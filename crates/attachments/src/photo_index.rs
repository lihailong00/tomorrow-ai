//! Opt-in, user/device-scoped photo indices; optional ephemeral cloud vision.
use super::*;
use axum::extract::Query;
use serde_json::json;
mod facts;
mod provider;
pub(super) mod semantic;
pub(super) mod vision;
pub(super) use semantic::Runtime;
#[cfg(test)]
mod tests;

pub(super) async fn initialize(pool: &AnyPool) -> Result<Runtime, AttachmentError> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS photo_index_devices(user_id TEXT NOT NULL,device_id TEXT NOT NULL,enabled BIGINT NOT NULL DEFAULT 0,epoch BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(user_id,device_id))",
        "CREATE TABLE IF NOT EXISTS photo_index_assets(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,revision TEXT NOT NULL,metadata TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id))",
        "CREATE TABLE IF NOT EXISTS photo_index_results(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,kind TEXT NOT NULL,processor TEXT NOT NULL,content TEXT NOT NULL,search_text TEXT,PRIMARY KEY(user_id,device_id,asset_id,kind))",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    initialize_keyword_search(pool).await?;
    semantic::initialize(pool).await
}

async fn initialize_keyword_search(pool: &AnyPool) -> Result<(), AttachmentError> {
    // Attachments use compatible startup schema upgrades on SQLite and Postgres.
    // A second instance may have added the column after our first check.
    let check = "SELECT search_text FROM photo_index_results LIMIT 0";
    if sqlx::query(check).fetch_optional(pool).await.is_err() {
        if let Err(error) = sqlx::query("ALTER TABLE photo_index_results ADD COLUMN search_text TEXT")
            .execute(pool).await
        {
            sqlx::query(check).fetch_optional(pool).await.map_err(|_| error)?;
        }
    }
    sqlx::query("CREATE INDEX IF NOT EXISTS photo_index_asset_order ON photo_index_assets(user_id,device_id,updated_at DESC,asset_id)")
        .execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS photo_index_search_pending ON photo_index_results(user_id,device_id,asset_id,kind) WHERE search_text IS NULL")
        .execute(pool).await?;
    loop {
        // At most 128 source rows and 776 SQL parameters per batch. Commit each
        // batch separately; never retain a stream/connection for the whole index.
        let rows = sqlx::query_as::<_, (String, String, String, String, String)>(
            "SELECT user_id,device_id,asset_id,kind,content FROM photo_index_results WHERE search_text IS NULL ORDER BY user_id,device_id,asset_id,kind LIMIT 128",
        ).fetch_all(pool).await?;
        if rows.is_empty() {
            break;
        }
        backfill_keyword_batch(pool, &rows).await?;
        tokio::task::yield_now().await;
    }
    Ok(())
}

