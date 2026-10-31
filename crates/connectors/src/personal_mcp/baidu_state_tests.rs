use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingTransport(Arc<AtomicUsize>);
impl McpTransport for CountingTransport {
    fn discover<'a>(&'a self, _: &'a str, _: &'a Credentials) -> RequestFuture<'a, Vec<Value>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![
                json!({"name":"user_info","description":"read-only","inputSchema":{"type":"object"}}),
            ])
        })
    }
    fn call<'a>(
        &'a self,
        _: &'a str,
        _: &'a Credentials,
        _: &'a str,
        _: Value,
    ) -> RequestFuture<'a, Value> {
        Box::pin(async { Ok(json!({"content":[]})) })
    }
}

#[tokio::test]
async fn personal_experience_requires_explicit_runtime_opt_in_without_environment_races() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "baidu-gate@example.test",
            "unused",
            "Baidu test",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = PersonalMcpState::with_transport(
        repo,
        Some(Crypto::from_hex(&"ab".repeat(32)).unwrap()),
        Arc::new(CountingTransport(calls.clone())),
    )
    .await
    .unwrap();
    let mut values = HashMap::from([("CONNECTOR_ENCRYPTION_KEY".into(), "ab".repeat(32))]);
    let disabled = state.reconfigured(&values);
    let item = disabled.item(&user.id, "baidu_netdisk").await.unwrap();
    assert_eq!(item["status"], "not_configured");
    assert_eq!(item["environment"], "experience");
    assert_eq!(item["experience_only"], true);
    assert_eq!(item["has_credentials"], false);
    let credentials = Credentials {
        token: "fake-fixture-token".into(),
        environment: "experience".into(),
        server_url: None,
    };
    assert!(
        disabled
            .connect(&user.id, "baidu_netdisk", credentials.clone())
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    values.insert("BAIDU_NETDISK_EXPERIENCE_ENABLED".into(), "true".into());
    let enabled = disabled.reconfigured(&values);
    assert_eq!(
        enabled
            .connect(&user.id, "baidu_netdisk", credentials)
            .await
            .unwrap()["environment"],
        "experience"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    values.insert("BAIDU_NETDISK_EXPERIENCE_ENABLED".into(), "false".into());
    let disabled = enabled.reconfigured(&values);
    let stored = disabled.item(&user.id, "baidu_netdisk").await.unwrap();
    assert_eq!(stored["status"], "not_configured");
    assert_eq!(stored["has_credentials"], true);
    assert!(disabled.tools(&user.id, "baidu_netdisk").await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    disabled
        .disconnect(&user.id, "baidu_netdisk")
        .await
        .unwrap();
    assert_eq!(
        disabled.item(&user.id, "baidu_netdisk").await.unwrap()["has_credentials"],
        false
    );
}
