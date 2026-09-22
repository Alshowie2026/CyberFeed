# Research: User Authentication

**Date**: 2026-09-21  
**Status**: Complete; implementation validation remains future work.

## Existing application and runtime

**Decision**: Extend `simple-posts/` using JavaScript CommonJS, Express 5, existing HTML/CSS/browser JavaScript, and Node 22 built-ins. Local inspection found Node 22.23.2 and installed Express 5.2.1 (application manifest ^5.1.0).

**Rationale**: The app currently exposes public GET/POST /api/posts, accepts a caller-supplied name, stores a JSON array, and has no auth/tests. Keeping this structure limits changes and preserves the feed.

**Alternatives considered**: A new frontend framework or external identity provider adds migration/integration work unrelated to the requested username/password flow.

## Password verification and capacity

**Decision**: Async Node scrypt with N=131072, r=8, p=1, keyLength=64, random 16-byte salts and maxmem=256 MiB. Version verifier records, use equal-length timingSafeEqual, and perform a same-cost dummy derivation for unknown names. Preserve password input exactly. Limit to four active derivations and 64 waiting; return generic 503 with Retry-After when capacity is exhausted.

**Rationale**: Node supplies scrypt, random generation and constant-time comparison, avoiding an added native dependency. OWASP lists the selected N/r/p profile for scrypt. Each active derivation needs roughly 128 MiB; four can need roughly 512 MiB plus application overhead. These are design estimates, not measured latency. Sources: [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

**Alternatives considered**: Argon2id is a strong alternative but adds a dependency for this Node 22 application. Plain hashes are inappropriate for password storage. Synchronous derivation would block request handling.

**Performance resolution**: SC-002 remains an implementation acceptance gate. Benchmark 20 distinct users on the intended deployment host, recording CPU/RAM and p95 including queue time. Node crypto and filesystem work share the worker pool; start the application with UV_THREADPOOL_SIZE=8 while retaining the four-derivation application limit to leave room for IO. Increase deployment capacity if necessary; do not weaken the crypto profile to manufacture a passing result. [Node worker pool setting](https://nodejs.org/api/cli.html#uv_threadpool_sizesize).

## Persistence and concurrent requests

**Decision**: Keep posts.json and add versioned auth.json storing users, hashed sessions and attempt windows. Use one short mutation queue, per-name login sequencing, and same-directory flushed temporary writes followed by rename. Do not hold the global queue during scrypt. Recheck uniqueness and authorization at commit.

**Rationale**: The existing app already serializes post writes. Extending that pattern fits one-process deployment; replacing the existing copy-over approach avoids writing partially updated JSON over live files. Failed writes do not publish in-memory state. The Node filesystem docs describe flush support and caution against overlapping writes. The choice of a queue and replacement protocol is our design inference. [Node filesystem](https://nodejs.org/docs/latest-v22.x/api/fs.html).

**Alternatives considered**: SQLite would provide transactional uniqueness and multiple-process coordination, but introduces a storage migration/dependency for this small app. JSON is explicitly limited to one process and local storage. Direct copy-over is rejected because a failed copy can damage the active file. Hard-power-loss durability is not guaranteed by the selected portable protocol.

## Cookie sessions and request security

**Decision**: Fresh 32-byte opaque random tokens per login; persist only their SHA-256 hashes. Enforce fixed 24-hour expiry and persisted revocation. Use HttpOnly, SameSite=Lax, Path=/, no Domain and Secure in production. Require configured exact Origin, JSON content type and X-CyberFeed-Request:1 for every POST, including login, with no cross-origin CORS allowance.

**Rationale**: Opaque server-side sessions make logout immediately enforceable; origin and custom-header checks protect same-origin browser mutations, including login. The raw token is never available through response JSON or browser storage. Sources: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

**Alternatives considered**: Stateless tokens complicate immediate revocation. SameSite alone is not the selected CSRF defense. A separate synchronizer token would be suitable for server-rendered form submissions, but the current app uses same-origin JSON fetch requests.

## Name equivalence, throttling and legacy ownership

**Decision**: NFC and outer trim for names, ASCII case folding for their unique key; allow Arabic letters, English letters, defined digit sets and underscore. Passwords are never normalized. Use a persisted rolling 15-minute failure window, fifth-failure block for 15 minutes, and per-key serialization. New posts contain immutable userId; legacy entries are never matched to accounts by name.

**Rationale**: Explicit rules resolve edge cases and make uniqueness and lockout testable. Persistent throttle state cannot be cleared by restarting the process. A matching old display name is not proof of authorship.

**Alternatives considered**: Case-sensitive usernames conflict with the spec. Broad normalization of Arabic letters would collapse distinct names beyond the requested rules. A global login queue would unnecessarily serialize unrelated users; a global block would penalize all users.

## Validation approach

**Decision**: Use node:test, assert, real local HTTP/fetch, isolated temp directories and injected time/write failures. Add a standalone 20-user benchmark and manual browser/usability checks; no test code is generated during planning.

**Rationale**: The critical behaviors are persistence, concurrency, expiry, request security and browser state. Tests must exercise those boundaries and production crypto parameters, not just duplicate helper logic.

**Alternatives considered**: Introducing a test framework or browser automation dependency is not necessary for this initial scope. Manual-only validation would miss races and failure boundaries.

## Resolved planning questions

| Question | Resolution |
| --- | --- |
| Who creates accounts? | Self-registration, per spec assumption |
| What is protected? | Publishing; feed stays public |
| How are names compared? | Documented NFC + trim + ASCII case folding |
| What survives restart? | Users, sessions and lockout state; old posts remain |
| What happens to drafts? | Retained in current page across failed submission and re-login |
| How is development configured? | Explicit local APP_ORIGIN, port and DATA_DIR; HTTPS/Secure for production |
| Is there a real branch? | No .git exists; setup-plan's 001-user-auth is feature state |
| Any mandatory hooks or governance rules? | No extensions.yml; constitution is an unfilled template |

Research was split between an authentication/security research agent and local review of storage, project integration and contracts. No unresolved design clarifications remain.

