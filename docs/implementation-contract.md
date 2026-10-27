# First build contract

This file is the implementation interface agreement. Android first; Rust business backend plus a TypeScript/Pi execution service. Public paths `/v1`, JSON snake_case. All timestamps RFC3339 strings, IDs strings. Authorization `Bearer <token>`. Errors `{ "error": { "code": "...", "message": "human readable" } }`. List endpoints return `{ "items": [...] }`. No credentials in responses/logs.

## Types

```ts
type User = {id:string; email:string; phone?:string; name:string; timezone:string; created_at:string};
type AuthSession = {token:string; user:User};
type MemoryKind = 'preference'|'person'|'project'|'goal'|'fact';
type Memory = {id:string; title:string; content:string; kind:MemoryKind; source:string; created_at:string; updated_at:string; version:number};
type TaskStatus = 'queued'|'running'|'waiting_approval'|'succeeded'|'failed'|'cancelled'|'uncertain';
type Step = {id:string; title:string; status:'pending'|'running'|'completed'|'failed'; detail?:string|null};
type Task = {id:string; title:string; instruction:string; kind:string; status:TaskStatus; progress:number; summary?:string|null; result?:string|null; error?:string|null; created_at:string; updated_at:string; steps:Step[]; model_mode:string; approval_required:boolean; approved_at?:string|null; artifact_id?:string|null};
type Schedule = {id:string; title:string; instruction:string; frequency:'daily'|'weekdays'|'weekly'|'once'; time:string; timezone:string; enabled:boolean; next_run_at:string; last_run_at?:string|null; created_at:string};
type Message = {id:string; conversation_id:string; role:'user'|'assistant'; content:string; created_at:string; model_mode?:string|null};
type Conversation = {id:string; title:string; updated_at:string};
type Artifact = {id:string; task_id:string; title:string; content:string; mime_type:string; created_at:string};
type Notification = {id:string; title:string; body:string; task_id?:string|null; read:boolean; created_at:string};
type Capability = {id:string; name:string; description:string; category:string; status:'available'|'not_configured'|'coming_soon'; detail:string};
type RuntimeInfo = {model_mode:string; model_name?:string|null; agent_harness:'pi'|'direct'; scheduler_mode:string; storage_mode:string};
type Today = {date:string; greeting:string; briefing:string; tasks:Task[]; schedules:Schedule[]; memories:Memory[]; notifications:Notification[]; stats:{tasks_completed:number; active_routines:number; memory_count:number}; runtime:RuntimeInfo};
```

## Endpoints

- `GET /health` public health JSON.
- `POST /auth/register` `{email,password,name?,timezone?}` -> AuthSession; legacy local/private email registration, blocked at the cloud ingress.
- `POST /auth/login` `{email,password}` -> AuthSession; legacy local/private email login, blocked at the cloud ingress.
- `POST /auth/phone/code` `{phone,purpose:'register'|'reset_password'}` -> `{challenge_id,expires_in,retry_after,test_mode}`. The cloud sends real SMS through Alibaba Cloud PNVS; the fixed code `123456` is restricted to explicit local loopback test mode. Mainland China phone numbers normalize to `+86` plus 11 digits. The former `login` SMS purpose is rejected without sending.
- `POST /auth/phone/register` `{phone,code,challenge_id,password,name?,timezone?}` -> AuthSession. SMS verifies phone possession before creating the account and setting its password. Empty names default to 用户 plus the last four digits.
- `POST /auth/phone/login` `{phone,password}` -> AuthSession. Uses the existing account without sending SMS and works independently of SMS provider availability. Unknown accounts, incorrect passwords and legacy accounts without a password return the same `401 invalid_credentials` response.
- `POST /auth/phone/password/reset` `{phone,code,challenge_id,new_password}` -> `{ok:true}`. Atomically consumes a reset-purpose SMS challenge, replaces the password and revokes all existing sessions; it does not log in automatically. Legacy phone accounts use this flow to set their first password.
- `POST /auth/logout` -> `{ok:true}` revokes current session.
- `GET /me` -> User. `PATCH /me` `{name?,timezone?}` -> User.
- `GET /today` -> Today. `POST /briefing` `{}` -> Task (kind briefing).
- `GET /memories?kind=...` -> items. `POST /memories` `{title?,content,kind,source?}` -> Memory.
- `PATCH /memories/:id` `{title?,content?,kind?,version?}` -> Memory; stale version 409. `DELETE /memories/:id` -> `{ok:true}`.
- `GET /tasks` -> items. `GET /tasks/:id` -> Task. `POST /tasks` `{instruction,title?,kind?,approval_required?,client_request_id?}` -> Task. Same client_request_id/user returns original task.
- `POST /tasks/:id/cancel` -> Task. `POST /tasks/:id/approve` `{}` -> Task (approval gated by immutable instruction snapshot/version; no external actions in initial local executor).
- `GET /schedules` -> items. `POST /schedules` `{title,instruction,frequency,time,timezone,enabled?}` -> Schedule.
- `PATCH /schedules/:id` same optional fields -> Schedule; enabled pause/resume. `DELETE /schedules/:id` -> `{ok:true}`.
- `GET /conversations` -> items. `GET /conversations/:id/messages` -> items.
- `POST /chat` `{message,conversation_id?,client_request_id?,remember?:boolean}` -> `{conversation_id:string,message:Message}`. No hidden memory extraction in local demo: explicit user-created memory entries only. Include user's active memories in real provider context; deletion must affect future requests. Real provider config via env; local mode clearly identified as `local` and never claim web/mail actions happened.
- `GET /capabilities` -> `{items:Capability[],runtime:RuntimeInfo}`. Unconfigured integrations accurately marked. `GET /notifications` -> items, `POST /notifications/:id/read` -> `{ok:true}`.
- `GET /artifacts` -> items, `GET /artifacts/:id` -> Artifact, `GET /artifacts/:id/download` authenticated attachment.

