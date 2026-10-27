use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tomorrow_domain::{
    phone::{normalize_phone, PhoneAuth, PhonePurpose},
    Repository,
};
use tomorrow_domain::{
    sms::{SmsMessage, SmsSender},
    DomainError,
};

#[derive(Default)]
struct FakeSms {
    messages: Mutex<Vec<(String, String, String)>>,
    fail: bool,
    started: Option<Arc<tokio::sync::Notify>>,
    finish: Option<Arc<tokio::sync::Notify>>,
}
impl SmsSender for FakeSms {
    fn send<'a>(
        &'a self,
        message: SmsMessage<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), DomainError>> + Send + 'a>> {
        Box::pin(async move {
            self.messages.lock().unwrap().push((
                message.phone.into(),
                message.code.into(),
                message.challenge_id.into(),
            ));
            if let Some(started) = &self.started {
                started.notify_one();
            }
            if let Some(finish) = &self.finish {
                finish.notified().await;
            }
            if self.fail {
                Err(DomainError::External("发送失败".into()))
            } else {
                Ok(())
            }
        })
    }
}
fn real_auth(sender: Arc<FakeSms>) -> PhoneAuth {
    PhoneAuth::with_sender(sender, "test-only-random-secret-at-least-32-bytes".into()).unwrap()
}

#[tokio::test]
async fn real_sms_codes_are_hashed_and_failed_delivery_never_activates() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let sender = Arc::new(FakeSms::default());
    let auth = real_auth(sender.clone());
    let challenge = auth
        .issue_code(&repo, "13800138000", PhonePurpose::Register)
        .await
        .unwrap();
    assert!(!challenge.test_mode);
    let (_, code, id) = sender.messages.lock().unwrap()[0].clone();
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|b| b.is_ascii_digit()));
    let hash: String = sqlx::query_scalar("SELECT code_hash FROM phone_codes WHERE id=$1")
        .bind(&id)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert!(hash.starts_with("v2:"));
    assert_ne!(hash, code);
    let reply = serde_json::to_value(&challenge).unwrap();
    assert!(reply.get("code").is_none());
    assert_eq!(reply.as_object().unwrap().len(), 4);
    auth.consume_code(&repo, "13800138000", PhonePurpose::Register, &id, &code)
        .await
        .unwrap();
    let failed_sender = Arc::new(FakeSms {
        fail: true,
        ..Default::default()
    });
    let failed = real_auth(failed_sender.clone());
    assert!(failed
        .issue_code(&repo, "13900139000", PhonePurpose::ResetPassword)
        .await
        .is_err());
    let (_, code, id) = failed_sender.messages.lock().unwrap()[0].clone();
    let hash: String = sqlx::query_scalar("SELECT code_hash FROM phone_codes WHERE id=$1")
        .bind(&id)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert!(hash.is_empty());
    assert!(failed
        .consume_code(
            &repo,
            "13900139000",
            PhonePurpose::ResetPassword,
            &id,
            &code
        )
        .await
        .is_err());
    assert!(failed
        .issue_code(&repo, "13900139000", PhonePurpose::Register)
        .await
        .is_err());
    assert_eq!(failed_sender.messages.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn sms_throttling_is_atomic_across_purposes_and_rejections_do_not_reserve() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let sender = Arc::new(FakeSms::default());
    let auth = real_auth(sender.clone());
    let mut handles = Vec::new();
    for i in 0..20 {
        let repo = repo.clone();
        let auth = auth.clone();
        handles.push(tokio::spawn(async move {
            auth.issue_code(
                &repo,
                if i % 2 == 0 {
                    "13800138000"
                } else {
                    "+8613800138000"
                },
                if i % 2 == 0 {
                    PhonePurpose::Register
                } else {
                    PhonePurpose::ResetPassword
                },
            )
            .await
        }));
    }
    let mut accepted = 0;
    for handle in handles {
        match handle.await.unwrap() {
            Ok(_) => accepted += 1,
            Err(DomainError::RateLimited { retry_after }) => {
                assert!((1..=60).contains(&retry_after))
            }
            Err(error) => panic!("unexpected: {error}"),
        }
    }
    assert_eq!(accepted, 1);
    assert_eq!(sender.messages.lock().unwrap().len(), 1);
    let mut handles = Vec::new();
    for i in 0..20 {
        let repo = repo.clone();
        let auth = auth.clone();
        handles.push(tokio::spawn(async move {
            auth.issue_code(&repo, &format!("139{i:08}"), PhonePurpose::ResetPassword)
                .await
        }));
    }
    let mut accepted = 0;
    for handle in handles {
        match handle.await.unwrap() {
            Ok(_) => accepted += 1,
            Err(DomainError::RateLimited { retry_after }) => {
                assert!((1..=60).contains(&retry_after))
            }
            Err(error) => panic!("unexpected: {error}"),
        }
    }
    assert_eq!(accepted, 2);
    assert_eq!(sender.messages.lock().unwrap().len(), 3);
    let count: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 3);
}

