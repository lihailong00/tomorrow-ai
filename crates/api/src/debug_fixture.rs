use tomorrow_domain::{auth, Repository};

pub async fn owner(
    repo: &Repository,
    database: &str,
    has_agent: bool,
) -> anyhow::Result<Option<String>> {
    let Ok(email) = std::env::var("TADA_TENCENT_DOCS_FIXTURE_EMAIL") else {
        return Ok(None);
    };
    anyhow::ensure!(
        std::env::var("APP_ENV").as_deref() == Ok("local") &&
            std::env::var("INSTANCE_MODE").as_deref() == Ok("self_hosted") &&
            database.starts_with("sqlite:") && has_agent &&
            email.ends_with("@tada-debug.invalid"),
        "Tencent Docs fixture requires a local self-hosted SQLite instance and a dedicated debug email"
    );
    let password = std::env::var("TADA_TENCENT_DOCS_FIXTURE_PASSWORD")
        .map_err(|_| anyhow::anyhow!("Tencent Docs fixture password is required"))?;
    anyhow::ensure!(
        password.len() >= 16,
        "Tencent Docs fixture password must have at least 16 characters"
    );
    if let Some((user, hash)) = repo.credentials(&email).await? {
        let matches =
            tokio::task::spawn_blocking(move || auth::verify_password(&password, &hash)).await?;
        anyhow::ensure!(
            matches,
            "Tencent Docs fixture account credentials do not match"
        );
        return Ok(Some(user.id));
    }
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&password)).await??;
    let user = repo
        .create_user(&email, &hash, "腾讯文档调试", "Asia/Shanghai")
        .await?;
    Ok(Some(user.id))
}

pub fn message_mode(message: &str) -> (&str, Option<bool>) {
    if let Some(text) = message.strip_prefix("【改写开】") {
        (text.trim_start(), Some(true))
    } else if let Some(text) = message.strip_prefix("【改写关】") {
        (text.trim_start(), Some(false))
    } else {
        (message, None)
    }
}
