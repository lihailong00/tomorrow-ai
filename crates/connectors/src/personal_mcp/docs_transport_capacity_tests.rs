use super::*;
use axum::{Json, Router, extract::State, routing::post};

async fn catalog_server(count: usize) -> (Url, tokio::task::JoinHandle<()>) {
    let tools: Vec<Value> = (0..count).map(|index| json!({
        "name":format!("docs_tool_{index}"), "description":"d".repeat(1700),
        "inputSchema":{"type":"object","required":["id"],"additionalProperties":false,
            "properties":{"id":{"type":"string","minLength":1,"description":"s".repeat(1100)}}}
    })).collect();
    let app = Router::new()
        .route(
            "/",
            post(
                |State(tools): State<Vec<Value>>, Json(input): Json<Value>| async move {
                    Json(json!({"jsonrpc":"2.0","id":input["id"],"result":{"tools":tools}}))
                },
            ),
        )
        .with_state(tools);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn docs_discovery_accepts_large_catalog_without_relaxing_tool_results() {
    let (url, task) = catalog_server(227).await;
    let mut default = HttpConnection::new(url.clone(), HeaderMap::new()).unwrap();
    assert!(default.rpc("tools/list", json!({})).await.is_err());
    let (count_limit, byte_limit) = super::super::catalog::discovery_limits("tencent_docs");
    let mut docs = HttpConnection::new(url.clone(), HeaderMap::new()).unwrap();
    docs.tools_response_bytes = byte_limit;
    let mut connection = Connection::Http(docs);
    let tools = discover_on_with_limits(&mut connection, count_limit, byte_limit)
        .await
        .unwrap();
    assert_eq!(tools.len(), 227);
    assert_eq!(tools[226]["inputSchema"]["required"], json!(["id"]));
    assert_eq!(tools[226]["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        tools[226]["inputSchema"]["properties"]["id"]["minLength"],
        1
    );
    let mut result = HttpConnection::new(url, HeaderMap::new()).unwrap();
    result.tools_response_bytes = byte_limit;
    assert!(result.rpc("tools/call", json!({})).await.is_err());
    task.abort();
}

#[tokio::test]
async fn docs_tool_count_and_one_mib_response_limits_still_reject_excess() {
    let (url, task) = catalog_server(257).await;
    let mut http = HttpConnection::new(url, HeaderMap::new()).unwrap();
    let (count, bytes) = super::super::catalog::discovery_limits("tencent_docs");
    http.tools_response_bytes = bytes;
    assert!(
        discover_on_with_limits(&mut Connection::Http(http), count, bytes)
            .await
            .is_err()
    );
    task.abort();
    let (url, task) = catalog_server(400).await;
    let mut http = HttpConnection::new(url, HeaderMap::new()).unwrap();
    http.tools_response_bytes = bytes;
    assert!(http.rpc("tools/list", json!({})).await.is_err());
    task.abort();
    assert_eq!(
        super::super::catalog::discovery_limits("didi"),
        (128, MAX_BYTES)
    );
}
