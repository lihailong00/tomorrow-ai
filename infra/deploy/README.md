# Linux cloud trial deployment

This is a single-host deployment for a limited cloud trial: Rust API + Rust Worker +
TypeScript Pi, PostgreSQL, private local upload storage, and an HTTPS ingress.
The scheduler is the existing durable database polling mode (`local`). This
package does not deploy a production Temporal cluster or claim S3 storage.

## Build on the development computer

Run `./scripts/Build-Cloud.ps1` at the repository root. Docker Desktop must have
its Linux engine running. The build uses Rust 1.92.0, locked Cargo dependencies,
Node 22.19.0 and pnpm 10.20.0. It exports Linux x86_64 API/Worker binaries, Node,
Pi production dependencies and templates into
`artifacts/deploy/linux-x64/tomorrow-backend-linux-x64.tar.gz`, with `SHA256SUMS`.
The uncompressed tar is retained locally as an intermediate output.
The script creates an explicit source-only context and also applies a Docker
context allowlist, excluding `.env`, data, APKs, benchmark artifacts and installed
dependencies. Debian 12 binaries target an older glibc
than Ubuntu 24.04. No server-side compilation is needed.

For an API-only update, use `./scripts/Build-Cloud.ps1 -ApiOnly -OutputDirectory
artifacts/deploy/api-update-<unique-id>`. It uses the same Linux Cargo cache and
`--locked`, builds only `tomorrow-api`, and exports `tomorrow-api-linux-x64.tar.gz`
plus `SHA256SUMS`. That small archive contains only `bin/tomorrow-api`; it does
not include Node, Worker, env files or an installer. Verify its checksum and
runtime linkage, stop only the API, preserve the previous API binary, install
the new binary, restart and run health checks. Existing database, uploads,
configuration and other services remain the operator's responsibility.

If Docker Desktop cannot pull public base images directly, the optional
`import-public-image.py` helper can download only the two explicitly allowed
official image tags through a specified local proxy, verify compressed blobs
and uncompressed layer hashes, and import them into the local Docker context.
It needs Python `requests` and never reads Docker credentials. Package downloads
during the build can separately use `-BuildProxy http://host.docker.internal:7897`
when that is the operator's own reachable local proxy. No system proxy settings
are changed by these helpers.

Transfer the **tar package and checksum** and extract it on Linux; the archive
preserves symbolic links and executable modes. Copying an extracted pnpm tree
through a tool that follows/loses symbolic links can break it.
Do not upload the repository `.env`, personal SQLite database or benchmark data.

## Prepare the server

Install PostgreSQL, Nginx, CA certificates, OpenSSL, curl and the ordinary C/C++
runtime libraries (`libc6`, `libgcc-s1`, `libstdc++6`). Run
`sh /path/to/package/verify-package.sh` to check the three binaries and production
Pi imports without model calls, then run `sh /path/to/package/prepare-host.sh`
as root.
It installs root-owned application files to `/opt/tomorrow`, creates the
unprivileged `tomorrow` account and private persistent `/var/lib/tomorrow`,
installs the three systemd units, and creates private env files only if absent.
It generates the internal service token without printing it and never starts
services. Existing env files and application data are preserved.

Provision a dedicated PostgreSQL login/database. Write its password-bearing URL
to `/etc/tomorrow/database.env` using a private server-side operation; keep this
file root-owned and mode 0600. API and Worker load it, Pi does not. The current
SQLx repository initializes business tables on startup. pgvector is not required
for the present application behavior; install it separately before a future
vector-search feature uses it. Do not expose port 5432 publicly.

Configure `/etc/tomorrow/model.env` with the server-side model key. Only the Pi
unit loads it. `/etc/tomorrow/runtime.env` is shared by all three units and holds
the private internal service token and loopback URLs. Keep all three env files
root-owned, mode 0600. Model keys must never be build arguments, command-line
arguments, APK configuration, source files, public URLs or printed diagnostics.
SMS provider credentials and the code hashing key belong in the optional private
`/etc/tomorrow/sms.env`, which only the API unit loads. The shared runtime sets
`APP_ENV=production` and `PHONE_AUTH_MODE=disabled`; real SMS must be explicitly
configured in the API-only env before enabling phone login. Apply an explicit
small trial rolling-24-hour SMS cap (20 sending attempts) in that API configuration.

