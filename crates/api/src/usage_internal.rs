//! Service-authenticated Pi accounting. User/purpose come exclusively from the run.
use super::{AppState, Result};
use axum::{extract::{Path, State}, http::{header, HeaderMap}, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tomorrow_domain::{DomainError, usage::{UsageIdentity, UsageMeasurements, UsageOutcome}};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/internal/agent/runs/{id}/usage", post(record))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Dispatch { request_index: u32, deployment: String, model: String, model_name: String, provider: String },
    Finish { request_index: u32, status: String, measurements: UsageMeasurements },
}

async fn record(State(state): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap, Json(input): Json<Input>) -> Result<Json<Value>> {
    let agent = state.agent.as_ref().ok_or(DomainError::Forbidden)?;
    agent.authenticate_service(headers.get("x-agent-service").and_then(|h| h.to_str().ok()).unwrap_or(""))?;
    let token = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok())
        .and_then(tomorrow_domain::auth::bearer_token).ok_or(DomainError::Unauthorized)?;
    match input {
        Input::Dispatch { request_index, deployment, model, model_name, provider } => {
            if deployment.len() > 4096 || model.len() > 240 || model_name.len() > 240 || provider.len() > 240 {
                return Err(DomainError::Validation("无效的模型用量标识".into()).into());
            }
            state.repository.dispatch_agent_usage(&id, token, request_index,
                UsageIdentity::new(&deployment, &model, &model_name, &provider)).await?;
        }
        Input::Finish { request_index, status, measurements } => {
            state.repository.finish_agent_usage(&id, token, request_index, UsageOutcome::new(status, measurements)).await?;
        }
    }
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_cannot_supply_an_owner_or_change_finish_identity() {
        assert!(serde_json::from_value::<Input>(json!({"kind":"dispatch","request_index":1,"deployment":"https://fixture.invalid/v1","model":"fixture","model_name":"fixture","provider":"fixture","user_id":"other"})).is_err());
        assert!(serde_json::from_value::<Input>(json!({"kind":"finish","request_index":1,"status":"succeeded","measurements":{},"model":"other"})).is_err());
        assert!(serde_json::from_value::<Input>(json!({"kind":"dispatch","request_index":1,"deployment":"https://fixture.invalid/v1","model":"fixture","model_name":"fixture","provider":"fixture","purpose":"chat"})).is_err());
    }
}
