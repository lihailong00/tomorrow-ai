//! Text-only embeddings. Model calls are gated by consent and durable admission.
use super::*;
use futures_util::TryStreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

const DIMENSION: usize = 1024;
const WINDOW: i64 = 86_400;
pub(crate) struct Config {
    pub endpoint: String,
    pub key: String,
    pub model: String,
    pub dimension: usize,
}
pub(crate) struct Runtime {
    pub config: Option<Config>,
    pub postgres_vector: bool,
    pub active: Semaphore,
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn source_hash(results: &[Derived]) -> String {
    let mut ordered = results.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|r| &r.kind);
    hash(
        serde_json::to_string(&ordered)
            .expect("derived strings serialize")
            .as_bytes(),
    )
}

fn from_env() -> Result<Option<Config>, AttachmentError> {
    config_from(|name| std::env::var(name).ok())
}

fn config_from(get: impl Fn(&str) -> Option<String>) -> Result<Option<Config>, AttachmentError> {
    if get("PHOTO_EMBEDDING_ENABLED").is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "disabled"
        )
    }) {
        return Ok(None);
    }
    let mut base = get("PHOTO_EMBEDDING_BASE_URL").unwrap_or_default();
    let mut key = get("PHOTO_EMBEDDING_API_KEY").unwrap_or_default();
    // Reuse an already configured official Qwen ASR credential only for its own
    // exact HTTPS origin. Never forward that credential to a custom endpoint.
    if base.trim().is_empty() && get("ASR_PROTOCOL").as_deref() == Some("qwen_asr") {
        let asr_base = get("ASR_BASE_URL").unwrap_or_default();
        if let Ok(url) = reqwest::Url::parse(asr_base.trim()) {
            let official = url.host_str().is_some_and(|h| {
                ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].contains(&h)
                    || h.ends_with(".cn-beijing.maas.aliyuncs.com")
                    || h.ends_with(".ap-southeast-1.maas.aliyuncs.com")
            });
            if official
                && url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path().trim_end_matches('/') == "/compatible-mode/v1"
            {
                base = asr_base;
                if key.is_empty() {
                    key = get("ASR_API_KEY").unwrap_or_default();
                }
            }
        }
    }
    if base.trim().is_empty() {
        return Ok(None);
    }
    let url = reqwest::Url::parse(base.trim()).map_err(|_| invalid())?;
    let local = url.host_str().is_some_and(|h| {
        h == "localhost"
            || h.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if key.trim().is_empty() {
        return Ok(None);
    }
    let model = get("PHOTO_EMBEDDING_MODEL").unwrap_or_else(|| "text-embedding-v4".into());
    if model.is_empty() || model.len() > 120 {
        return Err(invalid());
    }
    Ok(Some(Config {
        endpoint: format!("{}/embeddings", base.trim().trim_end_matches('/')),
        key,
        model,
        dimension: DIMENSION,
    }))
}

#[cfg(test)]
mod config_tests {
    use super::*;
    #[test]
    fn reuses_only_an_official_asr_origin_and_can_be_disabled() {
        let lookup = |base: &str, disabled: bool| {
            config_from(|name| match name {
                "ASR_PROTOCOL" => Some("qwen_asr".into()),
                "ASR_BASE_URL" => Some(base.into()),
                "ASR_API_KEY" => Some("test-key".into()),
                "PHOTO_EMBEDDING_ENABLED" if disabled => Some("false".into()),
                _ => None,
            })
        };
        let enabled = lookup("https://dashscope.aliyuncs.com/compatible-mode/v1", false)
            .unwrap()
            .unwrap();
        assert_eq!(
            enabled.endpoint,
            "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
        );
        assert!(
            lookup(
                "https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1",
                false
            )
            .unwrap()
            .is_none()
        );
        assert!(
            lookup("https://dashscope.aliyuncs.com/compatible-mode/v1", true)
                .unwrap()
                .is_none()
        );
        let explicit = config_from(|name| match name {
            "PHOTO_EMBEDDING_BASE_URL" => Some("https://custom.test/v1".into()),
            "ASR_API_KEY" => Some("must-not-forward".into()),
            _ => None,
        })
        .unwrap();
        assert!(explicit.is_none());
    }
}

pub(super) async fn initialize(pool: &AnyPool) -> Result<Runtime, AttachmentError> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS photo_index_facts(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,revision TEXT NOT NULL,source_hash TEXT NOT NULL,processor TEXT NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id))",
        "CREATE TABLE IF NOT EXISTS photo_index_vectors(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,revision TEXT NOT NULL,input_hash TEXT NOT NULL,model TEXT NOT NULL,dimension BIGINT NOT NULL,vector_data TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id))",
        "CREATE TABLE IF NOT EXISTS photo_embedding_guard(id BIGINT PRIMARY KEY,singleton BIGINT NOT NULL)",
        "INSERT INTO photo_embedding_guard(id,singleton)VALUES(1,0)ON CONFLICT(id)DO NOTHING",
        "CREATE TABLE IF NOT EXISTS photo_embedding_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,requested_at BIGINT NOT NULL,units BIGINT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS photo_embedding_attempts_time ON photo_embedding_attempts(requested_at)",
        "CREATE TABLE IF NOT EXISTS photo_embedding_jobs(user_id TEXT NOT NULL,device_id TEXT NOT NULL,job_id TEXT NOT NULL,requested_at BIGINT NOT NULL,PRIMARY KEY(user_id,device_id,job_id))",
        "CREATE TABLE IF NOT EXISTS photo_embedding_queries(user_id TEXT NOT NULL,device_id TEXT NOT NULL,query_hash TEXT NOT NULL,model TEXT NOT NULL,vector_data TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(user_id,device_id,query_hash,model))",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    let pg = {
        let connection = pool.acquire().await?;
        connection.backend_name() == "PostgreSQL"
    };
    let vector = if pg {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_extension WHERE extname='vector'")
            .fetch_one(pool)
            .await?;
        if n > 0 {
            sqlx::query(
                "ALTER TABLE photo_index_vectors ADD COLUMN IF NOT EXISTS embedding vector",
            )
            .execute(pool)
            .await?;
            true
        } else {
            false
        }
    } else {
        false
    };
    Ok(Runtime {
        config: from_env()?,
        postgres_vector: vector,
        active: Semaphore::new(2),
    })
}

