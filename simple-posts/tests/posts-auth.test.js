const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, password } = require("./helpers");
async function account(f, username) {
  await f.request("/api/auth/register", { method: "POST", body: { username, password } });
  return f.request("/api/auth/login", { method: "POST", body: { username, password } });
}
const publish = (f, cookie, body = { text: "Hello" }) => f.request("/api/posts", { method: "POST", body, cookie });

test("feed is public; posting needs a current session and derives identity", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/posts")).status, 200);
  assert.equal((await publish(f)).status, 401);
  const alice = await account(f, "Alice");
  const bob = await account(f, "Bob");
  const r = await publish(f, alice.cookie, { text: " Hello " });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "Alice");
  assert.equal(r.body.userId, alice.body.user.id);
  assert.equal(r.body.text, "Hello");
  for (const extra of [{ name: "Bob" }, { userId: bob.body.user.id }, { id: 99 }]) {
    assert.equal((await publish(f, alice.cookie, { text: "Fake", ...extra })).status, 400);
  }
  assert.equal((await f.request("/api/posts")).body.length, 1);
  await f.request("/api/auth/logout", { method: "POST", body: {}, cookie: alice.cookie });
  assert.equal((await publish(f, alice.cookie)).status, 401);
  f.advance(86400000);
  assert.equal((await publish(f, bob.cookie)).status, 401);
});

test("legacy records retain all original fields and are never claimed by matching usernames", async (t) => {
  const f = await fixture(t);
  const legacy = { id: 3, name: "Legacy", text: "Old text", created_at: "2020-01-01T00:00:00.000Z" };
  await f.app.locals.store.commit("posts", (posts) => posts.push(legacy));
  const user = await account(f, "Legacy");
  const publicPost = (await f.request("/api/posts")).body[0];
  assert.deepEqual(publicPost, { ...legacy, userId: null });
  assert.deepEqual((await f.disk("posts"))[0], legacy);
  const newPost = await publish(f, user.cookie);
  assert.equal(newPost.body.id, 4);
  assert.equal(newPost.body.userId, user.body.user.id);
  await f.restart();
  assert.deepEqual((await f.disk("posts"))[0], legacy);
});

test("post boundaries use code points and failed writes leave no partial post", async (t) => {
  const f = await fixture(t);
  const user = await account(f, "Writer");
  for (const text of ["", "   ", "a".repeat(2001), null]) {
    assert.equal((await publish(f, user.cookie, { text })).status, 400);
  }
  assert.equal((await publish(f, user.cookie, { text: "😀".repeat(2000) })).status, 201);
  f.fail("rename", "posts");
  assert.equal((await publish(f, user.cookie)).status, 503);
  assert.equal((await f.disk("posts")).length, 1);
  f.fail(null);
  const results = await Promise.all(Array.from({ length: 10 }, () => publish(f, user.cookie)));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 10);
});

test("logout and publication have explicit commit ordering", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await account(f, "Ordered");
  for (const logoutFirst of [true, false]) {
    const signedIn = await f.request("/api/auth/login", { method: "POST", body: { username: "Ordered", password } });
    const store = f.app.locals.store;
    const original = store.commit.bind(store);
    const calls = [];
    store.commit = (kind, work) => { calls.push(kind); return original(kind, work); };
    let release;
    const held = original("posts", () => new Promise((resolve) => { release = resolve; }));
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const doLogout = () => f.request("/api/auth/logout", { method: "POST", body: {}, cookie: signedIn.cookie });
    const first = logoutFirst ? doLogout() : publish(f, signedIn.cookie);
    while (calls.length < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = logoutFirst ? publish(f, signedIn.cookie) : doLogout();
    while (calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
    release();
    await held;
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((r) => r.status), logoutFirst ? [204, 401] : [201, 204]);
    store.commit = original;
  }
});
