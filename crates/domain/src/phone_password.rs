//! Phone/password login is independent of SMS availability.
use crate::{
    auth, new_id, now, phone::normalize_phone, timestamp, AuthSession, DomainError, Repository,
    User,
};
use sqlx::{Any, Row, Transaction};
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const LOGIN_WINDOW_SECONDS: i64 = 900;
const PHONE_ATTEMPT_LIMIT: i64 = 10;
const GLOBAL_ATTEMPT_LIMIT: i64 = 10000;
const SESSION_LIFETIME_SECONDS: i64 = 30 * 86400;
static PASSWORD_CPU: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

// A syntactically valid, fixed dummy PHC uses exactly Argon2::default() parameters.
// It belongs to no account; unknown identities are rejected irrespective of its verification result.
const DUMMY_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR0b21vcnJvdw$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn acquire_password_cpu() -> Result<OwnedSemaphorePermit, DomainError> {
    PASSWORD_CPU
        .clone()
        .try_acquire_owned()
        .map_err(|_| DomainError::LoginRateLimited { retry_after: 1 })
}

/// A cancelled async caller cannot release the CPU permit before blocking work finishes.
async fn password_job<T: Send + 'static>(
    permit: OwnedSemaphorePermit,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, DomainError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| DomainError::Internal("密码处理失败".into()))
}

pub async fn hash_password(password: String) -> Result<String, DomainError> {
    auth::validate_password(&password)?;
    let permit = acquire_password_cpu()?;
    password_job(permit, move || auth::hash_password(&password)).await?
}

/// Must be the first database operation in a credential-changing transaction.
pub(crate) async fn lock_password_state(
    transaction: &mut Transaction<'_, Any>,
) -> Result<(), DomainError> {
    let changed = sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    if changed == 1 {
        Ok(())
    } else {
        Err(DomainError::Unavailable("登录服务暂时无法使用".into()))
    }
}

struct LoginReservation {
    id: String,
    credential: Option<Credential>,
}

struct Credential {
    user_id: String,
    password_hash: String,
}

async fn reserve_login_attempt(
    repository: &Repository,
    phone: &str,
    clock: impl FnOnce() -> i64,
) -> Result<LoginReservation, DomainError> {
    let mut transaction = repository.pool.begin().await?;
    lock_password_state(&mut transaction).await?;
    let created = clock();
    let cutoff = created.saturating_sub(LOGIN_WINDOW_SECONDS);
    sqlx::query("DELETE FROM phone_login_attempts WHERE requested_at<=$1")
        .bind(cutoff)
        .execute(&mut *transaction)
        .await?;
    let blocking_time: Option<i64> = sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM phone_login_attempts WHERE phone=$1 AND requested_at>$2 ORDER BY requested_at DESC LIMIT 1 OFFSET $3")
        .bind(phone).bind(cutoff).bind(PHONE_ATTEMPT_LIMIT-1)
        .fetch_optional(&mut *transaction).await?;
    if let Some(time) = blocking_time {
        return Err(DomainError::LoginRateLimited {
            retry_after: time
                .saturating_add(LOGIN_WINDOW_SECONDS)
                .saturating_sub(created)
                .max(1),
        });
    }
    let count: i64 =
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_login_attempts")
            .fetch_one(&mut *transaction)
            .await?;
    if count >= GLOBAL_ATTEMPT_LIMIT {
        let oldest: Option<i64> = sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM phone_login_attempts ORDER BY requested_at LIMIT 1")
            .fetch_optional(&mut *transaction).await?;
        return Err(DomainError::LoginRateLimited {
            retry_after: oldest
                .map(|time| {
                    time.saturating_add(LOGIN_WINDOW_SECONDS)
                        .saturating_sub(created)
                        .max(1)
                })
                .unwrap_or(1),
        });
    }
    let id = new_id();
    sqlx::query("INSERT INTO phone_login_attempts(id,phone,requested_at) VALUES($1,$2,$3)")
        .bind(&id)
        .bind(phone)
        .bind(created)
        .execute(&mut *transaction)
        .await?;
    let credential = sqlx::query("SELECT c.user_id,c.password_hash FROM phone_credentials c JOIN phone_identities p ON p.user_id=c.user_id WHERE p.phone=$1 AND NOT EXISTS(SELECT 1 FROM admin_user_controls a WHERE a.user_id=c.user_id AND a.disabled<>0)")
        .bind(phone).fetch_optional(&mut *transaction).await?
        .map(|row| -> Result<Credential, DomainError> {
            Ok(Credential { user_id: row.try_get("user_id")?, password_hash: row.try_get("password_hash")? })
        }).transpose()?;
    transaction.commit().await?;
    Ok(LoginReservation { id, credential })
}