pub(super) async fn ensure_facts(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    asset: &str,
    epoch: i64,
) -> Result<(), AttachmentError> {
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, user, device, epoch).await?;
    let revision: Option<String> = sqlx::query_scalar(
        "SELECT revision FROM photo_index_assets WHERE user_id=$1 AND device_id=$2 AND asset_id=$3",
    )
    .bind(user)
    .bind(device)
    .bind(asset)
    .fetch_optional(&mut *tx)
    .await?;
    let revision = revision.ok_or_else(AttachmentError::not_found)?;
    let rows=sqlx::query("SELECT kind,processor,content FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 ORDER BY kind").bind(user).bind(device).bind(asset).fetch_all(&mut *tx).await?;
    let results = rows
        .into_iter()
        .map(|r| {
            Ok(Derived {
                kind: r.try_get("kind")?,
                processor: r.try_get("processor")?,
                content: r.try_get("content")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    write_facts(&mut tx, user, device, asset, &revision, &results).await?;
    tx.commit().await?;
    Ok(())
}

pub(super) async fn write_facts(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user: &str,
    device: &str,
    asset: &str,
    revision: &str,
    results: &[Derived],
) -> Result<(), AttachmentError> {
    let text = results
        .iter()
        .find(|r| r.kind == "ocr")
        .map(|r| r.content.as_str())
        .unwrap_or("");
    let facts = serde_json::to_string(&facts::extract(text)).map_err(|_| invalid())?;
    let fingerprint = source_hash(results);
    sqlx::query("INSERT INTO photo_index_facts(user_id,device_id,asset_id,revision,source_hash,processor,facts)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(user_id,device_id,asset_id)DO UPDATE SET revision=$4,source_hash=$5,processor=$6,facts=$7")
        .bind(user).bind(device).bind(asset).bind(revision).bind(&fingerprint).bind(facts::PROCESSOR).bind(facts).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM photo_index_vectors WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 AND (revision<>$4 OR input_hash<>$5)")
        .bind(user).bind(device).bind(asset).bind(revision).bind(fingerprint).execute(&mut **tx).await?;
    Ok(())
}

/// Failed calls retain quota. Byte units conservatively bound submitted text size.
async fn reserve(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    epoch: i64,
    job: &str,
    units: i64,
) -> Result<bool, AttachmentError> {
    // Keep a small reserve for interactive searches after indexing reaches its cap.
    let query_job = job.starts_with("query:");
    let now = chrono::Utc::now().timestamp();
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, user, device, epoch).await?;
    if sqlx::query("UPDATE photo_embedding_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?
        .rows_affected()
        != 1
    {
        return Err(AttachmentError::internal());
    }
    let recent:Option<i64>=sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM photo_embedding_jobs WHERE user_id=$1 AND device_id=$2 AND job_id=$3")
        .bind(user).bind(device).bind(job).fetch_optional(&mut *tx).await?;
    if recent.is_some_and(|t| t > now - 60) {
        return Ok(false);
    }
    sqlx::query("DELETE FROM photo_embedding_attempts WHERE requested_at<=$1")
        .bind(now - WINDOW)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM photo_embedding_jobs WHERE requested_at<=$1")
        .bind(now - WINDOW)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM photo_embedding_queries WHERE created_at<=$1")
        .bind(now - WINDOW)
        .execute(&mut *tx)
        .await?;
    for scope in [None, Some(user)] {
        let (count, total): (i64, i64) = if let Some(u) = scope {
            let r=sqlx::query("SELECT count(*) AS n,CAST(COALESCE(SUM(units),0) AS BIGINT) AS units FROM photo_embedding_attempts WHERE user_id=$1").bind(u).fetch_one(&mut *tx).await?;
            (r.try_get("n")?, r.try_get("units")?)
        } else {
            let r=sqlx::query("SELECT count(*) AS n,CAST(COALESCE(SUM(units),0) AS BIGINT) AS units FROM photo_embedding_attempts").fetch_one(&mut *tx).await?;
            (r.try_get("n")?, r.try_get("units")?)
        };
        let call_limit = match (scope.is_some(), query_job) {
            (true, true) => 120,
            (true, false) => 100,
            (false, true) => 240,
            (false, false) => 200,
        };
        let unit_limit = match (scope.is_some(), query_job) {
            (true, true) => 120_000,
            (true, false) => 100_000,
            (false, true) => 300_000,
            (false, false) => 250_000,
        };
        if count >= call_limit || total + units > unit_limit {
            return Ok(false);
        }
    }
    sqlx::query(
        "INSERT INTO photo_embedding_attempts(id,user_id,requested_at,units)VALUES($1,$2,$3,$4)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(user)
    .bind(now)
    .bind(units)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO photo_embedding_jobs(user_id,device_id,job_id,requested_at)VALUES($1,$2,$3,$4)ON CONFLICT(user_id,device_id,job_id)DO UPDATE SET requested_at=$4")
        .bind(user).bind(device).bind(job).bind(now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

fn valid_vector(mut vector: Vec<f64>, dimension: usize) -> Result<Vec<f64>, AttachmentError> {
    if vector.len() != dimension || vector.iter().any(|x| !x.is_finite() || x.abs() > 1e6) {
        return Err(unavailable());
    }
    let norm = vector.iter().map(|x| x * x).sum::<f64>().sqrt();
    if !norm.is_finite() || norm < 1e-12 {
        return Err(unavailable());
    }
    for x in &mut vector {
        *x /= norm;
    }
    Ok(vector)
}
fn unavailable() -> AttachmentError {
    AttachmentError::new(
        StatusCode::BAD_GATEWAY,
        "photo_semantic_unavailable",
        "语义搜索暂不可用，可以改用文字匹配",
    )
}
pub(super) async fn embed(
    state: &AttachmentsState,
    config: &Config,
    text: &str,
) -> Result<Vec<f64>, AttachmentError> {
    let mut response=state.client.post(&config.endpoint).bearer_auth(&config.key).timeout(Duration::from_secs(12))
        .json(&json!({"model":config.model,"input":[text],"dimensions":config.dimension,"encoding_format":"float"})).send().await.map_err(|_|unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if data["data"].as_array().map(Vec::len) != Some(1) || data["data"][0]["index"] != 0 {
        return Err(unavailable());
    }
    let vector: Vec<f64> =
        serde_json::from_value(data["data"][0]["embedding"].clone()).map_err(|_| unavailable())?;
    valid_vector(vector, config.dimension)
}

pub(super) async fn prepare(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    epoch: i64,
) -> Result<serde_json::Value, AttachmentError> {
    let config = state.photo_index.config.as_ref();
    let model = config.map(|c| c.model.as_str()).unwrap_or("");
    let dimension = config.map(|c| c.dimension as i64).unwrap_or(0);
    let candidate:Option<String>=sqlx::query_scalar("SELECT a.asset_id FROM photo_index_assets a WHERE a.user_id=$1 AND a.device_id=$2 AND (NOT EXISTS(SELECT 1 FROM photo_index_facts f WHERE f.user_id=a.user_id AND f.device_id=a.device_id AND f.asset_id=a.asset_id AND f.revision=a.revision AND f.processor=$3) OR ($4<>'' AND NOT EXISTS(SELECT 1 FROM photo_index_vectors v WHERE v.user_id=a.user_id AND v.device_id=a.device_id AND v.asset_id=a.asset_id AND v.revision=a.revision AND v.model=$4 AND v.dimension=$5))) ORDER BY a.updated_at,a.asset_id LIMIT 1")
        .bind(user).bind(device).bind(facts::PROCESSOR).bind(model).bind(dimension).fetch_optional(&state.pool).await?;
    let Some(asset) = candidate else {
        return Ok(json!({"processed":false,"more":false,"semantic_configured":config.is_some()}));
    };
    ensure_facts(state, user, device, &asset, epoch).await?;
    let Some(config) = config else {
        return Ok(json!({"processed":true,"more":true,"semantic_configured":false}));
    };
    let Ok(_permit) = state.photo_index.active.try_acquire() else {
        return Ok(json!({"processed":false,"more":true,"deferred":true}));
    };
    let source=sqlx::query("SELECT revision,source_hash FROM photo_index_facts WHERE user_id=$1 AND device_id=$2 AND asset_id=$3").bind(user).bind(device).bind(&asset).fetch_one(&state.pool).await?;
    let revision: String = source.try_get("revision")?;
    let fingerprint: String = source.try_get("source_hash")?;
    let rows=sqlx::query("SELECT kind,content FROM photo_index_results WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 ORDER BY CASE kind WHEN 'description' THEN 0 WHEN 'labels' THEN 1 ELSE 2 END")
        .bind(user).bind(device).bind(&asset).fetch_all(&state.pool).await?;
    let mut text = String::from("图片中记录的内容：\n");
    for row in rows {
        text.push_str(&row.try_get::<String, _>("content")?);
        text.push('\n');
    }
    while text.len() > 6000 {
        text.pop();
    }
    let job = format!("{asset}:{fingerprint}:{}", config.model);
    if !reserve(state, user, device, epoch, &job, text.len() as i64 + 128).await? {
        return Ok(json!({"processed":false,"more":true,"deferred":true}));
    }
    let vector = embed(state, config, &text).await?;
    let encoded = serde_json::to_string(&vector).map_err(|_| unavailable())?;
    let mut tx = state.pool.begin().await?;
    lock_consent(&mut tx, user, device, epoch).await?;
    let current:Option<String>=sqlx::query_scalar("SELECT source_hash FROM photo_index_facts WHERE user_id=$1 AND device_id=$2 AND asset_id=$3 AND revision=$4").bind(user).bind(device).bind(&asset).bind(&revision).fetch_optional(&mut *tx).await?;
    if current.as_deref() != Some(&fingerprint) {
        return Ok(json!({"processed":false,"more":true,"stale":true}));
    }
    sqlx::query("INSERT INTO photo_index_vectors(user_id,device_id,asset_id,revision,input_hash,model,dimension,vector_data)VALUES($1,$2,$3,$4,$5,$6,$7,$8)ON CONFLICT(user_id,device_id,asset_id)DO UPDATE SET revision=$4,input_hash=$5,model=$6,dimension=$7,vector_data=$8")
        .bind(user).bind(device).bind(&asset).bind(revision).bind(fingerprint).bind(&config.model).bind(config.dimension as i64).bind(&encoded).execute(&mut *tx).await?;
    if state.photo_index.postgres_vector {
        sqlx::query("UPDATE photo_index_vectors SET embedding=CAST($1 AS vector) WHERE user_id=$2 AND device_id=$3 AND asset_id=$4").bind(encoded).bind(user).bind(device).bind(asset).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(json!({"processed":true,"more":true,"semantic_configured":true}))
}

pub(super) async fn search(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    epoch: i64,
    query: &str,
) -> Result<Option<Vec<(String, f64)>>, AttachmentError> {
    let Some(config) = state.photo_index.config.as_ref() else {
        return Ok(None);
    };
    let now = chrono::Utc::now().timestamp();
    let key = hash(query.as_bytes());
    let cached:Option<String>=sqlx::query_scalar("SELECT vector_data FROM photo_embedding_queries WHERE user_id=$1 AND device_id=$2 AND query_hash=$3 AND model=$4 AND created_at>$5")
        .bind(user).bind(device).bind(&key).bind(&config.model).bind(now-WINDOW).fetch_optional(&state.pool).await?;
    let vector = if let Some(cache) = cached {
        valid_vector(
            serde_json::from_str(&cache).map_err(|_| unavailable())?,
            config.dimension,
        )?
    } else {
        let Ok(_permit) = state.photo_index.active.try_acquire() else {
            return Ok(None);
        };
        if !reserve(
            state,
            user,
            device,
            epoch,
            &format!("query:{key}:{}", config.model),
            query.len() as i64 + 128,
        )
        .await?
        {
            return Ok(None);
        }
        let vector = embed(state, config, query).await?;
        let mut tx = state.pool.begin().await?;
        lock_consent(&mut tx, user, device, epoch).await?;
        sqlx::query("INSERT INTO photo_embedding_queries(user_id,device_id,query_hash,model,vector_data,created_at)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(user_id,device_id,query_hash,model)DO UPDATE SET vector_data=$5,created_at=$6")
            .bind(user).bind(device).bind(&key).bind(&config.model).bind(serde_json::to_string(&vector).map_err(|_|unavailable())?).bind(now).execute(&mut *tx).await?;
        tx.commit().await?;
        vector
    };
    if state.photo_index.postgres_vector {
        let rows=sqlx::query("SELECT v.asset_id,CAST(1-(v.embedding <=> CAST($1 AS vector)) AS DOUBLE PRECISION) AS score FROM photo_index_vectors v JOIN photo_index_assets a ON a.user_id=v.user_id AND a.device_id=v.device_id AND a.asset_id=v.asset_id AND a.revision=v.revision WHERE v.user_id=$2 AND v.device_id=$3 AND v.model=$4 AND v.dimension=$5 AND v.embedding IS NOT NULL ORDER BY v.embedding <=> CAST($1 AS vector),v.asset_id LIMIT 100")
            .bind(serde_json::to_string(&vector).map_err(|_|unavailable())?).bind(user).bind(device).bind(&config.model).bind(config.dimension as i64).fetch_all(&state.pool).await?;
        return Ok(Some(
            rows.into_iter()
                .map(|r| Ok((r.try_get("asset_id")?, r.try_get("score")?)))
                .collect::<Result<Vec<_>, sqlx::Error>>()?,
        ));
    }
    // Portable exact search for local SQLite and PostgreSQL without the extension.
    let mut stream=sqlx::query("SELECT v.asset_id,v.vector_data FROM photo_index_vectors v JOIN photo_index_assets a ON a.user_id=v.user_id AND a.device_id=v.device_id AND a.asset_id=v.asset_id AND a.revision=v.revision WHERE v.user_id=$1 AND v.device_id=$2 AND v.model=$3 AND v.dimension=$4")
        .bind(user).bind(device).bind(&config.model).bind(config.dimension as i64).fetch(&state.pool);
    let mut ranked = Vec::new();
    while let Some(row) = stream.try_next().await? {
        let stored: Vec<f64> = serde_json::from_str(&row.try_get::<String, _>("vector_data")?)
            .map_err(|_| unavailable())?;
        let stored = valid_vector(stored, config.dimension)?;
        ranked.push((
            row.try_get::<String, _>("asset_id")?,
            stored.iter().zip(&vector).map(|(a, b)| a * b).sum::<f64>(),
        ));
        if ranked.len() > 200 {
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            ranked.truncate(100);
        }
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.truncate(100);
    Ok(Some(ranked))
}
