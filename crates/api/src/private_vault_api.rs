use crate::{AppState, Auth, Result};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tomorrow_domain::private_vault::{VaultBackup, VaultEnvelope};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/private-vault/backup", get(read).put(write).delete(remove))
        .layer(DefaultBodyLimit::max(270 * 1024))
        .layer(middleware::map_response(no_store))
}

async fn no_store(mut response: Response) -> Response {
    // Authentication, stale-version and extractor failures are private too.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteBackup {
    expected_version: i64,
    envelope: VaultEnvelope,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteBackup {
    expected_version: i64,
}

fn private_response(value: VaultBackup) -> Response {
    Json(value).into_response()
}
async fn read(State(state): State<Arc<AppState>>, auth: Auth) -> Result<Response> {
    Ok(private_response(
        state.repository.private_vault_backup(&auth.user_id).await?,
    ))
}
async fn write(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Json(input): Json<WriteBackup>,
) -> Result<Response> {
    Ok(private_response(
        state
            .repository
            .write_private_vault_backup(&auth.user_id, input.expected_version, Some(input.envelope))
            .await?,
    ))
}
async fn remove(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Json(input): Json<DeleteBackup>,
) -> Result<Response> {
    Ok(private_response(
        state
            .repository
            .write_private_vault_backup(&auth.user_id, input.expected_version, None)
            .await?,
    ))
}
