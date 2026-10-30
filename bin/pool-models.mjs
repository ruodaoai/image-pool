/**
 * 号池模型目录（CLI / 守护进程 / 工作台共用）
 *
 * 直驱模式没有「模型 API」，模型由 ChatGPT 网页会话里的画图工具决定：
 * 模型名仅用于记账与归类；未匹配到条目时不报错，保持当前选择，
 * 并在台账里记录实际使用的模型名。
 */

export const IMAGE_MODELS = [
  "gpt-image2-1k", "gpt-image2-2k", "gpt-image2-4k",
  "nana-banana-2", "nana-banana-2_sync", "nana-banana-pro",
  "nana-banana-2-4k", "nana-banana-pro-4k",
];

export const VIDEO_MODELS = ["veo-3-1", "veo-3-1-1080p", "veo-omni-flash", "veo-omni-flash-1080p", "seedance-2", "seedance-2-fast"];

/** 对话模型：直驱时按网页模型选择器的可见文案匹配，未命中就保持当前选择。 */
export const CHAT_MODELS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", labelRe: "GPT[- ]?6|Astra", aliases: ["gpt-6", "gpt-6-astra", "gpt6", "astra"] },
  { id: "gpt-5.5", label: "GPT-5.5", labelRe: "GPT[- ]?5\\.5", aliases: ["gpt-5.5", "gpt-5-5", "gpt5.5"] },
  { id: "auto", label: "自动", labelRe: "", aliases: ["auto", "自动"] },
];

const normalizeModel = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");

export function resolveChatModel(requested) {
  const key = normalizeModel(requested);
  const hit = CHAT_MODELS.find((model) => model.id === key || model.aliases.includes(key));
  return hit || CHAT_MODELS.find((model) => model.id === "auto");
}

export function isChatModel(value) {
  const key = normalizeModel(value);
  return key !== "auto" && CHAT_MODELS.some((model) => model.id === key || model.aliases.includes(key));
}

export function openAiModelList() {
  const now = Math.floor(Date.now() / 1000);
  return [
    ...IMAGE_MODELS.map((id) => ({ id, object: "model", created: now, owned_by: "image-pool", type: "image" })),
    ...CHAT_MODELS.filter((model) => model.id !== "auto")
      .map((model) => ({ id: model.id, object: "model", created: now, owned_by: "image-pool", type: "chat" })),
  ];
}
