#!/usr/bin/env node
/**
 * image-pool 直驱模块：插件内嵌 Playwright 直驱 VirtualBrowser 指纹窗口，
 * 不经过 FPBrowser2API 网关（Python/Git/管理后台全部免装）。
 *
 * 能力：
 *   bindLoginAccounts(text)  批量自动登录：解析 邮箱----密码----2FA，为每个账号分配独立
 *                            worker 指纹窗口，打开 chatgpt.com 自动填表 + TOTP 自动算码，
 *                            登录态落盘在 VirtualBrowser worker 目录永久保活。
 *   directGenerate(input)    挑选已登录 worker 直驱生图：注入防反问咒语 → 提交 → 轮询页面 →
 *                            会话内 fetch 原图转 base64 落盘（避开外链 403）→ 写消耗台账。
 *
 * 依赖：vendor/playwright-core（已随插件分发）；VirtualBrowser 主程序（locateVbExe）。
 * 说明：ChatGPT 页面结构可能随版本变化，选择器全部采用多候选回退，失败时输出可操作的提示。
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLedger, ensureDataDir as ensureLedgerDir, imagesDir, maskEmail as maskLedgerEmail, writeImageMeta } from "./ledger.mjs";
import { resolveChatModel } from "./pool-models.mjs";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const env = (k, d = "") => (process.env[k] ?? d).trim();
const VB_EXE = () => env("RUODAO_VB_EXE", "");

// 与主 CLI 一致的运行时数据目录：必须在插件目录之外，否则插件更新时会被运行中的进程锁住（EBUSY）
function resolveDataDir() {
  const custom = env("RUODAO_IMAGE_POOL_DATA_DIR", "");
  if (custom) return custom;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"), "RuodaoImagePool");
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || ".", "Library", "Application Support", "RuodaoImagePool");
  }
  return path.join(process.env.HOME || ".", ".local", "share", "ruodao-image-pool");
}
const DATA_DIR = resolveDataDir();
try {
  // 同主 CLI：避免拉起的 VirtualBrowser 以插件目录为 CWD（会锁住插件目录导致更新 EBUSY）
  mkdirSync(DATA_DIR, { recursive: true });
  process.chdir(DATA_DIR);
} catch { /* 忽略 */ }
const IMAGES_DIR = () => path.join(DATA_DIR, "images");
const WORKERS_FILE = () => path.join(DATA_DIR, "workers.json");
const LEDGER_FILE = () => path.join(DATA_DIR, "usage.jsonl");

export function hasPlaywright() {
  try { require(path.join(PLUGIN_DIR, "vendor", "playwright-core", "package.json")); return true; } catch { return false; }
}

function playwright() {
  return require(path.join(PLUGIN_DIR, "vendor", "playwright-core"));
}

/* ---------------- TOTP（RFC 6238，纯 Node 实现） ---------------- */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secretB32, timeStep = 30, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / timeStep)));
  const hmac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

/* ---------------- Worker 指纹窗口管理 ---------------- */

function vbWorkersDir() {
  const custom = env("RUODAO_VB_WORKERS_DIR", "");
  if (custom) return custom;
  const la = process.env.LOCALAPPDATA || "";
  return la ? path.join(la, "VirtualBrowser", "Workers") : "";
}

// 安装目录里有两种同名的 VirtualBrowser.exe，直驱只能用第二种：
//   1) <安装根>\VirtualBrowser.exe                     → Electron 管理客户端，任何 Chromium 参数都是 "bad option"
//   2) <安装根>\VirtualBrowser\<内核版本>\VirtualBrowser.exe → Chromium 内核，Playwright 的 --worker-id 靠它生效
// 旧版布局为 <安装根>\Chrome-bin\VirtualBrowser.exe。
function vbKernelExeFrom(root) {
  if (!root) return "";
  const versioned = path.join(root, "VirtualBrowser");
  try {
    const versions = readdirSync(versioned)
      .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d) && existsSync(path.join(versioned, d, "VirtualBrowser.exe")))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i]; // 内核版本高者优先
        return 0;
      });
    if (versions[0]) return path.join(versioned, versions[0], "VirtualBrowser.exe");
  } catch { /* 没有版本目录，继续试旧布局 */ }
  const legacy = path.join(root, "Chrome-bin", "VirtualBrowser.exe");
  return existsSync(legacy) ? legacy : "";
}

export function locateVbExe() {
  const configured = VB_EXE();
  if (configured && existsSync(configured)) {
    // 用户直接配了内核 exe（父目录是版本号）→ 原样使用；配成管理客户端 → 自动纠正到同目录内核
    if (/^\d+\.\d+\.\d+\.\d+$/.test(path.basename(path.dirname(configured)))) return configured;
    return vbKernelExeFrom(path.dirname(configured)) || configured;
  }
  const roots = [
    "C:\\Program Files\\VirtualBrowser",
    "C:\\Program Files (x86)\\VirtualBrowser",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "VirtualBrowser") : "",
  ].filter(Boolean);
  for (const root of roots) {
    const kernel = vbKernelExeFrom(root);
    if (kernel) return kernel;
  }
  return "";
}

function readWorkers() {
  try { return JSON.parse(readFileSync(WORKERS_FILE(), "utf8")); } catch { return { nextId: 1, workers: [] }; }
}

function writeWorkers(state) {
  ensureDataDir();
  writeFileSync(WORKERS_FILE(), JSON.stringify(state, null, 2), "utf8");
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function parseAccounts(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/----|\t+|\|/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [email, password, totpSecret] = parts;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    rows.push({ email, password, totpSecret: totpSecret || "" });
  }
  return rows;
}

function maskEmail(v) {
  if (!v) return "";
  return v.length > 4 ? `${v.slice(0, 2)}***${v.slice(-2)}` : "***";
}

/* ---------------- Playwright 通用（反自动化痕迹加固） ---------------- */

// 启动参数加固：去掉 Playwright 默认自动化特征（webdriver 横幅、enable-automation 开关）
const STEALTH_ARGS = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"];
const STEALTH_IGNORE_DEFAULT_ARGS = ["--enable-automation", "--enable-blink-features=IdleDetection"];

