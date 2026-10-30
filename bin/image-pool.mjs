#!/usr/bin/env node
/**
 * Ruodao 生图插件（AI 号池生图：FPBrowser2API + VirtualBrowser）
 *
 * 架构参照 https://github.com/yang0/fpbrowser2api（号池调度网关，OpenAI 风格 API）
 *         与 https://github.com/yang0/VirtualBrowser（指纹浏览器，账号隔离保活）。
 *
 * 工作方式：
 *   VirtualBrowser API 版（自建 API，免 VIP / 免 api-key）为每个账号创建独立指纹环境并保活登录态；
 *   FPBrowser2API 作为调度网关把浏览器里的生图能力封装为 /v1/videos 异步任务接口；
 *   本插件负责：二合一安装 → 服务拉起 → 后台自动配置 → 账号导入 → 生图取图 → 消耗记账。
 *
 * 二合一安装包：Ruodao-ImagePool-AllInOne-Setup.exe（VirtualBrowser API + FPBrowser2API 便携版）
 *   查找顺序：vendor/allinone/ → data/downloads/ → 下载目录/桌面 → RUODAO_POOL_SETUP_URL
 *
 * 环境变量 / UI 配置（全部可选，安装流程自动生成密钥）：
 *   RUODAO_POOL_SETUP_URL  二合一安装包下载地址
 *   RUODAO_FB_API_BASE      FPBrowser2API 网关地址，默认 http://127.0.0.1:8002
 *   RUODAO_FB_API_KEY       网关 API Key（安装时自动生成并写入 setting.toml）
 *   RUODAO_FB_HOME          网关安装目录；默认二合一包安装目录
 *   RUODAO_FB_PORT          内嵌 FPBrowser2API 端口，默认 8002
 *   RUODAO_VB_API_BASE      VirtualBrowser API 地址，默认自动探测（含 http://127.0.0.1:9000）
 *   RUODAO_VB_EXE           VirtualBrowser 主程序 exe 路径；配置后不可达时自动拉起
 *   RUODAO_IMAGE_MODEL      默认生图模型，默认 gpt-image2-1k
 *   RUODAO_IMAGE_TIMEOUT    任务轮询超时秒数，默认 600
 *
 * 命令模式（process.argv[2]）：
 *   doctor            环境自检：两端服务连通性、自动拉起
 *   setup             一键安装：定位/安装二合一包 → 生成密钥写配置（自动备份）→ 启动网关与
 *                     VirtualBrowser API → 挂载通信扩展 → 服务检查 → 后台自动配置
 *   service           服务维护：stdin { action: "start"|"stop"|"restart"|"status", target?: "fpb"|"vb"|"both" }
 *   assistant         启动内置 FPBrowser 搭建助手控制台（图形化维护，:8765）
 *   models            模型列表（/v1/models，网关未启动时回退内置清单）
 *   agent-access      启动本地 OpenAI 兼容生图 API 并返回 base URL / Key / 模型
 *   generate          生图：stdin { prompt, model?, resolution?, aspect_ratio?, n?, images? }
 *   task              任务查询：stdin { taskId }
 *   usage             消耗统计：stdin { days? }，按模型/账号/日/种类汇总，含额度与阶段耗时
 *   logs              调用日志：stdin { days?, limit?, offset?, kind?, state?, workerId?, q? }
 *   images            图片库：stdin { action: "list"|"delete"|"reveal", file? }
 *   daemon            加速进程：stdin { action: "start"|"stop"|"restart"|"status", warm? }
 *   warmup            预热已登录窗口（复用后省掉 10~30 秒冷启动）
 *   accounts          号池账号：stdin { action: "import"|"list", text? }
 *                     import 接受发货原文（每行 邮箱----密码----2FA），解析落盘 accounts.txt
 *
 * 输出（stdout JSON）：Host 记入 pluginExecutionResults。
 *   { "state": "succeeded", ... } 或 { "state": "failed", "error": "..." }
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import * as ledger from "./ledger.mjs";
import * as poolModels from "./pool-models.mjs";

const env = (k, d = "") => (process.env[k] ?? d).trim();

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 运行时数据目录（重要：必须在插件目录之外）
 * 插件更新/卸载会 rmdir 插件目录；若把克隆的网关、venv、数据库放在插件目录内，
 * 运行中的 python 会锁住文件导致 EBUSY 安装失败。因此统一放到系统应用数据目录。
 */
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
const DOWNLOADS_DIR = () => path.join(DATA_DIR, "downloads");

/**
 * 关键：立即把进程工作目录切到数据目录。
 * 插件命令是以「插件目录」为 cwd 启动的，若不切换，我们拉起的子进程（VirtualBrowser、
 * 安装器、python）会继承插件目录作为 CWD 并持有目录句柄，导致插件更新/卸载时报
 * EBUSY: resource busy or locked, rmdir .../image-pool。
 */
try {
  mkdirSync(DATA_DIR, { recursive: true });
  process.chdir(DATA_DIR);
} catch { /* 极端情况下（目录不可写）保持原 cwd，后续步骤会报明确错误 */ }

const FB_REPO_URL = "https://github.com/yang0/fpbrowser2api.git";
const PLAYWRIGHT_CORE_VERSION = "1.64.1"; // 与 vendor/playwright-core 保持一致，修复模式按此版本补装
const ASSISTANT_PORT = () => Number(env("RUODAO_ASSISTANT_PORT", "8765")) || 8765;

// 网关端口解析：显式配置 > 实测端口（记忆） > setting.toml > 默认 8002；启动后自动探测真实端口并记住，
// 避免上游仓库提交的默认 toml（port=8000）导致插件探测 8002 全红
let fbPortActual = 0;
function fbPortCandidates() {
  const explicit = Number(env("RUODAO_FB_PORT", "0"));
  const list = [];
  if (explicit) list.push(explicit);
  const tomlPort = Number(fbToml().cfg.server?.port) || 0;
  if (tomlPort) list.push(tomlPort);
  if (fbPortActual) list.push(fbPortActual);
  list.push(8002, 8000);
  return [...new Set(list.filter(Boolean))];
}
const FB_PORT = () => {
  const explicit = Number(env("RUODAO_FB_PORT", "0"));
  if (explicit) return explicit;
  if (fbPortActual) return fbPortActual;
  return Number(fbToml().cfg.server?.port) || 8002;
};
const FB_BASE = () => env("RUODAO_FB_API_BASE", `http://127.0.0.1:${FB_PORT()}`).replace(/\/+$/, "");
const FB_KEY = () => env("RUODAO_FB_API_KEY", "") || String(fbToml().cfg.global?.api_key || "");
const FB_BUNDLE_HOME = () => path.join(process.env.ProgramData || "C:\\ProgramData", "RuodaoImagePool", "fpbrowser2api");
function isGatewayHome(dir) {
  return Boolean(dir) && (existsSync(path.join(dir, "fpbrowser2api.exe")) || existsSync(path.join(dir, "main.py")));
}
const FB_HOME = () => {
  const custom = env("RUODAO_FB_HOME", "");
  // 二合一安装包把便携版装在 ProgramData；老版本配置可能指向已删除的源码目录，失效时自动回退
  if (custom && isGatewayHome(custom)) return custom;
  if (isGatewayHome(FB_BUNDLE_HOME())) return FB_BUNDLE_HOME();
  return custom || path.join(DATA_DIR, "fpbrowser2api");
};
const VB_BASE = () => env("RUODAO_VB_API_BASE", "http://127.0.0.1:9000").replace(/\/+$/, "");
const VB_KEY = () => env("RUODAO_VB_API_KEY", "");
const LOCAL_VB_KEY = "ruodao-local-api"; // 自建 API 版不校验 api-key，用于填满网关的必填字段
const VB_EXE = () => env("RUODAO_VB_EXE", "");
const DEFAULT_MODEL = () => env("RUODAO_IMAGE_MODEL", "gpt-image2-1k");
const POLL_TIMEOUT_S = () => Number(env("RUODAO_IMAGE_TIMEOUT", "600")) || 600;

const ACCOUNTS_FILE = () => path.join(DATA_DIR, "accounts.txt");
const LEDGER_FILE = () => path.join(DATA_DIR, "usage.jsonl");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyData();
}

// 旧版本把运行数据放在插件目录 data/ 下（会导致更新时 EBUSY）：首次运行自动迁移到应用数据目录
let legacyMigrated = false;
function migrateLegacyData() {
  if (legacyMigrated) return;
  legacyMigrated = true;
  const legacy = path.join(PLUGIN_DIR, "data");
  if (path.resolve(legacy) === path.resolve(DATA_DIR) || !existsSync(legacy)) return;
  try {
    if (existsSync(DATA_DIR) && readdirSync(DATA_DIR).some((f) => f !== "downloads")) return; // 已有新数据不覆盖
    // 只迁移小型状态文件（账号/台账/worker/安装状态），不搬半成品的网关目录与安装包
    cpSync(legacy, DATA_DIR, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (["downloads", "fpbrowser2api", "images", "node_modules"].includes(base)) return false;
        try { return statSync(src).size < 20 * 1024 * 1024; } catch { return true; }
      },
    });
  } catch { /* 被占用/权限不足时忽略：账号可重新导入，网关可重新安装 */ }
}

/* ---------------- 通用辅助（安装 / 维护） ---------------- */

// 极简命令探测（避免引入依赖）
function require0(cmd) {
  execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
}

// Python 查找：优先 fpbrowser2api 的 .venv，其次 PATH
function findPython(preferProjectDir) {
  if (preferProjectDir) {
    const venvWin = path.join(preferProjectDir, ".venv", "Scripts", "python.exe");
    const venvUnix = path.join(preferProjectDir, ".venv", "bin", "python");
    if (existsSync(venvWin)) return venvWin;
    if (existsSync(venvUnix)) return venvUnix;
  }
  for (const cmd of ["python", "python3", "py"]) {
    try { require0(cmd); return cmd; } catch { /* 下一个 */ }
  }
  return null;
}

function findGit() {
  for (const cmd of ["git"]) {
    try { require0(cmd); return cmd; } catch { /* 继续 */ }
  }
  return null;
}

// 网关启动器：二合一安装包装的是免 Python 的 fpbrowser2api.exe；源码安装才用 venv Python
function gatewayRunner(installDir) {
  const exe = path.join(installDir, "fpbrowser2api.exe");
  if (existsSync(exe)) return { cmd: exe, args: [], kind: "exe" };
  const python = findPython(installDir);
  const mainPy = path.join(installDir, "main.py");
  if (python && existsSync(mainPy)) return { cmd: python, args: [mainPy], kind: "python" };
  return null;
}

// 同步执行命令并收集日志（截断保留尾部）
function runLogged(cmd, args, cwd, { timeoutMs = 480000, logFile } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  if (logFile) {
    try { appendFileSync(logFile, `$ ${cmd} ${args.join(" ")}\n${output}\n\n`, "utf8"); } catch { /* 忽略 */ }
  }
  if (res.error) throw new Error(`执行失败（${cmd}）：${res.error.message}${output ? `\n${output.slice(-1500)}` : ""}`);
  if (res.status !== 0) throw new Error(`命令退出代码 ${res.status}：${cmd} ${args.join(" ")}\n${output.slice(-1500)}`);
  return output;
}

