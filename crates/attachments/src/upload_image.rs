//! Explicit chat-image preparation. It does not enable or access the album index.
use super::*;
use photo_index::{semantic::Config, vision};

const PROTOCOL: &str = "chat-image-vision-v1";
const JOB_SECONDS: i64 = 150;
const WAIT_SECONDS: u64 = 110;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAnalysis {
    pub upload_id: String,
    pub name: String,
    pub text: String,
    pub model: String,
}

pub(super) async fn initialize(pool: &AnyPool) -> Result<(), AttachmentError> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS upload_image_jobs(upload_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,identity TEXT NOT NULL,job_id TEXT NOT NULL,requested_at BIGINT NOT NULL,status TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS upload_image_results(upload_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,identity TEXT NOT NULL,text TEXT NOT NULL,model TEXT NOT NULL)",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    Ok(())
}

pub(super) fn is_image(upload: &Upload) -> bool {
    upload.mime_type.starts_with("image/")
        || FsPath::new(&upload.name)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| {
                ["jpg", "jpeg", "png", "webp", "heic", "heif", "gif"]
                    .contains(&s.to_ascii_lowercase().as_str())
            })
}

fn not_configured() -> AttachmentError {
    AttachmentError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "image_vision_not_configured",
        "服务暂未配置图片理解模型，请在后台的图片理解设置中配置并测试模型",
    )
}
fn changed() -> AttachmentError {
    AttachmentError::new(
        StatusCode::CONFLICT,
        "image_vision_configuration_changed",
        "图片或图片处理服务已变化，请重试分析；图片和输入内容已保留",
    )
}
fn unavailable() -> AttachmentError {
    AttachmentError::new(
        StatusCode::BAD_GATEWAY,
        "image_vision_unavailable",
        "图片分析暂未完成，请稍后重试；图片和输入内容已保留",
    )
}
fn limited(seconds: i64) -> AttachmentError {
    let mut error = AttachmentError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "image_vision_limited",
        "图片分析繁忙或已达今日额度，请稍后重试",
    );
    error.retry_after = Some(seconds.max(1));
    error
}

async fn current_configuration(
    state: &AttachmentsState,
) -> Result<Option<Config>, AttachmentError> {
    if let Some(load) = &state.photo_configuration {
        let (_, values) = load().await.ok_or_else(changed)?;
        return Ok(vision::config_from(|key| values.get(key).cloned()).unwrap_or(None));
    }
    Ok(state.photo_vision.config.clone())
}

/// Resolve settings before acquiring a database transaction (SQLite may have one connection).
async fn authorize(
    state: &AttachmentsState,
    user: &str,
    upload: &str,
    identity: &str,
) -> Result<(), AttachmentError> {
    if current_configuration(state)
        .await?
        .as_ref()
        .map(|c| c.identity(PROTOCOL))
        .as_deref()
        != Some(identity)
    {
        return Err(changed());
    }
    state.metadata(user, upload).await?;
    Ok(())
}

pub(super) async fn cached_text(
    state: &AttachmentsState,
    user: &str,
    upload: &str,
) -> Result<Option<String>, AttachmentError> {
    let text: Option<String> = sqlx::query_scalar(
        "SELECT r.text FROM upload_image_results r JOIN uploads u ON u.id=r.upload_id AND u.user_id=r.user_id WHERE u.id=$1 AND u.user_id=$2")
        .bind(upload).bind(user).fetch_optional(&state.pool).await?;
    if text
        .as_ref()
        .is_some_and(|s| s.len() > MAX_TEXT_BYTES as usize)
    {
        return Err(unavailable());
    }
    Ok(text)
}

async fn cached(
    state: &AttachmentsState,
    user: &str,
    upload: &Upload,
    identity: &str,
) -> Result<Option<ImageAnalysis>, AttachmentError> {
    let row: Option<(String,String)> = sqlx::query_as(
        "SELECT r.text,r.model FROM upload_image_results r JOIN uploads u ON u.id=r.upload_id AND u.user_id=r.user_id WHERE u.id=$1 AND u.user_id=$2 AND r.identity=$3")
        .bind(&upload.id).bind(user).bind(identity).fetch_optional(&state.pool).await?;
    row.map(|(text, model)| {
        if text.len() > MAX_TEXT_BYTES as usize {
            return Err(unavailable());
        }
        Ok(ImageAnalysis {
            upload_id: upload.id.clone(),
            name: upload.name.clone(),
            text,
            model,
        })
    })
    .transpose()
}

async fn pending_job(
    state: &AttachmentsState,
    user: &str,
    upload: &str,
    identity: &str,
) -> Result<Option<String>, AttachmentError> {
    Ok(sqlx::query_scalar(
        "SELECT job_id FROM upload_image_jobs WHERE upload_id=$1 AND user_id=$2 AND identity=$3 AND status='processing' AND requested_at>$4",
    ).bind(upload).bind(user).bind(identity).bind(chrono::Utc::now().timestamp()-JOB_SECONDS)
        .fetch_optional(&state.pool).await?)
}

