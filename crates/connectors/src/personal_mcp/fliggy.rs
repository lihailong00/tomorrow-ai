//! The pinned official FlyAI CLI owns the vendor signature protocol. User keys
//! are passed only through a cleared child environment, never CLI arguments.
use super::transport::Credentials;
use crate::{ConnectorError, Result};
use axum::http::StatusCode;
use chrono::NaiveDate;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::LazyLock};
use tokio::io::AsyncReadExt;

const MAX_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
struct Tool {
    name: String,
    command: String,
    description: String,
    group: Option<String>,
    required: Vec<String>,
    #[serde(default)]
    properties: Map<String, Value>,
}

#[derive(Deserialize)]
struct Catalog {
    parameter_groups: HashMap<String, Map<String, Value>>,
    tools: Vec<Tool>,
}

static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    let Catalog {
        parameter_groups,
        mut tools,
    } = serde_json::from_str(include_str!("fliggy_tools.json"))
        .expect("valid FlyAI tool definitions");
    for tool in &mut tools {
        if let Some(group) = tool.group.take() {
            let mut properties = parameter_groups[&group].clone();
            properties.append(&mut tool.properties);
            tool.properties = properties;
        }
    }
    tools
});

fn find_tool(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|tool| tool.name == name)
}

pub(super) fn tool_catalog() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": {
                    "type": "object",
                    "properties": tool.properties,
                    "required": tool.required,
                    "additionalProperties": false
                },
                "requires_confirmation": false
            })
        })
        .collect()
}

pub(super) fn is_legacy_catalog(tools: &[Value]) -> bool {
    tools.len() == 2
        && ["fliggy_fast_search", "fliggy_ai_search"]
            .iter()
            .all(|name| {
                tools
                    .iter()
                    .any(|tool| tool["name"].as_str() == Some(*name))
            })
}

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
    find_tool(tool).is_some()
}
fn valid_parameter(schema: &Value, value: &Value) -> bool {
    if schema["enum"]
        .as_array()
        .is_some_and(|values| !values.contains(value))
    {
        return false;
    }
    match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|text| {
            let max_bytes = schema["maxLength"].as_u64().unwrap_or(2000) as usize;
            !text.trim().is_empty()
                && text.len() <= max_bytes
                && !text.chars().any(char::is_control)
                && (schema["format"] != "date"
                    || (text.len() == 10
                        && NaiveDate::parse_from_str(text, "%Y-%m-%d")
                            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == text)))
        }),
        Some("integer" | "number") => {
            (schema["type"] == "number" || value.is_i64())
                && value.as_f64().is_some_and(|number| {
                    schema["minimum"].as_f64().is_none_or(|min| number >= min)
                        && schema["maximum"].as_f64().is_none_or(|max| number <= max)
                })
        }
        _ => false,
    }
}

fn validated_tool(name: &str, arguments: &Value) -> Result<&'static Tool> {
    let tool = find_tool(name).ok_or_else(invalid)?;
    let arguments = arguments.as_object().ok_or_else(invalid)?;
    if !tool.required.iter().all(|key| arguments.contains_key(key))
        || !arguments.iter().all(|(key, value)| {
            tool.properties
                .get(key)
                .is_some_and(|schema| valid_parameter(schema, value))
        })
    {
        return Err(invalid());
    }
    Ok(tool)
}

pub fn validate_arguments(tool: &str, arguments: &Value) -> Result<()> {
    validated_tool(tool, arguments).map(|_| ())
}

fn cli_arguments(name: &str, arguments: &Value) -> Result<Vec<String>> {
    let tool = validated_tool(name, arguments)?;
    let mut argv = vec![tool.command.clone()];
    for (key, value) in arguments.as_object().expect("validated object") {
        let value = match value {
            Value::String(text) => text.clone(),
            _ => value.to_string(),
        };
        // Bind the value to its allowlisted flag even when it starts with a dash.
        argv.push(format!("--{}={value}", key.replace('_', "-")));
    }
    Ok(argv)
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
    let argv = cli_arguments(tool, &args)?;
    let script = script().ok_or_else(unavailable)?;
    let home = Home::create()?;
    let node = std::env::var_os("PERSONAL_MCP_NODE").unwrap_or_else(|| "node".into());
    let mut command = tokio::process::Command::new(node);
    command
        .arg(script)
        .args(argv)
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
    parse_result(&bytes)
}

fn parse_result(bytes: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| upstream())?;
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
    Ok(tool_catalog())
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
        assert_eq!(
            cli_arguments("fliggy_search_poi", &json!({"city_name":"--help"})).unwrap(),
            ["search-poi", "--city-name=--help"]
        );
        for args in [
            json!({"destination":"成都"}),
            json!({"origin":"上海","dep_date":"2026-02-30"}),
            json!({"origin":"上海","sort_type":"3"}),
            json!({"origin":"上海","journey_type":3}),
            json!({"origin":"上海","max_price":-1}),
            json!({"origin":"上海","token":"secret"}),
        ] {
            assert!(validate_arguments("fliggy_search_flight", &args).is_err());
        }
        assert!(
            validate_arguments(
                "fliggy_search_marriott_hotel",
                &json!({
                    "dest_name":"上海","hotel_brands":"万豪"
                })
            )
            .is_err()
        );
    }

    #[test]
    fn all_eight_tools_route_to_the_official_commands_and_parse_their_receipts() {
        let commands = [
            ("fliggy_fast_search", "keyword-search"),
            ("fliggy_ai_search", "ai-search"),
            ("fliggy_search_flight", "search-flight"),
            ("fliggy_search_train", "search-train"),
            ("fliggy_search_hotel", "search-hotel"),
            ("fliggy_search_poi", "search-poi"),
            ("fliggy_search_marriott_hotel", "search-marriott-hotel"),
            ("fliggy_search_marriott_package", "search-marriott-package"),
        ];
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../services/agent/benchmarks/fliggy-receipts.json"
        ))
        .unwrap();
        let catalog = tool_catalog();
        assert_eq!(catalog.len(), commands.len());
        for (tool, command) in commands {
            let definition = catalog.iter().find(|item| item["name"] == tool).unwrap();
            assert_eq!(definition["requires_confirmation"], false);
            assert!(is_read_only(tool));
            let sample = fixtures["samples"]
                .as_array()
                .unwrap()
                .iter()
                .find(|sample| sample["tool"] == tool)
                .unwrap();
            let argv = cli_arguments(tool, &sample["arguments"]).unwrap();
            assert_eq!(argv[0], command);
            let args = sample["arguments"].as_object().unwrap();
            assert_eq!(argv.len(), args.len() + 1);
            for (key, value) in args {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                assert!(argv.contains(&format!("--{}={value}", key.replace('_', "-"))));
            }
            let response = &sample["response"];
            assert_eq!(
                parse_result(&serde_json::to_vec(response).unwrap()).unwrap(),
                *response
            );
            for failure in [
                json!({"status":401,"message":"unauthorized","data":{}}),
                json!({"status":0,"data":null}),
                json!({"status":0,"data":{},"isError":true}),
            ] {
                assert!(parse_result(&serde_json::to_vec(&failure).unwrap()).is_err());
            }
        }
    }
}
