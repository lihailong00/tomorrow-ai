# Shared client core

This package is consumed by `apps/client` (standalone browser build and the Tauri
desktop frontend). It contains no React, Node, Tauri, localStorage, or OS keyring
dependency. `src/index.ts` is the public export surface. DTOs follow the Rust v1
API and retain snake_case wire names.

## Account and server lifecycle

Create `new ApiClient(serverUrl, {token, transport, expectedInstanceId,
allowInsecureLan, onUnauthorized})`. `inspectInstance()` makes an anonymous
`GET /v1/instance` request and pins the public instance ID. Password-bearing and
authenticated requests recheck it before credentials are sent. It detects normal
server replacement; it is not cryptographic server attestation. HTTPS provides
transport authentication. No invalid-certificate or redirect bypass is present.

Call `dispose()` synchronously when logging out or switching server/account, then
discard that client's page/cache state. Disposal aborts requests and rejects late
results. Construct a new client for the new account. The caller owns credential
storage: browser tokens remain in memory; desktop sessions use the OS keyring
namespaced by canonical server origin **and confirmed instance ID**. Neither this
package nor the browser transport persists tokens, passwords, or conversation
data.

`normalizeServerUrl()` accepts a bare origin, tolerating a trailing `/v1`. HTTPS is
required except loopback HTTP. Private LAN HTTP needs explicit
`allowInsecureLan: true`; public HTTP is rejected. The selected server is never
silently replaced with the official service or a proxy.

## Transports

`createFetchTransport()` uses browser streaming fetch, no cookies, no redirects,
and bounded JSON/error buffering. `createDesktopTransport(bridge)` injects Tauri
commands/channel objects from the desktop frontend without importing Tauri into
the browser bundle. Each transport must reject redirects and emit `onChunk` only
for successful `text/event-stream` responses. UTF-8 decoding preserves codepoints
across byte boundaries. Native byte channels have headers/chunk/end events and
an explicit request ID for cancellation.

## Durable chat semantics

`chatStream(intent, onEvent, {signal,lastEventId,retry})` posts the actual
`/v1/chat/stream` endpoint. Preserve the **same immutable ChatIntent and
client_request_id** for reconnection. Send `Last-Event-ID` for the sequence cursor;
`X-Chat-Retry: 1` is sent only for an explicit retry. A transport disconnect never
automatically creates another model turn.

`initialChatStreamState()` / `reduceChatStream()` handle snapshot replacement,
duplicate event suppression, real delta append/replace, tool status, terminal
reply and interrupted-prefix preservation. The parser bounds one event rather
than retaining the full incoming stream. Truncated connections reject instead
of declaring partial replies complete.

**Abort stops receiving on this client.** The existing backend's producer is
durable and may continue running. There is no server stream-cancellation endpoint;
UI must not claim that a local AbortSignal cancels remote tool side effects.

## Existing endpoints covered

- Phone/password and email/password login; `me` and logout. No SMS login.
- Instance metadata and health.
- Paginated conversations and messages (`before` cursor preferred for older
  message pages, chronological items within each page); deletion of a user turn.
- Today briefing and briefing task polling.
- Paginated todo list; create/update/delete and explicit preparation. PATCH uses
  the current server `version`, preserving optimistic-concurrency conflict errors.
- Paginated memory list; create/update/delete, including current version.

This first API surface does not claim to port mobile phone integrations, audio
capture, multipart file uploads, vault cryptography or every admin endpoint.

## Checks

From `packages/client-core`, reusing the designated frontend dependency install:

```powershell
& ../../apps/client/node_modules/.bin/tsc.cmd --noEmit -p tsconfig.json
& ../../apps/client/node_modules/.bin/vitest.cmd run --root .
```

Tests cover origin policy, identity replacement before credentials, disposal and
late results, backend error propagation, fragmented UTF-8/SSE framing, snapshot
replay, explicit durable retry headers, stream truncation and native abort.
