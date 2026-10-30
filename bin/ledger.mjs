/**
 * 号池台账（CLI / 守护进程 / 工作台共用）
 *
 * 每次生图或对话都追加一行到 usage.jsonl（兼容旧记录），并在 images/ 下写同名 .json 元数据。
 * 统计口径：
 *   kind  image | chat（旧的 generate / generate-direct 归一为 image）
 *   state completed | failed
 *   stages 记录冷启动/导航/提交/出结果/取图各阶段耗时，用于定位「慢在哪」
 * 额度：ChatGPT 网页端不暴露「剩余额度」，这里给出可观测口径（今日成功/失败、限流标记与恢复时间）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const env = (k, d = "") => (process.env[k] ?? d).trim();

export function resolveDataDir() {
  const custom = env("RUODAO_IMAGE_POOL_DATA_DIR", "");
  if (custom) return custom;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"), "RuodaoImagePool");
  }
  if (process.platform === "darwin") return path.join(process.env.HOME || ".", "Library", "Application Support", "RuodaoImagePool");
  return path.join(process.env.HOME || ".", ".local", "share", "ruodao-image-pool");
}

export const DATA_DIR = resolveDataDir();
export const ledgerFile = () => path.join(DATA_DIR, "usage.jsonl");
export const workersFile = () => path.join(DATA_DIR, "workers.json");
export const imagesDir = () => path.join(DATA_DIR, "images");

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function maskEmail(v) {
  const s = String(v || "");
  if (!s) return "";
  return s.length > 4 ? `${s.slice(0, 2)}***${s.slice(-2)}` : "***";
}

export function appendLedger(record) {
  ensureDataDir();
  appendFileSync(ledgerFile(), JSON.stringify({ ts: Date.now(), ...record }) + "\n", "utf8");
}

export function readLedger() {
  try {
    return readFileSync(ledgerFile(), "utf8")
      .split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function readWorkersState() {
  try { return JSON.parse(readFileSync(workersFile(), "utf8")); } catch { return { nextId: 1, workers: [] }; }
}

const LOCAL_DAY = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function normalizeRecord(raw) {
  const kind = raw.kind === "chat" ? "chat"
    : /^generate/.test(String(raw.kind || "")) || raw.kind === "image" ? "image"
      : String(raw.kind || "other");
  const completed = raw.state === "completed";
  const stages = raw.stages && typeof raw.stages === "object" ? raw.stages : undefined;
  return {
    ts: Number(raw.ts) || 0,
    kind,
    state: completed ? "completed" : "failed",
    workerId: raw.workerId != null ? Number(raw.workerId) : null,
    account: raw.account || "",
    model: raw.model || (kind === "image" ? "chatgpt-direct" : "gpt-6-astra"),
    requestedModel: raw.requestedModel || "",
    source: raw.source || "",
    elapsedMs: Number(raw.elapsedMs) || 0,
    queueMs: Number(raw.queueMs) || 0,
    stages,
    promptChars: Number(raw.promptChars) || 0,
    chars: Number(raw.chars) || 0,
    prompt: raw.prompt || "",
    imagePath: raw.imagePath || "",
    imageUrl: raw.imageUrl || "",
    error: completed ? "" : String(raw.error || ""),
  };
}

function emptyBucket() {
  return { total: 0, completed: 0, failed: 0, elapsedSum: 0, queueSum: 0, chars: 0 };
}

function addTo(bucket, rec) {
  bucket.total++;
  if (rec.state === "completed") bucket.completed++;
  else bucket.failed++;
  bucket.elapsedSum += rec.elapsedMs;
  bucket.queueSum += rec.queueMs;
  bucket.chars += rec.chars;
}

function finishBucket(b) {
  return {
    total: b.total,
    generated: b.completed,
    failed: b.failed,
    successRate: b.total ? Math.round((b.completed / b.total) * 1000) / 10 : 0,
    avgElapsedMs: b.total ? Math.round(b.elapsedSum / b.total) : 0,
    avgQueueMs: b.total ? Math.round(b.queueSum / b.total) : 0,
    chars: b.chars,
    tokensEstimate: Math.ceil(b.chars / 4),
  };
}

const STAGE_KEYS = ["openMs", "modelMs", "submitMs", "resultMs", "extractMs"];

/**
 * @param {object[]} rows 原始台账行
 * @param {{days?:number, now?:number, workers?: object[]}} options
 */