function tcpOpen(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

let proxyCache;
const PROXY_FILE = () => path.join(DATA_DIR, "proxy.json");
const PROXY_CACHE_MS = 30 * 60 * 1000;
const normalizeProxy = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  return /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`;
};

// 用 curl 经代理访问指定 URL：返回任意 HTTP 状态码都算链路可用（403 是 Cloudflare 正常拦截）
function proxyReach(proxy, url, timeoutSec = 8) {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  try {
    const r = spawnSync(bin, [
      "-s", "-m", String(timeoutSec), "-x", proxy,
      "-o", process.platform === "win32" ? "NUL" : "/dev/null",
      "-w", "%{http_code}",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      url,
    ], { encoding: "utf8", windowsHide: true, timeout: (timeoutSec + 3) * 1000 });
    return /^[1-5]\d\d$/.test(String(r.stdout || "").trim());
  } catch { return false; }
}

/**
 * 指纹窗口默认直连。国内直连 chatgpt.com 会 ERR_CONNECTION_TIMED_OUT（窗口打开但一片空白，
 * 看起来像"啥也没操作"）。这里自动探测本机代理（显式配置 > Windows 系统代理 > 常见 Clash/V2Ray
 * 端口），并验证能否访问 auth.openai.com（有的端口能开首页却让登录接口超时），命中则传给
 * Playwright。RUODAO_VB_PROXY=off 可强制直连。
 */
export async function detectProxyServer() {
  if (proxyCache !== undefined) return proxyCache;
  const explicit = env("RUODAO_VB_PROXY", "");
  if (/^(off|none|direct)$/i.test(explicit)) return (proxyCache = "");
  if (explicit) return (proxyCache = normalizeProxy(explicit));

  // 30 分钟内复用上次选中的端口，避免每次命令都做连通性探测
  try {
    const saved = JSON.parse(readFileSync(PROXY_FILE(), "utf8"));
    if (saved?.server && Date.now() - Number(saved.at || 0) < PROXY_CACHE_MS) {
      const [host, portText] = String(saved.server).replace(/^[a-z]+:\/\//i, "").split(":");
      if (await tcpOpen(host, Number(portText))) return (proxyCache = saved.server);
    }
  } catch { /* 无缓存 */ }

  const candidates = [];
  if (process.platform === "win32") {
    try {
      const out = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"], { encoding: "utf8", windowsHide: true, timeout: 3000 }).stdout || "";
      const raw = (out.match(/ProxyServer\s+REG_SZ\s+(.+)/) || [])[1]?.trim();
      if (raw) {
        const http = raw.match(/(?:^|;)(?:http|https)=([^;]+)/i);
        candidates.push(http ? http[1] : raw);
      }
    } catch { /* 注册表不可用则跳过 */ }
  }
  // 只列标准 HTTP 代理端口：部分客户端会额外开 SOCKS/内部端口，浏览器不能直接当 HTTP 代理用
  candidates.push(
    "127.0.0.1:7897", "127.0.0.1:7890", "127.0.0.1:9674",
    "127.0.0.1:10809", "127.0.0.1:10808", "127.0.0.1:1080",
  );
  const unique = [...new Set(candidates.map(normalizeProxy).filter(Boolean))];
  const open = [];
  for (const proxy of unique) {
    const [host, portText] = proxy.replace(/^[a-z]+:\/\//i, "").split(":");
    const port = Number(portText);
    if (host && port && await tcpOpen(host, port)) open.push(proxy);
  }
  // 优先选真正能访问 OpenAI 登录域的端口；其次能开首页的；都没有再用第一个监听中的端口
  const pick = open.find((p) => proxyReach(p, "https://auth.openai.com/log-in/password"))
    || open.find((p) => proxyReach(p, "https://chatgpt.com/"))
    || open[0]
    || "";
  if (pick) {
    try { writeFileSync(PROXY_FILE(), JSON.stringify({ server: pick, at: Date.now() }), "utf8"); } catch { /* 缓存失败不影响 */ }
  }
  return (proxyCache = pick);
}

async function launchWorker(vbExe, workerId, workersDir) {
  const { chromium } = playwright();
  const proxy = await detectProxyServer();
  const context = await chromium.launchPersistentContext(path.join(workersDir, String(workerId)), {
    executablePath: vbExe,
    args: [`--worker-id=${workerId}`, ...STEALTH_ARGS],
    ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
    headless: false,
    defaultViewport: null,
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  // 双保险：抹平 navigator.webdriver 与 chrome 对象残留（VirtualBrowser 指纹层之上再补一层）
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      if (!window.chrome) window.chrome = { runtime: {} };
    } catch { /* 忽略 */ }
  });
  return context;
}

// 人类节奏模拟：随机停顿 + 逐字输入
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Playwright 的 page.evaluate 没有默认超时：页面正在导航/流式输出时会永久挂起。
// 所有注入脚本统一走这个包装，超时返回兜底值，让轮询循环还能判断 deadline。
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}
const humanPause = (min = 400, max = 1200) => sleep(min + Math.floor(Math.random() * (max - min)));
async function humanType(page, text, { instant = false } = {}) {
  if (instant) { await page.keyboard.insertText(text); return; }
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 40 + Math.floor(Math.random() * 90) });
  }
}

// 多候选选择器回退：依次尝试，全部失败返回 null
async function trySelectors(page, selectors, { timeout = 6000, visible = true } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: visible ? "visible" : "attached", timeout });
      return el;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 所有选择器共用一个超时预算，一次 evaluate 同时检查，避免 N 个选择器串行等待 */
async function findFirst(page, selectors, { timeout = 2500, visible = true } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const idx = await withTimeout(page.evaluate(({ sels, needVisible }) => {
      const ok = (el) => {
        if (!el) return false;
        if (!needVisible) return true;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
      };
      return sels.findIndex((sel) => ok(document.querySelector(sel)));
    }, { sels: selectors, needVisible: visible }), 4000, -1);
    if (idx >= 0) return page.locator(selectors[idx]).first();
    await sleep(120);
  }
  return null;
}

// 新账号首次进入会弹「更相关、更个性化的回复」记忆引导弹窗，遮住输入框后提示词发不出去，
// 页面看起来一直停在首页（实测卡满超时）。发提示词前把这些引导/隐私弹窗一律点掉。
const ONBOARDING_LABELS = ["知道了", "好，我知道了", "知道了！", "开始使用", "以后再说", "跳过", "Okay", "Got it", "Continue", "Not now"];
async function dismissOnboarding(page) {
  let dismissed = false;
  for (let round = 0; round < 3; round++) {
    const dialogs = page.locator("[role='dialog']");
    const count = await dialogs.count().catch(() => 0);
    let visible = null;
    for (let i = count - 1; i >= 0; i--) {
      if (await dialogs.nth(i).isVisible().catch(() => false)) { visible = dialogs.nth(i); break; }
    }
    if (!visible) {
      // 有些弹层没挂 role=dialog，兜底直接找「知道了」按钮
      const loose = page.getByRole("button", { name: "知道了", exact: false }).first();
      if (await loose.isVisible().catch(() => false)) {
        await loose.click({ timeout: 3000 }).catch(() => {});
        dismissed = true;
        await sleep(500);
        continue;
      }
      return dismissed;
    }
    let clicked = false;
    for (const label of ONBOARDING_LABELS) {
      const btn = visible.getByRole("button", { name: label, exact: false }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(async () => {
          await btn.evaluate((el) => el.click()).catch(() => {});
        });
        clicked = true;
        dismissed = true;
        break;
      }
    }
    if (!clicked) await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }
  return dismissed;
}

async function gotoChatGpt(page) {
  // 指纹环境冷启动 + 代理握手慢，单次 45s 经常超时；放宽到 3 次 × 60s，且超时后
  // 若 URL 已是 chatgpt.com 视为已挂载（资源可能还在慢慢加载）
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (e) {
      lastError = String(e.message || e).split("\n")[0];
      if (page.url().includes("chatgpt.com")) {
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        return;
      }
    }
  }
  throw new Error(`chatgpt.com 打开失败（${lastError || "网络/代理不通"}）。请确认代理可访问 ChatGPT，或设置 RUODAO_VB_PROXY=http://127.0.0.1:代理端口`);
}

// 邮箱提交后：URL 跳到 auth/login_with / auth.openai.com，或密码框已渲染
async function waitForAuthStep(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/auth\/login_with|auth\.openai\.com|login\.live\.com/.test(page.url())) return true;
    if (await page.locator("input[type='password']").first().isVisible().catch(() => false)) return true;
    await sleep(1200);
  }
  return false;
}

// 只点文案完全匹配的按钮（排除「使用电话号码继续」等子串误命中）
async function clickExactButton(page, pattern) {
  return page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
    };
    const btn = [...document.querySelectorAll("button, [role='button']")]
      .find((el) => visible(el) && re.test((el.textContent || "").trim()));
    if (!btn) return false;
    btn.click();
    return true;
  }, pattern.source).catch(() => false);
}

