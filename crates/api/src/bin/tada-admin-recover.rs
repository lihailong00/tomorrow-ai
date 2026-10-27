//! Offline owner recovery. This binary has no HTTP endpoint and never creates a new owner.
use serde::Deserialize;
use sqlx::Row;
use std::io::Read;
use tomorrow_domain::{auth, now, Repository};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    email: String,
    new_password: String,
    confirm_instance_id: String,
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|argument| argument == "--help") {
        println!("Offline administrator recovery. Stop API and worker first. Load the instance DATABASE_URL into the process environment, then pipe JSON on stdin: {{\"email\":\"owner@example.com\",\"new_password\":\"...\",\"confirm_instance_id\":\"...\"}}. Passwords must never be command-line arguments. Only an existing owner is recovered; all owner sessions are revoked.");
        return;
    }
    if recover().await.is_err() {
        eprintln!("Recovery failed. Check local instance access, confirmation ID, existing owner account and password format.");
        std::process::exit(1);
    }
}

async fn recover() -> Result<(), ()> {
    // A small stdin document keeps secrets out of arguments and bounds memory.
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > 8192 {
        return Err(());
    }
    let input: Input = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if uuid::Uuid::parse_str(&input.confirm_instance_id).is_err() {
        return Err(());
    }
    auth::validate_password(&input.new_password).map_err(|_| ())?;
    let database = std::env::var("DATABASE_URL").map_err(|_| ())?;
    if database.starts_with("sqlite:") {
        let path = database
            .trim_start_matches("sqlite:")
            .split('?')
            .next()
            .ok_or(())?;
        if !std::path::Path::new(path).is_file() {
            return Err(());
        }
    }
    let repository = Repository::connect(&database).await.map_err(|_| ())?;
    let pool = repository.pool();
    let instance_id: String =
        sqlx::query_scalar("SELECT instance_id FROM instance_config_meta WHERE id=1")
            .fetch_one(&pool)
            .await
            .map_err(|_| ())?;
    if instance_id != input.confirm_instance_id {
        return Err(());
    }
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&input.new_password))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let mut tx = pool.begin().await.map_err(|_| ())?;
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await
        .map_err(|_| ())?;
    let row=sqlx::query("SELECT u.id FROM users u JOIN admin_roles r ON r.user_id=u.id WHERE u.email=$1 AND r.role='owner'").bind(input.email.trim().to_lowercase()).fetch_optional(&mut *tx).await.map_err(|_|())?.ok_or(())?;
    let id: String = row.try_get("id").map_err(|_| ())?;
    sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2")
        .bind(hash)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|_| ())?;
    sqlx::query("INSERT INTO admin_user_controls(user_id,disabled,updated_at) VALUES($1,0,$2) ON CONFLICT(user_id) DO UPDATE SET disabled=0,updated_at=$2").bind(&id).bind(now()).execute(&mut *tx).await.map_err(|_|())?;
    for statement in [
        "DELETE FROM sessions WHERE user_id=$1",
        "DELETE FROM admin_sessions WHERE user_id=$1",
    ] {
        sqlx::query(statement)
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(|_| ())?;
    }
    sqlx::query("DELETE FROM admin_rate_windows")
        .execute(&mut *tx)
        .await
        .map_err(|_| ())?;
    tx.commit().await.map_err(|_| ())?;
    println!("{{\"ok\":true,\"sessions_revoked\":true}}");
    Ok(())
}
