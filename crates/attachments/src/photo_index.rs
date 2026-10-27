//! Opt-in, user/device-scoped derived photo data. No image bytes or local URIs.
use super::*;
use axum::extract::Query;
use serde_json::json;
mod facts;
mod semantic;
pub(super) use semantic::Runtime;
#[cfg(test)]
mod tests;

pub(super) async fn initialize(pool: &AnyPool) -> Result<Runtime, AttachmentError> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS photo_index_devices(user_id TEXT NOT NULL,device_id TEXT NOT NULL,enabled BIGINT NOT NULL DEFAULT 0,epoch BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(user_id,device_id))",
        "CREATE TABLE IF NOT EXISTS photo_index_assets(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,revision TEXT NOT NULL,metadata TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id))",
        "CREATE TABLE IF NOT EXISTS photo_index_results(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,kind TEXT NOT NULL,processor TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id,kind))",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    semantic::initialize(pool).await
}

pub(super) fn router(state: AttachmentsState) -> Router {
    Router::new()
        .route(
            "/v1/photo-index/devices/{device}",
            get(status).put(consent).delete(clear),
        )
        .route("/v1/photo-index/devices/{device}/assets", get(list))
        .route("/v1/photo-index/devices/{device}/prepare", post(prepare))
        .route(
            "/v1/photo-index/devices/{device}/assets/{asset}",
            axum::routing::put(sync).delete(remove),
        )
        .layer(DefaultBodyLimit::max(96 * 1024))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Consent {
    enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    taken_at: Option<i64>,
    modified_at: i64,
    width: Option<i64>,
    height: Option<i64>,
    size: i64,
    mime_type: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Derived {
    kind: String,
    processor: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sync {
    epoch: i64,
    revision: String,
    metadata: Metadata,
    results: Vec<Derived>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    q: Option<String>,
    offset: Option<i64>,
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    epoch: i64,
}

fn invalid() -> AttachmentError {
    AttachmentError::new(
        StatusCode::BAD_REQUEST,
        "invalid_photo_index",
        "图片索引格式无效",
    )
}
fn uuid(value: &str) -> Result<(), AttachmentError> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| invalid())
}

async fn status(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(device): Path<String>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    let user = state.user(&headers).await?;
    status_for(&state, &user, &device).await
}

async fn status_for(
    state: &AttachmentsState,
    user: &str,
    device: &str,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    let row=sqlx::query("SELECT CAST(enabled AS BIGINT) AS enabled,CAST(epoch AS BIGINT) AS epoch FROM photo_index_devices WHERE user_id=$1 AND device_id=$2")
        .bind(user).bind(device).fetch_optional(&state.pool).await?;
    let (enabled, epoch) = match row {
        Some(r) => (
            r.try_get::<i64, _>("enabled")? == 1,
            r.try_get::<i64, _>("epoch")?,
        ),
        None => (false, 0),
    };
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM photo_index_assets WHERE user_id=$1 AND device_id=$2",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&state.pool)
    .await?;
    let facts_ready:i64=sqlx::query_scalar("SELECT count(*) FROM photo_index_facts f JOIN photo_index_assets a ON a.user_id=f.user_id AND a.device_id=f.device_id AND a.asset_id=f.asset_id AND a.revision=f.revision WHERE f.user_id=$1 AND f.device_id=$2 AND f.processor=$3")
        .bind(user).bind(device).bind(facts::PROCESSOR).fetch_one(&state.pool).await?;
    let model = state
        .photo_index
        .config
        .as_ref()
        .map(|c| c.model.as_str())
        .unwrap_or("");
    let semantic_ready:i64=sqlx::query_scalar("SELECT count(*) FROM photo_index_vectors v JOIN photo_index_assets a ON a.user_id=v.user_id AND a.device_id=v.device_id AND a.asset_id=v.asset_id AND a.revision=v.revision WHERE v.user_id=$1 AND v.device_id=$2 AND v.model=$3")
        .bind(user).bind(device).bind(model).fetch_one(&state.pool).await?;
    Ok(Json(
        json!({"enabled":enabled,"epoch":epoch,"indexed":count,"facts_ready":facts_ready,"semantic_ready":semantic_ready,"semantic_configured":state.photo_index.config.is_some()}),
    ))
}

async fn consent(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(device): Path<String>,
    Json(input): Json<Consent>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    let user = state.user(&headers).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO photo_index_devices(user_id,device_id)VALUES($1,$2)ON CONFLICT(user_id,device_id)DO NOTHING").bind(&user).bind(&device).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE photo_index_devices SET enabled=$1,epoch=epoch+1 WHERE user_id=$2 AND device_id=$3",
    )
    .bind(if input.enabled { 1_i64 } else { 0 })
    .bind(&user)
    .bind(&device)
    .execute(&mut *tx)
    .await?;
    let epoch: i64 = sqlx::query_scalar(
        "SELECT CAST(epoch AS BIGINT) FROM photo_index_devices WHERE user_id=$1 AND device_id=$2",
    )
    .bind(&user)
    .bind(&device)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    // Return this mutation's epoch, not a later concurrent setting change.
    Ok(Json(json!({"enabled":input.enabled,"epoch":epoch})))
}

