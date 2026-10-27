//! Phone verification with backend-only SMS delivery and atomic challenge consumption.
use crate::{
    auth, new_id, now,
    phone_password::{hash_password, lock_password_state},
    sms::{hmac_sha256, AliyunPnvs, SmsMessage, SmsSender},
    validate_text, AuthSession, DomainError, Repository, User,
};
use rand::{rngs::OsRng, Rng};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{collections::HashSet, net::SocketAddr, sync::Arc};
use utoipa::ToSchema;

pub const TEST_PHONE_CODE: &str = "123456";
pub const CODE_LIFETIME_SECONDS: i64 = 300;
pub const CODE_RETRY_SECONDS: i64 = 60;
const MAX_CODE_ATTEMPTS: i64 = 5;
const PHONE_DAILY_LIMIT: i64 = 5;
const QUOTA_WINDOW_SECONDS: i64 = 86400;
const MAX_LEGACY_ATTEMPTS: i64 = 10000;

#[derive(Clone)]
pub struct PhoneAuth {
    sender: Option<Arc<dyn SmsSender>>,
    hash_key: Arc<str>,
    local_test: bool,
    daily_limit: i64,
    allowed_phones: Option<Arc<HashSet<String>>>,
}

impl PhoneAuth {
    pub fn disabled() -> Self {
        Self {
            sender: None,
            hash_key: Arc::from(""),
            local_test: false,
            daily_limit: 100,
            allowed_phones: None,
        }
    }

    /// Explicit dependency injection for local tests; runtime configuration additionally checks the bind address.
    pub fn local_test() -> Self {
        Self {
            sender: None,
            hash_key: Arc::from("local-test-only-do-not-use-in-production"),
            local_test: true,
            daily_limit: 100,
            allowed_phones: None,
        }
    }

    pub fn with_sender(sender: Arc<dyn SmsSender>, hash_key: String) -> Result<Self, DomainError> {
        if hash_key.len() < 32 {
            return Err(DomainError::Validation(
                "SMS_CODE_HASH_KEY 至少需要 32 字节随机密钥".into(),
            ));
        }
        Ok(Self {
            sender: Some(sender),
            hash_key: Arc::from(hash_key),
            local_test: false,
            daily_limit: 100,
            allowed_phones: None,
        })
    }

    /// Empty means open registration; malformed nonempty configuration fails closed.
    pub fn with_allowed_phones(mut self, value: &str) -> Result<Self, DomainError> {
        if value.trim().is_empty() {
            self.allowed_phones = None;
            return Ok(self);
        }
        let phones = value
            .split([',', '\n'])
            .map(|phone| {
                normalize_phone(phone).map_err(|_| {
                    DomainError::Validation(
                        "SMS_ALLOWED_PHONES 必须为逗号分隔的有效中国大陆手机号".into(),
                    )
                })
            })
            .collect::<Result<HashSet<_>, _>>()?;
        self.allowed_phones = Some(Arc::new(phones));
        Ok(self)
    }

    pub fn from_env() -> Result<Self, DomainError> {
        Self::from_settings(|key| std::env::var(key).ok())
    }

