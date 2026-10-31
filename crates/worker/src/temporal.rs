//! Real Temporal 1.1 SDK integration, explicitly enabled with --features temporal.
//! Workflow code contains only recorded Activities and durable timers; database/model I/O remains
//! inside Activities. The database attempt/lease guards make Activity redelivery safe to publish.
use crate::WorkerEngine;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use temporalio_client::{
    Client, ClientOptions, Connection, ConnectionOptions, Url, WorkflowIdConflictPolicy,
    WorkflowStartOptions,
};
use temporalio_common::worker::{WorkerDeploymentOptions, WorkerDeploymentVersion};
use temporalio_macros::{activities, workflow, workflow_methods};
use temporalio_sdk::{
    ActivityOptions, ContinueAsNewOptions, Runtime, Worker, WorkerOptions, WorkflowContext,
    WorkflowContextView, WorkflowResult,
    activities::{ActivityContext, ActivityError},
};
use tomorrow_domain::ClaimedTask;

fn task_execution_options() -> ActivityOptions {
    // Leave room for Pi's execution limit and the Rust HTTP/cleanup margin.
    let mut options = ActivityOptions::start_to_close_timeout(Duration::from_secs(
        tomorrow_domain::agent::AGENT_EXECUTION_TIMEOUT_SECONDS + 120,
    ));
    options.heartbeat_timeout = Some(Duration::from_secs(20));
    options
}

#[derive(Clone, Serialize, Deserialize)]
pub struct JobReference {
    user_id: String,
    task_id: String,
    attempt: i64,
}

pub struct TaskActivities {
    engine: WorkerEngine,
}

#[activities]
impl TaskActivities {
    #[activity]
    pub async fn tick(self: Arc<Self>, _ctx: ActivityContext) -> Result<u64, ActivityError> {
        let scheduled = self
            .engine
            .repository()
            .tick_schedules()
            .await
            .map_err(activity_error)? as u64;
        let growth = self.engine.repository().tick_daily_growth().await.map_err(activity_error)? as u64;
        Ok(scheduled + growth)
    }

    #[activity]
    pub async fn claim(
        self: Arc<Self>,
        _ctx: ActivityContext,
    ) -> Result<Option<JobReference>, ActivityError> {
        Ok(self
            .engine
            .claim()
            .await
            .map_err(activity_error)?
            .map(|claim| JobReference {
                task_id: claim.task.id,
                user_id: claim.user_id,
                attempt: claim.attempt,
            }))
    }

    #[activity]
    pub async fn execute(
        self: Arc<Self>,
        ctx: ActivityContext,
        job: JobReference,
    ) -> Result<bool, ActivityError> {
        let task = self
            .engine
            .repository()
            .task(&job.user_id, &job.task_id)
            .await
            .map_err(activity_error)?;
        let claim = ClaimedTask {
            task,
            user_id: job.user_id,
            attempt: job.attempt,
        };
        let work = self.engine.execute(&claim);
        tokio::pin!(work);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                result = &mut work => return result.map_err(activity_error),
                _ = heartbeat.tick() => ctx.record_heartbeat(claim.task.id.clone()).await.map_err(activity_error)?,
                _ = ctx.cancelled() => return Err(ActivityError::Cancelled { details: None }),
            }
        }
    }
}

fn activity_error(error: impl std::fmt::Display) -> ActivityError {
    temporalio_sdk::ApplicationFailure::new(error.to_string()).into()
}

#[workflow]
pub struct TaskQueueWorkflow;

#[workflow_methods]
impl TaskQueueWorkflow {
    #[init]
    fn new(_ctx: &WorkflowContextView) -> Self {
        Self
    }

