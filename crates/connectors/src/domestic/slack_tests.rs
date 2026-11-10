use super::*;
use axum::{Form, Router};
use tests::{fixture, request};

#[tokio::test]
async fn slack_oauth_search_rotation_and_disconnect_are_user_scoped() {
    let (state, user, _, a, b) = fixture().await;
    let route = "/v1/integrations/slack/search";
    assert_eq!(
        request(&state, "POST", route, Some(&a), json!({"query":"launch"}))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );

    let token_handler = |Form(form): Form<std::collections::HashMap<String, String>>| async move {
        assert_eq!(form["client_secret"], "slack-test-secret");
        match form["grant_type"].as_str() {
            "authorization_code" => {
                assert_eq!(form["code"], "slack-test-code");
                assert_eq!(
                    form["redirect_uri"],
                    "https://tada.example/v1/integrations/slack/callback"
                );
                Json(
                    json!({"ok":true,"team":{"id":"T123","name":"Fixture workspace"},
                    "authed_user":{"id":"U123","scope":"search:read.public","token_type":"user",
                    "access_token":"xoxe.xoxp-first","expires_in":1,"refresh_token":"xoxe-first"}}),
                )
            }
            "refresh_token" => {
                assert_eq!(form["refresh_token"], "xoxe-first");
                Json(
                    json!({"ok":true,"id":"U123","scope":"search:read.public","token_type":"user",
                    "access_token":"xoxe.xoxp-second","expires_in":43200,"refresh_token":"xoxe-second"}),
                )
            }
            _ => panic!("unexpected Slack grant"),
        }
    };
    let search_handler = |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
        assert_eq!(headers[header::AUTHORIZATION], "Bearer xoxe.xoxp-second");
        assert_eq!(body["channel_types"], json!(["public_channel"]));
        assert_eq!(body["content_types"], json!(["messages"]));
        assert_eq!(body["disable_semantic_search"], true);
        if body["query"] == "rate limit" {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"ok":false,"error":"ratelimited"})),
            );
        }
        assert_eq!(body["query"], "launch");
        if body["cursor"] == "page-two" {
            return (
                StatusCode::OK,
                Json(json!({"ok":true,"results":{"messages":[]}})),
            );
        }
        (
            StatusCode::OK,
            Json(json!({"ok":true,"results":{"messages":[
            {"team_id":"T123","channel_id":"C123","channel_name":"launch","message_ts":"123.45",
             "content":"Slack fixture message only","permalink":"https://fixture.slack.com/archives/C123/p12345?thread_ts=122.45&cid=C123"},
            {"team_id":"T987","channel_id":"C123","message_ts":"124.45",
             "content":"OTHER WORKSPACE","permalink":"https://other.slack.com/archives/C123/p12445"},
            {"team_id":"T123","channel_id":"G123","message_ts":"125.45",
             "content":"PRIVATE","permalink":"https://fixture.slack.com/archives/G123/p12545"},
            {"team_id":"T123","channel_id":"C123","message_ts":"126.45",
             "content":"UNSAFE LINK","permalink":"https://fixture.slack.com.example/archives/C123/p12645"}
        ]},"response_metadata":{"next_cursor":"page-two"}})),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let vendor = Router::new()
        .route("/api/oauth.v2.access", post(token_handler))
        .route("/api/assistant.search.context", post(search_handler));
    let server = tokio::spawn(async move { axum::serve(listener, vendor).await.unwrap() });
    let provider = oauth::OAuthProvider::from_lookup("slack", |name| match name {
        "SLACK_CLIENT_ID" => Some("123.456".into()),
        "SLACK_CLIENT_SECRET" => Some("slack-test-secret".into()),
        "SLACK_REDIRECT_URI" => Some("https://tada.example/v1/integrations/slack/callback".into()),
        _ => None,
    })
    .unwrap()
    .with_test_origin(origin);
    let mut inner = (*state.0).clone();
    inner.oauth_test_providers.insert("slack".into(), provider);
    let state = IntegrationState(Arc::new(inner));

    let (status, grant) = request(
        &state,
        "POST",
        "/v1/integrations/slack/authorize",
        Some(&a),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let url = reqwest::Url::parse(grant["authorization_url"].as_str().unwrap()).unwrap();
    assert_eq!(url.host_str(), Some("slack.com"));
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["user_scope"], "search:read.public");
    assert!(!params.contains_key("scope") && !params.contains_key("client_secret"));
    let callback = format!(
        "/v1/integrations/slack/callback?state={}&code=slack-test-code",
        params["state"]
    );
    assert_eq!(
        request(&state, "GET", &callback, None, Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "GET", &callback, None, Value::Null).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, list) = request(&state, "GET", "/v1/integrations", Some(&a), Value::Null).await;
    let slack = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "slack")
        .unwrap();
    assert_eq!(slack["status"], "connected");
    assert_eq!(slack["import_supported"], false);
    assert!(!list.to_string().contains("xoxe"));
    assert_eq!(
        request(&state, "POST", route, None, json!({"query":"launch"}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&state, "POST", route, Some(&b), json!({"query":"launch"}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/v1/integrations/slack/read",
            Some(&a),
            json!({"query":"launch"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _) = request(
        &state,
        "POST",
        route,
        Some(&a),
        json!({"query":"rate limit"}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (_, encrypted) = state.account(&user, "slack").await.unwrap().unwrap();
    assert!(!encrypted.contains("xoxe"));
    assert_eq!(
        state.decode(&user, "slack", &encrypted).unwrap()["refresh_token"],
        "xoxe-second"
    );
    let (status, data) = request(
        &state,
        "POST",
        route,
        Some(&a),
        json!({"query":"launch","channel_types":["im"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["items"].as_array().unwrap().len(), 1);
    assert_eq!(data["items"][0]["text"], "Slack fixture message only");
    assert_eq!(
        data["items"][0]["url"],
        "https://fixture.slack.com/archives/C123/p12345?thread_ts=122.45&cid=C123"
    );
    assert_eq!(data["next_cursor"], "page-two");
    let (_, page) = request(
        &state,
        "POST",
        route,
        Some(&a),
        json!({"query":"launch","cursor":"page-two"}),
    )
    .await;
    assert_eq!(page["items"], json!([]));
    assert_eq!(
        request(
            &state,
            "POST",
            "/v1/integrations/imports",
            Some(&a),
            json!({
                "source_app":"slack","title":"fixture","text":"Slack fixture message only"
            })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &state,
            "DELETE",
            "/v1/integrations/slack",
            Some(&a),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "POST", route, Some(&a), json!({"query":"launch"}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    server.abort();
}
