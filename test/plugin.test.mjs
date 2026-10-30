import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_DIR, "bin", "image-pool.mjs");

function run(mode, stdin = "", extraEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-test-"));
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, RUODAO_IMAGE_POOL_DATA_DIR: dataDir, ...extraEnv },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test("未知模式返回失败 JSON", () => {
  const { code, out } = run("nope");
  assert.equal(code, 1);
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "failed");
  assert.match(body.error, /未知模式/);
});

test("accounts import 解析发货文本并去重落盘", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-test-"));
  const text = [
    "user1@example.com----pwd1----JBSWY3DPEHPK3PXP",
    "not-an-account-line",
    "user2@example.com----pwd2----",
    "user1@example.com----pwd1----JBSWY3DPEHPK3PXP",
  ].join("\n");
  const { out } = run("accounts", JSON.stringify({ action: "import", text }), { RUODAO_IMAGE_POOL_DATA_DIR: dataDir });
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "succeeded");
  assert.equal(body.parsed, 3);
  assert.equal(body.imported, 2);
  assert.equal(body.duplicated, 1);
  const file = body.accountsFile;
  assert.ok(existsSync(file));
  const saved = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(saved.length, 2);
  assert.match(saved[0], /^txxxx@icloud\.com----pwd1----JBSWY3DPEHPK3PXP$/);
});

test("accounts list 脱敏展示且不泄露密码", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-test-"));
  const text = "user.secret@example.com----SUPERSECRET----KEY";
  run("accounts", JSON.stringify({ action: "import", text }), { RUODAO_IMAGE_POOL_DATA_DIR: dataDir });
  const { out } = run("accounts", JSON.stringify({ action: "list" }), { RUODAO_IMAGE_POOL_DATA_DIR: dataDir });
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "succeeded");
  assert.equal(body.total, 1);
  assert.equal(body.accounts[0].email, "us***om");
  assert.ok(!out.includes("SUPERSECRET"), "输出不得包含明文密码");
});

test("generate 缺少 prompt 返回失败", () => {
  const { code, out } = run("generate", "{}", { RUODAO_FB_API_BASE: "http://127.0.0.1:59999" });
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(code, 1);
  assert.equal(body.state, "failed");
  assert.match(body.error, /缺少生图提示词/);
});

test("usage 空台账返回零统计", () => {
  const { out } = run("usage", '{"days":7}');
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "succeeded");
  assert.equal(body.totalTasks, 0);
});

test("service 不支持的 action 返回失败", () => {
  const { code, out } = run("service", '{"action":"destroy"}');
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(code, 1);
  assert.equal(body.state, "failed");
  assert.match(body.error, /不支持的操作/);
});

test("service status 离线也能返回结构化状态", () => {
  const { out } = run("service", '{"action":"status"}', {
    RUODAO_FB_API_BASE: "http://127.0.0.1:59997",
    RUODAO_VB_API_BASE: "http://127.0.0.1:59996",
  });
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "succeeded");
  assert.equal(typeof body.fpb.status.up, "boolean");
  assert.equal(typeof body.vb.status.up, "boolean");
  assert.equal(body.up, false);
});

test("assistant 命令可运行且默认不侵入宿主（不弹浏览器、不拉起常驻服务）", () => {
  // 正常插件安装自带 vendor/assistant/app.py；这里只验证命令可运行且输出 JSON。
  // NO_OPEN/NO_LAUNCH 必开：否则跑一次用例就会弹出一个 127.0.0.1:<port> 浏览器标签页并留下常驻 Python 进程。
  const { out } = run("assistant", "", {
    RUODAO_ASSISTANT_PORT: "58766",
    RUODAO_ASSISTANT_NO_OPEN: "1",
    RUODAO_ASSISTANT_NO_LAUNCH: "1",
  });
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.ok(["succeeded", "failed"].includes(body.state));
  if (body.state === "succeeded") {
    assert.equal(body.opened, false);
    assert.equal(body.launched, false);
  }
});

test("bind 空账号文本返回失败", () => {
  const { code, out } = run("bind", '{"text":""}');
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(code, 1);
  assert.equal(body.state, "failed");
  assert.match(body.error, /未解析出任何账号/);
});

test("workers 空号池返回零统计且不报错", () => {
  const { out } = run("workers", "");
  const body = JSON.parse(out.trim().split("\n").pop());
  assert.equal(body.state, "succeeded");
  assert.equal(body.total, 0);
  assert.equal(body.loggedIn, 0);
  assert.equal(typeof body.playwright, "boolean");
});

test("generate 无直驱 worker 时走网关路径并给出明确失败", () => {
  // forceGateway：跳过后台守护进程与直驱，隔离本机已登录账号对用例的影响
  const { code, out } = run("generate", '{"prompt":"a cat","forceGateway":true}', { RUODAO_FB_API_BASE: "http://127.0.0.1:59999" });
  const lines = out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const final = lines.pop();
  assert.equal(code, 1);
  assert.equal(final.state, "failed"); // 两端都不可用，最终失败但过程可诊断
});

test("TOTP 按 RFC 6238 官方向量校验", async () => {
  const direct = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "direct.mjs")).href);
  const orig = Date.now;
  Date.now = () => 59 * 1000; // unix=59s → 官方向量 TOTP-SHA1 6位
  try {
    const code = direct.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(code, "287082");
  } finally {
    Date.now = orig;
  }
});

test("parseAccounts 解析发货文本", async () => {
  const direct = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "direct.mjs")).href);
  const rows = direct.parseAccounts("a@x.com----p1----KEY33\nbad-line\nb@y.com----p2");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].totpSecret, "KEY33");
  assert.equal(rows[1].totpSecret, "");
});

test("planWorkerBindings 无 Key 时也不引用未定义变量，并正确分配环境", async () => {
  const direct = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "direct.mjs")).href);
  const rows = direct.parseAccounts("a@x.com----p1----KEY33\nb@y.com----p2----KEY44");
  const plan = direct.planWorkerBindings({ rows, workers: [], profileIds: [1, 2] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.assignments.map((a) => a.workerId), [1, 2]);
  assert.deepEqual(plan.assignments.map((a) => a.existing), [false, false]);
});

test("planWorkerBindings 复用已绑定环境，只给新账号分配空闲环境", async () => {
  const direct = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "direct.mjs")).href);
  const rows = direct.parseAccounts("a@x.com----p1----KEY33\nb@y.com----p2----KEY44");
  const workers = [{ workerId: 1, email: "a@x.com" }];
  const plan = direct.planWorkerBindings({ rows, workers, profileIds: [1, 2] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.assignments.map((a) => a.workerId), [1, 2]);
  assert.deepEqual(plan.assignments.map((a) => a.existing), [true, false]);
});

test("planWorkerBindings 环境不足时返回明确错误", async () => {
  const direct = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "direct.mjs")).href);
  const rows = direct.parseAccounts("a@x.com----p1----KEY33\nb@y.com----p2----KEY44");
  const plan = direct.planWorkerBindings({ rows, workers: [], profileIds: [1] });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /可用环境不足/);
});
