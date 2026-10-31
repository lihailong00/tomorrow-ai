//! Per-revision configuration snapshots keep in-flight requests on their original
//! providers. Administration stays available even when an optional provider is incomplete.
use crate::{admin, AppState};
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{any, get},
    Json, Router,
};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use tomorrow_settings::ConfigStore;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct Live {
    baseline: AppState,
    settings: ConfigStore,
    cached: Arc<Mutex<Option<(i64, Router)>>>,
}

pub fn router(
    mut baseline: AppState,
    settings: ConfigStore,
    administration: admin::AdminState,
) -> Router {
    if let Some(attachments) = baseline.attachments.take() {
        let photo_settings = settings.clone();
        baseline.attachments = Some(attachments.with_photo_configuration(move || {
            let store = photo_settings.clone();
            async move { store.effective_snapshot().await.ok() }
        }));
    }
    let state = Live {
        baseline,
        settings,
        cached: Arc::new(Mutex::new(None)),
    };
    let root = std::env::var_os("TADA_ADMIN_DIST")
        .or_else(|| std::env::var_os("TADA_ADMIN_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(unix) {
                PathBuf::from("/opt/tomorrow/admin")
            } else {
                PathBuf::from("apps/admin/dist")
            }
        });
    let static_pages = Router::new()
        .route("/admin", get(|| async { Redirect::temporary("/admin/") }))
        .nest_service(
            "/admin/",
            ServeDir::new(&root).not_found_service(ServeFile::new(root.join("index.html"))),
        )
        .layer(middleware::from_fn(page_headers));
    Router::new()
        .fallback(any(dispatch))
        .with_state(state)
        .merge(static_pages)
        .merge(admin::router(administration.clone()))
        .merge(admin::public_router(administration))
}

async fn dispatch(State(live): State<Live>, request: Request) -> Response {
    let resolved = live.settings.effective_snapshot().await;
    let (revision, values) = match resolved {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let router = {
        let mut cached = live.cached.lock().await;
        if cached
            .as_ref()
            .is_none_or(|(current, _)| *current != revision)
        {
            match reconfigure(&live.baseline, &values) {
                Ok(state) => *cached = Some((revision, crate::app(state))),
                Err(_) => return unavailable(),
            }
        }
        cached.as_ref().expect("snapshot initialized").1.clone()
    };
    match router.oneshot(request).await {
        Ok(response) => response,
        Err(error) => match error {},
    }
}

fn reconfigure(base: &AppState, values: &HashMap<String, String>) -> anyhow::Result<AppState> {
    let mut next = base.clone();
    if next.agent.is_none() {
        next.provider = tomorrow_domain::ModelProvider::from_lookup(|key| values.get(key).cloned());
    }
    if let Some(attachments) = &base.attachments {
        next.attachments = Some(attachments.reconfigured(values)?);
    }
    if let Some(connectors) = &base.connectors {
        next.connectors = Some(connectors.reconfigured(values)?);
    }
    if let Some(integrations) = &base.integrations {
        next.integrations = Some(integrations.reconfigured(values));
    }
    if let Some(personal_mcp) = &base.personal_mcp {
        next.personal_mcp = Some(personal_mcp.reconfigured(values));
    }
    if let Some(wallet) = &base.personal_wallet {
        next.personal_wallet = Some(wallet.reconfigured(values));
    }
    if let Some(health) = &base.health {
        next.health = Some(health.reconfigured(values));
    }
    next.phone_auth =
        tomorrow_domain::phone::PhoneAuth::from_settings(|key| values.get(key).cloned())
            .unwrap_or_else(|_| tomorrow_domain::phone::PhoneAuth::disabled());
    Ok(next)
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":{"code":"configuration_unavailable","message":"服务配置暂时不可用，请在管理后台检查配置"}}))).into_response()
}

async fn page_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request as HttpRequest,
    };
    use tomorrow_domain::{auth, ModelProvider, Repository};
    use tomorrow_settings::ConfigOptions;

    async fn fixture() -> (Router, ConfigStore, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let settings = ConfigStore::with_options(
            repo.pool(),
            ConfigOptions {
                environment: HashMap::new(),
                config_dir: dir.path().join("config"),
                master_key: None,
            },
        )
        .await
        .unwrap();
        let admin = admin::AdminState::new(repo.clone(), settings.clone())
            .await
            .unwrap();
        let user = repo
            .create_user(
                "fixture@example.test",
                &auth::hash_password("Fixture-safe-pass-2026").unwrap(),
                "fixture",
                "Asia/Shanghai",
            )
            .await
            .unwrap();
        let token = repo.create_session(&user.id).await.unwrap();
        let mut state = AppState::new(repo, ModelProvider::local(), "sqlite::memory:");
        state.settings = Some(settings.clone());
        state.admin = Some(admin.clone());
        (router(state, settings.clone(), admin), settings, token, dir)
    }

    #[tokio::test]
    async fn real_router_keeps_admin_outside_permissive_mobile_cors_and_enforces_instance_policy() {
        let (app, settings, _, _dir) = fixture().await;
        let response = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/admin/api/session")
                    .header("origin", "https://hostile.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        let request = || {
            HttpRequest::builder()
                .method("POST")
                .uri("/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"second@example.test","password":"Fixture-safe-pass-2026"}"#,
                ))
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let revision = settings.revision().await.unwrap();
        settings
            .update(
                revision,
                HashMap::from([("REGISTRATION_POLICY".into(), Some("open".into()))]),
            )
            .await
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::OK
        );
        let revision = settings.revision().await.unwrap();
        settings
            .update(
                revision,
                HashMap::from([("EMAIL_PASSWORD_ENABLED".into(), Some("false".into()))]),
            )
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(request()).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn model_configuration_changes_take_effect_on_next_request_without_paid_calls() {
        let (app, settings, token, _dir) = fixture().await;
        let mock = Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|Json(input): Json<serde_json::Value>| async move {
                Json(json!({"choices":[{"message":{"content":input["model"].as_str().unwrap()}}]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        for model in ["fixture-one", "fixture-two"] {
            settings
                .update(
                    settings.revision().await.unwrap(),
                    HashMap::from([
                        ("MODEL_BASE_URL".into(), Some(base.clone())),
                        ("MODEL_NAME".into(), Some(model.into())),
                        (
                            "MODEL_API_KEY".into(),
                            Some("fixture-not-a-real-provider-key".into()),
                        ),
                    ]),
                )
                .await
                .unwrap();
            let response = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/v1/chat")
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"message":"hello"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap())
                    .unwrap();
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["message"]["content"], model);
        }
        server.abort();
    }
}
