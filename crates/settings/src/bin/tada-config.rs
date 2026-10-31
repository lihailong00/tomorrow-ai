//! Offline operator helper. Its output contains counts and public identifiers,
//! never plaintext settings. Not exposed through the administration HTTP router.
use sqlx::any::AnyPoolOptions;
use std::time::Duration;
use tomorrow_settings::{ConfigError, ConfigStore};

#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["--help"] {
        println!(
            "Usage: tada-config --status | --import-environment\nReads DATABASE_URL and the same private environment as the API. TADA_CONFIG_DIR/TADA_CONFIG_MASTER_KEY must match the running server. Stop request traffic before a controlled legacy import. No setting values are printed."
        );
        return;
    }
    if !matches!(arguments.as_slice(), [command] if command == "--status" || command == "--import-environment")
    {
        eprintln!("Use --help for supported operations.");
        std::process::exit(2);
    }
    let result = execute(&arguments[0]).await;
    if let Err(error) = result {
        // ConfigError has fixed, redacted messages. Never format a SQLx error.
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn execute(command: &str) -> Result<(), ConfigError> {
    let database = std::env::var("DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or(ConfigError::Validation)?;
    sqlx::any::install_default_drivers();
    let pool = AnyPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(30))
        .connect(&database)
        .await
        .map_err(|_| ConfigError::Storage)?;
    let store = ConfigStore::new(pool).await?;
    let environment_count = store.configured_environment_keys().len();
    let revision = if command == "--import-environment" {
        store
            .import_environment(store.revision().await?)
            .await?
            .revision
    } else {
        store.revision().await?
    };
    println!(
        "{}",
        serde_json::json!({
            "status":if command == "--import-environment" {"imported"} else {"ready"},
            "instance_id":store.instance_id(),"revision":revision,
            "configured_environment_count":environment_count,
        })
    );
    Ok(())
}