    #[run]
    pub async fn run(ctx: &mut WorkflowContext<Self>) -> WorkflowResult<()> {
        for _ in 0..500 {
            ctx.execute_activity(
                TaskActivities::tick,
                (),
                ActivityOptions::start_to_close_timeout(Duration::from_secs(30)),
            )
            .await?;
            let job = ctx
                .execute_activity(
                    TaskActivities::claim,
                    (),
                    ActivityOptions::start_to_close_timeout(Duration::from_secs(30)),
                )
                .await?;
            if let Some(job) = job {
                // Business retry/backoff is persisted in tasks. A retried activity either sees its
                // original live lease or returns false, then a later claim recovers the task.
                ctx.execute_activity(TaskActivities::execute, job, task_execution_options())
                    .await?;
            } else {
                ctx.timer(Duration::from_secs(2)).await;
            }
        }
        // Bound history growth for this long-running dispatcher without nondeterministic state.
        ctx.continue_as_new((), ContinueAsNewOptions::default())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use temporalio_sdk::ActivityCloseTimeouts;

    #[test]
    fn research_activity_allows_the_agent_deadline_with_heartbeat_protection() {
        let options = task_execution_options();
        let ActivityCloseTimeouts::StartToClose(duration) = options.close_timeouts else {
            panic!("task execution must retain a start-to-close deadline");
        };
        assert!(duration.as_secs() > tomorrow_domain::agent::AGENT_HTTP_TIMEOUT_SECONDS);
        assert!(duration.as_secs() > tomorrow_domain::agent::AGENT_RUN_LEASE_SECONDS as u64);
        assert_eq!(duration, Duration::from_secs(1320));
        assert_eq!(options.heartbeat_timeout, Some(Duration::from_secs(20)));
        assert_eq!(crate::LEASE_SECONDS, 90);
    }
}

pub async fn run(engine: WorkerEngine) -> Result<()> {
    let address =
        std::env::var("TEMPORAL_ADDRESS").unwrap_or_else(|_| "http://127.0.0.1:7233".into());
    let namespace = std::env::var("TEMPORAL_NAMESPACE").unwrap_or_else(|_| "default".into());
    let queue = std::env::var("TEMPORAL_TASK_QUEUE").unwrap_or_else(|_| "tomorrow-tasks-v1".into());
    let workflow_id = std::env::var("TEMPORAL_DISPATCHER_ID")
        .unwrap_or_else(|_| "tomorrow-task-dispatcher-v1".into());
    let connection_options = ConnectionOptions::new(
        address
            .parse::<Url>()
            .context("TEMPORAL_ADDRESS 须为 http(s)://host:port")?,
    )
    .connect_timeout(Duration::from_secs(5))
    .build();
    let connection = tokio::time::timeout(Duration::from_secs(10), Connection::connect(connection_options))
        .await.context("Temporal 服务连接超时，请先启动 Temporal 服务并检查 TEMPORAL_ADDRESS")?
        .context("无法连接 Temporal 服务，请先运行 temporal server start-dev，或检查 TEMPORAL_ADDRESS；不会切换至本地模式")?;
    let client = Client::new(connection, ClientOptions::new(namespace).build())?;
    let runtime = Runtime::from_current_tokio(Default::default())?;
    let options = WorkerOptions::new(queue.clone())
        .deployment_options(
            WorkerDeploymentOptions::new(
                WorkerDeploymentVersion::builder()
                    .deployment_name("tomorrow-worker")
                    .build_id(env!("CARGO_PKG_VERSION"))
                    .build(),
            )
            .build(),
        )
        .register_activities(TaskActivities { engine })
        .register_workflow::<TaskQueueWorkflow>()?
        .graceful_shutdown_period(Duration::from_secs(10))
        .build();
    let mut worker = Worker::new(&runtime, client.clone(), options)?;
    client
        .start_workflow(
            TaskQueueWorkflow::run,
            (),
            WorkflowStartOptions::new(queue, workflow_id)
                .id_conflict_policy(WorkflowIdConflictPolicy::UseExisting)
                .build(),
        )
        .await
        .context("启动 Temporal 调度工作流失败，请检查命名空间和任务队列")?;
    tracing::info!(
        scheduler_mode = "temporal",
        "Temporal Rust SDK Worker 已启动，调度由持久工作流与 Activities 执行"
    );
    worker.run().await?;
    Ok(())
}
