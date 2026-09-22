const { scrypt, randomBytes, randomUUID, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { problem } = require("./request-security");
const derive = promisify(scrypt);
const PARAMS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const busy = () => problem(503, "AUTH_BUSY", "Sign-in is busy. Please try again shortly.", 1);

function createWorkLimiter({ maxActive = 4, maxWaiting = 64, onWait = () => {} } = {}) {
  let active = 0;
  const waiting = [];
  function pump() {
    while (active < maxActive && waiting.length) {
      const job = waiting.shift();
      active++;
      onWait(performance.now() - job.queuedAt);
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  return {
    run(work) {
      if (active >= maxActive && waiting.length >= maxWaiting) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        waiting.push({ work, resolve, reject, queuedAt: performance.now() });
        pump();
      });
    },
    stats() { return { active, waiting: waiting.length }; }
  };
}
function normalizeUsername(value) {
  if (typeof value !== "string" || !value.isWellFormed()) throw problem(400, "VALIDATION_ERROR", "Username must contain 3–30 Arabic or English letters, digits, or underscores.");
  const username = value.trim().normalize("NFC");
  const chars = [...username];
  const allowed = (c) => /^[A-Za-z0-9_\u0660-\u0669\u06f0-\u06f9]$/u.test(c) || (/^\p{Letter}$/u.test(c) && /^\p{Script_Extensions=Arabic}$/u.test(c));
  if (chars.length < 3 || chars.length > 30 || !chars.every(allowed)) throw problem(400, "VALIDATION_ERROR", "Username must contain 3–30 Arabic or English letters, digits, or underscores.");
  return { username, usernameKey: username.replace(/[A-Z]/g, (c) => c.toLowerCase()) };
}
function validatePassword(password) {
  if (typeof password !== "string" || !password.isWellFormed() || [...password].length < 15 || [...password].length > 128) {
    throw problem(400, "VALIDATION_ERROR", "Password must contain 15–128 characters.");
  }
  return password;
}
const publicUser = ({ id, username }) => ({ id, username });
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const authRequired = () => problem(401, "AUTH_REQUIRED", "Sign in to continue.");
function prune(auth, now) {
  auth.sessions = auth.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  auth.loginAttempts = auth.loginAttempts.filter((a) => {
    if (a.blockedUntil && Date.parse(a.blockedUntil) <= now) return false;
    a.failures = a.failures.filter((time) => Date.parse(time) > now - 900000);
    return a.failures.length > 0 || Boolean(a.blockedUntil);
  });
}
function createAuth({ store, clock = Date.now, onHashWait }) {
  const limiter = createWorkLimiter({ onWait: onHashWait });
  const keys = new Map();
  let queued = 0;
  function byKey(key, work) {
    if (queued >= 68) return Promise.reject(busy());
    queued++;
    const prior = keys.get(key) || Promise.resolve();
    const result = prior.catch(() => {}).then(work);
    keys.set(key, result);
    const clean = () => { queued--; if (keys.get(key) === result) keys.delete(key); };
    result.then(clean, clean);
    return result;
  }
  async function hash(password, salt = randomBytes(16)) {
    const key = await limiter.run(() => derive(password, salt, 64, PARAMS));
    return { algorithm: "scrypt", N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, salt: salt.toString("base64"), derivedKey: key.toString("base64"), keyLength: 64 };
  }
  async function verify(password, record) {
    const salt = record ? Buffer.from(record.salt, "base64") : dummySalt;
    const key = await limiter.run(() => derive(password, salt, 64, PARAMS));
    const expected = record ? Buffer.from(record.derivedKey, "base64") : dummyKey;
    return timingSafeEqual(key, expected) && Boolean(record);
  }
  const dummySalt = randomBytes(16);
  const dummyKey = randomBytes(64);
  function session(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw authRequired();
    const auth = store.snapshot("auth");
    const found = auth.sessions.find((s) => s.tokenHash === tokenHash(token) && Date.parse(s.expiresAt) > clock());
    const user = found && auth.users.find((u) => u.id === found.userId);
    if (!user) throw authRequired();
    return { user: publicUser(user), expiresAt: found.expiresAt };
  }
  return {
    hash, verify, session,
    async initialize() {
      const current = store.snapshot("auth");
      const clean = structuredClone(current);
      prune(clean, clock());
      if (JSON.stringify(clean) !== JSON.stringify(current)) await store.commit("auth", (auth) => prune(auth, clock()));
    },
    async login(input, previousToken) {
      const { usernameKey } = normalizeUsername(input.username);
      const password = validatePassword(input.password);
      return byKey(usernameKey, async () => {
        const current = store.snapshot("auth");
        const attempt = current.loginAttempts.find((a) => a.usernameKey === usernameKey);
        if (attempt?.blockedUntil && Date.parse(attempt.blockedUntil) > clock()) {
          throw problem(429, "LOGIN_THROTTLED", "Too many attempts. Please wait before trying again.", Math.ceil((Date.parse(attempt.blockedUntil) - clock()) / 1000));
        }
        const user = current.users.find((u) => u.usernameKey === usernameKey);
        const valid = await verify(password, user?.password);
        const result = await store.commit("auth", (auth) => {
          const now = clock();
          prune(auth, now);
          if (!valid) {
            let attempt = auth.loginAttempts.find((a) => a.usernameKey === usernameKey);
            if (!attempt) { attempt = { usernameKey, failures: [], blockedUntil: null }; auth.loginAttempts.push(attempt); }
            attempt.failures.push(new Date(now).toISOString());
            if (attempt.failures.length >= 5) attempt.blockedUntil = new Date(now + 900000).toISOString();
            return null;
          }
          auth.loginAttempts = auth.loginAttempts.filter((a) => a.usernameKey !== usernameKey);
          if (previousToken) auth.sessions = auth.sessions.filter((s) => s.tokenHash !== tokenHash(previousToken));
          const token = randomBytes(32).toString("base64url");
          const expiresAt = new Date(now + 86400000).toISOString();
          auth.sessions.push({ tokenHash: tokenHash(token), userId: user.id, createdAt: new Date(now).toISOString(), expiresAt });
          return { token, user: publicUser(user), expiresAt };
        });
        if (!result) throw problem(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
        return result;
      });
    },
    async logout(token) {
      if (!token || !store.snapshot("auth").sessions.some((s) => s.tokenHash === tokenHash(token))) return;
      await store.commit("auth", (auth) => {
        auth.sessions = auth.sessions.filter((s) => s.tokenHash !== tokenHash(token));
        prune(auth, clock());
      });
    },
    async register(input) {
      const name = normalizeUsername(input.username);
      const password = validatePassword(input.password);
      return byKey(name.usernameKey, async () => {
        if (store.snapshot("auth").users.some((u) => u.usernameKey === name.usernameKey)) {
          throw problem(409, "USERNAME_TAKEN", "That username is not available.");
        }
        const verifier = await hash(password);
        return store.commit("auth", (auth) => {
          prune(auth, clock());
          if (auth.users.some((u) => u.usernameKey === name.usernameKey)) throw problem(409, "USERNAME_TAKEN", "That username is not available.");
          const user = { id: randomUUID(), ...name, password: verifier, createdAt: new Date(clock()).toISOString() };
          auth.users.push(user);
          return publicUser(user);
        });
      });
    }
  };
}
module.exports = { createAuth, createWorkLimiter, normalizeUsername, validatePassword };
