//! Bounded, network-free text extraction from explicitly uploaded OOXML files.
//! No macros, formulas, embedded objects or external relationships are executed.

use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    path::Path,
};

use axum::http::StatusCode;
use quick_xml::{
    Reader, XmlVersion,
    events::{BytesStart, Event},
};
use zip::{CompressionMethod, ZipArchive};

use crate::{AttachmentError, MAX_TEXT_BYTES, Upload};

pub(super) const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;
const MAX_EXPANDED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_XML_EVENTS: usize = 500_000;
const MAX_XML_DEPTH: usize = 64;
const MAX_SHEETS: usize = 32;
const MAX_STRINGS: usize = 20_000;
const MAX_CELLS: usize = 50_000;
pub(super) static PARSERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(super) fn supported(name: &str) -> bool {
    extension(name).is_some_and(|s| s == "docx" || s == "xlsx")
}

fn extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()?
        .to_str()
        .map(str::to_ascii_lowercase)
}

fn invalid() -> AttachmentError {
    error(
        "invalid_office_file",
        "文档格式无效或内容损坏，请重新导出 DOCX 或 XLSX 后上传",
    )
}

fn error(code: &'static str, message: &str) -> AttachmentError {
    AttachmentError::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}

fn limited() -> AttachmentError {
    error(
        "office_file_limit",
        "文档结构或展开内容超过读取限制，请拆分文档后上传",
    )
}

fn unsafe_content() -> AttachmentError {
    error(
        "unsafe_office_file",
        "暂不读取加密、含宏、嵌入对象或外部引用的文档，请另存为普通 DOCX 或 XLSX",
    )
}

fn push(out: &mut String, value: &str) -> Result<(), AttachmentError> {
    if out.len().saturating_add(value.len()) > MAX_TEXT_BYTES as usize {
        return Err(error(
            "attachment_too_long",
            "文档提取文字超过 64 KiB，请拆分后再使用",
        ));
    }
    out.push_str(value);
    Ok(())
}

pub(super) fn extract(upload: &Upload, bytes: &[u8]) -> Result<String, AttachmentError> {
    let format = extension(&upload.name).ok_or_else(invalid)?;
    let mime = match format.as_str() {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => return Err(invalid()),
    };
    if ![
        mime,
        "application/octet-stream",
        "application/zip",
        "application/x-zip-compressed",
    ]
    .contains(&upload.mime_type.as_str())
    {
        return Err(error("invalid_office_mime", "文档扩展名与文件类型不一致"));
    }
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(limited());
    }
    let mut package = Package::new(bytes)?;
    let content_types = package.xml("[Content_Types].xml")?;
    let required_content = if format == "docx" {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    } else {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    };
    let mut content_matches = false;
    walk(&content_types, |event| {
        if let Event::Start(e) | Event::Empty(e) = event {
            if let Some(content) = attr(e, "ContentType")? {
                let lower = content.to_ascii_lowercase();
                if lower.contains("macroenabled") || lower.contains("vba") {
                    return Err(unsafe_content());
                }
                if content == required_content {
                    content_matches = true;
                }
            }
        }
        Ok(())
    })?;
    if !content_matches {
        return Err(invalid());
    }
    // Validate every relationship file before reading any document content.
    for name in package
        .names
        .clone()
        .into_iter()
        .filter(|name| name.ends_with(".rels"))
    {
        relationships(&package.xml(&name)?)?;
    }
    let out = if format == "docx" {
        docx(&mut package)?
    } else {
        xlsx(&mut package)?
    };
    if out.trim().is_empty() {
        return Err(error(
            "office_no_text",
            "文档没有可读取的文字；图片和扫描件暂需先转换成文字",
        ));
    }
    Ok(out.trim_end().to_owned())
}

struct Package<'a> {
    archive: ZipArchive<Cursor<&'a [u8]>>,
    names: Vec<String>,
    read_total: u64,
}

