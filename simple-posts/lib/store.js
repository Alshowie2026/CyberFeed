const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeUsername } = require("./auth");

function storageError() {
  return Object.assign(new Error("Could not save or load data. Please try again."), { status: 503, code: "STORAGE_UNAVAILABLE" });
}
const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const uuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const unique = (items) => new Set(items).size === items.length;
function validate(kind, data) {
  const bad = () => { throw storageError(); };
  if (kind === "posts") {
    if (!Array.isArray(data) || !unique(data.map((p) => p?.id))) bad();
    for (const p of data) {
      if (!p || !Number.isSafeInteger(p.id) || p.id < 1 || typeof p.name !== "string" ||
          typeof p.text !== "string" || !iso(p.created_at) ||
          (p.userId !== undefined && !uuid(p.userId))) bad();
    }
    return;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.sessions) || !Array.isArray(data.loginAttempts)) bad();
  if (!unique(data.users.map((u) => u?.id)) || !unique(data.users.map((u) => u?.usernameKey)) ||
      !unique(data.sessions.map((s) => s?.tokenHash)) || !unique(data.loginAttempts.map((a) => a?.usernameKey))) bad();
  for (const u of data.users) {
    const p = u?.password;
    if (!u || !uuid(u.id) || typeof u.username !== "string" || u.username.length === 0 ||
        typeof u.usernameKey !== "string" || u.usernameKey !== u.username.replace(/[A-Z]/g, (c) => c.toLowerCase()) || !iso(u.createdAt) ||
        !p || p.algorithm !== "scrypt" || p.N !== 131072 || p.r !== 8 || p.p !== 1 || p.keyLength !== 64 ||
        typeof p.salt !== "string" || Buffer.from(p.salt, "base64").length !== 16 ||
        typeof p.derivedKey !== "string" || Buffer.from(p.derivedKey, "base64").length !== 64) bad();
    try {
      const normalized = normalizeUsername(u.username);
      if (normalized.username !== u.username || normalized.usernameKey !== u.usernameKey) bad();
    } catch { bad(); }
    if (Buffer.from(p.salt, "base64").toString("base64") !== p.salt ||
        Buffer.from(p.derivedKey, "base64").toString("base64") !== p.derivedKey) bad();
  }
  const ids = new Set(data.users.map((u) => u.id));
  for (const s of data.sessions) {
    if (!s || !/^[0-9a-f]{64}$/.test(s.tokenHash) || !ids.has(s.userId) || !iso(s.createdAt) || !iso(s.expiresAt) ||
        Date.parse(s.expiresAt) - Date.parse(s.createdAt) !== 86400000) bad();
  }
  for (const a of data.loginAttempts) {
    if (!a || typeof a.usernameKey !== "string" || !Array.isArray(a.failures) ||
        a.failures.length > 5 || !a.failures.every(iso) || !(a.blockedUntil === null || iso(a.blockedUntil))) bad();
    try { if (normalizeUsername(a.usernameKey).usernameKey !== a.usernameKey) bad(); } catch { bad(); }
  }
}
async function createStore({ dataDir, beforeWrite = async () => {} }) {
  await fs.mkdir(dataDir, { recursive: true });
  const state = {};
  let pending = Promise.resolve();
  async function replace(kind, data) {
    const target = path.join(dataDir, kind + ".json");
    const temp = target + "." + randomUUID() + ".tmp";
    try {
      await beforeWrite("write", kind);
      await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
      await beforeWrite("rename", kind);
      await fs.rename(temp, target);
    } catch {
      await fs.unlink(temp).catch(() => {});
      throw storageError();
    }
  }
  // Read all existing files before initializing missing ones, so corruption never triggers a reset.
  const missing = [];
  for (const [kind, initial] of Object.entries({ auth: { version: 1, users: [], sessions: [], loginAttempts: [] }, posts: [] })) {
    try { state[kind] = JSON.parse(await fs.readFile(path.join(dataDir, kind + ".json"), "utf8")); }
    catch (err) {
      if (err.code !== "ENOENT") throw storageError();
      state[kind] = initial;
      missing.push(kind);
    }
    validate(kind, state[kind]);
  }
  for (const kind of missing) await replace(kind, state[kind]);
  return {
    snapshot(kind) { return structuredClone(state[kind]); },
    publicPosts() {
      return state.posts.map(({ id, name, text, created_at, userId }) => ({ id, name, text, created_at, userId: userId ?? null }));
    },
    commit(kind, change) {
      const result = pending.then(async () => {
        const draft = structuredClone(state[kind]);
        const value = await change(draft);
        validate(kind, draft);
        await replace(kind, draft);
        state[kind] = draft;
        return value;
      });
      pending = result.catch(() => {});
      return result;
    }
  };
}
module.exports = { createStore, storageError };
