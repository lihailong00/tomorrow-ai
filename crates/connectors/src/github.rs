//! Bounded public source browsing through GitHub's source ZIP endpoint.
use std::{
    io::{Cursor, Read},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use axum::http::StatusCode;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use zip::ZipArchive;

use crate::{ConnectorError, Result};

const ARCHIVE_LIMIT: usize = 16 * 1024 * 1024;
const ENTRY_LIMIT: usize = 50_000;
const FILE_LIMIT: u64 = 512 * 1024;
static REQUESTS: Semaphore = Semaphore::const_new(4);
static HTTP: LazyLock<Option<Client>> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .user_agent("Tada-public-source")
        .build()
        .ok()
});

type Archive = ZipArchive<Cursor<Arc<[u8]>>>;
struct Snapshot {
    run_id: String,
    repository: String,
    commit: String,
    bytes: Arc<[u8]>,
}
// Only reuse immutable refs within the same authenticated run.
static CACHE: Mutex<Option<Snapshot>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    repository: String,
    #[serde(default = "head")]
    git_ref: String,
    path: Option<String>,
    query: Option<String>,
    offset: Option<usize>,
    start_line: Option<usize>,
}

fn head() -> String {
    "HEAD".into()
}

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_github_request",
        "GitHub 仓库、分支、文件路径或分页参数无效",
    )
}

fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "github_unreachable",
        "暂时无法从 GitHub 取得有效源码，请稍后重试",
    )
}

fn too_large() -> ConnectorError {
    ConnectorError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "github_source_too_large",
        "公开仓库快照超出本次读取范围，可在能力页连接 GitHub，按文件读取",
    )
}

fn sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn repository(value: &str) -> Result<(&str, &str)> {
    let (owner, repo) = value.split_once('/').ok_or_else(invalid)?;
    if !owner.is_empty()
        && owner.len() <= 39
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !repo.is_empty()
        && repo.len() <= 100
        && !matches!(repo, "." | "..")
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        Ok((owner, repo))
    } else {
        Err(invalid())
    }
}

fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

fn url(origin: &str, segments: impl IntoIterator<Item = impl AsRef<str>>) -> Url {
    let mut url = Url::parse(origin).expect("fixed GitHub origin");
    url.path_segments_mut()
        .expect("HTTPS origin")
        .extend(segments);
    url
}

pub async fn read_public(run_id: String, arguments: Value) -> Result<Value> {
    let input: Input = serde_json::from_value(arguments).map_err(|_| invalid())?;
    let (owner, repo) = repository(&input.repository)?;
    if input.git_ref.len() > 200
        || !valid_path(&input.git_ref)
        || !input
            .git_ref
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
        || input.path.as_deref().is_some_and(|path| !valid_path(path))
        || input.query.as_deref().is_some_and(|query| {
            query.is_empty() || query.len() > 120 || query.chars().any(char::is_control)
        })
        || input.offset.is_some_and(|offset| offset >= ENTRY_LIMIT)
        || input
            .start_line
            .is_some_and(|line| line == 0 || line > FILE_LIMIT as usize)
        || (input.path.is_some() && (input.query.is_some() || input.offset.is_some()))
        || (input.path.is_none() && input.start_line.is_some())
    {
        return Err(invalid());
    }
    let download = url(
        "https://codeload.github.com",
        [owner, repo, "zip"]
            .into_iter()
            .chain(input.git_ref.split('/')),
    );
    let key = input.repository.to_ascii_lowercase();
    let permit = REQUESTS.try_acquire().map_err(|_| {
        ConnectorError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "github_source_busy",
            "GitHub 源码读取繁忙，请稍后重试",
        )
    })?;
    let cached = CACHE.lock().ok().and_then(|cache| {
        cache
            .as_ref()
            .filter(|entry| {
                entry.run_id == run_id
                    && entry.repository == key
                    && entry.commit.eq_ignore_ascii_case(&input.git_ref)
            })
            .map(|entry| Arc::clone(&entry.bytes))
    });
    let downloaded = cached.is_none();
    let bytes = match cached {
        Some(bytes) => bytes,
        None => download_archive(download).await?,
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut archive =
            ZipArchive::new(Cursor::new(Arc::clone(&bytes))).map_err(|_| upstream())?;
        if archive.len() > ENTRY_LIMIT {
            return Err(too_large());
        }
        let commit = std::str::from_utf8(archive.comment())
            .ok()
            .filter(|value| sha(value))
            .ok_or_else(upstream)?
            .to_ascii_lowercase();
        if sha(&input.git_ref) && !commit.eq_ignore_ascii_case(&input.git_ref) {
            return Err(upstream());
        }
        if downloaded && let Ok(mut cache) = CACHE.lock() {
            *cache = Some(Snapshot {
                run_id,
                repository: key,
                commit: commit.clone(),
                bytes,
            });
        }
        inspect(&mut archive, &input, &commit)
    })
    .await
    .map_err(|_| upstream())?
}

async fn download_archive(download: Url) -> Result<Arc<[u8]>> {
    let mut response = HTTP
        .as_ref()
        .ok_or_else(upstream)?
        .get(download)
        .send()
        .await
        .map_err(|_| upstream())?;
    match response.status() {
        StatusCode::OK => (),
        StatusCode::NOT_FOUND => {
            return Err(ConnectorError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "github_archive_missing",
                "无法读取此公开仓库或版本，请核对链接；私有仓库需要先连接 GitHub",
            ));
        }
        StatusCode::TOO_MANY_REQUESTS => {
            return Err(ConnectorError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "github_rate_limited",
                "GitHub 暂时限制下载频率，请稍后重试",
            ));
        }
        _ => return Err(upstream()),
    }
    if response
        .content_length()
        .is_some_and(|len| len > ARCHIVE_LIMIT as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if bytes.len() + chunk.len() > ARCHIVE_LIMIT {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.into())
}