Optional speech transcription uses `/etc/tomorrow/asr.env`, loaded by the API
unit only. Copy `asr.env.example`, populate its Beijing Model Studio key privately,
and keep it root-owned, mode 0600. The cloud trial uses `qwen3-asr-flash` through
the `qwen_asr` protocol. It limits audio to 7 MiB, provider calls to two concurrent
requests per API process, and attempted calls to 50 globally / 20 per user in a
rolling 24 hours. Reservations survive restarts and failed calls; successful
transcripts are cached. A running request for the same upload returns 429 with
Retry-After. Do not put this key in Pi's model environment or the mobile build.

The minimal RAM send permission is provided in `aliyun-pnvs-send-policy.json`:
`dypns:SendSmsVerifyCode` on `*`. The current backend generates and verifies its
own codes, so it does not need the provider's `CheckSmsVerifyCode` permission.
After a credential identity check, sending permission and delivery still require
one explicitly authorized real SMS test; a valid AccessKey alone does not prove
that the RAM user can send messages.

For a shared-IP trial that currently exposes only HTTP, keep all four public
phone routes (`code`, `register`, `login`, and `password/reset` under
`/v1/auth/phone/`) returning 503 at Nginx while configuring
or testing the real sender through the private loopback API. Confirm these guards
before enabling the API's provider mode. Open public phone authentication only
after a trusted HTTPS route is ready. Read-only health checks can use HTTP.

## Configure the public ingress

Replace `SERVER_NAME` in `templates/nginx.conf` and install it as
`/etc/nginx/conf.d/tomorrow.conf`. Verify Nginx syntax before reloading it.
An existing Nginx default site can win requests sent to the IP address; on a
dedicated empty host disable that unused default site or explicitly select this
server as the sole default before checking the public-IP route. Do not alter
unrelated existing virtual hosts.
The template listens on HTTP port 80; use a trusted provider HTTPS ingress or
configure a certificate-backed 443 server before allowing mobile login. Avoid
exposing an unencrypted password/token endpoint publicly. Confirm the actual
provider's ingress target port, route and certificate rather than assuming it
from the SSH address.

### Verified provider HTTPS route for this trial

The assigned hostname is
`api.example.invalid`. Checks on
2026-10-27 established that its HTTP/HTTPS ingress forwards to **VM port 10014**,
which is separate from the public `149.71.241.13:10029` to VM port 80 mapping.
The assigned HTTPS certificate passed system trust and hostname verification.
Positive/negative protocol checks showed that the ingress overwrites a forged
`X-Forwarded-Proto`: real HTTP with a client `https` value arrived as `http`,
and real HTTPS with a client `http` value arrived as `https`.

For this specific route, replace every `SERVER_NAME` in
`nginx-provider-https.conf` with the exact assigned hostname and install it as
`/etc/nginx/conf.d/zz-tomorrow-provider-https.conf`. It must load after the base
`tomorrow.conf`, which declares the shared query-free `tomorrow` log format and
the `tomorrow_phone`, `tomorrow_phone_auth` and `tomorrow_phone_auth_global`
rate-limit zones. Remove the temporary port-10014 health probe before loading
the final server, then verify syntax before reloading.

The template accepts only the three currently observed ingress peers:
`10.199.87.254`, `10.199.195.111`, and `10.199.127.231`. Other source addresses
receive 403, mismatched or absent Host headers receive 421, and requests whose
verified ingress protocol is not `https` redirect to the fixed assigned HTTPS
hostname. No diagnostic probe headers are exposed.

A second 2026-10-27 check compared 8 baseline health requests with 8 requests
containing forged forwarding headers. The provider preserved forged XFF
prefixes but consistently appended one of the two observed real client egress
addresses as the final `X-Forwarded-For` entry. A client-provided `X-Real-IP`
value was preserved unchanged and is not trustworthy. The template therefore
uses server-level `set_real_ip_from` for exactly the three ingress peers,
`real_ip_header X-Forwarded-For`, and `real_ip_recursive off`: only the last XFF
address supplied by a trusted peer replaces the client address. The ingress
allowlist checks `$realip_remote_addr`, which retains the original TCP peer;
per-client limits use the resulting `$binary_remote_addr`. Only that verified
client address is sent to the API as XFF/X-Real-IP; the untrusted prefix and
the client's `Forwarded` header are discarded.

