use anyhow::{Context, Result, bail};
use std::time::Duration;
use tomorrow_domain::{ModelProvider, Repository};
use tomorrow_worker::WorkerEngine;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:data/tomorrow.db".into());
    let repository = Repository::connect(&database_url)
        .await
        .context("任务数据库连接失败，请检查 DATABASE_URL")?;
    let settings = tomorrow_settings::ConfigStore::new(repository.pool()).await?;
    let engine = WorkerEngine::new(repository, ModelProvider::from_env())
        .with_agent(tomorrow_domain::agent::AgentClient::from_env()?)
        .with_settings(settings);
    let mode = std::env::var("SCHEDULER_MODE").unwrap_or_else(|_| "local".into());
    match mode.as_str() {
        "local" => run_local(engine).await,
        "temporal" => {
            #[cfg(feature = "temporal")]
            {
                tomorrow_worker::temporal::run(engine).await
            }
            #[cfg(not(feature = "temporal"))]
            {
                bail!(
                    "SCHEDULER_MODE=temporal 需要真实 Temporal SDK 构建：cargo run -p tomorrow-worker --features temporal。请先启动 Temporal 服务；本进程不会自动降级为本地轮询。"
                )
            }
        }
        _ => bail!("SCHEDULER_MODE 只支持 local 或 temporal"),
    }
}

async fn run_local(engine: WorkerEngine) -> Result<()> {
    tracing::info!(
        scheduler_mode = "local",
        "持久队列 Worker 已启动；当前使用数据库轮询，可在 API 退出后独立工作"
    );
    let mut poll = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal?;
                tracing::info!("Worker 已停止，未完成任务将在租约到期后恢复");
                return Ok(());
            }
            _ = poll.tick() => {
                if let Err(error) = engine.repository().tick_schedules().await {
                    tracing::error!(%error, "例行任务检查失败，下轮重试");
                }
                match engine.claim().await {
                    Ok(Some(claim)) => {
                        if let Err(error) = engine.execute(&claim).await {
                            tracing::error!(task_id = %claim.task.id, %error, "任务执行失败，持久队列将按策略重试");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => tracing::error!(%error, "读取任务失败，下轮重试"),
                }
            }
        }
    }
}