// 流式执行：输出逐行实时追加到日志与状态文件（安装过程中的活性可见，子进程被杀也能留下已执行的痕迹）
function runStream(cmd, args, cwd, { logFile, state, timeoutMs = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: process.env });
    const appendLog = (line) => {
      try { appendFileSync(logFile, line + "\n", "utf8"); } catch { /* 忽略 */ }
      if (state) {
        state.lastLine = line.slice(0, 200);
        setupStateWrite(state);
      }
    };
    appendLog(`$ ${cmd} ${args.join(" ")}`);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时（${Math.round(timeoutMs / 60000)} 分钟）：${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    let stderrTail = "";
    const handle = (buf, isErr) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (isErr) stderrTail = (stderrTail + "\n" + t).slice(-2000);
        else appendLog(t);
      }
    };
    child.stdout.on("data", (b) => handle(b, false));
    child.stderr.on("data", (b) => handle(b, true));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`执行失败（${cmd}）：${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`命令退出代码 ${code}：${cmd} ${args.join(" ")}${stderrTail ? `\n${stderrTail}` : ""}`));
      else resolve();
    });
  });
}

// 简易 TOML 解析（仅支持 [section] key = value）
export function parseToml(text) {
  const result = {};
  let section = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const sec = s.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim(); result[section] = result[section] || {}; continue; }
    const kv = s.match(/^([^=#\s]+)\s*=\s*(.+)$/);
    if (kv && section) {
      let v = kv[2].trim();
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      else if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (/^\d+$/.test(v)) v = Number(v);
      result[section][kv[1]] = v;
    }
  }
  return result;
}

let fbTomlCache = { file: "", mtime: 0, cfg: {} };
function fbToml() {
  const file = path.join(FB_HOME(), "config", "setting.toml");
  try {
    const mtime = statSync(file).mtimeMs;
    if (fbTomlCache.file !== file || fbTomlCache.mtime !== mtime) {
      fbTomlCache = { file, mtime, cfg: parseToml(readFileSync(file, "utf8")) };
    }
    return fbTomlCache;
  } catch {
    return { file, mtime: 0, cfg: {} };
  }
}

// 写入/更新 setting.toml 键值（带备份），移植自 FPBrowser 搭建助手
function upsertToml(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const header = `[${section}]`;
  const secIdx = lines.findIndex((l) => l.trim() === header);
  const literal = typeof value === "boolean" ? (value ? "true" : "false")
    : typeof value === "number" ? String(value)
    : JSON.stringify(String(value));
  const newLine = `${key} = ${literal}`;
  if (secIdx === -1) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push("");
    lines.push(header, newLine);
    return lines.join("\n") + "\n";
  }
  let endIdx = lines.length;
  for (let i = secIdx + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { endIdx = i; break; }
  }
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let i = secIdx + 1; i < endIdx; i++) {
    if (keyRe.test(lines[i])) { lines[i] = newLine; return lines.join("\n") + "\n"; }
  }
  lines.splice(endIdx, 0, newLine);
  return lines.join("\n") + "\n";
}

function secret(len = 32) {
  return randomBytes(len).toString("base64url").slice(0, Math.max(20, len));
}

// 定位 VirtualBrowser 管理客户端：已配置路径 → 常见安装位置
function locateVbExe() {
  const configured = VB_EXE();
  if (configured && existsSync(configured)) return configured;
  const candidates = [
    "C:\\Program Files\\VirtualBrowser\\VirtualBrowser.exe",
    "C:\\Program Files (x86)\\VirtualBrowser\\VirtualBrowser.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "VirtualBrowser", "VirtualBrowser.exe") : "",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || "";
}

// 自建 API 版 VirtualBrowser：免 VIP、免 api-key，随二合一安装包一起装好
function locateVbApiExe() {
  const configured = env("RUODAO_VB_API_EXE", "");
  if (configured && existsSync(configured)) return configured;
  const candidates = [
    "C:\\Program Files\\VirtualBrowser API\\VirtualBrowser_API\\virtualbrowser_api.exe",
    "C:\\Program Files (x86)\\VirtualBrowser API\\VirtualBrowser_API\\virtualbrowser_api.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "VirtualBrowser API", "VirtualBrowser_API", "virtualbrowser_api.exe") : "",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || "";
}

// 定位 Chromium 内核 exe（Playwright 直驱必须用它，管理客户端不认 --worker-id）
// 新版布局：<根>\VirtualBrowser\<内核版本>\VirtualBrowser.exe；旧版布局：<根>\Chrome-bin\VirtualBrowser.exe
function locateVbKernelExe() {
  const configured = VB_EXE();
  if (configured && existsSync(configured)) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(path.basename(path.dirname(configured)))) return configured;
  }
  const roots = new Set();
  if (configured) roots.add(path.dirname(configured));
  const client = locateVbExe();
  if (client) roots.add(path.dirname(client));
  for (const root of roots) {
    const versioned = path.join(root, "VirtualBrowser");
    try {
      const versions = readdirSync(versioned)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d) && existsSync(path.join(versioned, d, "VirtualBrowser.exe")))
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
          return 0;
        });
      if (versions[0]) return path.join(versioned, versions[0], "VirtualBrowser.exe");
    } catch { /* 继续试旧布局 */ }
    const legacy = path.join(root, "Chrome-bin", "VirtualBrowser.exe");
    if (existsSync(legacy)) return legacy;
  }
  return "";
}

async function downloadToFile(url, dest, { timeoutMs = 1800000, state, minSize = 100 * 1024 * 1024 } = {}) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const { createWriteStream } = await import("node:fs");
  const ws = createWriteStream(dest);
  let received = 0;
  let lastBeat = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
    // 下载期间定期刷新心跳与进度（否则长下载会被僵尸检测误杀）
    if (state && Date.now() - lastBeat > 8000) {
      lastBeat = Date.now();
      state.download = total ? `下载中 ${Math.round((received / total) * 100)}%` : `下载中 ${(received / 1024 / 1024).toFixed(0)}MB`;
      setupStateWrite(state);
    }
  }
  await new Promise((r) => ws.end(r));
  const size = statSync(dest).size;
  if (size < minSize) throw new Error(`下载不完整（${(size / 1024 / 1024).toFixed(1)}MB）`);
  return size;
}

// 安全 spawn：spawn 失败（如执行权限受限）通过 error 事件捕获返回 false，绝不让安装进程崩溃
function spawnDetachedSafe(exe, args, { visible = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const child = spawn(exe, args, { cwd: DATA_DIR, detached: true, windowsHide: !visible, stdio: "ignore" });
      child.on("error", () => done(false));
      child.unref();
      setTimeout(() => done(true), 800); // spawn 成功发起即视为已启动（安装结果由后续检测判断）
    } catch { done(false); }
  });
}

/* ---------------- 二合一安装包（VirtualBrowser API + 便携网关） ----------------
 * 目标：用户点一次「一键安装」，插件自动找到并静默运行二合一安装包：
 *   1) VirtualBrowser API 版（免 VIP、免 api-key，自带 :9000 本地 API）
 *   2) 免 Python 的 FPBrowser2API 便携版（ProgramData，随包安装）
 * 安装包放在插件 vendor/allinone 随插件分发；也支持放到下载目录或配置 URL 自动下载。
 */

const POOL_SETUP_NAME = "Ruodao-ImagePool-AllInOne-Setup.exe";
const POOL_SETUP_DEFAULT_URL = "https://ruodao.com/downloads/plugins/Ruodao-ImagePool-AllInOne-Setup.exe";
const POOL_SETUP_URL = () => env("RUODAO_POOL_SETUP_URL", "") || POOL_SETUP_DEFAULT_URL;

function poolSetupCandidates(input) {
  const list = [];
  const explicit = String(input?.bundle_exe || input?.setup_exe || "").trim();
  if (explicit) list.push({ path: explicit, source: "指定路径" });
  const configured = env("RUODAO_POOL_SETUP_PATH", "");
  if (configured) list.push({ path: configured, source: "配置路径" });
  list.push({ path: path.join(PLUGIN_DIR, "vendor", "allinone", POOL_SETUP_NAME), source: "插件内置" });
  const dirs = [DOWNLOADS_DIR()];
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) dirs.push(path.join(home, "Downloads"), path.join(home, "Desktop"), path.join(home, "桌面"));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const hit = readdirSync(dir)
        .filter((f) => /^Ruodao-ImagePool-AllInOne.*\.exe$/i.test(f))
        .map((f) => ({ path: path.join(dir, f), size: statSync(path.join(dir, f)).size }))
        .filter((f) => f.size > 100 * 1024 * 1024)
        .sort((a, b) => b.size - a.size)[0];
      if (hit) list.push({ path: hit.path, source: `本地安装包（${dir}）` });
    } catch { /* 目录不可读跳过 */ }
  }
  return list.filter((c) => c.path && existsSync(c.path));
}

async function locatePoolSetup(input, { state } = {}) {
  const local = poolSetupCandidates(input)[0];
  if (local) return local;
  const url = String(input?.bundle_url || input?.setup_url || POOL_SETUP_URL() || "").trim();
  if (!url) return null;
  ensureDataDir();
  const dir = DOWNLOADS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, POOL_SETUP_NAME);
  const size = await downloadToFile(url, dest, { timeoutMs: 3600000, state });
  return { path: dest, source: `自动下载 ${(size / 1024 / 1024).toFixed(0)}MB` };
}

async function installPoolSilently(setupPath, { state } = {}) {
  const log = (line) => { if (state) setupStateLog(state, line); };
  const installLog = path.join(DATA_DIR, "allinone-install.log");
  const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", `/LOG=${installLog}`];
  log("启动二合一安装包（若弹出 UAC/安全提示，请点「是」允许；安装约 1~3 分钟）…");
  const launched = await spawnDetachedSafe(setupPath, args)
    || await spawnDetachedSafe("cmd", ["/c", "start", "", setupPath, ...args])
    || await spawnDetachedSafe(setupPath, [], { visible: true });
  if (!launched) log("安装包无法直接执行（可能被安全策略拦截），请手动双击安装包后重跑一键安装");
  for (let i = 0; i < 144; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (state) setupStateWrite(state); // 安装期间持续心跳，避免被僵尸检测误杀
    const gateway = gatewayRunner(FB_HOME());
    const vbApi = locateVbApiExe();
    const vbClient = locateVbExe();
    if (gateway && (vbApi || vbClient)) {
      log(`二合一安装完成：网关 ${FB_HOME()}${vbApi ? `；VirtualBrowser API ${vbApi}` : ""}${vbClient ? `；VirtualBrowser ${vbClient}` : ""}`);
      return { ok: true, installDir: FB_HOME(), vbApi, vbClient, silent: launched };
    }
    if (i === 11) log("安装仍在进行：若已弹出 UAC/安装向导，请按提示允许或完成");
  }
  log(`安装等待超时（日志：${installLog}）；请手动运行安装包后重跑一键安装`);
  return { ok: false, installDir: FB_HOME(), vbApi: locateVbApiExe(), vbClient: locateVbExe() };
}

// 源码兜底：没有二合一安装包且本机有 Git/Python 时仍可安装（老用户/开发环境）
async function installGatewayFromSource({ installDir, git, python, logFile, state }) {
  const mainPy = path.join(installDir, "main.py");
  setupStateLog(state, `源码安装 FPBrowser2API 到 ${installDir}`);
  if (!existsSync(mainPy)) {
    setupStateLog(state, `git clone ${FB_REPO_URL}`);
    await runStream(git, ["clone", "--depth", "1", FB_REPO_URL, installDir], path.dirname(installDir) || ".", { logFile, state, timeoutMs: 300000 });
  } else {
    setupStateLog(state, "检测到已有源码安装，跳过下载");
  }
  if (!existsSync(path.join(installDir, ".venv", process.platform === "win32" ? "Scripts" : "bin"))) {
    await runStream(python, ["-m", "venv", ".venv"], installDir, { logFile, state, timeoutMs: 300000 });
  }
  const venvPython = findPython(installDir);
  const depsMarker = path.join(installDir, ".deps-ok");
  if (!existsSync(depsMarker)) {
    const pipIndexFallback = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--timeout", "60"];
    const pipArgs = [
      ["-m", "pip", "install", "--upgrade", "pip"],
      ["-m", "pip", "install", "-r", "requirements.txt"],
    ];
    for (const args of pipArgs) {
      let lastErr = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        const fullArgs = attempt === 1 ? args : [...args, ...pipIndexFallback];
        try {
          setupStateLog(state, `pip：${fullArgs.slice(-1)[0] === "pip" ? "升级 pip" : "安装 requirements.txt"}${attempt > 1 ? `（第 ${attempt} 次重试，切换国内镜像）` : ""}`);
          await runStream(venvPython, fullArgs, installDir, { logFile, state, timeoutMs: 1200000 });
          lastErr = "";
          break;
        } catch (e) {
          lastErr = e.message;
          setupStateLog(state, `pip 失败：${e.message.slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (lastErr) throw new Error(`依赖安装失败（已自动重试 2 次并切换国内镜像）：${lastErr}（完整日志：${logFile}）`);
    }
    try { writeFileSync(depsMarker, new Date().toISOString(), "utf8"); } catch { /* 标记失败不影响安装 */ }
  } else {
    setupStateLog(state, "依赖已安装（.deps-ok），跳过 pip");
  }
  return installDir;
}

/* ---------------- 服务自动拉起 ---------------- */

let fbStarting = null;

async function fbReachable() {
  // 显式配置的地址只探该地址；否则多端口探测：toml 端口、记忆端口、8002/8000 默认，谁活用谁
  const explicit = env("RUODAO_FB_API_BASE", "");
  const bases = explicit ? [FB_BASE()] : fbPortCandidates().map((port) => `http://127.0.0.1:${port}`);
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) {
        if (!explicit) fbPortActual = Number(new URL(base).port);
        return true;
      }
    } catch { /* 下一个端口 */ }
  }
  return false;
}

async function vbReachable() {
  try {
    const res = await fetch(`${VB_BASE()}/api/getBrowserList`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(VB_KEY() ? { "X-API-KEY": VB_KEY() } : {}) },
      body: JSON.stringify({ page: 0, pageSize: 1 }),
      signal: AbortSignal.timeout(2500),
    });
    return res.status < 500;
  } catch { return false; }
}

