function problem(status, code, message, retryAfter) {
  return Object.assign(new Error(message), { status, code, retryAfter });
}
function requestGuard(origin) {
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    if (req.get("Origin") !== origin || req.get("X-CyberFeed-Request") !== "1") {
      return next(problem(403, "REQUEST_FORBIDDEN", "This request is not allowed."));
    }
    if (!req.is("application/json")) return next(problem(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json."));
    next();
  };
}
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => typeof body[key] !== "string")) {
    throw problem(400, "VALIDATION_ERROR", "Check the required fields.");
  }
}
function errorHandler(logger = console) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = err.status || 500;
    let code = err.code || "INTERNAL_ERROR";
    let message = err.message;
    if (err.type === "entity.too.large") { status = 413; code = "PAYLOAD_TOO_LARGE"; message = "Request is too large."; }
    else if (err.type === "entity.parse.failed") { status = 400; code = "INVALID_JSON"; message = "Request body must be a JSON object."; }
    else if (["charset.unsupported", "encoding.unsupported"].includes(err.type)) { status = 415; code = "UNSUPPORTED_MEDIA_TYPE"; message = "Use UTF-8 JSON."; }
    else if (!err.code || status >= 500 && !["STORAGE_UNAVAILABLE", "AUTH_BUSY"].includes(code)) {
      status = 500; code = "INTERNAL_ERROR"; message = "Something went wrong. Please try again.";
    }
    // Never pass an exception object, request body, cookie, or password to the logger.
    if (status >= 500) logger.error("Request failed", { code });
    res.set("Cache-Control", "no-store");
    if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
    res.status(status).json({ error: message, code });
  };
}
function readSession(req) {
  const cookies = (req.get("Cookie") || "").split(";").map((s) => s.trim()).filter((s) => s.startsWith("cyberfeed_session="));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice("cyberfeed_session=".length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function sessionCookie(res, token, secure) {
  res.cookie("cyberfeed_session", token || "", {
    httpOnly: true, sameSite: "lax", path: "/", secure,
    maxAge: token ? 86400000 : 0
  });
}
module.exports = { problem, requestGuard, fields, errorHandler, readSession, sessionCookie };