// 登录失败时落截图 + 页面文本，便于定位是验证码、风控还是改版
async function loginSnapshot(page, name) {
  const file = path.join(DATA_DIR, `debug-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  const info = await page.evaluate(() => ({
    title: document.title || "",
    text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 240),
  })).catch(() => ({ title: "", text: "" }));
  return { file, url: page.url(), ...info };
}

function isLoggedIn(page) {
  // 登录判定：出现输入框（composer）即视为已登录
  return trySelectors(page, ["#prompt-textarea", "textarea[data-id='root']", "div[contenteditable='true']"], { timeout: 8000 });
}

/* ---------------- VirtualBrowser 本地 API（自动发现端口 / 自动建环境） ----------------
 * 官方接口：POST /api/getBrowserList、POST /api/addBrowser、GET /api/getGroupList、
 * GET /api/getCoreVersions…，header 需要 api-key，端口是动态的（不一定 9000）。
 * 有了 key 就能全自动建环境，用户无需再在客户端里手动创建。
 */

const VB_API_FILE = () => path.join(DATA_DIR, "vb-api.json");

function vbKey() {
  return env("RUODAO_VB_API_KEY", "");
}

function errorText(value, fallback = "") {
  if (typeof value === "string" && value) return value;
  if (value == null) return fallback;
  try { return JSON.stringify(value).slice(0, 200); } catch { return fallback || String(value); }
}

async function vbGet(base, pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", "api-key": vbKey(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeoutMs || 15000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

// 列出 VirtualBrowser 进程正在监听的端口（端口动态，且必须属于 VB 进程，避免误判其他应用的端口）
function vbListenPorts() {
  try {
    const vbPids = new Set();
    const tl = spawnSync("tasklist", [], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    for (const line of String(tl.stdout || "").split(/\r?\n/)) {
      // 自建 API 版是独立的 virtualbrowser_api.exe（默认 :9000），必须一并识别
      const m = line.match(/^"?(VirtualBrowser|virtualbrowser_api)\.exe"?\s+(\d+)/i);
      if (m) vbPids.add(m[2]);
    }
    const res = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    const ports = [];
    for (const line of String(res.stdout || "").split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && (vbPids.size === 0 || vbPids.has(m[2]))) ports.push(Number(m[1]));
    }
    return { ports, vbRunning: vbPids.size > 0 };
  } catch { return { ports: [], vbRunning: false }; }
}

// VB 的错误响应可能是 JWT（payload 内含 errCode/errMsg/port），解码后用于识别端口与原因
function decodeVbJwt(raw) {
  try {
    if (typeof raw !== "string" || !raw.startsWith("eyJ")) return null;
    const payload = raw.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch { return null; }
}

/**
 * 自动发现 VirtualBrowser 本地 API 端口：逐个探测候选端口上的 /api/getBrowserList，
 * 返回 { success:true } 或 VB 风格响应（JWT errMsg / error 字段）即认定为 API 端口。
 */
export async function vbDiscover() {
  const explicit = env("RUODAO_VB_API_BASE", "").trim();
  const candidates = [];
  if (explicit) candidates.push(explicit.replace(/\/+$/, ""));
  const known = (() => { try { return JSON.parse(readFileSync(VB_API_FILE(), "utf8")).base; } catch { return ""; } })();
  if (known) candidates.push(known);
  // 自建 API 版固定监听 9000：即使进程名不匹配也先探一次
  candidates.push("http://127.0.0.1:9000");
  const { ports, vbRunning } = vbListenPorts();
  for (const p of ports) candidates.push(`http://127.0.0.1:${p}`);
  const seen = new Set();
  for (const base of candidates) {
    if (seen.has(base)) continue;
    seen.add(base);
    try {
      const { data } = await vbGet(base, "/api/getBrowserList", { timeoutMs: 2500 });
      if (!data || typeof data !== "object") continue;
      if (data.success === true) {
        ensureDataDir();
        writeFileSync(VB_API_FILE(), JSON.stringify({ base, updatedAt: Date.now() }), "utf8");
        return { ok: true, base, list: data.data || [] };
      }
      // JWT 形态的 VB 错误响应：说明端口确实是 VB API，只是 api-key 缺失/无效或格式问题
      const jwt = decodeVbJwt(data.raw);
      if (jwt && (jwt.errCode || jwt.errMsg)) {
        return { ok: false, base, needKey: true, error: `${jwt.errMsg || "api-key 无效"}（端口 ${jwt.port || base.split(":").pop()}）` };
      }
      if ("error" in data || "message" in data) {
        return { ok: false, base, needKey: true, error: errorText(data.error || data.message, "api-key 无效") };
      }
    } catch { /* 下一个端口 */ }
  }
  if (vbRunning) {
    return {
      ok: false,
      base: "",
      needEnable: true,
      error: "VirtualBrowser 已运行，但自带 API 服务未就绪：回插件点「启动服务」或重跑「一键安装」，会自动拉起 virtualbrowser_api.exe（:9000，免 Key）",
    };
  }
  return { ok: false, base: "", error: "VirtualBrowser API 未运行：回插件点「启动服务」或重跑「一键安装」，会自动拉起虚拟浏览器与 API 服务" };
}

async function vbGroupId(base) {
  const { data } = await vbGet(base, "/api/getGroupList");
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  if (list.length) return String(list[0].id ?? list[0].groupId ?? list[0].name ?? list[0]);
  const created = await vbGet(base, "/api/addGroup", { method: "POST", body: JSON.stringify({ name: "ruodao" }) });
  return String(created.data?.data?.id ?? created.data?.id ?? "1");
}

async function vbChromeVersion(base) {
  try {
    const { data } = await vbGet(base, "/api/getCoreVersions");
    const majors = data?.majors || data?.data?.majors || [];
    if (Array.isArray(majors) && majors.length) return Number(majors[0]) || 132;
  } catch { /* 用默认值 */ }
  return 132;
}

/**
 * 确保号池有足够环境：已有环境数量不足时，用 /api/addBrowser 自动创建补齐。
 * 返回 { base, profiles: [{id, name}] }，id 即 worker 编号。
 */
export async function vbEnsureEnvironments(need, { names = [] } = {}) {
  const found = await vbDiscover();
  if (!found.ok) throw new Error(errorText(found.error, "VirtualBrowser API 不可用"));
  const base = found.base;
  let profiles = (found.list || []).map((p) => ({ id: Number(p.id), name: p.name }));
  if (profiles.length >= need) return { base, profiles, created: 0 };

  const groupId = await vbGroupId(base);
  const chromeVersion = await vbChromeVersion(base);
  let created = 0;
  for (let i = profiles.length; i < need; i++) {
    const name = names[i] || `ruodao-${i + 1}`;
    const body = {
      name,
      group: [groupId],
      chrome_version: chromeVersion,
      proxy: { mode: 0, value: "", protocol: "HTTP", host: "", port: "", user: "", pass: "", API: "" },
      homepage: { mode: 0, value: "" },
    };
    const { data } = await vbGet(base, "/api/addBrowser", { method: "POST", body: JSON.stringify(body), timeoutMs: 30000 });
    if (data?.success === true && data?.data?.id != null) {
      profiles.push({ id: Number(data.data.id), name });
      created++;
    } else {
      throw new Error(`自动创建环境失败：${data?.error || data?.message || JSON.stringify(data).slice(0, 200)}`);
    }
  }
  return { base, profiles, created };
}

/* ---------------- 批量自动登录 ---------------- */

/* ---------------- 无 VIP 模式：探测已创建环境的窗口编号 ---------------- */

/**
 * VirtualBrowser 的窗口编号 = 环境 id（`--worker-id=N`）。没有 VIP（无 API）时，
 * 通过逐个尝试拉起窗口来发现可用编号：拉起成功即可用，失败（环境不存在）即跳过。
 */
async function probeWorkerIds(maxId = 20, onProgress = () => {}) {
  const vbExe = locateVbExe();
  const workersDir = vbWorkersDir();
  const found = [];
  for (let id = 1; id <= maxId; id++) {
    let ctx = null;
    try {
      ctx = await launchWorker(vbExe, id, workersDir);
      found.push(id);
      onProgress(`发现可用环境 #${id}（已发现 ${found.length} 个）`);
    } catch {
      // 环境不存在或启动失败：跳过
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }
  return found;
}

/**
 * 分配 worker 环境：已绑定账号复用原环境，新账号从未占用环境里顺序分配。
 * profileIds 来自自带 API（自动建环境）或手动/探测结果。
 */
export function planWorkerBindings({ rows, workers = [], profileIds = [] }) {
  const boundIds = new Set(workers.map((w) => w.workerId));
  const free = profileIds.filter((id) => !boundIds.has(id));
  const freshCount = rows.filter((row) => !workers.some((w) => w.email === row.email)).length;
  if (free.length < freshCount) {
    return { ok: false, error: `可用环境不足：需要 ${freshCount} 个，当前可用 ${free.length} 个。请点「启动服务」后重试（自带 API 会自动补建环境），或在 VirtualBrowser 客户端手动创建环境` };
  }
  return {
    ok: true,
    assignments: rows.map((row) => {
      const existing = workers.find((w) => w.email === row.email);
      return existing ? { row, workerId: existing.workerId, existing: true } : { row, workerId: free.shift(), existing: false };
    }),
  };
}

export async function bindLoginAccounts(text, { onProgress = () => {} } = {}) {
  const rows = parseAccounts(text);
  if (!rows.length) throw new Error("未解析出任何账号（格式：每行 邮箱----密码----2FA密钥）");
  const vbExe = locateVbExe();
  if (!vbExe) throw new Error("未找到 VirtualBrowser.exe：请先完成安装（setup 或手动），或在配置里填 RUODAO_VB_EXE");
  if (!hasPlaywright()) throw new Error("插件缺少内置 playwright-core，安装可能不完整，请重装插件");
  const workersDir = vbWorkersDir();
  if (!workersDir) throw new Error("无法定位 VirtualBrowser Workers 目录，请配置 RUODAO_VB_WORKERS_DIR");
  const state = readWorkers();
  const boundIds = new Set(state.workers.map((w) => w.workerId));
  const newCount = rows.filter((row) => !state.workers.some((w) => w.email === row.email)).length;

  // 环境来源：优先走自带 API 自动建环境（免 Key）；API 不可用时回退到手动/探测已有环境
  let profileIds = [];
  try {
    const ensured = await vbEnsureEnvironments(Math.max(rows.length, boundIds.size + newCount), {
      names: rows.map((r) => `ruodao-${r.email.split("@")[0]}`.slice(0, 28)),
    });
    profileIds = ensured.profiles.map((p) => p.id);
    onProgress({ step: `VirtualBrowser API 就绪（${ensured.base}），环境 ${ensured.profiles.length} 个${ensured.created ? `，本次自动创建 ${ensured.created} 个` : ""}` });
  } catch (apiError) {
    if (vbKey()) throw apiError;
    const manual = env("RUODAO_VB_WORKER_IDS", "").split(/[,\s]+/).map(Number).filter(Boolean);
    if (manual.length) {
      profileIds = manual;
      onProgress({ step: `自带 API 不可用（${apiError.message}），使用手动配置的窗口编号：${manual.join(", ")}` });
    } else {
      onProgress({ step: `自带 API 不可用（${apiError.message}）：正在探测客户端里已创建的环境编号，请勿关闭 VirtualBrowser` });
      profileIds = await probeWorkerIds(Math.max(rows.length * 2, 8), (msg) => onProgress({ step: msg }));
    }
    onProgress({ step: `已探测到 ${profileIds.length} 个可用环境（编号：${profileIds.slice(0, 6).join(", ")}${profileIds.length > 6 ? "…" : ""}）` });
  }

  // 环境 id 即 worker 编号：优先复用账号已绑定的，其次分配未被占用的新环境
  const plan = planWorkerBindings({ rows, workers: state.workers, profileIds });
  if (!plan.ok) throw new Error(plan.error);
  const results = [];
  for (const { row, workerId, existing } of plan.assignments) {
    state.nextId = Math.max(Number(state.nextId) || 1, Number(workerId) + 1);
    if (!existing) state.workers.push({ workerId, email: row.email, loggedIn: false, usageCount: 0, createdAt: Date.now() });
    writeWorkers(state);
    const entry = { workerId, email: maskEmail(row.email), ok: false };
    let context;
    try {
      context = await launchWorker(vbExe, workerId, workersDir);
      const page = context.pages()[0] || (await context.newPage());
      const proxy = await detectProxyServer();
      if (proxy) onProgress({ workerId, step: `指纹窗口使用本地代理 ${proxy}` });
      onProgress({ workerId, step: "打开 chatgpt.com" });
      await gotoChatGpt(page);

      if (!(await isLoggedIn(page))) {
        // 上次中断的登录会留下 pending/state 痕迹，重登时服务端报 invalid_state / 会话已失效；
        // 开新登录前清掉这些中间态（保留 Cloudflare 与设备指纹 Cookie）
        await context.clearCookies({ name: /next-auth|oai-mweb-auth-pending|auth-session|oai-login-csrf|iss_context|rg_context/i }).catch(() => {});
        await page.evaluate(() => {
          try {
            Object.keys(localStorage).filter((k) => /auth|next-auth|openai/i.test(k)).forEach((k) => localStorage.removeItem(k));
          } catch { /* 页面可能禁止访问 */ }
        }).catch(() => {});
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        onProgress({ workerId, step: "进入登录页" });
        // 进入登录入口
        const loginBtn = await trySelectors(page, [
          "button:has-text('Log in')", "button:has-text('登录')", "[data-testid='login-button']",
          "a:has-text('Log in')", "a:has-text('登录')",
        ], { timeout: 8000 });
        if (loginBtn) await loginBtn.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

        // 邮箱（登录弹窗可能默认停在电话 Tab：先点「继续使用电子邮箱」切换；再找邮箱框，兼容 login_hint）
        const emailTabBtn = await trySelectors(page, [
          "button:has-text('继续使用电子邮箱')", "button:has-text('Continue with email')",
          "div:has-text('继续使用电子邮箱')", "[data-testid='email-login-button']",
        ], { timeout: 5000 });
        if (emailTabBtn) { await emailTabBtn.click(); onProgress({ workerId, step: "切换到邮箱登录" }); await humanPause(600, 1200); }
        const emailInput = await trySelectors(page, ["input[name='email']", "input[name='login_hint']", "input[type='email']", "#email-input"], { timeout: 15000 });
        if (!emailInput) throw new Error("未找到邮箱输入框（页面可能改版或出现人机验证，请手动完成该窗口登录）");
        await emailInput.click();
        await humanPause(300, 800);
        await humanType(page, row.email);
        await humanPause();
        // 提交：实测 Enter 最可靠；点击 "button:has-text('继续')" 会子串命中「使用电话号码继续」，
        // 点错后页面停在电话 Tab，密码页永远不出现（2026-10-22 实测）。先 Enter，再兜底精确文案按钮。
        await page.keyboard.press("Enter").catch(() => {});
        let submitted = await waitForAuthStep(page, 15000);
        if (!submitted) {
          submitted = await clickExactButton(page, /^(continue|next|继续|下一步)$/i);
          if (submitted) submitted = await waitForAuthStep(page, 20000);
        }
        if (submitted) onProgress({ workerId, step: "已提交邮箱，等待密码页" });

        // 密码（中转跳转 + 渲染可能超过 15s，轮询最长 60s）
        let pwdInput = null;
        for (let waited = 0; waited < 60000 && !pwdInput; waited += 3000) {
          pwdInput = await trySelectors(page, ["input[name='password']", "input[type='password']"], { timeout: 3000 });
        }
        if (!pwdInput) {
          const snap = await loginSnapshot(page, "pwd-page");
          onProgress({ workerId, step: `密码页未出现：${snap.title || snap.url}（截图 ${snap.file}）` });
          throw new Error(`未找到密码输入框（可能触发风控验证，请手动完成该窗口登录）。当前页面：${snap.title || snap.url}`);
        }
        await pwdInput.click();
        await humanPause(300, 800);
        await humanType(page, row.password);
        await humanPause();
        // Enter 提交；若密码框仍在（未提交/被拒）再点精确「继续」按钮兜底
        await page.keyboard.press("Enter").catch(() => {});
        await sleep(2500);
        if (await page.locator("input[type='password']").first().isVisible().catch(() => false)) {
          const clicked = await clickExactButton(page, /^(continue|next|继续|下一步)$/i);
          if (!clicked) {
            const submitBtn = await trySelectors(page, ["button[type='submit']"], { timeout: 3000 });
            if (submitBtn) await submitBtn.click();
          }
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

        let lastPwdSubmitAt = Date.now();
        let pwdAttempts = 1;
        let lastOtpFillAt = 0;
        let otpFillCount = 0;

        const OTP_SELECTOR = [
          "input[name='code']",
          "input[inputmode='numeric']",
          "input[autocomplete='one-time-code']",
          "input[type='tel'][name='otp']",
          "input[maxlength='1'][type='text']",
          "input[aria-label*='验证码']",
          "input[aria-label*='verification code']",
        ].join(", ");
        const otpLoc = page.locator(OTP_SELECTOR).first();
        const composerLoc = page.locator("#prompt-textarea, textarea[data-id='root'], div[contenteditable='true']").first();
        // 慢代理下 auth.openai.com 可能 3+ 分钟才返回 2FA 页，统一循环处理验证码/超时/重试
        const loginDeadline = Date.now() + 360000;
        let composer = null;
        let lastRetryClickAt = 0;
        let lastKeepaliveAt = Date.now();
        while (Date.now() < loginDeadline) {
          if (await composerLoc.isVisible().catch(() => false)) { composer = composerLoc; break; }

          const bodyText = await page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
          if (/密码不正确|密码错误|incorrect password|invalid password/i.test(bodyText)) {
            throw new Error("密码不正确（请检查发货文本中的密码）");
          }

          // 2FA 页随时可能出现：每次填新码（TOTP 30s 过期，超时后自动换码重填）
          if (await otpLoc.isVisible().catch(() => false)) {
            if (!row.totpSecret) throw new Error("该账号需要 2FA 验证码但未提供 2FA 密钥");
            if (Date.now() - lastOtpFillAt > 35000) {
              lastOtpFillAt = Date.now();
              otpFillCount++;
              onProgress({ workerId, step: `填入 2FA 动态码（第 ${otpFillCount} 次）` });
              await otpLoc.click().catch(() => {});
              await page.keyboard.press("Control+A").catch(() => {});
              await page.keyboard.press("Backspace").catch(() => {});
              await humanPause(300, 700);
              await humanType(page, totp(row.totpSecret));
              await page.keyboard.press("Enter").catch(() => {});
              await sleep(1500);
              if (await otpLoc.isVisible().catch(() => false)) {
                await clickExactButton(page, /^(continue|next|继续|下一步|verify|验证)$/i);
              }
              await sleep(2000);
            }
            await sleep(1500);
            continue;
          }

          const retryBtn = page.locator("button:has-text('重试'), button:has-text('Retry')").first();
          if (await retryBtn.isVisible().catch(() => false)) {
            if (Date.now() - lastRetryClickAt > 10000) {
              lastRetryClickAt = Date.now();
              onProgress({ workerId, step: "OpenAI 登录接口超时，点击重试" });
              await retryBtn.click().catch(() => {});
            }
            await sleep(4000);
            continue;
          }

          // 密码框在请求进行中也会一直可见，只有距上次提交 >40s 才视为需要重填
          const pwdAgain = page.locator("input[type='password']").first();
          if (await pwdAgain.isVisible().catch(() => false) && Date.now() - lastPwdSubmitAt > 40000 && pwdAttempts <= 2) {
            pwdAttempts++;
            onProgress({ workerId, step: `登录超时回到密码页，重新提交密码（第 ${pwdAttempts} 次）` });
            await pwdAgain.click().catch(() => {});
            await page.keyboard.press("Control+A").catch(() => {});
            await page.keyboard.press("Backspace").catch(() => {});
            await humanPause(300, 800);
            await humanType(page, row.password);
            await page.keyboard.press("Enter").catch(() => {});
            lastPwdSubmitAt = Date.now();
            await sleep(3000);
            continue;
          }

          if (Date.now() - lastKeepaliveAt > 60000) {
            lastKeepaliveAt = Date.now();
            onProgress({ workerId, step: `等待登录结果（剩余 ${Math.round((loginDeadline - Date.now()) / 1000)}s）：${page.url().slice(0, 80)}` });
          }
          await sleep(2500);
        }
        if (!composer) {
          const snap = await loginSnapshot(page, "login-final");
          const challenge = await page.locator("iframe[src*='challenges.cloudflare.com'], iframe[title*='Cloudflare']").count().catch(() => 0);
          const timedOut = /timed out|出错了|went wrong/i.test(snap.text);
          const expired = /会话已失效|invalid_state|session.*expired/i.test(snap.text);
          onProgress({ workerId, step: `登录未完成：${snap.title || snap.url}${challenge ? "（人机验证）" : ""}（截图 ${snap.file}）` });
          throw new Error(
            timedOut
              ? `OpenAI 登录接口超时（Operation timed out），通常是代理节点太慢或被风控。请在代理客户端切换到更快的节点后重试。截图：${snap.file}`
              : expired
                ? `登录会话已失效（invalid_state），通常是代理太慢导致登录回调过期。请重试；若仍失败请更换代理节点。截图：${snap.file}`
                : `登录未完成：${snap.title || snap.url}${challenge ? "，需要人工完成人机验证" : ""}。截图：${snap.file}。页面文字：${snap.text}`,
          );
        }
      }

      const w = state.workers.find((x) => x.workerId === workerId);
      w.loggedIn = true;
      writeWorkers(state);
      entry.ok = true;
      onProgress({ workerId, step: "登录态已保存" });
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
    } finally {
      if (context) {
        // 安全关闭：给浏览器几秒把 Cookie/SQLite 刷盘，避免登录态丢失
        await context.close({ reason: "login done" }).catch(() => {});
      }
    }
    results.push(entry);
  }

  return {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    results,
  };
}

/* ---------------- 风控伪装自检 ---------------- */

export async function stealthCheck({ workerId } = {}) {
  const vbExe = locateVbExe();
  if (!vbExe) throw new Error("未找到 VirtualBrowser.exe：请先完成安装");
  if (!hasPlaywright()) throw new Error("插件缺少内置 playwright-core，请重装插件");
  const state = readWorkers();
  const target = workerId ? Number(workerId) : (state.workers.find((w) => w.loggedIn)?.workerId ?? 1);
  const workersDir = vbWorkersDir();
  ensureDataDir();
  if (!existsSync(IMAGES_DIR())) mkdirSync(IMAGES_DIR(), { recursive: true });
  const context = await launchWorker(vbExe, target, workersDir);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://bot.sannysoft.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(2000);
    const indicators = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      pluginsCount: navigator.plugins.length,
      chromeRuntime: Boolean(window.chrome?.runtime),
      hardwareConcurrency: navigator.hardwareConcurrency,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    }));
    const screenshotPath = path.join(IMAGES_DIR(), `stealth-worker${target}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const passed = indicators.webdriver === false && indicators.languages?.length > 0;
    return { workerId: target, passed, indicators, screenshotPath, checkPage: "https://bot.sannysoft.com/" };
  } finally {
    await context.close({ reason: "stealth check done" }).catch(() => {});
  }
}

function ledgerAppend(record) {
  appendLedger({ source: "direct", ...record });
}

/* ---------------- 直驱生图 / 对话（共用页面操作） ---------------- */

async function pickWorker() {
  const state = readWorkers();
  const now = Date.now();
  // limitedUntil：上游提示「额度/次数上限」后打标，24h 内不再选它
  const candidates = state.workers.filter((w) => w.loggedIn && !(Number(w.limitedUntil) > now));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.usageCount || 0) - (b.usageCount || 0)); // 轮询均衡消耗
  return candidates[0];
}

function workerById(workerId) {
  const state = readWorkers();
  return state.workers.find((w) => w.workerId === Number(workerId)) || null;
}

function markWorker(workerId, patch) {
  const state = readWorkers();
  const worker = state.workers.find((w) => w.workerId === Number(workerId));
  if (!worker) return;
  Object.assign(worker, patch);
  writeWorkers(state);
}

function bumpUsage(workerId) {
  const state = readWorkers();
  const worker = state.workers.find((w) => w.workerId === Number(workerId));
  if (!worker) return;
  worker.usageCount = (worker.usageCount || 0) + 1;
  worker.lastUsedAt = Date.now();
  writeWorkers(state);
}

function markLimited(workerId) {
  markWorker(workerId, { limitedUntil: Date.now() + 24 * 3600 * 1000 });
}

// 页面文字里出现这些提示时立即失败，避免无意义地轮询到超时
const LIMIT_PATTERN = /(?:达到|超出|用完|用尽|已达).{0,12}(?:上限|额度|次数)|image generation limit|limit reached|usage limit|no (?:more )?images|you've reached your limit/i;
const FAIL_PATTERN = /(?:图片生成失败|生成失败|无法生成|出了点问题|something went wrong|an error occurred while generating)/i;

const GUARD = (p) => `立即生成图片：${p}。请直接调用画图工具立即生成图片，不要输出任何询问文字或反问。`;

const COMPOSER_SELECTORS = ["#prompt-textarea", "textarea[data-id='root']", "div[contenteditable='true']"];
const SEND_SELECTORS = ["[data-testid='send-button']", "button[aria-label*='Send']", "button[aria-label*='发送']"];
const NEW_CHAT_SELECTORS = [
  "a[data-testid='create-new-chat-button']",
  "button[data-testid='create-new-chat-button']",
  "[data-testid='new-chat-button']",
  "[aria-label*='New chat']",
  "[aria-label*='新聊天']",
  "[title*='New chat']",
  "a[href='/']", // 侧边栏「新聊天」当前是纯链接，没有 aria-label/testid
  "a[href='https://chatgpt.com/']",
];
const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";

/** 冷启动一个指纹窗口并打开 ChatGPT（会校验登录态） */
async function openWorkerPage(vbExe, workerId, { stages, onProgress } = {}) {
  const t0 = Date.now();
  const context = await launchWorker(vbExe, workerId, vbWorkersDir());
  const page = context.pages()[0] || (await context.newPage());
  if (stages) stages.launchMs = Date.now() - t0;
  const t1 = Date.now();
  try {
    await gotoChatGpt(page);
    await sleep(900); // 等首屏引导弹窗渲染
    if (await dismissOnboarding(page)) onProgress?.({ workerId, step: "已关闭 ChatGPT 引导弹窗" });
    if (stages) stages.navigateMs = Date.now() - t1;
    if (!(await isLoggedIn(page))) {
      markWorker(workerId, { loggedIn: false });
      throw new Error(`worker ${workerId} 登录态已失效，请重新执行 bind`);
    }
    return { context, page };
  } catch (e) {
    await context.close({ reason: "open failed" }).catch(() => {});
    throw e;
  }
}

/** 等页面真正处于「可输入」状态：输入框存在、没有正在生成的回复、URL 已离开旧会话 */
async function waitComposerReady(page, { timeout = 20000, requireNewChat = true } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await withTimeout(page.evaluate(() => {
      const composer = document.querySelector("#prompt-textarea, textarea[data-id='root'], div[contenteditable='true']");
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
      };
      const stop = [...document.querySelectorAll("[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']")].some(visible);
      return { composer: visible(composer), stop, path: location.pathname };
    }), 8000, { composer: false, stop: false, path: page.url() });
    // local-chatgpt: 是本地点出的新会话占位，不算旧会话
    const onOldConversation = requireNewChat && /^\/c\/(?!local-chatgpt)/.test(String(state.path || ""));
    if (state.composer && !state.stop && !onOldConversation) return true;
    await sleep(300);
  }
  return false;
}

/** 开一个新会话：冷启动页面本身就在新会话，直接复用；复用时点「新聊天」，失败才重新导航 */
async function startNewChat(page, { fresh = false, timings = {} } = {}) {
  const t0 = Date.now();
  let clicked = false;
  if (fresh) {
    // 刚 gotoChatGpt 的页面已在新会话，跳过一次 10s+ 的按钮探测
    if (await waitComposerReady(page, { timeout: 6000, requireNewChat: false })) {
      const composer = await findFirst(page, COMPOSER_SELECTORS, { timeout: 2000 });
      if (composer) {
        timings.readyMs = Date.now() - t0;
        return composer;
      }
    }
  } else {
    const btn = await findFirst(page, NEW_CHAT_SELECTORS, { timeout: 1800 });
    timings.btnMs = Date.now() - t0;
    if (btn) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      clicked = true;
      await sleep(350);
    }
  }
  const tReady = Date.now();
  let ready = await waitComposerReady(page, { timeout: 5000 });
  timings.readyMs = Date.now() - tReady;
  timings.clicked = clicked;
  if (!ready) {
    // 侧边栏按钮没生效（或仍在旧会话）：重新导航到首页，最稳但多花几秒
    const tNav = Date.now();
    await gotoChatGpt(page);
    await sleep(700);
    await dismissOnboarding(page);
    ready = await waitComposerReady(page, { timeout: 15000, requireNewChat: false });
    timings.navMs = Date.now() - tNav;
  }
  if (!ready) throw new Error("输入框未就绪（页面改版或仍在加载）");
  return findFirst(page, COMPOSER_SELECTORS, { timeout: 2500 });
}

async function composerText(composer) {
  return withTimeout(composer.evaluate((el) => String(el.value || el.innerText || "")), 5000, "");
}

/**
 * 清空输入框。ChatGPT 的「新聊天」会保留草稿（上一次 probe / 失败的输入会残留），
 * 不清理就会把旧文本拼到新提示词前面，模型答非所问。
 */
async function clearComposer(page, composer) {
  if (!(await composerText(composer)).trim()) return true;
  await composer.click({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await sleep(150);
    if (!(await composerText(composer)).trim()) return true;
  }
  await withTimeout(composer.evaluate((el) => {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
  }), 5000, null).catch(() => {});
  await sleep(200);
  return !(await composerText(composer)).trim();
}

/** 写入提示词并逐字校验：中文在页面未就绪时可能乱码，校验失败则清空后分段重打 */
async function typePrompt(page, composer, text) {
  const want = text.trim();
  if (!(await clearComposer(page, composer))) return false;
  await composer.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.insertText(text);
  await sleep(250);
  if ((await composerText(composer)).trim() === want) return true;
  await clearComposer(page, composer);
  await composer.click({ timeout: 5000 }).catch(() => {});
  const chunks = text.match(/[\s\S]{1,24}/g) || [];
  for (const chunk of chunks) {
    await page.keyboard.type(chunk, { delay: 12 });
    await sleep(60);
  }
  await sleep(250);
  return (await composerText(composer)).trim() === want;
}

/** 注入并提交提示词：写入必须逐字等于目标文本，否则重新导航后再试一次 */
async function submitPrompt(page, text, { composer: knownComposer = null, timings = {} } = {}) {
  const want = text.trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    const tSelect = Date.now();
    const composer = knownComposer || await findFirst(page, COMPOSER_SELECTORS, { timeout: attempt ? 12000 : 3000 });
    timings.selectMs = (timings.selectMs || 0) + (Date.now() - tSelect);
    if (!composer) throw new Error("未找到输入框（页面改版？）");
    const tDismiss = Date.now();
    await dismissOnboarding(page);
    await composer.scrollIntoViewIfNeeded().catch(() => {});
    timings.dismissMs = (timings.dismissMs || 0) + (Date.now() - tDismiss);
    const tClick = Date.now();
    try {
      await composer.click({ timeout: 4000 });
    } catch {
      await dismissOnboarding(page);
      await composer.click({ timeout: 3000 }).catch(async () => {
        await composer.evaluate((el) => el.focus()).catch(() => {});
      });
    }
    timings.clickMs = (timings.clickMs || 0) + (Date.now() - tClick);
    const tType = Date.now();
    const typed = await typePrompt(page, composer, text).catch(() => false);
    timings.typeMs = (timings.typeMs || 0) + (Date.now() - tType);
    if (!typed) {
      if (attempt === 0) {
        await gotoChatGpt(page);
        await sleep(800);
        await dismissOnboarding(page);
        await waitComposerReady(page, { timeout: 15000, requireNewChat: false });
        continue;
      }
      throw new Error("提示词写入校验失败（页面未就绪导致文字乱码），已阻断提交避免脏内容");
    }
    // 回车提交最快；被拦下（输入框仍有文本）再点发送按钮
    const tSend = Date.now();
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(450);
    let left = (await composerText(composer)).trim();
    if (left) {
      const sendBtn = await findFirst(page, SEND_SELECTORS, { timeout: 1200 });
      if (sendBtn) await sendBtn.click({ timeout: 3000 }).catch(() => {});
      await sleep(500);
      left = (await composerText(composer)).trim();
    }
    timings.sendMs = (timings.sendMs || 0) + (Date.now() - tSend);
    if (!left) return;
    await dismissOnboarding(page);
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(600);
    if (!(await composerText(composer)).trim()) return;
    if (attempt === 0) {
      await gotoChatGpt(page);
      await sleep(800);
      await dismissOnboarding(page);
      await waitComposerReady(page, { timeout: 15000, requireNewChat: false });
      continue;
    }
    throw new Error("提示词没有提交成功：输入框被引导弹窗遮挡或发送按钮不可用（页面截图见下）");
  }
}

async function countGeneratedImages(page) {
  return withTimeout(page.evaluate(() => [...document.querySelectorAll("img")]
    .filter((im) => /oaiusercontent|blob:|data:image/.test(im.src || "") && (im.naturalWidth || 0) >= 256).length), 8000, 0);
}

/** 轮询新出现的图片（复用会话时必须按「新增张数」判定，否则会拿到上一轮旧图） */
async function waitForImage(page, { baseline, timeoutMs, onProgress, workerId, startedAt }) {
  const deadline = Date.now() + timeoutMs;
  let lastTick = Date.now();
  let src = "";
  while (Date.now() < deadline && !src) {
    await sleep(1200);
    const snap = await withTimeout(page.evaluate(() => {
      const hits = [...document.querySelectorAll("img")].filter((im) => /oaiusercontent|blob:|data:image/.test(im.src || "") && (im.naturalWidth || 0) >= 256);
      return { count: hits.length, src: hits.length ? hits[hits.length - 1].src : "", tail: (document.body?.innerText || "").replace(/\s+/g, " ").slice(-400) };
    }), 10000, { count: 0, src: "", tail: "" });
    if (snap.count > baseline && snap.src) { src = snap.src; break; }
    if (LIMIT_PATTERN.test(snap.tail)) {
      markLimited(workerId);
      throw new Error(`worker ${workerId} 额度已用完（24 小时内不再选它）：${snap.tail.slice(-120)}`);
    }
    if (FAIL_PATTERN.test(snap.tail)) throw new Error(`生成失败：${snap.tail.slice(-160)}`);
    if (Date.now() - lastTick > 15000) {
      lastTick = Date.now();
      onProgress?.({ workerId, step: `生成中（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）` });
    }
  }
  if (!src) throw new Error(`生成超时（${Math.round(timeoutMs / 1000)}s）未取到图片：可能触发上游风控、额度耗尽或代理过慢`);
  return src;
}

/** 会话内取原图（外链直接下载会 403），返回 base64 */
async function extractImageBase64(page, src) {
  return withTimeout(page.evaluate(async (imageSrc) => {
    const res = await fetch(imageSrc, { credentials: "include" });
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
  }, src), 30000, "");
}

async function readModelLabel(page) {
  try {
    const label = await withTimeout(page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
      };
      const btn = [...document.querySelectorAll("button, [role='button']")].find((el) => {
        if (!visible(el)) return false;
        const testid = el.getAttribute("data-testid") || "";
        if (/model/i.test(testid)) return true;
        const text = (el.innerText || "").trim();
        return /^(GPT|o\d|自动|Auto)/i.test(text) && el.getAttribute("aria-haspopup");
      });
      return btn ? (btn.innerText || "").replace(/\s+/g, " ").trim() : "";
    }), 5000, "");
    return label;
  } catch { return ""; }
}

const NO_MODEL_SWITCHER = new Set(); // 免费号没有模型选择器，判定一次后该 worker 不再重复探测

/** 在网页模型选择器里切到目标模型；找不到就保持默认，返回实际标签 */
async function selectChatModel(page, requested, workerId) {
  const target = resolveChatModel(requested);
  if (!target || target.id === "auto" || !target.labelRe) return await readModelLabel(page);
  if (workerId != null && NO_MODEL_SWITCHER.has(Number(workerId))) return "";
  // 只用模型选择器专属锚点：通配 aria-haspopup='menu' 会点到头像/分享菜单
  // 免费号通常没有模型选择器，共用 1.2s 预算快速判定，避免 4 个选择器串行等 14s
  const btn = await findFirst(page, [
    "[data-testid='model-switcher-dropdown-button']",
    "[data-testid*='model-switcher']",
    "button[aria-label*='模型']",
    "button[aria-label*='Model']",
  ], { timeout: 1200 });
  if (!btn) {
    if (workerId != null) NO_MODEL_SWITCHER.add(Number(workerId));
    return await readModelLabel(page);
  }
  await btn.click({ timeout: 5000 }).catch(() => {});
  await sleep(550);
  const clicked = await withTimeout(page.evaluate((pattern) => {
    const re = new RegExp(pattern, "i");
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
    };
    const items = [...document.querySelectorAll("[role='menuitem'], [role='menuitemradio'], [role='option'], [data-testid*='model'] button, button")]
      .filter((el) => visible(el) && re.test((el.innerText || "").replace(/\s+/g, " ").trim()));
    if (!items.length) return false;
    items[items.length - 1].click();
    return true;
  }, target.labelRe), 8000, false);
  if (!clicked) await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  return (await readModelLabel(page)) || target.label;
}

/* 这个 ChatGPT 构建没有 data-message-author-role / article / .markdown，
 * 消息只能从 main 文本里按「你说：」「ChatGPT 说：」这类标记切分。 */
const ASSISTANT_MARK_SRC = "(?:ChatGPT|GPT(?:-[\\w.]+)?|GPT-?\\d[\\w.]*)\\s*(?:说|said)\\s*[：:]";
const CHAT_TAIL_CUT = /ChatGPT 可能会出错|ChatGPT can make mistakes|最新一条回复|回答已完成|Answer now|Thought for \d/i;

function parseAssistantReply(pageText) {
  const text = String(pageText || "");
  const re = new RegExp(ASSISTANT_MARK_SRC, "gi");
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return "";
  let body = text.slice(last.index + last[0].length);
  const cut = body.search(CHAT_TAIL_CUT);
  if (cut >= 0) body = body.slice(0, cut);
  // 去掉消息下方的按钮/反馈条文字（innerText 会把按钮也带进来）
  body = body.replace(/(?:\s*(?:你说：|提供反馈|Create image|Copy|Edit|Read aloud|Regenerate|Good response|Bad response|到目前为止，这段对话对你有帮助吗？|Was this helpful\?|Rate this response)\s*)+$/gi, "");
  return body.replace(/\s+/g, " ").trim();
}

function countAssistantMarks(pageText) {
  const re = new RegExp(ASSISTANT_MARK_SRC, "gi");
  return [...String(pageText || "").matchAll(re)].length;
}

/** 轮询助手回复：增量回调 + 文本稳定判定 + 额度识别。baseline 为提交前的「ChatGPT 说：」标记数，避免复用会话时拿到上一轮回复 */
async function waitForChat(page, { baseline = 0, timeoutMs, onDelta, onProgress, workerId, startedAt }) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  let stable = 0;
  let lastTail = "";
  let lastTick = Date.now();
  while (Date.now() < deadline) {
    await sleep(700);
    const snap = await withTimeout(page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
      };
      const main = document.querySelector("main");
      return {
        text: main ? String(main.innerText || "") : "",
        streaming: [...document.querySelectorAll("[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']")].some(visible),
        tail: (document.body?.innerText || "").replace(/\s+/g, " ").slice(-400),
      };
    }), 8000, { text: "", streaming: false, tail: "" });

    lastTail = snap.tail;
    if (LIMIT_PATTERN.test(snap.tail)) {
      markLimited(workerId);
      throw new Error(`worker ${workerId} 额度已用完（24 小时内不再选它）：${snap.tail.slice(-120)}`);
    }
    const reply = countAssistantMarks(snap.text) > baseline ? parseAssistantReply(snap.text) : "";
    if (reply) {
      if (reply !== text) {
        const delta = text && reply.startsWith(text) ? reply.slice(text.length) : reply;
        text = reply;
        stable = 0;
        onDelta?.(delta, text);
      } else {
        stable++;
        const finished = /回答已完成|Answer now/i.test(snap.text);
        if ((!snap.streaming && stable >= 3) || (finished && stable >= 1 && !snap.streaming)) {
          return { text, elapsedMs: Date.now() - startedAt };
        }
      }
    }
    if (Date.now() - lastTick > 15000) {
      lastTick = Date.now();
      onProgress?.({ workerId, step: `等待回复（已 ${Math.round((Date.now() - startedAt) / 1000)}s）` });
    }
  }
  if (text) return { text, elapsedMs: Date.now() - startedAt, truncated: true };
  throw new Error(`对话超时（${Math.round(timeoutMs / 1000)}s）没有取到回复：可能触发上游风控或代理过慢${lastTail ? `；页面最后文字：${lastTail.slice(-120)}` : ""}`);
}

function onProgressStep(startedAt, workerId) {
  // 仅在 directGenerate/directChat 的 onProgress 通道可用时输出；守护进程忽略
  try { process.stderr.write(`worker ${workerId} 等待回复 ${Math.round((Date.now() - startedAt) / 1000)}s\n`); } catch { /* 忽略 */ }
}

function toChatPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return "";
  const system = list.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
  const rest = list.filter((m) => m.role !== "system");
  const history = rest.slice(0, -1).map((m) => `${m.role === "assistant" ? "助手" : "用户"}：${m.content}`).join("\n");
  const last = rest[rest.length - 1];
  const body = [history, last ? String(last.content || "") : ""].filter(Boolean).join("\n\n");
  return [system ? `（系统指令）${system}` : "", body].filter(Boolean).join("\n\n");
}

/* ---------------- 常驻会话池（加速核心） ----------------
 * 同一个 worker 的指纹窗口只冷启动一次，之后复用：省掉每次 10~30s 的浏览器启动 + 页面加载，
 * 只做「点新聊天 → 提交 → 等结果」。窗口空闲超过 maxIdleMs 自动关闭，避免长期占内存。
 */

export function createPool({ maxIdleMs = 15 * 60_000, onEvent = () => {}, source = "direct" } = {}) {
  const entries = new Map();
  const launching = new Map();
  let closed = false;

  function resetIdle(entry) {
    clearTimeout(entry.idleTimer);
    if (!(maxIdleMs > 0) || closed) return;
    entry.idleTimer = setTimeout(() => { void closeEntry(entry); }, maxIdleMs);
    entry.idleTimer.unref?.();
  }

  async function closeEntry(entry) {
    if (!entry || entry.closing) return;
    entry.closing = true;
    clearTimeout(entry.idleTimer);
    if (entries.get(entry.workerId) === entry) entries.delete(entry.workerId);
    try { await entry.context?.close({ reason: "idle" }); } catch { /* 已关闭 */ }
    onEvent({ type: "close", workerId: entry.workerId });
  }

  async function ensure(worker) {
    const existing = entries.get(worker.workerId);
    if (existing && existing.page && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now();
      resetIdle(existing);
      return existing;
    }
    if (existing) await closeEntry(existing);
    if (launching.has(worker.workerId)) return launching.get(worker.workerId);
    const promise = (async () => {
      const vbExe = locateVbExe();
      if (!vbExe) throw new Error("未找到 VirtualBrowser.exe：请先完成安装");
      if (!hasPlaywright()) throw new Error("插件缺少内置 playwright-core，请重装插件");
      const { context, page } = await openWorkerPage(vbExe, worker.workerId, { onProgress: (p) => onEvent({ type: "progress", ...p }) });
      if (closed) { await context.close().catch(() => {}); throw new Error("会话池已关闭"); }
      const entry = { workerId: worker.workerId, context, page, createdAt: Date.now(), lastUsedAt: Date.now(), uses: 0, chain: Promise.resolve(), busy: false, closing: false };
      entries.set(worker.workerId, entry);
      resetIdle(entry);
      onEvent({ type: "open", workerId: worker.workerId, ms: Date.now() - entry.createdAt });
      return entry;
    })().finally(() => launching.delete(worker.workerId));
    launching.set(worker.workerId, promise);
    return promise;
  }

  function runOn(worker, fn) {
    return ensure(worker).then((entry) => {
      const run = entry.chain.then(async () => {
        entry.busy = true;
        try {
          return await fn(entry);
        } finally {
          entry.busy = false;
          entry.lastUsedAt = Date.now();
          entry.uses++;
          resetIdle(entry);
        }
      });
      entry.chain = run.catch(() => {});
      return run;
    });
  }

  // 看门狗：页面/导航异常时 runOn 可能长期不返回，超时后强制关闭该 worker 窗口并让链路可恢复
  async function runGuarded(worker, fn, timeoutMs) {
    const budget = Math.max(60000, Number(timeoutMs) + 90000);
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`任务超时（${Math.round(budget / 1000)}s 页面无响应），已重置该账号窗口`)), budget);
      timer.unref?.();
    });
    try {
      return await Promise.race([runOn(worker, fn), guard]);
    } catch (e) {
      if (/页面无响应/.test(String(e?.message || ""))) await closeEntry(entries.get(worker.workerId));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate({ workerId, prompt, timeoutMs = 180000, queueMs = 0, onProgress } = {}) {
    const worker = workerId != null ? workerById(workerId) : await pickWorker();
    if (!worker) throw new Error("号池中没有可用账号：请先导入账号并完成自动登录（或所有账号今日额度已用完）");
    if (!worker.loggedIn) throw new Error(`worker ${worker.workerId} 未登录，请重新执行 bind`);
    const startedAt = Date.now();
    let stages = {};
    try {
      const result = await runGuarded(worker, async (entry) => {
        const { page } = entry;
        const warm = entry.uses > 0;
        stages = {};
        const tOpen = Date.now();
        onProgress?.({ workerId: worker.workerId, step: warm ? "复用已登录窗口" : "冷启动指纹窗口" });
        stages.openParts = {};
        const composer = await startNewChat(page, { fresh: !warm, timings: stages.openParts });
        stages.openMs = Date.now() - tOpen;
        // 新会话里没有旧图；若页面残留旧会话，baseline 仍能保证只取新图
        const baseline = await countGeneratedImages(page);
        const tSubmit = Date.now();
        stages.submitParts = {};
        await submitPrompt(page, GUARD(prompt), { composer, timings: stages.submitParts });
        stages.submitMs = Date.now() - tSubmit;
        onProgress?.({ workerId: worker.workerId, step: "生成中，轮询结果" });
        const tResult = Date.now();
        const src = await waitForImage(page, { baseline, timeoutMs, onProgress, workerId: worker.workerId, startedAt });
        stages.resultMs = Date.now() - tResult;
        onProgress?.({ workerId: worker.workerId, step: "会话内提取原图" });
        const tExtract = Date.now();
        const base64 = await extractImageBase64(page, src);
        stages.extractMs = Date.now() - tExtract;
        return { src, base64, warm };
      }, timeoutMs);
      const elapsedMs = Date.now() - startedAt;
      if (!result.base64) {
        bumpUsage(worker.workerId);
        ledgerAppend({ kind: "image", source, workerId: worker.workerId, account: maskLedgerEmail(worker.email), model: "chatgpt-direct", requestedModel: "", state: "completed", elapsedMs, queueMs, stages, promptChars: prompt.length, prompt: prompt.slice(0, 200), imageUrl: result.src });
        return { workerId: worker.workerId, imageUrl: result.src, imagePath: "", elapsedMs, queueMs, stages, session: result.warm ? "warm" : "cold", note: "会话内提取失败，返回原始 src（可能带鉴权时效）" };
      }
      ensureLedgerDir();
      const dir = imagesDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const imagePath = path.join(dir, `img-${Date.now()}.png`);
      writeFileSync(imagePath, Buffer.from(result.base64, "base64"));
      writeImageMeta(imagePath, { prompt: prompt.slice(0, 500), model: "chatgpt-direct", workerId: worker.workerId, elapsedMs });
      bumpUsage(worker.workerId);
      ledgerAppend({ kind: "image", source, workerId: worker.workerId, account: maskLedgerEmail(worker.email), model: "chatgpt-direct", requestedModel: "", state: "completed", elapsedMs, queueMs, stages, promptChars: prompt.length, prompt: prompt.slice(0, 200), imagePath });
      return { workerId: worker.workerId, imageUrl: "", imagePath, elapsedMs, queueMs, stages, session: result.warm ? "warm" : "cold" };
    } catch (e) {
      let message = String(e?.message || e);
      const entry = entries.get(worker.workerId);
      if (entry?.page && !entry.page.isClosed()) {
        const snap = await loginSnapshot(entry.page, "generate-fail");
        message = `${message}（页面截图：${snap.file}；页面文字：${(snap.text || "").slice(0, 120)}）`;
      }
      if (/登录态已失效/.test(message)) await closeEntry(entry);
      ledgerAppend({ kind: "image", source, workerId: worker.workerId, account: maskLedgerEmail(worker.email), model: "chatgpt-direct", state: "failed", elapsedMs: Date.now() - startedAt, queueMs, stages, promptChars: prompt.length, prompt: prompt.slice(0, 200), error: message.slice(0, 500) });
      throw e;
    }
  }

  async function chat({ workerId, messages, prompt, model, timeoutMs = 180000, queueMs = 0, onDelta, onProgress } = {}) {
    const worker = workerId != null ? workerById(workerId) : await pickWorker();
    if (!worker) throw new Error("号池中没有可用账号：请先导入账号并完成自动登录");
    if (!worker.loggedIn) throw new Error(`worker ${worker.workerId} 未登录，请重新执行 bind`);
    const text = String(prompt || toChatPrompt(messages) || "").trim();
    if (!text) throw new Error("缺少对话内容：请传 messages 或 prompt");
    const startedAt = Date.now();
    let stages = {};
    try {
      const result = await runGuarded(worker, async (entry) => {
        const { page } = entry;
        const warm = entry.uses > 0;
        stages = {};
        const tOpen = Date.now();
        stages.openParts = {};
        // 复用窗口时直接在当前会话追问，省掉一次开新会话（约 10s）；新回复用标记数基线区分
        let composer = null;
        if (warm && await waitComposerReady(page, { timeout: 4000, requireNewChat: false })) {
          composer = await findFirst(page, COMPOSER_SELECTORS, { timeout: 2000 });
          stages.openParts.reuseMs = Date.now() - tOpen;
        }
        if (!composer) composer = await startNewChat(page, { fresh: !warm, timings: stages.openParts });
        stages.openMs = Date.now() - tOpen;
        const tModel = Date.now();
        const modelLabel = await selectChatModel(page, model, worker.workerId);
        stages.modelMs = Date.now() - tModel;
        const mainBefore = await withTimeout(page.evaluate(() => String(document.querySelector("main")?.innerText || "")), 5000, "");
        const baseline = countAssistantMarks(mainBefore);
        const tSubmit = Date.now();
        stages.submitParts = {};
        await submitPrompt(page, text, { composer, timings: stages.submitParts });
        stages.submitMs = Date.now() - tSubmit;
        const tResult = Date.now();
        const reply = await waitForChat(page, { baseline, timeoutMs, onDelta, onProgress, workerId: worker.workerId, startedAt });
        stages.resultMs = Date.now() - tResult;
        return { ...reply, modelLabel, warm };
      }, timeoutMs);
      const elapsedMs = Date.now() - startedAt;
      bumpUsage(worker.workerId);
      ledgerAppend({
        kind: "chat", source, workerId: worker.workerId, account: maskLedgerEmail(worker.email),
        model: result.modelLabel || model || "auto", requestedModel: model || "",
        state: "completed", elapsedMs, queueMs, stages, promptChars: text.length, chars: result.text.length,
        prompt: text.slice(0, 200),
      });
      return {
        workerId: worker.workerId, text: result.text, model: result.modelLabel || model || "auto",
        requestedModel: model || "", elapsedMs, queueMs, stages, session: result.warm ? "warm" : "cold",
        truncated: Boolean(result.truncated),
      };
    } catch (e) {
      let message = String(e?.message || e);
      const entry = entries.get(worker.workerId);
      if (entry?.page && !entry.page.isClosed()) {
        const snap = await loginSnapshot(entry.page, "chat-fail");
        message = `${message}（页面截图：${snap.file}；页面文字：${(snap.text || "").slice(0, 120)}）`;
      }
      if (/登录态已失效/.test(message)) await closeEntry(entry);
      ledgerAppend({
        kind: "chat", source, workerId: worker.workerId, account: maskLedgerEmail(worker.email),
        model: model || "auto", requestedModel: model || "", state: "failed",
        elapsedMs: Date.now() - startedAt, queueMs, stages, promptChars: text.length, prompt: text.slice(0, 200), error: message.slice(0, 500),
      });
      throw e;
    }
  }

  /** 诊断：新会话 + 写入测试文字，可选提交，返回输入框内容/用户气泡真实内容/模型标签/截图 */
  async function probe(workerId, { method = "insertText", submit = false, text: sampleText, waitMs = 0 } = {}) {
    const worker = workerId != null ? workerById(workerId) : await pickWorker();
    if (!worker) throw new Error("号池中没有可用账号");
    return runGuarded(worker, async (entry) => {
      const { page } = entry;
      const composer = await startNewChat(page);
      const label = await readModelLabel(page);
      const sample = String(sampleText || env("RUODAO_PROBE_TEXT", "你好世界 probe"));
      await clearComposer(page, composer);
      let typed = false;
      if (method === "type") {
        await composer.click({ timeout: 5000 }).catch(() => {});
        await page.keyboard.type(sample, { delay: 30 }).catch(() => {});
        await sleep(300);
        typed = (await composerText(composer)).trim() === sample.trim();
      } else if (method === "fill") {
        await composer.fill(sample).catch(() => {});
        await sleep(300);
        typed = (await composerText(composer)).trim() === sample.trim();
      } else if (method === "exec") {
        await composer.click({ timeout: 5000 }).catch(() => {});
        await withTimeout(composer.evaluate((el, value) => {
          el.focus();
          document.execCommand("insertText", false, value);
        }, sample), 8000, null).catch(() => {});
        await sleep(300);
        typed = (await composerText(composer)).trim() === sample.trim();
      } else {
        typed = await typePrompt(page, composer, sample);
      }
      const text = await composerText(composer);
      let userBubble = "";
      let dom = null;
      if (submit) {
        await submitPrompt(page, sample, { composer });
        await sleep(1500);
        if (waitMs > 0) {
          const deadline = Date.now() + waitMs;
          let last = "";
          let stable = 0;
          while (Date.now() < deadline) {
            const main = await withTimeout(page.evaluate(() => String(document.querySelector("main")?.innerText || "")), 5000, "");
            const reply = parseAssistantReply(main);
            if (reply) {
              stable = reply === last ? stable + 1 : 0;
              last = reply;
              if (stable >= 2) break;
            }
            await sleep(800);
          }
        } else {
          await sleep(2000);
        }
        const snap = await withTimeout(page.evaluate(() => {
          const q = (s) => {
            const nodes = [...document.querySelectorAll(s)];
            const last = nodes[nodes.length - 1];
            return {
              count: nodes.length,
              last: last ? String(last.innerText || "").replace(/\s+/g, " ").slice(-140) : "",
              cls: last ? String(last.className || "").slice(0, 80) : "",
            };
          };
          const out = {};
          for (const s of [".markdown", "[class*='markdown']", "article", "[data-testid^='conversation-turn']",
            "[data-message-author-role]", "[class*='assistant']", "[class*='message']", "main"]) {
            out[s] = q(s);
          }
          const region = document.querySelector("[role='region'][aria-label='对话'], [role='region'][aria-label='Chat']");
          out["region:text"] = {
            count: region ? 1 : 0,
            last: region ? String(region.innerText || "").replace(/\s+/g, " ").slice(-200) : "",
          };
          const user = document.querySelector("[data-message-author-role='user']");
          return { probes: out, userText: user ? String(user.innerText || "").replace(/\s+/g, " ").slice(0, 120) : "" };
        }), 10000, null);
        dom = snap?.probes || null;
        userBubble = snap?.userText || "";
      }
      const mainText = await withTimeout(page.evaluate(() => String(document.querySelector("main")?.innerText || "")), 8000, "");
      const reply = parseAssistantReply(mainText);
      const shot = path.join(DATA_DIR, `debug-probe-${worker.workerId}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      return { workerId: worker.workerId, url: page.url(), method, typed, sample, text, reply, userBubble, dom, model: label, screenshotPath: shot };
    }, 120000);
  }

  /** 诊断：抓当前（或指定）页面的结构，定位对话消息节点 */
  async function inspect(workerId, { url } = {}) {
    const worker = workerId != null ? workerById(workerId) : await pickWorker();
    if (!worker) throw new Error("号池中没有可用账号");
    return runGuarded(worker, async (entry) => {
      const { page } = entry;
      if (url) {
        await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await sleep(6000);
      }
      const info = await withTimeout(page.evaluate(() => {
        // 消息区在 role=region aria-label=对话 的滚动容器里，不在 main 下
        const main = document.querySelector("[role='region'][aria-label='对话'], [role='region'][aria-label='Chat'], .thread-scroll-container")
          || document.querySelector("main") || document.body;
        const describe = (el) => ({
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute("data-testid") || "",
          role: el.getAttribute("role") || "",
          author: el.getAttribute("data-message-author-role") || "",
          aria: el.getAttribute("aria-label") || "",
          cls: String(el.className || "").slice(0, 90),
          text: String(el.innerText || "").replace(/\s+/g, " ").slice(0, 70),
        });
        const candidates = [...main.querySelectorAll("[data-testid], [role], [aria-live], [data-message-author-role]")]
          .filter((el) => (el.innerText || "").trim())
          .slice(0, 150).map(describe);
        return {
          url: location.href,
          html: String(main.outerHTML || "").slice(0, 9000),
          candidates,
          bodyText: String(document.body.innerText || "").replace(/\s+/g, " ").slice(0, 900),
        };
      }), 15000, null);
      return { workerId: worker.workerId, ...info };
    }, 120000);
  }

  async function warmup(workerIds) {
    const state = readWorkers();
    const targets = (workerIds && workerIds.length ? workerIds : state.workers.filter((w) => w.loggedIn).map((w) => w.workerId))
      .map((id) => state.workers.find((w) => w.workerId === Number(id)))
      .filter(Boolean);
    const results = [];
    for (const worker of targets) {
      const startedAt = Date.now();
      try {
        await ensure(worker);
        results.push({ workerId: worker.workerId, ok: true, ms: Date.now() - startedAt });
      } catch (e) {
        results.push({ workerId: worker.workerId, ok: false, ms: Date.now() - startedAt, error: String(e?.message || e) });
      }
    }
    return results;
  }

  function stats() {
    return [...entries.values()].map((entry) => ({
      workerId: entry.workerId,
      warm: Boolean(entry.page && !entry.page.isClosed()),
      busy: entry.busy,
      queued: false,
      uses: entry.uses,
      lastUsedAt: entry.lastUsedAt,
      idleMs: Date.now() - entry.lastUsedAt,
      url: entry.page && !entry.page.isClosed() ? entry.page.url() : "",
    }));
  }

  async function closeAll() {
    closed = true;
    await Promise.allSettled([...launching.values()]);
    await Promise.all([...entries.values()].map((entry) => closeEntry(entry).catch(() => {})));
    entries.clear();
  }

  return { generate, chat, warmup, probe, inspect, stats, closeAll, closeWorker: (id) => closeEntry(entries.get(Number(id))) };
}

