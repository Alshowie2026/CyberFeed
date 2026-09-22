# Implementation Validation: 001-user-auth

**Reviewed**: 2026-09-21  
**Status**: Feature implementation and functional validation complete; **36/38 tasks complete**. T036 and T037 remain open. This report does not claim full acceptance.

## 1. Spec Kit task audit

[Tasks](tasks.md) and all design artifacts were checked against the implementation. T001–T035 and T038 are complete. All three user stories are implemented: account registration, sign-in/sign-out, and authenticated publishing.

| Remaining task | Evidence / reason | What completes it |
| --- | --- | --- |
| T036 / SC-002 | Current local 20-user load test exceeded the two-second p95 target | Meet the target on the intended deployment host, including user-visible browser timing, while retaining the selected crypto profile |
| T037 / SC-001 | No ten-person study was performed; no participant results supplied | Observe ten new users; at least nine complete registration and first login without help within two minutes |

The requirements checklist remains unchanged and passed 16/16 checks. It is a specification-quality gate, not implementation evidence. No extensions.yml exists, so no before/after implementation hooks apply. The constitution is an unfilled template with no additional ratified rules.

## 2. Created and updated files

Classification uses the pre-implementation file inventory from this session, since there is no Git baseline.

| Classification | Files | Purpose |
| --- | --- | --- |
| Updated application | [package.json](../../simple-posts/package.json), [server.js](../../simple-posts/server.js) | Test/benchmark scripts, isolated app factory, configuration, auth routes and protected publishing |
| Updated UI | [index.html](../../simple-posts/public/index.html), [app.js](../../simple-posts/public/app.js), [style.css](../../simple-posts/public/style.css) | Registration/login/logout, account state, trusted authorship, retained drafts and responsive layout |
| New runtime modules | [store.js](../../simple-posts/lib/store.js), [auth.js](../../simple-posts/lib/auth.js), [request-security.js](../../simple-posts/lib/request-security.js) | Serialized atomic replacement, scrypt, persistent sessions/attempt windows, request and cookie rules |
| New tests | [store.test.js](../../simple-posts/tests/store.test.js), [auth.test.js](../../simple-posts/tests/auth.test.js), [posts-auth.test.js](../../simple-posts/tests/posts-auth.test.js), [helpers.js](../../simple-posts/tests/helpers.js) | Real HTTP, race/failure/time-boundary checks, isolated data fixtures |
| New verification tools | [browser-check.js](../../simple-posts/tools/browser-check.js), [benchmark-auth.js](../../simple-posts/tools/benchmark-auth.js) | Real headless Chromium flows and reproducible 20-user load |
| New run documentation | [README.md](../../simple-posts/README.md) | Startup, configuration, tests and known limits |
| Updated Spec Kit documents | [tasks.md](tasks.md), [quickstart.md](quickstart.md), [plan.md](plan.md) | Actual task state, runnable guide and implemented file inventory |
| New verification evidence | This report, [test-results.tap](artifacts/test-results.tap), [benchmark.json](artifacts/benchmark.json), [browser-mobile.png](artifacts/browser-mobile.png) | Auditable functional results, measured load and mobile screenshot |

The original `simple-posts/data/posts.json` is unchanged. SHA-256 before and after:
`A27EC33D59BF5B54653A8FE05A4AAD31BF3D3927B493012805CC2F4BD765A911`.

No real accounts or sessions were added to the application's data directory. All tests, browser checks and benchmarks used disposable OS temporary directories. The lockfile and root package.json were not changed; no runtime dependencies were added. The package is private, and no Docker/lint/format/publishing infrastructure was found, so there were no applicable ignore-file updates.

## 3. Git audit

Git 2.55.0.windows.1 is installed. Both workspace-root and simple-posts `git rev-parse --is-inside-work-tree` checks failed because neither is a repository. There is no branch, diff, status, commit or PR to report. No repository was initialized. Spec Kit's `001-user-auth` identifier is feature state, not an actual Git branch.

## 4. Current tests

| Check | Result |
| --- | --- |
| Syntax checks for application, modules, tests and tools | PASS |
| `npm test` / `node --test` | **23 tests passed; 0 failures**, final recorded run about 29.8 seconds |
| `node tools/browser-check.js` | PASS in real headless Edge, outside sandbox with approval |
| `npm run benchmark:auth` | **FAIL latency gate**, exit 1; **200/200 requests succeeded**, no errors |

