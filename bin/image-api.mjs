#!/usr/bin/env node
/**
 * 号池守护进程（本地 OpenAI 兼容 API + 并发调度 + 常驻会话）
 *
 * 为什么要有它：直驱生图每次冷启动指纹窗口要 10~30s。守护进程把已登录窗口保活复用，
 * 并按账号并发调度，让多个 worker 同时出图；同时统一记录调用日志、额度与图片库。
 *
 *   GET  /health                         健康检查（无需鉴权）
 *   GET  /v1/models                      模型列表（图像）
 *   POST /v1/images/generations          { model?, prompt, n?, response_format? }
 *   GET  /v1/usage?days=30               消耗统计（含额度、阶段耗时、错误 Top）
 *   GET  /v1/logs?days=7&limit=100       调用日志
 *   GET  /v1/images                      图片库
 *   DELETE /v1/images/<file>             删除图片
 *   GET  /images/<file>                  图片文件（本机可直连，OpenAI 客户端取图用）
 *   GET  /v1/workers                     账号与常驻窗口状态
 *   POST /v1/warmup                      { count? } 预热窗口
 *   POST /v1/shutdown                    关闭进程（会一并关闭浏览器窗口）
 */

import http from "node:http";
import path from "node:path";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createPool } from "./direct.mjs";
import {
  DATA_DIR, appendLedger, aggregateUsage, deleteImage, imagesDir, listImages, maskEmail,
  queryLogs, readLedger, readWorkersState,
} from "./ledger.mjs";
import { openAiModelList } from "./pool-models.mjs";

const env = (k, d = "") => (process.env[k] ?? d).trim();