async fn lock_consent(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user: &str,
    device: &str,
    epoch: i64,
) -> Result<(), AttachmentError> {
    if epoch<1 || sqlx::query("UPDATE photo_index_devices SET epoch=epoch WHERE user_id=$1 AND device_id=$2 AND enabled=1 AND epoch=$3")
        .bind(user).bind(device).bind(epoch).execute(&mut **tx).await?.rows_affected()!=1 {
        return Err(AttachmentError::new(StatusCode::CONFLICT,"photo_index_disabled","相册索引未开启或授权已更新，请重新开启后再同步"));
    }
    Ok(())
}

async fn sync(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path((device, asset)): Path<(String, String)>,
    Json(input): Json<Sync>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    uuid(&asset)?;
    let user = state.user(&headers).await?;
    let m = &input.metadata;
    if input.revision.is_empty()
        || input.revision.len() > 128
        || m.width.is_some_and(|n| !(1..=100_000).contains(&n))
        || m.height.is_some_and(|n| !(1..=100_000).contains(&n))
        || m.size < 0
        || m.modified_at < 0
        || m.taken_at.is_some_and(|t| t < 0)
        || ![
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/heic",
            "image/heif",
            "image/avif",
            "image/gif",
            "image/bmp",
        ]
        .contains(&m.mime_type.as_str())
        || input.results.is_empty()
        || input.results.len() > 3
    {
        return Err(invalid());
    }
    let mut kinds = std::collections::HashSet::new();
    for result in &input.results {
        if !["ocr", "labels", "description"].contains(&result.kind.as_str())
            || !kinds.insert(&result.kind)
            || result.processor.is_empty()
            || result.processor.len() > 128
            || result.content.len() > 64_000
        {
            return Err(invalid());
        }
    }
    let metadata = serde_json::to_string(m).map_err(|_| invalid())?;
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, &user, &device, input.epoch).await?;
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT revision FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
    )
    .bind(&user)
    .bind(&device)
    .bind(&asset)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_none() {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM photo_index_assets WHERE user_id=$1 AND device_id=$2",
        )
        .bind(&user)
        .bind(&device)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 50_000 {
            return Err(AttachmentError::new(
                StatusCode::CONFLICT,
                "photo_index_full",
                "当前设备的图片索引已达上限",
            ));
        }
    }
    sqlx::query("INSERT INTO photo_index_assets(user_id,device_id,asset_id,revision,metadata,updated_at)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(user_id,device_id,asset_id)DO UPDATE SET revision=$4,metadata=$5,updated_at=$6")
        .bind(&user).bind(&device).bind(&asset).bind(&input.revision).bind(metadata).bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    sqlx::query(
        "DELETE FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
    )
    .bind(&user)
    .bind(&device)
    .bind(&asset)
    .execute(&mut *tx)
    .await?;
    semantic::write_facts(
        &mut tx,
        &user,
        &device,
        &asset,
        &input.revision,
        &input.results,
    )
    .await?;
    for result in input.results {
        sqlx::query("INSERT INTO photo_index_results(user_id,device_id,asset_id,kind,processor,content)VALUES($1,$2,$3,$4,$5,$6)")
            .bind(&user).bind(&device).bind(&asset).bind(result.kind).bind(result.processor).bind(result.content).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"ok":true,"asset_id":asset,"facts_prepared":true,"semantic_pending":state.photo_index.config.is_some()}),
    ))
}