async function ensureFb() {
  if (await fbReachable()) return { ok: true, base: FB_BASE() };
  const home = FB_HOME();
  if (!home || !existsSync(home)) return { ok: false, base: FB_BASE(), hint: `FPBrowser2API 未安装（${home}）：执行「一键安装」自动装好二合一便携包` };
  const runner = gatewayRunner(home);
  if (!runner) return { ok: false, base: FB_BASE(), hint: "网关文件不完整（缺 fpbrowser2api.exe 或 Python 环境）：重新执行「一键安装」" };
  if (!fbStarting) {
    try {
      const child = spawn(runner.cmd, runner.args, {
        cwd: home,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, FPBROWSER2API_APP_ROOT: home, FPBROWSER_PORT: String(FB_PORT()) },
      });
      child.on("error", () => undefined);
      child.unref();
    } catch { /* 拉起失败由后续探测报错 */ }
    fbStarting = (async () => {
      for (let i = 0; i < 40; i++) {
        if (await fbReachable()) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
  }
  const ok = await fbStarting;
  return ok ? { ok: true, base: FB_BASE() } : { ok: false, base: FB_BASE(), hint: `FPBrowser2API 启动超时（${FB_BASE()}），请手动启动后重试` };
}

// 释放 9000 端口上的旧 VirtualBrowser API/客户端（旧版本可能需要 api-key）
function killVbApiPortOwners() {
  const ps = [
    "$killed = @()",
    "foreach ($port in @(9000)) {",
    "  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue",
    "  foreach ($c in $conns) {",
    "    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue",
    "    if ($p -and $p.ProcessName -match '^(VirtualBrowser|virtualbrowser_api)$') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $killed += \"$($p.ProcessName)#$($p.Id)\" }",
    "  }",
    "}",
    "if ($killed.Count) { 'killed ' + ($killed -join ',') } else { 'no vb api owner' }",
  ].join("; ");
  return psRun(ps, 20000);
}

async function ensureVb() {
  const direct = await directModule();
  const discover = async () => {
    try { return await direct.vbDiscover(); }
    catch (e) { return { ok: false, error: e.message }; }
  };
  let found = await discover();
  if (found.ok) return { ok: true, base: found.base, discovered: true };
  if (found.needKey && VB_KEY()) return { ok: true, base: found.base || VB_BASE(), auth: "api-key" };

  // 优先拉起自建 API 服务（无需 VIP、无需在客户端里开 API）
  const apiExe = locateVbApiExe();
  if (apiExe) {
    if (found.needKey) {
      // 9000 被旧客户端/旧 API 占用且需要 key：先释放端口，再启动免 key 的 API 版
      killVbApiPortOwners();
      await new Promise((r) => setTimeout(r, 1200));
    }
    try {
      spawn(apiExe, [], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        found = await discover();
        if (found.ok) return { ok: true, base: found.base, started: "api" };
        if (found.needKey && VB_KEY()) return { ok: true, base: found.base || VB_BASE(), auth: "api-key", started: "api" };
      }
    } catch { /* 下面继续尝试客户端 */ }
  }
  // 兼容官方客户端：打开客户端后由用户/插件在客户端里开启本地 API
  const exe = locateVbExe();
  if (exe) {
    try {
      spawn(exe, [], { detached: true, windowsHide: false, stdio: "ignore" }).unref();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        found = await discover();
        if (found.ok) return { ok: true, base: found.base, started: "client" };
        if (found.needKey && VB_KEY()) return { ok: true, base: found.base || VB_BASE(), auth: "api-key", started: "client" };
      }
    } catch { /* 忽略，下面报错 */ }
  }
  if (apiExe) {
    return { ok: false, base: VB_BASE(), hint: "VirtualBrowser API 服务启动超时：请点「启动服务」重试，或到开始菜单「VirtualBrowser API & MCP」启动（若 :9000 被占用，请先关闭旧的 VirtualBrowser 客户端）" };
  }
  return { ok: false, base: VB_BASE(), hint: "VirtualBrowser 未安装：请先执行一键安装（二合一安装包会自动装好 API 版）" };
}

/* ---------------- HTTP 封装 ---------------- */

async function fbApi(pathname, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const started = await ensureFb();
  if (!started.ok) throw new Error(started.hint || `FPBrowser2API 不可达（${started.base}）`);
  let res;
  try {
    res = await fetch(`${FB_BASE()}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(FB_KEY() ? { Authorization: `Bearer ${FB_KEY()}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`无法连接 FPBrowser2API（${FB_BASE()}）：${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`网关返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (res.status === 401 || res.status === 403) throw new Error("鉴权失败：请在插件配置里填写正确的 RUODAO_FB_API_KEY（FPBrowser2API 后台生成）");
  if (res.status >= 400) throw new Error(`接口 ${pathname} 返回 HTTP ${res.status}：${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/* ---------------- 消耗台账 ---------------- */

function ledgerAppend(record) {
  ensureDataDir();
  appendFileSync(LEDGER_FILE(), JSON.stringify({ ts: Date.now(), ...record }) + "\n", "utf8");
}

function ledgerRead() {
  try {
    return readFileSync(LEDGER_FILE(), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function maskAccount(v) {
  if (!v) return "";
  const [mailbox] = String(v).split("----");
  if (!mailbox) return "";
  return mailbox.length > 4 ? `${mailbox.slice(0, 2)}***${mailbox.slice(-2)}` : "***";
}

/* ---------------- 账号导入 ---------------- */

function parseAccounts(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/----|\t+|\|/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [email, password, totp] = parts;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    rows.push({ email, password, totp: totp || "" });
  }
  return rows;
}

async function accountsImport(input) {
  const text = input.text ?? input.content ?? input.accounts ?? "";
  const rows = parseAccounts(text);
  if (!rows.length) {
    fail("未解析出任何账号：发货格式为每行「邮箱----密码----2FA密钥」，请把购买平台的发货文本原文粘贴进来");
  }
  ensureDataDir();
  const file = ACCOUNTS_FILE();
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const known = new Set(existing.split(/\r?\n/).filter(Boolean).map((l) => l.split("----")[0]));
  const fresh = [];
  for (const r of rows) {
    if (!known.has(r.email)) { known.add(r.email); fresh.push(r); }
  }
  appendFileSync(file, fresh.map((r) => [r.email, r.password, r.totp].join("----")).join("\n") + (fresh.length ? "\n" : ""), "utf8");
  emit({
    state: "succeeded",
    action: "import",
    parsed: rows.length,
    imported: fresh.length,
    duplicated: rows.length - fresh.length,
    total: known.size + fresh.length,
    accountsFile: file,
    masked: rows.map((r) => maskAccount(r.email)),
    next: "打开 VirtualBrowser，用 FPBrowser2API 的批量绑定脚本（batch_bind_chatgpt.py）或手动为每个账号创建独立窗口并登录，登录态会持久保存在指纹环境里",
  });
}

async function accountsList() {
  ensureDataDir();
  const file = ACCOUNTS_FILE();
  if (!existsSync(file)) emit({ state: "succeeded", action: "list", total: 0, accounts: [], hint: "尚无账号，请用 accounts import 导入发货文本" });
  const rows = parseAccounts(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.split("----").slice(0, 2).join("----")).join("\n"));
  const usage = ledgerRead();
  const perAccount = {};
  for (const u of usage) {
    const key = u.account || "未记录";
    perAccount[key] = perAccount[key] || { generated: 0, failed: 0 };
    perAccount[key][u.state === "completed" ? "generated" : "failed"]++;
  }
  emit({
    state: "succeeded",
    action: "list",
    total: rows.length,
    accounts: rows.map((r) => ({
      email: maskAccount(r.email),
      has2fa: Boolean(r.totp),
      generated: perAccount[maskAccount(r.email)]?.generated || 0,
      failed: perAccount[maskAccount(r.email)]?.failed || 0,
    })),
    accountsFile: file,
  });
}

/* ---------------- 命令实现 ---------------- */

async function doctor() {
  const [fb, vb] = await Promise.all([ensureFb(), ensureVb()]);
  const direct = await directModule();
  const report = { state: "succeeded", dataDir: DATA_DIR, checks: {} };
  const vbKernel = locateVbKernelExe();
  report.checks.directMode = { ok: direct.hasPlaywright() && Boolean(vbKernel), hint: "直驱模式（推荐）：内置 Playwright + VirtualBrowser 内核，免网关免 Python、免 VIP", playwright: direct.hasPlaywright(), vbExe: vbKernel || undefined, vbClient: locateVbExe() || undefined };
  let pool = { workers: [] };
  try { pool = JSON.parse(readFileSync(path.join(DATA_DIR, "workers.json"), "utf8")); } catch { /* 空 */ }
  report.checks.accountPool = { ok: pool.workers?.some((w) => w.loggedIn) || false, loggedIn: pool.workers?.filter((w) => w.loggedIn).length || 0, total: pool.workers?.length || 0, hint: "bind 命令可批量自动登录" };
  report.checks.fpbrowser2api = { ok: fb.ok, base: fb.base, hint: fb.ok ? "号池调度网关连通（高级模型路径）" : "未就绪（可选：仅直驱模式即可满足 ChatGPT 生图）" };
  // VirtualBrowser：API 端口是动态的，用自动发现（同时校验 api-key）
  let vbd = { ok: false, base: VB_BASE(), error: "" };
  try {
    vbd = await direct.vbDiscover();
    report.checks.virtualbrowser = vbd.ok
      ? { ok: true, base: vbd.base, auth: VB_KEY() ? "api-key" : "none", hint: `本地 API 就绪（${vbd.base}），已有 ${Array.isArray(vbd.list) ? vbd.list.length : 0} 个环境（不足会自动创建）${VB_KEY() ? "" : "；自建 API 版无需 api-key"}` }
      : { ok: false, base: vbd.base || VB_BASE(), hint: vbd.needKey ? `端口已找到但鉴权失败：${vbd.error}：点「启动服务」或重跑「一键安装」拉起自带 API 版` : vbd.error };
  } catch (e) {
    report.checks.virtualbrowser = { ok: false, base: VB_BASE(), hint: e.message };
  }
  if (vbd.ok) {
    try {
      const listed = await vbApiRequest(vbd.base, "/api/getCrxList", { key: VB_KEY() || LOCAL_VB_KEY });
      const exts = Array.isArray(listed?.data) ? listed.data : [];
      const bridge = exts.find((e) => /browser_extension/i.test(String(e.path || "")));
      report.checks.bridgeExtension = { ok: Boolean(bridge), count: exts.length, hint: bridge ? "通信扩展已挂载（网关任务可用）" : "通信扩展未挂载：点「后台自动配置」自动安装" };
    } catch (e) {
      report.checks.bridgeExtension = { ok: false, hint: `读取扩展列表失败：${e.message}` };
    }
  } else {
    report.checks.bridgeExtension = { ok: false, hint: "VirtualBrowser API 未就绪" };
  }
  report.checks.apiKey = { ok: Boolean(FB_KEY()), hint: FB_KEY() ? "API Key 已就绪（setup 自动写入 setting.toml）" : "未配置 API Key：执行 setup 可自动生成" };
  report.checks.model = { ok: true, value: DEFAULT_MODEL(), hint: "默认生图模型（gpt-image2-1k/2k/4k、nana-banana-2 等）" };
  let apiHealth = null;
  try { apiHealth = await imageApiHealth(); } catch { /* 未启动 */ }
  report.checks.daemon = {
    ok: Boolean(apiHealth),
    base: `http://127.0.0.1:${IMAGE_API_PORT()}/v1`,
    warmSessions: apiHealth?.pool?.warm?.length || 0,
    concurrency: apiHealth?.pool?.concurrency ?? null,
    hint: apiHealth
      ? `常驻守护进程在线（并发 ${apiHealth.pool?.concurrency ?? "-"}，常驻窗口 ${apiHealth.pool?.warm?.length ?? 0} 个）：生图复用已登录窗口`
      : "守护进程未运行：首次生图会自动拉起；也可手动「启动加速进程」",
  };
  const directReady = report.checks.directMode.ok && report.checks.accountPool.ok;
  const gatewayReady = fb.ok && vb.ok; // 自建 API 版免 key，只要两端连通即可
  report.ok = directReady || gatewayReady;
  report.mode = directReady ? "direct（直驱，已就绪）" : gatewayReady ? "gateway（网关）" : "未就绪";
  if (!report.ok) report.hint = "最简单路径：① 点「一键安装」（二合一安装包自动装好 VirtualBrowser API 版 + FPBrowser2API）② 粘贴账号并登录 ③ 直接生图，无需任何手动配置";
  emit(report);
}

const BUILTIN_IMAGE_MODELS = ["gpt-image2-1k", "gpt-image2-2k", "gpt-image2-4k", "nana-banana-2", "nana-banana-2_sync", "nana-banana-pro", "nana-banana-2-4k", "nana-banana-pro-4k"];
const BUILTIN_VIDEO_MODELS = ["veo-3-1", "veo-3-1-1080p", "veo-omni-flash", "veo-omni-flash-1080p", "seedance-2", "seedance-2-fast"];

async function models() {
  let list = [];
  let gatewayOk = false;
  try {
    const res = await fetch(`${FB_BASE()}/v1/models`, {
      headers: { ...(FB_KEY() ? { Authorization: `Bearer ${FB_KEY()}` } : {}) },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      list = (data?.data || data?.models || []).map((m) => (typeof m === "string" ? { id: m } : m)).filter((m) => m?.id);
      gatewayOk = list.length > 0;
    }
  } catch { /* 网关未启动时用内置列表，保证下拉框可用 */ }
  if (!list.length) {
    list = [...BUILTIN_IMAGE_MODELS, ...BUILTIN_VIDEO_MODELS].map((id) => ({ id, object: "model", owned_by: "image-pool-builtin" }));
  }
  const imageModels = list.filter((m) => /image|banana/i.test(String(m.id)));
  const videoModels = list.filter((m) => /veo|video|seedance|sora/i.test(String(m.id)));
  emit({
    state: "succeeded",
    gatewayOk,
    total: list.length,
    models: list,
    imageModels: imageModels.map((m) => m.id),
    videoModels: videoModels.map((m) => m.id),
    defaultModel: DEFAULT_MODEL(),
    hint: gatewayOk
      ? "网关已连通；直驱模式会忽略图像模型名，由 ChatGPT 内置画图工具出图"
      : "FPBrowser2API 未启动，当前展示内置清单；直驱生图无需选图像模型",
  });
}

async function generate(input) {
  const prompt = String(input.prompt || input.description || "").trim();
  if (!prompt) fail("缺少生图提示词：请传 { prompt }");

  // 优先守护进程：已登录窗口常驻复用 + 多账号并发（比每次冷启动快 10~30 秒）
  if (!input.forceGateway && input.mode !== "gateway") {
    let ready = false;
    try { ready = Boolean(await ensureImageApi()); } catch { ready = false; }
    if (ready) {
      emit({ state: "progress", step: "号池守护进程就绪，开始调度（复用已登录窗口）" });
      try {
        const data = await apiRequest("/v1/images/generations", {
          method: "POST",
          body: {
            prompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.response_format ? { response_format: input.response_format } : {}),
            ...(input.timeoutMs ? { timeout_seconds: Math.round(Number(input.timeoutMs) / 1000) } : {}),
          },
          timeoutMs: Number(input.timeoutMs) || 300000,
        });
        const first = data?.data?.[0] || {};
        const poolInfo = data?.pool || {};
        emit({
          state: "succeeded",
          mode: "direct",
          via: "daemon",
          workerId: poolInfo.workerId,
          imageUrl: first.url || "",
          url: first.url || "",
          elapsedMs: poolInfo.elapsedMs,
          queueMs: poolInfo.queueMs,
          session: poolInfo.session,
          stages: poolInfo.stages,
          hint: "已完成并记账：本地守护进程复用了已登录窗口；可用 usage / logs / images 查看额度、日志与图片库",
        });
        return;
      } catch (e) {
        fail(e.message, { mode: "daemon" });
      }
    }
  }

  // 直驱优先：号池里有已登录 worker 时，内嵌 Playwright 直连 VirtualBrowser 生图（免网关）。
  // 失败时换下一个已登录账号；全部失败直接报错，绝不悄悄回退到没有 worker 的网关白等。
  const direct = await directModule();
  let pool = { workers: [] };
  try { pool = JSON.parse(readFileSync(path.join(DATA_DIR, "workers.json"), "utf8")); } catch { /* 空 */ }
  const now = Date.now();
  const usable = (pool.workers || [])
    .filter((w) => w.loggedIn && !(Number(w.limitedUntil) > now))
    .sort((a, b) => (a.usageCount || 0) - (b.usageCount || 0));
  if (usable.length && direct.hasPlaywright() && !input.forceGateway && input.mode !== "gateway") {
    const maxAttempts = Math.max(1, Math.min(usable.length, Number(input.workers) || 3));
    const errors = [];
    for (const worker of usable.slice(0, maxAttempts)) {
      try {
        const result = await direct.directGenerate(
          { ...input, workerId: worker.workerId, timeoutMs: Number(input.timeoutMs) || 180000 },
          { onProgress: (p) => emit({ state: "progress", ...p }) },
        );
        emit({
          state: "succeeded",
          mode: "direct",
          workerId: result.workerId,
          imagePath: result.imagePath || undefined,
          imageUrl: result.imageUrl || undefined,
          url: result.imageUrl || result.imagePath || "",
          elapsedMs: result.elapsedMs,
          ...(result.note ? { note: result.note } : {}),
          hint: "直驱模式：消耗已记入本地台账，可用 usage 命令查看",
        });
        return;
      } catch (e) {
        const message = String(e?.message || e);
        errors.push(`账号 #${worker.workerId}：${message}`);
        if (worker !== usable[Math.min(maxAttempts, usable.length) - 1]) {
          emit({ state: "progress", step: `账号 #${worker.workerId} 生图失败，自动换下一个账号：${message.slice(0, 140)}` });
        }
      }
    }
    fail(`直驱生图失败（已尝试 ${Math.min(maxAttempts, usable.length)} 个账号）：\n${errors.join("\n")}`, { mode: "direct" });
  }

  // 强制直出咒语：避免 ChatGPT 反问导致自动化卡死（参见 FPBrowser2API 的防反问封装）
  const guardedPrompt = /[？?]$|帮我画|画一|画个/.test(prompt)
    ? `立即生成图片：${prompt.replace(/[？?]$/, "")}。请直接调用画图工具立即生成图片，不要输出任何询问文字或反问。`
    : prompt;

  const model = input.model || DEFAULT_MODEL();
  const body = {
    model,
    prompt: guardedPrompt,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.aspect_ratio || input.aspectRatio ? { aspect_ratio: input.aspect_ratio || input.aspectRatio } : {}),
    ...(input.n ? { n: input.n } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.images ? { images: input.images } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
  };

  const submitted = await fbApi("/v1/videos", { method: "POST", body, timeoutMs: 60000 });
  const taskId = submitted?.task_id || submitted?.id || submitted?.data?.task_id;
  if (!taskId) fail(`任务提交失败：${JSON.stringify(submitted).slice(0, 300)}`);

  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_S() * 1000;
  let last = submitted;
  let queuedSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    last = await fbApi(`/v1/videos/${encodeURIComponent(taskId)}`, { timeoutMs: 30000 });
    const status = last?.status || last?.state || last?.task_status || "";
    if (status === "completed" || status === "failed" || last?.final === true) break;
    if (status && !/queued|pending|排队/i.test(String(status))) queuedSince = Date.now();
    // 网关没有浏览器 worker 时任务会一直排队到服务端 5 分钟超时；提前给出可操作提示
    if (Date.now() - queuedSince > 120000) {
      fail("FPBrowser2API 排队超过 120 秒，没有浏览器窗口接单：请把模型留空改用直驱（直接出图），或在号池后台同步 VirtualBrowser 窗口后再选网关模型", { taskId });
    }
    if (status) emit({ state: "progress", taskId, status, progress: last?.progress, elapsedMs: Date.now() - startedAt });
  }
  const status = last?.status || last?.state || last?.task_status || "unknown";
  const imageUrl = last?.image_url || last?.video_url || last?.url || last?.data?.image_url || "";
  const elapsedMs = Date.now() - startedAt;
  const gatewayError = String(last?.error?.message || "");
  if (/排队超时|queue.*timeout/i.test(gatewayError)) {
    fail("网关排队超时：FPBrowser2API 当前没有可用的浏览器 worker。直驱模式请把模型留空；要用 nana-banana/veo 请先在号池后台同步窗口", { taskId });
  }

  ledgerAppend({
    kind: "generate",
    taskId,
    model,
    account: maskAccount(last?.metadata?.account || last?.window || input.account || ""),
    state: status === "completed" ? "completed" : "failed",
    elapsedMs,
    imageUrl: imageUrl || "",
    error: status === "failed" ? (last?.error?.message || "任务失败") : undefined,
  });

  if (status !== "completed" && !imageUrl) {
    fail(`生图失败（${status}）：${last?.error?.message || "超时或上游异常，可用 task 命令继续查询"}`, { taskId });
  }
  emit({
    state: "succeeded",
    taskId,
    model,
    status,
    imageUrl,
    url: imageUrl,
    progress: last?.progress,
    elapsedMs,
    metadata: last?.metadata,
    hint: "imageUrl 由浏览器会话内提取，可直接下载；消耗已记入本地台账，可用 usage 命令查看",
  });
}

async function task(input) {
  const taskId = input.taskId || input.id || input.task_id;
  if (!taskId) fail("缺少 taskId：请传 { taskId }");
  const data = await fbApi(`/v1/videos/${encodeURIComponent(taskId)}`, { timeoutMs: 30000 });
  const status = data?.status || data?.state || data?.task_status || "";
  emit({ state: "succeeded", taskId, status, progress: data?.progress, imageUrl: data?.image_url || data?.url || "", videoUrl: data?.video_url || "", error: data?.error, raw: data });
}

const IMAGE_API_PORT = () => Number(env("RUODAO_IMAGE_API_PORT", "8100")) || 8100;
const IMAGE_API_TOKEN_FILE = () => path.join(DATA_DIR, "api-token.txt");

function imageApiToken() {
  try {
    const saved = readFileSync(IMAGE_API_TOKEN_FILE(), "utf8").trim();
    if (saved) return saved;
  } catch { /* 首次启动 */ }
  ensureDataDir();
  const fresh = randomBytes(24).toString("hex");
  writeFileSync(IMAGE_API_TOKEN_FILE(), fresh, "utf8");
  return fresh;
}

async function imageApiHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${IMAGE_API_PORT()}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function agentAccess() {
  const port = IMAGE_API_PORT();
  const apiKey = imageApiToken();
  const before = await imageApiHealth();
  let health;
  try { health = await ensureImageApi(); } catch (e) { fail(e.message); }
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const started = !before || before.build !== health.build;
  emit({
    state: "succeeded",
    started,
    baseUrl,
    apiKey,
    models: poolModels.IMAGE_MODELS.slice(0, 3),
    endpoints: {
      models: `${baseUrl}/models`,
      images: `${baseUrl}/images/generations`,
      usage: `${baseUrl}/usage?days=30`,
      logs: `${baseUrl}/logs?days=7&limit=100`,
      imageLibrary: `${baseUrl}/images`,
    },
    workers: health.workers,
    pool: health.pool,
    example: `curl ${baseUrl}/images/generations -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"prompt":"一只橘猫"}'`,
    note: "OpenAI 兼容：生图 /v1/images/generations，另有 /v1/usage、/v1/logs、/v1/images 可直接给 Agent 或工作台用。",
  });
}

async function usage(input) {
  const days = Number(input?.days) || 30;
  const state = ledger.readWorkersState();
  const report = ledger.aggregateUsage(ledger.readLedger(), { days, workers: state.workers || [] });
  emit({
    state: "succeeded",
    ...report,
    hint: "统计来自本地台账 usage.jsonl（每次生图/对话的模型、账号、排队与阶段耗时）。额度为可观测口径：今日调用量 + 上游限流标记；ChatGPT 网页端不暴露剩余次数。",
  });
}

/* ---------------- 守护进程 / 对话 / 日志 / 图片库 ---------------- */

async function apiRequest(pathname, { method = "GET", body, timeoutMs = 30000, token } = {}) {
  const base = `http://127.0.0.1:${IMAGE_API_PORT()}`;
  let res;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token || imageApiToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`无法连接号池守护进程（${base}）：${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}：${text.slice(0, 200)}`);
  return data;
}

/** 确保守护进程就绪：插件更新（build 变化）时自动重启，避免跑旧代码 */
async function ensureImageApi({ restartOnStale = true } = {}) {
  const port = IMAGE_API_PORT();
  const directScript = path.join(PLUGIN_DIR, "bin", "direct.mjs");
  const build = existsSync(directScript) ? String(statSync(directScript).mtimeMs) : "";
  let health = await imageApiHealth();
  if (health && restartOnStale && health.build !== build) {
    await stopImageApi();
    health = null;
  }
  if (!health) {
    const script = path.join(PLUGIN_DIR, "bin", "image-api.mjs");
    if (!existsSync(script)) throw new Error(`缺少守护进程脚本：${script}`);
    try {
      const child = spawn(process.execPath, [script], {
        cwd: DATA_DIR,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          RUODAO_IMAGE_API_PORT: String(port),
          RUODAO_IMAGE_API_BUILD: build,
          RUODAO_IMAGE_POOL_DATA_DIR: DATA_DIR,
        },
      });
      child.on("error", () => {});
      child.unref();
    } catch (e) {
      throw new Error(`号池守护进程启动失败：${e.message}`);
    }
    for (let i = 0; i < 30 && !health; i++) {
      await new Promise((r) => setTimeout(r, 500));
      health = await imageApiHealth();
    }
  }
  if (!health) throw new Error(`号池守护进程未就绪（端口 ${port}）：请查看 ${path.join(DATA_DIR, "api.log")}`);
  return health;
}

