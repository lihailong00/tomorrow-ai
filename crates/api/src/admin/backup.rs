//! Administrator-only, bounded encrypted instance exports. No plaintext download route.
use super::{AdminSession, AdminState};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use sqlx::Row;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path as FsPath, PathBuf},
    process::{Command, Stdio},
    str::FromStr,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio_util::io::ReaderStream;

const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
// Successful archives are retained until explicitly deleted by the owner.
// Failed attempts have no downloadable data and keep only a small history.
const MAX_FAILED_JOBS: usize = 20;
const CHUNK: usize = 1024 * 1024;
const KDF_ROUNDS: u32 = 600_000;
const MAGIC: &[u8; 8] = b"TADABAK2";
static ACTIVE: AtomicBool = AtomicBool::new(false);
struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}
struct DumpChild(std::process::Child);
impl Drop for DumpChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BackupJob {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub bytes: u64,
    pub error: Option<String>,
}
#[derive(Deserialize)]
pub struct CreateBackup {
    passphrase: String,
}
type Failure = (StatusCode, Json<serde_json::Value>);
fn failure(status: StatusCode, message: &str) -> Failure {
    (
        status,
        Json(json!({"error":{"code":"backup_unavailable","message":message}})),
    )
}
fn internal() -> Failure {
    failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "备份操作未完成，请检查服务配置和可用空间",
    )
}
fn owner(session: &AdminSession) -> Result<(), Failure> {
    if session.role == "owner" {
        Ok(())
    } else {
        Err(failure(
            StatusCode::FORBIDDEN,
            "只有实例所有者可以管理整站备份",
        ))
    }
}
fn directory(state: &AdminState) -> PathBuf {
    std::env::var_os("BACKUP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| state.config_dir.join("backups"))
}
fn support() -> Result<(), &'static str> {
    if std::env::var("BACKUP_ENABLED").as_deref() == Ok("false") {
        return Err("此实例未启用网页备份");
    }
    if !std::env::var("DATABASE_URL")
        .unwrap_or_default()
        .starts_with("postgres")
    {
        return Err("首版网页备份支持 PostgreSQL；SQLite 请停机后由部署者备份数据目录");
    }
    if std::env::var("UPLOAD_STORAGE").unwrap_or_else(|_| "local".into()) != "local" {
        return Err("对象存储需由部署者同步备份，首版网页备份只支持本机附件存储");
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}
fn database_password(database: &str) -> Result<String, ()> {
    let parsed = url::Url::parse(database).map_err(|_| ())?;
    let encoded = parsed.password().unwrap_or("").as_bytes();
    let mut bytes = Vec::new();
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' {
            if index + 2 >= encoded.len() {
                return Err(());
            }
            let hex = std::str::from_utf8(&encoded[index + 1..index + 3]).map_err(|_| ())?;
            bytes.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            index += 3;
        } else {
            bytes.push(encoded[index]);
            index += 1;
        }
    }
    let mut value = String::from_utf8(bytes).map_err(|_| ())?;
    for (key, part) in parsed.query_pairs() {
        if key == "password" {
            value = part.into_owned();
        }
    }
    if value.contains('\0') {
        return Err(());
    }
    Ok(value)
}
fn job_path(dir: &FsPath, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}
fn archive_path(dir: &FsPath, id: &str) -> PathBuf {
    dir.join(format!("{id}.tadabak"))
}
fn clean_interrupted(dir: &FsPath) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = name
            .strip_prefix('.')
            .and_then(|value| value.strip_suffix(".work"))
        {
            if valid_id(id) && entry.file_type()?.is_dir() {
                // The exact UUID child of our private backup directory is the only
                // recursive cleanup target; read_dir does not follow symlinks.
                fs::remove_dir_all(entry.path())?;
            }
        }
    }
    Ok(())
}
fn private_dir(path: &FsPath) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn private_file(path: &FsPath) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
fn save_job(dir: &FsPath, job: &BackupJob) -> std::io::Result<()> {
    let temporary = dir.join(format!("{}.json.tmp", job.id));
    let _ = fs::remove_file(&temporary);
    let mut file = private_file(&temporary)?;
    serde_json::to_writer(&mut file, job).map_err(std::io::Error::other)?;
    file.sync_all()?;
    fs::rename(temporary, job_path(dir, &job.id))
}
fn read_job(dir: &FsPath, id: &str) -> Result<BackupJob, Failure> {
    if !valid_id(id) {
        return Err(failure(StatusCode::NOT_FOUND, "备份不存在"));
    }
    let file =
        File::open(job_path(dir, id)).map_err(|_| failure(StatusCode::NOT_FOUND, "备份不存在"))?;
    if file.metadata().map_err(|_| internal())?.len() > 4096 {
        return Err(internal());
    }
    let job: BackupJob = serde_json::from_reader(file).map_err(|_| internal())?;
    if job.id != id {
        return Err(internal());
    }
    Ok(job)
}
fn newest_first(a: &BackupJob, b: &BackupJob) -> std::cmp::Ordering {
    b.created_at
        .cmp(&a.created_at)
        .then_with(|| b.id.cmp(&a.id))
}
fn mark_interrupted(job: &mut BackupJob, active: bool) {
    if matches!(job.status.as_str(), "queued" | "running") && !active {
        job.status = "failed".into();
        job.error = Some("备份被服务重启中断，请重新创建".into());
    }
}
struct JobListing {
    items: Vec<BackupJob>,
    pruned_failed_jobs: usize,
}
fn list_jobs(dir: &FsPath, active: bool) -> std::io::Result<JobListing> {
    let mut items = Vec::new();
    let mut failed = Vec::with_capacity(MAX_FAILED_JOBS + 1);
    let mut pruned_failed_jobs = 0;
    // Inspect the whole directory: read_dir order is unspecified, and archive,
    // temporary, or failed-job files must never hide retained successful jobs.
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(mut job) = read_job(dir, id) else {
            continue;
        };
        mark_interrupted(&mut job, active);
        let archive_absent = match fs::symlink_metadata(archive_path(dir, id)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(error),
            Ok(_) => false,
        };
        if job.status == "failed" && archive_absent {
            failed.push(job);
            failed.sort_by(newest_first);
            if failed.len() > MAX_FAILED_JOBS {
                let expired = failed.pop().expect("failed history exceeds limit");
                // Only validated terminal metadata without an archive is removed.
                // Ready/active jobs, archives, unknown files and symlinks survive.
                match fs::remove_file(job_path(dir, &expired.id)) {
                    Ok(()) => pruned_failed_jobs += 1,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        } else {
            items.push(job);
        }
    }
    items.extend(failed);
    items.sort_by(newest_first);
    Ok(JobListing {
        items,
        pruned_failed_jobs,
    })
}
pub fn router() -> Router<AdminState> {
    Router::new()
        .route("/admin/api/backups", get(list).post(create))
        .route("/admin/api/backups/{id}", get(status).delete(remove))
        .route("/admin/api/backups/{id}/download", get(download))
}
async fn list(
    State(state): State<AdminState>,
    _session: AdminSession,
) -> Result<Json<serde_json::Value>, Failure> {
    owner(&_session)?;
    let dir = directory(&state);
    private_dir(&dir).map_err(|_| internal())?;
    let listing = list_jobs(&dir, ACTIVE.load(Ordering::Acquire)).map_err(|_| internal())?;
    Ok(Json(
        json!({"items":listing.items,"supported":support().is_ok(),"reason":support().err(),"max_bytes":MAX_BYTES,"retention":{"failed_history_limit":MAX_FAILED_JOBS,"pruned_failed_jobs":listing.pruned_failed_jobs}}),
    ))
}
async fn status(
    State(state): State<AdminState>,
    _session: AdminSession,
    Path(id): Path<String>,
) -> Result<Json<BackupJob>, Failure> {
    owner(&_session)?;
    let mut job = read_job(&directory(&state), &id)?;
    mark_interrupted(&mut job, ACTIVE.load(Ordering::Acquire));
    Ok(Json(job))
}
async fn create(
    State(state): State<AdminState>,
    _session: AdminSession,
    Json(input): Json<CreateBackup>,
) -> Result<(StatusCode, Json<BackupJob>), Failure> {
    owner(&_session)?;
    support().map_err(|reason| failure(StatusCode::CONFLICT, reason))?;
    if !(12..=1024).contains(&input.passphrase.chars().count()) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "备份口令须为 12 到 1024 个字符，并单独妥善保存",
        ));
    }
    if ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(failure(StatusCode::CONFLICT, "已有备份正在进行"));
    }
    let active = ActiveGuard;
    let dir = directory(&state);
    private_dir(&dir).map_err(|_| internal())?;
    clean_interrupted(&dir).map_err(|_| internal())?;
    let count = fs::read_dir(&dir)
        .map_err(|_| internal())?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "tadabak"))
        .count();
    if count >= 5 {
        return Err(failure(
            StatusCode::CONFLICT,
            "最多保留 5 份备份，请下载并删除旧备份后重试",
        ));
    }
    let job = BackupJob {
        id: uuid::Uuid::new_v4().to_string(),
        status: "queued".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        bytes: 0,
        error: None,
    };
    if save_job(&dir, &job).is_err() {
        return Err(internal());
    }
    let background_job = job.clone();
    tokio::spawn(async move {
        let _active = active;
        let mut job = background_job;
        job.status = "running".into();
        let _ = save_job(&dir, &job);
        let result = run_backup(&state, &dir, &job, input.passphrase).await;
        match result {
            Ok(bytes) => {
                job.status = "ready".into();
                job.bytes = bytes;
            }
            Err(()) => {
                job.status = "failed".into();
                job.error = Some(
                    "备份未完成：请检查 PostgreSQL 工具、恢复密钥、附件完整性和 256 MiB 容量限制"
                        .into(),
                );
                let _ = fs::remove_file(archive_path(&dir, &job.id));
            }
        }
        let _ = save_job(&dir, &job);
        // Bound failure history even when the owner does not reopen the list.
        // Keep the active guard until retention completes so queued/running
        // metadata is never mistaken for an interrupted attempt here.
        let _ = list_jobs(&dir, true);
    });
    Ok((StatusCode::ACCEPTED, Json(job)))
}
async fn download(
    State(state): State<AdminState>,
    _session: AdminSession,
    Path(id): Path<String>,
) -> Result<Response, Failure> {
    owner(&_session)?;
    let dir = directory(&state);
    let job = read_job(&dir, &id)?;
    if job.status != "ready" {
        return Err(failure(StatusCode::CONFLICT, "备份尚未完成"));
    }
    let file = tokio::fs::File::open(archive_path(&dir, &id))
        .await
        .map_err(|_| internal())?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "no-store".into()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"tada-{id}.tadabak\""),
            ),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}
