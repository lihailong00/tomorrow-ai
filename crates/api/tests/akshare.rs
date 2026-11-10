use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::post,
};
use serde_json::{Value, json};
use tomorrow_api::{AppState, app};
use tomorrow_connectors::akshare::Akshare;
use tomorrow_domain::{
    ModelProvider, Repository,
    agent::{AKSHARE_TOOL, AgentClient},
};
use tower::ServiceExt;

const SERVICE: &str = "fixture-service-token-with-at-least-32-characters";
const MCP_TOKEN: &str = "fixture-aktools-token";

#[tokio::test]
async fn akshare_is_advertised_and_invoked_through_an_authenticated_chat_run() {
    let remote = Router::new().route("/mcp", post(mcp)).route(
        "/v1/runs",
        post(|Json(input): Json<Value>| async move {
            assert!(
                input["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == AKSHARE_TOOL)
            );
            Json(json!({"content":"fixture"}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, remote).await.unwrap() });

    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository
        .create_user("akshare@example.test", "unused", "Fixture", "Asia/Shanghai")
        .await
        .unwrap();
    let discovery = repository
        .begin_agent_run(&user.id, "akshare-discovery", "fixture", None, None)
        .await
        .unwrap();
    let mut state = AppState::new(
        repository.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    );
    state.akshare = Some(Akshare::new(&format!("{url}/mcp"), MCP_TOKEN).unwrap());
    let agent = AgentClient::new(&url, SERVICE.into(), "fixture".into())
        .unwrap()
        .with_akshare(true);
    assert_eq!(
        agent
            .execute(&repository, &discovery, &[], "chat")
            .await
            .unwrap(),
        "fixture"
    );
    state.agent = Some(agent);
    let router = app(state);
    let run = repository
        .begin_agent_run(&user.id, "akshare-call", "fixture", None, None)
        .await
        .unwrap();
    let path = format!("/internal/agent/runs/{}/tools", run.id);
    let call = |token: &str, arguments: Value| {
        let router = router.clone();
        let request = Request::post(&path)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("x-agent-service", SERVICE)
            .body(Body::from(
                json!({"name":AKSHARE_TOOL,"arguments":arguments}).to_string(),
            ))
            .unwrap();
        async move {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 100_000).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap())
        }
    };
    let daily = json!({"dataset":"a_share_daily", "symbol":"000001",
        "start_date":"2026-11-02", "end_date":"2026-11-06", "adjust":"qfq"});
    assert_eq!(
        call("another-run", daily.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let mut injected = daily.clone();
    injected["name"] = json!("some_other_interface");
    assert_eq!(call(&run.token, injected).await.0, StatusCode::BAD_REQUEST);
    let (status, data) = call(&run.token, daily).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(data["source"], "东方财富");
    assert_eq!(
        data["rows"],
        json!([{"date":"2026-11-02","open":10.5,"close":11.2,
        "high":11.4,"low":10.2,"volume_lots":1000,"amount_cny":1050000}])
    );
    assert!(data.get("csv_url").is_none());

    let (status, data) = call(
        &run.token,
        json!({"dataset":"trading_calendar",
        "start_date":"2026-10-31","end_date":"2026-11-06"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(
        data["rows"],
        json!([{"date":"2026-11-02"},{"date":"2026-11-06"}])
    );
    assert_eq!(data["coverage_complete"], false);
    server.abort();
}

async fn mcp(headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {MCP_TOKEN}")
    );
    let payload = match body["method"].as_str().unwrap() {
        "initialize" => json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}}}),
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "tools/call" => {
            assert_eq!(body["params"]["name"], "get_data");
            let args = &body["params"]["arguments"];
            match args["name"].as_str().unwrap() {
                "stock_zh_a_hist" => {
                    assert_eq!(
                        args["params"],
                        json!({"symbol":"000001","period":"daily",
                        "adjust":"qfq","start_date":"20261102","end_date":"20261106"})
                    );
                    json!({"structuredContent":{"result":{"rows":[{"日期":"2026-11-02T00:00:00.000",
                        "开盘":10.5,"收盘":11.2,"最高":11.4,"最低":10.2,"成交量":1000,"成交额":1050000}],
                        "csv_url":"/api/public/stock_zh_a_hist"}}})
                }
                "tool_trade_date_hist_sina" => {
                    assert_eq!(args["offset"], -1000);
                    let text = json!({"rows":[{"trade_date":"2026-11-09"},{"trade_date":"2026-11-06"},{"trade_date":"2026-11-02"}]});
                    json!({"content":[{"type":"text","text":text.to_string()}]})
                }
                name => panic!("Unexpected interface: {name}"),
            }
        }
        method => panic!("Unexpected method: {method}"),
    };
    Json(json!({"jsonrpc":"2.0","id":body["id"],"result":payload})).into_response()
}

#[tokio::test]
#[ignore = "requires a running AKTools MCP endpoint and live market data sources"]
async fn akshare_live_calendar_and_daily_prices() {
    let akshare = Akshare::from_env().unwrap().expect("AKSHARE_MCP_URL");
    let calendar = akshare
        .query(json!({"dataset":"trading_calendar",
        "start_date":"2024-10-08","end_date":"2024-10-11"}))
        .await
        .unwrap();
    assert_eq!(calendar["coverage_complete"], true);
    assert_eq!(calendar["rows"].as_array().unwrap().len(), 4);

    let daily = akshare
        .query(json!({"dataset":"a_share_daily","symbol":"000001",
        "start_date":"2024-10-08","end_date":"2024-10-11"}))
        .await
        .unwrap();
    let rows = daily["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0]["date"], "2024-10-08");
    assert!(rows.iter().all(|row| row["close"].is_number()));
}
