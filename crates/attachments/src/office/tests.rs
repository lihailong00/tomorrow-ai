use super::*;
use std::io::Write;
use zip::{ZipWriter, write::SimpleFileOptions};

const DOC_CONTENT: &str = r#"<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
const XLS_CONTENT: &str = r#"<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#;

fn archive(files: &[(&str, &str)]) -> Vec<u8> {
    let files: Vec<_> = files
        .iter()
        .map(|(name, text)| (*name, text.as_bytes()))
        .collect();
    archive_bytes(&files)
}

fn archive_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(content).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn upload(name: &str, bytes: &[u8]) -> Upload {
    Upload {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        mime_type: "application/octet-stream".into(),
        size: bytes.len() as i64,
        created_at: chrono::Utc::now().to_rfc3339(),
        uri: String::new(),
    }
}

fn docx(xml: &str) -> Vec<u8> {
    archive(&[
        ("[Content_Types].xml", DOC_CONTENT),
        ("word/document.xml", xml),
    ])
}

fn document(xml: &str) -> String {
    let bytes = docx(xml);
    extract(&upload("note.docx", &bytes), &bytes).unwrap()
}

#[test]
fn docx_preserves_chinese_paragraphs_tabs_line_breaks_and_standard_entities() {
    assert_eq!(
        document(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>会议 &amp; 项目 &#x4E2D;</w:t><w:tab/><w:t>周五</w:t><w:br/><w:t>14:00</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>"#
        ),
        "会议 & 项目 中\t周五\n14:00\n第二段"
    );
}

#[test]
fn docx_paired_and_empty_separators_extract_equivalent_text() {
    let prefix = r#"<w:document xmlns:w="word"><w:p><w:r><w:t>one</w:t>"#;
    let suffix = r#"<w:t>four</w:t></w:r></w:p></w:document>"#;
    let empty = format!("{prefix}<w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t><w:cr/>{suffix}");
    let paired = format!(
        "{prefix}<w:tab></w:tab><w:t>two</w:t><w:br></w:br><w:t>three</w:t><w:cr></w:cr>{suffix}"
    );
    assert_eq!(document(&empty), "one\ttwo\nthree\nfour");
    assert_eq!(document(&paired), document(&empty));
}

#[test]
fn docx_preserves_element_and_literal_hyphens_without_doubling() {
    for separators in [
        "<w:noBreakHyphen/><w:t>甲方</w:t><w:softHyphen/>",
        "<w:noBreakHyphen></w:noBreakHyphen><w:t>甲方</w:t><w:softHyphen></w:softHyphen>",
        "<w:t>\u{2011}甲方\u{00ad}</w:t>",
    ] {
        assert_eq!(
            document(&format!(
                "<w:document xmlns:w=\"word\"><w:p><w:r><w:t>项目</w:t>{separators}<w:t>续行</w:t></w:r></w:p></w:document>"
            )),
            "项目\u{2011}甲方\u{00ad}续行"
        );
    }
}

fn utf16(xml: &str, little_endian: bool) -> Vec<u8> {
    let mut bytes = if little_endian {
        vec![0xff, 0xfe]
    } else {
        vec![0xfe, 0xff]
    };
    for unit in xml.encode_utf16() {
        bytes.extend(if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        });
    }
    bytes
}

#[test]
fn utf16_xml_parts_decode_both_byte_orders_and_keep_security_checks() {
    for little_endian in [true, false] {
        let types = utf16(
            &format!("<?xml version=\"1.0\" encoding=\"UTF-16\"?>{DOC_CONTENT}"),
            little_endian,
        );
        let text = utf16(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><document><t>中文与😀</t></document>",
            little_endian,
        );
        let bytes = archive_bytes(&[
            ("[Content_Types].xml", &types),
            ("word/document.xml", &text),
        ]);
        assert_eq!(
            extract(&upload("utf16.docx", &bytes), &bytes).unwrap(),
            "中文与😀"
        );
        for xml in [
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><!DOCTYPE document [<!ENTITY ext SYSTEM 'file:///secret'>]><document><t>&ext;</t></document>",
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><document><t>&unknown;</t></document>",
        ] {
            let text = utf16(xml, little_endian);
            let bytes = archive_bytes(&[
                ("[Content_Types].xml", &types),
                ("word/document.xml", &text),
            ]);
            assert_eq!(
                extract(&upload("unsafe.docx", &bytes), &bytes)
                    .unwrap_err()
                    .code(),
                "unsafe_office_file"
            );
        }
        let rels = utf16(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><Relationships><Relationship Id=\"r1\" Type=\"officeDocument\" Target=\"https://example.test\" TargetMode=\"External\"/></Relationships>",
            little_endian,
        );
        let bytes = archive_bytes(&[
            ("[Content_Types].xml", &types),
            ("word/document.xml", &text),
            ("_rels/.rels", &rels),
        ]);
        assert_eq!(
            extract(&upload("external.docx", &bytes), &bytes)
                .unwrap_err()
                .code(),
            "unsafe_office_file"
        );
    }
}

