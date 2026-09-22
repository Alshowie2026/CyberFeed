const express = require("express");
const path = require("node:path");
const { createStore } = require("./lib/store");
const { createAuth } = require("./lib/auth");
const { problem, requestGuard, fields, errorHandler, readSession, sessionCookie } = require("./lib/request-security");

function createApp(options = {}) {
  const app = express();
  const port = process.env.PORT || 3000;
  const appOrigin = options.appOrigin || process.env.APP_ORIGIN || `http://localhost:${port}`;
  const origin = new URL(appOrigin);
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (origin.origin !== appOrigin || !["http:", "https:"].includes(origin.protocol) ||
      (production && origin.protocol !== "https:")) throw new Error("APP_ORIGIN must be an exact origin, using HTTPS in production.");
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data"));
  const publicDir = path.join(__dirname, "public");
  const relativeData = path.relative(publicDir, dataDir);
  if (!relativeData || (!relativeData.startsWith(".." + path.sep) && relativeData !== ".." && !path.isAbsolute(relativeData))) {
    throw new Error("DATA_DIR must be outside the public directory.");
  }
  const clock = options.clock || Date.now;
  let initialization;
  app.initialize = () => initialization ||= createStore({ dataDir, beforeWrite: options.beforeWrite }).then(async (store) => {
    app.locals.store = store;
    app.locals.auth = createAuth({ store, clock, onHashWait: options.onHashWait });
    await app.locals.auth.initialize();
    return app;
  });
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    if (req.path.startsWith("/api/auth")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(requestGuard(appOrigin));
  app.use(express.json({ limit: "20kb" }));
  app.use("/api", async (req, res, next) => { await app.initialize(); next(); });
  app.get("/api/posts", (req, res) => res.json(app.locals.store.publicPosts()));
  app.post("/api/auth/register", async (req, res) => {
    fields(req.body, ["username", "password"]);
    const user = await app.locals.auth.register(req.body);
    res.status(201).json({ user });
  });
  const secureCookie = production || origin.protocol === "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  app.post("/api/auth/login", async (req, res) => {
    fields(req.body, ["username", "password"]);
    const { token, user, expiresAt } = await app.locals.auth.login(req.body, readSession(req));
    sessionCookie(res, token, secureCookie);
    res.json({ user, expiresAt });
  });
  app.get("/api/auth/me", (req, res) => res.json(app.locals.auth.session(readSession(req))));
  app.post("/api/auth/logout", async (req, res) => {
    fields(req.body, []);
    await app.locals.auth.logout(readSession(req));
    sessionCookie(res, null, secureCookie);
    res.status(204).end();
  });
  app.post("/api/posts", async (req, res) => {
    app.locals.auth.session(readSession(req));
    fields(req.body, ["text"]);
    const text = req.body.text.trim();
    if (!text || !text.isWellFormed() || [...text].length > 2000) throw problem(400, "VALIDATION_ERROR", "Post text must contain 1–2000 characters.");
    const post = await app.locals.store.commit("posts", (posts) => {
      const { user } = app.locals.auth.session(readSession(req));
      const post = { id: posts.reduce((n, p) => Math.max(n, p.id), 0) + 1, name: user.username, userId: user.id, text, created_at: new Date(clock()).toISOString() };
      posts.push(post); return post;
    });
    res.status(201).json(post);
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.use(errorHandler(options.logger));
  return app;
}
const app = createApp();
if (require.main === module) {
  app.initialize().then(() => app.listen(process.env.PORT || 3000, () => console.log("CyberFeed is running.")))
    .catch(() => { console.error("Could not initialize application data or configuration."); process.exitCode = 1; });
}
module.exports = app;
module.exports.createApp = createApp;