async function stopImageApi() {
  try {
    await apiRequest("/v1/shutdown", { method: "POST", timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 600));
  } catch { /* 进程可能已退出 */ }
  try {
    const pid = Number(readFileSync(path.join(DATA_DIR, "api.pid"), "utf8").trim());
    if (pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      else process.kill(pid, "SIGTERM");
    }
  } catch { /* 已退出 */ }
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), "", "utf8"); } catch { /* 忽略 */ }
}

async function daemonCommand(input) {
  const action = input.action || input.subcommand || "status";
  if (action === "start") {
    const health = await ensureImageApi();
    let warm = null;
    if (input.warm) {
      const count = Math.max(1, Number(input.warm) || 1);
      warm = await apiRequest("/v1/warmup", { method: "POST", body: { count }, timeoutMs: 240000 });
    }
    emit({
      state: "succeeded",
      action,
      port: IMAGE_API_PORT(),
      health,
      ...(warm ? { warm } : {}),
      hint: "守护进程已启动：同一账号窗口复用，多账号按并发数同时执行；空闲窗口 15 分钟自动关闭",
    });
    return;
  }
  if (action === "stop") {
    await stopImageApi();
    emit({ state: "succeeded", action, hint: "守护进程与常驻浏览器窗口已关闭" });
    return;
  }
  if (action === "restart") {
    await stopImageApi();
    const health = await ensureImageApi();
    emit({ state: "succeeded", action, health });
    return;
  }
  if (action !== "status") fail(`不支持的 daemon 操作：${action}（支持 start / stop / restart / status）`);
  const health = await imageApiHealth();
  const directScript = path.join(PLUGIN_DIR, "bin", "direct.mjs");
  const build = existsSync(directScript) ? String(statSync(directScript).mtimeMs) : "";
  emit({
    state: "succeeded",
    action,
    running: Boolean(health),
    stale: Boolean(health && health.build !== build),
    port: IMAGE_API_PORT(),
    health,
    concurrency: health?.pool?.concurrency ?? null,
    warmSessions: health?.pool?.warm?.length ?? 0,
    queued: health?.pool?.queued ?? 0,
    apiBase: `http://127.0.0.1:${IMAGE_API_PORT()}/v1`,
    hint: health
      ? "守护进程在线：生图/对话默认走它，已登录窗口复用，速度比每次冷启动快 10~30 秒"
      : "守护进程未运行：执行 daemon start（或直接生图/对话，会自动拉起）",
  });
}

async function warmup(input) {
  await ensureImageApi();
  const workers = ledger.readWorkersState();
  const total = (workers.workers || []).filter((w) => w.loggedIn).length;
  if (!total) fail("号池没有已登录账号：请先导入账号并自动登录");
  const count = Math.min(total, Math.max(1, Number(input?.count) || total));
  const result = await apiRequest("/v1/warmup", { method: "POST", body: { count }, timeoutMs: 300000 });
  emit({
    state: "succeeded",
    ...result,
    hint: "窗口已预热：接下来的生图/对话直接复用，省掉 10~30 秒冷启动",
  });
}

async function logs(input) {
  const result = ledger.queryLogs(ledger.readLedger(), {
    days: Number(input?.days) || 7,
    limit: Number(input?.limit) || 100,
    offset: Number(input?.offset) || 0,
    kind: input?.kind || "",
    state: input?.state || "",
    workerId: input?.workerId ?? "",
    q: input?.q || input?.keyword || "",
  });
  emit({ state: "succeeded", ...result, ledgerFile: ledger.ledgerFile() });
}

async function images(input) {
  const action = input.action || input.subcommand || "list";
  if (action === "list") {
    const items = ledger.listImages({ limit: Number(input.limit) || 200 });
    const base = `http://127.0.0.1:${IMAGE_API_PORT()}`;
    emit({
      state: "succeeded",
      total: items.length,
      imagesDir: ledger.imagesDir(),
      apiBase: base,
      token: imageApiToken(),
      items: items.map((item) => ({ ...item, url: `${base}/images/${encodeURIComponent(item.file)}` })),
      hint: "图片库来自本地 images/ 目录，每条生图记录都带提示词与耗时；可直接用 url 预览",
    });
    return;
  }
  if (action === "delete") {
    try {
      const result = ledger.deleteImage(input.file);
      emit({ state: "succeeded", action, ...result });
    } catch (e) {
      fail(e.message);
    }
    return;
  }
  if (action === "reveal") {
    const name = path.basename(String(input.file || ""));
    if (!name) fail("缺少 file");
    const full = path.join(ledger.imagesDir(), name);
    if (!existsSync(full)) fail("图片不存在");
    try {
      if (process.platform === "win32") spawnSync("explorer.exe", [`/select,${full}`], { windowsHide: true });
      else if (process.platform === "darwin") spawnSync("open", ["-R", full]);
      else spawnSync("xdg-open", [path.dirname(full)]);
      emit({ state: "succeeded", action, path: full });
    } catch (e) {
      fail(`打开文件夹失败：${e.message}`);
    }
    return;
  }
  fail(`不支持的 images 操作：${action}（支持 list / delete / reveal）`);
}

/* ---------------- 一键安装 / 维护 ---------------- */

// 停止网关：ps1 失败/无 pid/仍有残留时，按安装路径 + 端口占用者反查并结束孤儿进程
function killPortOwners(ports = [8000, 8002]) {
  const portList = ports.join(",");
  const ps = [
    "$killed = @()",
    `foreach ($port in @(${portList})) {`,
    "  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue",
    "  foreach ($c in $conns) {",
    "    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue",
    "    if ($p -and $p.ProcessName -match 'python|node|fpbrowser2api') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $killed += \"$($p.Id)@$port\" }",
    "  }",
    "}",
    `if ($killed.Count -eq 0) { 'no listener on ${portList}' } else { 'killed ' + ($killed -join ',') }`,
  ].join("; ");
  try {
    const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    return `${res.stdout || ""}${res.stderr || ""}`.trim();
  } catch { return "port kill skipped"; }
}

