// Relaunch before Node initializes its shared crypto/IO worker pool.
if (process.env.UV_THREADPOOL_SIZE !== "8") {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, UV_THREADPOOL_SIZE: "8" }, stdio: "inherit", windowsHide: true
  });
  process.exit(result.status ?? 1);
}
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createApp } = require("../server");
function p95(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * .95) - 1] || 0; }
const round = (n) => Math.round(n * 100) / 100;
async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberfeed-benchmark-"));
  const server = http.createServer();
  let timer;
  const hashWait = [], registration = [], login = [], errors = [];
  const rounds = [];
  let peakRss = process.memoryUsage().rss;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const app = createApp({ dataDir, appOrigin: origin, onHashWait: (ms) => hashWait.push(ms), logger: { error() {} } });
    await app.initialize();
    server.on("request", app);
    timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    async function run(route, username, times, expected) {
      const start = performance.now();
      const response = await fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "X-CyberFeed-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "Benchmark password 2026!" })
      });
      await response.arrayBuffer();
      const elapsed = performance.now() - start;
      times.push(elapsed);
      if (response.status !== expected) errors.push({ route, status: response.status });
      return elapsed;
    }
    for (let i = 0; i < 5; i++) {
      const names = Array.from({ length: 20 }, (_, j) => "load_" + i + "_" + j);
      const reg = await Promise.all(names.map((name) => run("/api/auth/register", name, registration, 201)));
      const log = await Promise.all(names.map((name) => run("/api/auth/login", name, login, 200)));
      const result = { round: i + 1, registrationP95Ms: round(p95(reg)), loginP95Ms: round(p95(log)) };
      rounds.push(result);
      console.log(JSON.stringify(result));
    }
    const report = {
      measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryMiB: round(os.totalmem() / 1048576),
      threadPool: 8, activeHashLimit: 4, queuedHashLimit: 64, scrypt: { N: 131072, r: 8, p: 1, keyLength: 64 },
      rounds, requests: registration.length + login.length, successes: registration.length + login.length - errors.length,
      errors, registrationP95Ms: round(p95(registration)), loginP95Ms: round(p95(login)),
      hashQueueP95Ms: round(p95(hashWait)), peakRssMiB: round(peakRss / 1048576),
      passed: !errors.length && p95(registration) < 2000 && p95(login) < 2000,
      scope: "Local HTTP load, 20 concurrent distinct users, 5 rounds; not human usability or deployment certification."
    };
    const artifact = path.join(__dirname, "../../specs/001-user-auth/artifacts/benchmark.json");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(dataDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("cyberfeed-benchmark-")) throw new Error("Invalid cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });

