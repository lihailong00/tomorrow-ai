//! The pinned official FlyAI CLI owns the vendor signature protocol. User keys
//! are passed only through a cleared child environment, never CLI arguments.
use super::transport::Credentials;
use crate::{ConnectorError, Result};
use axum::http::StatusCode;
use rand::RngCore;
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tokio::io::AsyncReadExt;

const MAX_BYTES: usize = 256 * 1024;

pub fn script() -> Option<PathBuf> {
    let relative = "services/agent/node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs";
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PERSONAL_MCP_FLIGGY_SCRIPT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(root) = std::env::current_dir() {
        candidates.push(root.join(relative));
        candidates.push(root.join("node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs"));
    }
    if let Ok(path) = std::env::current_exe() {
        if let Some(root) = path.parent().and_then(|parent| parent.parent()) {
            candidates.push(root.join(relative));
        }
    }
    candidates
        .into_iter()
        .find_map(|path| path.canonicalize().ok().filter(|path| path.is_file()))
}

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "请填写明确的飞猪旅行查询，不支持其他命令或参数",
    )
}
fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "not_configured",
        "服务器尚未安装已固定版本的飞猪官方连接组件",
    )
}
fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "fliggy_provider_error",
        "飞猪官方查询未成功，请检查个人 API Key、额度和服务状态",
    )
}
pub fn is_read_only(tool: &str) -> bool {
    matches!(tool, "fliggy_fast_search" | "fliggy_ai_search")
}
pub fn validate_arguments(tool: &str, args: &Value) -> Result<()> {
    if !is_read_only(tool)
        || !args.as_object().is_some_and(|object| object.len() == 1)
        || !args["query"].as_str().is_some_and(|query| {
            !query.trim().is_empty() && query.len() <= 2000 && !query.chars().any(char::is_control)
        })
    {
        return Err(invalid());
    }
    Ok(())
}

struct Home(PathBuf);
impl Home {
    fn create() -> Result<Self> {
        let mut random = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut random);
        let path = std::env::temp_dir().join(format!(
            "tada-flyai-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        std::fs::create_dir(&path).map_err(|_| unavailable())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| unavailable())?;
        }
        Ok(Self(path))
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn invoke(credentials: &Credentials, tool: &str, args: Value) -> Result<Value> {
    credentials.validate("fliggy")?;
    validate_arguments(tool, &args)?;
    let script = script().ok_or_else(unavailable)?;
    let home = Home::create()?;
    let node = std::env::var_os("PERSONAL_MCP_NODE").unwrap_or_else(|| "node".into());
    let mut command = tokio::process::Command::new(node);
    command
        .arg(script)
        .arg(if tool == "fliggy_fast_search" {
            "keyword-search"
        } else {
            "ai-search"
        })
        .arg("--query")
        .arg(args["query"].as_str().ok_or_else(invalid)?)
        .env_clear()
        .env("FLYAI_API_KEY", &credentials.token)
        .env("NO_COLOR", "1")
        .env("HOME", &home.0)
        .env("USERPROFILE", &home.0)
        .env("XDG_CONFIG_HOME", &home.0)
        .current_dir(&home.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(upstream)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| upstream())?;
    if bytes.len() > MAX_BYTES {
        let _ = child.kill().await;
        return Err(upstream());
    }
    if !child.wait().await.map_err(|_| upstream())?.success() {
        return Err(upstream());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| upstream())?;
    if !value.is_object()
        || (value["status"] != 0 && value["status"] != "0")
        || value.get("data").is_none_or(Value::is_null)
        || value["isError"] == true
        || value["success"] == false
        || value.get("error").is_some_and(|error| !error.is_null())
    {
        return Err(upstream());
    }
    Ok(value)
}

pub async fn discover(credentials: &Credentials) -> Result<Vec<Value>> {
    // CLI help and static schemas do not validate a personal API key. Perform
    // one bounded, read-only official query before saving a connection.
    invoke(
        credentials,
        "fliggy_fast_search",
        json!({"query":"杭州旅游"}),
    )
    .await?;
    Ok([("fliggy_fast_search", "飞猪关键词旅行搜索"), ("fliggy_ai_search", "飞猪自然语言旅行搜索")].into_iter().map(|(name, description)| json!({"name":name,"description":description,"inputSchema":{"type":"object","required":["query"],"additionalProperties":false,"properties":{"query":{"type":"string","minLength":1,"maxLength":2000}}}})).collect())
}
pub async fn call(credentials: &Credentials, tool: &str, args: Value) -> Result<Value> {
    invoke(credentials, tool, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn searches_are_fixed_and_arguments_cannot_become_flags() {
        assert!(validate_arguments("fliggy_fast_search", &json!({"query":"北京到杭州"})).is_ok());
        for value in [
            json!({"query":""}),
            json!({"query":"杭州", "endpoint":"https://invalid.test"}),
            json!({"query":"杭州\n--debug"}),
        ] {
            assert!(validate_arguments("fliggy_fast_search", &value).is_err());
        }
        assert!(validate_arguments("config", &json!({"query":"杭州"})).is_err());
        assert!(!is_read_only("book_flight"));
    }
}