impl<'a> Package<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, AttachmentError> {
        // Check the EOCD count before ZipArchive allocates its central directory.
        // ZIP64 and multi-disk archives are unnecessary for these bounded inputs.
        if bytes.len() < 22 || !bytes.starts_with(b"PK\x03\x04") {
            return Err(invalid());
        }
        let min = bytes.len().saturating_sub(65_557);
        let eocd = (min..=bytes.len() - 22)
            .rev()
            .find(|&i| {
                bytes[i..].starts_with(b"PK\x05\x06")
                    && i + 22 + u16::from_le_bytes([bytes[i + 20], bytes[i + 21]]) as usize
                        == bytes.len()
            })
            .ok_or_else(invalid)?;
        let u16_at = |n| u16::from_le_bytes([bytes[eocd + n], bytes[eocd + n + 1]]);
        let count = u16_at(10) as usize;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(limited());
        }
        if u16_at(4) != 0 || u16_at(6) != 0 || u16_at(8) as usize != count {
            return Err(invalid());
        }
        let archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
        if archive.len() != count || archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(invalid());
        }
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        let mut expanded = 0u64;
        for i in 0..archive.len() {
            let file = archive.by_index_data(i).map_err(|_| invalid())?;
            let name = std::str::from_utf8(file.name_raw())
                .map_err(|_| invalid())?
                .to_owned();
            let lower = name.to_ascii_lowercase();
            if file.encrypted()
                || lower.contains("vbaproject")
                || lower.contains("vbadata")
                || lower.contains("/activex/")
                || lower.contains("/embeddings/")
                || lower.contains("/macrosheets/")
                || lower.contains("/externallinks/")
            {
                return Err(unsafe_content());
            }
            if name.len() > 256
                || name.starts_with('/')
                || name.contains(['\\', ':', '\0'])
                || name.split('/').any(|part| part == "." || part == "..")
                || file.is_symlink()
                || !seen.insert(name.clone())
            {
                return Err(invalid());
            }
            if !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            ) {
                return Err(invalid());
            }
            expanded = expanded.checked_add(file.size()).ok_or_else(limited)?;
            if expanded > MAX_EXPANDED_BYTES {
                return Err(limited());
            }
            if (name.ends_with(".xml") || name.ends_with(".rels")) && file.size() > MAX_XML_BYTES {
                return Err(limited());
            }
            names.push(name);
        }
        Ok(Self {
            archive,
            names,
            read_total: 0,
        })
    }

    fn xml(&mut self, name: &str) -> Result<String, AttachmentError> {
        let mut file = self.archive.by_name(name).map_err(|_| invalid())?;
        if file.size() > MAX_XML_BYTES {
            return Err(limited());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_XML_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        self.read_total = self
            .read_total
            .checked_add(bytes.len() as u64)
            .ok_or_else(limited)?;
        if bytes.len() as u64 > MAX_XML_BYTES || self.read_total > MAX_EXPANDED_BYTES {
            return Err(limited());
        }
        String::from_utf8(bytes).map_err(|_| invalid())
    }
}

fn attr(element: &BytesStart<'_>, key: &str) -> Result<Option<String>, AttachmentError> {
    let mut found = None;
    for value in element.attributes() {
        let value = value.map_err(|_| invalid())?;
        if value.key.local_name().as_ref() == key {
            if found.is_some() {
                return Err(invalid());
            }
            found = Some(
                value
                    .normalized_value(XmlVersion::Implicit1_0)
                    .map_err(|_| invalid())?
                    .into_owned(),
            );
        }
    }
    Ok(found)
}

fn walk<'a>(
    xml: &'a str,
    mut visit: impl FnMut(&Event<'a>) -> Result<(), AttachmentError>,
) -> Result<(), AttachmentError> {
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut roots = 0usize;
    for _ in 0..MAX_XML_EVENTS {
        let event = reader.read_event().map_err(|_| invalid())?;
        match &event {
            Event::Start(e) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
                if depth > MAX_XML_DEPTH {
                    return Err(limited());
                }
                // Bound attributes and validate their escaping even when unused.
                if e.attributes().count() > 128 {
                    return Err(limited());
                }
                for item in e.attributes() {
                    item.map_err(|_| invalid())?
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|_| invalid())?;
                }
            }
            Event::Empty(e) => {
                if depth == 0 {
                    roots += 1;
                }
                if e.attributes().count() > 128 {
                    return Err(limited());
                }
                for item in e.attributes() {
                    item.map_err(|_| invalid())?
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|_| invalid())?;
                }
            }
            Event::End(_) => depth = depth.checked_sub(1).ok_or_else(invalid)?,
            Event::DocType(_) => return Err(unsafe_content()),
            Event::GeneralRef(value) => {
                reference(value)?;
            }
            Event::Eof => {
                return if depth == 0 && roots == 1 {
                    Ok(())
                } else {
                    Err(invalid())
                };
            }
            _ => {}
        }
        if roots > 1 {
            return Err(invalid());
        }
        visit(&event)?;
    }
    Err(limited())
}

