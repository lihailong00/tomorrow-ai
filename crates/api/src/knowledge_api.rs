use super::{AppState, Auth, Result};
use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tomorrow_domain::knowledge::{GraphIndexInput, GraphSearch};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/knowledge-graph/index", post(index))
        .route("/knowledge-graph/search", get(search))
        .route("/knowledge-graph/memories/{id}", delete(remove))
}

#[utoipa::path(post,path="/v1/knowledge-graph/index",request_body=GraphIndexInput,responses((status=200,description="Index a saved memory using source-backed entity and relation extraction")))]
pub async fn index(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Json(input): Json<GraphIndexInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        state
            .repository
            .index_memory_graph(&auth.user_id, input)
            .await?,
    ))
}

#[utoipa::path(get,path="/v1/knowledge-graph/search",params(("query"=Option<String>,Query),("scope"=Option<String>,Query),("entity_id"=Option<String>,Query),("from"=Option<String>,Query),("before"=Option<String>,Query),("limit"=Option<usize>,Query)),responses((status=200,description="Source-backed lexical search plus one-hop graph expansion")))]
pub async fn search(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Query(input): Query<GraphSearch>,
) -> Result<Json<Value>> {
    Ok(Json(
        state
            .repository
            .search_knowledge_graph(&auth.user_id, input)
            .await?,
    ))
}

#[utoipa::path(delete,path="/v1/knowledge-graph/memories/{id}",params(("id"=String,Path)),responses((status=200,description="Remove derived graph for an owned memory without deleting the memory")))]
pub async fn remove(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    state
        .repository
        .delete_memory_graph(&auth.user_id, &id)
        .await?;
    Ok(Json(json!({"ok":true})))
}