async fn remove(
    State(state): State<AdminState>,
    _session: AdminSession,
    Path(id): Path<String>,
) -> Result<StatusCode, Failure> {
    owner(&_session)?;
    let dir = directory(&state);
    let job = read_job(&dir, &id)?;
    if matches!(job.status.as_str(), "queued" | "running") && ACTIVE.load(Ordering::Acquire) {
        return Err(failure(StatusCode::CONFLICT, "备份正在进行"));
    }
    for path in [archive_path(&dir, &id), job_path(&dir, &id)] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(internal()),
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn run_backup(
    state: &AdminState,
    dir: &FsPath,
    job: &BackupJob,
    passphrase: String,
) -> Result<u64, ()> {
    let database = std::env::var("DATABASE_URL").map_err(|_| ())?;
    let options = sqlx::postgres::PgConnectOptions::from_str(&database).map_err(|_| ())?;
    let password = database_password(&database)?;
    let (config_revision, effective_settings) =
        state.settings.effective_snapshot().await.map_err(|_| ())?;
    // Hold the same repeatable-read snapshot for the referenced file list and pg_dump.
    // Files are immutable; disappearance/change aborts the entire export.
    let pool = state.repository.pool();
    let mut transaction = pool.begin().await.map_err(|_| ())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(|_| ())?;
    let snapshot: String = sqlx::query_scalar("SELECT pg_export_snapshot()")
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ())?;
    if !snapshot.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err(());
    }
    let rows = sqlx::query("SELECT id,size FROM uploads ORDER BY id")
        .fetch_all(&mut *transaction)
        .await
        .map_err(|_| ())?;
    if rows.len() > MAX_FILES {
        return Err(());
    }
    let mut uploads = Vec::new();
    for row in rows {
        let id: String = row.try_get("id").map_err(|_| ())?;
        let bytes: i64 = row.try_get("size").map_err(|_| ())?;
        if !valid_id(&id) || bytes < 0 {
            return Err(());
        }
        uploads.push((id, bytes as u64));
    }
    let config = state.config_dir.clone();
    let dir = dir.to_path_buf();
    let id = job.id.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        export(
            &dir,
            &id,
            &config,
            options,
            password,
            effective_settings,
            &snapshot,
            uploads,
            &passphrase,
        )
    })
    .await
    .map_err(|_| ())??;
    if state.settings.revision().await.map_err(|_| ())? != config_revision {
        return Err(());
    }
    transaction.commit().await.map_err(|_| ())?;
    Ok(bytes)
}
fn pg_dump(
    options: &sqlx::postgres::PgConnectOptions,
    password: &str,
    snapshot: &str,
    path: &FsPath,
) -> Result<(), ()> {
    let output = private_file(path).map_err(|_| ())?;
    let ssl = match options.get_ssl_mode() {
        sqlx::postgres::PgSslMode::Disable => "disable",
        sqlx::postgres::PgSslMode::Allow => "allow",
        sqlx::postgres::PgSslMode::Prefer => "prefer",
        sqlx::postgres::PgSslMode::Require => "require",
        sqlx::postgres::PgSslMode::VerifyCa => "verify-ca",
        sqlx::postgres::PgSslMode::VerifyFull => "verify-full",
        _ => "verify-full",
    };
    let mut child = DumpChild(
        Command::new("pg_dump")
            .args([
                "--format=custom",
                "--no-owner",
                "--no-acl",
                "--snapshot",
                snapshot,
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env(
                "PGHOST",
                options
                    .get_socket()
                    .map(|path| path.as_os_str())
                    .unwrap_or_else(|| std::ffi::OsStr::new(options.get_host())),
            )
            .env("PGPORT", options.get_port().to_string())
            .env("PGUSER", options.get_username())
            .env("PGPASSWORD", password)
            .env("PGDATABASE", options.get_database().unwrap_or("tomorrow"))
            .env("PGSSLMODE", ssl)
            .env("PGCONNECT_TIMEOUT", "10")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(output)
            .spawn()
            .map_err(|_| ())?,
    );
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        if fs::metadata(path).map_err(|_| ())?.len() > MAX_BYTES || Instant::now() > deadline {
            return Err(());
        }
        if let Some(status) = child.0.try_wait().map_err(|_| ())? {
            return if status.success() { Ok(()) } else { Err(()) };
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
struct TemporaryDirectory(PathBuf);
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn export(
    dir: &FsPath,
    id: &str,
    config: &FsPath,
    options: sqlx::postgres::PgConnectOptions,
    password: String,
    effective_settings: std::collections::HashMap<String, String>,
    snapshot: &str,
    uploads: Vec<(String, u64)>,
    passphrase: &str,
) -> Result<u64, ()> {
    let work = dir.join(format!(".{id}.work"));
    fs::create_dir(&work).map_err(|_| ())?;
    private_dir(&work).map_err(|_| ())?;
    let _cleanup = TemporaryDirectory(work.clone());
    let dump = work.join("database.dump");
    pg_dump(&options, &password, snapshot, &dump)?;
    let mut entries = vec![("database.dump".to_owned(), dump, None)];
    let upload_root = std::env::var_os("UPLOAD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/uploads"));
    for (id, size) in uploads {
        entries.push((format!("uploads/{id}"), upload_root.join(&id), Some(size)));
    }
    collect_files(config, config, "config", &mut entries)?;
    let settings_path = work.join("effective-settings.json");
    let mut settings_file = private_file(&settings_path).map_err(|_| ())?;
    serde_json::to_writer(&mut settings_file, &effective_settings).map_err(|_| ())?;
    settings_file.sync_all().map_err(|_| ())?;
    drop(settings_file);
    entries.push((
        "recovery/effective-settings.json".into(),
        settings_path,
        None,
    ));
    // The effective connector key or config master key may be supplied solely
    // by process environment rather than a file. Preserve them only inside the
    // encrypted export, never in the JSON manifest or download metadata.
    let recovery = work.join("effective-secrets.env");
    let mut recovery_file = private_file(&recovery).map_err(|_| ())?;
    for name in ["CONNECTOR_ENCRYPTION_KEY", "TADA_CONFIG_MASTER_KEY"] {
        if let Ok(value) = std::env::var(name) {
            if value.contains(['\r', '\n', '\0']) {
                return Err(());
            }
            if !value.is_empty() {
                writeln!(recovery_file, "{name}={value}").map_err(|_| ())?;
            }
        }
    }
    recovery_file.sync_all().map_err(|_| ())?;
    drop(recovery_file);
    entries.push(("recovery/effective-secrets.env".into(), recovery, None));
    if let Some(value) = std::env::var_os("BACKUP_RECOVERY_FILES") {
        for (index, path) in std::env::split_paths(&value).enumerate() {
            if index >= 20 {
                return Err(());
            }
            entries.push((format!("recovery/{index}.env"), path, None));
        }
    }
    if entries.len() >= MAX_FILES {
        return Err(());
    }
    let mut archive = private_file(&work.join("archive.raw")).map_err(|_| ())?;
    let mut total = 0u64;
    let manifest=serde_json::to_vec(&json!({"format":"tada-instance-v1","created_at":chrono::Utc::now().to_rfc3339(),"database":"postgresql","storage":"local","contains_secrets":true,"restoration":"offline-only","resume_schedules":false,"runtime_env_included":std::env::var_os("BACKUP_RECOVERY_FILES").is_some(),"files":entries.iter().map(|e|e.0.as_str()).collect::<Vec<_>>()})).map_err(|_|())?;
    append_header(
        &mut archive,
        "manifest.json",
        manifest.len() as u64,
        &mut total,
    )?;
    archive.write_all(&manifest).map_err(|_| ())?;
    for (name, path, expected) in entries {
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || expected.is_some_and(|size| size != metadata.len())
        {
            return Err(());
        }
        append_header(&mut archive, &name, metadata.len(), &mut total)?;
        let mut file = File::open(&path).map_err(|_| ())?;
        let copied = std::io::copy(
            &mut Read::by_ref(&mut file).take(metadata.len()),
            &mut archive,
        )
        .map_err(|_| ())?;
        if copied != metadata.len()
            || fs::metadata(&path).map_err(|_| ())?.modified().ok() != metadata.modified().ok()
            || fs::metadata(&path).map_err(|_| ())?.len() != metadata.len()
        {
            return Err(());
        }
    }
    archive.sync_all().map_err(|_| ())?;
    drop(archive);
    let output = archive_path(dir, id);
    let mut source = File::open(work.join("archive.raw")).map_err(|_| ())?;
    let mut target = private_file(&output).map_err(|_| ())?;
    encrypt(&mut source, &mut target, passphrase).map_err(|_| ())?;
    target.sync_all().map_err(|_| ())?;
    fs::metadata(output).map(|m| m.len()).map_err(|_| ())
}
fn collect_files(
    root: &FsPath,
    path: &FsPath,
    prefix: &str,
    entries: &mut Vec<(String, PathBuf, Option<u64>)>,
) -> Result<(), ()> {
    if !path.exists() {
        return Err(());
    }
    for entry in fs::read_dir(path).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|_| ())?;
        if kind.is_symlink() {
            return Err(());
        }
        let relative = path.strip_prefix(root).map_err(|_| ())?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if name.split('/').any(|part| {
            matches!(part, "backups" | "tmp" | "logs" | "setup-token") || part.starts_with('.')
        }) {
            continue;
        }
        if entries.len() >= MAX_FILES {
            return Err(());
        }
        if kind.is_dir() {
            collect_files(root, &path, prefix, entries)?;
        } else if kind.is_file() {
            entries.push((format!("{prefix}/{name}"), path, None));
        } else {
            return Err(());
        }
    }
    Ok(())
}
fn safe_archive_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1024
        && !name.chars().any(char::is_control)
        && name.split('/').count() <= 25
        && !name.contains('\\')
        && !name.contains(':')
        && !name.starts_with('/')
        && name
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}
fn append_header(
    output: &mut impl Write,
    name: &str,
    size: u64,
    total: &mut u64,
) -> Result<(), ()> {
    if !safe_archive_name(name) {
        return Err(());
    }
    *total = total
        .checked_add(10 + name.len() as u64)
        .and_then(|n| n.checked_add(size))
        .filter(|n| *n <= MAX_BYTES)
        .ok_or(())?;
    output
        .write_all(&(name.len() as u16).to_be_bytes())
        .map_err(|_| ())?;
    output.write_all(&size.to_be_bytes()).map_err(|_| ())?;
    output.write_all(name.as_bytes()).map_err(|_| ())
}
fn derive_key(passphrase: &str, salt: &[u8], rounds: u32) -> [u8; 32] {
    type H = Hmac<Sha256>;
    let mut first =
        <H as Mac>::new_from_slice(passphrase.as_bytes()).expect("HMAC accepts all key lengths");
    first.update(salt);
    first.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = first.finalize().into_bytes().into();
    let mut output = u;
    for _ in 1..rounds {
        let mut mac = <H as Mac>::new_from_slice(passphrase.as_bytes())
            .expect("HMAC accepts all key lengths");
        mac.update(&u);
        u = mac.finalize().into_bytes().into();
        for (out, part) in output.iter_mut().zip(u) {
            *out ^= part;
        }
    }
    output
}
fn encrypt(
    source: &mut impl Read,
    target: &mut impl Write,
    passphrase: &str,
) -> std::io::Result<()> {
    let mut salt = [0u8; 16];
    let mut prefix = [0u8; 8];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut prefix);
    let mut header = Vec::from(*MAGIC);
    header.extend(salt);
    header.extend(prefix);
    header.extend(KDF_ROUNDS.to_be_bytes());
    target.write_all(&header)?;
    let mut key = derive_key(passphrase, &salt, KDF_ROUNDS);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("key length");
    key.fill(0);
    let mut buffer = vec![0u8; CHUNK];
    let mut counter = 0u32;
    let mut total = 0u64;
    loop {
        let count = source.read(&mut buffer)?;
        total += count as u64;
        if total > MAX_BYTES {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let kind = if count == 0 { 2u8 } else { 1u8 };
        let mut nonce = [0u8; 12];
        nonce[..8].copy_from_slice(&prefix);
        nonce[8..].copy_from_slice(&counter.to_be_bytes());
        let mut aad = header.clone();
        aad.extend(counter.to_be_bytes());
        aad.push(kind);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &buffer[..count],
                    aad: &aad,
                },
            )
            .map_err(|_| std::io::ErrorKind::InvalidData)?;
        target.write_all(&[kind])?;
        target.write_all(&(ciphertext.len() as u32).to_be_bytes())?;
        target.write_all(&ciphertext)?;
        if count == 0 {
            break;
        }
        counter = counter
            .checked_add(1)
            .ok_or(std::io::ErrorKind::InvalidData)?;
    }
    buffer.fill(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example_job(index: u128, status: &str) -> BackupJob {
        BackupJob {
            id: uuid::Uuid::from_u128(index + 1).to_string(),
            status: status.into(),
            created_at: chrono::DateTime::from_timestamp(1_793_059_200 + index as i64, 0)
                .unwrap()
                .to_rfc3339(),
            bytes: 0,
            error: None,
        }
    }
    #[test]
    fn failed_history_cannot_hide_ready_backups_and_is_bounded_deterministically() {
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path();
        let ready: Vec<_> = (0..5).map(|index| example_job(index, "ready")).collect();
        for job in &ready {
            save_job(dir, job).unwrap();
            fs::write(archive_path(dir, &job.id), b"encrypted backup").unwrap();
        }
        // Unrelated directory entries also used to consume the 100-entry limit.
        for index in 0..110 {
            fs::write(
                dir.join(format!("unrelated-{index}.tmp")),
                b"leave untouched",
            )
            .unwrap();
        }
        for index in (100..205).rev() {
            save_job(dir, &example_job(index, "failed")).unwrap();
        }
        let listing = list_jobs(dir, false).unwrap();
        assert_eq!(listing.items.len(), 5 + MAX_FAILED_JOBS);
        assert_eq!(listing.pruned_failed_jobs, 105 - MAX_FAILED_JOBS);
        for job in &ready {
            assert!(listing.items.iter().any(|item| item.id == job.id));
            assert_eq!(
                fs::read(archive_path(dir, &job.id)).unwrap(),
                b"encrypted backup"
            );
        }
        let failed_ids: Vec<_> = listing
            .items
            .iter()
            .filter(|job| job.status == "failed")
            .map(|job| job.id.clone())
            .collect();
        let expected: Vec<_> = (185..205)
            .rev()
            .map(|index| example_job(index, "failed").id)
            .collect();
        assert_eq!(failed_ids, expected);
        assert!(dir.join("unrelated-109.tmp").exists());
        let again = list_jobs(dir, false).unwrap();
        assert_eq!(again.pruned_failed_jobs, 0);
        assert_eq!(
            again.items.iter().map(|job| &job.id).collect::<Vec<_>>(),
            listing.items.iter().map(|job| &job.id).collect::<Vec<_>>()
        );
        assert_eq!(
            fs::read_dir(dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count(),
            25
        );
    }
    #[test]
    fn retention_preserves_archives_active_jobs_and_unknown_files() {
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path();
        for index in 100..130 {
            save_job(dir, &example_job(index, "failed")).unwrap();
        }
        let protected = [
            example_job(0, "failed"),
            example_job(1, "queued"),
            example_job(2, "running"),
            example_job(3, "ready"),
        ];
        for job in &protected {
            save_job(dir, job).unwrap();
        }
        fs::write(archive_path(dir, &protected[0].id), b"retained archive").unwrap();
        let malformed = job_path(dir, &example_job(4, "failed").id);
        fs::write(&malformed, b"not a backup job").unwrap();
        let mismatched = job_path(dir, &example_job(5, "failed").id);
        fs::write(
            &mismatched,
            serde_json::to_vec(&example_job(6, "failed")).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("unknown.json"), b"{}").unwrap();
        let listing = list_jobs(dir, true).unwrap();
        assert_eq!(listing.pruned_failed_jobs, 10);
        for job in protected {
            let kept = listing.items.iter().find(|item| item.id == job.id).unwrap();
            assert_eq!(kept.status, job.status);
            assert!(job_path(dir, &job.id).exists());
        }
        assert!(malformed.exists());
        assert!(mismatched.exists());
        assert!(dir.join("unknown.json").exists());
    }
    #[test]
    fn interrupted_jobs_report_failure_and_ties_have_a_stable_order() {
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path();
        let mut running = example_job(10, "running");
        let mut queued = example_job(20, "queued");
        queued.created_at = running.created_at.clone();
        save_job(dir, &queued).unwrap();
        save_job(dir, &running).unwrap();
        let listing = list_jobs(dir, false).unwrap();
        assert_eq!(
            listing.items.iter().map(|job| &job.id).collect::<Vec<_>>(),
            vec![&queued.id, &running.id]
        );
        assert!(listing.items.iter().all(|job| job.status == "failed"
            && job.error.as_deref() == Some("备份被服务重启中断，请重新创建")));
        mark_interrupted(&mut running, false);
        assert_eq!(running.status, "failed");
    }
    #[test]
    fn cleanup_reaches_interrupted_work_after_many_unrelated_entries() {
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path();
        for index in 0..110 {
            fs::write(dir.join(format!("unrelated-{index}.tmp")), b"keep").unwrap();
        }
        let work = dir.join(format!(".{}.work", example_job(1, "running").id));
        fs::create_dir(&work).unwrap();
        fs::write(work.join("partial.dump"), b"partial").unwrap();
        let unknown = dir.join(".unknown.work");
        fs::create_dir(&unknown).unwrap();
        clean_interrupted(dir).unwrap();
        assert!(!work.exists());
        assert!(unknown.exists());
        assert!(dir.join("unrelated-109.tmp").exists());
    }
    #[test]
    fn pbkdf2_matches_standard_vector() {
        assert_eq!(
            derive_key("password", b"salt", 1),
            [
                0x12, 0x0f, 0xb6, 0xcf, 0xfc, 0xf8, 0xb3, 0x2c, 0x43, 0xe7, 0x22, 0x52, 0x56, 0xc4,
                0xf8, 0x37, 0xa8, 0x65, 0x48, 0xc9, 0x2c, 0xcc, 0x35, 0x48, 0x08, 0x05, 0x98, 0x7c,
                0xb7, 0x0b, 0xe1, 0x7b
            ]
        );
    }
    #[test]
    fn postgres_password_decoding_preserves_literal_plus_and_query_override() {
        assert_eq!(
            database_password("postgresql://owner:abc%40x+z@localhost/tada").unwrap(),
            "abc@x+z"
        );
        assert_eq!(
            database_password("postgresql://owner:old@localhost/tada?password=new%2Bvalue")
                .unwrap(),
            "new+value"
        );
        assert!(database_password("postgresql://owner:bad%00value@localhost/tada").is_err());
    }
    #[test]
    fn backup_metadata_never_serializes_passphrase_or_recovery_keys() {
        let job = BackupJob {
            id: uuid::Uuid::new_v4().to_string(),
            status: "ready".into(),
            created_at: "2026-10-27T00:00:00Z".into(),
            bytes: 123,
            error: None,
        };
        let value = serde_json::to_value(job).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(value.get("passphrase").is_none());
        assert!(value.get("key").is_none());
    }
    #[test]
    fn paths_and_size_are_bounded() {
        for name in [
            "../x",
            "/root/key",
            "config/../../key",
            "uploads\\key",
            "C:/key",
            "a//b",
        ] {
            assert!(!safe_archive_name(name));
        }
        let mut total = MAX_BYTES - 1;
        assert!(append_header(&mut Vec::new(), "x", 2, &mut total).is_err());
        assert!(valid_id("e84d3e1f-580e-46a0-a815-f13e1ff747d0"));
        assert!(!valid_id("../x"));
    }
    #[test]
    fn errors_do_not_include_provider_or_database_details() {
        let (_, Json(error)) = internal();
        let text = error.to_string();
        assert!(!text.contains("DATABASE_URL"));
        assert!(!text.contains("password"));
        assert!(text.contains("备份"));
    }
}