function killPortOwnersExtra(ports) {
  return killPortOwners(ports);
}

function fbStopService(installDir) {  let ps1Msg = "";
  try {
    ps1Msg = fbServiceAction("stop", installDir);
  } catch (e) {
    ps1Msg = `ps1 失败：${String(e.message).slice(0, 100)}`;
  }
  // ps1 说"未运行"也可能存在孤儿进程（旧目录启动/pid 文件丢失）：按端口占用者兜底清理
  const leftover = killPortOwners();
  return `${ps1Msg}；端口清理：${leftover}`;
}

// FPBrowser2API 服务控制：便携版直接管理 fpbrowser2api.exe；源码版复用自带 ps1
function psRun(script, timeout = 30000) {
  const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return `${res.stdout || ""}\n${res.stderr || ""}`.trim();
}

function gatewayPids(exePath) {
  const p = exePath.replace(/'/g, "''");
  const out = psRun(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${p}' } | ForEach-Object { $_.ProcessId }`, 20000);
  return out.split(/\s+/).map((s) => Number(s)).filter(Boolean);
}

function fbStartService(installDir) {
  return fbServiceAction("start", installDir);
}

function fbServiceAction(action, installDir) {
  const exe = path.join(installDir, "fpbrowser2api.exe");
  if (existsSync(exe)) {
    const pids = gatewayPids(exe);
    if (action === "status") {
      return `portable: ${pids.length ? `running pid=${pids.join(",")}` : "stopped"}，端口 ${FB_PORT()}`;
    }
    if (action === "stop" || action === "restart") {
      if (pids.length) {
        psRun(pids.map((id) => `Stop-Process -Id ${id} -Force -ErrorAction SilentlyContinue`).join("; "), 20000);
      }
      if (action === "stop") return `portable: stopped ${pids.length} process(es)`;
      spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 800"], { windowsHide: true, timeout: 5000 });
    }
    if (action === "start" || action === "restart") {
      if (pids.length && action === "start") return `portable: already running pid=${pids.join(",")}`;
      const child = spawn(exe, [], {
        cwd: installDir,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, FPBROWSER2API_APP_ROOT: installDir, FPBROWSER_PORT: String(FB_PORT()) },
      });
      child.on("error", () => undefined);
      child.unref();
      return "portable: started fpbrowser2api.exe";
    }
    throw new Error(`不支持的服务操作：${action}`);
  }

  const ps1 = path.join(installDir, "fpbrowser2api_service.ps1");
  if (!existsSync(ps1)) throw new Error(`找不到 ${ps1} 或 fpbrowser2api.exe（网关未安装？先执行 setup）`);
  const venvPython = path.join(installDir, ".venv", "Scripts", "python.exe");
  if (!existsSync(venvPython)) throw new Error("找不到 .venv\\Scripts\\python.exe，请先执行 setup 完成安装");
  const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, action], {
    cwd: installDir,
    encoding: "utf8",
    timeout: 45000,
    windowsHide: true,
    env: { ...process.env, PYTHON_BIN: venvPython },
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  if (res.status !== 0) throw new Error(`服务操作 ${action} 失败：${output.slice(-1000) || `退出代码 ${res.status}`}`);
  return output;
}

/* ---------------- 残留进程清理（修复插件目录被占用 / EBUSY） ----------------
 * 典型场景：旧版本把网关装在插件目录内，升级/重装时宿主要删除插件目录，
 * 但仍在运行的 python 持有目录句柄 → EBUSY。这里按命令行特征清理残留进程。
 */

function killByCommandLineMatchers(matchers, { keepPids = [] } = {}) {
  const keep = new Set([String(process.pid), ...keepPids.map(String)]);
  const ps = [
    "$targets = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.Name -match '^(python|pythonw|node|fpbrowser2api|virtualbrowser_api|VirtualBrowser\\.Setup)') }",
    `$keep = @(${[...keep].map((p) => `'${p}'`).join(",")})`,
    "$killed = @()",
    "foreach ($p in $targets) {",
    `  if ($keep -contains [string]$p.ProcessId) { continue }`,
    `  $hit = ${matchers.map((m) => `($p.CommandLine -like '*${m.replace(/'/g, "''")}*')`).join(" -or ") || "$false"}`,
    "  if ($hit) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed += ($p.Name + '#' + $p.ProcessId) }",
    "}",
    "if ($killed.Count) { 'killed ' + ($killed -join ',') } else { 'no residue' }",
  ].join("; ");
  try {
    const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      encoding: "utf8", timeout: 40000, windowsHide: true,
    });
    return `${res.stdout || ""}${res.stderr || ""}`.trim();
  } catch (e) { return `skip: ${e.message}`; }
}

async function cleanup(input) {
  const steps = {};
  // 1. 先按服务脚本 + 端口占用者停网关
  try { steps.stopGateway = { ok: true, output: String(fbStopService(FB_HOME())).slice(-400) }; }
  catch (e) { steps.stopGateway = { ok: false, error: e.message }; }
  // 2. 清理引用插件目录/数据目录的残留进程（旧版网关、安装器、搭建助手、残留自动化进程）
  const matchers = [PLUGIN_DIR, DATA_DIR, "codex-market\\image-pool", "codex-market/image-pool"];
  steps.killResidue = { ok: true, output: killByCommandLineMatchers(matchers) };
  // VirtualBrowser 若以插件目录为 CWD 启动，会持有目录句柄（EBUSY 的常见真凶）：关闭后重开会自动落到数据目录
  try {
    const r = spawnSync("taskkill", ["/IM", "VirtualBrowser.exe", "/F"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    steps.killVirtualBrowser = { ok: r.status === 0 || /not found|没有找到/i.test(out), output: out.slice(-300), hint: "VirtualBrowser 已关闭；重新点「启动服务」或手动打开即可（指纹环境与登录态都在磁盘上，不会丢）" };
  } catch (e) {
    steps.killVirtualBrowser = { ok: false, error: e.message };
  }
  // 搭建助手常驻服务（8765）单独兜底：避免它以插件目录为 cwd 时锁住 vendor
  steps.killAssistant = { ok: true, output: killPortOwnersExtra([ASSISTANT_PORT()]) };
  // 3. 删除旧版本留在插件目录内的运行时数据（现在数据目录已在 AppData）
  const legacyData = path.join(PLUGIN_DIR, "data");
  if (existsSync(legacyData)) {
    try {
      rmSync(legacyData, { recursive: true, force: true });
      steps.removeLegacyData = { ok: true, path: legacyData };
    } catch (e) {
      steps.removeLegacyData = { ok: false, error: `仍被占用：${e.message}。请关闭 VirtualBrowser/命令行窗口后重试，或重启系统再安装` };
    }
  } else {
    steps.removeLegacyData = { ok: true, hint: "插件目录内无运行时数据（已分离到应用数据目录）" };
  }
  emit({
    state: "succeeded",
    steps,
    hint: "清理完成：现在可以重新安装/更新插件了。若仍报 EBUSY，请重启系统后再装（登录态与账号数据都在应用数据目录，不会丢）",
  });
}

/* ---------------- 一键安装（后台任务 + 状态文件实时落盘） ----------------
 * setup 改为 detached 后台进程执行，进度实时写入 data/setup-state.json；
 * 前端通过 setup-status 轮询渲染步骤清单与日志，不受命令宿主超时影响，可随时回来看进度。
 */

const SETUP_STATE_FILE = () => path.join(DATA_DIR, "setup-state.json");
const SETUP_STEPS = ["prerequisites", "allinone", "configure", "startFpb", "startVb", "bridgeExtension", "serviceCheck", "provision"];

function setupStateWrite(state) {
  state.heartbeat = Date.now(); // 心跳：每次状态写入都刷新，供 setup-status 判断进程是否意外死亡
  ensureDataDir();
  writeFileSync(SETUP_STATE_FILE(), JSON.stringify(state, null, 2), "utf8");
}

function setupStateInit(input) {
  const state = {
    status: "running", // running | completed | failed
    step: "",
    steps: {},
    log: [],
    next: [],
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
  };
  setupStateWrite(state);
  return state;
}

function setupStateLog(state, line) {
  state.log = state.log || [];
  state.log.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${line}`);
  state.log = state.log.slice(-300);
  setupStateWrite(state);
}

function setupStateStep(state, name, value) {
  state.steps = state.steps || {};
  state.steps[name] = value;
  state.step = name;
  setupStateWrite(state);
  setupStateLog(state, `${name}: ${value?.ok === false ? "未完成" : "完成"}${value?.hint ? `（${value.hint}）` : ""}`);
}

function setupStateFinish(state, status, error = "") {
  state.status = status;
  state.error = error;
  state.finishedAt = Date.now();
  setupStateWrite(state);
}

async function setupFlow(input, state) {
  let installDir = String(input?.install_dir || "").trim() || FB_HOME();
  const logFile = path.join(DATA_DIR, "setup.log");
  const total = SETUP_STEPS.length;
  const sourceDir = env("RUODAO_FB_HOME", "") || path.join(DATA_DIR, "fpbrowser2api");

  // 0. 清场：结束旧版本遗留在插件目录内运行/启动的进程（它们会让插件更新报 EBUSY）
  setupStateLog(state, `步骤 0/${total}：清理旧版残留进程（避免插件目录被占用）`);
  const residuePatterns = [
    `${PLUGIN_DIR}\\data`,
    `${PLUGIN_DIR}/data`,
    "codex-market\\image-pool\\data",
    "VirtualBrowser.Setup",
  ];
  const residue = killByCommandLineMatchers(residuePatterns);
  setupStateLog(state, `残留清理：${residue}`);

  // 1. 环境与安装包：优先二合一包（免 Git/Python），老环境才回退源码
  setupStateLog(state, `步骤 1/${total}：检查运行环境与二合一安装包`);
  let poolSetup = null;
  try { poolSetup = await locatePoolSetup(input, { state }); }
  catch (e) { setupStateLog(state, `定位/下载二合一安装包失败：${e.message}`); }
  const git = findGit();
  const python = findPython(installDir);
  let gateway = gatewayRunner(FB_HOME());
  let vbApi = locateVbApiExe();
  let vbClient = locateVbExe();
  const portableReady = Boolean(gateway && (vbApi || vbClient));
  const sourceReady = Boolean(git && python);
  const prerequisitesOk = portableReady || Boolean(poolSetup) || sourceReady;
  setupStateStep(state, "prerequisites", {
    ok: prerequisitesOk,
    git: git || undefined,
    python: python || undefined,
    bundle: poolSetup?.path,
    hint: portableReady ? "已安装便携版：免 Git / Python / API Key"
      : poolSetup ? "已找到二合一安装包：全程免 Git / Python"
      : sourceReady ? "未找到二合一安装包，回退源码安装（较慢，需要保持网络）"
      : "缺少二合一安装包，且未检测到 Git / Python",
  });
  if (!prerequisitesOk) {
    throw new Error(`未找到二合一安装包（${path.join(PLUGIN_DIR, "vendor", "allinone", POOL_SETUP_NAME)}）。请重新安装完整插件，或把安装包放到 ${DOWNLOADS_DIR()} 后重跑一键安装`);
  }

  // 2. 二合一安装：VirtualBrowser API 版 + FPBrowser2API 便携版一次装好
  setupStateLog(state, `步骤 2/${total}：安装/校验二合一包（VirtualBrowser API + FPBrowser2API 便携版）`);
  let mode = "source";
  if (portableReady) {
    mode = gateway.kind === "exe" ? "portable" : "source";
    setupStateStep(state, "allinone", {
      ok: true,
      installDir: FB_HOME(),
      mode,
      hint: gateway.kind === "exe" ? "便携版已安装：免 Git / Python" : "源码版已安装",
    });
  } else if (poolSetup) {
    setupStateLog(state, `安装包：${poolSetup.path}（${poolSetup.source}）`);
    const installed = await installPoolSilently(poolSetup.path, { state });
    gateway = gatewayRunner(FB_HOME());
    vbApi = locateVbApiExe();
    vbClient = locateVbExe();
    if (gateway && (vbApi || vbClient)) {
      mode = gateway.kind === "exe" ? "portable" : "source";
      setupStateStep(state, "allinone", {
        ok: true,
        installDir: FB_HOME(),
        mode,
        setupPackage: poolSetup.path,
        hint: "一键安装完成：免 Git / Python、免 API Key",
      });
    } else if (!gateway && sourceReady) {
      setupStateLog(state, "二合一安装包未生效，回退源码安装");
      installDir = await installGatewayFromSource({ installDir: sourceDir, git, python, logFile, state });
      mode = "source";
      setupStateStep(state, "allinone", { ok: true, installDir, mode, hint: "二合一安装未完成，已回退源码安装" });
    } else if (!gateway) {
      throw new Error(`二合一安装包未完成安装（未检测到 fpbrowser2api.exe），且缺少 Git / Python。请以管理员身份运行 ${poolSetup.path}，完成后重跑一键安装`);
    } else {
      throw new Error("便携网关已就绪，但未检测到 VirtualBrowser：请重新运行二合一安装包（会自动安装 VirtualBrowser API 版）后重跑一键安装");
    }
  } else {
    setupStateLog(state, "未找到二合一安装包：回退源码安装 FPBrowser2API");
    installDir = await installGatewayFromSource({ installDir: sourceDir, git, python, logFile, state });
    mode = "source";
    setupStateStep(state, "allinone", { ok: true, installDir, mode, hint: "已用源码方式安装（未使用二合一包）" });
  }
  // 统一最终安装目录：便携版在 ProgramData，源码版在应用数据目录
  if (mode === "portable") {
    const bundledHome = isGatewayHome(FB_BUNDLE_HOME()) ? FB_BUNDLE_HOME() : installDir;
    process.env.RUODAO_FB_HOME = bundledHome;
    installDir = bundledHome;
  } else {
    process.env.RUODAO_FB_HOME = installDir;
  }
  installDir = path.resolve(installDir);
  state.installDir = installDir;
  state.mode = mode;

  // 3. 配置：自动生成随机密钥，强制 8002 端口（用户无需填写任何 Key）
  setupStateLog(state, `步骤 3/${total}：生成安全密钥并写入网关配置（自动备份旧配置）`);
  const configDir = path.join(installDir, "config");
  try { mkdirSync(configDir, { recursive: true }); }
  catch (e) { throw new Error(`无法写入配置目录 ${configDir}：${e.message}。请用管理员身份重新运行二合一安装包后重试`); }
  const configPath = path.join(configDir, "setting.toml");
  const examplePath = path.join(configDir, "setting_example.toml");
  let text = existsSync(configPath) ? readFileSync(configPath, "utf8") : (existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "");
  if (!text.trim()) {
    text = [
      "[server]",
      'host = "127.0.0.1"',
      "port = 8002",
      "",
      "[global]",
      'admin_username = "admin"',
      'admin_password = "admin"',
      'api_key = "fpb123456"',
      "",
      "[extension_executor]",
      "enabled = true",
      'base_url = "127.0.0.1:8002"',
      "task_timeout_seconds = 1800",
      "",
    ].join("\n");
  }
  let backupPath;
  if (existsSync(configPath)) {
    backupPath = path.join(configDir, `setting.toml.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
    try { writeFileSync(backupPath, text, "utf8"); } catch { backupPath = undefined; }
  }
  const existing = parseToml(text);
  // 上游默认弱密钥 / 安装包出厂占位密钥 → 首次运行统一换成随机密钥
  const weakAdmin = !existing.global?.admin_password
    || ["admin", "123456"].includes(String(existing.global.admin_password))
    || existing.ruodao?.package_defaults === true;
  const weakApi = !existing.global?.api_key
    || /^(mirrmart|fpb123456)/i.test(String(existing.global.api_key))
    || existing.ruodao?.package_defaults === true;
  const apiKey = weakApi ? secret(43) : String(existing.global?.api_key);
  const values = [
    ["server", "host", "127.0.0.1"],
    ["server", "port", 8002],
    ["global", "admin_username", "admin"],
    ["global", "admin_password", weakAdmin ? secret(24) : String(existing.global?.admin_password)],
    ["global", "api_key", apiKey],
    ["system", "proxy_enabled", false],
    ["system", "debug_enabled", true],
    ["system", "log_to_file", true],
    ["extension_executor", "enabled", true],
    ["extension_executor", "base_url", "127.0.0.1:8002"],
    ["extension_executor", "bridge_token", String(existing.extension_executor?.bridge_token || secret(43))],
    ["extension_executor", "task_timeout_seconds", 1800],
    ["ruodao", "package_defaults", false],
    ["ruodao", "installed_by", "image-pool-setup"],
  ];
  for (const [sec, key, val] of values) text = upsertToml(text, sec, key, val);
  writeFileSync(configPath, text, "utf8");
  setupStateStep(state, "configure", {
    ok: true,
    configPath,
    backupPath: backupPath || undefined,
    apiKeyMasked: `${apiKey.slice(0, 6)}***`,
    hint: `端口 ${FB_PORT()}、密钥已自动生成（无需手动填写）`,
  });

  // 4. 启动网关：先清理旧端口占用，再按便携/源码方式启动
  setupStateLog(state, `步骤 4/${total}：启动号池网关 FPBrowser2API（:${FB_PORT()}）`);
  try {
    const stopped = fbStopService(installDir);
    await new Promise((r) => setTimeout(r, 800));
    const started = fbStartService(installDir);
    setupStateStep(state, "startFpb", {
      ok: true,
      output: `${stopped}；${started}`.slice(-500),
      hint: mode === "portable" ? "便携版网关已启动" : "源码版网关已启动",
    });
  } catch (e) {
    const runner = gatewayRunner(installDir);
    if (runner) {
      try {
        const child = spawn(runner.cmd, runner.args, {
          cwd: installDir,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, FPBROWSER2API_APP_ROOT: installDir, FPBROWSER_PORT: String(FB_PORT()) },
        });
        child.on("error", () => undefined);
        child.unref();
        setupStateStep(state, "startFpb", { ok: true, hint: "服务脚本失败，已直接拉起网关进程" });
      } catch (e2) {
        setupStateStep(state, "startFpb", { ok: false, hint: e2.message });
      }
    } else {
      setupStateStep(state, "startFpb", { ok: false, hint: e.message });
    }
  }

  // 5. 启动 VirtualBrowser API（自建 API 版免 VIP、免 api-key）
  setupStateLog(state, `步骤 5/${total}：启动 VirtualBrowser API 服务（:9000，免 API Key）`);
  const vbStarted = await ensureVb();
  setupStateStep(state, "startVb", vbStarted.ok
    ? {
      ok: true,
      base: vbStarted.base,
      started: vbStarted.started,
      exe: locateVbApiExe() || locateVbExe() || undefined,
      hint: vbStarted.started === "api" ? "API 版已自动启动" : "服务已就绪",
    }
    : { ok: false, hint: vbStarted.hint });

  // 6. 通信扩展：网关任务依赖它注入页面上下文，自动注册到 VirtualBrowser
  setupStateLog(state, `步骤 6/${total}：挂载通信扩展（对全部指纹窗口自动生效）`);
  if (vbStarted.ok) {
    try {
      const access = await resolveVbAccess();
      const ext = await ensureVbBridgeExtension({ base: access.base, key: access.key, installDir });
      setupStateStep(state, "bridgeExtension", {
        ok: ext.ok,
        ...ext,
        auth: access.auth,
        hint: ext.ok ? (ext.alreadyInstalled ? "通信扩展已存在" : "通信扩展已自动挂载") : ext.hint,
      });
    } catch (e) {
      setupStateStep(state, "bridgeExtension", { ok: false, hint: e.message });
    }
  } else {
    setupStateStep(state, "bridgeExtension", { ok: false, hint: "VirtualBrowser API 未就绪，暂无法挂载扩展" });
  }

  // 7. 服务检查（留出启动时间，失败再自动拉起一次）
  setupStateLog(state, `步骤 7/${total}：检查两端服务连通性`);
  await new Promise((r) => setTimeout(r, 1500));
  let fbUp = await fbReachable();
  if (!fbUp) fbUp = Boolean((await ensureFb()).ok);
  let vbUp = await vbReachable();
  if (!vbUp) vbUp = Boolean((await ensureVb()).ok);
  setupStateStep(state, "serviceCheck", {
    ok: fbUp && vbUp,
    fpb: fbUp,
    vb: vbUp,
    bases: { fpb: FB_BASE(), vb: VB_BASE() },
    hint: fbUp && vbUp ? "网关与 VirtualBrowser API 均已就绪" : "部分服务未就绪：可点「启动服务」重试，或重跑一键安装（已完成步骤自动跳过）",
  });

  // 8. 号池后台自动配置（自建 API 版无鉴权，用占位 key 填满网关必填字段）
  let provisionOk = false;
  if (fbUp && vbUp) {
    setupStateLog(state, `步骤 8/${total}：号池后台自动配置（项目/浏览器服务器/空间/窗口/gpt_workflow/绑定窗口）`);
    try {
      const steps = await provisionPool({});
      provisionOk = true;
      setupStateStep(state, "provision", { ok: true, waiting: steps.bindWindows?.waiting, detail: steps });
      if (steps.bindWindows?.waiting) setupStateLog(state, steps.bindWindows.waiting);
    } catch (e) {
      setupStateStep(state, "provision", { ok: false, hint: `自动配置失败：${e.message}` });
    }
  } else {
    setupStateStep(state, "provision", { ok: false, hint: "服务未就绪，已跳过后台配置；服务启动后可点「后台自动配置」" });
  }

  state.ready = fbUp && vbUp && provisionOk;
  if (state.ready) {
    state.next.push("打开「号池账号」页，粘贴发货文本（邮箱----密码----2FA密钥），点「一键入池并登录」");
    state.next.push("登录完成后即可生图：工作台「立即生图」或调用 /v1/videos；额度会在已登录账号间自动轮询");
  } else {
    state.next.push("点「启动服务」重试；或重跑一键安装（已完成的步骤会自动跳过）");
    if (!provisionOk && fbUp && vbUp) state.next.push("服务已就绪，点「后台自动配置」重试");
  }
}

