//! The official wallet CLI owns one local wallet identity. It is deliberately
//! restricted to ONE configured Tada owner in a dedicated OS service account.
//! HOME rewriting is not used to pretend this is a multi-tenant wallet SDK.
use super::validation::{provider_error, QueryReceipt};
use crate::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{future::Future, path::PathBuf, pin::Pin, process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, time::timeout};

pub(super) type RuntimeFuture<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
pub(super) enum Operation {
    Check,
    Apply,
    Bind(String),
    Manage,
    Pay {
        session: String,
        link: String,
        summary: String,
    },
    Query(QueryReceipt),
}
pub(super) trait WalletRuntime: Send + Sync {
    fn execute(&self, operation: Operation) -> RuntimeFuture<'_>;
}

pub(super) struct CliRuntime {
    binary: PathBuf,
    home: PathBuf,
    gate: Arc<Semaphore>,
}

const PINNED_SHA256: &str = "8e44c598f4eaca2241d0dd58972b28014cfd37e3511863ceff0eac6431e6b1dd";

impl CliRuntime {
    /// Only explicit environment configuration can provision this runtime.
    /// Ordinary administration flags and merchant keys cannot enable it.
    pub(super) fn configured() -> Option<(String, Arc<dyn WalletRuntime>)> {
        if std::env::var("ALIPAY_WALLET_RUNTIME").ok()?.as_str() != "official_cli_single_user" {
            return None;
        }
        let owner = std::env::var("ALIPAY_WALLET_OWNER_ID").ok()?;
        if owner.is_empty() || owner.len() > 100 || owner.chars().any(char::is_control) {
            return None;
        }
        let binary = PathBuf::from(std::env::var_os("ALIPAY_WALLET_CLI")?);
        let home = PathBuf::from(std::env::var_os("HOME")?);
        if !binary.is_absolute() || !home.is_absolute() || !dedicated_home(&home) {
            return None;
        }
        let marker = home.join(".tada-alipay-owner");
        let marker_meta = std::fs::symlink_metadata(&marker).ok()?;
        if !private_marker(&marker_meta, &home)
            || marker_meta.file_type().is_symlink()
            || std::fs::read_to_string(marker).ok()?.trim() != owner
        {
            return None;
        }
        let meta = std::fs::symlink_metadata(&binary).ok()?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 14_000_000 {
            return None;
        }
        let content = std::fs::read(&binary).ok()?;
        if format!("{:x}", Sha256::digest(&content)) != PINNED_SHA256 {
            return None;
        }
        Some((
            owner,
            Arc::new(Self {
                binary,
                home,
                gate: Arc::new(Semaphore::new(1)),
            }),
        ))
    }
}

#[cfg(target_os = "linux")]
fn dedicated_home(home: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::symlink_metadata(home) else {
        return false;
    };
    let Ok(process) = std::fs::metadata("/proc/self") else {
        return false;
    };
    // Requiring an actual private, non-root OS account avoids sharing root's
    // existing wallet or using another user's profile through environment flags.
    let real_home = std::fs::read_to_string("/etc/passwd")
        .ok()
        .is_some_and(|contents| {
            contents.lines().any(|line| {
                let fields: Vec<_> = line.split(':').collect();
                fields.len() == 7
                    && fields[2].parse::<u32>().ok() == Some(process.uid())
                    && std::path::Path::new(fields[5]) == home
            })
        });
    meta.is_dir()
        && home.ancestors().all(|part| {
            std::fs::symlink_metadata(part).is_ok_and(|meta| !meta.file_type().is_symlink())
        })
        && meta.uid() == process.uid()
        && meta.uid() != 0
        && meta.mode() & 0o077 == 0
        && real_home
}
#[cfg(not(target_os = "linux"))]
fn dedicated_home(_home: &std::path::Path) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn private_marker(marker: &std::fs::Metadata, home: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    marker.is_file()
        && marker.mode() & 0o077 == 0
        && std::fs::metadata(home).is_ok_and(|meta| meta.uid() == marker.uid())
}
#[cfg(not(target_os = "linux"))]
fn private_marker(_marker: &std::fs::Metadata, _home: &std::path::Path) -> bool {
    false
}