These addresses are observations for this trial, not a provider guarantee or
permission to trust the entire `10.199.0.0/16` subnet. If ingress addresses,
target ports, certificate handling or forwarded-header behavior change,
recheck them before updating the exact allowlist. Do not reuse this trust
configuration for another provider or a directly exposed application port.
Keep the separate port-80/public-10029 route health-only or otherwise block
authentication and sensitive API traffic there; this template does not secure
a different Nginx server automatically. Its error log is discarded because
standard Nginx request error messages may contain full query strings; use the
query-free access log and API/systemd diagnostics for routine investigation.

Nginx only proxies `/v1/`. All `/internal/agent/*`, Pi and local file paths return
404 through the public proxy. API and Pi listen only on 127.0.0.1. Uploads remain
private and accessible through authenticated API routes. Access logs omit query
arguments so OAuth codes do not enter them. The proxy timeout accommodates the
existing maximum Pi run timeout; upload limits match the default 25 MiB API cap.
The current mobile cloud entry point exposes phone authentication only: the
legacy email/password `/v1/auth/register` and `/v1/auth/login` routes return 404
at Nginx, preventing open email registration from bypassing phone verification.
The private loopback API retains these routes for existing internal tools;
the phone routes, authenticated profile routes and logout remain available.

**The build must include the phone adapter that disables test codes in production.**
Do not deploy an older binary with fixed-code phone login. With SMS disabled the
registration and password-recovery flows cannot send verification codes;
existing accounts with a configured password can still use phone/password
login. Verify an unconfigured phone-code request fails without sending SMS and
that fixed test codes are rejected before enabling a real provider. Public HTTP
may be used to check ingress health, but it is not suitable for actual login or
sensitive data.

### Phone/password account flow

Phone registration verifies an SMS code and sets a login password. Passwords
must contain 8–128 Unicode characters and are used exactly as entered: neither
the client nor the API trims leading or trailing spaces. Subsequent login uses
the phone number and password, without sending or accepting a login SMS code.
The code endpoint accepts only the separate purposes `register` and
`reset_password`; the former `login` SMS purpose is rejected.

Password recovery verifies a code issued for `reset_password` and uses
`POST /v1/auth/phone/password/reset` to set the new password. Successful reset
revokes all existing sessions for that account and does not automatically sign
the user in. The user must log in again with the new password. Legacy phone
accounts that have no password use this same recovery flow to set their first
password. Registration codes and recovery codes are not interchangeable.

All four endpoints are public routes and do not require a bearer token. Their
JSON contract is:

| POST route under `/v1/auth/phone` | Required request fields | Optional fields | Successful response |
| --- | --- | --- | --- |
| `/code` | `phone`, `purpose` (`register` or `reset_password`) | None | `challenge_id`, `expires_in`, `retry_after`, `test_mode` |
| `/register` | `phone`, `code`, `challenge_id`, `password` | `name`, `timezone` | Auth session with `user` and `token` |
| `/login` | `phone`, `password` | None | Auth session with `user` and `token` |
| `/password/reset` | `phone`, `code`, `challenge_id`, `new_password` | None | `{"ok":true}` only |

The old `purpose: "login"` code request returns 422 without sending SMS. A
nonexistent phone number and a wrong login password use the same generic
HTTP 401 `invalid_credentials` error. The API error JSON retains the
`{"error":{"code":"...","message":"..."}}` envelope; quota errors use
`rate_limited` with a positive integer `Retry-After` response header. Never log
passwords, codes, challenge identifiers, or returned session tokens.

In the single API process, all phone-password Argon2 hashing and verification
share **2 CPU permits**. Admission uses an immediate try-acquire: when both are
occupied, the API returns 429 with `Retry-After: 1` instead of queuing more
password jobs. A cancelled asynchronous request does not release its permit
until the corresponding CPU work actually finishes.

Password login also reserves a persistent attempt before verification. Each
normalized phone number allows at most **10 failed or pending verifications in
a rolling 15-minute window**. A successful login removes only its own attempt;
it does not clear other failures or concurrent pending verifications. The
service retains at most **10,000 active login-attempt records**, removing
expired records transactionally during admission. A verified password reset
clears that phone's login attempts to unlock recovery. Session creation checks
the password hash and the reserved attempt again, so an old password check
already in flight cannot establish a session after reset.