The TAP artifact records the final full server run. Browser checks exercised account creation, password clearing, sign-in, page reload, cross-tab logout, failed-logout feedback, publication under the account name, offline draft retention, 24-hour expiry/re-login, failed-save draft retention, keyboard Tab navigation, narrow-screen overflow, HttpOnly cookies and absence of stored browser credentials. The screenshot was visually inspected.

A browser test initially interacted before deferred application JavaScript was ready; the harness now waits for page/script readiness. It also brings the relevant tab forward before keyboard/screenshot operations. Those harness issues were corrected and the final full browser run passed.

### Requirement evidence

| Requirements / outcome | Verification |
| --- | --- |
| FR-001–FR-003 / SC-003 | Registration boundaries, Arabic/NFC/case rules, duplicate names, 20 concurrent registrations with exactly one account |
| FR-004–FR-005 | Real scrypt, exact passwords including Arabic/spaces, generic credential errors, public field projection, secret-free errors/logs |
| FR-006–FR-007 | Cookies, session replacement, restoration/restart, exact expiry, revocation/reuse and two-tab browser flow |
| FR-008–FR-010 / SC-004 | Public reading, denied unauthenticated/expired/revoked publishing, rejected author input, trusted account identity, deterministic logout/post ordering |
| FR-011 / SC-005 | Restart, failed write/rename rollback, corrupt-file rejection, unchanged legacy posts and original file hash |
| FR-012 / SC-006 | Fifth/sixth attempt boundary, rolling 15-minute window, exact unblock time, concurrent failures, unknown names and restart persistence |
| FR-013 | Browser failures preserve drafts, sign-in state on failed logout, understandable feedback, no automatic publication retries |
| Capacity | Four active hash jobs plus 64 queued; HTTP overload returns 503/Retry-After, queue recovers after errors |
| Request security | Origin/custom-header/content-type validation, body limits and invalid JSON/encoding handling; private data directory rejected under public |
| SC-001 | OPEN: real participants required |
| SC-002 | OPEN: measured latency exceeds target |

Tests were written and observed failing before the corresponding storage, registration, session and posting implementations. The initial failures were missing modules/routes or absent authorization behavior, followed by passing implementation checks.

### Latest performance measurement

From [benchmark.json](artifacts/benchmark.json), measured at 2026-09-21T13:34:29.074Z:

- Host: Windows, Node v22.23.2, Intel Core i7-10850H, six reported logical CPUs, about 32 GiB RAM.
- Five rounds, each with 20 distinct-user registrations followed by 20 simultaneous valid logins.
- Registration p95: **2705.83 ms**.
- Login p95: **2822.19 ms**.
- Hash queue p95: **2153.58 ms**; peak process RSS approximately **599.67 MiB**.
- UV_THREADPOOL_SIZE=8, four active hash jobs, scrypt N=131072/r=8/p=1/keyLength=64 throughout.
- The benchmark was rerun after the final server review, separately from functional tests to avoid load contamination.

The eight-thread IO/crypto pool and four-job memory bound are already applied. Most tail latency is queue waiting; the test establishes a current-host capacity limit, not a functional request failure. Crypto cost was not lowered and successful requests were not selectively excluded to pass the target. The intended deployment hardware has not been confirmed; target-host and concurrent user-visible timing remain part of T036.

## Follow-up UI update

Implemented the requested top navigation with app name, username/Exit or Login, moved the composer below the feed, and applied a responsive dark cybersecurity-inspired theme. Updated the existing browser check to open the account panel through navigation and verify both navigation states and feed/composer document order. The full browser flow passed again, including keyboard navigation, logout across tabs, draft preservation and narrow-screen overflow. Desktop and mobile screenshots were visually inspected. Server logic was unchanged by this UI update.

See [desktop screenshot](artifacts/browser-desktop.png) and [mobile screenshot](artifacts/browser-mobile.png).

## Run

The subsequent composer refinement keeps the field visible to everyone and expands it on focus or the Expand button. The real-browser check passed guest drafting, collapsing without data loss, login-to-publish with the draft retained, and collapse after successful publication, alongside the existing authentication and failure checks.

From `simple-posts/`, run `npm start` and open http://localhost:3000. See the [quickstart](quickstart.md) for isolated validation, production HTTPS/origin configuration and the remaining acceptance checks.