#[test]
fn xml_encoding_rejects_false_declarations_invalid_utf16_and_decoded_overflow() {
    let cases = [
        b"<?xml version=\"1.0\" encoding=\"UTF-16\"?><a/>".to_vec(),
        b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><a/>".to_vec(),
        utf16("<?xml version=\"1.0\" encoding=\"UTF-16BE\"?><a/>", true),
        utf16("<?xml version=\"1.0\" encoding=\"UTF-8\"?><a/>", false),
        vec![0xff, 0xfe, 0x3c],
        vec![0xff, 0xfe, 0x00, 0xd8],
    ];
    for bytes in cases {
        assert_eq!(
            decode_xml(&bytes).unwrap_err().code(),
            "invalid_office_file"
        );
    }
    for prefix in [" ", "<!--before declaration-->"] {
        let bytes = docx(&format!(
            "{prefix}<?xml version=\"1.0\" encoding=\"UTF-16\"?><document><t>false encoding claim</t></document>"
        ));
        assert_eq!(
            extract(&upload("misplaced-declaration.docx", &bytes), &bytes)
                .unwrap_err()
                .code(),
            "invalid_office_file"
        );
    }
    for little_endian in [true, false] {
        let encoding = if little_endian {
            "UTF-16LE"
        } else {
            "UTF-16BE"
        };
        let xml = format!("<?xml version=\"1.0\" encoding=\"{encoding}\"?><a/>");
        assert_eq!(decode_xml(&utf16(&xml, little_endian)).unwrap(), xml);
    }
    let large = utf16(
        &format!("<a>{}</a>", "中".repeat(MAX_XML_BYTES as usize / 3 + 1)),
        true,
    );
    assert!(large.len() < MAX_XML_BYTES as usize);
    assert_eq!(decode_xml(&large).unwrap_err().code(), "office_file_limit");
}