Migration `006_phone_password` adds the separate `phone_credentials` table,
the shared password-operation guard and the bounded login-attempt ledger.
Phone passwords are not copied into the legacy email password field: phone-only
users retain its `!phone-only` sentinel, and the public legacy email routes
remain closed. Existing phone accounts acquire their first credential through
verified password recovery. Password replacement, verification-code
consumption, old-session revocation and the recovery unlock commit together;
recovery still returns only `{"ok":true}`.

Before this upgrade, back up the database and preserve the previous binary,
stop the old API, install the new API and apply its startup migration, then
verify the new password routes before using the updated APK. Do not run the
old SMS-login API alongside the new process. Preserve migration 005 and its
SMS-attempt history when applying migration 006; the password upgrade does not
reset SMS quotas or grant new sending capacity.

### SMS controls for phone signup

The selected cloud signup policy allows supported phone numbers to register
without an invitation list. Leave the optional server-side `SMS_ALLOWED_PHONES`
setting unset or empty for that policy. If a future test needs an invitation
list, configure it privately in `/etc/tomorrow/sms.env`; do not publish its
contents or place them in the APK, source, deployment package, logs, or
documentation. Provider keys and the SMS-code hashing key remain in the same
root-owned API-only configuration.

Sending attempts are reserved atomically in the database before contacting the
SMS provider. A reserved attempt still counts if the provider request fails or
its outcome is uncertain. The trial limits are:

- Per phone: at most 1 sending attempt per rolling 60 seconds and 5 per rolling
  24 hours.
- Across the cloud service: at most 3 sending attempts per rolling 60 seconds,
  10 per rolling hour, and 20 per rolling 24 hours (`SMS_DAILY_LIMIT=20`).
- At Nginx, per verified client IP: the code route allows an average of
  3 requests/minute with burst 2; phone registration, password login and
  password reset share one 10 requests/minute bucket with burst 5. The three
  password routes also share a per-virtual-host 30 requests/minute bucket with
  burst 10, bounding distributed password-hashing traffic. All four exact
  routes accept request bodies no larger than 2 KiB and buffer them before
  passing them to the API. Their exact locations take precedence over the
  general `/v1/` proxy. The direct HTTP port-80 template rejects all four
  routes with 503, including password reset.

The attempt ledger is persistent and concurrency-safe. Parallel requests,
process restarts, or a change of date do not reset the rolling windows. API
quota rejections use HTTP 429 with the shared JSON error envelope and a
calculated `Retry-After`; Nginx quota rejections use the same `rate_limited`
error code with `Retry-After: 60`. Upstream API 429 responses are preserved,
so a longer rolling-window retry time is not overwritten by the proxy.

Migration `005_phone_sms_attempts` introduces the persistent attempt ledger.
Legacy aggregate counts do not contain individual send timestamps; their
conservative import uses the import time rather than inventing older send
times that would immediately release quota. For this upgrade, stop the old API
before installing the new binary and applying its startup migration. Do not
run the old and new API concurrently against the same database, delete the
ledger, or clear prior counters to make a test pass. Preserve the database
backup and previous binary for recovery.

Server-verified, single-use CAPTCHA is not implemented yet. The current public
phone-signup protection consists of the per-client, per-phone and persistent
global attempt quotas described above; do not describe this release as
CAPTCHA-protected. The optional phone allowlist remains available for a future
invited test without changing the public signup policy selected for this rollout.

## Start and verify

After private configuration, database initialization, HTTPS and the login policy
are ready:

```sh
systemctl enable --now tomorrow-agent tomorrow-api tomorrow-worker
sh /path/to/package/verify-local.sh
```

Health checks do not invoke the model. Separately verify an isolated user's
registration/login, memory CRUD, one chat, task approval and result persistence.
Confirm unauthorized internal access is rejected and private uploads cannot be
read by another account. Paid model smoke tests require a chosen spending limit.

Logs go to journald (`journalctl -u tomorrow-api -u tomorrow-agent -u tomorrow-worker`)
and the Nginx logs. Log output must not include env file contents or credentials.
Back up PostgreSQL and `/var/lib/tomorrow/uploads` together. Preserve any connector
encryption key with the backup. A new cloud database starts with new accounts;
existing local user data is not silently copied or migrated by this installer.

For updates, stop the three units before replacing files, keep the previous
package and database backup for rollback, install the new package, then restart
and repeat health/smoke checks. The installer does not implement zero-downtime
rollout or transactional database rollback. Configure monitoring, disk/log
retention and backups for the intended server before broader use.