#[tokio::test]
async fn allowlist_normalizes_numbers_and_rejects_before_sender_or_quota() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let sender = Arc::new(FakeSms::default());
    let auth = real_auth(sender.clone())
        .with_allowed_phones("+86 138-0013-8000")
        .unwrap();
    repo.create_phone_user("13900139000", "existing", "Asia/Shanghai")
        .await
        .unwrap();
    for phone in ["13900139000", "13700137000"] {
        for purpose in [PhonePurpose::Register, PhonePurpose::ResetPassword] {
            assert!(matches!(
                auth.issue_code(&repo, phone, purpose).await,
                Err(DomainError::Forbidden)
            ));
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(sender.messages.lock().unwrap().is_empty());
    auth.issue_code(&repo, "008613800138000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    assert_eq!(sender.messages.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_delivery_keeps_its_admission_after_restart_without_retry() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("failed-send.db").to_string_lossy()
    );
    let repo = Repository::connect(&url).await.unwrap();
    let sender = Arc::new(FakeSms {
        fail: true,
        ..Default::default()
    });
    let auth = real_auth(sender.clone());
    assert!(matches!(
        auth.issue_code(&repo, "13800138000", PhonePurpose::ResetPassword)
            .await,
        Err(DomainError::External(_))
    ));
    repo.pool().close().await;
    let reopened = Repository::connect(&url).await.unwrap();
    assert!(
        matches!(auth.issue_code(&reopened, "13800138000", PhonePurpose::Register).await, Err(DomainError::RateLimited { retry_after }) if retry_after > 0)
    );
    assert_eq!(sender.messages.lock().unwrap().len(), 1);
    let pending: i64 =
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_codes WHERE code_hash=''")
            .fetch_one(&reopened.pool())
            .await
            .unwrap();
    let admitted: i64 =
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_sms_attempts")
            .fetch_one(&reopened.pool())
            .await
            .unwrap();
    assert_eq!((pending, admitted), (1, 1));
}

#[tokio::test]
async fn five_parallel_wrong_guesses_exhaust_the_challenge_and_legacy_codes_are_rejected() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let auth = PhoneAuth::local_test();
    let challenge = auth
        .issue_code(&repo, "13800138000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for _ in 0..10 {
        let repo = repo.clone();
        let auth = auth.clone();
        let id = challenge.challenge_id.clone();
        handles.push(tokio::spawn(async move {
            auth.consume_code(
                &repo,
                "13800138000",
                PhonePurpose::ResetPassword,
                &id,
                "000000",
            )
            .await
        }));
    }
    for handle in handles {
        assert!(handle.await.unwrap().is_err());
    }
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM phone_codes WHERE id=$1")
        .bind(&challenge.challenge_id)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(attempts, 5);
    assert!(auth
        .consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &challenge.challenge_id,
            "123456"
        )
        .await
        .is_err());
    let old = auth
        .issue_code(&repo, "13900139000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    let legacy_hash = tomorrow_domain::auth::hash_token(&format!(
        "{}|+8613900139000|login|123456",
        old.challenge_id
    ));
    sqlx::query("UPDATE phone_codes SET code_hash=$1 WHERE id=$2")
        .bind(legacy_hash)
        .bind(&old.challenge_id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(auth
        .consume_code(
            &repo,
            "13900139000",
            PhonePurpose::ResetPassword,
            &old.challenge_id,
            "123456"
        )
        .await
        .is_err());
}

#[tokio::test]
async fn pending_code_is_unusable_and_late_send_cannot_activate_a_new_challenge() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let slow_sender = Arc::new(FakeSms {
        started: Some(started.clone()),
        finish: Some(finish.clone()),
        ..Default::default()
    });
    let slow_auth = real_auth(slow_sender.clone());
    let request = {
        let repo = repo.clone();
        let auth = slow_auth.clone();
        tokio::spawn(async move {
            auth.issue_code(&repo, "13800138000", PhonePurpose::ResetPassword)
                .await
        })
    };
    started.notified().await;
    let (_, code, id) = slow_sender.messages.lock().unwrap()[0].clone();
    assert!(slow_auth
        .consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &id,
            &code
        )
        .await
        .is_err());
    sqlx::query("UPDATE phone_sms_attempts SET requested_at=requested_at-60")
        .execute(&repo.pool())
        .await
        .unwrap();
    let next_sender = Arc::new(FakeSms::default());
    let next_auth = real_auth(next_sender.clone());
    let next = next_auth
        .issue_code(&repo, "13800138000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    finish.notify_one();
    assert!(request.await.unwrap().is_err());
    assert_ne!(id, next.challenge_id);
    assert!(slow_auth
        .consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &id,
            &code
        )
        .await
        .is_err());
    let (_, code, id) = next_sender.messages.lock().unwrap()[0].clone();
    next_auth
        .consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &id,
            &code,
        )
        .await
        .unwrap();
}