async fn current_epoch(
    state: &AttachmentsState,
    user: &str,
    device: &str,
) -> Result<Option<i64>, AttachmentError> {
    Ok(sqlx::query_scalar("SELECT CAST(epoch AS BIGINT) FROM photo_index_devices WHERE user_id=$1 AND device_id=$2 AND enabled=1").bind(user).bind(device).fetch_optional(&state.pool).await?)
}

async fn prepare(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(device): Path<String>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    let user = state.user(&headers).await?;
    let epoch = current_epoch(&state, &user, &device)
        .await?
        .ok_or_else(|| {
            AttachmentError::new(
                StatusCode::CONFLICT,
                "photo_index_disabled",
                "请先在设置中开启相册索引",
            )
        })?;
    Ok(Json(
        semantic::prepare(&state, &user, &device, epoch).await?,
    ))
}

async fn asset_json(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    id: &str,
) -> Result<Option<serde_json::Value>, AttachmentError> {
    let row=sqlx::query("SELECT revision,metadata,updated_at FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 AND asset_id=$3").bind(user).bind(device).bind(id).fetch_optional(&state.pool).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let results=sqlx::query("SELECT kind,processor,content FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 ORDER BY kind").bind(user).bind(device).bind(id).fetch_all(&state.pool).await?;
    let derived=results.into_iter().map(|r|Ok(json!({"kind":r.try_get::<String,_>("kind")?,"processor":r.try_get::<String,_>("processor")?,"content":r.try_get::<String,_>("content")?}))).collect::<Result<Vec<_>,sqlx::Error>>()?;
    let facts=sqlx::query("SELECT facts,processor FROM photo_index_facts WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 AND revision=$4").bind(user).bind(device).bind(id).bind(row.try_get::<String,_>("revision")?).fetch_optional(&state.pool).await?;
    let (extracted, processor) = if let Some(f) = facts {
        (
            serde_json::from_str::<serde_json::Value>(&f.try_get::<String, _>("facts")?)
                .map_err(|_| AttachmentError::internal())?,
            Some(f.try_get::<String, _>("processor")?),
        )
    } else {
        (json!([]), None)
    };
    Ok(Some(
        json!({"asset_id":id,"revision":row.try_get::<String,_>("revision")?,"metadata":serde_json::from_str::<serde_json::Value>(&row.try_get::<String,_>("metadata")?).map_err(|_|AttachmentError::internal())?,"updated_at":row.try_get::<String,_>("updated_at")?,"results":derived,"facts":extracted,"facts_processor":processor}),
    ))
}

