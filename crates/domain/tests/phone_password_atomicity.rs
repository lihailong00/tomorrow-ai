//! Fault injection uses disposable databases and explicit local-test SMS only.
use tomorrow_domain::{
    phone::{PhoneAuth, PhonePurpose, TEST_PHONE_CODE},
    phone_password, DomainError, Repository,
};

const PHONE: &str = "13800138000";
const PASSWORD: &str = " 密码 😀 old password ";
const NEW_PASSWORD: &str = " 新密码 😀 new password ";

async fn challenge(
    repository: &Repository,
    auth: &PhoneAuth,
    phone: &str,
    purpose: PhonePurpose,
) -> String {
    // Quota boundaries have separate tests; these fixtures focus on transactions.
    sqlx::query("DELETE FROM phone_sms_attempts")
        .execute(&repository.pool())
        .await
        .unwrap();
    auth.issue_code(repository, phone, purpose)
        .await
        .unwrap()
        .challenge_id
}

async fn count(repository: &Repository, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT CAST(COUNT(*) AS BIGINT) FROM {table}"))
        .fetch_one(&repository.pool())
        .await
        .unwrap()
}

async fn code_state(repository: &Repository, id: &str) -> (i64, i64) {
    use sqlx::Row;
    let row = sqlx::query("SELECT CAST(attempts AS BIGINT) AS attempts,CAST(CASE WHEN consumed_at IS NULL THEN 0 ELSE 1 END AS BIGINT) AS consumed FROM phone_codes WHERE id=$1")
        .bind(id).fetch_one(&repository.pool()).await.unwrap();
    (row.get("attempts"), row.get("consumed"))
}

async fn fault(repository: &Repository, postgres: bool, operation: &str, enabled: bool) {
    let statement = if !enabled {
        if postgres {
            "DROP TRIGGER password_fixture_failure ON phone_credentials"
        } else {
            "DROP TRIGGER password_fixture_failure"
        }
    } else if postgres && operation == "INSERT" {
        "CREATE TRIGGER password_fixture_failure BEFORE INSERT ON phone_credentials FOR EACH ROW EXECUTE FUNCTION password_fixture_failure()"
    } else if postgres {
        "CREATE TRIGGER password_fixture_failure BEFORE UPDATE ON phone_credentials FOR EACH ROW EXECUTE FUNCTION password_fixture_failure()"
    } else if operation == "INSERT" {
        "CREATE TRIGGER password_fixture_failure BEFORE INSERT ON phone_credentials BEGIN SELECT RAISE(ABORT,'test-only credential failure'); END"
    } else {
        "CREATE TRIGGER password_fixture_failure BEFORE UPDATE ON phone_credentials BEGIN SELECT RAISE(ABORT,'test-only credential failure'); END"
    };
    sqlx::raw_sql(statement)
        .execute(&repository.pool())
        .await
        .unwrap();
}