Phone passwords contain 8–128 Unicode characters and are never trimmed. Only salted Argon2id hashes are stored, separately from legacy email credentials. SMS codes are bound to phone, purpose and challenge, expire after five minutes, lock after five wrong attempts and are atomically single-use. Sending attempts share persistent rolling per-phone and global quotas across registration and password reset, including failed deliveries. Every phone authentication request has a 2 KiB body limit. Rate limits return `429` with `Retry-After`; the verified HTTPS ingress additionally limits source IPs. A password reset cannot be bypassed by a login that verified an older password concurrently.

## Persistence and Worker

### Pi integration

`POST /chat` additionally returns optional `agent_run_id`. Pi mode reconstructs history from Rust and uses business tools for current memory; direct mode retains the original context injection. Existing mobile bundles tolerate these additive fields.

- `GET /agent-runs` returns the current user's last 50 run summaries.
- `GET /agent-runs/:id` returns own run state, redacted events, committed operations and reported Token usage.
- `POST /agent-runs/:id/cancel` revokes further run operations; committed effects remain.

Pi's loop is not a second business database. Rust stores `agent_runs`, `agent_events`, `agent_operations`; mutation and replay receipt are atomic. Internal callbacks `/internal/agent/runs/:id/{state,events,tools}` require both `X-Agent-Service` and a per-run Bearer capability; never expose them as user-authenticated public tool endpoints. Identity comes from the run, not model arguments. Writes include an adapter-generated per-tool `operation_index`; changed arguments on replay fail with `agent_replay_conflict` and stop the Pi run. Tasks created by Pi always await approval; schedules are disabled drafts. Background runs expose read tools only and validate task attempt/lease/cancellation.

Pi mode needs the API and Pi service online even for background work. Persisted task retries remain in Rust/Temporal; chat retries reuse the original `client_request_id`. Recovery can re-invoke the model and incur charges; it is not exact replay of Pi's entire in-memory execution. Current mobile chat remains a completed JSON response; Pi's internal model streaming does not imply client streaming. See `services/agent/README.md` for config and limits.

Crates: `tomorrow-domain` (library), `tomorrow-api` (binary), `tomorrow-worker` (binary). Domain root exports DTOs, `Repository` cloneable and `ModelProvider`. Backend agent defines Repository APIs and sends worker agent signatures immediately. Worker operates through domain library; never through unprotected internal HTTP endpoints.

SQLite file supports local setup; `DATABASE_URL=postgres://...` production path. No in-memory-only business state. Worker standalone polls persisted queue in `local` mode and survives API exit; Temporal mode is separately configured and explicitly reported. At least-once jobs must not duplicate task side effects; compare state/claim within DB, lease/attempt recoverability.

Phone identities and verification challenges use migration `003_phone_auth.sql`; `004`/`005` provide persistent SMS quotas and conservative one-time import into the rolling attempt ledger. Migration `006_phone_password.sql` adds separate phone credentials, a shared transaction guard and bounded login-attempt records. Existing accounts and resource ownership are retained. Mobile account changes remount the account's view tree; late authentication failures from an older token cannot expire the new session. SMS/model credentials remain backend-only; production rejects the fixed-code local test configuration.

Local mode executes genuine local artifact/briefing generation and stored-data organization; explicitly labels limited capability. Configured LLM requests use an API-compatible HTTP endpoint (env `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`), token stored server-only. Tasks are cancelled safely and read current memories just before execution. Scheduling uses IANA timezone including DST and persists next/last run.

## Android platform port

Native module `TomorrowPlatform`:
- `getSecureItem(key:string): Promise<string|null>`
- `setSecureItem(key:string,value:string): Promise<void>`
- `removeSecureItem(key:string): Promise<void>`
- `startRecording(): Promise<void>`
- `stopRecording(): Promise<{uri:string;name:string;mime_type:string;duration_ms:number}>`
- `pickDocument(): Promise<{uri:string;name:string;mime_type:string;size:number}|null>`
- `shareText(text:string): Promise<void>`
- `requestNotifications(): Promise<boolean>`
- `showNotification(title:string,body:string): Promise<void>`

UI owns `src/platform` interface and adapter; all NativeModules access confined there. Native agent implements Android module. iOS/Harmony unsupported adapter returns clear capability status rather than pretending support. Base URL defaults to the deployed cloud HTTPS service and remains editable before/after login. An uncustomized legacy emulator default (`http://10.0.2.2:8080`) migrates only after clearing its old session; explicitly customized URLs are preserved. Token secure storage; AsyncStorage only URL/preferences, no token fallback to disk.

File/audio upload endpoints will be coordinated as optional additions after core contract; do not fake successful upload. Show selected local file/recording and availability truthfully until backend supports it.