pub(super) async fn analyze(
    State(state): State<AttachmentsState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ImageAnalysis>, AttachmentError> {
    let user = state.user(&headers).await?;
    Ok(Json(state.analyze_image(&user, &id).await?))
}

impl AttachmentsState {
    pub async fn analyze_image(
        &self,
        user: &str,
        id: &str,
    ) -> Result<ImageAnalysis, AttachmentError> {
        let upload = self.metadata(user, id).await?;
        if !["image/jpeg", "image/png"].contains(&upload.mime_type.as_str()) {
            return Err(AttachmentError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_image_type",
                "图片理解目前支持 JPEG 和 PNG，请转换格式后重试",
            ));
        }
        if upload.size <= 0 || upload.size as usize > vision::MAX_BYTES {
            return Err(AttachmentError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "image_too_large",
                "图片理解上限为 4 MiB，请压缩图片后重试",
            ));
        }
        let config = current_configuration(self)
            .await?
            .ok_or_else(not_configured)?;
        let identity = config.identity(PROTOCOL);
        if let Some(result) = cached(self, user, &upload, &identity).await? {
            return Ok(result);
        }
        if let Some(job) = pending_job(self, user, id, &identity).await? {
            return wait(self, user, &upload, &identity, Some(&job)).await;
        }
        let permit = match self.photo_vision.active.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                // A duplicate can arrive between the first lookup and admission.
                if let Some(job) = pending_job(self, user, id, &identity).await? {
                    return wait(self, user, &upload, &identity, Some(&job)).await;
                }
                return Err(limited(30));
            }
        };
        let image = self.read_bytes(user, id, vision::MAX_BYTES as u64).await?;
        let pixels = vision::validate_image(&image, &upload.mime_type).map_err(|error| {
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE { error } else {
                AttachmentError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_image",
                    "图片无法读取，或尺寸超过 32–8192 像素、总像素 6291456 的范围，请压缩或转换后重试")
            }
        })?;
        authorize(self, user, id, &identity).await?;
        let job = reserve(self, user, &upload, &identity, &config, pixels, image.len()).await?;
        if let Reservation::New(job_id) = &job {
            let state = self.clone();
            let user = user.to_owned();
            let upload = upload.clone();
            let job_id = job_id.clone();
            let identity = identity.clone();
            // Once admitted, inference survives HTTP disconnects. Retried requests join this job.
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) =
                    prepare(&state, &user, &upload, &job_id, &identity, &config, image).await
                {
                    tracing::warn!(
                        code = error.code(),
                        "chat image preparation did not complete"
                    );
                    fail_job(&state, &user, &upload.id, &job_id).await;
                }
            });
        } else {
            drop(image);
            drop(permit);
        }
        wait(self, user, &upload, &identity, job.id()).await
    }
}

enum Reservation {
    Cached,
    Pending(String),
    New(String),
}
impl Reservation {
    fn id(&self) -> Option<&str> {
        match self {
            Self::Cached => None,
            Self::Pending(id) | Self::New(id) => Some(id),
        }
    }
}

