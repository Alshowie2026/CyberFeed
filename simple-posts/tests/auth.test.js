const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, password } = require("./helpers");
const register = (f, username, pass = password) => f.request("/api/auth/register", { method: "POST", body: { username, password: pass } });

const login = (f, username, pass = password, cookie) => f.request("/api/auth/login", { method: "POST", body: { username, password: pass }, cookie });
const logout = (f, cookie) => f.request("/api/auth/logout", { method: "POST", body: {}, cookie });

test("hash work is bounded to four active plus 64 waiting and recovers after errors", async () => {
  const { createWorkLimiter } = require("../lib/auth");
  const limiter = createWorkLimiter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let running = 0, peak = 0;
  const jobs = Array.from({ length: 68 }, () => limiter.run(async () => {
    running++; peak = Math.max(peak, running);
    await gate; running--; return true;
  }));
  assert.deepEqual(limiter.stats(), { active: 4, waiting: 64 });
  await assert.rejects(limiter.run(() => true), { status: 503, code: "AUTH_BUSY", retryAfter: 1 });
  release();
  assert.ok((await Promise.all(jobs)).every(Boolean));
  assert.equal(peak, 4);
  await assert.rejects(limiter.run(() => { throw new Error("work failed"); }));
  assert.equal(await limiter.run(() => "recovered"), "recovered");
});

test("HTTP admission rejects overload with Retry-After without creating extra users", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 80 }, () => register(f, "capacity")));
  assert.ok(results.some((r) => r.status === 503));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.every((r) => [201, 409, 503].includes(r.status)));
  for (const r of results.filter((r) => r.status === 503)) {
    assert.equal(r.body.code, "AUTH_BUSY");
    assert.equal(r.headers.get("retry-after"), "1");
    assert.equal(r.cookie, undefined);
  }
  assert.equal((await f.disk()).users.length, 1);
});

test("sessions: login, restore, restart, exact expiry and cookie flags", async (t) => {
  const f = await fixture(t);
  await register(f, "SessionUser");
  const r = await login(f, " sessionuser ");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["expiresAt", "user"]);
  assert.match(r.cookie, /^cyberfeed_session=[\w-]{43}$/);
  const header = r.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=86400"]) assert.ok(header.includes(attr), attr);
  assert.ok(!header.includes("Secure") && !header.includes("Domain"));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await f.request("/api/auth/me", { cookie: r.cookie })).status, 200);
  const disk = await f.disk();
  assert.equal(JSON.stringify(disk).includes(r.cookie.split("=")[1]), false);
  assert.equal(disk.sessions[0].tokenHash.length, 64);
  await f.restart();
  assert.equal((await f.request("/api/auth/me", { cookie: r.cookie })).status, 200);
  f.advance(86400000 - 1);
  assert.equal((await f.request("/api/auth/me", { cookie: r.cookie })).status, 200);
  f.advance(1);
  assert.equal((await f.request("/api/auth/me", { cookie: r.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/me", { cookie: "cyberfeed_session=%bad" })).status, 401);
});

test("logout revokes reused token; login replaces only current device session", async (t) => {
  const f = await fixture(t);
  await register(f, "devices");
  const first = await login(f, "devices");
  const second = await login(f, "devices");
  const replacement = await login(f, "devices", password, first.cookie);
  assert.equal((await f.request("/api/auth/me", { cookie: first.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/me", { cookie: second.cookie })).status, 200);
  assert.equal((await logout(f, replacement.cookie)).status, 204);
  assert.equal((await f.request("/api/auth/me", { cookie: replacement.cookie })).status, 401);
  assert.equal((await logout(f, replacement.cookie)).status, 204);
  assert.equal((await logout(f)).status, 204);
  assert.ok((await logout(f, second.cookie)).headers.get("set-cookie").includes("Max-Age=0"));
});

test("identical credential errors and fifth/sixth lockout including unknown names and restart", async (t) => {
  const f = await fixture(t);
  await register(f, "known");
  let knownError;
  for (const username of ["known", "unknown"]) {
    for (let i = 0; i < 5; i++) {
      const r = await login(f, username, "wrong password 2026!");
      assert.equal(r.status, 401);
      knownError ??= r.body;
      assert.deepEqual(r.body, knownError);
    }
    const limited = await login(f, username);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "900");
  }
  await f.restart();
  assert.equal((await login(f, "known")).status, 429);
  f.advance(899999);
  assert.equal((await login(f, "known")).status, 429);
  f.advance(1);
  assert.equal((await login(f, "known")).status, 200);
  assert.equal((await f.disk()).loginAttempts.some((x) => x.usernameKey === "known"), false);
});

test("concurrent failures cannot bypass lockout; independent names and successful reset", async (t) => {
  const f = await fixture(t);
  await register(f, "parallel");
  await register(f, "independent");
  const results = await Promise.all(Array.from({ length: 10 }, () => login(f, "parallel", "wrong password 2026!")));
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 5);
  assert.equal((await login(f, "independent")).status, 200);
  await login(f, "independent", "wrong password 2026!");
  assert.equal((await login(f, "independent")).status, 200);
  assert.equal((await f.disk()).loginAttempts.some((a) => a.usernameKey === "independent"), false);
});

test("rolling failure window excludes timestamps exactly 15 minutes old; malformed login not counted", async (t) => {
  const f = await fixture(t);
  await register(f, "window");
  for (let i = 0; i < 4; i++) assert.equal((await login(f, "window", "wrong password 2026!")).status, 401);
  f.advance(900000);
  assert.equal((await login(f, "window", "wrong password 2026!")).status, 401);
  assert.equal((await f.disk()).loginAttempts[0].failures.length, 1);
  assert.equal((await login(f, "window", "short")).status, 400);
  assert.equal((await f.disk()).loginAttempts[0].failures.length, 1);
});

test("password is exact including spaces and Arabic, and response/logs contain no secrets", async (t) => {
  const f = await fixture(t);
  const pass = " كلمة مرور عربية طويلة ";
  await register(f, "عربي", pass);
  assert.equal((await login(f, "عربي", pass.trim())).status, 401);
  assert.equal((await login(f, "عربي", pass)).status, 200);
  assert.equal(JSON.stringify(f.logs).includes(pass), false);
});

test("failed login/logout persistence never claims successful state changes", async (t) => {
  const f = await fixture(t);
  await register(f, "failures");
  f.fail("rename");
  const denied = await login(f, "failures");
  assert.equal(denied.status, 503);
  assert.equal(denied.cookie, undefined);
  assert.equal((await f.disk()).sessions.length, 0);
  f.fail(null);
  const signedIn = await login(f, "failures");
  f.fail("write");
  const failed = await logout(f, signedIn.cookie);
  assert.equal(failed.status, 503);
  assert.equal(failed.cookie, undefined);
  assert.equal((await f.request("/api/auth/me", { cookie: signedIn.cookie })).status, 200);
  f.fail(null);
  assert.equal((await logout(f, signedIn.cookie)).status, 204);
});

test("production requires HTTPS origin and emits Secure host-only cookie", async (t) => {
  const { createApp } = require("../server");
  assert.throws(() => createApp({ production: true, appOrigin: "http://localhost:3000" }));
  const path = require("node:path");
  assert.throws(() => createApp({ dataDir: path.join(__dirname, "../public/data") }));
  const f = await fixture(t, { production: true, appOrigin: "https://feed.example" });
  await register(f, "production");
  const r = await login(f, "production");
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("set-cookie").includes("Secure"));
  assert.ok(!r.headers.get("set-cookie").includes("Domain"));
  assert.equal((await f.request("/api/auth/logout", { method: "POST", body: {}, cookie: r.cookie, headers: { Origin: null } })).status, 403);
});


test("registration returns only public identity, no cookie, and persists across restart", async (t) => {
  const f = await fixture(t);
  const r = await register(f, " Ali ");
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ["id", "username"]);
  assert.equal(r.body.user.username, "Ali");
  assert.equal(r.cookie, undefined);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const data = await f.disk();
  assert.equal(data.users.length, 1);
  assert.equal(data.users[0].usernameKey, "ali");
  assert.equal(data.users[0].password.algorithm, "scrypt");
  assert.equal(JSON.stringify(data).includes(password), false);
  await f.restart();
  assert.equal((await register(f, "ali")).status, 409);
});

test("twenty canonical-name registrations create exactly one account", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => register(f, i % 2 ? " CONCURRENT " : "concurrent")));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 19);
  assert.equal((await f.disk()).users.length, 1);
});