    fn from_settings(get: impl Fn(&str) -> Option<String>) -> Result<Self, DomainError> {
        let value = |key: &str| {
            get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let required = |key: &str| {
            value(key).ok_or_else(|| DomainError::Validation(format!("短信服务缺少 {key} 配置")))
        };
        let service = match value("PHONE_AUTH_MODE").as_deref().unwrap_or("disabled") {
            "disabled" => Ok(Self::disabled()),
            "local_test" => {
                let bind = value("API_BIND").unwrap_or_else(|| "127.0.0.1:8080".into());
                let loopback = bind
                    .parse::<SocketAddr>()
                    .is_ok_and(|a| a.ip().is_loopback());
                if value("APP_ENV").as_deref() != Some("local") || !loopback {
                    return Err(DomainError::Validation(
                        "固定测试验证码仅允许 APP_ENV=local 且 API_BIND 为本机回环地址".into(),
                    ));
                }
                Ok(Self::local_test())
            }
            "aliyun_pnvs" => {
                let id = required("ALIBABA_CLOUD_ACCESS_KEY_ID")?;
                let secret = required("ALIBABA_CLOUD_ACCESS_KEY_SECRET")?;
                let token = value("ALIBABA_CLOUD_SECURITY_TOKEN");
                // All values interpolated into HTTP headers must be valid before request construction.
                for input in std::iter::once(id.as_str()).chain(token.as_deref()) {
                    if reqwest::header::HeaderValue::from_str(input).is_err()
                        || input.contains([',', ';'])
                    {
                        return Err(DomainError::Validation("阿里云短信凭证格式无效".into()));
                    }
                }
                let sender = AliyunPnvs::new(
                    id,
                    secret,
                    token,
                    required("ALIYUN_PNVS_SIGN_NAME")?,
                    required("ALIYUN_PNVS_TEMPLATE_CODE")?,
                )?;
                let mut service =
                    Self::with_sender(Arc::new(sender), required("SMS_CODE_HASH_KEY")?)?;
                service.daily_limit = value("SMS_DAILY_LIMIT")
                    .unwrap_or_else(|| "100".into())
                    .parse::<i64>()
                    .ok()
                    .filter(|v| (1..=10000).contains(v))
                    .ok_or_else(|| {
                        DomainError::Validation("SMS_DAILY_LIMIT 必须是 1～10000 的整数".into())
                    })?;
                Ok(service)
            }
            _ => Err(DomainError::Validation(
                "PHONE_AUTH_MODE 必须为 disabled、local_test 或 aliyun_pnvs".into(),
            )),
        }?;
        service.with_allowed_phones(&get("SMS_ALLOWED_PHONES").unwrap_or_default())
    }

    pub fn ensure_available(&self) -> Result<(), DomainError> {
        if self.local_test || self.sender.is_some() {
            Ok(())
        } else {
            Err(DomainError::Unavailable(
                "短信验证码服务尚未配置，暂时无法获取验证码".into(),
            ))
        }
    }

    fn code_digest(&self, id: &str, phone: &str, purpose: PhonePurpose, code: &str) -> String {
        format!(
            "v2:{}",
            hmac_sha256(
                self.hash_key.as_bytes(),
                format!(
                    "tomorrow:sms:challenge:v2\0{id}\0{phone}\0{}\0{code}",
                    purpose.as_str()
                )
                .as_bytes()
            )
        )
    }

    pub async fn issue_code(
        &self,
        repository: &Repository,
        phone: &str,
        purpose: PhonePurpose,
    ) -> Result<PhoneCodeChallenge, DomainError> {
        self.ensure_available()?;
        let phone = normalize_phone(phone)?;
        if self
            .allowed_phones
            .as_ref()
            .is_some_and(|phones| !phones.contains(&phone))
        {
            return Err(DomainError::Forbidden);
        }
        let id = auth::generate_token();
        let code = if self.local_test {
            TEST_PHONE_CODE.to_owned()
        } else {
            format!("{:06}", OsRng.gen_range(0..1_000_000))
        };
        let created = repository
            .reserve_phone_code(&id, &phone, purpose, self.daily_limit, now)
            .await?;
        let expires_at = created + CODE_LIFETIME_SECONDS;
        if let Some(sender) = &self.sender {
            sender
                .send(SmsMessage {
                    phone: &phone,
                    code: &code,
                    challenge_id: &id,
                })
                .await?;
        }
        // A failed/unknown send never leaves an active challenge. The quota stays reserved.
        let changed = sqlx::query("UPDATE phone_codes SET code_hash=$1 WHERE id=$2 AND phone=$3 AND purpose=$4 AND code_hash='' AND consumed_at IS NULL AND expires_at>$5")
            .bind(self.code_digest(&id, &phone, purpose, &code)).bind(&id).bind(&phone).bind(purpose.as_str()).bind(now())
            .execute(&repository.pool).await?.rows_affected();
        if changed != 1 {
            return Err(DomainError::Conflict(
                "验证码已过期或已更新，请重新获取".into(),
            ));
        }
        Ok(PhoneCodeChallenge {
            challenge_id: id,
            expires_in: (expires_at - now()).max(0),
            retry_after: CODE_RETRY_SECONDS,
            test_mode: self.local_test,
        })
    }

    pub async fn consume_code(
        &self,
        repository: &Repository,
        phone: &str,
        purpose: PhonePurpose,
        id: &str,
        code: &str,
    ) -> Result<(), DomainError> {
        self.ensure_available()?;
        validate_code_input(id, code)?;
        let phone = normalize_phone(phone)?;
        let mut transaction = repository.pool.begin().await?;
        let accepted = self
            .consume_code_in_transaction(&mut transaction, &phone, purpose, id, code, now())
            .await?;
        // An invalid guess still commits its attempt count.
        transaction.commit().await?;
        if accepted {
            Ok(())
        } else {
            Err(invalid_code())
        }
    }

    async fn consume_code_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Any>,
        phone: &str,
        purpose: PhonePurpose,
        id: &str,
        code: &str,
        at: i64,
    ) -> Result<bool, DomainError> {
        // One write both reserves an attempt and claims a correct answer, preventing parallel guesses/replays.
        let accepted: Option<i64> = sqlx::query_scalar("UPDATE phone_codes SET attempts=attempts+1,consumed_at=CASE WHEN code_hash=$5 THEN $1 ELSE consumed_at END WHERE id=$2 AND phone=$3 AND purpose=$4 AND code_hash<>'' AND expires_at>$1 AND consumed_at IS NULL AND attempts<$6 RETURNING CAST(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END AS BIGINT)")
            .bind(at).bind(id).bind(phone).bind(purpose.as_str()).bind(self.code_digest(id, phone, purpose, code)).bind(MAX_CODE_ATTEMPTS)
            .fetch_optional(&mut **transaction).await?;
        Ok(accepted == Some(1))
    }

