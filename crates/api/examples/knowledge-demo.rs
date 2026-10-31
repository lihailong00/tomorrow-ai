//! Isolated local instance for the graph smoke test; never opens the main application's database.
use tomorrow_api::{app, AppState};
use tomorrow_domain::{agent::AgentClient, ModelProvider, Repository};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database = std::env::var("GRAPH_DEMO_DATABASE")?;
    let repository = Repository::connect(&database).await?;
    let mut state = AppState::new(repository, ModelProvider::local(), &database);
    state.agent = Some(AgentClient::new(
        &std::env::var("AGENT_URL")?,
        std::env::var("AGENT_SERVICE_TOKEN")?,
        std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-flash".into()),
    )?);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18080").await?;
    axum::serve(listener, app(state)).await?;
    Ok(())
}