test("registration validates Unicode names and exact password boundaries", async (t) => {
  const f = await fixture(t);
  for (const username of ["ab", "a".repeat(31), "a b", "a-b", "😀abc", "éclair", "مُحمد", ""] ) {
    assert.equal((await register(f, username)).status, 400, username);
  }
  for (const pass of ["a".repeat(14), "a".repeat(129), "\ud800" + "a".repeat(20), null]) {
    assert.equal((await register(f, "valid", pass)).status, 400);
  }
  for (const [username, pass] of [["abc", "a".repeat(15)], ["a".repeat(30), "a".repeat(128)], ["مستخدم١۲", " كلمة مرور عربية طويلة "], ["ا\u0654حمد", password]]) {
    assert.equal((await register(f, username, pass)).status, 201);
  }
  assert.equal((await register(f, "أحمد")).status, 409);
  assert.equal((await register(f, "احمد")).status, 201);
  const extra = await f.request("/api/auth/register", { method: "POST", body: { username: "extra", password, admin: true } });
  assert.equal(extra.status, 400);
});

test("registration failure never creates a partial account or exposes secrets", async (t) => {
  const f = await fixture(t);
  for (const stage of ["write", "rename"]) {
    f.fail(stage);
    const r = await register(f, "failure");
    assert.equal(r.status, 503);
    assert.equal(r.cookie, undefined);
    assert.equal((await f.disk()).users.length, 0);
    assert.equal(JSON.stringify([r.body, f.logs]).includes(password), false);
  }
  f.fail(null);
  assert.equal((await register(f, "failure")).status, 201);
});

test("request security and error responses have consistent JSON contracts", async (t) => {
  const f = await fixture(t);
  const body = { username: "valid", password };
  for (const origin of [null, "null", "https://foreign.example", "http://localhost:3000/"]) {
    const r = await f.request("/api/auth/register", { method: "POST", body, headers: { Origin: origin } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await f.request("/api/auth/register", { method: "POST", body, headers: { "X-CyberFeed-Request": null } })).status, 403);
  assert.equal((await f.request("/api/auth/register", { method: "POST", body, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await f.request("/api/auth/register", { method: "POST", body, headers: { "Content-Type": "application/json; charset=iso-8859-1" } })).status, 415);
  for (const raw of ["{", "null", "[]", '"hello"']) {
    assert.equal((await f.request("/api/auth/register", { method: "POST", raw })).status, 400);
  }
  assert.equal((await f.request("/api/auth/register", { method: "POST", raw: JSON.stringify({ username: "x".repeat(22000), password }) })).status, 413);
});
