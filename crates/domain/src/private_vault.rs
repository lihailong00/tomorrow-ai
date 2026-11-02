//! Owner-scoped, opaque encrypted backups. Never a memory/resource/embedding.
use crate::{now, DomainError, Repository};
use serde::{Deserialize, Serialize};
use sqlx::Row;

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS private_vault_backups(
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version BIGINT NOT NULL, envelope TEXT, updated_at BIGINT NOT NULL
)";

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VaultEnvelope {
    pub schema: u32,
    pub algorithm: String,
    pub kid: String,
    pub iv: String,
    pub ciphertext: String,
}

impl VaultEnvelope {
    pub fn validate(&self) -> Result<(), DomainError> {
        fn base64_bytes(value: &str) -> Option<usize> {
            if value.is_empty() || value.len() % 4 != 0 {
                return None;
            }
            let core = value.trim_end_matches('=');
            let padding = value.len() - core.len();
            if padding > 2 || core.is_empty() {
                return None;
            }
            let sextet = |byte: u8| match byte {
                b'A'..=b'Z' => Some(byte - b'A'),
                b'a'..=b'z' => Some(byte - b'a' + 26),
                b'0'..=b'9' => Some(byte - b'0' + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            };
            let mut last = 0;
            for byte in core.bytes() {
                last = sextet(byte)?;
            }
            // Reject noncanonical trailing bits rather than accepting multiple
            // textual encodings of one AEAD envelope.
            if padding == 1 && last & 3 != 0 || padding == 2 && last & 15 != 0 {
                return None;
            }
            Some(value.len() / 4 * 3 - padding)
        }
        if self.schema != 1
            || self.algorithm != "A256GCM"
            || self.kid.len() != 32
            || !self
                .kid
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.iv.len() != 16
            || self.iv.contains('=')
            || base64_bytes(&self.iv) != Some(12)
            || !(24..=262168).contains(&self.ciphertext.len())
            || !base64_bytes(&self.ciphertext).is_some_and(|bytes| (16..=196624).contains(&bytes))
        {
            return Err(DomainError::Validation(
                "仅接受受支持格式的加密备份，不接收明文资料".into(),
            ));
        }
        Ok(())
    }
}

impl std::fmt::Debug for VaultEnvelope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("VaultEnvelope([redacted])")
    }
}

#[derive(Serialize, Deserialize)]
pub struct VaultBackup {
    pub version: i64,
    pub envelope: Option<VaultEnvelope>,
    pub updated_at: Option<i64>,
}

impl std::fmt::Debug for VaultBackup {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VaultBackup")
            .field("version", &self.version)
            .field("has_envelope", &self.envelope.is_some())
            .finish_non_exhaustive()
    }
}

impl Repository {
    pub async fn private_vault_backup(&self, user_id: &str) -> Result<VaultBackup, DomainError> {
        let row = sqlx::query(
            "SELECT version,envelope,updated_at FROM private_vault_backups WHERE user_id=$1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(VaultBackup {
                version: row.try_get("version")?,
                envelope: row
                    .try_get::<Option<String>, _>("envelope")?
                    .map(|value| {
                        serde_json::from_str(&value)
                            .map_err(|_| DomainError::Internal("加密备份格式不可读取".into()))
                    })
                    .transpose()?,
                updated_at: Some(row.try_get("updated_at")?),
            }),
            None => Ok(VaultBackup {
                version: 0,
                envelope: None,
                updated_at: None,
            }),
        }
    }

    /// Retain a version-only tombstone after deletion: an interrupted old PUT
    /// must never resurrect a deleted backup. Each update is an atomic CAS.
    pub async fn write_private_vault_backup(
        &self,
        user_id: &str,
        expected_version: i64,
        envelope: Option<VaultEnvelope>,
    ) -> Result<VaultBackup, DomainError> {
        if !(0..=9_007_199_254_740_990).contains(&expected_version) {
            return Err(DomainError::Validation("备份版本无效".into()));
        }
        if let Some(value) = &envelope {
            value.validate()?;
        }
        let body = envelope
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| DomainError::Validation("加密备份格式无效".into()))?;
        let updated = now();
        let row = if expected_version == 0 {
            sqlx::query("INSERT INTO private_vault_backups(user_id,version,envelope,updated_at) VALUES($1,1,$2,$3) ON CONFLICT(user_id) DO NOTHING RETURNING version")
                .bind(user_id).bind(body).bind(updated).fetch_optional(&self.pool).await?
        } else {
            sqlx::query("UPDATE private_vault_backups SET version=version+1,envelope=$1,updated_at=$2 WHERE user_id=$3 AND version=$4 RETURNING version")
                .bind(body).bind(updated).bind(user_id).bind(expected_version).fetch_optional(&self.pool).await?
        };
        let row = row.ok_or_else(|| {
            DomainError::Conflict("云端副本已发生变化，请刷新后重试；不会自动覆盖".into())
        })?;
        Ok(VaultBackup {
            version: row.try_get("version")?,
            envelope,
            updated_at: Some(updated),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_envelope_fields() {
        let envelope = VaultEnvelope {
            schema: 1,
            algorithm: "A256GCM".into(),
            kid: "0123456789abcdef0123456789abcdef".into(),
            iv: "AAAAAAAAAAAAAAAA".into(),
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==".into(),
        };
        let rendered = format!("{envelope:?}");
        assert!(!rendered.contains(&envelope.kid));
        assert!(!rendered.contains(&envelope.iv));
        assert!(!rendered.contains(&envelope.ciphertext));
        assert!(rendered.contains("redacted"));
        let backup = VaultBackup {
            version: 1,
            envelope: Some(envelope),
            updated_at: Some(1),
        };
        assert!(!format!("{backup:?}").contains("ciphertext"));
    }
}
