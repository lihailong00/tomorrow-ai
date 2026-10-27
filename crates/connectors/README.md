# Google read-only connectors

This Rust crate exposes authenticated `/v1/connectors` routes for Google Calendar,
Gmail and Google Drive metadata. It does not implement external write operations.

Configure server-side variables (never place these in a mobile bundle):

- `GOOGLE_CLIENT_ID`: a Google OAuth **Web application** client.
- `GOOGLE_CLIENT_SECRET`: that client's secret.
- `GOOGLE_REDIRECT_URI`: the exact authorized server callback URL ending in
  `/v1/connectors/google/callback`; HTTPS in deployment, HTTP only for loopback
  development. The app opens the authorization URL in the system browser.
- `CONNECTOR_ENCRYPTION_KEY`: 32 random bytes represented as 64 hexadecimal digits.
  Preserve this key with the database; changing it requires reconnecting accounts.

Enable the three relevant Google APIs and configure the consent screen/test users
in the same Google Cloud project. Sensitive/restricted scopes can require Google
verification before public use; test-mode refresh credentials may expire. No real
Google account authorization has been performed in this environment.

Each service requests its own scope:

| Service | Scope |
| --- | --- |
| `google_calendar` | `calendar.events.readonly` |
| `gmail` | `gmail.readonly` |
| `google_drive` | `drive.metadata.readonly` |

Authorization state has 256 bits of randomness, is stored only as a SHA-256 digest,
expires after ten minutes and is atomically consumed. PKCE uses S256. PKCE
verifiers and access/refresh tokens are encrypted with AES-256-GCM, including
authenticated user/service/purpose binding. An account generation counter prevents
late callbacks and refresh responses from recreating a disconnected account.

`GET /v1/connectors` returns connection status. Authorize via
`POST /v1/connectors/{id}/authorize`, then return to the app and reload status.
`DELETE /v1/connectors/{id}` clears local access before attempting revocation.
Google revocation can invalidate all scopes for the Google project; when confirmed,
all this user's local Google connections are cleared and the response explicitly
returns `disconnected_ids` and a human-readable detail. If remote revocation fails,
the selected local connection still stays disconnected.

Read endpoints return `{items:[{id,title,preview,date,link}],next_page_token}`:

- `GET /v1/connectors/google_calendar/events`: upcoming events in the primary calendar.
- `GET /v1/connectors/gmail/messages`: message subjects/from/snippets and metadata;
  no full bodies or attachments.
- `GET /v1/connectors/google_drive/files`: names, descriptions, MIME types and modified
  timestamps; no file contents or downloads.

Use `page_size=1..100` (default 20) and optional `page_token`. Tokens, raw Google
errors and credentials never appear in responses. HTTP access logs must record the
callback **path only**, since its query contains an authorization code and state.

Official references checked on 2026-10-26:

- [Google web-server OAuth and token revocation](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google PKCE parameters](https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier)
- [Calendar events list](https://developers.google.com/calendar/api/v3/reference/events/list)
- [Gmail messages list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail messages metadata](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Drive files list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)

The SQLite tests exercise isolation, state expiry/single use, ciphertext binding,
explicit unavailable configuration, real local-HTTP refresh and revocation errors.
They are contract tests, not verification against a signed-in Google account.