async fn list(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(device): Path<String>,
    Query(search): Query<Search>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    let user = state.user(&headers).await?;
    let q = search.q.unwrap_or_default().trim().to_owned();
    let offset = search.offset.unwrap_or(0);
    let mode = search.mode.as_deref().unwrap_or("hybrid");
    if q.chars().count() > 200
        || !(0..=50_000).contains(&offset)
        || !["hybrid", "keyword"].contains(&mode)
    {
        return Err(invalid());
    }
    let pattern = format!(
        "%{}%",
        q.to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let hybrid = mode == "hybrid" && !q.is_empty();
    let literal:Vec<String>=sqlx::query_scalar("SELECT a.asset_id FROM photo_index_assets a WHERE a.user_id=$1 AND a.device_id=$2 AND ($3='' OR EXISTS(SELECT 1 FROM photo_index_results r WHERE r.user_id=a.user_id AND r.device_id=a.device_id AND r.asset_id=a.asset_id AND LOWER(r.content) LIKE $4 ESCAPE '\\')) ORDER BY a.updated_at DESC,a.asset_id LIMIT $5 OFFSET $6")
        .bind(&user).bind(&device).bind(&q).bind(pattern).bind(if hybrid{100_i64}else{20}).bind(if hybrid{0}else{offset}).fetch_all(&state.pool).await?;
    let mut fallback = None;
    let mut used_semantic = false;
    let ids = if hybrid {
        let mut ranked = std::collections::HashMap::<String, f64>::new();
        for (n, id) in literal.iter().enumerate() {
            ranked.insert(id.clone(), 1.0 / (60.0 + n as f64));
        }
        let ready:i64=sqlx::query_scalar("SELECT count(*) FROM photo_index_vectors WHERE user_id=$1 AND device_id=$2 AND model=$3")
            .bind(&user).bind(&device).bind(state.photo_index.config.as_ref().map(|c|c.model.as_str()).unwrap_or("")).fetch_one(&state.pool).await?;
        if let Some(epoch) = current_epoch(&state, &user, &device).await? {
            if ready > 0 {
                match semantic::search(&state, &user, &device, epoch, &q).await {
                    Ok(Some(matches)) => {
                        used_semantic = true;
                        for (n, (id, score)) in matches.into_iter().enumerate() {
                            if score >= 0.30 {
                                *ranked.entry(id).or_default() += 1.0 / (60.0 + n as f64);
                            }
                        }
                    }
                    Ok(None) => fallback = Some("语义搜索暂未就绪，已使用文字匹配"),
                    Err(e) if e.code == "photo_index_disabled" => return Err(e),
                    Err(_) => fallback = Some("语义服务暂不可用，已使用文字匹配"),
                }
            } else {
                fallback = Some("语义索引尚未准备完成，已使用文字匹配");
            }
        } else {
            fallback = Some("相册索引已关闭，已使用文字匹配");
        }
        let mut ranked = ranked.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked
            .into_iter()
            .skip(offset as usize)
            .take(20)
            .map(|(id, _)| id)
            .collect::<Vec<_>>()
    } else {
        literal
    };
    let mut items = Vec::new();
    for id in ids {
        if let Some(item) = asset_json(&state, &user, &device, &id).await? {
            items.push(item);
        }
    }
    Ok(Json(
        json!({"next_offset":if items.len()==20 && (!hybrid||offset+20<100){Some(offset+20)}else{None},"items":items,"search_mode":if used_semantic{"hybrid"}else{"keyword"},"notice":fallback}),
    ))
}

async fn remove(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path((device, asset)): Path<(String, String)>,
    Json(input): Json<Remove>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    uuid(&asset)?;
    let user = state.user(&headers).await?;
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, &user, &device, input.epoch).await?;
    for sql in [
        "DELETE FROM photo_index_vectors WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        "DELETE FROM photo_index_facts WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        "DELETE FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        "DELETE FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
    ] {
        sqlx::query(sql)
            .bind(&user)
            .bind(&device)
            .bind(&asset)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

async fn clear(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(device): Path<String>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    uuid(&device)?;
    let user = state.user(&headers).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO photo_index_devices(user_id,device_id)VALUES($1,$2)ON CONFLICT(user_id,device_id)DO NOTHING").bind(&user).bind(&device).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE photo_index_devices SET enabled=0,epoch=epoch+1 WHERE user_id=$1 AND device_id=$2",
    )
    .bind(&user)
    .bind(&device)
    .execute(&mut *tx)
    .await?;
    for sql in [
        "DELETE FROM photo_index_vectors WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_index_facts WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_embedding_queries WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_embedding_jobs WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_index_results WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_index_assets WHERE user_id=$1 AND device_id=$2",
    ] {
        sqlx::query(sql)
            .bind(&user)
            .bind(&device)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"enabled":false,"indexed":0})))
}