async function setup(input) {
  // 后台模式（默认）：detached 子进程执行，立即返回任务句柄，前端轮询 setup-status
  if (String(input?.mode || "async") === "async") {
    ensureDataDir();
    const state = setupStateInit(input);
    setupStateLog(state, "一键安装任务已创建（后台执行，关闭界面不影响进度）");
    const cliPath = path.resolve(process.argv[1] || "");
    try {
      const child = spawn(process.execPath, [cliPath, "setup-run"], {
        cwd: DATA_DIR,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          RUODAO_SETUP_CONFIG: JSON.stringify(Object.fromEntries(Object.entries(input?.config || {}).filter(([k]) => /^RUODAO_/.test(k)))),
          RUODAO_SETUP_INPUT: JSON.stringify(input || {}),
        },
      });
      child.unref();
      emit({
        state: "succeeded",
        jobId: `setup-${state.startedAt}`,
        stateFile: SETUP_STATE_FILE(),
        hint: "安装任务已在后台启动，用 setup-status 轮询进度；即使关闭界面安装也会继续",
      });
    } catch (e) {
      setupStateFinish(state, "failed", e.message);
      fail(`安装任务启动失败：${e.message}`);
    }
    return;
  }
  // 同步模式（兼容命令行直跑）
  const state = setupStateInit(input);
  try {
    await setupFlow(input, state);
    setupStateFinish(state, "completed");
    emit({ state: "succeeded", ...state, stateFile: SETUP_STATE_FILE() });
  } catch (e) {
    setupStateFinish(state, "failed", e?.message || String(e));
    emit({ state: "failed", error: e?.message || String(e), ...state, stateFile: SETUP_STATE_FILE() });
    process.exit(1);
  }
}

async function setupRun() {
  // detached 子进程入口：应用 UI 传入的配置 → 执行安装 → 状态落盘
  try {
    const cfg = JSON.parse(env("RUODAO_SETUP_CONFIG", "{}"));
    for (const [k, v] of Object.entries(cfg)) {
      if (/^RUODAO_[A-Z0-9_]+$/.test(k) && v != null && String(v).trim()) process.env[k] = String(v).trim();
    }
    const input = JSON.parse(env("RUODAO_SETUP_INPUT", "{}"));
    const state = JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8"));
    await setupFlow(input, state);
    setupStateFinish(state, "completed");
  } catch (e) {
    try {
      const state = existsSync(SETUP_STATE_FILE()) ? JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8")) : setupStateInit({});
      setupStateFinish(state, "failed", e?.message || String(e));
    } catch { /* 状态文件不可写时忽略 */ }
    process.exit(1);
  }
}