async fn complete_login(
    repository: &Repository,
    phone: &str,
    attempt_id: &str,
    credential: &Credential,
    clock: impl FnOnce() -> i64,
) -> Result<AuthSession, DomainError> {
    let mut transaction = repository.pool.begin().await?;
    lock_password_state(&mut transaction).await?;
    let created = clock();
    let token = auth::generate_token();
    // Reset/registration uses this same guard. A stale hash or removed/expired
    // reservation must never create a session after an intervening reset.
    let inserted = sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) SELECT $1,c.user_id,$2,$3 FROM phone_credentials c JOIN phone_identities p ON p.user_id=c.user_id WHERE p.phone=$4 AND c.user_id=$5 AND c.password_hash=$6 AND EXISTS(SELECT 1 FROM phone_login_attempts a WHERE a.id=$7 AND a.phone=$4 AND a.requested_at>$8) AND NOT EXISTS(SELECT 1 FROM admin_user_controls a WHERE a.user_id=c.user_id AND a.disabled<>0)")
        .bind(auth::hash_token(&token)).bind(created.saturating_add(SESSION_LIFETIME_SECONDS)).bind(created)
        .bind(phone).bind(&credential.user_id).bind(&credential.password_hash).bind(attempt_id).bind(created.saturating_sub(LOGIN_WINDOW_SECONDS))
        .execute(&mut *transaction).await?.rows_affected();
    if inserted != 1 {
        return Err(DomainError::InvalidCredentials);
    }
    let row = sqlx::query("SELECT u.id,u.email,u.name,u.timezone,CAST(u.created_at AS BIGINT) AS created_at,p.phone FROM users u JOIN phone_identities p ON p.user_id=u.id WHERE u.id=$1 AND p.phone=$2")
        .bind(&credential.user_id).bind(phone).fetch_optional(&mut *transaction).await?
        .ok_or(DomainError::InvalidCredentials)?;
    let user = User {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
        name: row.try_get("name")?,
        timezone: row.try_get("timezone")?,
        created_at: timestamp(row.try_get("created_at")?),
        phone: Some(row.try_get("phone")?),
    };
    let removed = sqlx::query("DELETE FROM phone_login_attempts WHERE id=$1 AND phone=$2")
        .bind(attempt_id)
        .bind(phone)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
    if removed != 1 {
        return Err(DomainError::InvalidCredentials);
    }
    transaction.commit().await?;
    Ok(AuthSession { user, token })
}

