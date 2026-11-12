import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  shell,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Backend } from "./backend";
import { trimCache } from "./cache";
import { z } from "zod";
import { PdfRenderer } from "./pdf";
import { createLibraryHandlers } from "./library";
import { createReadingChoiceHandlers } from "./readingChoices";
import { createSourceLocator } from "./sourceLocator";
import { createPathRepair } from "./pathRepair";
import type { TreeNode } from "../contracts";
app.setName("mini.manga");
app.setAppUserModelId("mini.manga");
if (process.env.MINIMANGA_DATA)
  app.setPath("userData", process.env.MINIMANGA_DATA);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "manga",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const image = /\.(jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i,
  archive =
    /\.(zip|cbz|rar|cbr|7z|cb7|tar|cbt|gz|gzip|tgz|bz2|bzip2|tbz|tbz2|xz|txz|zst|tzst|cab|lzh|lha|cpio)$/i;
const wrappedArchive = /\.(gz|gzip|tgz|bz2|bzip2|tbz|tbz2|xz|txz|zst|tzst)$/i;
const pdf = /\.pdf$/i;
let db: Backend, win: BrowserWindow;
let online: Promise<ReturnType<typeof import("./online")["createOnline"]>> | undefined;
const getOnline = () => online ??= import("./online").then(module =>
  module.createOnline(db, app.getPath("userData"), url => shell.openExternal(url)),
);
let pdfRenderer: PdfRenderer | undefined;
const getPdfRenderer = () => pdfRenderer ??= new PdfRenderer();
const assets = new Map<string, string>(),
  indices = new Map<string, string[]>();
const pending = new Map<string, Promise<string>>();
let running = 0;
const queue: Array<() => void> = [];
const nodes = new Map<string, string>();
const nodeParents = new Map<string, string>();
const pdfFiles = new Map<string, string>();
const order = new Intl.Collator("zh", { numeric: true });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const asset = (file: string) => {
  const id = hash(file);
  assets.set(id, file);
  return "manga://asset/" + id;
};
async function target(file: string) {
  if (/\.lnk$/i.test(file)) {
    const seen = new Set<string>();
    while (/\.lnk$/i.test(file)) {
      if (seen.has(file) || seen.size >= 32) throw Error("快捷方式循环");
      seen.add(file);
      const next = shell.readShortcutLink(file).target;
      if (!next) throw Error("快捷方式目标为空");
      file = path.resolve(
        path.dirname(file),
        next.replace(/%([^%]+)%/g, (whole, name) => {
          const key = Object.keys(process.env).find(
            (k) => k.toLowerCase() === name.toLowerCase(),
          );
          return key ? process.env[key]! : whole;
        }),
      );
    }
  }
  return file;
}
async function seven(args: string[]): Promise<Buffer> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  else running++;
  try {
    return await new Promise((resolve, reject) => {
      const exe = app.isPackaged
        ? path.join(process.resourcesPath, "7zip/7z.exe")
        : require("7zip-bin-full").path7z;
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        child.kill();
      }, 120000);
      child.stderr.resume();
      child.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 128 * 1024 * 1024) {
          stopped = true;
          child.kill();
        } else chunks.push(c);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 && !stopped
          ? resolve(Buffer.concat(chunks))
          : reject(Error("压缩包损坏、加密或读取失败"));
      });
    });
  } finally {
    const next = queue.shift();
    if (next) next();
    else running--;
  }
}
const safeEntry = (name: string) =>
  !!name &&
  !name.replace(/\\/g, "/").split("/").includes("..") &&
  !/^[/\\]|^[a-z]:/i.test(name);