const IMAGES_DIR = imagesDir();
const TOKEN_FILE = path.join(DATA_DIR, "api-token.txt");
const LOG_FILE = path.join(DATA_DIR, "api.log");
const PORT = Number(env("RUODAO_IMAGE_API_PORT", "8100")) || 8100;
const BUILD = env("RUODAO_IMAGE_API_BUILD", "");
const CONCURRENCY = () => Math.max(1, Math.min(10, Number(env("RUODAO_POOL_CONCURRENCY", "3")) || 3));
const WARM_IDLE_MS = () => Math.max(0, Number(env("RUODAO_WARM_IDLE_MIN", "15")) || 15) * 60_000;
const QUEUE_TIMEOUT_MS = () => Math.max(30000, Number(env("RUODAO_QUEUE_TIMEOUT", "600")) || 600) * 1000;
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function log(line) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, "utf8"); } catch { /* 忽略 */ }
}
function token() {
  try {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch { /* 首次启动 */ }
  const fresh = randomBytes(24).toString("hex");
  try { writeFileSync(TOKEN_FILE, fresh, "utf8"); } catch { /* 读内存值 */ }
  return fresh;
}
const TOKEN = token();

const pool = createPool({
  maxIdleMs: WARM_IDLE_MS(),
  source: "daemon",
  onEvent: (event) => log(`pool ${event.type} worker=${event.workerId}${event.ms ? ` ms=${event.ms}` : ""}`),
});

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(text);
}
function authorized(req) {
  const raw = String(req.headers.authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && m[1].trim() === TOKEN);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { reject(new Error("请求体超过 4MB")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

/* ---------------- 调度器：按账号并发，同一账号串行 ---------------- */

const queue = [];
const busy = new Set();
let running = 0;
let shuttingDown = false;

function usableWorkers() {
  const now = Date.now();
  return readWorkersState().workers.filter((w) => w.loggedIn && !(Number(w.limitedUntil) > now));
}
function freeWorker(exclude, only) {
  const now = Date.now();
  // 热窗口优先：复用已打开的指纹窗口能省掉 10~30s 冷启动，其次才按调用量均衡
  let warmIds = new Set();
  try { warmIds = new Set(pool.stats().filter((s) => s.warm && !s.busy).map((s) => s.workerId)); } catch { /* 池未就绪 */ }
  return readWorkersState().workers
    .filter((w) => w.loggedIn && !(Number(w.limitedUntil) > now) && !busy.has(w.workerId) && !exclude.has(w.workerId) && (only == null || w.workerId === Number(only)))
    .sort((a, b) => {
      const warmDiff = Number(warmIds.has(b.workerId)) - Number(warmIds.has(a.workerId));
      return warmDiff || (a.usageCount || 0) - (b.usageCount || 0);
    })[0] || null;
}
function poolState() {
  return { running, queued: queue.length, concurrency: CONCURRENCY(), busy: [...busy], warm: pool.stats() };
}

function schedule(run, { exclude = new Set(), only = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!usableWorkers().length) {
      reject(new Error("号池没有可用账号：请先导入账号并完成自动登录（或所有账号额度已用完）"));
      return;
    }
    queue.push({ run, exclude, only, resolve, reject, enqueuedAt: Date.now() });
    pump();
  });
}

function pump() {
  while (!shuttingDown && running < CONCURRENCY() && queue.length) {
    const job = queue[0];
    const worker = freeWorker(job.exclude, job.only) || (job.only == null ? freeWorker(new Set()) : null);
    if (!worker) break;
    if (Date.now() - job.enqueuedAt > QUEUE_TIMEOUT_MS()) {
      queue.shift();
      job.reject(new Error("排队超时：所有账号都在执行任务，请稍后重试或增加账号"));
      continue;
    }
    queue.shift();
    busy.add(worker.workerId);
    running++;
    const queueMs = Date.now() - job.enqueuedAt;
    Promise.resolve()
      .then(() => job.run(worker, queueMs))
      .then(job.resolve, job.reject)
      .finally(() => {
        busy.delete(worker.workerId);
        running--;
        log(`task done worker=${worker.workerId} queueMs=${queueMs} running=${running} queued=${queue.length}`);
        pump();
      });
  }
}

async function runWithRetry(kind, payload, { attempts = 1, workerId = null } = {}) {
  let lastError;
  const tried = new Set();
  for (let index = 0; index < Math.max(1, attempts); index++) {
    try {
      return await schedule((worker, queueMs) => {
        tried.add(worker.workerId);
        const onProgress = (progress) => log(`${kind} worker=${worker.workerId} ${progress.step || ""}`);
        return pool.generate({ ...payload, workerId: worker.workerId, queueMs, onProgress });
      }, { exclude: tried.size > 1 ? new Set(tried) : new Set(), only: workerId });
    } catch (e) {
      lastError = e;
      const message = String(e?.message || e);
      if (!/登录态已失效|超时|生成失败|限额|额度/.test(message)) break;
      log(`retry ${kind} after: ${message.slice(0, 160)}`);
    }
  }
  throw lastError;
}

function statusForError(message) {
  if (/没有可用账号|未登录/.test(message)) return 503;
  if (/额度|限额|limit/i.test(message)) return 429;
  if (/排队超时/.test(message)) return 429;
  return 502;
}

/* ---------------- HTTP ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") return json(res, 204, {});

  if (url.pathname === "/health") {
    const workers = readWorkersState().workers;
    return json(res, 200, {
      ok: true,
      service: "image-pool-daemon",
      port: PORT,
      build: BUILD,
      workers: {
        total: workers.length,
        loggedIn: workers.filter((w) => w.loggedIn).length,
        available: usableWorkers().length,
        busy: busy.size,
      },
      pool: poolState(),
    });
  }

  // 图片文件走本机直连：OpenAI 客户端拿到 URL 后不会带 Bearer，要求鉴权会 401
  if (req.method === "GET" && url.pathname.startsWith("/images/")) {
    const name = path.basename(decodeURIComponent(url.pathname.slice("/images/".length)));
    const file = path.join(IMAGES_DIR, name);
    if (!/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(name) || !existsSync(file)) {
      return json(res, 404, { error: { message: "image not found" } });
    }
    const ext = path.extname(name).toLowerCase();
    const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
    return;
  }

  if (!authorized(req)) return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, { object: "list", data: openAiModelList() });
  }

  if (req.method === "GET" && url.pathname === "/v1/workers") {
    const state = readWorkersState();
    const now = Date.now();
    return json(res, 200, {
      workers: state.workers.map((w) => ({
        workerId: w.workerId,
        email: maskEmail(w.email),
        loggedIn: Boolean(w.loggedIn),
        usageCount: w.usageCount || 0,
        limited: Number(w.limitedUntil) > now,
        limitedUntil: w.limitedUntil || 0,
        lastUsedAt: w.lastUsedAt || 0,
      })),
      pool: poolState(),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    const days = Number(url.searchParams.get("days")) || 30;
    const state = readWorkersState();
    return json(res, 200, aggregateUsage(readLedger(), { days, workers: state.workers }));
  }

  if (req.method === "GET" && url.pathname === "/v1/logs") {
    const params = url.searchParams;
    return json(res, 200, queryLogs(readLedger(), {
      days: Number(params.get("days")) || 7,
      limit: Number(params.get("limit")) || 100,
      offset: Number(params.get("offset")) || 0,
      kind: params.get("kind") || "",
      state: params.get("state") || "",
      workerId: params.get("workerId") || "",
      q: params.get("q") || "",
    }));
  }

  if (req.method === "GET" && url.pathname === "/v1/images") {
    const items = listImages({ limit: Number(url.searchParams.get("limit")) || 200 })
      .map((item) => ({ ...item, url: `http://127.0.0.1:${PORT}/images/${encodeURIComponent(item.file)}` }));
    return json(res, 200, { total: items.length, items });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/v1/images/")) {
    try {
      const file = decodeURIComponent(url.pathname.slice("/v1/images/".length));
      return json(res, 200, { state: "succeeded", ...deleteImage(file) });
    } catch (e) {
      return json(res, 400, { state: "failed", error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/warmup") {
    let body = {};
    try { body = await readBody(req); } catch { /* 空 body 允许 */ }
    const workers = usableWorkers();
    const count = Math.min(workers.length, Math.max(1, Number(body.count) || workers.length));
    const targets = workers.slice(0, count).map((w) => w.workerId);
    const results = await pool.warmup(targets);
    return json(res, 200, { state: "succeeded", workers: targets.length, results, pool: poolState() });
  }

  if (req.method === "POST" && url.pathname === "/v1/debug/probe") {
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空 body */ }
    try {
      const result = await pool.probe(body.worker_id ? Number(body.worker_id) : null, {
        method: body.method,
        submit: Boolean(body.submit),
        text: body.text,
        waitMs: Number(body.wait_ms) || 0,
      });
      return json(res, 200, { state: "succeeded", ...result, url: result.url });
    } catch (e) {
      return json(res, 502, { state: "failed", error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/debug/dom") {
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空 body */ }
    try {
      const result = await pool.inspect(body.worker_id ? Number(body.worker_id) : null, { url: body.url });
      return json(res, 200, { state: "succeeded", ...result });
    } catch (e) {
      return json(res, 502, { state: "failed", error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/shutdown") {
    json(res, 200, { state: "succeeded", message: "shutting down" });
    setTimeout(() => shutdown("api request"), 200);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    let body;
    try { body = await readBody(req); } catch (e) {
      return json(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
    }
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return json(res, 400, { error: { message: "缺少 prompt", type: "invalid_request_error" } });
    const timeoutMs = Number(body.timeout_seconds) > 0 ? Number(body.timeout_seconds) * 1000 : 240000;
    try {
      const result = await runWithRetry("image", { prompt, timeoutMs }, {
        attempts: body.worker_id ? 1 : Math.min(3, Math.max(1, usableWorkers().length)),
        workerId: body.worker_id ? Number(body.worker_id) : null,
      });
      log(`image ok worker=${result.workerId} elapsed=${result.elapsedMs}ms session=${result.session}`);
      if (body.response_format === "b64_json") {
        const file = result.imagePath || "";
        const b64 = file && existsSync(file) ? readFileSync(file).toString("base64") : "";
        if (!b64) return json(res, 502, { error: { message: "生图完成但读取图片失败", type: "upstream_error" } });
        return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }], pool: result });
      }
      const file = result.imagePath ? path.basename(result.imagePath) : "";
      const imageUrl = file ? `http://127.0.0.1:${PORT}/images/${encodeURIComponent(file)}` : result.imageUrl;
      if (!imageUrl) return json(res, 502, { error: { message: "生图完成但没有图片地址", type: "upstream_error" } });
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: imageUrl, revised_prompt: prompt }],
        pool: { workerId: result.workerId, elapsedMs: result.elapsedMs, queueMs: result.queueMs, session: result.session, stages: result.stages },
      });
    } catch (e) {
      const message = String(e?.message || e);
      log(`image failed: ${message.slice(0, 400)}`);
      return json(res, statusForError(message), { error: { message, type: "upstream_error" } });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return json(res, 404, { error: { message: "对话模型已下线：号池仅支持生图，请用 /v1/images/generations", type: "invalid_request_error" } });
  }

  json(res, 404, { error: { message: `unknown endpoint ${req.method} ${url.pathname}` } });
});