export function aggregateUsage(rows, { days = 30, now = Date.now(), workers = [] } = {}) {
  const span = Math.max(1, Number(days) || 30);
  const since = now - span * 86400_000;
  const records = rows.map(normalizeRecord).filter((r) => r.ts >= since);

  const total = emptyBucket();
  const byKind = { image: emptyBucket(), chat: emptyBucket(), other: emptyBucket() };
  const byDay = new Map();
  const byModel = new Map();
  const byAccount = new Map();
  const stageSums = Object.fromEntries(STAGE_KEYS.map((k) => [k, { sum: 0, n: 0 }]));
  const errors = new Map();

  for (const rec of records) {
    addTo(total, rec);
    if (!byKind[rec.kind]) byKind[rec.kind] = emptyBucket();
    addTo(byKind[rec.kind], rec);

    const day = LOCAL_DAY(rec.ts);
    if (!byDay.has(day)) byDay.set(day, emptyBucket());
    addTo(byDay.get(day), rec);

    const model = rec.model || "未知";
    if (!byModel.has(model)) byModel.set(model, emptyBucket());
    addTo(byModel.get(model), rec);

    const account = rec.account || (rec.workerId != null ? `#${rec.workerId}` : "未记录");
    if (!byAccount.has(account)) byAccount.set(account, emptyBucket());
    addTo(byAccount.get(account), rec);

    if (rec.stages) {
      for (const key of STAGE_KEYS) {
        const value = Number(rec.stages[key]);
        if (value > 0) { stageSums[key].sum += value; stageSums[key].n++; }
      }
    }
    if (rec.state === "failed" && rec.error) {
      const key = rec.error.replace(/\s+/g, " ").slice(0, 160);
      const item = errors.get(key) || { message: key, count: 0, lastAt: 0 };
      item.count++;
      item.lastAt = Math.max(item.lastAt, rec.ts);
      errors.set(key, item);
    }
  }

  const mapToObj = (map, mapFn = finishBucket) => Object.fromEntries([...map.entries()].map(([k, v]) => [k, mapFn(v)]));
  const objToObj = (obj, mapFn = finishBucket) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, mapFn(v)]));
  const stageAvg = Object.fromEntries(Object.entries(stageSums).map(([k, v]) => [k, v.n ? Math.round(v.sum / v.n) : 0]));

  // 额度：按账号给出今日调用与限流状态（网页端不暴露剩余次数，只能给可观测口径）
  const todayKey = LOCAL_DAY(now);
  const today = rows.map(normalizeRecord).filter((r) => LOCAL_DAY(r.ts) === todayKey);
  const quotaAccounts = (workers || []).map((w) => {
    const mine = today.filter((r) => r.workerId === Number(w.workerId));
    const last = rows.map(normalizeRecord).filter((r) => r.workerId === Number(w.workerId)).sort((a, b) => b.ts - a.ts)[0];
    const limitedUntil = Number(w.limitedUntil) || 0;
    return {
      workerId: Number(w.workerId),
      email: maskEmail(w.email),
      loggedIn: Boolean(w.loggedIn),
      todayTotal: mine.length,
      todayCompleted: mine.filter((r) => r.state === "completed").length,
      todayFailed: mine.filter((r) => r.state === "failed").length,
      totalCalls: Number(w.usageCount) || 0,
      limited: limitedUntil > now,
      limitedUntil: limitedUntil || 0,
      availableInMs: Math.max(0, limitedUntil - now),
      lastCallAt: last?.ts || 0,
      lastError: last?.state === "failed" ? last.error.slice(0, 120) : "",
    };
  });

  return {
    days: span,
    since,
    totalTasks: total.total,
    generated: total.completed,
    failed: total.failed,
    successRate: finishBucket(total).successRate,
    avgElapsedMs: finishBucket(total).avgElapsedMs,
    avgQueueMs: finishBucket(total).avgQueueMs,
    totalChars: total.chars,
    tokensEstimate: Math.ceil(total.chars / 4),
    today: finishBucket(today.reduce((b, r) => { addTo(b, r); return b; }, emptyBucket())),
    byKind: objToObj(byKind),
    byDay: mapToObj(byDay),
    byModel: mapToObj(byModel),
    byAccount: mapToObj(byAccount),
    stages: stageAvg,
    quota: { date: todayKey, accounts: quotaAccounts },
    errors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    ledgerFile: ledgerFile(),
  };
}

export function queryLogs(rows, { days = 7, limit = 100, offset = 0, kind = "", state = "", workerId = "", q = "", now = Date.now() } = {}) {
  const since = now - Math.max(1, Number(days) || 7) * 86400_000;
  const keyword = String(q || "").trim().toLowerCase();
  const all = rows.map(normalizeRecord)
    .filter((r) => r.ts >= since)
    .filter((r) => !kind || r.kind === kind)
    .filter((r) => !state || r.state === state)
    .filter((r) => workerId === "" || workerId == null || r.workerId === Number(workerId))
    .filter((r) => !keyword || `${r.prompt} ${r.model} ${r.account} ${r.error}`.toLowerCase().includes(keyword))
    .sort((a, b) => b.ts - a.ts);
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(500, Math.max(1, Number(limit) || 100));
  return { total: all.length, offset: start, limit: size, rows: all.slice(start, start + size) };
}

/* ---------------- 图片库 ---------------- */

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function writeImageMeta(file, meta) {
  try {
    writeFileSync(`${file}.json`, JSON.stringify({ ts: Date.now(), ...meta }), "utf8");
  } catch { /* 元数据失败不影响出图 */ }
}

export function listImages({ limit = 200 } = {}) {
  const dir = imagesDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => IMAGE_EXT.test(f));
  const records = readLedger().map(normalizeRecord);
  const items = files.map((file) => {
    const full = path.join(dir, file);
    let stat = { size: 0, mtimeMs: 0 };
    try { stat = statSync(full); } catch { /* 忽略 */ }
    let meta = null;
    try { meta = JSON.parse(readFileSync(`${full}.json`, "utf8")); } catch { /* 旧文件无元数据 */ }
    const fallback = records.filter((r) => r.imagePath && path.basename(r.imagePath) === file).sort((a, b) => b.ts - a.ts)[0];
    return {
      file,
      size: stat.size,
      ts: Number(meta?.ts) || Number(fallback?.ts) || stat.mtimeMs,
      prompt: meta?.prompt || fallback?.prompt || "",
      model: meta?.model || fallback?.model || "chatgpt-direct",
      workerId: meta?.workerId ?? fallback?.workerId ?? null,
      elapsedMs: Number(meta?.elapsedMs) || fallback?.elapsedMs || 0,
      path: full,
    };
  }).sort((a, b) => b.ts - a.ts);
  return items.slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)));
}

export function deleteImage(file) {
  const name = path.basename(String(file || ""));
  if (!name || !IMAGE_EXT.test(name)) throw new Error("文件名不合法");
  const full = path.join(imagesDir(), name);
  if (!existsSync(full)) throw new Error("图片不存在");
  rmSync(full, { force: true });
  rmSync(`${full}.json`, { force: true });
  return { removed: name };
}
