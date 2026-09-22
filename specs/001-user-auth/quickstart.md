# Quickstart and Validation: User Authentication

The authentication feature is implemented. Use this guide to run it and reproduce validation. See [validation.md](validation.md) for actual results and the acceptance gates that remain open.

## Prerequisites and safe setup

Use Node.js 22.23.2 or a compatible maintained Node 22 release and npm. Commands below run in PowerShell from the repository root. Use a separate data directory so verification never modifies the existing feed. Run one server process against each data directory. Reserve approximately 1 GiB or more for the application/crypto workload and measure actual usage.

```powershell
Set-Location simple-posts
npm ci
npm test
$env:DATA_DIR = Join-Path $env:TEMP ('cyberfeed-auth-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:DATA_DIR | Out-Null
Copy-Item -LiteralPath (Join-Path $PWD 'data/posts.json') -Destination (Join-Path $env:DATA_DIR 'posts.json')
$env:PORT = '3000'
$env:APP_ORIGIN = 'http://localhost:3000'
$env:UV_THREADPOOL_SIZE = '8'
npm start
```

Available commands: `npm test` → `node --test`, `npm run benchmark:auth` → `node tools/benchmark-auth.js`, and `node tools/browser-check.js` for real headless Edge checks. Default DATA_DIR is simple-posts/data; tests always override it. The app factory accepts injected clock/write behavior only for in-process tests. The benchmark and browser checks create and dispose their own isolated server/data directories, leaving live data untouched. The benchmark relaunches with UV_THREADPOOL_SIZE=8 before initializing crypto/IO.

The browser check defaults to installed Microsoft Edge on Windows. Set BROWSER_PATH to another Chromium executable if needed. It may require running outside an execution sandbox that prevents browser rendering. All browser accounts are disposable fixtures; no real credentials are used. Test artifacts are saved under `specs/001-user-auth/artifacts/`.

Open http://localhost:3000. APP_ORIGIN must match the address exactly; localhost and 127.0.0.1 are different origins. For production set NODE_ENV=production and APP_ORIGIN to the deployed HTTPS origin; require Secure cookies and correct trusted TLS configuration.

## Browser acceptance

1. As a visitor, verify existing posts remain readable and publication requires sign-in.
2. Register a new valid username with a 15–128-character password. Expect success and the sign-in form, not automatic login. Try an Arabic username too.
3. Try the same name with English case changes and outer spaces. Expect an unavailable-name message. Try length/character boundaries described in [data-model.md](data-model.md).
4. Sign in correctly; verify the username and composer appear. Refresh; the same account remains signed in.
5. Publish a draft; verify the server-assigned username. Sign out in another tab; the first tab must no longer be able to publish through the old session.
6. While a draft is present, interrupt the network and attempt publication; reconnect and verify the draft remains. Check the feed before retrying an uncertain publication. Repeat for expired-session handling using the automated clock scenario rather than waiting 24 hours.
7. Verify keyboard navigation, password masking/autocomplete, announced errors and narrow-screen layout. Do not store passwords or cookie tokens in browser storage.

See [UI contract](contracts/ui.md) for exact state transitions and [HTTP contract](contracts/http-api.md) for status codes and payloads.

## HTTP smoke checks

In a second PowerShell terminal, while the isolated development server is running:

```powershell
$baseUri = 'http://localhost:3000'
$requestHeaders = @{ Origin = $baseUri; 'X-CyberFeed-Request' = '1' }
$credentials = @{ username = ('verify_' + [guid]::NewGuid().ToString('N').Substring(0,8)); password = 'Demo password 2026!' } | ConvertTo-Json
Invoke-RestMethod -Uri ($baseUri + '/api/posts')
Invoke-RestMethod -Method Post -Uri ($baseUri + '/api/auth/register') -Headers $requestHeaders -ContentType 'application/json' -Body $credentials
Invoke-RestMethod -Method Post -Uri ($baseUri + '/api/auth/login') -Headers $requestHeaders -ContentType 'application/json' -Body $credentials -SessionVariable browserSession
Invoke-RestMethod -Uri ($baseUri + '/api/auth/me') -WebSession $browserSession
Invoke-RestMethod -Method Post -Uri ($baseUri + '/api/posts') -Headers $requestHeaders -ContentType 'application/json' -Body '{"text":"Authentication validation post"}' -WebSession $browserSession
Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($baseUri + '/api/auth/logout') -Headers $requestHeaders -ContentType 'application/json' -Body '{}' -WebSession $browserSession
```

Expect registration 201, login/me 200, post 201 with the account's userId/name and logout 204. Following /me or publication through the old token must return 401. Error-status assertions are performed by automated tests because Invoke-RestMethod throws on non-success responses.

## Automated coverage required

| Area | Required verification |
| --- | --- |
| Validation/secrets | Boundaries 2/3/30/31 name characters and 14/15/128/129 password characters; Arabic and spaces; exact password matching; no verifier/token/password in public JSON/logs |
| Uniqueness | Twenty simultaneous registrations of one canonical name yield one account/201 and nineteen 409 |
| Request security | Foreign/missing/null Origin, missing custom header and wrong content type rejected; supplied author fields rejected; cookie flags checked in development and production configurations |
| Sessions | Exact 24-hour expiry using injected clock; invalid token; session replacement; revocation across tabs; stale-token reuse; concurrent logout/post commit ordering |
| Throttle | Failures 1–5 return generic 401; sixth returns 429; same behavior for unknown names; concurrent requests cannot bypass; just before/at 15-minute expiry; independent names; success resets count |
| Persistence | Accounts and sessions survive restart; throttling survives restart; duplicate remains unavailable; failed write/rename cannot publish partial state or success; corrupt file fails startup without overwrite |
| Compatibility | Legacy posts preserve id/name/text/created_at and no automatic owner link; new posts derive author from session |
| Failure UX | 401/503/network failure preserve draft; failed logout does not falsely announce success; publication retries are manual |

## Performance and usability gates

```powershell
npm run benchmark:auth
```

Benchmark must use real scrypt settings, capture host Node/CPU/RAM, run 20 distinct-user registrations and then 20 concurrent valid logins, and repeat at least five rounds with fresh names. Report registration and login p95 separately, total successes/failures, queue time and peak resident memory. HTTP timing includes queuing and persistence; an endpoint-only pass is supporting evidence, and browser measurement on a stable connection must confirm the user-visible two-second target. Fail on unexpected errors or p95 >= 2000 ms. Do not count throttled/busy rejections as successful fast responses.

If the gate fails, record results and adjust deployment capacity while preserving crypto parameters; do not declare SC-002 passed. Separately observe ten new users completing account creation and first login: at least nine must succeed without help within two minutes (SC-001). Record anonymized completion times.

SC-003–SC-006 map to the uniqueness, session/ownership, persistence and throttle checks above and have automated evidence in validation.md. The current local benchmark exceeded the two-second SC-002 target despite no request failures; SC-001 still requires real participants. Neither gate should be marked passed without new evidence.
