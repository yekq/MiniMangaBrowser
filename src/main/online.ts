import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Book, OnlineListing, OnlineSource, OnlineTask, Page } from "../contracts";
import type { Backend } from "./backend";
import { trimCache } from "./cache";
import { catalog, catalogUrl, galleryUrl, openGallery, siteOf, type Gallery, type ImageLink } from "./onlineAdapters";
import { fetchOnline, OnlineRateLimitError, publicUrl, rasterExtension, type OnlineRequest, type OnlineResponse } from "./onlineNetwork";

const builtIn: OnlineSource[] = [
  { url: "https://e-hentai.org/", title: "E-Hentai", builtIn: true },
  { url: "https://nhentai.net/", title: "nHentai", builtIn: true },
];
const urlInput = z.string().trim().min(1).max(4096);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exists = (file: string) => fs.access(file).then(() => true, () => false);

export function createOnline(db: Backend, data: string, openExternal: (url: string) => Promise<void>, transport = fetchOnline) {
  const storage = path.join(data, "online-library");
  const scratch = path.join(data, "online-images");
  const galleries = new Map<string, { book: Book; gallery: Gallery }>();
  const opening = new Map<string, Promise<Book>>();
  const covers = new Map<string, ImageLink>();
  const pending = new Map<string, Promise<string>>();
  const tasks = new Map<string, OnlineTask>();
  let job: { id: string; controller: AbortController } | undefined;
  let schema: Promise<unknown> | undefined;
  const ready = () => schema ??= db.call("transaction", { statements: [
    { sql: "CREATE TABLE IF NOT EXISTS online_sources(url TEXT PRIMARY KEY,title TEXT NOT NULL)", args: [] },
    { sql: "CREATE TABLE IF NOT EXISTS online_books(url TEXT PRIMARY KEY,progress INTEGER NOT NULL DEFAULT 0,cached_path TEXT)", args: [] },
    { sql: "CREATE TABLE IF NOT EXISTS online_partial_downloads(url TEXT PRIMARY KEY,path TEXT NOT NULL,total INTEGER NOT NULL,done INTEGER NOT NULL,host TEXT NOT NULL,retry_at INTEGER NOT NULL)", args: [] },
  ] }).catch(error => { schema = undefined; throw error; });

  let requests = 0;
  const waiting: Array<() => void> = [];
  const request: OnlineRequest = async (url, kind, referer, signal) => {
    if (requests >= 4) {
      if (waiting.length >= 256) throw Error("网络任务过多，请稍后重试 / Too many network requests");
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          const index = waiting.indexOf(start);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal?.reason);
        };
        if (signal?.aborted) { reject(signal.reason); return; }
        waiting.push(start);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else requests++;
    try {
      signal?.throwIfAborted();
      return await transport(url, kind, referer, signal);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else requests--;
    }
  };

  const get = (id: string) => {
    const item = galleries.get(z.string().uuid().parse(id));
    if (!item) throw Error("在线漫画未打开 / Online comic is not open");
    return item;
  };
  const pageResource = (id: string, index: number) => `manga://online/${id}/${index}`;
  const keepImage = async (key: string, response: OnlineResponse) => {
    const extension = rasterExtension(response.bytes);
    const file = path.join(scratch, key + ".image");
    // The protocol and sharp use the file signature. The actual extension is
    // applied when creating the offline copy.
    await fs.mkdir(scratch, { recursive: true });
    await fs.writeFile(file + ".part", response.bytes);
    await fs.rename(file + ".part", file);
    void trimCache(scratch, 384 * 1024 * 1024, file);
    return { file, extension };
  };
  const imageFile = async (key: string, source: () => Promise<ImageLink>, signal?: AbortSignal) => {
    const file = path.join(scratch, key + ".image");
    if (await exists(file)) return file;
    if (!pending.has(key)) pending.set(key, (async () => {
      const link = await source();
      const response = await request(link.url, "image", link.referer, signal);
      return (await keepImage(key, response)).file;
    })().finally(() => pending.delete(key)));
    return pending.get(key)!;
  };

  const resourceFile = (value: URL, thumbnail = false, signal?: AbortSignal): Promise<string> => {
    const parts = value.pathname.slice(1).split("/");
    if (parts.length === 1) {
      const link = covers.get(parts[0]);
      if (!link) throw Error("Unknown online cover");
      return imageFile(parts[0], async () => link);
    }
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw Error("Unknown online image");
    const item = get(parts[0]);
    const page = item.gallery.pages[Number(parts[1])];
    if (!page) throw Error("Unknown online page");
    const thumb = thumbnail ? page.thumbnail : undefined;
    const key = hash(item.gallery.url + "\n" + parts[1] + (thumb ? ":thumb" : ""));
    return imageFile(key, thumb ? async () => thumb : () => page.image(signal), signal);
  };

  const localBook = async (directory: string, item: { book: Book; gallery: Gallery }): Promise<Book> => {
    const book = item.book;
    await db.call("transaction", { statements: [
      { sql: "INSERT OR IGNORE INTO sources(id,path,title) VALUES(?,?,?)", args: [hash(directory), directory, book.title] },
      { sql: "DELETE FROM source_exclusions WHERE path=?", args: [directory] },
      { sql: "INSERT OR IGNORE INTO books(id,path,title,pages,progress) VALUES(?,?,?,?,?)", args: [randomUUID(), directory, book.title, book.pages, book.progress] },
      { sql: "UPDATE online_books SET cached_path=? WHERE url=?", args: [directory, item.gallery.url] },
    ] });
    return db.prepare("SELECT * FROM books WHERE path=?").get(directory);
  };

  const takePartial = async (url: string, total: number): Promise<{ directory: string; done: number; limit?: OnlineRateLimitError } | undefined> => {
    // Claim a checkpoint atomically so two app instances cannot write to it.
    const row = await db.prepare("DELETE FROM online_partial_downloads WHERE url=? RETURNING path,total,done,host,retry_at").get(url);
    if (!row || row.total !== total || !Number.isInteger(row.done) || row.done < 0 || row.done >= total ||
        path.dirname(row.path) !== storage || !/^\.download-[a-z0-9]{6}$/i.test(path.basename(row.path))) return;
    try {
      const relative = path.relative(await fs.realpath(storage), await fs.realpath(row.path));
      if (relative !== path.basename(row.path)) return;
      const files = await fs.readdir(row.path, { withFileTypes: true });
      const pages = new Set(files.filter(file => file.isFile() && /^\d{4}\.(jpg|png|gif|webp|avif|bmp)$/.test(file.name))
        .map(file => Number(file.name.slice(0, 4))));
      if (files.length === row.done && pages.size === row.done &&
          Array.from({ length: row.done }, (_, index) => index + 1).every(page => pages.has(page)))
        return { directory: row.path, done: row.done,
          limit: row.retry_at > Date.now() ? new OnlineRateLimitError(row.host, row.retry_at) : undefined };
    } catch {}
  };

  const waitForRateLimit = async (task: OnlineTask, error: OnlineRateLimitError, signal: AbortSignal) => {
    const wait = Math.max(0, error.retryAt - Date.now());
    if (wait > 15 * 60_000) throw error;
    task.retryAt = error.retryAt;
    try { await delay(wait, undefined, { signal }); }
    finally { delete task.retryAt; }
  };

  const cachePage = async (task: OnlineTask, index: number, signal: AbortSignal) => {
    const url = new URL(pageResource(task.id, index));
    for (let attempts = 0; ; attempts++) {
      signal.throwIfAborted();
      try { return await resourceFile(url, false, signal); }
      catch (error) {
        if (!(error instanceof OnlineRateLimitError) || attempts >= 3) throw error;
        await waitForRateLimit(task, error, signal);
      }
    }
  };

  const download = async (task: OnlineTask, item: ReturnType<typeof get>, controller: AbortController) => {
    const signal = controller.signal;
    let staging: string | undefined;
    let terminal: Pick<OnlineTask, "state" | "error"> | undefined;
    try {
      await ready();
      const saved = (await db.prepare("SELECT cached_path FROM online_books WHERE url=?").get(item.gallery.url))?.cached_path;
      if (typeof saved === "string" && path.dirname(saved) === storage) {
        const files = await fs.readdir(saved).catch(() => []);
        if (Array.from({ length: task.total }, (_, index) => String(index + 1).padStart(4, "0"))
          .every(number => files.some(file => file.startsWith(number + ".")))) {
          signal.throwIfAborted();
          task.book = await localBook(saved, item);
          task.done = task.total;
          task.state = "done";
          return;
        }
      }
      await fs.mkdir(storage, { recursive: true });
      signal.throwIfAborted();
      const previous = await takePartial(item.gallery.url, task.total);
      staging = previous?.directory ?? await fs.mkdtemp(path.join(storage, ".download-"));
      task.done = previous?.done ?? 0;
      if (previous?.limit) await waitForRateLimit(task, previous.limit, signal);
      for (let index = task.done; index < task.total; index++) {
        signal.throwIfAborted();
        const source = await cachePage(task, index, signal);
        const bytes = await fs.readFile(source);
        const ext = rasterExtension(bytes);
        const name = String(index + 1).padStart(4, "0") + "." + ext;
        await fs.writeFile(path.join(staging, name), bytes);
        task.done = index + 1;
      }
      signal.throwIfAborted();
      const title = item.book.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 48);
      const directory = path.join(storage, `${title || "Manga"}-${hash(item.gallery.url).slice(0, 10)}-${randomUUID().slice(0, 8)}`);
      await fs.rename(staging, directory);
      staging = undefined;
      task.book = await localBook(directory, item);
      task.state = "done";
    } catch (failure) {
      let retained = false;
      if (failure instanceof OnlineRateLimitError && !signal.aborted) {
        task.retryAt = failure.retryAt;
        if (staging) {
          try {
            await db.prepare("INSERT OR REPLACE INTO online_partial_downloads(url,path,total,done,host,retry_at) VALUES(?,?,?,?,?,?)")
              .run(item.gallery.url, staging, task.total, task.done, failure.host, failure.retryAt);
            staging = undefined;
            retained = task.done > 0;
          } catch {}
        }
      }
      terminal = {
        state: signal.aborted ? "cancelled" : "failed",
        error: signal.aborted ? undefined : String(failure) +
          (retained ? `。已保留 ${task.done} 页，下次重试继续 / ${task.done} pages saved for retry.` : ""),
      };
    } finally {
      if (staging && path.dirname(staging) === storage && path.basename(staging).startsWith(".download-"))
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      job = undefined;
      if (terminal) Object.assign(task, terminal);
    }
  };

  return {
    resourceFile,
    imageResponse: async (url: URL) => {
      const file = await resourceFile(url);
      const bytes = await fs.readFile(file);
      const extension = rasterExtension(bytes);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "image/" + (extension === "jpg" ? "jpeg" : extension), "X-Content-Type-Options": "nosniff" },
      });
    },
    handlers: {
      onlineSources: async (): Promise<OnlineSource[]> => {
        await ready();
        return [...builtIn, ...await db.prepare("SELECT url,title FROM online_sources ORDER BY title").all()];
      },
      onlineSaveSource: async (value: string, name: string) => {
        const url = galleryUrl(publicUrl(urlInput.parse(value)));
        const title = z.string().trim().max(120).parse(name) || url.hostname;
        if (builtIn.some(site => site.url === url.href)) return url.href;
        await ready();
        await db.prepare("INSERT OR REPLACE INTO online_sources(url,title) VALUES(?,?)").run(url.href, title);
        return url.href;
      },
      onlineRemoveSource: async (value: string) => {
        await ready();
        await db.prepare("DELETE FROM online_sources WHERE url=?").run(urlInput.parse(value));
      },
      onlineList: async (value: string, input: string): Promise<OnlineListing> => {
        const url = catalogUrl(publicUrl(urlInput.parse(value)), z.string().trim().max(200).parse(input));
        const site = siteOf(url);
        if (!site) throw Error("该网址请作为图片页打开 / Open this URL as an image page");
        const response = await request(url.href, "document");
        if (siteOf(publicUrl(response.url)) !== site) throw Error("网站跳转到了不同来源 / Site redirected to a different source");
        const result = catalog(response, site);
        return { ...result, items: result.items.map(item => {
          if (!item.cover) return { url: item.url, title: item.title };
          const key = hash(item.cover.url);
          while (covers.size >= 500) covers.delete(covers.keys().next().value!);
          covers.set(key, item.cover);
          return { url: item.url, title: item.title, cover: `manga://online/${key}` };
        }) };
      },
      onlineOpen: async (value: string): Promise<Book> => {
        const url = galleryUrl(publicUrl(urlInput.parse(value))).href;
        const known = [...galleries.values()].find(item => item.gallery.url === url);
        if (known) return known.book;
        if (!opening.has(url)) opening.set(url, (async () => {
          const gallery = await openGallery(request, url);
          const existing = [...galleries.values()].find(item => item.gallery.url === gallery.url);
          if (existing) return existing.book;
          await ready();
          await db.prepare("INSERT OR IGNORE INTO online_books(url) VALUES(?)").run(gallery.url);
          const record = await db.prepare("SELECT progress FROM online_books WHERE url=?").get(gallery.url);
          const book: Book = { id: randomUUID(), title: gallery.title, onlineUrl: gallery.url, path: gallery.url,
            pages: gallery.pages.length, progress: Math.min(record.progress, gallery.pages.length - 1), tags: "", author: "" };
          if (gallery.firstImage) {
            await keepImage(hash(gallery.url + "\n0"), gallery.firstImage);
            delete gallery.firstImage;
          }
          galleries.set(book.id, { gallery, book });
          return book;
        })().finally(() => opening.delete(url)));
        return opening.get(url)!;
      },
      onlinePages: async (id: string): Promise<Page[]> => get(id).gallery.pages.map((_, index) => ({
        id: String(index), title: String(index + 1).padStart(4, "0"), url: pageResource(id, index),
      })),
      onlineProgress: async (id: string, page: number) => {
        const item = get(id);
        item.book.progress = z.number().int().min(0).max(item.book.pages - 1).parse(page);
        await db.prepare("UPDATE online_books SET progress=? WHERE url=?").run(page, item.gallery.url);
      },
      onlineCache: async (id: string) => {
        const item = get(id);
        if (job) throw Error("已有缓存任务在运行 / A cache job is already running");
        const controller = new AbortController();
        const task: OnlineTask = { id, title: item.book.title, total: item.book.pages, done: 0, state: "running" };
        if (tasks.size >= 50) tasks.delete(tasks.keys().next().value!);
        tasks.set(id, task);
        job = { id, controller };
        void download(task, item, controller);
      },
      onlineTasks: async () => [...tasks.values()].reverse(),
      onlineCancel: async (id: string) => {
        if (job?.id === id) job.controller.abort();
      },
      onlineExternal: async (value: string) => {
        const original = new URL(urlInput.parse(value));
        const validated = publicUrl(original.href);
        validated.hash = original.hash;
        await openExternal(validated.href);
      },
    },
  };
}
