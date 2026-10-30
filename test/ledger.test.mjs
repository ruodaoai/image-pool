import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_DIR, "bin", "image-pool.mjs");

function dataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "image-pool-ledger-"));
  mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

function seed(dir) {
  const now = Date.now();
  const rows = [
    { ts: now - 1000, kind: "generate-direct", workerId: 1, model: "chatgpt-direct", state: "completed", elapsedMs: 90000, imagePath: path.join(dir, "images", "a.png") },
    { ts: now - 2000, kind: "image", workerId: 2, account: "ro***om", model: "chatgpt-direct", state: "failed", elapsedMs: 60000, error: "生成超时", stages: { openMs: 800, submitMs: 1500, resultMs: 50000 } },
    { ts: now - 3000, kind: "chat", workerId: 1, account: "ro***om", model: "GPT-6 Astra", requestedModel: "gpt-6", state: "completed", elapsedMs: 12000, chars: 400, promptChars: 20, prompt: "你好", stages: { openMs: 600, modelMs: 400, submitMs: 900, resultMs: 9000 } },
  ];
  writeFileSync(path.join(dir, "usage.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(path.join(dir, "workers.json"), JSON.stringify({
    nextId: 3,
    workers: [
      { workerId: 1, email: "rosamond@example.com", loggedIn: true, usageCount: 2 },
      { workerId: 2, email: "rogers@example.com", loggedIn: true, usageCount: 1, limitedUntil: now + 3600_000 },
    ],
  }), "utf8");
  writeFileSync(path.join(dir, "images", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, "images", "a.png.json"), JSON.stringify({ ts: now, prompt: "一只猫", model: "chatgpt-direct", workerId: 1, elapsedMs: 90000 }), "utf8");
  return dir;
}

function run(mode, stdin, dir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, RUODAO_IMAGE_POOL_DATA_DIR: dir, ...extraEnv },
  });
  const lines = String(res.stdout || "").trim().split("\n").filter(Boolean);
  return { code: res.status, body: JSON.parse(lines[lines.length - 1] || "{}") };
}

test("usage 归一化旧记录并按种类/账号/额度聚合", () => {
  const dir = seed(dataDir());
  const { body } = run("usage", '{"days":30}', dir);
  assert.equal(body.state, "succeeded");
  assert.equal(body.totalTasks, 3);
  assert.equal(body.generated, 2);
  assert.equal(body.failed, 1);
  assert.equal(body.byKind.image.total, 2);
  assert.equal(body.byKind.chat.total, 1);
  assert.equal(body.byKind.chat.chars, 400);
  assert.equal(body.byKind.chat.tokensEstimate, 100);
  assert.equal(body.quota.accounts[0].email, "ro***om");
  assert.equal(body.quota.accounts[0].todayTotal, 2);
  assert.equal(body.quota.accounts[1].limited, true);
  assert.equal(body.errors[0].message, "生成超时");
  assert.equal(body.stages.resultMs, Math.round((50000 + 9000) / 2));
});

test("logs 支持按种类/状态/关键词过滤并倒序", () => {
  const dir = seed(dataDir());
  const { body } = run("logs", '{"days":30,"kind":"chat"}', dir);
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].kind, "chat");
  assert.equal(body.rows[0].prompt, "你好");
  const failed = run("logs", '{"days":30,"state":"failed"}', dir).body;
  assert.equal(failed.total, 1);
  assert.match(failed.rows[0].error, /超时/);
  const keyword = run("logs", '{"days":30,"q":"猫"}', dir).body;
  assert.equal(keyword.total, 0);
});

test("images 列表带提示词与大小，delete 后消失", () => {
  const dir = seed(dataDir());
  const list = run("images", "{}", dir).body;
  assert.equal(list.state, "succeeded");
  assert.equal(list.total, 1);
  assert.equal(list.items[0].prompt, "一只猫");
  assert.ok(list.items[0].size > 0);
  assert.match(list.items[0].url, /\/images\/a\.png$/);
  const del = run("images", '{"action":"delete","file":"a.png"}', dir).body;
  assert.equal(del.state, "succeeded");
  assert.equal(run("images", "{}", dir).body.total, 0);
  assert.equal(existsSync(path.join(dir, "images", "a.png.json")), false);
});

test("对话模型别名解析：gpt-6 → gpt-6-astra，未知值回落到自动", async () => {
  const models = await import(pathToFileURL(path.join(PLUGIN_DIR, "bin", "pool-models.mjs")).href);
  assert.equal(models.resolveChatModel("gpt-6").id, "gpt-6-astra");
  assert.equal(models.resolveChatModel("GPT-6-ASTRA").id, "gpt-6-astra");
  assert.equal(models.resolveChatModel("gpt-5.5").id, "gpt-5.5");
  assert.equal(models.resolveChatModel("some-unknown").id, "auto");
  assert.equal(models.isChatModel("gpt-6-astra"), true);
  assert.equal(models.isChatModel("gpt-image2-1k"), false);
  assert.ok(models.openAiModelList().some((m) => m.id === "gpt-6-astra" && m.type === "chat"));
});

test("守护进程状态在未运行时给出可操作提示", () => {
  const dir = dataDir();
  const { body } = run("daemon", '{"action":"status"}', dir, { RUODAO_IMAGE_API_PORT: "58111" });
  assert.equal(body.state, "succeeded");
  assert.equal(body.running, false);
  assert.match(body.hint, /未运行/);
});
