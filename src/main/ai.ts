import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import sharp from "sharp";
import { shell } from "electron";
import { z } from "zod";
import type { AiEdit, AiEditOptions, Book, Page } from "../contracts";
import type { Backend } from "./backend";
import { aiConfigSchema, editImage } from "./aiProviders";

type Stored = Omit<AiEdit, "imageUrl"> & { outputFile?: string; destination: string; bookPath?: string };
type Dependencies = { db: Backend; root: string; defaults: string; pages(file: string): Promise<Page[]>; resolve(url: string): Promise<string>; asset(file: string): string };
export async function createAiHandlers({ db, root, defaults, pages, resolve, asset }: Dependencies) {
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  const configFile = path.join(root, "config.json");
  try { await fs.access(configFile); } catch { await fs.cp(defaults, root, { recursive: true, force: false, errorOnExist: false }); }
  // Upgrade bundled presets once; preserve custom profiles and edited workflow files.
  try {
    const existing = JSON.parse(await fs.readFile(configFile, "utf8"));
    const bundled = JSON.parse(await fs.readFile(path.join(defaults, "config.json"), "utf8"));
    if ((existing.presetRevision || 1) < (bundled.presetRevision || 1)) {
      aiConfigSchema.parse(existing); aiConfigSchema.parse(bundled);
      for (const profile of bundled.profiles) {
        if (profile.provider === "comfyui") await fs.copyFile(path.join(defaults, profile.workflow), path.join(root, profile.workflow), constants.COPYFILE_EXCL).catch(e => { if (e.code !== "EEXIST") throw e; });
        if (!existing.profiles.some((p: { id: string }) => p.id === profile.id)) existing.profiles.push(profile);
      }
      if (["klein-4b", "klein-9b"].includes(existing.defaultProfile)) existing.defaultProfile = bundled.defaultProfile;
      existing.presetRevision = bundled.presetRevision;
      await fs.copyFile(configFile, configFile + ".before-pony", constants.COPYFILE_EXCL).catch(e => { if (e.code !== "EEXIST") throw e; });
      await fs.writeFile(configFile + ".tmp", JSON.stringify(existing, null, 2)); await fs.rename(configFile + ".tmp", configFile);
    }
  } catch (e) { console.error("AI preset migration:", e); }
  await db.prepare("CREATE TABLE IF NOT EXISTS ai_edits(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL)").run();
  // Interrupted jobs remain visible after restart rather than appearing to run forever.
  const rows = await db.prepare("SELECT data FROM ai_edits").all();
  const put = async (record: Stored) => { await db.prepare("INSERT OR REPLACE INTO ai_edits(id,book_id,created,data) VALUES(?,?,?,?)").run(record.id, record.bookId, record.createdAt, JSON.stringify(record)); };
  for (const row of rows) { const record: Stored = JSON.parse(row.data); if (record.status === "generating") { record.status = "failed"; record.error = "上次运行中断，请重新生成 / Previous session interrupted"; await put(record); } }
  const config = async () => aiConfigSchema.parse(JSON.parse(await fs.readFile(configFile, "utf8")));
  const get = async (id: string): Promise<Stored> => {
    z.string().uuid().parse(id);
    const row = await db.prepare("SELECT data FROM ai_edits WHERE id=?").get(id);
    if (!row) throw Error("AI记录不存在 / AI record not found");
    return JSON.parse(row.data);
  };
  const present = async (r: Stored): Promise<AiEdit> => {
    const { outputFile, destination, bookPath, ...rest } = r;
    const item: AiEdit = rest;
    if (outputFile && r.status !== "deleted") {
      try { await fs.access(outputFile); item.imageUrl = asset(outputFile); }
      catch { if (r.savedPath) { try { await fs.access(r.savedPath); item.imageUrl = asset(r.savedPath); } catch {} } }
    }
    return item;
  };
  let busy = false;
  const mutations = new Set<string>();
  async function mutate<T>(id: string, fn: (record: Stored) => Promise<T>) {
    if (mutations.has(id)) throw Error("记录正在更新，请稍后再试");
    mutations.add(id);
    try { return await fn(await get(id)); } finally { mutations.delete(id); }
  }
  return {
    aiProfiles: async () => {
      const c = await config(); return { defaultProfile: c.defaultProfile, profiles: c.profiles.map(p => ({ id: p.id, name: p.name, provider: p.provider, endpoint: p.endpoint, requiresMask: p.requiresMask, promptHint: p.promptHint, parameters: p.provider === "comfyui" ? p.parameters.map(({ node, input, ...parameter }) => parameter) : [] })) };
    },
    aiConfigure: async () => { const error = await shell.openPath(configFile); if (error) throw Error(error); },
    aiHistory: async (query = "", bookId?: string) => {
      z.string().max(500).parse(query); if (bookId) z.string().uuid().parse(bookId);
      const rows = bookId ? await db.prepare("SELECT data FROM ai_edits WHERE book_id=? ORDER BY created DESC").all(bookId) : await db.prepare("SELECT data FROM ai_edits ORDER BY created DESC").all();
      const records: Stored[] = rows.map((row: any) => JSON.parse(row.data));
      return Promise.all(records.filter(r => [r.bookTitle, r.pageTitle, r.prompt, r.profileName].join(" ").toLowerCase().includes(query.toLowerCase())).map(present));
    },
    aiGet: async (id: string) => present(await get(id)),
    aiOriginal: async (id: string) => {
      const record = await get(id);
      const book: Book | undefined = await db.prepare("SELECT * FROM books WHERE id=?").get(record.bookId);
      const bookPath = book?.path || record.bookPath;
      if (!bookPath) return null;
      try {
        const list = await pages(bookPath);
        // Do not compare against the wrong page if the original book has changed.
        const page = list[record.page]?.title === record.pageTitle
          ? list[record.page] : list.find(p => p.title === record.pageTitle);
        return page?.url || null;
      } catch { return null; }
    },
    aiStart: async (bookId: string, page: number, prompt: string, profileId: string, options: AiEditOptions = {}) => {
      z.string().uuid().parse(bookId); z.number().int().min(0).parse(page); prompt = z.string().trim().min(1).max(6000).parse(prompt); z.string().max(100).parse(profileId);
      options = z.object({ mask: z.string().max(12 * 1024 * 1024).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).optional(), parameters: z.record(z.string().regex(/^[a-zA-Z_]\w*$/), z.number().finite()).optional() }).strict().parse(options);
      if (busy) throw Error("已有AI任务正在运行，可在AI修改记录中查看 / An AI job is already running");
      busy = true;
      try {
        const c = await config(), profile = c.profiles.find(p => p.id === profileId);
        if (!profile) throw Error("模型配置不存在 / Profile not found");
        if (profile.requiresMask && !options.mask) throw Error("请先涂抹需要修改的区域 / Paint an edit region first");
        const parameters: Record<string, number> = {};
        for (const [key, value] of Object.entries(options.parameters || {})) {
          const definition = profile.provider === "comfyui" ? profile.parameters.find(p => p.key === key) : undefined;
          if (!definition || value < definition.min || value > definition.max) throw Error(`参数无效 / Invalid parameter: ${key}`);
          parameters[key] = value;
        }
        const book: Book = await db.prepare("SELECT * FROM books WHERE id=?").get(bookId);
        if (!book) throw Error("漫画不存在 / Book not found");
        const list = await pages(book.path), selected = list[page];
        if (!selected) throw Error("当前页不存在 / Page not found");
        const source = await resolve(selected.url), stat = await fs.stat(book.path);
        const destination = stat.isDirectory() ? path.dirname(source) : /\.(jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i.test(book.path) ? path.dirname(book.path) : path.join(path.dirname(book.path), path.parse(book.path).name + "_AI");
        const record: Stored = { id: randomUUID(), bookId, bookPath: book.path, bookTitle: book.title, pageTitle: selected.title, page, prompt, profileId, profileName: profile.name, createdAt: Date.now(), status: "generating", destination, localEdit: !!options.mask, parameters };
        await put(record);
        void (async () => {
          const start = Date.now();
          try {
            const meta = await sharp(source, { limitInputPixels: 50000000 }).rotate().metadata();
            const w = meta.autoOrient?.width || meta.width!, h = meta.autoOrient?.height || meta.height!;
            const ratio = Math.min(1, Math.sqrt(profile.maxPixels / (w * h)));
            const width = Math.max(16, Math.floor(w * ratio / 16) * 16), height = Math.max(16, Math.floor(h * ratio / 16) * 16);
            const image = await sharp(source, { limitInputPixels: 50000000 }).rotate().resize(width, height).png().toBuffer();
            let mask: Buffer | undefined, fullMask: Buffer | undefined;
            if (options.mask) {
              const supplied = Buffer.from(options.mask.split(",")[1], "base64");
              const maskMeta = await sharp(supplied, { limitInputPixels: 50000000 }).metadata();
              if (maskMeta.format !== "png" || !maskMeta.width || !maskMeta.height || Math.abs(maskMeta.width / maskMeta.height - w / h) > (w / h) * 0.02) throw Error("遮罩与原图比例不一致 / Mask aspect ratio does not match the page");
              const stats = await sharp(supplied).removeAlpha().greyscale().stats();
              if (!stats.channels.some(c => c.max > 0)) throw Error("遮罩为空，请先涂抹修改区域 / The mask is empty");
              mask = await sharp(supplied).removeAlpha().greyscale().resize(width, height).png().toBuffer();
              fullMask = await sharp(supplied).removeAlpha().greyscale().resize(w, h).png().toBuffer();
            }
            const result = await editImage(profile, { image, mask, prompt, width, height, seed: randomInt(2147483647), parameters }, root);
            let png: Buffer;
            if (fullMask) {
              const alpha = await sharp(fullMask).greyscale().raw().toBuffer();
              const rgb = await sharp(result, { limitInputPixels: 50000000 }).resize(w, h).removeAlpha().png().toBuffer();
              const overlay = await sharp(rgb).joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
              png = await sharp(source, { limitInputPixels: 50000000 }).rotate().composite([{ input: overlay }]).png().toBuffer();
            } else png = await sharp(result, { limitInputPixels: 50000000 }).png().toBuffer();
            record.outputFile = path.join(root, "results", record.id + ".png");
            await fs.writeFile(record.outputFile, png, { flag: "wx" }); record.status = "ready";
          } catch (e) { record.status = "failed"; record.error = String(e).slice(0, 1000); }
          finally { record.seconds = (Date.now() - start) / 1000; try { await put(record); } finally { busy = false; } }
        })().catch(console.error);
        return present(record);
      } catch (e) { busy = false; throw e; }
    },
    aiSave: (id: string) => mutate(id, async record => {
      if (record.status === "saved") return present(record);
      if (record.status !== "ready" || !record.outputFile) throw Error("没有可保存的结果 / No image to save");
      await fs.mkdir(record.destination, { recursive: true });
      const base = path.parse(path.basename(record.pageTitle.replace(/\\/g, "/"))).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "page";
      const saved = path.join(record.destination, `${base}_AI_${record.id}.png`);
      await fs.copyFile(record.outputFile, saved, constants.COPYFILE_EXCL);
      record.savedPath = saved; record.status = "saved"; await put(record); return present(record);
    }),
    aiDelete: (id: string) => mutate(id, async record => {
      if (record.status === "generating") throw Error("生成中不能删除，可关闭窗口后在记录中查看");
      if (record.status === "deleted") return;
      for (const file of new Set([record.savedPath, record.outputFile].filter(Boolean) as string[])) {
        try { await fs.access(file); } catch { continue; }
        await shell.trashItem(file);
      }
      record.status = "deleted"; record.savedPath = undefined; record.outputFile = undefined; await put(record);
    }),
    aiRemove: (id: string) => mutate(id, async record => {
      if (record.status === "generating") throw Error("生成中的记录不能移除 / Cannot remove an active job");
      // Only forget the history entry. Saved images and generated result files remain untouched.
      await db.prepare("DELETE FROM ai_edits WHERE id=?").run(record.id);
    }),
  };
}
