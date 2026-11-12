import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const binding = z.object({ node: z.string().regex(/^[\w-]+$/), input: z.string().regex(/^[a-zA-Z_]\w*$/) });
const common = {
  id: z.string().regex(/^[\w-]+$/), name: z.string().min(1).max(100),
  endpoint: z.string().url().refine(value => /^https?:$/.test(new URL(value).protocol)),
  apiKeyEnv: z.string().optional(), maxPixels: z.number().int().min(65536).max(4194304).default(786432),
  requiresMask: z.boolean().default(false), promptHint: z.string().max(500).optional(),
};
export const profileSchema = z.discriminatedUnion("provider", [
  z.object({ ...common, provider: z.literal("comfyui"), workflow: z.string().min(1),
    bindings: z.object({ prompt: binding, image: binding, mask: binding.optional(), seed: binding.optional(), width: z.array(binding).default([]), height: z.array(binding).default([]), outputNode: z.string() }),
    promptPrefix: z.string().max(1000).default(""),
    parameters: z.array(binding.extend({ key: z.string().regex(/^[a-zA-Z_]\w*$/), label: z.string().min(1).max(80), min: z.number().finite(), max: z.number().finite(), step: z.number().positive(), default: z.number().finite() })).max(20).default([]),
    overrides: z.array(binding.extend({ value: z.union([z.string(), z.number(), z.boolean()]) })).default([]),
  }),
  z.object({ ...common, provider: z.literal("openai-images"), model: z.string().min(1) }),
]);
export const aiConfigSchema = z.object({ version: z.literal(1), defaultProfile: z.string(), profiles: z.array(profileSchema).min(1).max(30) }).superRefine((c, ctx) => {
  if (new Set(c.profiles.map(p => p.id)).size !== c.profiles.length || !c.profiles.some(p => p.id === c.defaultProfile))
    ctx.addIssue({ code: "custom", message: "模型ID必须唯一，默认模型必须存在 / Invalid profile IDs" });
  for (const p of c.profiles) if (p.provider === "comfyui") {
    if (p.requiresMask && !p.bindings.mask) ctx.addIssue({ code: "custom", message: "需要遮罩的工作流必须配置mask绑定" });
    if (new Set(p.parameters.map(p => p.key)).size !== p.parameters.length || p.parameters.some(p => p.min > p.max || p.default < p.min || p.default > p.max)) ctx.addIssue({ code: "custom", message: "参数范围、默认值或参数ID配置无效" });
  }
});
export type Profile = z.infer<typeof profileSchema>;
type Input = { image: Buffer; mask?: Buffer; prompt: string; width: number; height: number; seed: number; parameters?: Record<string, number> };
const limit = 64 * 1024 * 1024;
export async function responseBytes(response: Response) {
  if (!response.ok) throw Error(`AI服务 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  if (Number(response.headers.get("content-length")) > limit) throw Error("AI结果超过64MB");
  const reader = response.body?.getReader();
  if (!reader) throw Error("AI服务未返回图片");
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > limit) throw Error("AI结果超过64MB");
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function headers(profile: Profile): Record<string, string> {
  if (!profile.apiKeyEnv) return {};
  const key = process.env[profile.apiKeyEnv];
  if (!key) throw Error(`未设置环境变量 ${profile.apiKeyEnv}`);
  return { Authorization: `Bearer ${key}` };
}
function url(profile: Profile, suffix: string) { return profile.endpoint.replace(/\/$/, "") + suffix; }
async function request(profile: Profile, suffix: string, init?: RequestInit, timeout = 30000) {
  const merged = new Headers(headers(profile));
  new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
  try { return await fetch(url(profile, suffix), { ...init, headers: merged, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw Error(`无法连接AI服务或请求超时，请确认服务已启动并检查模型配置 (${profile.endpoint}): ${String(e)}`); }
}
async function json(response: Response) { return JSON.parse((await responseBytes(response)).toString("utf8")); }
function setInput(graph: any, b: { node: string; input: string }, value: unknown) {
  if (["__proto__", "prototype", "constructor"].includes(b.input) || !Object.hasOwn(graph, b.node) || !graph[b.node]?.inputs)
    throw Error(`工作流节点无效: ${b.node}.${b.input}`);
  graph[b.node].inputs[b.input] = value;
}
async function comfyui(profile: Extract<Profile, { provider: "comfyui" }>, input: Input, configDir: string) {
  const graph = JSON.parse(await fs.readFile(path.resolve(configDir, profile.workflow), "utf8"));
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(input.image)], { type: "image/png" }), randomUUID() + ".png");
  form.append("subfolder", "MiniManga"); form.append("type", "input"); form.append("overwrite", "false");
  const uploaded = await json(await request(profile, "/upload/image", { method: "POST", body: form }));
  if (typeof uploaded.name !== "string" || /[/\\]/.test(uploaded.name) || typeof uploaded.subfolder !== "string" || uploaded.subfolder.split(/[/\\]/).includes("..")) throw Error("无效的上传结果");
  for (const override of profile.overrides) setInput(graph, override, override.value);
  setInput(graph, profile.bindings.prompt, input.prompt);
  if (profile.promptPrefix) setInput(graph, profile.bindings.prompt, profile.promptPrefix + input.prompt);
  setInput(graph, profile.bindings.image, uploaded.subfolder + "/" + uploaded.name);
  if (profile.bindings.mask) {
    if (!input.mask) throw Error("此工作流需要先涂抹修改区域 / A painted mask is required");
    const maskForm = new FormData();
    maskForm.append("image", new Blob([new Uint8Array(input.mask)], { type: "image/png" }), randomUUID() + "-mask.png");
    maskForm.append("subfolder", "MiniManga"); maskForm.append("type", "input"); maskForm.append("overwrite", "false");
    const mask = await json(await request(profile, "/upload/image", { method: "POST", body: maskForm }));
    if (typeof mask.name !== "string" || /[/\\]/.test(mask.name) || typeof mask.subfolder !== "string" || mask.subfolder.split(/[/\\]/).includes("..")) throw Error("无效的遮罩上传结果");
    setInput(graph, profile.bindings.mask, mask.subfolder + "/" + mask.name);
  }
  for (const parameter of profile.parameters) setInput(graph, parameter, input.parameters?.[parameter.key] ?? parameter.default);
  if (profile.bindings.seed) setInput(graph, profile.bindings.seed, input.seed);
  for (const b of profile.bindings.width) setInput(graph, b, input.width);
  for (const b of profile.bindings.height) setInput(graph, b, input.height);
  const job = await json(await request(profile, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: "mini-manga-" + randomUUID() }) }));
  if (typeof job.prompt_id !== "string") throw Error("工作流提交失败: " + JSON.stringify(job.node_errors || job).slice(0, 300));
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const history = await json(await request(profile, "/history/" + encodeURIComponent(job.prompt_id)));
    const result = history[job.prompt_id];
    if (result) {
      if (result.status?.status_str === "error" || result.status?.status_str === "failed") {
        const error = result.status.messages?.find((m: any) => m[0] === "execution_error");
        throw Error(error?.[1]?.exception_message || "ComfyUI 执行失败");
      }
      const image = result.outputs?.[profile.bindings.outputNode]?.images?.[0];
      if (image) {
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
        return responseBytes(await request(profile, "/view?" + params));
      }
      if (result.status?.completed) throw Error("工作流完成但没有图片，请检查 outputNode 配置");
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw Error("生成超过20分钟，请检查ComfyUI队列 / AI job timed out");
}
async function openaiImages(profile: Extract<Profile, { provider: "openai-images" }>, input: Input) {
  const form = new FormData();
  form.append("model", profile.model); form.append("prompt", input.prompt); form.append("n", "1");
  form.append("image", new Blob([new Uint8Array(input.image)], { type: "image/png" }), "page.png");
  if (input.mask) {
    // OpenAI-compatible masks use transparent pixels for the editable area.
    const { default: sharp } = await import("sharp");
    const alpha = await sharp(input.mask).removeAlpha().greyscale().negate().raw().toBuffer();
    const rgb = await sharp(input.image).removeAlpha().png().toBuffer();
    const mask = await sharp(rgb).joinChannel(alpha, { raw: { width: input.width, height: input.height, channels: 1 } }).png().toBuffer();
    form.append("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");
  }
  const result = await json(await request(profile, "/images/edits", { method: "POST", body: form }, 20 * 60 * 1000));
  const image = result.data?.[0];
  if (typeof image?.b64_json === "string") {
    if (image.b64_json.length > limit * 1.4) throw Error("AI结果超过64MB");
    return Buffer.from(image.b64_json, "base64");
  }
  if (typeof image?.url === "string" && new URL(image.url).origin === new URL(profile.endpoint).origin)
    return responseBytes(await fetch(image.url, { headers: headers(profile), signal: AbortSignal.timeout(30000) }));
  throw Error("服务没有返回base64图片或同源图片地址");
}
export function editImage(profile: Profile, input: Input, configDir: string): Promise<Buffer> {
  switch (profile.provider) {
    case "comfyui": return comfyui(profile, input, configDir);
    case "openai-images": return openaiImages(profile, input);
  }
}