    pub async fn register_with_password(
        &self,
        repository: &Repository,
        phone: &str,
        code: &str,
        id: &str,
        password: String,
        name: &str,
        timezone: &str,
    ) -> Result<AuthSession, DomainError> {
        self.ensure_available()?;
        validate_code_input(id, code)?;
        let phone = normalize_phone(phone)?;
        let name = validate_text(name, "昵称", 80)?;
        if timezone.parse::<chrono_tz::Tz>().is_err() {
            return Err(DomainError::Validation("无效的 IANA 时区".into()));
        }
        // Validate/hash before consuming the SMS code, and outside the database lock.
        let password_hash = hash_password(password).await?;
        let mut transaction = repository.pool.begin().await?;
        lock_password_state(&mut transaction).await?;
        let at = now();
        if !self
            .consume_code_in_transaction(
                &mut transaction,
                &phone,
                PhonePurpose::Register,
                id,
                code,
                at,
            )
            .await?
        {
            transaction.commit().await?;
            return Err(invalid_code());
        }
        let existing: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM phone_identities WHERE phone=$1")
                .bind(&phone)
                .fetch_optional(&mut *transaction)
                .await?;
        if existing.is_some() {
            // Only a caller proving possession of this phone may learn that it
            // already has an account. A successful proof is still single-use.
            transaction.commit().await?;
            return Err(DomainError::Conflict("该手机号已注册，请切换到登录".into()));
        }
        let user_id = new_id();
        sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,'!phone-only',$3,$4,$5)")
            .bind(&user_id).bind(format!("{user_id}@phone.tomorrow.local")).bind(&name).bind(timezone).bind(at)
            .execute(&mut *transaction).await?;
        sqlx::query("INSERT INTO phone_identities(phone,user_id) VALUES($1,$2)")
            .bind(&phone)
            .bind(&user_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO phone_credentials(user_id,password_hash,updated_at) VALUES($1,$2,$3)",
        )
        .bind(&user_id)
        .bind(password_hash)
        .bind(at)
        .execute(&mut *transaction)
        .await?;
        let token = auth::generate_token();
        sqlx::query(
            "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)",
        )
        .bind(auth::hash_token(&token))
        .bind(&user_id)
        .bind(at + 30 * 86400)
        .bind(at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(AuthSession {
            user: repository.user(&user_id).await?,
            token,
        })
    }

    pub async fn reset_password(
        &self,
        repository: &Repository,
        phone: &str,
        code: &str,
        id: &str,
        new_password: String,
    ) -> Result<(), DomainError> {
        self.ensure_available()?;
        validate_code_input(id, code)?;
        let phone = normalize_phone(phone)?;
        let password_hash = hash_password(new_password).await?;
        let mut transaction = repository.pool.begin().await?;
        lock_password_state(&mut transaction).await?;
        let at = now();
        if !self
            .consume_code_in_transaction(
                &mut transaction,
                &phone,
                PhonePurpose::ResetPassword,
                id,
                code,
                at,
            )
            .await?
        {
            transaction.commit().await?;
            return Err(invalid_code());
        }
        let user_id: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM phone_identities WHERE phone=$1")
                .bind(&phone)
                .fetch_optional(&mut *transaction)
                .await?;
        let Some(user_id) = user_id else {
            // A verified code for an unknown phone does not create an account.
            transaction.commit().await?;
            return Err(invalid_code());
        };
        sqlx::query("INSERT INTO phone_credentials(user_id,password_hash,updated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET password_hash=$2,updated_at=$3")
            .bind(&user_id).bind(password_hash).bind(at).execute(&mut *transaction).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(&user_id)
            .execute(&mut *transaction)
            .await?;
        // Proof of phone possession may unlock password guessing; pending old-hash
        // logins still cannot create a session after the credential changes.
        sqlx::query("DELETE FROM phone_login_attempts WHERE phone=$1")
            .bind(&phone)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}

fn invalid_code() -> DomainError {
    DomainError::Validation("验证码错误、已使用或已过期，请重新获取".into())
}

/// Reject oversized/untrusted identifiers before hashing, normalization or database access.
pub fn validate_code_input(id: &str, code: &str) -> Result<(), DomainError> {
    if id.len() != 64
        || !id.bytes().all(|c| c.is_ascii_hexdigit())
        || code.len() != 6
        || !code.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(invalid_code());
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PhonePurpose {
    Register,
    ResetPassword,
}
impl PhonePurpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::ResetPassword => "reset_password",
        }
    }
}

#[derive(Serialize, ToSchema)]
pub struct PhoneCodeChallenge {
    pub challenge_id: String,
    pub expires_in: i64,
    pub retry_after: i64,
    pub test_mode: bool,
}

