# CyberFeed

Public post feed with username/password accounts. Sign in to publish under your account name.

## Run

From this directory, with Node.js 22.23.2 or compatible Node 22:

```powershell
npm ci
$env:UV_THREADPOOL_SIZE = '8'
npm start
```

Open http://localhost:3000, choose **Create account**, then **Sign in**. Usernames are 3–30 Arabic/English letters, digits or underscores; passwords are 15–128 characters, with spaces preserved.

Existing posts remain intact. New accounts, hashed session tokens and login-attempt windows are stored in data/auth.json on first launch; passwords are stored as salted scrypt verifiers. Do not place the data directory inside public or share one directory between multiple server processes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| PORT | 3000 | Listener port |
| APP_ORIGIN | http://localhost:PORT | Exact browser origin accepted for POST |
| DATA_DIR | data beside server.js | Private persistent data directory |
| NODE_ENV | development | Set production to require an HTTPS origin |
| UV_THREADPOOL_SIZE | Node default unless set | Use 8 before startup, with four bounded hash workers |
| BROWSER_PATH | Microsoft Edge Windows path | Optional executable for browser checks |

Production needs HTTPS/TLS termination, APP_ORIGIN matching the public address and private filesystem access to data. Cookies are HttpOnly, host-only and Secure outside local HTTP development. Sessions expire after 24 hours; five failed attempts for a name within 15 minutes block further attempts for 15 minutes.

## Verify

```powershell
npm test
node tools/browser-check.js
npm run benchmark:auth
```

All checks use temporary data. The benchmark exits nonzero when p95 meets/exceeds two seconds or any request fails; the current machine has not met the latency target. See [the verification report](../specs/001-user-auth/validation.md) and [detailed validation guide](../specs/001-user-auth/quickstart.md).
