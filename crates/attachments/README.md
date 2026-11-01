# tomorrow-attachments

Authenticated uploads for the Tomorrow Android API. Requires the same `Repository` as the core API. This module owns the SQLx `uploads` table and initializes it for SQLite or PostgreSQL.

```rust,ignore
let attachments = tomorrow_attachments::AttachmentsState::new(repository.clone()).await?;
// The module router includes the full /v1/uploads prefix and its own body limit.
let app = api.with_state(state).merge(tomorrow_attachments::router(attachments));
```

Routes require the main API's `Authorization: Bearer <token>` session:

| Method | Route | Result |
| --- | --- | --- |
| GET | `/v1/uploads` | `{items: Upload[]}`, up to 200 newest owned uploads |
| POST | `/v1/uploads` | One multipart field named `file`; HTTP 201 `Upload` |
| DELETE | `/v1/uploads/{id}` | Delete owned stored content and metadata; `{ok:true}` |
| GET | `/v1/uploads/{id}/download` | Authenticated file download, attachment disposition, no-store |
| POST | `/v1/uploads/{id}/transcribe` | `{upload_id,text,model}` from a genuine compatible ASR provider |

`Upload` is `{id,name,mime_type,size,created_at,uri}`. `uri` is an API-relative download route, not a public link or local disk path. React Native's FormData accepts `{uri,name,type}` from `content://` document selection or local recording. Set only the Authorization header; let the runtime set Content-Type and its multipart boundary.

Configuration:

- `UPLOAD_DIR`: defaults to `data/uploads`. Mount durable private storage for deployments and back it up alongside the database. Do not expose this directory with a static-file server.
- `UPLOAD_STORAGE`: `local` by default, or `s3` with the optional SDK feature and S3 configuration below. Selecting S3 in a binary compiled without that feature fails explicitly.
- `UPLOAD_MAX_BYTES`: default 26214400 (25 MiB), configurable from 1024 to 104857600. Files are streamed to a private random UUID path, metadata is committed only after the file is complete. Rejected uploads are removed. Process crashes can leave unreferenced files; do not treat filesystem directory enumeration as the user's upload list.
- `ASR_PROTOCOL`: `openai_transcriptions` (default, multipart `/audio/transcriptions`) or `qwen_asr` (JSON `/chat/completions` with base64 input audio).
- `ASR_BASE_URL`: API-compatible base. For Alibaba Beijing use `https://dashscope.aliyuncs.com/compatible-mode/v1` with `qwen_asr`; the selected protocol path is appended unless already included.
- `ASR_MODEL`: actual model supported by that provider. Base and model must be configured together.
- `ASR_API_KEY`: optional only for providers that allow unauthenticated local access. Credentials remain server-side.

No ASR configuration returns HTTP 503 `not_configured`; audio remains saved. Empty, failed or invalid responses never fabricate a transcript, and provider bodies or credentials never appear in public errors. Successful transcripts are persisted and reused without another attempted call or quota charge. `ASR_USER_DAILY_LIMIT` defaults to 1000 and `ASR_GLOBAL_DAILY_LIMIT` to 5000; each accepts integers from 1 to 1000000 and can be edited in administration. An SQL transaction enforces a rolling 24-hour window across API processes, including failed or ambiguous attempts; history is not purged to free quota. Exhaustion returns 429 `asr_user_daily_limit` or `asr_global_daily_limit` with an accurate `Retry-After` and `error.retry_after_seconds`. Same-upload jobs return 429 `asr_in_progress`; a queued duplicate whose earlier attempt failed returns 409 `asr_retry_required` instead of silently making another paid call. Two provider operations run per API process; admission waits at most 15 seconds before returning 503 `asr_busy`. All retries are explicit and reuse the upload ID. Provider authentication, rate limiting and availability have distinct `asr_provider_*` errors; ambiguous timeouts return 504 `asr_timeout`. The read-plus-provider operation is bounded to 130 seconds, within its 150-second running lease, and the provider HTTP client retains its 120-second timeout. Audio is capped at 7 MiB and responses at 1 MiB. Attempt counts are usage limits, not a guaranteed currency budget.

Android dictation uploads audio over the authenticated API, transcribes it automatically, and inserts editable text without sending a chat message. It preserves typed text and reuses an upload for explicit retries. After success or cancellation the client attempts to delete its temporary upload; failed deletion or interrupted app shutdown may leave private audio for later cleanup. Selected audio attachments retain the separate manual attachment workflow. Credentials are never returned to the mobile client.

Chat integration calls `chat_context(authenticated_user_id, upload_ids)`. It verifies ownership before accessing bytes, accepts at most five uploads, limits each readable text to 64 KiB and combined context to 128 KiB. TXT, MD/Markdown, CSV, TSV, JSON and LOG files must actually be UTF-8, without NUL bytes. Saved audio is readable only after genuine transcription. PDF, Office, images and other files can be stored and downloaded but return `unsupported_file_type` for chat analysis; no parsing is claimed.

Optional S3 storage:

```powershell
cargo run -p tomorrow-api --features s3
```

Set `UPLOAD_STORAGE=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. `S3_REGION` defaults to `us-east-1`; `S3_FORCE_PATH_STYLE` defaults to `true` for S3-compatible services; `S3_PREFIX` defaults to `tomorrow-uploads`. Temporary credentials may include `S3_SESSION_TOKEN`. Create the private bucket before production use. The opt-in integration test can create its configured bucket when absent.

The S3 driver uses `aws-sdk-s3` for actual signed object PUT, streamed GET and DELETE. The Android app keeps using the same authenticated upload/download/delete API; credentials and bucket keys are not returned to it. Uploads first stream into a bounded local spool, transfer to S3, then commit their metadata and object location in one SQL transaction. On metadata failure the driver attempts compensating object deletion. A crash or an unavailable cleanup request can leave unreferenced objects, which require operational reconciliation. No permanent local copy is retained for successful S3 uploads. Existing local uploads keep their original storage location when S3 is enabled, so retain the old local volume until deliberately migrated.

Object deletion finishes before metadata removal and never holds a SQL transaction during external I/O. Failed object deletion preserves metadata for retry. A database failure after successful object deletion can leave an unavailable metadata record that a repeated deletion removes. S3 version retention, object lock, backups and lifecycle rules remain the operator's responsibility; this API does not purge historical object versions. Configuring a different endpoint is a storage migration, not a safe automatic setting change.

The optional AWS package family is explicitly constrained to versions compatible with the workspace's Rust 1.92 toolchain; commit Cargo.lock and use `--locked` for builds. S3 server compatibility and recovery must be tested against the chosen provider, not inferred from successful SDK compilation or the HTTP mock.

Run `cargo test -p tomorrow-attachments` for local storage and ASR tests, and `cargo test -p tomorrow-attachments --features s3 --locked` for the signed HTTP S3 test. The explicit real-server gate is `cargo test -p tomorrow-attachments --features s3 real_s3_server_round_trip -- --ignored` with the intended test server's `S3_*` configuration.

Verification on 2026-10-26: Rust 1.92.0 compiled the optional feature; nine automated tests passed, including a real signed HTTP mock. The opt-in integration test also passed against the local RustFS 1.0.1 service: bucket initialization, upload, text read, cross-user denial, byte-identical download and deletion. The test object was removed. This verifies that specific local server path, not all S3 vendors, failure recovery, object version retention or production reliability.

This first build does not claim direct-to-S3 presigned multipart/resumable uploads, content malware scanning or file format conversion. S3 mode can share stored files across API nodes, while local mode requires a shared filesystem or a single API storage node.