fn inspect(archive: &mut Archive, input: &Input, commit: &str) -> Result<Value> {
    let (owner, repo) = repository(&input.repository)?;
    let root = url("https://github.com", [owner, repo, "tree", commit]);
    let query = input.query.as_ref().map(|value| value.to_lowercase());
    let offset = input.offset.unwrap_or(0);
    let mut paths = Vec::new();
    let mut path_bytes = 0;
    let mut matching = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| upstream())?;
        let Ok(name) = entry.name() else { continue };
        let Some((_, path)) = name.split_once('/') else {
            continue;
        };
        if !entry.is_file() || !valid_path(path) {
            continue;
        }
        if let Some(target) = &input.path {
            if path == target {
                drop(name);
                drop(entry);
                return read_file(archive, index, input, commit);
            }
        } else if query
            .as_ref()
            .is_none_or(|q| path.to_lowercase().contains(q))
        {
            if matching >= offset && paths.len() < 30 && path_bytes + path.len() <= 12_000 {
                paths.push(path.to_owned());
                path_bytes += path.len();
            }
            matching += 1;
            if matching > offset + paths.len() {
                break;
            }
        }
    }
    if input.path.is_some() {
        return Ok(json!({"status":"file_not_found","commit":commit,"url":root.as_str()}));
    }
    let next_offset = (matching > offset + paths.len()).then_some(offset + paths.len());
    Ok(
        json!({"repository":input.repository,"commit":commit,"url":root.as_str(),"paths":paths,"next_offset":next_offset}),
    )
}

fn read_file(archive: &mut Archive, index: usize, input: &Input, commit: &str) -> Result<Value> {
    let (owner, repo) = repository(&input.repository)?;
    let path = input.path.as_deref().ok_or_else(invalid)?;
    let entry = archive.by_index(index).map_err(|_| upstream())?;
    if entry.size() > FILE_LIMIT {
        return Ok(json!({"status":"file_too_large","path":path,"commit":commit}));
    }
    let mut bytes = Vec::new();
    entry
        .take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| upstream())?;
    let Some(body) = std::str::from_utf8(&bytes).ok().filter(|body| {
        bytes.len() <= FILE_LIMIT as usize
            && !body
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }) else {
        return Ok(json!({"status":"not_utf8_source","path":path,"commit":commit}));
    };
    let start = input.start_line.unwrap_or(1);
    let mut lines = Vec::new();
    let mut remaining: usize = 10_000;
    let mut next_line = None;
    for (index, line) in body.lines().enumerate().skip(start - 1) {
        if lines.len() == 80 || remaining < 1024 {
            next_line = Some(index + 1);
            break;
        }
        let end = line.floor_char_boundary(line.len().min(1024));
        remaining -= end;
        lines.push(json!({"line":index+1,"text":&line[..end],"truncated":end < line.len()}));
    }
    let mut link = url(
        "https://github.com",
        [owner, repo, "blob", commit]
            .into_iter()
            .chain(path.split('/')),
    );
    if !lines.is_empty() {
        link.set_fragment(Some(&format!("L{start}-L{}", start + lines.len() - 1)));
    }
    Ok(
        json!({"repository":input.repository,"commit":commit,"path":path,"url":link.as_str(),"lines":lines,"next_line":next_line}),
    )
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;

    const COMMIT: &str = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

    #[test]
    fn lists_paths_and_reads_unicode_source_at_the_same_commit() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.set_comment(COMMIT).unwrap();
        writer
            .start_file("sample-HEAD/src/源 #.rs", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(format!("first\n{}\nthird\n", "汉".repeat(420)).as_bytes())
            .unwrap();
        writer
            .start_file("sample-HEAD/.gitignore", SimpleFileOptions::default())
            .unwrap();
        let bytes: Arc<[u8]> = writer.finish().unwrap().into_inner().into();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.comment(), COMMIT.as_bytes());
        let listing: Input =
            serde_json::from_value(json!({"repository":"owner/sample","query":"SRC"})).unwrap();
        let list = inspect(&mut archive, &listing, COMMIT).unwrap();
        assert_eq!(list["paths"], json!(["src/源 #.rs"]));
        assert_eq!(list["commit"], COMMIT);
        let file: Input = serde_json::from_value(
            json!({"repository":"owner/sample","path":"src/源 #.rs","start_line":2}),
        )
        .unwrap();
        let result = inspect(&mut archive, &file, COMMIT).unwrap();
        assert_eq!(result["lines"][0]["line"], 2);
        assert_eq!(
            result["lines"][0]["text"].as_str().unwrap().chars().count(),
            341
        );
        assert_eq!(result["lines"][0]["truncated"], true);
        assert_eq!(result["lines"][1]["text"], "third");
        assert!(
            result["url"]
                .as_str()
                .unwrap()
                .ends_with(&format!("/{COMMIT}/src/%E6%BA%90%20%23.rs#L2-L3"))
        );
    }

    #[test]
    fn repository_and_paths_cannot_change_the_github_origin() {
        for input in [
            "https://github.com/owner/repo",
            "owner/..",
            "owner/repo?ref=x",
            "owner/a/b",
        ] {
            assert!(repository(input).is_err(), "{input}");
        }
        for input in ["/etc/passwd", "../README", "src//file", "src\\file"] {
            assert!(!valid_path(input), "{input}");
        }
        assert!(valid_path("src/源 #.rs"));
    }
}
