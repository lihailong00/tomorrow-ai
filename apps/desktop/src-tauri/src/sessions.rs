//! Session tokens are namespaced by canonical server origin and saved only in
//! the OS credential store. No file or localStorage plaintext fallback exists.

use crate::network::normalized_server;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());
const SERVICE: &str = "com.tada.desktop.session";

fn credential_key(server_url: &str, instance_id: &str) -> Result<String, String> {
    // LAN URL validation here does not grant permission to transmit HTTP. The
    // request bridge separately requires an explicit allowInsecureLan flag.
    let server = normalized_server(server_url, true)?;
    if instance_id.is_empty()
        || instance_id.len() > 128
        || !instance_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid server instance identity".into());
    }
    let identity = format!("{}\0{instance_id}", server.origin().ascii_serialization());
    Ok(format!("{:x}", Sha256::digest(identity.as_bytes())))
}

#[tauri::command]
pub async fn desktop_session_read(
    server_url: String,
    instance_id: String,
) -> Result<Option<String>, String> {
    let key = credential_key(&server_url, &instance_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "系统凭据库暂不可用")?;
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|_| "无法访问系统凭据库")?;
        match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取系统凭据库，请重新登录".to_owned()),
        }
    })
    .await
    .map_err(|_| "凭据读取被中断")?
}

#[tauri::command]
pub async fn desktop_session_write(
    server_url: String,
    instance_id: String,
    token: Option<String>,
) -> Result<(), String> {
    let key = credential_key(&server_url, &instance_id)?;
    if token.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 16_384 || value.contains(['\r', '\n'])
    }) {
        return Err("Invalid session token".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "系统凭据库暂不可用")?;
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|_| "无法访问系统凭据库")?;
        if let Some(token) = token {
            entry
                .set_password(&token)
                .map_err(|_| "无法保存到系统凭据库；本次登录仅在当前窗口有效".to_owned())
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("无法清除系统凭据库中的登录凭据".to_owned()),
            }
        }
    })
    .await
    .map_err(|_| "凭据写入被中断")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_isolated_by_origin() {
        assert_eq!(
            credential_key("https://EXAMPLE.com:443", "instance-a").unwrap(),
            credential_key("https://example.com/", "instance-a").unwrap()
        );
        assert_ne!(
            credential_key("https://example.com", "instance-a").unwrap(),
            credential_key("https://other.test", "instance-a").unwrap()
        );
        assert_ne!(
            credential_key("http://localhost:8080", "instance-a").unwrap(),
            credential_key("http://localhost:8081", "instance-a").unwrap()
        );
        assert_ne!(
            credential_key("https://example.com", "instance-a").unwrap(),
            credential_key("https://example.com", "instance-b").unwrap()
        );
        for invalid in ["", "with/slash", "with space", "with\nnewline"] {
            assert!(credential_key("https://example.com", invalid).is_err());
        }
    }
}
