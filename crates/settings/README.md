# Instance configuration

`tomorrow-settings` is the server-only configuration authority shared by the API,
worker, and trusted Pi configuration endpoint. It supports SQLx `AnyPool` on
SQLite and PostgreSQL. It does not call providers or send notifications.

## Runtime contract

- `ConfigStore::new(pool).await` captures only allowlisted, nonempty environment
  overrides. `TADA_INSTANCE_MODE` is an alias for `INSTANCE_MODE`.
- `effective_values().await` returns plaintext configuration to trusted server
  adapters only. Never serialize, log, cache in a browser, or return this map from
  a public or administrator endpoint.
- `snapshot().await` returns `{ revision, settings }`. Secret fields always have
  `value: null`; `configured`, `source`, and `locked` communicate their state.
- `update(expected_revision, changes).await` applies one atomic transaction. An
  absent key is untouched; `null` deletes a stored override; an empty string
  explicitly clears an optional value. Environment and managed keys are locked.
- `validate_update(expected_revision, &changes).await` checks format, locks, and
  revision without writing or making a paid provider call. `preview` additionally
  returns a masked proposed snapshot without saving.
- `instance_metadata()` returns only stable instance identity, public name/URL,
  deployment mode, login policies, and configuration revision.
- `effective_snapshot()` pairs plaintext values and their revision in one SQL
  statement for trusted runtime caches. `readiness()` and `preview_readiness()`
  return missing-field names and structural status only. They never claim a
  provider connection has been verified and never call a paid API.

Precedence is **nonempty environment override > encrypted stored value > default**.
Blank example environment variables do not lock the editor. Environment values
are captured on process start; changes to that deployment layer require restart.

Defaults are `INSTANCE_MODE=self_hosted`, `REGISTRATION_POLICY=closed`,
`EMAIL_PASSWORD_ENABLED=true`, and `PHONE_PASSWORD_ENABLED=false`. Setting mode to
`official` changes the default registration policy to `open` and enables phone
password login; explicit values still win. No external model Key is required to
start the store. Optional cloud photo processing and web search default off for
self-hosted instances; official mode enables web search by default.

Provider addresses require HTTPS, or administrator-selected HTTP on loopback,
RFC1918/ULA addresses, and fixed Docker service hosts. URL userinfo, query strings,
and fragments are rejected, including in environment overrides. This exception
does not apply to webpages or URLs supplied by model output. An explicit private
`MODEL_BASE_URL` plus `MODEL_NAME` supports a keyless local model without borrowing
any cloud credential; public endpoints still require their own Key. The four Pi
startup limits are marked as requiring restart.

## Secrets and restoration

All stored values use AES-256-GCM with a fresh random nonce. Authenticated context
binds each ciphertext to its instance ID and setting name. Copying ciphertext to
another field or instance cannot decrypt it. Credentials are excluded from Debug
implementations and error text.

`TADA_CONFIG_MASTER_KEY` optionally supplies a 32-byte key as 64 hexadecimal
characters or standard Base64. Otherwise the first process atomically creates
`$TADA_CONFIG_DIR/master.key`. The default directory is `data/config`, or
`/var/lib/tomorrow/config` for Unix production. Unix directory/file modes are
0700/0600; unsafe restored permissions are rejected. Concurrent initializers
cannot overwrite another process's generated key.

The database contains an encrypted key check even before user settings are saved.
If the original master key is missing or incorrect, startup fails closed instead
of generating a replacement that would make existing secrets unreadable.

Back up the database, uploads, original master key or private environment source,
and any independent service authentication material. The master key must be kept
private and restored together with the database. A database-only backup does not
contain the decryption key.

`CONNECTOR_ENCRYPTION_KEY` and `SMS_CODE_HASH_KEY` are generated and durably stored
when deployment values are absent. These server-internal keys are masked and
locked in the web editor because replacing them can invalidate user authorizations
or outstanding verification challenges.

## Controlled legacy migration

Before opening a migrated server to traffic, a trusted deployment command may call
`import_environment(expected_revision).await` or `import_values(...)` to persist
allowlisted legacy configuration under encryption, including managed keys. The
result is a masked snapshot. This bypasses environment locks **only for the
trusted migration path**; never expose these methods as HTTP endpoints. Removing
selected environment overrides after a successful import lets the web editor
manage those settings on the next process start.

The `tada-config --status` and `tada-config --import-environment` offline helper
reads the same private process environment as the API. It requires `DATABASE_URL`
and the correct config directory/master key. Its JSON output contains only status,
public instance ID, revision, and a count of configured environment overrides.