async fn reserve(
    state: &AttachmentsState,
    user: &str,
    upload: &Upload,
    identity: &str,
    config: &Config,
    pixels: i64,
    bytes: usize,
) -> Result<Reservation, AttachmentError> {
    let mut tx = state.pool.begin().await?;
    // Share durable quotas with album vision, so either entrypoint cannot evade the total limit.
    sqlx::query("UPDATE photo_vision_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let owned = sqlx::query("UPDATE uploads SET name=name WHERE id=$1 AND user_id=$2")
        .bind(&upload.id)
        .bind(user)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if owned != 1 {
        return Err(AttachmentError::not_found());
    }
    let ready: i64=sqlx::query_scalar("SELECT count(*) FROM upload_image_results WHERE upload_id=$1 AND user_id=$2 AND identity=$3")
        .bind(&upload.id).bind(user).bind(identity).fetch_one(&mut *tx).await?;
    if ready == 1 {
        tx.commit().await?;
        return Ok(Reservation::Cached);
    }
    let now = chrono::Utc::now().timestamp();
    let pending:Option<(String,String,i64,String)>=sqlx::query_as("SELECT identity,job_id,CAST(requested_at AS BIGINT),status FROM upload_image_jobs WHERE upload_id=$1 AND user_id=$2")
        .bind(&upload.id).bind(user).fetch_optional(&mut *tx).await?;
    if let Some((existing, id, at, status)) = pending {
        if status == "processing" && at > now - JOB_SECONDS {
            if existing != identity {
                return Err(changed());
            }
            tx.commit().await?;
            return Ok(Reservation::Pending(id));
        }
    }
    sqlx::query("DELETE FROM photo_vision_attempts WHERE requested_at<=$1")
        .bind(now - 86_400)
        .execute(&mut *tx)
        .await?;
    for scope in [Some(user), None] {
        let (count, budget): (i64, i64) = if let Some(user) = scope {
            sqlx::query_as("SELECT count(*),CAST(coalesce(sum(pixels),0) AS BIGINT) FROM photo_vision_attempts WHERE user_id=$1").bind(user).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_as("SELECT count(*),CAST(coalesce(sum(pixels),0) AS BIGINT) FROM photo_vision_attempts").fetch_one(&mut *tx).await?
        };
        let (calls, allowance) = if scope.is_some() {
            (50, 150_000_000)
        } else {
            (100, 300_000_000)
        };
        if count >= calls || budget + pixels > allowance {
            return Err(limited(3600));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO photo_vision_attempts(id,user_id,requested_at,pixels,bytes,model)VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&id).bind(user).bind(now).bind(pixels).bind(bytes as i64).bind(&config.model).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO upload_image_jobs(upload_id,user_id,identity,job_id,requested_at,status)VALUES($1,$2,$3,$4,$5,'processing')ON CONFLICT(upload_id)DO UPDATE SET identity=$3,job_id=$4,requested_at=$5,status='processing' WHERE upload_image_jobs.user_id=$2")
        .bind(&upload.id).bind(user).bind(identity).bind(&id).bind(now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Reservation::New(id))
}

async fn fail_job(state: &AttachmentsState, user: &str, upload: &str, job: &str) {
    let _=sqlx::query("UPDATE upload_image_jobs SET status='failed' WHERE upload_id=$1 AND user_id=$2 AND job_id=$3 AND status='processing'")
        .bind(upload).bind(user).bind(job).execute(&state.pool).await;
}

async fn wait(
    state: &AttachmentsState,
    user: &str,
    upload: &Upload,
    identity: &str,
    job: Option<&str>,
) -> Result<ImageAnalysis, AttachmentError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(WAIT_SECONDS);
    loop {
        authorize(state, user, &upload.id, identity).await?;
        if let Some(result) = cached(state, user, upload, identity).await? {
            return Ok(result);
        }
        let row:Option<(String,String)>=sqlx::query_as("SELECT job_id,status FROM upload_image_jobs WHERE upload_id=$1 AND user_id=$2 AND identity=$3")
            .bind(&upload.id).bind(user).bind(identity).fetch_optional(&state.pool).await?;
        if row
            .as_ref()
            .is_some_and(|(id, status)| Some(id.as_str()) == job && status == "complete")
        {
            // Completion can commit between the two reads above. Re-read its
            // cache instead of misreporting a successfully finished request.
            return cached(state, user, upload, identity)
                .await?
                .ok_or_else(unavailable);
        }
        if row
            .as_ref()
            .is_none_or(|(id, status)| Some(id.as_str()) != job || status != "processing")
        {
            return Err(unavailable());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AttachmentError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "image_vision_processing",
                "图片仍在分析，稍后重试会继续获取同一次结果",
            ));
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn prepare(
    state: &AttachmentsState,
    user: &str,
    upload: &Upload,
    job: &str,
    identity: &str,
    config: &Config,
    image: Vec<u8>,
) -> Result<(), AttachmentError> {
    let payload = vision::image_payload(config, &upload.mime_type, &image);
    drop(image);
    let client = vision::client_for(&Some(config.clone()))?;
    let mut attempt = 0;
    let response = loop {
        authorize(state, user, &upload.id, identity).await?;
        match client
            .post(&config.endpoint)
            .bearer_auth(&config.key)
            .json(&payload)
            .send()
            .await
        {
            Ok(response) => break response,
            Err(error) if attempt == 0 && error.is_connect() => {
                attempt += 1;
            }
            Err(_) => return Err(unavailable()),
        }
    };
    let result = vision::read_analysis(response)
        .await
        .map_err(|_| unavailable())?;
    let mut text = format!(
        "图片描述：\n{}\n\n图片中的可见文字：\n{}\n\n检索标签：{}",
        result.description,
        result.ocr,
        result.labels.join("、")
    );
    if text.len() > MAX_TEXT_BYTES as usize {
        let suffix = "\n[图片文字较长，已截断；请针对局部图片提问]";
        let mut boundary = MAX_TEXT_BYTES as usize - suffix.len();
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
        text.push_str(suffix);
    }
    authorize(state, user, &upload.id, identity).await?;
    let mut tx = state.pool.begin().await?;
    let owned = sqlx::query("UPDATE uploads SET name=name WHERE id=$1 AND user_id=$2")
        .bind(&upload.id)
        .bind(user)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if owned != 1 {
        return Err(AttachmentError::not_found());
    }
    let current=sqlx::query("UPDATE upload_image_jobs SET status='complete' WHERE upload_id=$1 AND user_id=$2 AND identity=$3 AND job_id=$4 AND status='processing'")
        .bind(&upload.id).bind(user).bind(identity).bind(job).execute(&mut *tx).await?.rows_affected();
    if current != 1 {
        return Err(changed());
    }
    sqlx::query("INSERT INTO upload_image_results(upload_id,user_id,identity,text,model)VALUES($1,$2,$3,$4,$5)ON CONFLICT(upload_id)DO UPDATE SET identity=$3,text=$4,model=$5 WHERE upload_image_results.user_id=$2")
        .bind(&upload.id).bind(user).bind(identity).bind(text).bind(&config.model).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