async fn backfill_keyword_batch(
    pool: &AnyPool,
    rows: &[(String, String, String, String, String)],
) -> Result<(), AttachmentError> {
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Ok(());
    };
    // Any's generic QueryBuilder uses '?' placeholders; numbered parameters are
    // accepted by both supported backends. Only fixed parameter counts enter SQL.
    let values = (0..rows.len()).map(|row| {
        let parameters = (1..=6).map(|column| format!("${}", row * 6 + column))
            .collect::<Vec<_>>().join(",");
        format!("({parameters})")
    }).collect::<Vec<_>>().join(",");
    // UPDATE only: a concurrent delete must never resurrect private text.
    // Comparing the source also prevents overwriting a concurrent re-sync.
    // Limit the update's target scan to this sorted batch's primary-key range.
    // Otherwise Postgres can choose to scan every pending row for every batch.
    let bounds = (1..=8).map(|n| format!("${}", rows.len() * 6 + n))
        .collect::<Vec<_>>();
    let lower = bounds[..4].join(",");
    let upper = bounds[4..].join(",");
    let sql = format!("WITH pending(user_id,device_id,asset_id,kind,source,normalized) AS (VALUES {values}) UPDATE photo_index_results AS r SET search_text=p.normalized FROM pending p WHERE r.user_id=p.user_id AND r.device_id=p.device_id AND r.asset_id=p.asset_id AND r.kind=p.kind AND r.content=p.source AND r.search_text IS NULL AND (r.user_id,r.device_id,r.asset_id,r.kind)>=({lower}) AND (r.user_id,r.device_id,r.asset_id,r.kind)<=({upper})");
    let mut query = sqlx::query(&sql);
    for (user, device, asset, kind, content) in rows {
        query = query.bind(user).bind(device).bind(asset).bind(kind)
            .bind(content).bind(content.to_lowercase());
    }
    query = query.bind(&first.0).bind(&first.1).bind(&first.2).bind(&first.3)
        .bind(&last.0).bind(&last.1).bind(&last.2).bind(&last.3);
    query.execute(pool).await?;
    Ok(())
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
        .merge(vision::router())
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Consent {
    enabled: bool,
    #[serde(default)]
    cloud_processing: bool,
    #[serde(default)]
    consent_scope: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
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
    let consent = provider::refresh(state, user, device).await?;
    let enabled = consent.enabled;
    let epoch = consent.epoch;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM photo_index_assets WHERE user_id=$1 AND device_id=$2",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&state.pool)
    .await?;
    let facts_ready:i64=sqlx::query_scalar("SELECT count(*) FROM photo_index_facts f JOIN photo_index_assets a ON a.user_id=f.user_id AND a.device_id=f.device_id AND a.asset_id=f.asset_id AND a.revision=f.revision WHERE f.user_id=$1 AND f.device_id=$2 AND f.processor=$3")
        .bind(user).bind(device).bind(facts::PROCESSOR).fetch_one(&state.pool).await?;
    let semantic_ready = semantic::ready_count(state, user, device, consent.configuration.embedding.as_ref()).await?;
    Ok(Json(
        json!({"enabled":enabled,"epoch":epoch,"cloud_processing":consent.allowed,"consent_required":consent.required,"configuration_paused":consent.required,"consent_reason":consent.reason,"consent_scope":consent.configuration.scope,"configuration_revision":consent.configuration.revision,"processing_destinations":consent.configuration.disclosure(),"vision_configured":consent.configuration.image.is_some(),"indexed":count,"facts_ready":facts_ready,"semantic_ready":semantic_ready,"semantic_configured":consent.configuration.embedding.is_some(),"semantic_allowed":consent.allowed&&consent.configuration.embedding.is_some()}),
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
    let configuration = provider::current(&state).await?;
    if input.enabled && input.cloud_processing && input.consent_scope.as_deref() != Some(configuration.scope.as_str()) {
        return Err(provider::changed());
    }
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
    sqlx::query("DELETE FROM photo_cloud_consents WHERE user_id=$1 AND device_id=$2")
        .bind(&user)
        .bind(&device)
        .execute(&mut *tx)
        .await?;
    if input.enabled && input.cloud_processing {
        sqlx::query("INSERT INTO photo_cloud_consents(user_id,device_id,epoch,provider_scope,invalidated)VALUES($1,$2,$3,$4,0)")
            .bind(&user)
            .bind(&device)
            .bind(epoch)
            .bind(&configuration.scope)
            .execute(&mut *tx)
            .await?;
    }
    for table in ["photo_embedding_jobs", "photo_vision_jobs"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id=$1 AND device_id=$2"))
            .bind(&user).bind(&device).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE photo_vision_task_state SET status='failed' WHERE user_id=$1 AND device_id=$2 AND status='processing'")
        .bind(&user).bind(&device).execute(&mut *tx).await?;
    tx.commit().await?;
    // Return this mutation's epoch, not a later concurrent setting change.
    Ok(Json(
        json!({"enabled":input.enabled,"epoch":epoch,"cloud_processing":input.enabled&&input.cloud_processing,"consent_scope":configuration.scope}),
    ))
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
    persist_sync(&state, &user, &device, &asset, input, None).await
}

fn validate_sync(input: &Sync) -> Result<(), AttachmentError> {
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
    Ok(())
}

async fn persist_sync(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    asset: &str,
    input: Sync,
    vision_hash: Option<(&str, &str, &str)>,
) -> Result<Json<serde_json::Value>, AttachmentError> {
    validate_sync(&input)?;
    let cloud_scope = if vision_hash.is_some() {
        let config = state.photo_vision.config.as_ref().ok_or_else(provider::changed)?;
        Some(provider::authorize(state, user, device, input.epoch, config, true).await?)
    } else {
        provider::refresh(state, user, device).await?;
        None
    };
    let metadata = serde_json::to_string(&input.metadata).map_err(|_| invalid())?;
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, &user, &device, input.epoch).await?;
    if let Some(scope) = cloud_scope.as_deref() {
        vision::lock_cloud_consent(&mut tx, user, device, input.epoch, scope).await?;
    }
    if let Some((_, _, job)) = vision_hash {
        let live:i64=sqlx::query_scalar("SELECT count(*) FROM photo_vision_jobs WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 AND job_id=$4")
            .bind(user).bind(device).bind(asset).bind(job).fetch_one(&mut *tx).await?;
        if live != 1 {
            return Err(AttachmentError::new(
                StatusCode::CONFLICT,
                "photo_job_cancelled",
                "图片处理已取消，请重新同步",
            ));
        }
    }
    // Storage has no per-device record ceiling. Page size and model admission
    // limits are independent of the number of authorized photos we can retain.
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
        let search_text = result.content.to_lowercase();
        sqlx::query("INSERT INTO photo_index_results(user_id,device_id,asset_id,kind,processor,content,search_text)VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(&user).bind(&device).bind(&asset).bind(result.kind).bind(result.processor).bind(result.content).bind(search_text).execute(&mut *tx).await?;
    }
    if let Some((hash, model, job)) = vision_hash {
        sqlx::query("INSERT INTO photo_vision_results(user_id,device_id,asset_id,input_hash,model,revision)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(user_id,device_id,asset_id)DO UPDATE SET input_hash=$4,model=$5,revision=$6")
            .bind(user).bind(device).bind(asset).bind(hash).bind(model).bind(&input.revision).execute(&mut *tx).await?;
        sqlx::query("UPDATE photo_vision_task_state SET status='complete' WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 AND job_id=$4")
            .bind(user).bind(device).bind(asset).bind(job).execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM photo_vision_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        )
        .bind(user)
        .bind(device)
        .bind(asset)
        .execute(&mut *tx)
        .await?;
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
        || offset < 0
        || !["hybrid", "keyword"].contains(&mode)
    {
        return Err(invalid());
    }
    let hybrid = mode == "hybrid" && !q.is_empty();
    let literal = literal_matches(&state, &user, &device, &q,
        if hybrid { 100 } else { 20 }, if hybrid { 0 } else { offset }).await?;
    let mut fallback = None;
    let mut used_semantic = false;
    let ids = if hybrid {
        let mut ranked = std::collections::HashMap::<String, f64>::new();
        for (n, id) in literal.iter().enumerate() {
            ranked.insert(id.clone(), 1.0 / (60.0 + n as f64));
        }
        let consent = provider::refresh(&state, &user, &device).await?;
        let ready = semantic::ready_count(&state, &user, &device, state.photo_index.config.as_ref()).await?;
        if !consent.allowed {
            fallback = Some(if consent.required {"云端处理目标已变化，请重新确认授权；已使用文字匹配"} else {"云端处理已关闭，已使用文字匹配"});
        } else if let Some(epoch) = current_epoch(&state, &user, &device).await? {
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
        json!({"next_offset":if items.len()==20 {offset.checked_add(20).filter(|next| !hybrid || *next < 100)}else{None},"items":items,"search_mode":if used_semantic{"hybrid"}else{"keyword"},"notice":fallback}),
    ))
}

async fn literal_matches(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    query: &str,
    limit: usize,
    offset: i64,
) -> Result<Vec<String>, AttachmentError> {
    if query.is_empty() {
        return Ok(sqlx::query_scalar("SELECT asset_id FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 ORDER BY updated_at DESC,asset_id LIMIT $3 OFFSET $4")
            .bind(user).bind(device).bind(limit as i64).bind(offset).fetch_all(&state.pool).await?);
    }
    // Normalize once when syncing/backfilling, then filter inside the database.
    // Escape LIKE metacharacters so keyword search remains literal on both DBs.
    let escaped = query.to_lowercase().replace('!', "!!").replace('%', "!%")
        .replace('_', "!_");
    let pattern = format!("%{escaped}%");
    // Common keywords can fill a page among the newest 256 photos. Probe this
    // bounded window first, without forcing a full-table scan for every click.
    // We only return early when the whole requested page fits in that window;
    // otherwise the full filtered query below preserves global pagination.
    let needed = offset as usize + limit;
    if needed <= 256 {
        let recent: Vec<String> = sqlx::query_scalar("WITH candidates AS MATERIALIZED(SELECT asset_id,updated_at FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 ORDER BY updated_at DESC,asset_id LIMIT 256) SELECT a.asset_id FROM candidates a WHERE EXISTS(SELECT 1 FROM photo_index_results r WHERE r.user_id=$1 AND r.device_id=$2 AND r.asset_id=a.asset_id AND r.search_text LIKE $3 ESCAPE '!') ORDER BY a.updated_at DESC,a.asset_id LIMIT $4")
            .bind(user).bind(device).bind(&pattern).bind(needed as i64)
            .fetch_all(&state.pool).await?;
        if recent.len() == needed {
            return Ok(recent.into_iter().skip(offset as usize).collect());
        }
    }
    // Filter source rows once before looking up/sorting assets. A correlated
    // EXISTS would perform a random text lookup for every photo on a miss.
    // Only matching IDs are materialized, never the original or normalized OCR.
    Ok(sqlx::query_scalar("WITH matching AS MATERIALIZED(SELECT DISTINCT asset_id FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND search_text LIKE $3 ESCAPE '!') SELECT a.asset_id FROM matching r JOIN photo_index_assets a ON a.user_id=$1 AND a.device_id=$2 AND a.asset_id=r.asset_id ORDER BY a.updated_at DESC,a.asset_id LIMIT $4 OFFSET $5")
        .bind(user).bind(device).bind(pattern).bind(limit as i64).bind(offset)
        .fetch_all(&state.pool).await?)
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
        "DELETE FROM photo_vision_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        "DELETE FROM photo_vision_jobs WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
        "DELETE FROM photo_vision_task_state WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
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
        "DELETE FROM photo_cloud_consents WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_vision_results WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_vision_jobs WHERE user_id=$1 AND device_id=$2",
        "DELETE FROM photo_vision_task_state WHERE user_id=$1 AND device_id=$2",
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
