# HTTP Contract: Authentication and Posts

Base URL: same origin as the application. All timestamps use UTC ISO 8601. JSON request bodies are objects, maximum 20 KiB. Errors retain the existing `error` string and add a stable `code`: `{"error":"...","code":"INVALID_CREDENTIALS"}`. Optional field errors are limited to username/password/text validation; never echo passwords.

## Shared rules

- All POST requests require `Content-Type: application/json`, `X-CyberFeed-Request: 1`, and `Origin` exactly equal to configured `APP_ORIGIN`. Reject absent, null, malformed or foreign Origin with 403; do not infer allowed origin from Host. CLI/tests supply these headers. Do not enable cross-origin credentials/CORS.
- Missing custom header returns 403; wrong content type 415; oversized body 413; invalid JSON/object or fields 400. Apply these rules before credential work. Treat fields not listed in a request as invalid, including supplied author fields on post creation.
- Auth responses and all errors use `Cache-Control: no-store`. Use JSON error handling for malformed payloads and operational failures.
- Cookie `cyberfeed_session`: opaque 32 random bytes encoded base64url; HttpOnly; SameSite=Lax; Path=/; no Domain; Max-Age=86400. Secure is required outside local HTTP development. Clear using the same attributes and Max-Age=0.
- Production requires an HTTPS APP_ORIGIN and a trusted TLS termination configuration; do not trust arbitrary forwarded headers. Local default is `http://localhost:3000`.
- Server checks the persisted session on every protected action. Cookie presence alone never proves authentication. Raw tokens and password verifiers never appear in response bodies or logs.
- Allow at most four active scrypt operations and 64 waiting; excess work returns 503 `AUTH_BUSY` with Retry-After. This resource protection does not replace per-name lockout.

## Endpoints

| Method / path | Body | Success | Expected errors |
| --- | --- | --- | --- |
| POST /api/auth/register | `{username,password}` | 201 `{user:{id,username}}`; no login cookie | 400 VALIDATION_ERROR; 409 USERNAME_TAKEN; 503 STORAGE_UNAVAILABLE/AUTH_BUSY |
| POST /api/auth/login | `{username,password}` | 200 `{user:{id,username},expiresAt}` and session cookie | 400 VALIDATION_ERROR; 401 INVALID_CREDENTIALS; 429 LOGIN_THROTTLED; 503 STORAGE_UNAVAILABLE/AUTH_BUSY |
| GET /api/auth/me | none | 200 `{user:{id,username},expiresAt}` | 401 AUTH_REQUIRED for missing/invalid/expired session |
| POST /api/auth/logout | `{}` | 204, empty body, clear cookie; repeat logout also 204 | 503 STORAGE_UNAVAILABLE if revocation cannot be saved |
| GET /api/posts | none | 200 array of public posts; no login required | 503 STORAGE_UNAVAILABLE |
| POST /api/posts | `{text}` | 201 public post attributed to current user | 401 AUTH_REQUIRED; 400 VALIDATION_ERROR; 503 STORAGE_UNAVAILABLE |

Credential shape validation is identical for existing/unknown accounts. INVALID_CREDENTIALS always uses the same public message, including when the fifth failure starts the block. LOGIN_THROTTLED includes Retry-After in whole seconds rounded up and a generic retry message; it does not disclose account existence. Existing names may be revealed by registration's required availability feedback, but not by differing login error details.

Public post: `{id,name,text,created_at,userId}`, userId is a UUID for new posts or null for legacy posts. Do not allow a request to set any field except text. Authenticate before validating the post's fields after shared request checks.

## Consistency and failure semantics

- 201 register only after the account commit; 20 concurrent requests for one canonical username yield one 201 and nineteen 409 when otherwise valid and within capacity.
- 200 login only after session insertion and attempt reset commit; failed persistence never issues a cookie.
- 204 logout only after known-session deletion commits. If storage fails, return 503 and do not claim logout succeeded. Missing/expired cookies can be cleared idempotently.
- Posting and logout share commit ordering. Revalidate the session at post commit; any post ordered after revocation fails 401.
- A lost response after a successful write is an uncertain outcome: UI instructs checking the feed before retrying publication. No automatic retries of POST; duplicate-proof publication is outside this feature.
- Reads of old posts preserve id/name/text/created_at. GET may map missing userId to null in the response without modifying the file.

