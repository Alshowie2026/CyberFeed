const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberfeed-auth-"));
  let now = Date.UTC(2026, 8, 21);
  let fail;
  let server;
  let base;
  const logs = [];
  const config = {
    dataDir, appOrigin: "http://localhost:3000", clock: () => now,
    beforeWrite: async (stage, kind) => { if (fail && fail.stage === stage && fail.kind === kind) throw new Error("injected"); },
    logger: { error: (...args) => logs.push(args) },
    ...options
  };
  async function start() {
    const app = createApp(config);
    await app.initialize();
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = "http://127.0.0.1:" + server.address().port;
    return app;
  }
  let app = await start();
  async function stop() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    server = null;
  }
  t.after(async () => { await stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, logs, get app() { return app; },
    advance(ms) { now += ms; }, setTime(ms) { now = ms; }, get now() { return now; },
    fail(stage, kind = "auth") { fail = stage ? { stage, kind } : null; },
    async restart() { await stop(); app = await start(); },
    async request(route, { method = "GET", body, cookie, headers = {}, raw } = {}) {
      const defaults = method === "POST" ? { Origin: config.appOrigin, "X-CyberFeed-Request": "1", "Content-Type": "application/json" } : {};
      if (cookie) defaults.Cookie = cookie;
      const h = { ...defaults, ...headers };
      for (const key of Object.keys(h)) if (h[key] === null) delete h[key];
      const response = await fetch(base + route, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: response.status, body: json, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    },
    async disk(name = "auth") { return JSON.parse(await fs.readFile(path.join(dataDir, name + ".json"), "utf8")); }
  };
}
const password = "A test password 2026!";
module.exports = { fixture, password };