impl WalletRuntime for CliRuntime {
    fn execute(&self, operation: Operation) -> RuntimeFuture<'_> {
        Box::pin(async move {
            let _guard = self
                .gate
                .clone()
                .try_acquire_owned()
                .map_err(|_| super::busy())?;
            // Keep the profile lock in the supervising process. The CLI can
            // start helpers, which must not inherit the lock descriptor.
            let applying = matches!(&operation, Operation::Apply);
            let mut command = Command::new("/usr/bin/flock");
            command
                .args(["--wait", "3", "--conflict-exit-code", "73", "--close"])
                .arg(self.home.join(".tada-alipay-runtime.lock"))
                .args(["/usr/bin/timeout", "--kill-after=3s", "38s"])
                .arg(&self.binary);
            command
                .env_clear()
                .env("HOME", &self.home)
                .env("PATH", "/opt/tomorrow/bin:/usr/local/bin:/usr/bin:/bin")
                .env("LANG", "C.UTF-8")
                .env("AIPAY_OUTPUT_CHANNEL", "webchat")
                .current_dir(self.binary.parent().ok_or_else(provider_error)?)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            match operation {
                Operation::Check => {
                    command.arg("check-wallet");
                }
                Operation::Apply => {
                    command.args(["apply-wallet", "--agent-name", "妥啦"]);
                }
                Operation::Bind(code) => {
                    command.args(["bind-wallet", "--code", &code]);
                }
                Operation::Manage => {
                    command.arg("close-wallet");
                }
                Operation::Pay {
                    session,
                    link,
                    summary,
                } => {
                    command.args([
                        "submit-payment",
                        "--session-id",
                        &session,
                        "--payment-link",
                        &link,
                        "--intent-summary",
                        &summary,
                    ]);
                }
                Operation::Query(receipt) => {
                    command.arg("query-payment-status");
                    if let Some(order) = receipt.order {
                        command.args(["--out-shake-no", &order]);
                    } else if let Some(url) = receipt.url {
                        command.args(["--launch-url", &url]);
                    } else {
                        return Err(provider_error());
                    }
                }
            }
            command.arg("--json");
            let mut child = command.spawn().map_err(|_| provider_error())?;
            let mut stdout = child.stdout.take().ok_or_else(provider_error)?;
            let output = timeout(Duration::from_secs(46), async {
                let mut output = Vec::new();
                (&mut stdout)
                    .take(96 * 1024 + 1)
                    .read_to_end(&mut output)
                    .await
                    .map_err(|_| provider_error())?;
                if output.len() > 96 * 1024 {
                    return Err(provider_error());
                }
                let status = child.wait().await.map_err(|_| provider_error())?;
                if status.code() == Some(73) {
                    return Err(super::busy());
                }
                if matches!(status.code(), Some(124 | 137) | None) {
                    return Err(provider_error());
                }
                // Provider business failures may exit nonzero but still return
                // an authoritative bounded JSON envelope. Never expose stderr.
                let value: Value = serde_json::from_slice(&output).map_err(|_| provider_error())?;
                if applying && status.success() {
                    if let Some(link) = super::validation::native_apply_link(&value) {
                        return Ok(serde_json::json!({"code": 200, "access_url": link}));
                    }
                }
                if value.get("code").and_then(Value::as_i64).is_none() {
                    return Err(provider_error());
                }
                Ok(value)
            })
            .await;
            // The OS timeout bounds the CLI even if this Rust task is
            // cancelled. Keep the supervisor alive to hold the profile lock
            // until that command exits.
            output.unwrap_or_else(|_| Err(provider_error()))
        })
    }
}