server.on("error", (e) => {
  log(`server error: ${e.message}`);
  process.exit(e.code === "EADDRINUSE" ? 0 : 1);
});
server.listen(PORT, "127.0.0.1", async () => {
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), String(process.pid), "utf8"); } catch { /* 忽略 */ }
  log(`listening on http://127.0.0.1:${PORT}/v1 concurrency=${CONCURRENCY()} idle=${Math.round(WARM_IDLE_MS() / 1000)}s`);
  const prewarm = Math.max(0, Number(env("RUODAO_POOL_PREWARM", "0")) || 0);
  if (prewarm > 0) {
    const targets = usableWorkers().slice(0, prewarm).map((w) => w.workerId);
    if (targets.length) {
      log(`prewarm ${targets.length} worker(s): ${targets.join(",")}`);
      void pool.warmup(targets).then((r) => log(`prewarm done ${JSON.stringify(r)}`)).catch((e) => log(`prewarm failed: ${e.message}`));
    }
  }
});

let exiting = false;
async function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  shuttingDown = true;
  log(`shutdown: ${reason}`);
  await pool.closeAll().catch(() => {});
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), "", "utf8"); } catch { /* 忽略 */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutdown(sig); });

process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e?.message || e).slice(0, 300)}`));
process.on("uncaughtException", (e) => log(`uncaughtException: ${String(e?.message || e).slice(0, 300)}`));
