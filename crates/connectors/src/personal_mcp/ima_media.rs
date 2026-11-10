use std::io::{Cursor, Read};

use reqwest::{
    Url,
    header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue},
};
use serde_json::{Value, json};

use super::{Api, Credentials, MAX_RESPONSE, paginate_content};
use crate::Result;

const MEDIA_LIMIT: usize = 8 * 1024 * 1024;
const FILE_HOST: &str = "skb.ima.myqcloud.com";

pub(super) async fn read(
    api: &Api,
    credentials: &Credentials,
    media: &Value,
    offset: usize,
) -> Result<Value> {
    let media_type = media["media_type"]
        .as_u64()
        .or_else(|| media["media_type"].as_str()?.parse().ok());
    let mut result = json!({"media_type":media_type,"read_status":"open_in_ima"});
    let text = if media_type == Some(11) {
        let Some(note_id) = media["notebook_ext_info"]["notebook_id"]
            .as_str()
            .filter(|id| !id.is_empty())
        else {
            return Ok(result);
        };
        let note = api
            .request(
                credentials,
                "openapi/note/v1/get_doc_content",
                json!({"note_id":note_id,"target_content_format":0}),
            )
            .await?;
        note["data"]["content"]
            .as_str()
            .ok_or_else(super::protocol)?
            .to_owned()
    } else {
        let Some((url, headers)) = access(&media["url_info"]) else {
            return Ok(result);
        };
        if !matches!(media_type, Some(3 | 5 | 7 | 13)) {
            return Ok(result);
        }
        let Some(content) = fetch_text(api, url, headers, media_type).await else {
            result["read_status"] = json!("content_unavailable");
            return Ok(result);
        };
        content
    };
    result["read_status"] = json!("read");
    result["content"] = json!(text);
    paginate_content(&mut result, offset)?;
    Ok(result)
}

fn access(info: &Value) -> Option<(Url, HeaderMap)> {
    let url = Url::parse(info["url"].as_str()?).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some(FILE_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().contains("/file_manager/")
    {
        return None;
    }
    let mut headers = HeaderMap::new();
    if !info["headers"].is_null() {
        let values = info["headers"].as_object()?;
        if values.len() > 12 {
            return None;
        }
        for (name, value) in values {
            let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
            if !matches!(
                name.as_str(),
                "authorization"
                    | "x-ima-create-url-time"
                    | "x-ima-platform"
                    | "x-ima-resource-category"
                    | "x-ima-sign"
                    | "x-ima-trace-id"
                    | "x-ima-uid-sha256"
            ) {
                return None;
            }
            let value = value.as_str().filter(|value| value.len() <= 4096)?;
            let mut value = HeaderValue::from_str(value).ok()?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
    }
    Some((url, headers))
}

async fn fetch_text(
    api: &Api,
    url: Url,
    headers: HeaderMap,
    media_type: Option<u64>,
) -> Option<String> {
    // The client disables redirects. IMA account credentials never travel to the file host.
    let mut response = api.client.get(url).headers(headers).send().await.ok()?;
    if response.status() != reqwest::StatusCode::OK {
        return None;
    }
    let mime = response
        .headers()
        .get(CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    let office_name = match (media_type, mime.as_str()) {
        (
            Some(3),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/octet-stream",
        ) => Some("document.docx"),
        (
            Some(5),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/octet-stream",
        ) => Some("document.xlsx"),
        (
            _,
            "text/plain"
            | "text/markdown"
            | "text/x-markdown"
            | "text/csv"
            | "application/md"
            | "application/markdown",
        ) => None,
        (Some(7 | 13), "application/octet-stream") => None,
        _ => return None,
    };
    let limit = if office_name.is_some() {
        MEDIA_LIMIT
    } else {
        MAX_RESPONSE
    };
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(name) = office_name {
        return tomorrow_attachments::extract_office_text(name.into(), mime, bytes)
            .await
            .ok();
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return tokio::task::spawn_blocking(move || read_text_archive(&bytes))
            .await
            .ok()?;
    }
    let text = String::from_utf8(bytes).ok()?;
    (!text.trim().is_empty() && !text.contains('\0')).then_some(text)
}

fn read_text_archive(bytes: &[u8]) -> Option<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    if archive.len() > 24 {
        return None;
    }
    let mut output = String::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).ok()?;
        if file.is_dir() {
            continue;
        }
        if !file.is_file() || file.is_symlink() || file.encrypted() {
            return None;
        }
        let path = file.enclosed_name()?.into_os_string().into_string().ok()?;
        if path.len() > 512 || path.chars().any(char::is_control) {
            return None;
        }
        let heading = format!("\n\n文件 {path}\n\n");
        let room = MAX_RESPONSE.checked_sub(output.len() + heading.len())?;
        if file.size() > room as u64 {
            return None;
        }
        let mut content = String::new();
        file.take(room as u64 + 1)
            .read_to_string(&mut content)
            .ok()?;
        if content.len() > room || content.contains('\0') {
            return None;
        }
        output.push_str(&heading);
        output.push_str(&content);
    }
    (!output.is_empty()).then_some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_small_text_archives_without_extracting_files() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("纪要.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all("下一步检查权限。".as_bytes()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let text = read_text_archive(&bytes).unwrap();
        assert!(text.contains("纪要.md\n\n下一步检查权限。"));
    }

    #[test]
    fn media_headers_only_go_to_the_verified_ima_file_endpoint() {
        let mut info = json!({"url":"https://skb.ima.myqcloud.com/5/fixture/file_manager/test.txt", "headers":{"X-IMA-Sign":"temporary"}});
        let (_, headers) = access(&info).unwrap();
        assert!(headers["x-ima-sign"].is_sensitive());
        for url in [
            "https://skb.ima.myqcloud.com.evil.test/5/file_manager/test.txt",
            "http://skb.ima.myqcloud.com/5/file_manager/a",
            "https://private@skb.ima.myqcloud.com/5/file_manager/a",
            "https://skb.ima.myqcloud.com/other",
            "https://skb.ima.myqcloud.com:1234/5/file_manager/a",
        ] {
            info["url"] = json!(url);
            assert!(access(&info).is_none());
        }
        info["url"] = json!("https://skb.ima.myqcloud.com/5/fixture/file_manager/a");
        info["headers"]["Host"] = json!("127.0.0.1");
        assert!(access(&info).is_none());
    }
}