pub async fn login(
    repository: &Repository,
    phone: &str,
    password: String,
) -> Result<AuthSession, DomainError> {
    let phone = normalize_phone(phone).map_err(|_| DomainError::InvalidCredentials)?;
    auth::validate_password(&password).map_err(|_| DomainError::InvalidCredentials)?;
    // Take a CPU slot before writing an attempt. Busy callers neither queue
    // unbounded blocking work nor consume somebody's failure allowance.
    let permit = acquire_password_cpu()?;
    let reservation = reserve_login_attempt(repository, &phone, now).await?;
    let encoded_hash = reservation
        .credential
        .as_ref()
        .map(|credential| credential.password_hash.as_str())
        .unwrap_or(DUMMY_PASSWORD_HASH)
        .to_owned();
    let verified = password_job(permit, move || {
        auth::verify_password(&password, &encoded_hash)
    })
    .await?;
    if !verified {
        return Err(DomainError::InvalidCredentials);
    }
    let credential = reservation
        .credential
        .as_ref()
        .ok_or(DomainError::InvalidCredentials)?;
    complete_login(repository, &phone, &reservation.id, credential, now).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::{PhoneAuth, PhonePurpose, TEST_PHONE_CODE};
    use argon2::{password_hash::PasswordHash, Argon2};
    use std::time::Duration;

    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    const PHONE: &str = "+8613800138000";
    const PASSWORD: &str = " test password 汉字 ";

    async fn credential_fixture(repository: &Repository) -> User {
        let user = repository
            .create_phone_user(PHONE, "密码测试", "Asia/Shanghai")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO phone_credentials(user_id,password_hash,updated_at) VALUES($1,$2,$3)",
        )
        .bind(&user.id)
        .bind(auth::hash_password(PASSWORD).unwrap())
        .bind(now())
        .execute(&repository.pool)
        .await
        .unwrap();
        user
    }

    async fn attempt_count(repository: &Repository) -> i64 {
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_login_attempts")
            .fetch_one(&repository.pool)
            .await
            .unwrap()
    }

    async fn reset_challenge(repository: &Repository, auth: &PhoneAuth) -> String {
        // Only this disposable fixture bypasses SMS admission clocks; local_test never sends an SMS.
        sqlx::query("DELETE FROM phone_sms_attempts")
            .execute(&repository.pool)
            .await
            .unwrap();
        auth.issue_code(repository, PHONE, PhonePurpose::ResetPassword)
            .await
            .unwrap()
            .challenge_id
    }

    async fn assert_no_sessions(repository: &Repository, user_id: &str) {
        let count: i64 =
            sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions WHERE user_id=$1")
                .bind(user_id)
                .fetch_one(&repository.pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    async fn exercise_actual_password_reset_login_races(repository: &Repository) {
        let auth = PhoneAuth::local_test();
        let user = credential_fixture(repository).await;
        let old_token = repository.create_session(&user.id).await.unwrap();

        // Reset finishes between password verification and session insertion.
        let stale = reserve_login_attempt(repository, PHONE, now).await.unwrap();
        assert!(auth::verify_password(
            PASSWORD,
            &stale.credential.as_ref().unwrap().password_hash
        ));
        let challenge = reset_challenge(repository, &auth).await;
        let replacement_one = "replacement one 汉字";
        auth.reset_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &challenge,
            replacement_one.into(),
        )
        .await
        .unwrap();
        assert_no_sessions(repository, &user.id).await;
        assert!(repository.authenticate(&old_token).await.is_err());
        assert!(matches!(
            complete_login(
                repository,
                PHONE,
                &stale.id,
                stale.credential.as_ref().unwrap(),
                now
            )
            .await,
            Err(DomainError::InvalidCredentials)
        ));
        assert_no_sessions(repository, &user.id).await;

        // The other deterministic order: login commits first, then real reset revokes it.
        let before_reset = reserve_login_attempt(repository, PHONE, now).await.unwrap();
        assert!(auth::verify_password(
            replacement_one,
            &before_reset.credential.as_ref().unwrap().password_hash
        ));
        let completed = complete_login(
            repository,
            PHONE,
            &before_reset.id,
            before_reset.credential.as_ref().unwrap(),
            now,
        )
        .await
        .unwrap();
        assert_eq!(
            repository.authenticate(&completed.token).await.unwrap(),
            user.id
        );
        let challenge = reset_challenge(repository, &auth).await;
        let replacement_two = "replacement two 汉字";
        auth.reset_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &challenge,
            replacement_two.into(),
        )
        .await
        .unwrap();
        assert!(repository.authenticate(&completed.token).await.is_err());
        assert_no_sessions(repository, &user.id).await;

        // Allow either lock order on real concurrent connections. Once reset
        // returns, every session created with the prior credential must be gone.
        let racing = reserve_login_attempt(repository, PHONE, now).await.unwrap();
        assert!(auth::verify_password(
            replacement_two,
            &racing.credential.as_ref().unwrap().password_hash
        ));
        let challenge = reset_challenge(repository, &auth).await;
        let (completion, reset) = tokio::join!(
            complete_login(
                repository,
                PHONE,
                &racing.id,
                racing.credential.as_ref().unwrap(),
                now
            ),
            auth.reset_password(
                repository,
                PHONE,
                TEST_PHONE_CODE,
                &challenge,
                "replacement final 汉字".into()
            )
        );
        reset.unwrap();
        match completion {
            Ok(session) => assert!(repository.authenticate(&session.token).await.is_err()),
            Err(DomainError::InvalidCredentials) => {}
            Err(_) => panic!("unexpected concurrent login error"),
        }
        assert_no_sessions(repository, &user.id).await;
        assert_eq!(attempt_count(repository).await, 0);
        let current_hash: String =
            sqlx::query_scalar("SELECT password_hash FROM phone_credentials WHERE user_id=$1")
                .bind(&user.id)
                .fetch_one(&repository.pool)
                .await
                .unwrap();
        assert!(auth::verify_password(
            "replacement final 汉字",
            &current_hash
        ));
    }

    #[tokio::test]
    async fn actual_sms_reset_prevents_stale_login_sessions_in_both_orders() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        exercise_actual_password_reset_login_races(&repository).await;
    }

    #[tokio::test]
    #[ignore = "Requires an isolated tomorrow_sms_test_* PostgreSQL database; local SMS test mode only"]
    async fn postgres_actual_sms_reset_prevents_stale_login_sessions_in_both_orders() {
        let _serial = TEST_LOCK.lock().await;
        let (repository, _) = isolated_postgres_fixture().await;
        exercise_actual_password_reset_login_races(&repository).await;
        repository.pool.close().await;
    }

    async fn isolated_postgres_fixture() -> (Repository, String) {
        let url = std::env::var("TEST_PHONE_PASSWORD_DATABASE_URL")
            .or_else(|_| std::env::var("TEST_SMS_DATABASE_URL"))
            .expect("set a disposable TEST_PHONE_PASSWORD_DATABASE_URL or TEST_SMS_DATABASE_URL");
        let database = url
            .split('?')
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        assert!(
            (url.starts_with("postgres://") || url.starts_with("postgresql://"))
                && database.starts_with("tomorrow_sms_test_")
                && database
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "password tests require a separate tomorrow_sms_test_* PostgreSQL database"
        );
        let repository = Repository::connect(&url).await.unwrap();
        let actual_database: String = sqlx::query_scalar("SELECT CAST(current_database() AS TEXT)")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_eq!(
            actual_database, database,
            "unexpected connected test database"
        );
        // Cleanup is permitted only after verifying this explicit disposable database.
        for table in [
            "phone_codes",
            "phone_sms_attempts",
            "phone_login_attempts",
            "sessions",
            "phone_credentials",
            "phone_identities",
            "users",
        ] {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&repository.pool)
                .await
                .unwrap();
        }
        (repository, url)
    }

    #[tokio::test]
    #[ignore = "Requires an isolated tomorrow_sms_test_* PostgreSQL database; no SMS or model calls"]
    async fn postgres_pending_login_guesses_are_atomic_across_connections() {
        let _serial = TEST_LOCK.lock().await;
        let (first, url) = isolated_postgres_fixture().await;
        let second = Repository::connect(&url).await.unwrap();
        let mut handles = Vec::new();
        for index in 0..50 {
            let repository = if index % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            handles.push(tokio::spawn(async move {
                reserve_login_attempt(&repository, PHONE, || 10000).await
            }));
        }
        let mut accepted = 0;
        let mut rejected = 0;
        for handle in handles {
            match handle.await.unwrap() {
                Ok(_) => accepted += 1,
                Err(DomainError::LoginRateLimited { retry_after }) => {
                    assert_eq!(retry_after, 900);
                    rejected += 1;
                }
                Err(_) => panic!("unexpected concurrent PostgreSQL reservation error"),
            }
        }
        assert_eq!((accepted, rejected), (10, 40));
        assert_eq!(attempt_count(&first).await, 10);
        first.pool.close().await;
        second.pool.close().await;

        let reopened = Repository::connect(&url).await.unwrap();
        assert_eq!(attempt_count(&reopened).await, 10);
        assert!(matches!(
            reserve_login_attempt(&reopened, PHONE, || 10899).await,
            Err(DomainError::LoginRateLimited { retry_after: 1 })
        ));
        assert_eq!(attempt_count(&reopened).await, 10);
        reserve_login_attempt(&reopened, PHONE, || 10900)
            .await
            .unwrap();
        assert_eq!(attempt_count(&reopened).await, 1);
        reopened.pool.close().await;
    }

    #[test]
    fn unknown_account_dummy_has_the_same_argon2_cost_as_real_credentials() {
        let parsed = PasswordHash::new(DUMMY_PASSWORD_HASH).unwrap();
        let defaults = Argon2::default();
        assert_eq!(parsed.algorithm.as_str(), "argon2id");
        assert_eq!(parsed.version, Some(19));
        assert_eq!(
            parsed.params.get_decimal("m"),
            Some(defaults.params().m_cost())
        );
        assert_eq!(
            parsed.params.get_decimal("t"),
            Some(defaults.params().t_cost())
        );
        assert_eq!(
            parsed.params.get_decimal("p"),
            Some(defaults.params().p_cost())
        );
        assert_eq!(parsed.hash.unwrap().len(), 32);
    }

    #[tokio::test]
    async fn successful_login_keeps_other_failures_and_pending_attempts() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let user = credential_fixture(&repository).await;
        assert!(matches!(
            login(&repository, PHONE, "wrong password".into()).await,
            Err(DomainError::InvalidCredentials)
        ));
        let pending = reserve_login_attempt(&repository, PHONE, now)
            .await
            .unwrap();
        let session = login(&repository, "13800138000", PASSWORD.into())
            .await
            .unwrap();
        assert_eq!(session.user.id, user.id);
        assert_eq!(session.user.phone.as_deref(), Some(PHONE));
        assert_eq!(
            repository.authenticate(&session.token).await.unwrap(),
            user.id
        );
        assert_eq!(attempt_count(&repository).await, 2);
        let pending_still_exists: i64 = sqlx::query_scalar(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM phone_login_attempts WHERE id=$1",
        )
        .bind(pending.id)
        .fetch_one(&repository.pool)
        .await
        .unwrap();
        assert_eq!(pending_still_exists, 1);
        let stored: String = sqlx::query_scalar("SELECT token_hash FROM sessions")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_ne!(stored, session.token);
        assert_eq!(stored, auth::hash_token(&session.token));
    }

    #[tokio::test]
    async fn unknown_and_legacy_accounts_share_errors_and_failures_persist_after_restart() {
        let _serial = TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let url = format!(
            "sqlite:{}",
            directory.path().join("password.db").to_string_lossy()
        );
        let repository = Repository::connect(&url).await.unwrap();
        repository
            .create_phone_user("13900139000", "旧账号", "UTC")
            .await
            .unwrap();
        for phone in [PHONE, "13900139000"] {
            let error = login(&repository, phone, PASSWORD.into())
                .await
                .err()
                .unwrap();
            assert!(matches!(error, DomainError::InvalidCredentials));
            assert_eq!(
                error.to_string(),
                "手机号或密码错误；如未设置密码，请先重置密码"
            );
        }
        assert_eq!(attempt_count(&repository).await, 2);
        repository.pool.close().await;
        let reopened = Repository::connect(&url).await.unwrap();
        assert_eq!(attempt_count(&reopened).await, 2);
        let users: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM users")
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(users, 1);
        let sessions: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions")
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn parallel_pending_guesses_share_a_strict_ten_attempt_window() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let mut handles = Vec::new();
        for _ in 0..20 {
            let repository = repository.clone();
            handles.push(tokio::spawn(async move {
                reserve_login_attempt(&repository, PHONE, || 10000).await
            }));
        }
        let mut accepted = 0;
        let mut rejected = 0;
        for handle in handles {
            match handle.await.unwrap() {
                Ok(_) => accepted += 1,
                Err(DomainError::LoginRateLimited { retry_after }) => {
                    assert_eq!(retry_after, 900);
                    rejected += 1;
                }
                Err(_) => panic!("unexpected reservation error"),
            }
        }
        assert_eq!((accepted, rejected), (10, 10));
        assert_eq!(attempt_count(&repository).await, 10);
        assert!(matches!(
            reserve_login_attempt(&repository, PHONE, || 10899).await,
            Err(DomainError::LoginRateLimited { retry_after: 1 })
        ));
        reserve_login_attempt(&repository, PHONE, || 10900)
            .await
            .unwrap();
        assert_eq!(attempt_count(&repository).await, 1);
    }

    #[tokio::test]
    async fn global_pending_cap_bounds_unknown_phone_rows_and_recovers_at_expiry() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        for chunk in 0..50 {
            let values = (0..200)
                .map(|i| format!("(${},${},${})", i * 3 + 1, i * 3 + 2, i * 3 + 3))
                .collect::<Vec<_>>()
                .join(",");
            let statement =
                format!("INSERT INTO phone_login_attempts(id,phone,requested_at) VALUES {values}");
            let mut query = sqlx::query(&statement);
            for offset in 0..200 {
                query = query
                    .bind(format!("fixture-{}", chunk * 200 + offset))
                    .bind("+8613900139000")
                    .bind(10000_i64);
            }
            query.execute(&repository.pool).await.unwrap();
        }
        assert!(matches!(
            reserve_login_attempt(&repository, PHONE, || 10000).await,
            Err(DomainError::LoginRateLimited { retry_after: 900 })
        ));
        assert_eq!(attempt_count(&repository).await, 10000);
        reserve_login_attempt(&repository, PHONE, || 10900)
            .await
            .unwrap();
        assert_eq!(attempt_count(&repository).await, 1);
    }

    #[tokio::test]
    async fn changed_password_or_removed_pending_attempt_cannot_create_a_session() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let user = credential_fixture(&repository).await;
        let before_reset = reserve_login_attempt(&repository, PHONE, now)
            .await
            .unwrap();
        let mut transaction = repository.pool.begin().await.unwrap();
        lock_password_state(&mut transaction).await.unwrap();
        sqlx::query("UPDATE phone_credentials SET password_hash=$1 WHERE user_id=$2")
            .bind(auth::hash_password("replacement password").unwrap())
            .bind(&user.id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        assert!(matches!(
            complete_login(
                &repository,
                PHONE,
                &before_reset.id,
                before_reset.credential.as_ref().unwrap(),
                now
            )
            .await,
            Err(DomainError::InvalidCredentials)
        ));
        let removed = reserve_login_attempt(&repository, PHONE, now)
            .await
            .unwrap();
        let mut transaction = repository.pool.begin().await.unwrap();
        lock_password_state(&mut transaction).await.unwrap();
        sqlx::query("DELETE FROM phone_login_attempts WHERE id=$1")
            .bind(&removed.id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        assert!(matches!(
            complete_login(
                &repository,
                PHONE,
                &removed.id,
                removed.credential.as_ref().unwrap(),
                now
            )
            .await,
            Err(DomainError::InvalidCredentials)
        ));
        let count: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn disabled_account_revokes_existing_sessions_and_rejects_inflight_phone_login() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let user = credential_fixture(&repository).await;
        let existing = repository.create_session(&user.id).await.unwrap();
        let pending = reserve_login_attempt(&repository, PHONE, now)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_user_controls(user_id,disabled,updated_at) VALUES($1,1,$2)")
            .bind(&user.id)
            .bind(now())
            .execute(&repository.pool)
            .await
            .unwrap();
        assert!(matches!(
            repository.authenticate(&existing).await,
            Err(DomainError::Unauthorized)
        ));
        assert!(matches!(
            repository.create_session(&user.id).await,
            Err(DomainError::Unauthorized)
        ));
        assert!(repository.credentials(&user.email).await.unwrap().is_none());
        assert!(matches!(
            complete_login(
                &repository,
                PHONE,
                &pending.id,
                pending.credential.as_ref().unwrap(),
                now
            )
            .await,
            Err(DomainError::InvalidCredentials)
        ));
        let next = reserve_login_attempt(&repository, PHONE, now)
            .await
            .unwrap();
        assert!(next.credential.is_none());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "old session remains stored but unusable, no new token is issued"
        );
    }

    #[tokio::test]
    async fn missing_global_guard_fails_closed_before_admission() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        sqlx::query("DELETE FROM phone_password_guard")
            .execute(&repository.pool)
            .await
            .unwrap();
        assert!(matches!(
            reserve_login_attempt(&repository, PHONE, now).await,
            Err(DomainError::Unavailable(_))
        ));
        assert_eq!(attempt_count(&repository).await, 0);
    }

    #[tokio::test]
    async fn cpu_busy_does_not_reserve_attempts_and_cancellation_keeps_the_permit() {
        let _serial = TEST_LOCK.lock().await;
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let first = acquire_password_cpu().unwrap();
        let second = acquire_password_cpu().unwrap();
        assert!(matches!(
            login(&repository, PHONE, PASSWORD.into()).await,
            Err(DomainError::LoginRateLimited { retry_after: 1 })
        ));
        assert!(matches!(
            hash_password(PASSWORD.into()).await,
            Err(DomainError::LoginRateLimited { retry_after: 1 })
        ));
        assert_eq!(attempt_count(&repository).await, 0);
        drop(second);
        let started = Arc::new(tokio::sync::Notify::new());
        let started_in_worker = started.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let job = tokio::spawn(async move {
            password_job(first, move || {
                started_in_worker.notify_one();
                wait.recv().unwrap();
            })
            .await
        });
        started.notified().await;
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        assert_eq!(PASSWORD_CPU.available_permits(), 1);
        let remaining = acquire_password_cpu().unwrap();
        assert!(acquire_password_cpu().is_err());
        release.send(()).unwrap();
        let released =
            tokio::time::timeout(Duration::from_secs(3), PASSWORD_CPU.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
        drop(released);
        drop(remaining);
        assert_eq!(PASSWORD_CPU.available_permits(), 2);
    }
}
