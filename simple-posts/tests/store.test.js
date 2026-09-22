const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../lib/store");

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberfeed-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: await createStore({ dataDir: dir, ...options }) };
}
const post = (id) => ({ id, name: "Legacy", text: "Preserved", created_at: new Date(0).toISOString() });

test("initializes only missing files and preserves legacy posts and orphan temps", async (t) => {
  const { dir, store } = await fixture(t);
  assert.deepEqual(store.snapshot("auth"), { version: 1, users: [], sessions: [], loginAttempts: [] });
  await store.commit("posts", (posts) => posts.push(post(1)));
  const before = await fs.readFile(path.join(dir, "posts.json"), "utf8");
  await fs.writeFile(path.join(dir, "auth.json.orphan.tmp"), "broken");
  const reopened = await createStore({ dataDir: dir });
  assert.deepEqual(reopened.snapshot("posts"), [post(1)]);
  assert.equal(await fs.readFile(path.join(dir, "posts.json"), "utf8"), before);
});

test("corrupt and unsupported files fail closed without overwrite", async (t) => {
  const { dir } = await fixture(t);
  for (const invalid of ["{", '{"version":2,"users":[],"sessions":[],"loginAttempts":[]}', '{"version":1,"users":[{}],"sessions":[],"loginAttempts":[]}']) {
    await fs.writeFile(path.join(dir, "auth.json"), invalid);
    await assert.rejects(createStore({ dataDir: dir }));
    assert.equal(await fs.readFile(path.join(dir, "auth.json"), "utf8"), invalid);
  }
});

test("write and rename failures preserve committed disk and memory; queue recovers", async (t) => {
  let failStage;
  const { dir, store } = await fixture(t, { beforeWrite: async (stage) => { if (stage === failStage) throw new Error("injected"); } });
  for (const stage of ["write", "rename"]) {
    failStage = stage;
    await assert.rejects(store.commit("posts", (posts) => posts.push(post(1))), { code: "STORAGE_UNAVAILABLE" });
    assert.deepEqual(store.snapshot("posts"), []);
    assert.equal(await fs.readFile(path.join(dir, "posts.json"), "utf8"), "[]\n");
  }
  failStage = undefined;
  await store.commit("posts", (posts) => posts.push(post(1)));
  assert.equal(store.snapshot("posts").length, 1);
});

test("serial commits do not overwrite one another and snapshots cannot mutate storage", async (t) => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => store.commit("posts", async (posts) => {
    const id = posts.length + 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    posts.push(post(id));
  })));
  assert.deepEqual(store.snapshot("posts").map((p) => p.id), Array.from({ length: 20 }, (_, i) => i + 1));
  store.snapshot("posts").pop();
  assert.equal(store.snapshot("posts").length, 20);
});