/* ---------------- 一次性入口（CLI 回退路径） ---------------- */

export async function directGenerate(input, { onProgress = () => {} } = {}) {
  const prompt = String(input.prompt || input.description || "").trim();
  if (!prompt) throw new Error("缺少生图提示词：请传 { prompt }");
  const worker = input.workerId != null ? workerById(input.workerId) : await pickWorker();
  if (!worker) throw new Error("号池中没有可用账号：请先导入账号并完成自动登录（或所有账号今日生图额度已用完）");
  const timeoutMs = Number(input.timeoutMs) || (Number(env("RUODAO_IMAGE_TIMEOUT", "600")) || 600) * 1000;
  const pool = createPool({ maxIdleMs: 0 });
  try {
    return await pool.generate({ workerId: worker.workerId, prompt, timeoutMs, onProgress });
  } finally {
    await pool.closeAll();
  }
}

export async function directChat(input, { onDelta, onProgress } = {}) {
  const worker = input.workerId != null ? workerById(input.workerId) : await pickWorker();
  if (!worker) throw new Error("号池中没有可用账号：请先导入账号并完成自动登录");
  const timeoutMs = Number(input.timeoutMs) || (Number(env("RUODAO_CHAT_TIMEOUT", "300")) || 300) * 1000;
  const pool = createPool({ maxIdleMs: 0 });
  try {
    return await pool.chat({
      workerId: worker.workerId,
      messages: input.messages,
      prompt: input.prompt,
      model: input.model,
      timeoutMs,
      onDelta,
      onProgress,
    });
  } finally {
    await pool.closeAll();
  }
}