async fn exercise_atomicity(repository: &Repository, postgres: bool) {
    if postgres {
        sqlx::raw_sql("CREATE OR REPLACE FUNCTION password_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only credential failure'; END; $$")
            .execute(&repository.pool()).await.unwrap();
    }
    let auth = PhoneAuth::local_test();
    let id = challenge(repository, &auth, PHONE, PhonePurpose::Register).await;
    fault(repository, postgres, "INSERT", true).await;
    let result = auth
        .register_with_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &id,
            PASSWORD.into(),
            "事务测试",
            "Asia/Shanghai",
        )
        .await;
    assert!(matches!(result, Err(DomainError::Database(_))));
    for table in ["users", "phone_identities", "phone_credentials", "sessions"] {
        assert_eq!(
            count(repository, table).await,
            0,
            "registration leaked {table}"
        );
    }
    assert_eq!(code_state(repository, &id).await, (0, 0));
    fault(repository, postgres, "INSERT", false).await;
    let account = auth
        .register_with_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &id,
            PASSWORD.into(),
            "事务测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    assert_eq!(code_state(repository, &id).await, (1, 1));
    let legacy_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(&account.user.id)
        .fetch_one(&repository.pool())
        .await
        .unwrap();
    assert_eq!(legacy_hash, "!phone-only");
    let original_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM phone_credentials WHERE user_id=$1")
            .bind(&account.user.id)
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert!(original_hash.starts_with("$argon2id$"));
    assert_ne!(original_hash, PASSWORD);
    let second_session = repository.create_session(&account.user.id).await.unwrap();

    let reset = challenge(repository, &auth, PHONE, PhonePurpose::ResetPassword).await;
    fault(repository, postgres, "UPDATE", true).await;
    let result = auth
        .reset_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &reset,
            NEW_PASSWORD.into(),
        )
        .await;
    assert!(matches!(result, Err(DomainError::Database(_))));
    assert_eq!(code_state(repository, &reset).await, (0, 0));
    assert_eq!(
        repository.authenticate(&account.token).await.unwrap(),
        account.user.id
    );
    assert_eq!(
        repository.authenticate(&second_session).await.unwrap(),
        account.user.id
    );
    let unchanged: String =
        sqlx::query_scalar("SELECT password_hash FROM phone_credentials WHERE user_id=$1")
            .bind(&account.user.id)
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert_eq!(unchanged, original_hash);
    fault(repository, postgres, "UPDATE", false).await;

    assert!(matches!(
        auth.reset_password(repository, PHONE, "000000", &reset, NEW_PASSWORD.into())
            .await,
        Err(DomainError::Validation(_))
    ));
    assert_eq!(
        code_state(repository, &reset).await,
        (1, 0),
        "incorrect code guess must commit its attempt"
    );
    auth.reset_password(
        repository,
        PHONE,
        TEST_PHONE_CODE,
        &reset,
        NEW_PASSWORD.into(),
    )
    .await
    .unwrap();
    assert_eq!(code_state(repository, &reset).await, (2, 1));
    assert!(repository.authenticate(&account.token).await.is_err());
    assert!(repository.authenticate(&second_session).await.is_err());
    assert_eq!(
        count(repository, "sessions").await,
        0,
        "reset must not automatically log in"
    );
    assert!(matches!(
        phone_password::login(repository, PHONE, PASSWORD.into()).await,
        Err(DomainError::InvalidCredentials)
    ));
    let signed_in = phone_password::login(repository, PHONE, NEW_PASSWORD.into())
        .await
        .unwrap();
    assert_eq!(signed_in.user.id, account.user.id);
    assert!(matches!(
        auth.reset_password(
            repository,
            PHONE,
            TEST_PHONE_CODE,
            &reset,
            "another password".into()
        )
        .await,
        Err(DomainError::Validation(_))
    ));
    assert!(
        repository.authenticate(&signed_in.token).await.is_ok(),
        "replay must not revoke newer sessions"
    );

    // The compatibility path is an SMS-authorized first password, never OTP login.
    let legacy = repository
        .create_phone_user("13900139000", "旧用户", "UTC")
        .await
        .unwrap();
    let legacy_session = repository.create_session(&legacy.id).await.unwrap();
    assert!(matches!(
        phone_password::login(repository, "13900139000", NEW_PASSWORD.into()).await,
        Err(DomainError::InvalidCredentials)
    ));
    let reset = challenge(
        repository,
        &auth,
        "13900139000",
        PhonePurpose::ResetPassword,
    )
    .await;
    auth.reset_password(
        repository,
        "13900139000",
        TEST_PHONE_CODE,
        &reset,
        NEW_PASSWORD.into(),
    )
    .await
    .unwrap();
    assert!(repository.authenticate(&legacy_session).await.is_err());
    let first_password_login =
        phone_password::login(repository, "13900139000", NEW_PASSWORD.into())
            .await
            .unwrap();
    assert_eq!(first_password_login.user.id, legacy.id);

    let unknown = challenge(
        repository,
        &auth,
        "13700137000",
        PhonePurpose::ResetPassword,
    )
    .await;
    assert!(matches!(
        auth.reset_password(
            repository,
            "13700137000",
            TEST_PHONE_CODE,
            &unknown,
            NEW_PASSWORD.into()
        )
        .await,
        Err(DomainError::Validation(_))
    ));
    assert_eq!(code_state(repository, &unknown).await, (1, 1));
    assert!(repository
        .phone_user("13700137000")
        .await
        .unwrap()
        .is_none());
    if postgres {
        sqlx::query("DROP FUNCTION password_fixture_failure()")
            .execute(&repository.pool())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn sqlite_registration_and_password_reset_are_atomic_under_storage_failures() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    exercise_atomicity(&repository, false).await;
}

#[tokio::test]
#[ignore = "Requires a separate tomorrow_sms_test_* database via TEST_SMS_DATABASE_URL; never sends SMS"]
async fn postgres_registration_and_password_reset_are_atomic_under_storage_failures() {
    let url = std::env::var("TEST_SMS_DATABASE_URL").expect("set disposable TEST_SMS_DATABASE_URL");
    let database = url
        .rsplit('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    assert!(
        url.starts_with("postgres")
            && database.starts_with("tomorrow_sms_test_")
            && database
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    );
    let repository = Repository::connect(&url).await.unwrap();
    let actual: String = sqlx::query_scalar("SELECT CAST(current_database() AS TEXT)")
        .fetch_one(&repository.pool())
        .await
        .unwrap();
    assert_eq!(
        actual, database,
        "refuse to clear a different PostgreSQL database"
    );
    for statement in [
        "DELETE FROM phone_codes",
        "DELETE FROM phone_sms_attempts",
        "DELETE FROM phone_sms_limits",
        "DELETE FROM phone_login_attempts",
        "DELETE FROM sessions",
        "DELETE FROM phone_credentials",
        "DELETE FROM phone_identities",
        "DELETE FROM users",
        "UPDATE phone_sms_guard SET legacy_imported=1 WHERE id=1",
    ] {
        sqlx::query(statement)
            .execute(&repository.pool())
            .await
            .unwrap();
    }
    exercise_atomicity(&repository, true).await;
}
