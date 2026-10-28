# Streaming chat and long conversation rendering

The Android client immediately adds the submitted user message and an assistant placeholder, then clears the submitted text and attachments. The composer stays editable. A failed reply retains its text and offers Retry on that reply; retrying does not submit the new draft. Loaded history remains available while React Native mounts a bounded window of message rows.

## Public stream

`POST /v1/chat/stream` uses Bearer authentication and `Content-Type: application/json`. Its JSON input is the same as `/v1/chat`, but `client_request_id` is required. Keep the original message, conversation ID (including an original null ID), attachment IDs and remember choice unchanged on every reconnect or retry. Reusing a request ID with different input is a conflict.

Responses use `text/event-stream`, `Cache-Control: no-cache, no-store` and `X-Accel-Buffering: no`. Each event has a numeric `id`, an event name and a JSON `data` object. The first event is an authoritative `snapshot`, including the durable sequence, attempt, accepted message IDs, current text, status and active tool. It may already contain the completed response; clients must accept completion from this snapshot without waiting for a separate `done` event.

Subsequent events include `accepted`, `text_start`, `text_delta`, `tool_start`, `tool_end`, `retrying`, `done` and `error`. Apply deltas once, in sequence. A gap requires reconnection for a new snapshot. Tool events describe actual execution; they do not expose tool arguments or private model reasoning. Text comes from actual upstream content deltas, with no completed-response typing animation.

`Last-Event-ID` may contain the last received nonnegative sequence. Reconnection returns a current snapshot and follows the same durable attempt; it does not start a second model run. The native Android transport uses incremental XHR progress because React Native's fetch text response is buffered. Transport buffers, retained event history, generated text and run lifetime are bounded.

## Disconnects and retries

The producer continues after a subscriber disconnects. Current text and state are checkpointed in the database, so a new connection can catch up. An interrupted or expired attempt preserves partial text and stable conversation, user-message and assistant-message IDs.

Only an explicit user Retry sends `X-Chat-Retry: 1`. The server atomically acquires the next attempt, revokes the previous attempt's write capability and reuses the request's accepted IDs and operation journal. Old producer callbacks cannot commit into the new attempt. The old partial text remains available as `previous_content`; the first new text delta has `replace: true`, after which deltas append normally. Starting a retry may incur a new model charge.

New streaming Pi runs use an opt-in global mutation slot alongside the existing per-tool operation index. Business effects and both replay receipts commit in the same transaction. Replaying a slot with different tool or arguments fails closed. Existing runs with unjournaled legacy operations cannot silently upgrade into this mode. This protects stored tasks, memories and schedules; any future external side effect must implement equivalent idempotency before it is exposed as a mutation tool.

## Deployment and verification

Deploy Rust API and Pi together before releasing a client that requires streaming. Existing `/v1/chat` clients retain their JSON behavior. Reverse proxies must pass streaming responses without buffering or compression delays and allow the bounded stream lifetime. Credentials stay on the server, and the client verifies the selected server identity before sending authenticated stream requests.

Acceptance must demonstrate a first visible user message before the model finishes, an upstream-gated first text fragment, actual tool transitions, a dropped connection reattaching to one producer, explicit retry preserving IDs with one committed effect, and account/route changes rejecting late updates. Native long-conversation checks must also load every history page, verify anchors and drafts across History/Back, and measure memory and waiting on the same APK and fixture. Unit tests alone do not establish native list correctness.
