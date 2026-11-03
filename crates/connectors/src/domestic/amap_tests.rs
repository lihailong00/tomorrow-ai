use super::*;

fn map_status(items: Vec<Value>) -> Value {
    items.into_iter().find(|item| item["id"] == "amap").unwrap()
}

#[tokio::test]
async fn map_keys_are_encrypted_owned_and_never_returned_in_status() {
    let (state, a, b, ta, tb) = tests::fixture().await;
    let generation = state.reserve(&a, "amap").await.unwrap();
    let secret = "amap-user-a-private-test-key";
    state.save(&a, "amap", generation, &json!({"web_api_key":secret})).await.unwrap();
    let (_, ciphertext) = state.account(&a, "amap").await.unwrap().unwrap();
    assert!(!ciphertext.contains(secret));
    assert_eq!(state.decode(&a, "amap", &ciphertext).unwrap()["web_api_key"], secret);
    assert!(state.decode(&b, "amap", &ciphertext).is_err());
    for (token, expected) in [(ta, "connected"), (tb, "not_connected")] {
        let (status, body) = tests::request(&state, "GET", "/v1/integrations", Some(&token), json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.to_string().contains(secret));
        let item = map_status(body["items"].as_array().unwrap().clone());
        assert_eq!(item["status"], expected);
        assert_eq!(item["credential_scope"], "user");
        assert_eq!(item["required_configuration"], json!(["CONNECTOR_ENCRYPTION_KEY"]));
    }
}

#[tokio::test]
async fn map_cannot_fall_back_to_a_service_key_or_another_users_key() {
    let (base, a, b, _, tb) = tests::fixture().await;
    let state = base.reconfigured(&std::collections::HashMap::from([
        ("CONNECTOR_ENCRYPTION_KEY".into(), "01".repeat(32)),
        ("AMAP_WEB_API_KEY".into(), "legacy-service-key-must-not-be-used".into()),
    ]));
    assert_eq!(map_status(state.statuses(&a).await.unwrap())["status"], "not_connected");
    let generation = state.reserve(&a, "amap").await.unwrap();
    state.save(&a, "amap", generation, &json!({"web_api_key":"user-a-key"})).await.unwrap();
    let (status, body) = tests::request(&state, "POST", "/v1/integrations/amap/read", Some(&tb), json!({"keywords":"北京南站"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "connection_required");
    assert!(state.account(&b, "amap").await.unwrap().is_none());
}

#[tokio::test]
async fn invalid_map_replacement_preserves_existing_key_and_disconnect_is_scoped() {
    let (state, a, b, ta, _) = tests::fixture().await;
    for (user, key) in [(&a, "user-a-key"), (&b, "user-b-key")] {
        let generation = state.reserve(user, "amap").await.unwrap();
        state.save(user, "amap", generation, &json!({"web_api_key":key})).await.unwrap();
    }
    let (status, _) = tests::request(&state, "POST", "/v1/integrations/amap/connect", Some(&ta), json!({"web_api_key":""})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, ciphertext) = state.account(&a, "amap").await.unwrap().unwrap();
    assert_eq!(state.decode(&a, "amap", &ciphertext).unwrap()["web_api_key"], "user-a-key");
    assert_eq!(map_status(state.statuses(&a).await.unwrap())["status"], "connected");
    state.disconnect(&a, "amap").await.unwrap();
    assert_eq!(map_status(state.statuses(&a).await.unwrap())["status"], "not_connected");
    assert_eq!(map_status(state.statuses(&b).await.unwrap())["status"], "connected");
    assert_eq!(state.read(&a, "amap", json!({"keywords":"北京南站"})).await.unwrap_err().code, "connection_required");
}

#[tokio::test]
async fn map_credentials_are_required_before_any_provider_request() {
    assert_eq!(providers::verify("amap", &json!({"token":"wrong-field"})).await.unwrap_err().status, StatusCode::BAD_REQUEST);
    assert_eq!(providers::read("amap", &json!({}), &json!({"keywords":"北京南站"})).await.unwrap_err().status, StatusCode::BAD_REQUEST);
    assert!(!usable_credentials("map", "amap", &json!({"web_api_key":""})));
    assert!(!usable_credentials("map", "amap", &json!({"token":"wrong-field"})));
}