fn reference(value: &quick_xml::events::BytesRef<'_>) -> Result<String, AttachmentError> {
    if let Some(c) = value.resolve_char_ref().map_err(|_| invalid())? {
        return Ok(c.to_string());
    }
    Ok(match value.as_ref() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => return Err(unsafe_content()),
    }
    .to_owned())
}

fn event_text(event: &Event<'_>) -> Result<Option<String>, AttachmentError> {
    Ok(match event {
        Event::Text(value) => Some(value.xml10_content().into_owned()),
        Event::CData(value) => Some(value.xml10_content().into_owned()),
        Event::GeneralRef(value) => Some(reference(value)?),
        _ => None,
    })
}

fn relationships(xml: &str) -> Result<HashMap<String, (String, String)>, AttachmentError> {
    let mut out = HashMap::new();
    walk(xml, |event| {
        if let Event::Start(e) | Event::Empty(e) = event {
            if e.local_name().as_ref() == "Relationship" {
                if attr(e, "TargetMode")?.is_some_and(|s| !s.eq_ignore_ascii_case("internal")) {
                    return Err(unsafe_content());
                }
                let target = attr(e, "Target")?.ok_or_else(invalid)?;
                if target.contains([':', '\\', '\0']) || target.starts_with("//") {
                    return Err(unsafe_content());
                }
                let id = attr(e, "Id")?.ok_or_else(invalid)?;
                let kind = attr(e, "Type")?.ok_or_else(invalid)?;
                if out.insert(id, (target, kind)).is_some() {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    })?;
    Ok(out)
}

fn docx(package: &mut Package<'_>) -> Result<String, AttachmentError> {
    let xml = package.xml("word/document.xml")?;
    let mut out = String::new();
    let mut in_text = false;
    walk(&xml, |event| {
        match event {
            Event::Start(e) if e.local_name().as_ref() == "t" => in_text = true,
            Event::End(e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" | "tr" => push(&mut out, "\n")?,
                "tc" => push(&mut out, "\t")?,
                _ => {}
            },
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                "tab" => push(&mut out, "\t")?,
                "br" | "cr" => push(&mut out, "\n")?,
                _ => {}
            },
            _ if in_text => {
                if let Some(text) = event_text(event)? {
                    push(&mut out, &text)?;
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(out)
}

fn xlsx(package: &mut Package<'_>) -> Result<String, AttachmentError> {
    let mut strings = Vec::new();
    if package.names.iter().any(|s| s == "xl/sharedStrings.xml") {
        let xml = package.xml("xl/sharedStrings.xml")?;
        let mut current = String::new();
        let mut in_text = false;
        let mut in_phonetic = false;
        let mut string_total = 0usize;
        walk(&xml, |event| {
            match event {
                Event::Start(e) if e.local_name().as_ref() == "si" => current.clear(),
                Event::Empty(e) if e.local_name().as_ref() == "si" => {
                    if strings.len() >= MAX_STRINGS {
                        return Err(limited());
                    }
                    // An empty item still occupies its shared-string index.
                    strings.push(String::new());
                }
                Event::Start(e) if e.local_name().as_ref() == "rPh" => in_phonetic = true,
                Event::End(e) if e.local_name().as_ref() == "rPh" => in_phonetic = false,
                Event::Start(e) if e.local_name().as_ref() == "t" => in_text = !in_phonetic,
                Event::End(e) if e.local_name().as_ref() == "t" => in_text = false,
                Event::End(e) if e.local_name().as_ref() == "si" => {
                    string_total += current.len();
                    if strings.len() >= MAX_STRINGS || string_total > MAX_XML_BYTES as usize {
                        return Err(limited());
                    }
                    strings.push(std::mem::take(&mut current));
                }
                _ if in_text => {
                    if let Some(text) = event_text(event)? {
                        push(&mut current, &text)?;
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
    }
    let xml = package.xml("xl/workbook.xml")?;
    let rels = relationships(&package.xml("xl/_rels/workbook.xml.rels")?)?;
    let mut sheets = Vec::new();
    walk(&xml, |event| {
        if let Event::Start(e) | Event::Empty(e) = event {
            if e.local_name().as_ref() == "sheet" {
                if sheets.len() >= MAX_SHEETS {
                    return Err(limited());
                }
                let name = attr(e, "name")?.ok_or_else(invalid)?;
                let id = attr(e, "id")?.ok_or_else(invalid)?;
                let (target, kind) = rels.get(&id).ok_or_else(invalid)?;
                if !kind.ends_with("/worksheet") {
                    return Err(invalid());
                }
                let path = if target.starts_with("/xl/") {
                    target.trim_start_matches('/').to_owned()
                } else {
                    format!("xl/{target}")
                };
                if !path.starts_with("xl/worksheets/")
                    || path.split('/').any(|p| p == ".." || p == ".")
                {
                    return Err(invalid());
                }
                sheets.push((name, path));
            }
        }
        Ok(())
    })?;
    if sheets.is_empty() {
        return Err(invalid());
    }
    let mut out = String::from(
        "表格文字提取：公式仅读取已保存的缓存结果，不重新计算；数字未套用单元格显示格式。\n",
    );
    let mut count = 0usize;
    for (name, path) in sheets {
        push(&mut out, &format!("\n[工作表: {name}]\n"))?;
        let xml = package.xml(&path)?;
        let mut cell: Option<Cell> = None;
        let mut in_value = false;
        let mut in_inline = false;
        let mut in_phonetic = false;
        walk(&xml, |event| {
            match event {
                Event::Start(e) if e.local_name().as_ref() == "c" => {
                    if cell.is_some() {
                        return Err(invalid());
                    }
                    count += 1;
                    if count > MAX_CELLS {
                        return Err(limited());
                    }
                    cell = Some(Cell {
                        address: attr(e, "r")?.ok_or_else(invalid)?,
                        kind: attr(e, "t")?.unwrap_or_default(),
                        ..Cell::default()
                    });
                }
                Event::Start(e) if cell.is_some() && e.local_name().as_ref() == "v" => {
                    in_value = true
                }
                Event::Start(e) if e.local_name().as_ref() == "rPh" => in_phonetic = true,
                Event::Start(e) if cell.is_some() && e.local_name().as_ref() == "t" => {
                    in_inline = !in_phonetic
                }
                Event::Start(e) | Event::Empty(e)
                    if cell.is_some() && e.local_name().as_ref() == "f" =>
                {
                    cell.as_mut().unwrap().formula = true
                }
                Event::End(e) => match e.local_name().as_ref() {
                    "v" => in_value = false,
                    "t" => in_inline = false,
                    "rPh" => in_phonetic = false,
                    "c" => {
                        let cell = cell.take().ok_or_else(invalid)?;
                        cell.emit(&mut out, &strings)?;
                        in_value = false;
                        in_inline = false;
                    }
                    _ => {}
                },
                _ if in_value || in_inline => {
                    if let (Some(cell), Some(text)) = (cell.as_mut(), event_text(event)?) {
                        push(&mut cell.value, &text)?;
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
    }
    Ok(out)
}

#[derive(Default)]
struct Cell {
    address: String,
    kind: String,
    value: String,
    formula: bool,
}
impl Cell {
    fn emit(self, out: &mut String, strings: &[String]) -> Result<(), AttachmentError> {
        let letter_count = self
            .address
            .bytes()
            .take_while(u8::is_ascii_uppercase)
            .count();
        if !(1..=3).contains(&letter_count)
            || self.address.len() <= letter_count
            || self.address.len() > 10
            || !self.address[letter_count..]
                .bytes()
                .all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        if self.value.is_empty() && !self.formula {
            return Ok(());
        }
        let value = if self.kind == "s" {
            strings
                .get(self.value.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)?
                .clone()
        } else if self.kind == "b" {
            match self.value.as_str() {
                "0" => "false".to_owned(),
                "1" => "true".to_owned(),
                _ => return Err(invalid()),
            }
        } else if self.value.is_empty() && self.formula {
            "[公式，无缓存结果]".to_owned()
        } else {
            self.value
        };
        push(out, &format!("{}\t{}\n", self.address, value))
    }
}

#[cfg(test)]
mod tests;