async function setupStatus() {
  let state = null;
  try { state = JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8")); } catch { state = null; }
  if (!state) {
    emit({ state: "succeeded", status: "idle", hint: "尚无安装任务，点「一键安装」开始" });
    return;
  }
  // 僵尸任务检测：running 但心跳超过 2 分钟（后台进程被意外杀死）→ 标记失败可续跑
  if (state.status === "running" && Date.now() - (state.heartbeat || state.startedAt) > 120000) {
    setupStateFinish(state, "failed", "安装进程意外中断（宿主环境终止了后台任务）。已完成的步骤会保留，直接重跑一键安装即可从断点续装");
    setupStateLog(state, "检测到安装进程意外中断（心跳超时），任务标记为失败；重跑一键安装将从已完成步骤续装");
  }
  emit({ state: "succeeded", ...state, stateFile: SETUP_STATE_FILE(), elapsedMs: (state.finishedAt || Date.now()) - state.startedAt });
}

/* ---------------- 一键修复：直驱组件缺失时自动补装（后台任务 + 实时进度） ---------------- */

const REPAIR_STEPS = ["diagnose", "playwright", "verify"];

async function repairFlow(input, state) {
  const total = REPAIR_STEPS.length;
  const logFile = path.join(DATA_DIR, "repair.log");

  // 1. 诊断：逐项定位直驱链路缺什么
  setupStateLog(state, `步骤 1/${total}：诊断直驱组件`);
  const vbKernel = locateVbKernelExe();
  const missing = { playwright: !directModuleSync(), vbKernel: !vbKernel };
  setupStateStep(state, "diagnose", {
    ok: missing.playwright || missing.vbKernel ? undefined : true,
    missing: Object.keys(missing).filter((k) => missing[k]),
    vbKernel: vbKernel || undefined,
    hint: missing.playwright ? "缺内置 playwright-core" : missing.vbKernel ? "缺 VirtualBrowser 内核" : "未发现缺失",
  });
  if (missing.vbKernel && !missing.playwright) {
    throw new Error(`VirtualBrowser 内核未找到（已装客户端但缺内核目录）。请重跑「一键安装」或在设置里填 RUODAO_VB_EXE 指向 <内核版本>\\VirtualBrowser.exe`);
  }
  if (!missing.playwright && !missing.vbKernel) {
    setupStateLog(state, "组件齐全，无需修复（可能是之前修复成功后再次自检）");
    return;
  }

  // 2. 补装 playwright-core：优先 npmmirror 镜像，失败回退官方源
  setupStateLog(state, `步骤 2/${total}：下载 playwright-core（npmmirror 镜像 → 官方源回退）`);
  const dest = path.join(PLUGIN_DIR, "vendor", "playwright-core");
  const version = PLAYWRIGHT_CORE_VERSION;
  const tarName = `playwright-core-${version}.tgz`;
  const urls = [
    `https://registry.npmmirror.com/playwright-core/-/${tarName}`,
    `https://registry.npmjs.org/playwright-core/-/${tarName}`,
  ];
  const tgz = path.join(DATA_DIR, tarName);
  let downloaded = "";
  let lastErr = "";
  for (const url of urls) {
    try {
      setupStateLog(state, `下载 ${url}`);
      await downloadToFile(url, tgz, { timeoutMs: 600000, state, minSize: 1024 * 1024 });
      downloaded = url;
      break;
    } catch (e) {
      lastErr = e.message;
      setupStateLog(state, `下载失败：${e.message}`);
    }
  }
  if (!downloaded) throw new Error(`playwright-core 下载失败（镜像与官方源均不可达）：${lastErr}`);
  setupStateLog(state, `解压到 ${dest}`);
  await rm(dest, { recursive: true, force: true });
  await extractTarTgz(tgz, dest);
  setupStateStep(state, "playwright", { ok: true, version, source: downloaded });

  // 3. 验证：加载模块确认可用
  setupStateLog(state, `步骤 3/${total}：验证 playwright-core 可加载`);
  const direct = await directModule();
  if (!direct.hasPlaywright()) throw new Error("playwright-core 已解压但加载失败，请查看 repair.log");
  setupStateStep(state, "verify", { ok: true, hint: "直驱组件已就绪" });
  state.next = ["回到状态页点「重新自检」，直驱模式应变绿；若 VirtualBrowser 未装先跑「一键安装」"];
}

// 探测 vendor/playwright-core 是否可用（诊断用，避免拉起完整 direct 模块）
function directModuleSync() {
  try {
    createRequire(import.meta.url)(path.join(PLUGIN_DIR, "vendor", "playwright-core", "package.json"));
    return true;
  } catch { return false; }
}

// 解压 npm tgz（gzip tar：package/ 前缀 → 目标目录）。系统 tar 失败时用纯 Node ustar 解析兜底
async function extractTarTgz(tgzPath, dest) {
  await mkdir(dest, { recursive: true });
  // Windows 10+ 自带 tar，可直接解 tgz
  try {
    execFileSync("tar", ["-xzf", tgzPath, "-C", dest, "--strip-components=1"], { windowsHide: true, timeout: 120000 });
    return;
  } catch { /* 继续用纯 Node 回退 */ }
  const { gunzipSync } = await import("node:zlib");
  const raw = gunzipSync(readFileSync(tgzPath));
  // 最简 ustar 解析：512 字节头，name 前缀拼接
  let off = 0;
  while (off + 512 <= raw.length) {
    const name = raw.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    const sizeStr = raw.toString("utf8", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr || "0", 8) || 0;
    const typeflag = raw.toString("utf8", off + 156, off + 157);
    const prefix = raw.toString("utf8", off + 345, off + 500).replace(/\0.*$/, "");
    if (!name) break;
    const rel = `${prefix ? prefix + "/" : ""}${name}`.replace(/^package\//, "");
    const dataStart = off + 512;
    if (rel && (typeflag === "0" || typeflag === "")) {
      const target = path.join(dest, rel);
      if (!target.startsWith(path.resolve(dest) + path.sep) && path.resolve(target) !== path.resolve(dest, rel)) throw new Error("tar 路径越界");
      if (target.startsWith(dest)) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, raw.subarray(dataStart, dataStart + size));
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

async function repair(input) {
  if (String(input?.mode || "async") === "async") {
    ensureDataDir();
    const state = setupStateInit(input);
    state.kind = "repair";
    state.steps = {};
    state.log = [];
    setupStateLog(state, "一键修复任务已创建（后台执行，关闭界面不影响进度）");
    const cliPath = path.resolve(process.argv[1] || "");
    try {
      const child = spawn(process.execPath, [cliPath, "repair-run"], {
        cwd: DATA_DIR,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          RUODAO_SETUP_INPUT: JSON.stringify(input || {}),
        },
      });
      child.unref();
      emit({ state: "succeeded", jobId: `repair-${state.startedAt}`, stateFile: SETUP_STATE_FILE(), hint: "修复任务已在后台启动，用 setup-status 轮询进度" });
    } catch (e) {
      setupStateFinish(state, "failed", e.message);
      fail(`修复任务启动失败：${e.message}`);
    }
    return;
  }
  const state = setupStateInit(input);
  try {
    await repairFlow(input, state);
    setupStateFinish(state, "completed");
    emit({ state: "succeeded", ...state, stateFile: SETUP_STATE_FILE() });
  } catch (e) {
    setupStateFinish(state, "failed", e?.message || String(e));
    emit({ state: "failed", error: e?.message || String(e), ...state, stateFile: SETUP_STATE_FILE() });
    process.exit(1);
  }
}

async function repairRun() {
  try {
    const input = JSON.parse(env("RUODAO_SETUP_INPUT", "{}"));
    const state = JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8"));
    await repairFlow(input, state);
    setupStateFinish(state, "completed");
  } catch (e) {
    try {
      const state = existsSync(SETUP_STATE_FILE()) ? JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8")) : setupStateInit({});
      setupStateFinish(state, "failed", e?.message || String(e));
    } catch { /* 状态文件不可写时忽略 */ }
    process.exit(1);
  }
}

async function repairStatus() {
  let state = null;
  try { state = JSON.parse(readFileSync(SETUP_STATE_FILE(), "utf8")); } catch { state = null; }
  if (!state) { emit({ state: "succeeded", status: "idle", hint: "尚无修复任务" }); return; }
  if (state.status === "running" && Date.now() - (state.heartbeat || state.startedAt) > 120000) {
    setupStateFinish(state, "failed", "修复进程意外中断（心跳超时）。直接重跑「一键修复」即可，已下载的包会复用");
  }
  emit({ state: "succeeded", ...state, stateFile: SETUP_STATE_FILE(), elapsedMs: (state.finishedAt || Date.now()) - state.startedAt });
}

async function service(input) {
  const action = String(input?.action || "status").toLowerCase();
  const target = String(input?.target || "both").toLowerCase();
  if (!["start", "stop", "restart", "status"].includes(action)) fail(`不支持的操作：${action}（支持 start / stop / restart / status）`);
  if (!["fpb", "vb", "both"].includes(target)) fail(`不支持的目标：${target}（支持 fpb / vb / both）`);
  const result = { state: "succeeded", action, target, fpb: {}, vb: {} };
  const installDir = FB_HOME();

  if (target !== "vb" && action !== "status") {
    try {
      const output = action === "start" ? fbStartService(installDir)
        : action === "stop" ? fbStopService(installDir)
        : fbServiceAction(action, installDir);
      result.fpb[action] = { ok: true, output: String(output).slice(-800) };
    } catch (e) { result.fpb[action] = { ok: false, error: e.message }; }
  }
  if (target !== "fpb" && action !== "status") {
    if (action === "stop") {
      const outputs = [];
      let ok = false;
      for (const name of ["virtualbrowser_api.exe", "VirtualBrowser.exe"]) {
        const res = spawnSync("taskkill", ["/IM", name, "/F"], { encoding: "utf8", windowsHide: true });
        const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
        outputs.push(`${name}: ${out || `退出代码 ${res.status}`}`);
        if (res.status === 0) ok = true;
      }
      result.vb.stop = {
        ok,
        output: outputs.join("\n").slice(-600),
        hint: "已关闭 API 服务与浏览器进程；登录态保存在指纹环境中，重新启动即可恢复",
      };
    } else {
      const started = await ensureVb();
      result.vb[action] = started.ok
        ? { ok: true, base: started.base, started: started.started, exe: locateVbApiExe() || locateVbExe() || "" }
        : { ok: false, error: started.hint || "VirtualBrowser 启动失败" };
    }
  }

  // 状态探测
  if (target !== "vb") result.fpb.status = { up: await fbReachable(), base: FB_BASE(), installDir: isGatewayHome(installDir) ? installDir : "" };
  if (target !== "fpb") {
    result.vb.status = { up: await vbReachable(), base: VB_BASE(), apiExe: locateVbApiExe() || "", clientExe: locateVbExe() || "" };
  }
  result.up = (target !== "vb" ? result.fpb.status.up : true) && (target !== "fpb" ? result.vb.status.up : true);
  if (!result.up && action === "status") result.hint = "有服务未运行：用 service start 拉起，或重跑 setup";
  emit(result);
}

async function assistant() {
  const dir = path.join(PLUGIN_DIR, "vendor", "assistant");
  const app = path.join(dir, "app.py");
  if (!existsSync(app)) fail(`未找到内置搭建助手（${app}），插件安装可能不完整`);
  const python = findPython();
  if (!python) fail("未找到 Python 3.11+，无法启动搭建助手；请安装 Python 并勾选 Add to PATH");
  // 测试/无头场景开关：NO_OPEN 不弹浏览器，NO_LAUNCH 只探测不拉起常驻服务
  const flag = (name) => /^(1|true|yes|on)$/i.test(String(env(name, "")).trim());
  const noOpen = flag("RUODAO_ASSISTANT_NO_OPEN");
  const noLaunch = flag("RUODAO_ASSISTANT_NO_LAUNCH");
  const base = `http://127.0.0.1:${ASSISTANT_PORT()}`;
  let alive = false;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    alive = Boolean(res);
  } catch { alive = false; }
  let launched = false;
  if (!alive && !noLaunch) {
    launched = true;
    // 关键：工作目录必须放在应用数据目录，不能是插件目录（否则常驻进程会锁住插件目录导致更新 EBUSY）
    ensureDataDir();
    const workDir = path.join(DATA_DIR, "assistant-work");
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
    spawn(python, [app, "--port", String(ASSISTANT_PORT())], { cwd: workDir, detached: true, windowsHide: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 20 && !alive; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try { const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); alive = Boolean(res); } catch { /* 重试 */ }
    }
  }
  const opened = !noOpen && (alive || launched);
  if (opened) {
    try { spawn("cmd", ["/c", "start", "", base], { detached: true, windowsHide: true, stdio: "ignore" }).unref(); } catch { /* 打开浏览器失败不致命 */ }
  }
  emit({
    state: "succeeded",
    url: base,
    alreadyRunning: alive,
    launched,
    opened,
    hint: opened
      ? "搭建助手已在浏览器打开：环境检测 → 安装 FPBrowser2API → 生成密钥写配置 → VirtualBrowser API 测试 → 服务启停 → 任务提交/查询，全图形化维护"
      : "未打开浏览器（NO_OPEN/NO_LAUNCH 生效）：可手动访问该 url",
  });
}

/* ---------------- 直驱模式（内嵌 Playwright，免 FPBrowser2API） ---------------- */

async function directModule() {
  return import("./direct.mjs");
}

async function bind(input) {
  const direct = await directModule();
  const text = input.text ?? input.content ?? input.accounts ?? "";
  try {
    // API 没起来时 bind 会逐个拉起窗口探测环境（很慢且闪屏）：先确保 :9000 就绪
    try {
      const vb = await ensureVb();
      emit({ state: "progress", step: vb.ok ? `VirtualBrowser API 就绪（${vb.base}）` : (vb.hint || "VirtualBrowser API 未就绪，尝试使用已有环境") });
    } catch { /* bind 内部还有探测回退 */ }
    const result = await direct.bindLoginAccounts(text, {
      onProgress: (p) => emit({ state: "progress", ...p }),
    });
    // 新窗口创建后自动补做网关侧配置：通信扩展 + 窗口同步 + gpt_workflow 绑定
    let gateway = { ok: false, hint: "网关未安装/未运行，已跳过（直驱模式不受影响）" };
    try {
      const started = await ensureFb();
      if (started.ok) gateway = { ok: true, steps: await provisionPool({}) };
      else gateway.hint = started.hint || gateway.hint;
    } catch (e) {
      gateway = { ok: false, hint: `账号已登录，但网关自动绑定失败：${e.message}` };
    }
    emit({
      state: "succeeded",
      action: "bind",
      ...result,
      gateway,
      hint: result.failed.length
        ? "部分账号未自动登录成功（多为触发人机验证）：在对应 worker 窗口手动完成登录后，该窗口登录态同样会被保活"
        : gateway.ok
          ? "全部账号已自动登录，号池后台与通信扩展已自动绑定，可直接生图"
          : "全部账号已自动登录，登录态永久保存在指纹窗口中，可直接生图",
    });
  } catch (e) {
    fail(e?.message || String(e));
  }
}

async function workersList() {
  const direct = await directModule();
  const state = ledger.readWorkersState();
  const health = await imageApiHealth().catch(() => null);
  const warmById = new Map((health?.pool?.warm || []).map((w) => [w.workerId, w]));
  const usageToday = ledger.aggregateUsage(ledger.readLedger(), { days: 1, workers: state.workers }).quota.accounts;
  const todayById = new Map(usageToday.map((a) => [a.workerId, a]));
  emit({
    state: "succeeded",
    total: state.workers.length,
    loggedIn: state.workers.filter((w) => w.loggedIn).length,
    playwright: direct.hasPlaywright(),
    daemon: Boolean(health),
    concurrency: health?.pool?.concurrency ?? null,
    warmSessions: health?.pool?.warm?.length ?? 0,
    workers: state.workers.map((w) => {
      const warm = warmById.get(w.workerId);
      const today = todayById.get(w.workerId);
      return {
        workerId: w.workerId,
        email: maskAccount(w.email),
        loggedIn: w.loggedIn,
        generated: w.usageCount || 0,
        warm: Boolean(warm),
        busy: Boolean(warm?.busy),
        todayTotal: today?.todayTotal || 0,
        limited: Boolean(today?.limited),
        availableInMs: today?.availableInMs || 0,
        lastError: today?.lastError || "",
      };
    }),
    hint: "bind 批量自动登录；守护进程在线时窗口常驻复用，多账号按并发数同时执行",
  });
}

async function stealth(input) {
  const direct = await directModule();
  try {
    const result = await direct.stealthCheck({ workerId: input.workerId });
    emit({
      state: "succeeded",
      ...result,
      verdict: result.passed ? "伪装生效：navigator.webdriver 已抹平，基础反机器人检测可通过" : "存在自动化痕迹：请把截图发给开发者排查，或改用网关路径（扩展动态注入，抗检测更强）",
      hint: "完整检测矩阵见截图（bot.sannysoft.com 全项结果）；绿色越多越安全",
    });
  } catch (e) {
    fail(e?.message || String(e));
  }
}

/* ---------------- 号池后台自动配置（provision） ----------------
 * 利用 FPBrowser2API admin API 把传统手动步骤全部自动化：
 * 登录后台 → 建项目 → 建浏览器服务器(vendor=virtualbrowser) → 建空间(default) →
 * 同步窗口 → 创建 gpt_workflow 任务类型 → 绑定全部窗口。
 * 幂等：已存在的同名资源直接复用，可重复执行。
 */

async function adminApi(pathname, { method = "GET", body, token, timeoutMs = 30000 } = {}) {
  let res;
  try {
    res = await fetch(`${FB_BASE()}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`无法连接 FPBrowser2API 后台（${FB_BASE()}）：${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`后台接口 ${pathname} 返回非 JSON（HTTP ${res.status}）`); }
  if (res.status >= 400) throw new Error(`后台接口 ${pathname} HTTP ${res.status}：${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function vbApiRequest(base, pathname, { method = "GET", body, key = "", timeoutMs = 30000 } = {}) {
  let res;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(key ? { "api-key": key } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`VirtualBrowser API 连接失败（${base}）：${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (res.status >= 400) throw new Error(`VirtualBrowser API ${pathname} HTTP ${res.status}：${text.slice(0, 200)}`);
  if (data && data.success === false) throw new Error(`VirtualBrowser API ${pathname} 失败：${data.error || data.msg || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// 自建 API 版无鉴权（vbDiscover 用空 key 能成功）；官方 API 才需要用户填 Key
async function resolveVbAccess() {
  const direct = await directModule();
  const found = await direct.vbDiscover();
  if (found.ok) {
    return { base: found.base, key: VB_KEY() || LOCAL_VB_KEY, auth: VB_KEY() ? "api-key" : "none" };
  }
  if (VB_KEY() && found.base) {
    const probe = await vbApiRequest(found.base, "/api/getBrowserList", { method: "POST", body: { page: 0, pageSize: 1 }, key: VB_KEY() });
    if (probe?.success !== false) return { base: found.base, key: VB_KEY(), auth: "api-key" };
  }
  throw new Error(found.error || "VirtualBrowser API 不可达：请先执行一键安装");
}

// 把 FPBrowser2API 的通信扩展注册进 VirtualBrowser（--load-extension 对所有 worker 生效）
async function ensureVbBridgeExtension({ base, key, installDir }) {
  const extDir = path.join(installDir, "browser_extension");
  if (!existsSync(extDir)) return { ok: false, hint: `便携包缺少通信扩展：${extDir}（请重装二合一安装包）` };
  const listed = await vbApiRequest(base, "/api/getCrxList", { key });
  const exts = Array.isArray(listed?.data) ? listed.data : (Array.isArray(listed) ? listed : []);
  const norm = (p) => path.resolve(String(p || "")).toLowerCase();
  const existed = exts.find((e) => norm(e.path) === norm(extDir));
  if (!existed) {
    await vbApiRequest(base, "/api/addCrx", { method: "POST", key, body: { path: extDir, name: "FPBrowser2API Bridge", enabled: true } });
  } else if (existed.enabled === false) {
    await vbApiRequest(base, "/api/addCrx", { method: "POST", key, body: { id: existed.id, path: extDir, name: existed.name || "FPBrowser2API Bridge", enabled: true } });
  }
  return { ok: true, path: extDir, alreadyInstalled: Boolean(existed) };
}

// 把自动同步后的密码/API Key 写回 setting.toml，保证插件后续请求使用同一套凭据
function updateGatewaySetting({ adminPassword, apiKey } = {}) {
  const file = path.join(FB_HOME(), "config", "setting.toml");
  if (!existsSync(file)) return;
  let text = readFileSync(file, "utf8");
  if (adminPassword) text = upsertToml(text, "global", "admin_password", adminPassword);
  if (apiKey) text = upsertToml(text, "global", "api_key", apiKey);
  writeFileSync(file, text, "utf8");
}

async function provisionPool({ vbKey, vbBase } = {}) {
  if (!(await fbReachable())) throw new Error(`FPBrowser2API 未运行（${FB_BASE()}）：先执行 setup 或 service start`);
  const vb = await ensureVb();
  if (!vb.ok) throw new Error(vb.hint || "VirtualBrowser API 不可达");

  const access = vbKey
    ? { base: (vbBase || VB_BASE()).replace(/\/+$/, ""), key: vbKey, auth: "api-key" }
    : await resolveVbAccess();

  const tomlCfg = fbToml().cfg;
  const adminUser = String(tomlCfg.global?.admin_username || "admin");
  const adminPwdCfg = String(tomlCfg.global?.admin_password || "admin");
  const adminPwdWeak = !adminPwdCfg || ["admin", "123456"].includes(adminPwdCfg) || /mirrmart/i.test(adminPwdCfg);
  const adminPwdTarget = adminPwdWeak ? secret(24) : adminPwdCfg;
  const steps = {};

  // 1. 登录后台：数据库可能还是初始弱密码（升级场景），逐个尝试后自动同步成配置里的强密码
  let token = "";
  let usedPwd = "";
  const candidates = [...new Set([adminPwdTarget, adminPwdCfg, "admin", "123456", "mirrmart"])];
  for (const pwd of candidates) {
    const attempt = await adminApi("/api/admin/login", { method: "POST", body: { username: adminUser, password: pwd } }).catch(() => null);
    const t = attempt?.token || attempt?.data?.token || attempt?.access_token;
    if (t) { token = t; usedPwd = pwd; break; }
  }
  if (!token) throw new Error("后台登录失败：配置密码、默认密码均无效。请重装二合一安装包，或删除网关 data/fpbrowser.db 后重跑一键安装（会重建号池配置，不影响浏览器登录态）");
  if (usedPwd !== adminPwdTarget) {
    await adminApi("/api/admin/change-password", { method: "POST", token, body: { old_password: usedPwd, new_password: adminPwdTarget } });
    const relogin = await adminApi("/api/admin/login", { method: "POST", body: { username: adminUser, password: adminPwdTarget } });
    token = relogin?.token || relogin?.data?.token || "";
    if (!token) throw new Error("管理员密码已同步，但重新登录失败");
    steps.login = { ok: true, user: adminUser, passwordSynced: true };
  } else {
    steps.login = { ok: true, user: adminUser };
  }

  // 1.1 同步 API Key：数据库初始化后改过 setting.toml 时，/v1 请求会因旧 key 失败
  const apiKeyCfg = FB_KEY();
  const apiKeyWeak = !apiKeyCfg || /^(fpb123456|mirrmart)/i.test(apiKeyCfg);
  const apiKeyTarget = apiKeyWeak ? secret(43) : apiKeyCfg;
  try {
    const sys = await adminApi("/api/admin/system-config", { token });
    const dbKey = String(sys?.config?.api_key || "");
    if (dbKey !== apiKeyTarget) {
      await adminApi("/api/admin/api-key", { method: "POST", token, body: { api_key: apiKeyTarget } });
      steps.apiKey = { ok: true, synced: true };
    } else {
      steps.apiKey = { ok: true };
    }
  } catch (e) {
    steps.apiKey = { ok: false, hint: `同步 API Key 失败：${e.message}` };
  }
  if (adminPwdTarget !== adminPwdCfg || apiKeyTarget !== apiKeyCfg) {
    try {
      updateGatewaySetting({
        adminPassword: adminPwdTarget !== adminPwdCfg ? adminPwdTarget : "",
        apiKey: apiKeyTarget !== apiKeyCfg ? apiKeyTarget : "",
      });
    } catch (e) {
      steps.apiKey.hint = `${steps.apiKey.hint || ""}；写回配置失败：${e.message}`.replace(/^；/, "");
    }
  }
  steps.vbApi = { ok: true, base: access.base, auth: access.auth };

  // 2. 通信扩展（网关任务依赖它注入页面上下文）
  steps.bridgeExtension = await ensureVbBridgeExtension({ base: access.base, key: access.key, installDir: FB_HOME() });

  // 2. 项目（复用同名）
  let projects = (await adminApi("/api/admin/projects", { token })).projects || [];
  let project = projects.find((p) => p.name === "ruodao-image-pool");
  if (!project) {
    project = await adminApi("/api/admin/projects", { method: "POST", token, body: { name: "ruodao-image-pool" } });
    project = { id: project.project_id ?? project.id };
  }
  steps.project = { ok: true, id: project.id };

  // 3. 浏览器服务器（vendor=virtualbrowser）；lan_addr 必须是完整 URL（网关按原样请求）
  let browsers = (await adminApi(`/api/admin/projects/${project.id}/browsers`, { token })).browsers || [];
  let browser = browsers.find((b) => b.name === "virtualbrowser");
  const lanAddr = access.base.replace(/\/+$/, "");
  if (!browser) {
    browser = await adminApi("/api/admin/browsers", {
      method: "POST", token,
      body: { project_id: project.id, name: "virtualbrowser", lan_addr: lanAddr, vendor: "virtualbrowser", access_key: access.key },
    });
    browser = { id: browser.browser_id ?? browser.id };
  } else if (String(browser.lan_addr || "") !== lanAddr || String(browser.vendor || "") !== "virtualbrowser" || String(browser.access_key || "") !== String(access.key || "")) {
    // 旧版本可能写入过 127.0.0.1:9000（缺协议）或旧 key：自动纠正
    await adminApi(`/api/admin/browsers/${browser.id}`, {
      method: "PUT", token,
      body: {
        name: browser.name || "virtualbrowser",
        lan_addr: lanAddr,
        vendor: "virtualbrowser",
        access_key: access.key,
        browser_pool_limit: Number(browser.browser_pool_limit) || 0,
      },
    });
    steps.browserUpdated = { ok: true, from: browser.lan_addr || "", to: lanAddr };
  }
  steps.browser = { ok: true, id: browser.id, lanAddr };

  // 4. 空间（space_id=default 同步全部窗口；列表项字段是 id，新建返回 space_pk）
  const spaces = (await adminApi(`/api/admin/browsers/${browser.id}/spaces`, { token })).spaces || [];
  let space = spaces.find((s) => s.space_id === "default");
  if (!space) {
    const created = await adminApi("/api/admin/spaces", {
      method: "POST", token,
      body: { browser_id: browser.id, name: "default", space_id: "default" },
    });
    space = { id: created.space_pk ?? created.id ?? created.space_id };
  }
  const spacePk = space.space_pk ?? space.id;
  if (!spacePk) throw new Error(`空间已创建但缺少主键：${JSON.stringify(space).slice(0, 200)}`);
  steps.space = { ok: true, pk: spacePk };

  // 5. 同步窗口
  await adminApi(`/api/admin/spaces/${spacePk}/sync-windows`, { method: "POST", token, timeoutMs: 120000 });
  const windows = (await adminApi(`/api/admin/spaces/${spacePk}/windows`, { token })).windows || [];
  steps.syncWindows = { ok: true, count: windows.length };

  // 6. 任务类型 gpt_workflow
  let taskTypes = (await adminApi("/api/admin/task-types", { token })).task_types || [];
  let taskType = taskTypes.find((t) => t.code === "gpt_workflow");
  if (!taskType) {
    taskType = await adminApi("/api/admin/task-types", {
      method: "POST", token,
      body: { name: "ChatGPT 生图", code: "gpt_workflow", project_id: project.id, concurrency: 2, create_task_handler: "gpt_workflow", timeout_seconds: 1800 },
    });
    taskType = { id: taskType.task_type_id ?? taskType.id };
  }
  steps.taskType = { ok: true, id: taskType.id, code: "gpt_workflow" };

  if (!windows.length) {
    steps.bindWindows = { ok: true, waiting: "暂无指纹窗口：账号入池后会自动绑定" };
    return steps;
  }

  // 7. 绑定全部窗口（已有绑定则跳过）
  const bound = (await adminApi(`/api/admin/task-types/${taskType.id}/windows`, { token })).windows || [];
  if (!bound.length) {
    const pks = windows.map((w) => w.pk ?? w.id).filter(Boolean);
    await adminApi(`/api/admin/task-types/${taskType.id}/windows`, { method: "POST", token, body: { window_pks: pks } });
    steps.bindWindows = { ok: true, bound: pks.length };
  } else {
    steps.bindWindows = { ok: true, alreadyBound: bound.length };
  }

  return steps;
}

async function provision(input) {
  try {
    const steps = await provisionPool({ vbKey: input?.vbKey, vbBase: input?.vbBase });
    emit({
      state: "succeeded",
      steps,
      hint: steps.bindWindows?.waiting
        ? "号池环境已就绪，通信扩展已挂载；导入账号并自动登录后会自动完成窗口绑定"
        : "号池后台已全自动配置完成：通信扩展、窗口池、gpt_workflow 任务类型与绑定全部就绪",
    });
  } catch (e) {
    fail(e?.message || String(e));
  }
}

/* ---------------- main ---------------- */

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    // 终端直跑（无管道输入）时 stdin 不会关闭，2 秒无数据即按空输入处理
    const timer = setTimeout(() => { process.stdin.destroy(); done(parseStdin(data)); }, 2000);
    if (process.stdin.isTTY) { clearTimeout(timer); return done({}); }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => { clearTimeout(timer); done(parseStdin(data)); });
    process.stdin.on("error", () => { clearTimeout(timer); done({}); });
    process.stdin.on("close", () => { clearTimeout(timer); done(parseStdin(data)); });
  });
}

function parseStdin(data) {
  try { return data.trim() ? JSON.parse(data) : { text: data.trim() }; }
  catch { return { text: data.trim() }; }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  process.exit(1);
}

const stdin = await readStdin();
// 工作台 UI 会把用户保存的配置通过 stdin JSON 的 config 字段传进来，覆盖同名环境变量。
if (stdin.config && typeof stdin.config === "object") {
  for (const [key, value] of Object.entries(stdin.config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) process.env[key] = String(value).trim();
  }
}
const mode = process.argv[2] ?? "";
try {
  if (mode === "doctor") await doctor();
  else if (mode === "models") await models();
  else if (mode === "agent-access") await agentAccess();
  else if (mode === "generate") await generate(stdin);
  else if (mode === "task") await task(stdin);
  else if (mode === "usage") await usage(stdin);
  else if (mode === "chat") fail("对话模型已下线：号池仅支持生图，请用 generate 模式");
  else if (mode === "logs") await logs(stdin);
  else if (mode === "images") await images(stdin);
  else if (mode === "daemon") await daemonCommand(stdin);
  else if (mode === "warmup") await warmup(stdin);
  else if (mode === "setup") await setup(stdin);
  else if (mode === "setup-run") await setupRun();
  else if (mode === "setup-status") await setupStatus();
  else if (mode === "repair") await repair(stdin);
  else if (mode === "repair-run") await repairRun();
  else if (mode === "repair-status") await repairStatus();
  else if (mode === "cleanup") await cleanup(stdin);
  else if (mode === "provision") await provision(stdin);
  else if (mode === "service") await service(stdin);
  else if (mode === "assistant") await assistant();
  else if (mode === "bind") await bind(stdin);
  else if (mode === "workers") await workersList();
  else if (mode === "stealth") await stealth(stdin);
  else if (mode === "accounts") {
    const action = stdin.action || stdin.subcommand || "list";
    if (action === "import") await accountsImport(stdin);
    else if (action === "list") await accountsList();
    else fail(`未知 accounts 子命令：${action}（支持 import / list）`);
  }
  else fail(`未知模式：${mode}（支持 doctor / generate / bind / workers / stealth / usage / logs / images / daemon / warmup / accounts / models / task / setup / setup-status / cleanup / provision / service / assistant）`);
} catch (e) {
  fail(e?.message || String(e));
}