async function entries(file: string): Promise<string[]> {
  const text = (await seven(["l", "-slt", "-sccUTF-8", "--", file]))
    .toString("utf8")
    .split("----------")
    .slice(1)
    .join("");
  return text
    .split(/\r?\n\s*\r?\n/)
    .filter((block) => !/^Folder = \+$/m.test(block))
    .map((block) => /^Path = (.+)$/m.exec(block)?.[1]?.trim() || "")
    .filter(safeEntry);
}
// A compressed TAR has two layers: decompress the stream, then list the TAR.
// Intermediate paths use our own hashes; archive entry paths are never written.
async function unwrap(
  file: string,
  depth = 0,
  originalName = path.basename(file),
): Promise<string> {
  if (!wrappedArchive.test(file)) return file;
  if (depth >= 4) throw Error("压缩层级过深");
  const stat = await fs.stat(file);
  const key = hash(file + stat.size + stat.mtimeMs);
  const list = await entries(file);
  // BZip2/XZ/Zstandard streams do not contain a filename. 7-Zip's listing
  // therefore has no Path field; infer it from the original outer filename.
  if (list.length > 1) throw Error("压缩流没有唯一内容");
  const alias = /\.(tgz|tbz2?|txz|tzst)$/i.test(originalName);
  const inferred = originalName.replace(wrappedArchive, alias ? ".tar" : "");
  const name = list[0] || inferred;
  const ext = alias ? ".tar" : path.extname(name).toLowerCase();
  if (!image.test(name) && !archive.test(name) && ext !== ".tar")
    throw Error("压缩流内容不是漫画图片或压缩包");
  const dest = path.join(app.getPath("userData"), "streams", key + ext);
  try {
    await fs.access(dest);
  } catch {
    if (!pending.has(dest))
      pending.set(
        dest,
        (async () => {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          const bytes = await seven(["x", "-so", "-y", "--", file]);
          await fs.writeFile(dest + ".part", bytes);
          await fs.rename(dest + ".part", dest);
          void trimCache(path.dirname(dest), 512 * 1024 * 1024, dest);
          return dest;
        })().finally(() => pending.delete(dest)),
      );
    await pending.get(dest);
  }
  return unwrap(dest, depth + 1, name);
}
async function pages(file: string) {
  file = await target(file);
  let stat = await fs.stat(file);
  if (stat.isDirectory()) {
    const files = (await fs.readdir(file))
      .filter((n) => image.test(n))
      .sort(order.compare);
    return files.map((name, i) => ({
      id: String(i),
      title: name,
      url: asset(path.join(file, name)),
    }));
  }
  if (pdf.test(file)) {
    const key = hash(file + stat.size + stat.mtimeMs);
    pdfFiles.set(key, file);
    const count = await getPdfRenderer().count(file);
    return Array.from({ length: count }, (_, i) => ({
      id: String(i),
      title: `${i + 1}.png`,
      url: `manga://pdf/${key}/${i}`,
    }));
  }
  if (wrappedArchive.test(file)) {
    file = await unwrap(file);
    stat = await fs.stat(file);
  }
  if (image.test(file))
    return [{ id: "0", title: path.basename(file), url: asset(file) }];
  const key = hash(file + stat.size + stat.mtimeMs);
  if (!indices.has(key))
    indices.set(
      key,
      (await entries(file))
        .filter((name) => image.test(name))
        .sort(order.compare),
    );
  assets.set(key, file);
  return indices.get(key)!.map((title, i) => ({
    id: String(i),
    title,
    url: `manga://page/${key}/${i}`,
  }));
}
async function resolve(url: string) {
  const u = new URL(url);
  if (u.hostname === "pdf") return pdfPage(u);
  if (u.hostname === "asset") {
    const f = assets.get(u.pathname.slice(1));
    if (!f) throw Error("Unknown resource");
    return f;
  }
  if (u.hostname === "thumb") {
    return path.join(
      app.getPath("userData"),
      "thumbs",
      u.pathname.slice(1) + ".jpg",
    );
  }
  const [key, index] = u.pathname.slice(1).split("/");
  const file = assets.get(key),
    entry = indices.get(key)?.[Number(index)];
  if (!file || !entry) throw Error("Unknown page");
  const dest = path.join(
    app.getPath("userData"),
    "pages",
    key + "-" + index + path.extname(entry),
  );
  try {
    await fs.access(dest);
    return dest;
  } catch {}
  if (!pending.has(dest))
    pending.set(
      dest,
      (async () => {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const bytes = await seven([
          "x",
          "-so",
          "-y",
          "-spd",
          "--",
          file,
          entry,
        ]);
        await fs.writeFile(dest + ".part", bytes);
        await fs.rename(dest + ".part", dest);
        void trimCache(path.dirname(dest), 512 * 1024 * 1024, dest);
        return dest;
      })().finally(() => pending.delete(dest)),
    );
  return pending.get(dest)!;
}
async function pdfPage(url: URL, thumbnail = false) {
  const [key, value] = url.pathname.slice(1).split("/");
  const file = pdfFiles.get(key),
    index = Number(value);
  if (!file || !/^\d+$/.test(value) || !Number.isSafeInteger(index))
    throw Error("Unknown PDF page");
  const root = path.join(
    app.getPath("userData"),
    thumbnail ? "pdf-thumbs" : "pdf-pages",
  );
  const dest = path.join(root, `${key}-${index}.png`);
  try {
    await fs.access(dest);
    return dest;
  } catch {}
  if (!pending.has(dest))
    pending.set(
      dest,
      getPdfRenderer()
        .render(file, index, dest, thumbnail)
        .then(() => {
          void trimCache(root, (thumbnail ? 128 : 512) * 1024 * 1024, dest);
          return dest;
        })
        .finally(() => pending.delete(dest)),
    );
  return pending.get(dest)!;
}
app.whenReady().then(async () => {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  db = new Backend(path.join(app.getPath("userData"), "library.sqlite"));
  protocol.handle("manga", async (req) => {
    try {
      const url = new URL(req.url);
      if (url.hostname === "online") return await (await getOnline()).imageResponse(url);
      return net.fetch(pathToFileURL(await resolve(req.url)).href);
    } catch {
      return new Response("Unavailable", { status: 404 });
    }
  });
  // Index the selected directory and its immediate readable entries only.
  // Deeper collections are discovered when their node is clicked in the tree.
  const indexOneLevel = async (file: string) => {
    const real = await fs.realpath(await target(file));
    const stat = await fs.stat(real);
    const inspectBook = async (entry: string) => {
      const resolved = await fs.realpath(await target(entry));
      const info = await fs.stat(resolved);
      if (info.isDirectory()) {
        if (!(await fs.readdir(resolved)).some(name => image.test(name))) return;
      } else if (!archive.test(resolved) && !image.test(resolved) && !pdf.test(resolved)) return;
      return { path: resolved, title: path.basename(entry).replace(/\.lnk$/i, "") };
    };
    const rootBook = await inspectBook(file);
    if (rootBook) await db.prepare("INSERT OR IGNORE INTO books(id,path,title) VALUES(?,?,?)")
      .run(randomUUID(), rootBook.path, rootBook.title);
    if (!stat.isDirectory()) return;
    const excluded: Array<{ path: string }> = await db.prepare("SELECT path FROM source_exclusions").all();
    const exclusions = new Set(excluded.map(row => path.resolve(row.path).toLowerCase()));
    const children = await fs.readdir(real, { withFileTypes: true });
    const candidates = children.filter(child =>
      (child.isDirectory() || child.isSymbolicLink() || archive.test(child.name) || pdf.test(child.name) || /\.lnk$/i.test(child.name)) &&
      !exclusions.has(path.resolve(real, child.name).toLowerCase()));
    for (let i = 0; i < candidates.length; i += 16) {
      const batch = await Promise.all(candidates.slice(i, i + 16).map(child =>
        inspectBook(path.join(real, child.name)).catch(() => undefined)));
      const statements = batch.flatMap(book => book ? [{
        sql: "INSERT OR IGNORE INTO books(id,path,title) VALUES(?,?,?)",
        args: [randomUUID(), book.path, book.title],
      }] : []);
      if (statements.length) await db.call("transaction", { statements });
    }
  };
  const handlers: Record<string, (...args: any[]) => any> = {
    cover: async (id: string) => {
      z.string().uuid().parse(id);
      const book = await db.prepare("SELECT * FROM books WHERE id=?").get(id);
      if (!book) throw Error("Unknown book");
      const list = await pages(book.path);
      return list[0] ? handlers.thumb(list[0].url) : "";
    },
    sources: async () => {
      const roots = await db
        .prepare("SELECT * FROM sources ORDER BY title")
        .all();
      return Promise.all(
        roots.map(async (r: any) => {
          nodes.set(r.id, r.path);
          try {
            const real = await fs.realpath(await target(r.path));
            return {
              id: r.id,
              title: r.title.replace(/\.lnk$/i, ""),
              leaf: (await fs.stat(real)).isFile(),
              bookId: (await db.prepare("SELECT id FROM books WHERE path=?").get(real))?.id,
            };
          } catch {
            // One unavailable source must not prevent healthy sources from loading.
            return {
              id: r.id,
              title: r.title.replace(/\.lnk$/i, ""),
              leaf: true,
            };
          }
        }),
      );
    },
    children: async (id: string) => {
      z.string().parse(id);
      const source = nodes.get(id);
      if (!source) throw Error("Unknown source");
      const real = await fs.realpath(await target(source));
      const children = await fs.readdir(real, { withFileTypes: true });
      const excluded: Array<{ path: string }> = await db.prepare("SELECT path FROM source_exclusions").all();
      const exclusions = new Set(excluded.map(row => path.resolve(row.path).toLowerCase()));
      const candidates = children.filter(child =>
        (child.isDirectory() || child.isSymbolicLink() || archive.test(child.name) ||
          pdf.test(child.name) || /\.lnk$/i.test(child.name)) &&
        !exclusions.has(path.resolve(real, child.name).toLowerCase()),
      ).sort((a, b) => order.compare(a.name, b.name));
      const result: Array<TreeNode & { resolved: string }> = [];
      // Bound concurrent filesystem checks so large folders do not block the UI
      // behind thousands of sequential I/O round trips.
      for (let i = 0; i < candidates.length; i += 32) {
        const batch = await Promise.all(candidates.slice(i, i + 32).map(async child => {
          const file = path.join(real, child.name), key = hash(file);
          try {
            const resolved = await fs.realpath(await target(file));
            const stat = await fs.stat(resolved);
            if (!stat.isDirectory() && !archive.test(resolved) &&
                !image.test(resolved) && !pdf.test(resolved)) return null;
            nodes.set(key, file);
            nodeParents.set(key, id);
            return { id: key, title: child.name.replace(/\.lnk$/i, ""), leaf: stat.isFile(), resolved };
          } catch { return null; /* Broken shortcuts do not hide healthy siblings. */ }
        }));
        result.push(...batch.filter((node): node is TreeNode & { resolved: string } => node !== null));
      }
      // Resolve canonical IDs in batches, including shortcut targets outside the root.
      // This keeps existing source/book identity without querying SQLite per child.
      const ids = new Map<string, string>();
      for (let i = 0; i < result.length; i += 300) {
        const paths = [...new Set(result.slice(i, i + 300).map(node => node.resolved))];
        const books: Array<{ id: string; path: string }> = await db.prepare(
          `SELECT id,path FROM books WHERE path IN (${paths.map(() => "?").join(",")})`,
        ).all(...paths);
        for (const book of books) ids.set(book.path, book.id);
      }
      return result.map(({ resolved, ...node }) => ({ ...node, bookId: ids.get(resolved) }));
    },
    list: () => db.prepare("SELECT * FROM books ORDER BY title").all(),
    openSource: async (id: string) => {
      z.string().parse(id);
      const source = nodes.get(id);
      if (!source) throw Error("来源不存在 / Source not found");
      const real = await fs.realpath(await target(source));
      const stat = await fs.stat(real);
      if (
        !stat.isDirectory() &&
        !archive.test(real) &&
        !image.test(real) &&
        !pdf.test(real)
      )
        throw Error("不支持此格式 / Unsupported format");
      const list = await pages(real);
      if (!list.length && stat.isDirectory()) {
        await indexOneLevel(source);
        return null;
      }
      if (!list.length)
        throw Error("文件中没有可阅读的图片 / No readable pages");
      await db
        .prepare("INSERT OR IGNORE INTO books(id,path,title) VALUES(?,?,?)")
        .run(randomUUID(), real, path.basename(source).replace(/\.lnk$/i, ""));
      return db.prepare("SELECT * FROM books WHERE path=?").get(real);
    },
    forgetSource: async (id: string) => {
      z.string().parse(id);
      const source =
        nodes.get(id) ||
        (await db.prepare("SELECT path FROM sources WHERE id=?").get(id))?.path;
      if (!source) throw Error("来源不存在 / Source not found");
      let real = source;
      try {
        real = await fs.realpath(await target(source));
      } catch {}
      const within = (file: string, root: string) => {
        const rel = path.relative(root, file);
        return (
          rel === "" ||
          (!rel.startsWith(".." + path.sep) &&
            rel !== ".." &&
            !path.isAbsolute(rel))
        );
      };
      const books = await db.prepare("SELECT id,path FROM books").all();
      const roots = await db.prepare("SELECT id,path FROM sources").all();
      await db.call("transaction", {
        statements: [
          {
            sql: "INSERT OR IGNORE INTO source_exclusions(path) VALUES(?)",
            args: [source],
          },
          ...roots
            .filter((r: any) => within(r.path, source))
            .map((r: any) => ({
              sql: "DELETE FROM sources WHERE id=?",
              args: [r.id],
            })),
          ...books
            .filter((b: any) => within(b.path, real))
            .map((b: any) => ({
              sql: "DELETE FROM books WHERE id=?",
              args: [b.id],
            })),
        ],
      });
      for (const [key, file] of nodes)
        if (within(file, source)) nodes.delete(key);
    },
    import: async (mode: "folder" | "files" = "folder") => {
      z.enum(["folder", "files"]).parse(mode);
      const result = await dialog.showOpenDialog(win, {
        properties:
          mode === "files"
            ? ["openFile", "multiSelections"]
            : ["openDirectory", "multiSelections"],
        filters: [
          {
            name: "Manga",
            extensions: [
              "jpg",
              "jpeg",
              "png",
              "webp",
              "avif",
              "gif",
              "bmp",
              "svg",
              "ico",
              "pdf",
              "zip",
              "cbz",
              "rar",
              "cbr",
              "7z",
              "cb7",
              "tar",
              "cbt",
              "gz",
              "gzip",
              "tgz",
              "bz2",
              "bzip2",
              "tbz",
              "tbz2",
              "xz",
              "txz",
              "zst",
              "tzst",
              "cab",
              "lzh",
              "lha",
              "cpio",
              "lnk",
            ],
          },
        ],
      });
      for (const f of result.filePaths) {
        const excluded = await db
          .prepare("SELECT path FROM source_exclusions")
          .all();
        for (const e of excluded) {
          const rel = path.relative(f, e.path);
          if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
            await db
              .prepare("DELETE FROM source_exclusions WHERE path=?")
              .run(e.path);
        }
        const resolved = await fs.realpath(await target(f));
        const stat = await fs.stat(resolved);
        if (
          !stat.isDirectory() &&
          !archive.test(resolved) &&
          !image.test(resolved) &&
          !pdf.test(resolved)
        )
          throw Error("快捷方式目标或文件格式不受支持");
        await db
          .prepare("INSERT OR IGNORE INTO sources(id,path,title) VALUES(?,?,?)")
          .run(hash(f), f, path.basename(f));
        await indexOneLevel(f);
      }
      return handlers.list();
    },
    open: async (id: string) => {
      z.string().uuid().parse(id);
      const book = (await db
        .prepare("SELECT * FROM books WHERE id=?")
        .get(id)) as any;
      if (!book) throw Error("Unknown book");
      const p = await pages(book.path);
      await db.prepare("UPDATE books SET pages=? WHERE id=?").run(p.length, id);
      return p;
    },
    reveal: async (id: string, page: number) => {
      z.string().uuid().parse(id);
      z.number().int().min(0).parse(page);
      const book = await db.prepare("SELECT * FROM books WHERE id=?").get(id);
      if (!book) throw Error("Unknown book");
      const file = await fs.realpath(await target(book.path));
      const stat = await fs.stat(file);
      const list = await pages(file);
      if (!list[page]) throw Error("Unknown page");
      // Explorer can select an original image or archive, but not an entry inside an archive.
      shell.showItemInFolder(
        stat.isDirectory() ? await resolve(list[page].url) : file,
      );
    },
    progress: async (id: string, page: number) => {
      z.number().int().min(0).parse(page);
      await db.prepare("UPDATE books SET progress=? WHERE id=?").run(page, id);
    },
    metadata: async (id: string, tags: string, author: string) => {
      await db
        .prepare("UPDATE books SET tags=?,author=? WHERE id=?")
        .run(
          z.string().max(4096).parse(tags),
          z.string().max(1024).parse(author),
          id,
        );
    },
    thumb: async (url: string) => {
      if (!url.startsWith("manga://")) throw Error("Invalid resource");
      const resource = new URL(url);
      if (resource.hostname === "pdf") return asset(await pdfPage(resource, true));
      const resolvedFile = resource.hostname === "online"
        ? await (await getOnline()).resourceFile(resource, true) : await resolve(url);
      const fingerprint = await fs.stat(resolvedFile);
      const id = hash(url + fingerprint.size + fingerprint.mtimeMs),
        dest = path.join(app.getPath("userData"), "thumbs", id + ".jpg");
      try {
        await fs.access(dest);
      } catch {
        if (!pending.has(dest)) pending.set(dest, (async () => {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          const temporary = dest + ".part";
          try {
            await db.call("thumb", { file: resolvedFile, dest: temporary });
            await fs.rename(temporary, dest);
            void trimCache(path.dirname(dest), 128 * 1024 * 1024, dest);
            return "manga://thumb/" + id;
          } catch { return url; }
        })().finally(() => pending.delete(dest)));
        return pending.get(dest)!;
      }
      return "manga://thumb/" + id;
    },
  };
  let ai: Promise<Awaited<ReturnType<typeof import("./ai")["createAiHandlers"]>>> | undefined;
  const getAi = () => ai ??= import("./ai").then(module => module.createAiHandlers({
    db, root: path.join(app.getPath("userData"), "ai"),
    defaults: app.isPackaged ? path.join(process.resourcesPath, "ai") : path.join(__dirname, "../../resources/ai"),
    pages, resolve, asset,
  })).catch(error => { ai = undefined; throw error; });
  Object.assign(
    handlers,
    Object.fromEntries(([
      "onlineSources", "onlineSaveSource", "onlineRemoveSource", "onlineList", "onlineOpen",
      "onlinePages", "onlineProgress", "onlineCache", "onlineTasks", "onlineCancel", "onlineExternal",
    ] as const).map(name => [name, async (...args: any[]) => {
      const handler = (await getOnline()).handlers[name] as (...values: any[]) => any;
      return handler(...args);
    }])),
    createPathRepair({ db, nodes, target, pages, getWindow: () => win,
      helperDirectory: app.isPackaged ? path.join(process.resourcesPath, "everything") : path.join(__dirname, "../../resources/everything") }),
    Object.fromEntries(["aiProfiles", "aiConfigure", "aiHistory", "aiGet", "aiOriginal", "aiStart", "aiSave", "aiDelete", "aiRemove"]
      .map(name => [name, async (...args: any[]) => {
        const api = await getAi();
        return (api as Record<string, (...values: any[]) => any>)[name](...args);
      }])),
    { locateBook: createSourceLocator({ db, nodes, parents: nodeParents, target, children: id => handlers.children(id) }) },
    createReadingChoiceHandlers({ db, nodes, target, pages, thumb: (url) => handlers.thumb(url) }),
    createLibraryHandlers({
      db,
      nodes,
      target,
      pages,
      resolve,
      thumb: (url) => handlers.thumb(url),
      getWindow: () => win,
    }),
  );
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle("manga:" + name, (event, ...args) => {
      if (event.sender !== win.webContents) throw Error("Forbidden");
      return handler(...args);
    });
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#11151d",
    title: "Mini Manga",
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(__dirname, "../../resources/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));
});
app.on("window-all-closed", () => app.quit());
