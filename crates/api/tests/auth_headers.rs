use axum::{body::Body, http::{Request, StatusCode}};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

#[tokio::test]
async fn bearer_scheme_casing_is_accepted_without_changing_token_identity() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository.create_user("headers@example.test", "unused", "Headers", "Asia/Shanghai").await.unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let router = app(AppState::new(repository, ModelProvider::local(), "sqlite::memory:"));
    for scheme in ["Bearer", "bearer", "bEaReR", "BEARER  "] {
        let response = router.clone().oneshot(Request::builder().uri("/v1/me")
            .header("authorization", format!("{scheme} {token}"))
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "scheme {scheme:?}");
    }
    let mut wrong_case = token.to_uppercase();
    if wrong_case == token { wrong_case.replace_range(..1, "A"); }
    for header in [format!("Basic {token}"), "Bearer".into(), "Bearer ".into(),
        format!("Bearer {token} extra"), format!("Bearer {wrong_case}"),
        format!("Bearer\t{token}")] {
        let response = router.clone().oneshot(Request::builder().uri("/v1/me")
            .header("authorization", header).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