#[test]
fn mainland_phone_formats_have_one_identity() {
    for input in ["13800138000", "+86 138-0013-8000", "008613800138000"] {
        assert_eq!(normalize_phone(input).unwrap(), "+8613800138000");
    }
    for input in [
        "",
        "123456",
        "12800138000",
        "+113800138000",
        "１３８００１３８０００",
    ] {
        assert!(normalize_phone(input).is_err());
    }
}

#[tokio::test]
async fn phone_codes_are_scoped_expire_lock_and_cannot_be_replayed() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let phone = "13800138000";
    let code = PhoneAuth::local_test()
        .issue_code(&repo, phone, PhonePurpose::Register)
        .await
        .unwrap();
    assert!(code.test_mode);
    assert_eq!(code.expires_in, 300);
    assert!(PhoneAuth::local_test()
        .issue_code(&repo, phone, PhonePurpose::Register)
        .await
        .is_err());
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            "13900139000",
            PhonePurpose::Register,
            &code.challenge_id,
            "123456"
        )
        .await
        .is_err());
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            phone,
            PhonePurpose::ResetPassword,
            &code.challenge_id,
            "123456"
        )
        .await
        .is_err());
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            phone,
            PhonePurpose::Register,
            &code.challenge_id,
            "000000"
        )
        .await
        .is_err());
    PhoneAuth::local_test()
        .consume_code(
            &repo,
            phone,
            PhonePurpose::Register,
            &code.challenge_id,
            "123456",
        )
        .await
        .unwrap();
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            phone,
            PhonePurpose::Register,
            &code.challenge_id,
            "123456"
        )
        .await
        .is_err());
    sqlx::query("UPDATE phone_sms_attempts SET requested_at=requested_at-60")
        .execute(&repo.pool())
        .await
        .unwrap();
    let code = PhoneAuth::local_test()
        .issue_code(&repo, phone, PhonePurpose::ResetPassword)
        .await
        .unwrap();
    for _ in 0..5 {
        assert!(PhoneAuth::local_test()
            .consume_code(
                &repo,
                phone,
                PhonePurpose::ResetPassword,
                &code.challenge_id,
                "000000"
            )
            .await
            .is_err());
    }
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            phone,
            PhonePurpose::ResetPassword,
            &code.challenge_id,
            "123456"
        )
        .await
        .is_err());
    let expired = PhoneAuth::local_test()
        .issue_code(&repo, "13700137000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    sqlx::query("UPDATE phone_codes SET expires_at=0 WHERE id=$1")
        .bind(&expired.challenge_id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(PhoneAuth::local_test()
        .consume_code(
            &repo,
            "13700137000",
            PhonePurpose::ResetPassword,
            &expired.challenge_id,
            "123456"
        )
        .await
        .is_err());
}

#[tokio::test]
async fn concurrent_verification_has_exactly_one_winner() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let auth = PhoneAuth::local_test();
    let code = PhoneAuth::local_test()
        .issue_code(&repo, "13800138000", PhonePurpose::ResetPassword)
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        auth.consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &code.challenge_id,
            "123456"
        ),
        auth.consume_code(
            &repo,
            "13800138000",
            PhonePurpose::ResetPassword,
            &code.challenge_id,
            "123456"
        )
    );
    assert_ne!(first.is_ok(), second.is_ok());
}

#[tokio::test]
async fn phone_identity_survives_reconnect_and_duplicate_registration_is_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("phone.db").to_string_lossy()
    );
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_phone_user("13800138000", "小林", "Asia/Shanghai")
        .await
        .unwrap();
    assert!(repo
        .create_phone_user("+8613800138000", "重复", "Asia/Shanghai")
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    let token = repo.create_session(&user.id).await.unwrap();
    let reopened = Repository::connect(&url).await.unwrap();
    assert_eq!(
        reopened
            .phone_user("008613800138000")
            .await
            .unwrap()
            .unwrap()
            .id,
        user.id
    );
    assert_eq!(
        reopened.user(&user.id).await.unwrap().phone.as_deref(),
        Some("+8613800138000")
    );
    assert_eq!(reopened.authenticate(&token).await.unwrap(), user.id);
}