#[test]
fn docx_follows_safe_internal_main_part_and_requires_matching_content_type() {
    let types = r#"<Types><Override PartName="/word/main-document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let rels = r#"<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/main-document.xml"/></Relationships>"#;
    let bytes = archive(&[
        ("[Content_Types].xml", types),
        ("_rels/.rels", rels),
        (
            "word/main-document.xml",
            "<document><t>内部主文档</t></document>",
        ),
    ]);
    assert_eq!(
        extract(&upload("moved.docx", &bytes), &bytes).unwrap(),
        "内部主文档"
    );
    let bytes = archive(&[
        ("[Content_Types].xml", DOC_CONTENT),
        ("_rels/.rels", rels),
        (
            "word/main-document.xml",
            "<document><t>wrong type path</t></document>",
        ),
    ]);
    assert_eq!(
        extract(&upload("mismatch.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
    for target in [
        "word/../main-document.xml",
        "//host/main.xml",
        "word/%2e%2e/main.xml",
        "word/main.xml#fragment",
    ] {
        let rels = format!(
            r#"<Relationships><Relationship Id="r1" Type="office/officeDocument" Target="{target}"/></Relationships>"#
        );
        let bytes = archive(&[
            ("[Content_Types].xml", types),
            ("_rels/.rels", &rels),
            (
                "word/main-document.xml",
                "<document><t>hidden</t></document>",
            ),
        ]);
        assert!(extract(&upload("unsafe-target.docx", &bytes), &bytes).is_err());
    }
}

#[test]
fn docx_reads_tables_without_executing_fields_or_deleted_text() {
    let text = document(
        r#"<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>客户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:instrText>INCLUDETEXT file:///etc/passwd</w:instrText><w:delText>删除</w:delText><w:t>当前内容</w:t></w:r></w:p></w:body></w:document>"#,
    );
    assert!(text.contains("客户\n\t甲方"));
    assert!(!text.contains("etc/passwd"));
    assert!(!text.contains("删除"));
    assert!(text.ends_with("当前内容"));
}

#[test]
fn xlsx_reads_workbook_order_shared_and_inline_strings_sparse_addresses_and_cached_formula() {
    let bytes = archive(&[
        ("[Content_Types].xml", XLS_CONTENT),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns:r="relationships"><sheets><sheet name="进度 &amp; 计划" sheetId="1" r:id="rId2"/><sheet name="空表" sheetId="2" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#,
        ),
        (
            "xl/sharedStrings.xml",
            r#"<sst><si><r><t>客户</t></r><r><t>甲方</t></r></si></sst>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData/></worksheet>",
        ),
        (
            "xl/worksheets/sheet2.xml",
            r#"<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="D2" t="inlineStr"><is><t>周五</t></is></c><c r="F2"><f>SUM(A1:B1)</f><v>30</v></c><c r="G2" t="b"><v>1</v></c><c r="H2"><f>HYPERLINK("https://example.test")</f></c></row></sheetData></worksheet>"#,
        ),
    ]);
    let text = extract(&upload("plan.xlsx", &bytes), &bytes).unwrap();
    assert!(text.find("进度 & 计划").unwrap() < text.find("空表").unwrap());
    assert!(text.contains("A2\t客户甲方\nD2\t周五\nF2\t30\nG2\ttrue\nH2\t[公式，无缓存结果]"));
    assert!(!text.contains("https://example.test"));
}

fn worksheet_workbook(sheet: &str) -> Vec<u8> {
    archive(&[
        ("[Content_Types].xml", XLS_CONTENT),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns:r="relationships"><sheets><sheet name="计划" sheetId="1" r:id="r1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="r1" Type="office/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/sheet1.xml", sheet),
    ])
}

fn sheet_text(rows: &str) -> Result<String, AttachmentError> {
    let bytes = worksheet_workbook(&format!(
        "<worksheet><sheetData>{rows}</sheetData></worksheet>"
    ));
    extract(&upload("plan.xlsx", &bytes), &bytes)
}

#[test]
fn xlsx_decodes_utf16_workbook_relationship_and_worksheet_parts() {
    let original = worksheet_workbook(
        r#"<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>春节😀</t></is></c></row></sheetData></worksheet>"#,
    );
    let expected = extract(&upload("utf8.xlsx", &original), &original).unwrap();
    for little_endian in [true, false] {
        let mut source = ZipArchive::new(Cursor::new(&original)).unwrap();
        let mut parts = Vec::new();
        for index in 0..source.len() {
            let mut file = source.by_index(index).unwrap();
            let name = std::str::from_utf8(file.name_raw()).unwrap().to_owned();
            let mut xml = String::new();
            file.read_to_string(&mut xml).unwrap();
            parts.push((
                name,
                utf16(
                    &format!("<?xml version=\"1.0\" encoding=\"UTF-16\"?>{xml}"),
                    little_endian,
                ),
            ));
        }
        let refs: Vec<_> = parts
            .iter()
            .map(|(name, body)| (name.as_str(), body.as_slice()))
            .collect();
        let bytes = archive_bytes(&refs);
        assert_eq!(
            extract(&upload("utf16.xlsx", &bytes), &bytes).unwrap(),
            expected
        );
    }
}

#[test]
fn xlsx_follows_safe_workbook_sheet_and_shared_string_part_targets() {
    let bytes = archive(&[
        (
            "[Content_Types].xml",
            r#"<Types><Override PartName="/documents/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/documents/plan.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships><Relationship Id="main" Type="office/officeDocument" Target="/documents/book.xml"/></Relationships>"#,
        ),
        (
            "documents/book.xml",
            r#"<workbook xmlns:r="relationships"><sheets><sheet name="搬迁计划" sheetId="1" r:id="sheet"/></sheets></workbook>"#,
        ),
        (
            "documents/_rels/book.xml.rels",
            r#"<Relationships><Relationship Id="sheet" Type="office/worksheet" Target="plan.xml"/><Relationship Id="strings" Type="office/sharedStrings" Target="/data/strings.xml"/></Relationships>"#,
        ),
        ("data/strings.xml", "<sst><si><t>关系定位</t></si></sst>"),
        (
            "documents/plan.xml",
            r#"<worksheet><sheetData><row r="3"><c r="C3" t="s"><v>0</v></c></row></sheetData></worksheet>"#,
        ),
    ]);
    let text = extract(&upload("moved.xlsx", &bytes), &bytes).unwrap();
    assert!(text.ends_with("[工作表: 搬迁计划]\nC3\t关系定位"));
    for target in ["../plan.xml", "plan.xml?query", "%2e%2e/plan.xml"] {
        assert_eq!(
            resolve_part("xl/workbook.xml", target).unwrap_err().code(),
            "invalid_office_file"
        );
    }
    assert_eq!(
        resolve_part("xl/workbook.xml", "/xl/plan.xml").unwrap(),
        "xl/plan.xml"
    );
}

#[test]
fn xlsx_infers_missing_cell_addresses_across_sparse_rows_and_empty_cells() {
    let text = sheet_text(r#"<row r="2"><c r="A2" t="inlineStr"><is><t>first</t></is></c><c><v>2</v></c><c/><c><v>4</v></c><c r="Z2"><v>26</v></c><c><v>27</v></c></row><row/><row><c><v>row4</v></c></row><row><c r="C9"/><c><v>after gap</v></c></row>"#).unwrap();
    assert!(text.ends_with("A2\tfirst\nB2\t2\nD2\t4\nZ2\t26\nAA2\t27\nA4\trow4\nD9\tafter gap"));
    let explicit =
        sheet_text(r#"<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row>"#).unwrap();
    let implicit = sheet_text(r#"<row r="2"><c r="A2"><v>1</v></c><c><v>2</v></c></row>"#).unwrap();
    assert_eq!(explicit, implicit);
}

#[test]
fn xlsx_rejects_ambiguous_or_out_of_range_coordinates_and_counts_empty_cells() {
    for rows in [
        r#"<row r="0"/>"#,
        r#"<row r="1048577"/>"#,
        r#"<row r="2"/><row r="1"/>"#,
        r#"<row r="1"><c r="B1"/><c r="A1"><v>1</v></c></row>"#,
        r#"<row r="4"><c r="A5"><v>1</v></c></row>"#,
        r#"<row><c r="XFE1"><v>1</v></c></row>"#,
        r#"<row><c r="A0"><v>1</v></c></row>"#,
        r#"<row><c r="XFD1"/><c><v>1</v></c></row>"#,
        r#"<row r="1048576"/><row><c><v>1</v></c></row>"#,
    ] {
        assert_eq!(
            sheet_text(rows).unwrap_err().code(),
            "invalid_office_file",
            "{rows}"
        );
    }
    let mut rows = String::new();
    for row in 1..=4 {
        rows.push_str(&format!(
            "<row r=\"{row}\">{}</row>",
            "<c/>".repeat(MAX_COLUMN as usize)
        ));
    }
    assert_eq!(sheet_text(&rows).unwrap_err().code(), "office_file_limit");
}

#[test]
fn xlsx_missing_formula_cache_is_consistent_for_boolean_numeric_and_string_cells() {
    for kind in ["b", "n", "str", "s"] {
        for cache in ["", "<v/>", "<v></v>"] {
            let text = sheet_text(&format!(r#"<row r="2"><c r="A2"><v>kept</v></c><c r="B2" t="{kind}"><f>A2&gt;0</f>{cache}</c></row>"#)).unwrap();
            assert!(text.ends_with("A2\tkept\nB2\t[公式，无缓存结果]"));
        }
    }
    for (cache, expected) in [("0", "false"), ("1", "true")] {
        assert!(
            sheet_text(&format!(
                r#"<row><c t="b"><f>1&gt;0</f><v>{cache}</v></c></row>"#
            ))
            .unwrap()
            .ends_with(expected)
        );
    }
    assert_eq!(
        sheet_text(r#"<row><c t="b"><f>1&gt;0</f><v>yes</v></c></row>"#)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
}

fn shared_string_workbook(strings: &str, cells: &str) -> Vec<u8> {
    let sheet = format!("<worksheet><sheetData><row r=\"1\">{cells}</row></sheetData></worksheet>");
    archive(&[
        ("[Content_Types].xml", XLS_CONTENT),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns:r="relationships"><sheets><sheet name="中文计划" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/sharedStrings.xml", strings),
        ("xl/worksheets/sheet1.xml", &sheet),
    ])
}

#[test]
fn xlsx_empty_shared_strings_preserve_indices_and_rich_text() {
    let cells = r#"<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c><c r="H1" t="s"><v>3</v></c>"#;
    let mut previous = None;
    for empty in ["<si/>", "<si></si>", "<si><t/></si>", "<si><t></t></si>"] {
        let strings = format!(
            r#"<sst>{empty}<si><t>春节计划</t></si>{empty}<si><r><t>春</t></r><r><t/></r><r><t>节 &amp; 计划</t></r><rPh sb="0" eb="1"><t>chun</t></rPh><rPh/><r><t>2027</t></r></si>{empty}<si><t>2027-02-06</t></si>{empty}</sst>"#
        );
        let bytes = shared_string_workbook(&strings, cells);
        let text = extract(&upload("plan.xlsx", &bytes), &bytes).unwrap();
        assert!(text.ends_with("A1\t\nB1\t春节计划\nC1\t\nD1\t春节 & 计划2027\nE1\t\nF1\t2027-02-06\nG1\t\nH1\t春节 & 计划2027"));
        if let Some(previous) = &previous {
            assert_eq!(&text, previous);
        }
        previous = Some(text);
    }
}

#[test]
fn xlsx_empty_shared_strings_obey_item_limit_without_padding_indices() {
    let cells = format!(
        r#"<c r="A1" t="s"><v>{}</v></c><c r="B1" t="s"><v>0</v></c>"#,
        MAX_STRINGS - 1
    );
    for (empty_count, expected_error) in [
        (MAX_STRINGS - 1, None),
        (MAX_STRINGS, Some("office_file_limit")),
    ] {
        let strings = format!(
            "<sst><si><t>kept</t></si>{}</sst>",
            "<si/>".repeat(empty_count)
        );
        let bytes = shared_string_workbook(&strings, &cells);
        let result = extract(&upload("limit.xlsx", &bytes), &bytes);
        if let Some(code) = expected_error {
            assert_eq!(result.unwrap_err().code(), code);
        } else {
            assert!(result.unwrap().ends_with("A1\t\nB1\tkept"));
        }
    }
    let bytes = shared_string_workbook(
        r#"<sst count="10" uniqueCount="10"><si/></sst>"#,
        r#"<c r="A1" t="s"><v>1</v></c>"#,
    );
    assert_eq!(
        extract(&upload("invalid-index.xlsx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
}

#[test]
fn rejects_macro_external_relationship_dtd_unknown_entity_and_path_traversal() {
    let cases = [
        archive(&[
            ("[Content_Types].xml", DOC_CONTENT),
            ("word/document.xml", "<document/>"),
            ("word/vbaProject.bin", "macro"),
        ]),
        archive(&[
            ("[Content_Types].xml", DOC_CONTENT),
            ("word/document.xml", "<document/>"),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships><Relationship Id="r1" Type="hyperlink" Target="https://example.test" TargetMode="External"/></Relationships>"#,
            ),
        ]),
        docx(
            r#"<!DOCTYPE document [<!ENTITY ext SYSTEM "file:///etc/passwd">]><document><t>&ext;</t></document>"#,
        ),
        docx("<document><t>&unknown;</t></document>"),
    ];
    for bytes in cases {
        assert_eq!(
            extract(&upload("unsafe.docx", &bytes), &bytes)
                .unwrap_err()
                .code(),
            "unsafe_office_file"
        );
    }
    let bytes = archive(&[
        ("[Content_Types].xml", DOC_CONTENT),
        ("../escape.xml", "<a/>"),
    ]);
    assert_eq!(
        extract(&upload("path.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
}

#[test]
fn rejects_binary_renamed_files_mime_mismatch_malformed_xml_and_overlong_output() {
    let bytes = b"%PDF-1.7 fake document";
    assert_eq!(
        extract(&upload("fake.docx", bytes), bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
    let bytes = docx("<document><t>Hello</t></document>");
    let mut item = upload("note.docx", &bytes);
    item.mime_type = "image/png".into();
    assert_eq!(
        extract(&item, &bytes).unwrap_err().code(),
        "invalid_office_mime"
    );
    let bytes = docx("<document><t>Hello</document>");
    assert_eq!(
        extract(&upload("note.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
    let bytes = docx(&format!(
        "<document><t>{}</t></document>",
        "中".repeat(MAX_TEXT_BYTES as usize)
    ));
    assert_eq!(
        extract(&upload("large.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "attachment_too_long"
    );
}

#[test]
fn rejects_archive_bombs_excess_entries_xml_depth_and_encryption() {
    let bytes = docx(&format!(
        "<document>{}</document>",
        "x".repeat(MAX_XML_BYTES as usize + 1)
    ));
    assert_eq!(
        extract(&upload("bomb.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let entries: Vec<_> = (0..MAX_ARCHIVE_ENTRIES + 1)
        .map(|i| (format!("part{i}"), "".to_owned()))
        .collect();
    let refs: Vec<_> = entries
        .iter()
        .map(|(n, c)| (n.as_str(), c.as_str()))
        .collect();
    let bytes = archive(&refs);
    assert_eq!(
        extract(&upload("many.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let bytes = docx(&format!(
        "{}text{}",
        "<a>".repeat(MAX_XML_DEPTH + 1),
        "</a>".repeat(MAX_XML_DEPTH + 1)
    ));
    assert_eq!(
        extract(&upload("deep.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let mut bytes = docx("<document><t>Hello</t></document>");
    // The encrypted flag is carried by both local and central headers.
    for i in 0..bytes.len() - 10 {
        if bytes[i..].starts_with(b"PK\x03\x04") {
            bytes[i + 6] |= 1;
        }
        if bytes[i..].starts_with(b"PK\x01\x02") {
            bytes[i + 8] |= 1;
        }
    }
    assert_eq!(
        extract(&upload("encrypted.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "unsafe_office_file"
    );
}

#[tokio::test]
async fn extracted_text_cache_keeps_owner_scope_works_in_agent_context_and_deletes_with_upload() {
    use crate::{AttachmentsState, router};
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use tomorrow_domain::Repository;
    use tower::ServiceExt;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user("office@fixtures.test", "unused", "owner", "Asia/Shanghai")
        .await
        .unwrap();
    let other = repo
        .create_user(
            "other-office@fixtures.test",
            "unused",
            "other",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&owner.id).await.unwrap();
    let other_token = repo.create_session(&other.id).await.unwrap();
    let directory =
        std::env::temp_dir().join(format!("tomorrow-office-test-{}", uuid::Uuid::new_v4()));
    let state =
        AttachmentsState::initialize(repo, directory.clone(), crate::DEFAULT_MAX_BYTES, None)
            .await
            .unwrap();
    let bytes = docx("<document><t>本周交付计划</t></document>");
    let item = upload("work.docx", &bytes);
    tokio::fs::write(state.path(&item.id).unwrap(), bytes)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO uploads(id,user_id,name,mime_type,size,created_at) VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(&item.id)
    .bind(&owner.id)
    .bind(&item.name)
    .bind(&item.mime_type)
    .bind(item.size)
    .bind(&item.created_at)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        state.read_text(&owner.id, &item.id).await.unwrap().text,
        "本周交付计划"
    );
    assert_eq!(
        state
            .read_text(&other.id, &item.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/v1/uploads/{}/text", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 128 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["text"], "本周交付计划");
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/v1/uploads/{}/text", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {other_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // Cached text remains readable even if the original object is temporarily unavailable.
    tokio::fs::remove_file(state.path(&item.id).unwrap())
        .await
        .unwrap();
    assert!(
        state
            .chat_context(&owner.id, &[item.id.clone()])
            .await
            .unwrap()
            .contains("本周交付计划")
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/uploads/{}", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cached: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM upload_text_cache")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(cached, 0);
    assert_eq!(
        state
            .read_text(&owner.id, &item.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    state.pool.close().await;
    let resolved = std::fs::canonicalize(&directory).unwrap();
    assert_eq!(
        resolved.parent().unwrap(),
        std::fs::canonicalize(std::env::temp_dir()).unwrap()
    );
    assert!(
        resolved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tomorrow-office-test-")
    );
    tokio::fs::remove_dir_all(resolved).await.unwrap();
}
