// Real Chromium smoke checks, using the built-in WebSocket/CDP client; no test dependency.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createApp } = require("../server");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cyberfeed-browser-"));
  let browser, server, ws;
  const pending = new Map();
  let id = 0;
  try {
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    let now = Date.now();
    let fail = false;
    const app = createApp({ dataDir: path.join(temp, "data"), appOrigin: origin, clock: () => now,
      beforeWrite: async () => { if (fail) throw new Error("injected"); }, logger: { error() {} } });
    await app.initialize();
    server.on("request", app);
    const binary = process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    const profile = path.join(temp, "profile");
    browser = spawn(binary, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"],
      { windowsHide: true, stdio: "ignore" });
    let launchError; browser.on("error", (e) => { launchError = e; });
    let portFile;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try { portFile = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8"); break; } catch { await delay(100); }
    }
    if (!portFile) throw new Error("Headless browser did not start.");
    const [port, socketPath] = portFile.trim().split(/\r?\n/);
    ws = new WebSocket("ws://127.0.0.1:" + port + socketPath);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const job = pending.get(message.id); if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
    });
    function command(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error("CDP timeout: " + method)); }, 15000);
        pending.set(key, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    async function tab() {
      const { targetId } = await command("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
      const send = (method, params) => command(method, params, sessionId);
      await send("Page.enable");
      await send("Runtime.enable");
      const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const wait = async (expression) => {
        for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
        const state = await evaluate('({ready:document.readyState,authMessage:document.querySelector("#auth-message")?.textContent,postMessage:document.querySelector("#form-message")?.textContent})');
        throw new Error("Browser condition timed out: " + expression + " " + JSON.stringify(state));
      };
      await send("Page.navigate", { url: origin });
      await wait('document.readyState === "complete" && typeof setMode === "function"');
      await send("Page.bringToFront");
      return { send, evaluate, wait };
    }
    const page = await tab();
    assert.equal(await page.evaluate('!document.querySelector("#nav-login").hidden && document.querySelector("#signed-in").hidden'), true);
    assert.equal(await page.evaluate('!document.querySelector("#composer-dialog").open && getComputedStyle(document.querySelector("#new-post")).position === "fixed"'), true);
    await page.evaluate('document.querySelector("#new-post").click(); document.querySelector("#text").value="My guest draft"');
    assert.equal(await page.evaluate('document.querySelector("#new-post").getAttribute("aria-expanded")'), "true");
    await page.evaluate('document.querySelector("#close-composer").click()');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "My guest draft");
    await page.evaluate('document.querySelector("#new-post").click(); document.querySelector("#post-form").requestSubmit()');
    await page.wait('!document.querySelector("#account-panel").hidden');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "My guest draft");
    await page.evaluate('document.querySelector("#nav-login").click()');
    await page.evaluate('document.querySelector("#register-mode").click(); document.querySelector("#username").value="BrowserUser"; document.querySelector("#password").value="Browser password 2026!"; document.querySelector("#auth-form").requestSubmit()');
    await page.wait('document.querySelector("#auth-message").textContent.includes("Account created")');
    assert.equal(await page.evaluate('document.querySelector("#password").value'), "");
    assert.equal(await page.evaluate('document.querySelector("#username").value'), "BrowserUser");
    assert.equal(await page.evaluate('document.querySelector("#auth-submit").textContent'), "Sign in");
    await page.evaluate('document.querySelector("#username").focus()');
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate('document.activeElement.id'), "password");
    console.log("PASS: browser registration, success feedback, sign-in transition, cleared password.");
    await page.evaluate('document.querySelector("#password").value="Browser password 2026!"; document.querySelector("#auth-form").requestSubmit()');
    await page.wait('!document.querySelector("#signed-in").hidden');
    assert.equal(await page.evaluate('document.querySelector("#current-user").textContent'), "BrowserUser");
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "My guest draft");
    assert.equal(await page.evaluate('document.querySelector("#nav-login").hidden && Boolean(document.querySelector("nav #current-user")) && Boolean(document.querySelector("nav #logout"))'), true);
    assert.equal(await page.evaluate('document.querySelector("#composer-dialog").open'), true);
    await page.send("Page.reload");
    await page.wait('Boolean(document.querySelector("#signed-in")) && !document.querySelector("#signed-in").hidden');
    const second = await tab();
    await second.wait('!document.querySelector("#signed-in").hidden');
    fail = true;
    await second.evaluate('document.querySelector("#logout").click()');
    await second.wait('document.querySelector("#auth-message").textContent.includes("Could not")');
    assert.equal(await second.evaluate('document.querySelector("#signed-in").hidden'), false);
    fail = false;
    await second.evaluate('document.querySelector("#logout").click()');
    await second.wait('document.querySelector("#signed-in").hidden');
    await page.wait('document.querySelector("#signed-in").hidden');
    console.log("PASS: browser sign-in, reload, cross-tab logout, failed-logout state.");
    await page.evaluate('document.querySelector("#nav-login").click()');
    await page.evaluate('document.querySelector("#username").value="BrowserUser"; document.querySelector("#password").value="Browser password 2026!"; document.querySelector("#auth-form").requestSubmit()');
    await page.wait('!document.querySelector("#signed-in").hidden');
    assert.equal(await page.evaluate('document.querySelector("#name") === null'), true);
    await page.evaluate('document.querySelector("#new-post").click(); document.querySelector("#text").value="A browser verified post"; document.querySelector("#post-form").requestSubmit()');
    await page.wait('document.querySelector("#feed").textContent.includes("A browser verified post")');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "");
    assert.equal(await page.evaluate('document.querySelector("#composer-dialog").open'), false);
    assert.equal(await page.evaluate('document.querySelector(".post h3").textContent'), "BrowserUser");
    await page.evaluate('document.querySelector("#new-post").click(); document.querySelector("#text").value="Keep this draft"');
    await page.send("Network.enable");
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.evaluate('document.querySelector("#post-form").requestSubmit()');
    await page.wait('document.querySelector("#form-message").textContent.includes("Could not confirm")');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "Keep this draft");
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    now += 86400000;
    await page.evaluate('document.querySelector("#post-form").requestSubmit()');
    await page.wait('document.querySelector("#auth-message").textContent.includes("Sign in again")');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "Keep this draft");
    await page.evaluate('document.querySelector("#password").value="Browser password 2026!"; document.querySelector("#auth-form").requestSubmit()');
    await page.wait('!document.querySelector("#signed-in").hidden');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "Keep this draft");
    fail = true;
    await page.evaluate('document.querySelector("#post-form").requestSubmit()');
    await page.wait('document.querySelector("#form-message").textContent.includes("Could not save")');
    assert.equal(await page.evaluate('document.querySelector("#text").value'), "Keep this draft");
    fail = false;
    await page.send("Page.bringToFront");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1250, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('window.scrollTo(0, 0)');
    const desktopShot = await page.send("Page.captureScreenshot", { format: "png" });
    const desktopArtifact = path.join(__dirname, "../../specs/001-user-auth/artifacts/browser-desktop.png");
    await fs.mkdir(path.dirname(desktopArtifact), { recursive: true });
    await fs.writeFile(desktopArtifact, Buffer.from(desktopShot.data, "base64"));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate('window.scrollTo(0, 0)');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= 390'), true);
    assert.equal(await page.evaluate('document.querySelector("#password").type'), "password");
    assert.equal(await page.evaluate('localStorage.length + sessionStorage.length'), 0);
    assert.equal(await page.evaluate('document.cookie.includes("cyberfeed_session")'), false);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const artifact = path.join(__dirname, "../../specs/001-user-auth/artifacts/browser-mobile.png");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, Buffer.from(shot.data, "base64"));
    console.log("PASS: browser publishing/author, offline and expired-session drafts, re-login, save failure, mobile overflow, HttpOnly and no browser credential storage.");
    await command("Browser.close").catch(() => {});
  } finally {
    if (ws) ws.close();
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error("Browser closed")); }
    if (browser && browser.exitCode === null) { browser.kill(); await delay(400); }
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    // temp is created by mkdtemp under os.tmpdir; never accept an external deletion target.
    const resolved = path.resolve(temp);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("cyberfeed-browser-")) throw new Error("Invalid cleanup path");
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