pub fn normalize_phone(value: &str) -> Result<String, DomainError> {
    if value.len() > 64 {
        return Err(DomainError::Validation("请输入有效的中国大陆手机号".into()));
    }
    let compact: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let number = compact
        .strip_prefix("+86")
        .or_else(|| compact.strip_prefix("0086"))
        .unwrap_or(&compact);
    let bytes = number.as_bytes();
    if bytes.len() != 11
        || bytes[0] != b'1'
        || !(b'3'..=b'9').contains(&bytes[1])
        || !bytes.iter().all(u8::is_ascii_digit)
    {
        return Err(DomainError::Validation("请输入有效的中国大陆手机号".into()));
    }
    Ok(format!("+86{number}"))
}

async fn import_legacy_limits(
    transaction: &mut sqlx::Transaction<'_, sqlx::Any>,
    created: i64,
) -> Result<(), DomainError> {
    let unavailable = || DomainError::Unavailable("短信验证码服务暂时无法使用".into());
    let rows = sqlx::query("SELECT scope,CAST(last_requested_at AS BIGINT) AS last_requested_at,CAST(requests AS BIGINT) AS requests,CAST(window_started_at AS BIGINT) AS window_started_at FROM phone_sms_limits WHERE last_requested_at>$1 OR requests<0 OR window_started_at>last_requested_at LIMIT 10002")
        .bind(created.saturating_sub(QUOTA_WINDOW_SECONDS))
        .fetch_all(&mut **transaction).await?;
    if rows.len() > MAX_LEGACY_ATTEMPTS as usize + 1 {
        return Err(unavailable());
    }
    let mut latest = 0;
    let mut global_count = 0;
    let mut phones = Vec::new();
    let mut phone_count: i64 = 0;
    for row in rows {
        let scope: String = row.try_get("scope")?;
        let time: i64 = row.try_get("last_requested_at")?;
        let count: i64 = row.try_get("requests")?;
        let started: i64 = row.try_get("window_started_at")?;
        if !(0..=MAX_LEGACY_ATTEMPTS).contains(&count) || time < 0 || started < 0 || started > time
        {
            return Err(unavailable());
        }
        latest = latest.max(time);
        if scope == "global" {
            global_count = count;
        } else if let Some(phone) = scope.strip_prefix("phone:") {
            let phone = normalize_phone(phone).map_err(|_| unavailable())?;
            phone_count = phone_count.checked_add(count).ok_or_else(unavailable)?;
            if phone_count > MAX_LEGACY_ATTEMPTS {
                return Err(unavailable());
            }
            phones.extend(std::iter::repeat_n(Some(phone), count as usize));
        } else {
            return Err(unavailable());
        }
    }
    // Legacy windows were anchored independently and exact timestamps are lost.
    // Put all remaining admissions at their common latest known time, so neither
    // a short global window nor a phone window can be reset by this upgrade.
    phones.extend(std::iter::repeat_n(
        None,
        (global_count - phone_count).max(0) as usize,
    ));
    for chunk in phones.chunks(200) {
        // Any's QueryBuilder emits '?' placeholders, which PostgreSQL does not
        // accept. Generate only numbered placeholders; every value stays bound.
        let values = (0..chunk.len())
            .map(|i| format!("(${},${},${})", i * 3 + 1, i * 3 + 2, i * 3 + 3))
            .collect::<Vec<_>>()
            .join(",");
        let statement =
            format!("INSERT INTO phone_sms_attempts(id,phone,requested_at) VALUES {values}");
        let mut query = sqlx::query(&statement);
        for phone in chunk {
            query = query.bind(new_id()).bind(phone.as_deref()).bind(latest);
        }
        query.execute(&mut **transaction).await?;
    }
    sqlx::query("UPDATE phone_sms_guard SET legacy_imported=1 WHERE id=1")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

impl Repository {
    async fn reserve_phone_code(
        &self,
        id: &str,
        phone: &str,
        purpose: PhonePurpose,
        daily_limit: i64,
        clock: impl FnOnce() -> i64 + Send,
    ) -> Result<i64, DomainError> {
        let mut transaction = self.pool.begin().await?;
        // This must be the transaction's first database operation: SQLite takes its
        // write lock before a read snapshot; PostgreSQL locks the same global row.
        let imported: Option<i64> = sqlx::query_scalar("UPDATE phone_sms_guard SET legacy_imported=legacy_imported WHERE id=1 RETURNING CAST(legacy_imported AS BIGINT)")
            .fetch_optional(&mut *transaction).await?;
        let imported = imported
            .ok_or_else(|| DomainError::Unavailable("短信验证码服务暂时无法使用".into()))?;
        // Sample the clock after waiting for the lock, never at request arrival.
        let created = clock();
        if imported == 0 {
            import_legacy_limits(&mut transaction, created).await?;
        } else if imported != 1 {
            return Err(DomainError::Unavailable(
                "短信验证码服务暂时无法使用".into(),
            ));
        }

        let mut retry_after = 0;
        for (scope_phone, limit, window) in [
            (None, 3, CODE_RETRY_SECONDS),
            (None, 10, 3600),
            (None, daily_limit, QUOTA_WINDOW_SECONDS),
            (Some(phone), 1, CODE_RETRY_SECONDS),
            (Some(phone), PHONE_DAILY_LIMIT, QUOTA_WINDOW_SECONDS),
        ] {
            // The Nth newest event gives the earliest time this window admits
            // another send. Include future events so clock rollback fails closed.
            let blocking_time: Option<i64> = if let Some(phone) = scope_phone {
                sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM phone_sms_attempts WHERE phone=$1 AND requested_at>$2 ORDER BY requested_at DESC LIMIT 1 OFFSET $3")
                    .bind(phone).bind(created.saturating_sub(window)).bind(limit-1)
                    .fetch_optional(&mut *transaction).await?
            } else {
                sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM phone_sms_attempts WHERE requested_at>$1 ORDER BY requested_at DESC LIMIT 1 OFFSET $2")
                    .bind(created.saturating_sub(window)).bind(limit-1)
                    .fetch_optional(&mut *transaction).await?
            };
            if let Some(time) = blocking_time {
                retry_after = retry_after.max(time.saturating_add(window).saturating_sub(created));
            }
        }
        if retry_after > 0 {
            // Preserve a completed one-time legacy import even when it blocks this request.
            transaction.commit().await?;
            return Err(DomainError::RateLimited { retry_after });
        }

        sqlx::query("INSERT INTO phone_sms_attempts(id,phone,requested_at) VALUES($1,$2,$3)")
            .bind(id)
            .bind(phone)
            .bind(created)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("INSERT INTO phone_codes(id,phone,purpose,code_hash,expires_at,attempts,consumed_at,created_at) VALUES($1,$2,$3,'',$4,0,NULL,$5) ON CONFLICT(phone,purpose) DO UPDATE SET id=$1,code_hash='',expires_at=$4,attempts=0,consumed_at=NULL,created_at=$5")
            .bind(id).bind(phone).bind(purpose.as_str()).bind(created+CODE_LIFETIME_SECONDS).bind(created)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(created)
    }

    pub async fn phone_user(&self, phone: &str) -> Result<Option<User>, DomainError> {
        let phone = normalize_phone(phone)?;
        let id: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM phone_identities WHERE phone=$1")
                .bind(phone)
                .fetch_optional(&self.pool)
                .await?;
        match id {
            Some(id) => self.user(&id).await.map(Some),
            None => Ok(None),
        }
    }

    pub async fn create_phone_user(
        &self,
        phone: &str,
        name: &str,
        timezone: &str,
    ) -> Result<User, DomainError> {
        let phone = normalize_phone(phone)?;
        let name = validate_text(name, "昵称", 80)?;
        if timezone.parse::<chrono_tz::Tz>().is_err() {
            return Err(DomainError::Validation("无效的 IANA 时区".into()));
        }
        let id = new_id();
        let mut transaction = self.pool.begin().await?;
        // Phone accounts cannot authenticate through the legacy email/password endpoint.
        sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(&id).bind(format!("{id}@phone.tomorrow.local")).bind("!phone-only")
            .bind(name).bind(timezone).bind(now()).execute(&mut *transaction).await?;
        let inserted = sqlx::query("INSERT INTO phone_identities(phone,user_id) VALUES($1,$2)")
            .bind(&phone)
            .bind(&id)
            .execute(&mut *transaction)
            .await;
        if let Err(error) = inserted {
            if error
                .as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return Err(DomainError::Conflict("该手机号已注册，请切换到登录".into()));
            }
            return Err(error.into());
        }
        transaction.commit().await?;
        self.user(&id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(entries: &[(&str, &str)]) -> Result<PhoneAuth, DomainError> {
        let map: HashMap<_, _> = entries.iter().copied().collect();
        PhoneAuth::from_settings(|key| map.get(key).map(|value| (*value).to_owned()))
    }

    #[test]
    fn sms_auth_is_disabled_by_default_and_local_test_requires_explicit_local_loopback() {
        assert!(config(&[]).unwrap().ensure_available().is_err());
        assert!(config(&[("PHONE_AUTH_MODE", "local_test")]).is_err());
        assert!(config(&[
            ("PHONE_AUTH_MODE", "local_test"),
            ("APP_ENV", "production"),
            ("API_BIND", "127.0.0.1:8080")
        ])
        .is_err());
        assert!(config(&[
            ("PHONE_AUTH_MODE", "local_test"),
            ("APP_ENV", "local"),
            ("API_BIND", "0.0.0.0:8080")
        ])
        .is_err());
        assert!(config(&[
            ("PHONE_AUTH_MODE", "local_test"),
            ("APP_ENV", "local"),
            ("API_BIND", "127.0.0.1:8080")
        ])
        .unwrap()
        .ensure_available()
        .is_ok());
        assert!(config(&[
            ("PHONE_AUTH_MODE", "local_test"),
            ("APP_ENV", "local"),
            ("API_BIND", "[::1]:8080")
        ])
        .is_ok());
    }

    #[test]
    fn real_sms_requires_complete_config_and_rejects_unsafe_credentials() {
        assert!(config(&[("PHONE_AUTH_MODE", "aliyun_pnvs")]).is_err());
        let mut entries = vec![
            ("PHONE_AUTH_MODE", "aliyun_pnvs"),
            ("APP_ENV", "production"),
            ("ALIBABA_CLOUD_ACCESS_KEY_ID", "fake-test-id"),
            ("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "fake-test-secret"),
            ("ALIYUN_PNVS_SIGN_NAME", "控制台签名"),
            ("ALIYUN_PNVS_TEMPLATE_CODE", "100001"),
            ("SMS_CODE_HASH_KEY", "fake-test-secret-32bytes-long-value"),
            ("SMS_DAILY_LIMIT", "20"),
        ];
        let auth = config(&entries).unwrap();
        assert_eq!(auth.daily_limit, 20);
        assert!(!auth.local_test);
        entries[2].1 = "id\r\ninjected";
        assert!(config(&entries).is_err());
        entries[2].1 = "fake-test-id";
        entries[6].1 = "short";
        assert!(config(&entries).is_err());
    }

    #[test]
    fn allowlist_config_is_normalized_and_invalid_nonempty_values_fail_closed() {
        let entries = [
            ("PHONE_AUTH_MODE", "local_test"),
            ("APP_ENV", "local"),
            ("SMS_ALLOWED_PHONES", "+86 138-0013-8000,008613800138000"),
        ];
        let auth = config(&entries).unwrap();
        let phones = auth.allowed_phones.unwrap();
        assert_eq!(phones.len(), 1);
        assert!(phones.contains("+8613800138000"));
        for value in [",", "13800138000,", "13800138000,invalid", "，"] {
            let mut entries = entries;
            entries[2].1 = value;
            assert!(config(&entries).is_err());
        }
        assert!(PhoneAuth::local_test()
            .with_allowed_phones("  ")
            .unwrap()
            .allowed_phones
            .is_none());
    }

    async fn reserve_at(
        repo: &Repository,
        phone: &str,
        created: i64,
        daily_limit: i64,
    ) -> Result<i64, DomainError> {
        repo.reserve_phone_code(
            &auth::generate_token(),
            &normalize_phone(phone).unwrap(),
            PhonePurpose::ResetPassword,
            daily_limit,
            move || created,
        )
        .await
    }

    fn rate_limit(result: Result<i64, DomainError>, expected: i64) {
        assert!(
            matches!(result, Err(DomainError::RateLimited { retry_after }) if retry_after == expected),
            "expected Retry-After={expected}, got {result:?}"
        );
    }

    async fn event_count(repo: &Repository) -> i64 {
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts")
            .fetch_one(&repo.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn phone_windows_are_strictly_rolling_with_exact_second_boundaries() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let t = 100000;
        reserve_at(&repo, "13800138000", t, 20).await.unwrap();
        rate_limit(reserve_at(&repo, "13800138000", t + 59, 20).await, 1);
        for i in 1..5 {
            reserve_at(&repo, "13800138000", t + i * 60, 20)
                .await
                .unwrap();
        }
        rate_limit(
            reserve_at(&repo, "13800138000", t + 300, 20).await,
            86400 - 300,
        );
        assert_eq!(event_count(&repo).await, 5);
        rate_limit(reserve_at(&repo, "13800138000", t + 86399, 20).await, 1);
        reserve_at(&repo, "13800138000", t + 86400, 20)
            .await
            .unwrap();
        // The oldest event expiring does not reset the other four admissions.
        rate_limit(reserve_at(&repo, "13800138000", t + 86459, 20).await, 1);
        reserve_at(&repo, "13800138000", t + 86460, 20)
            .await
            .unwrap();
        assert_eq!(event_count(&repo).await, 7);
    }

    #[tokio::test]
    async fn global_minute_hour_and_day_are_independent_sliding_windows() {
        let t = 100000;
        let minute = Repository::connect("sqlite::memory:").await.unwrap();
        for i in 0..3 {
            reserve_at(&minute, &format!("138{i:08}"), t, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&minute, "13900139000", t + 59, 20).await, 1);
        reserve_at(&minute, "13900139000", t + 60, 20)
            .await
            .unwrap();

        let hour = Repository::connect("sqlite::memory:").await.unwrap();
        for i in 0..10 {
            reserve_at(&hour, &format!("138{i:08}"), t + i * 60, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&hour, "13900139000", t + 3599, 20).await, 1);
        reserve_at(&hour, "13900139000", t + 3600, 20)
            .await
            .unwrap();
        rate_limit(reserve_at(&hour, "13700137000", t + 3601, 20).await, 59);

        let day = Repository::connect("sqlite::memory:").await.unwrap();
        for i in 0..20 {
            reserve_at(&day, &format!("138{i:08}"), t + i * 360, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&day, "13900139000", t + 86399, 20).await, 1);
        reserve_at(&day, "13900139000", t + 86400, 20)
            .await
            .unwrap();
        rate_limit(reserve_at(&day, "13700137000", t + 86401, 20).await, 359);
        assert_eq!(event_count(&day).await, 21);
    }

    #[tokio::test]
    async fn concurrent_independent_repositories_and_restarts_share_the_same_budget() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!(
            "sqlite:{}",
            directory.path().join("quota.db").to_string_lossy()
        );
        let first = Repository::connect(&url).await.unwrap();
        let second = Repository::connect(&url).await.unwrap();
        let mut handles = Vec::new();
        for i in 0..40 {
            let repo = if i % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            handles.push(tokio::spawn(async move {
                reserve_at(&repo, &format!("138{i:08}"), 100000, 20).await
            }));
        }
        let mut admitted = 0;
        for handle in handles {
            match handle.await.unwrap() {
                Ok(_) => admitted += 1,
                Err(DomainError::RateLimited { retry_after: 60 }) => (),
                result => panic!("unexpected admission result: {result:?}"),
            }
        }
        assert_eq!(admitted, 3);
        assert_eq!(event_count(&first).await, 3);
        first.pool.close().await;
        second.pool.close().await;
        let reopened = Repository::connect(&url).await.unwrap();
        rate_limit(reserve_at(&reopened, "13900139000", 100059, 20).await, 1);
        assert_eq!(event_count(&reopened).await, 3);
        reserve_at(&reopened, "13900139000", 100060, 20)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn clock_rollback_does_not_ignore_future_admissions() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        reserve_at(&repo, "13800138000", 100000, 20).await.unwrap();
        rate_limit(reserve_at(&repo, "13800138000", 99700, 20).await, 360);
        assert_eq!(event_count(&repo).await, 1);
    }

    async fn legacy(repo: &Repository, scope: &str, started: i64, last: i64, requests: i64) {
        sqlx::query("INSERT INTO phone_sms_limits(scope,window_started_at,last_requested_at,requests) VALUES($1,$2,$3,$4)")
            .bind(scope).bind(started).bind(last).bind(requests).execute(&repo.pool).await.unwrap();
    }

    #[tokio::test]
    async fn legacy_counters_import_once_and_a_rejected_request_commits_the_import() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!(
            "sqlite:{}",
            directory.path().join("legacy.db").to_string_lossy()
        );
        let repo = Repository::connect(&url).await.unwrap();
        legacy(&repo, "global", 90000, 100000, 3).await;
        legacy(&repo, "phone:+8613800138000", 90000, 99990, 3).await;
        legacy(&repo, "phone:+8613700137000", 0, 10000, 5).await;
        rate_limit(reserve_at(&repo, "13800138000", 100000, 20).await, 60);
        assert_eq!(event_count(&repo).await, 3);
        let marker: i64 = sqlx::query_scalar(
            "SELECT CAST(legacy_imported AS BIGINT) FROM phone_sms_guard WHERE id=1",
        )
        .fetch_one(&repo.pool)
        .await
        .unwrap();
        assert_eq!(marker, 1);
        let times: Vec<i64> =
            sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM phone_sms_attempts")
                .fetch_all(&repo.pool)
                .await
                .unwrap();
        assert_eq!(times, vec![100000; 3]);
        repo.pool.close().await;
        let reopened = Repository::connect(&url).await.unwrap();
        reserve_at(&reopened, "13900139000", 100060, 20)
            .await
            .unwrap();
        assert_eq!(event_count(&reopened).await, 4);
        rate_limit(reserve_at(&reopened, "13800138000", 100060, 3).await, 86340);
        assert_eq!(event_count(&reopened).await, 4);
    }

    #[tokio::test]
    async fn legacy_global_residual_is_retained_and_corrupt_counters_fail_closed() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        legacy(&repo, "global", 99900, 100000, 5).await;
        legacy(&repo, "phone:+8613800138000", 99900, 99999, 2).await;
        rate_limit(reserve_at(&repo, "13900139000", 100000, 20).await, 60);
        assert_eq!(event_count(&repo).await, 5);
        let residual: i64 = sqlx::query_scalar(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts WHERE phone IS NULL",
        )
        .fetch_one(&repo.pool)
        .await
        .unwrap();
        assert_eq!(residual, 3);
        for count in [-1, MAX_LEGACY_ATTEMPTS + 1] {
            let corrupt = Repository::connect("sqlite::memory:").await.unwrap();
            legacy(&corrupt, "global", 99900, 100000, count).await;
            assert!(matches!(
                reserve_at(&corrupt, "13900139000", 100000, 20).await,
                Err(DomainError::Unavailable(_))
            ));
            assert_eq!(event_count(&corrupt).await, 0);
            let marker: i64 = sqlx::query_scalar(
                "SELECT CAST(legacy_imported AS BIGINT) FROM phone_sms_guard WHERE id=1",
            )
            .fetch_one(&corrupt.pool)
            .await
            .unwrap();
            assert_eq!(marker, 0);
        }
    }

    #[tokio::test]
    #[ignore = "Requires an isolated PostgreSQL test database via TEST_SMS_DATABASE_URL; never sends SMS"]
    async fn postgres_sms_rolling_quota_and_legacy_import() {
        let url =
            std::env::var("TEST_SMS_DATABASE_URL").expect("set a disposable TEST_SMS_DATABASE_URL");
        let database = url
            .rsplit('/')
            .next()
            .unwrap_or("")
            .split('?')
            .next()
            .unwrap_or("");
        assert!(
            url.starts_with("postgres") && database.starts_with("tomorrow_sms_test_"),
            "SMS tests require a separate tomorrow_sms_test_* PostgreSQL database"
        );
        let first = Repository::connect(&url).await.unwrap();
        for statement in [
            "DELETE FROM phone_codes",
            "DELETE FROM phone_sms_attempts",
            "DELETE FROM phone_sms_limits",
            "UPDATE phone_sms_guard SET legacy_imported=0 WHERE id=1",
        ] {
            sqlx::query(statement).execute(&first.pool).await.unwrap();
        }
        legacy(&first, "global", 99900, 100000, 5).await;
        legacy(&first, "phone:+8613800138000", 99900, 99999, 2).await;
        rate_limit(reserve_at(&first, "13900139000", 100000, 20).await, 60);
        let residual: i64 = sqlx::query_scalar(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts WHERE phone IS NULL",
        )
        .fetch_one(&first.pool)
        .await
        .unwrap();
        assert_eq!(residual, 3);
        assert_eq!(event_count(&first).await, 5);
        let second = Repository::connect(&url).await.unwrap();
        assert_eq!(event_count(&second).await, 5);
        for statement in [
            "DELETE FROM phone_codes",
            "DELETE FROM phone_sms_attempts",
            "DELETE FROM phone_sms_limits",
        ] {
            sqlx::query(statement).execute(&first.pool).await.unwrap();
        }
        let mut handles = Vec::new();
        for i in 0..50 {
            let repo = if i % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            handles.push(tokio::spawn(async move {
                reserve_at(&repo, &format!("138{i:08}"), 100000, 20).await
            }));
        }
        let mut admitted = 0;
        for handle in handles {
            match handle.await.unwrap() {
                Ok(_) => admitted += 1,
                Err(DomainError::RateLimited { retry_after: 60 }) => (),
                result => panic!("unexpected PostgreSQL result: {result:?}"),
            }
        }
        assert_eq!(admitted, 3);
        assert_eq!(event_count(&first).await, 3);
        rate_limit(reserve_at(&first, "13900139000", 100059, 20).await, 1);
        reserve_at(&first, "13900139000", 100060, 20).await.unwrap();
        for statement in ["DELETE FROM phone_codes", "DELETE FROM phone_sms_attempts"] {
            sqlx::query(statement).execute(&first.pool).await.unwrap();
        }
        for i in 0..5 {
            reserve_at(&first, "13800138000", 100000 + i * 60, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&first, "13800138000", 186399, 20).await, 1);
        reserve_at(&first, "13800138000", 186400, 20).await.unwrap();
        rate_limit(reserve_at(&first, "13800138000", 186459, 20).await, 1);
        for statement in ["DELETE FROM phone_codes", "DELETE FROM phone_sms_attempts"] {
            sqlx::query(statement).execute(&first.pool).await.unwrap();
        }
        for i in 0..10 {
            reserve_at(&first, &format!("138{i:08}"), 100000 + i * 60, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&first, "13900139000", 103599, 20).await, 1);
        reserve_at(&first, "13900139000", 103600, 20).await.unwrap();
        rate_limit(reserve_at(&first, "13700137000", 103601, 20).await, 59);
        for statement in ["DELETE FROM phone_codes", "DELETE FROM phone_sms_attempts"] {
            sqlx::query(statement).execute(&first.pool).await.unwrap();
        }
        for i in 0..20 {
            reserve_at(&first, &format!("138{i:08}"), 100000 + i * 360, 20)
                .await
                .unwrap();
        }
        rate_limit(reserve_at(&first, "13900139000", 186399, 20).await, 1);
        reserve_at(&first, "13900139000", 186400, 20).await.unwrap();
        rate_limit(reserve_at(&first, "13700137000", 186401, 20).await, 359);
    }
}
