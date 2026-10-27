#![cfg(feature = "temporal")]

use std::{
    fs::File,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use temporalio_client::{
    Client, ClientOptions, Connection, ConnectionOptions, WorkflowCancelOptions,
};
use tomorrow_domain::{CreateTask, Repository};
use tomorrow_worker::temporal::TaskQueueWorkflow;

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_worker(
    directory: &Path,
    url: &str,
    address: &str,
    queue: &str,
    workflow_id: &str,
    log: &str,
) -> Process {
    // Run a copy so parallel Windows builds can still replace target/debug's executable.
    let executable = directory.join(if cfg!(windows) {
        "worker.exe"
    } else {
        "worker"
    });
    if !executable.exists() {
        std::fs::copy(env!("CARGO_BIN_EXE_tomorrow-worker"), &executable).unwrap();
    }
    let file = File::create(directory.join(log)).unwrap();
    Process(
        Command::new(executable)
            .current_dir(directory)
            .env("DATABASE_URL", url)
            .env("SCHEDULER_MODE", "temporal")
            .env("TEMPORAL_ADDRESS", address)
            .env("TEMPORAL_NAMESPACE", "default")
            .env("TEMPORAL_TASK_QUEUE", queue)
            .env("TEMPORAL_DISPATCHER_ID", workflow_id)
            .env_remove("MODEL_API_KEY")
            .env_remove("MODEL_NAME")
            .env_remove("MODEL_BASE_URL")
            .env_remove("DEEPSEEK_API_KEY")
            .env_remove("DEEPSEEK_BASE_URL")
            .env_remove("DEEPSEEK_MODEL")
            .stdout(Stdio::from(file.try_clone().unwrap()))
            .stderr(Stdio::from(file))
            .spawn()
            .unwrap(),
    )
}

async fn wait_for_result(
    repository: &Repository,
    user_id: &str,
    task_id: &str,
    directory: &Path,
    log: &str,
) {
    for _ in 0..120 {
        let task = repository.task(user_id, task_id).await.unwrap();
        if task.status == "succeeded" {
            return;
        }
        assert_ne!(task.status, "failed", "task failed: {:?}", task.error);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!(
        "Temporal task did not complete: {}",
        std::fs::read_to_string(directory.join(log)).unwrap_or_default()
    );
}

#[tokio::test]
#[ignore = "requires a real Temporal service; run --features temporal --test temporal_live -- --ignored"]
async fn real_workflow_executes_and_replays_after_worker_restart() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory
            .path()
            .join("temporal.db")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let address =
        std::env::var("TEMPORAL_TEST_ADDRESS").unwrap_or_else(|_| "http://127.0.0.1:7233".into());
    let suffix = format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let queue = format!("tomorrow-qa-worker-{suffix}");
    let workflow_id = format!("tomorrow-qa-dispatcher-{suffix}");
    let repository = Repository::connect(&url).await.unwrap();
    let user = repository
        .create_user(
            "temporal-test@example.com",
            "test-only-password-hash",
            "Temporal 测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let create = || CreateTask {
        instruction: "整理本地测试资料".into(),
        title: Some("Temporal 真实执行验证".into()),
        kind: Some("organize".into()),
        approval_required: Some(false),
        client_request_id: None,
    };

    let first = repository.create_task(&user.id, create()).await.unwrap();
    let process = spawn_worker(
        directory.path(),
        &url,
        &address,
        &queue,
        &workflow_id,
        "first.log",
    );
    wait_for_result(
        &repository,
        &user.id,
        &first.id,
        directory.path(),
        "first.log",
    )
    .await;
    assert!(
        repository
            .task(&user.id, &first.id)
            .await
            .unwrap()
            .result
            .unwrap()
            .contains("本地模式")
    );
    drop(process);

    let second = repository.create_task(&user.id, create()).await.unwrap();
    assert_eq!(
        repository.task(&user.id, &second.id).await.unwrap().status,
        "queued"
    );
    let restarted = spawn_worker(
        directory.path(),
        &url,
        &address,
        &queue,
        &workflow_id,
        "restarted.log",
    );
    wait_for_result(
        &repository,
        &user.id,
        &second.id,
        directory.path(),
        "restarted.log",
    )
    .await;
    assert_eq!(repository.artifacts(&user.id).await.unwrap().len(), 2);
    assert_eq!(repository.notifications(&user.id).await.unwrap().len(), 2);

    let connection = Connection::connect(
        ConnectionOptions::new(address.parse::<temporalio_client::Url>().unwrap()).build(),
    )
    .await
    .unwrap();
    let client = Client::new(connection, ClientOptions::new("default").build()).unwrap();
    client
        .get_workflow_handle::<TaskQueueWorkflow>(&workflow_id)
        .cancel(WorkflowCancelOptions::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(restarted);
}

#[tokio::test]
async fn unavailable_service_fails_clearly_without_executing_locally() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory
            .path()
            .join("offline.db")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let repository = Repository::connect(&url).await.unwrap();
    let user = repository
        .create_user(
            "unavailable-test@example.com",
            "test-only-password-hash",
            "离线测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let task = repository
        .create_task(
            &user.id,
            CreateTask {
                instruction: "不应该执行这个任务".into(),
                title: None,
                kind: None,
                approval_required: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let mut process = spawn_worker(
        directory.path(),
        &url,
        "http://127.0.0.1:0",
        "unavailable-test",
        "unavailable-test",
        "offline.log",
    );
    let mut exited = false;
    for _ in 0..30 {
        if let Some(status) = process.0.try_wait().unwrap() {
            assert!(!status.success());
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        exited,
        "unavailable Temporal service must time out promptly"
    );
    let output = std::fs::read_to_string(directory.path().join("offline.log")).unwrap();
    assert!(output.contains("Temporal 服务"), "{output}");
    assert!(
        output.contains("不会切换至本地模式") || output.contains("连接超时"),
        "{output}"
    );
    assert_eq!(
        repository.task(&user.id, &task.id).await.unwrap().status,
        "queued"
    );
    assert!(repository.artifacts(&user.id).await.unwrap().is_empty());
}
