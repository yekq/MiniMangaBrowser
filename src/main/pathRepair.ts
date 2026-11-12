import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import type { Backend } from "./backend";
import type { Book, Page, RepairCandidate, RepairInfo, RepairResult, RepairTarget } from "../contracts";
import { searchEverything } from "./everything";

const fileType = /\.(zip|cbz|rar|cbr|7z|cb7|tar|cbt|gz|gzip|tgz|bz2|bzip2|tbz|tbz2|xz|txz|zst|tzst|cab|lzh|lha|cpio|pdf|jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i;
const imageType = /\.(jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i;
const targetSchema = z.object({ kind: z.enum(["book", "source", "favorite", "ai"]), id: z.string().min(1).max(256) }).strict();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => path.relative(a, b) === "";
const within = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
type Row = Record<string, any>;
type Context = RepairInfo & { target: RepairTarget; sourceId?: string; favoriteId?: string; favoritePage?: string };
type Dependencies = { db: Backend; nodes: Map<string, string>; helperDirectory: string;
  target(file: string): Promise<string>; pages(file: string): Promise<Page[]>; getWindow(): BrowserWindow };

export function createPathRepair({ db, nodes, helperDirectory, target, pages, getWindow }: Dependencies) {
  const candidates = new Map<string, { targetKey: string; oldPath: string; file: string; expires: number }>();
  const context = async (input: RepairTarget): Promise<Context> => {
    const item = targetSchema.parse(input);
    let book: Book | undefined, file = "", title = "", page: number | undefined;
    let sourceId: string | undefined, favoriteId: string | undefined, favoritePage: string | undefined;
    let originalId: string | undefined;
    if (item.kind === "book") {
      book = await db.prepare("SELECT * FROM books WHERE id=?").get(item.id);
      if (!book) throw Error("书库记录已移除；请从保留的收藏或AI记录找回 / Book record was removed");
    } else if (item.kind === "source") {
      const source = await db.prepare("SELECT * FROM sources WHERE id=?").get(item.id);
      file = source?.path || nodes.get(item.id) || ""; title = source?.title || path.basename(file); sourceId = item.id;
      if (!file) throw Error("来源记录已失效 / Source record unavailable");
    } else if (item.kind === "favorite") {
      const favorite = await db.prepare("SELECT * FROM favorites WHERE id=?").get(item.id);
      if (!favorite) throw Error("收藏记录已移除 / Favorite record was removed");
      file = favorite.kind === "source" ? favorite.source_path : favorite.book_path;
      title = favorite.title; page = favorite.page_index ?? undefined; favoritePage = favorite.page_title || undefined;
      sourceId = favorite.source_id || undefined; favoriteId = favorite.id; originalId = favorite.book_id || undefined;
      if (originalId) book = await db.prepare("SELECT * FROM books WHERE id=?").get(originalId);
    } else {
      const row = await db.prepare("SELECT data FROM ai_edits WHERE id=?").get(item.id);
      if (!row) throw Error("AI记录已移除 / AI record was removed");
      const record = JSON.parse(row.data);
      originalId = record.bookId; title = record.bookTitle; file = record.bookPath; page = record.page;
      book = await db.prepare("SELECT * FROM books WHERE id=?").get(originalId);
    }
    if (book) { file = book.path; title = book.title; }
    if (!file || !path.isAbsolute(file)) throw Error("记录没有原路径，请手动重新导入 / Original path is unavailable");
    file = path.resolve(await target(file));
    if (!book && !originalId) book = await db.prepare("SELECT * FROM books WHERE path=?").get(file);
    let exists = false;
    try { await fs.stat(file); exists = true; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
    const missingRecord = !book && (item.kind === "ai" || !!originalId);
    const base = path.basename(file);
    return { target: item, title: title || base, oldPath: file, keyword: fileType.test(base) ? base.replace(/\.[^.]+$/, "") : base,
      available: exists && !missingRecord, missingRecord, bookId: book?.id || originalId,
      page: page ?? book?.progress, sourceId, favoriteId, favoritePage };
  };
  const register = (info: Context, hit: { path: string; kind: "folder" | "file"; size?: number }): RepairCandidate => {
    for (const [id, entry] of candidates) if (entry.expires < Date.now()) candidates.delete(id);
    while (candidates.size >= 1000) candidates.delete(candidates.keys().next().value!);
    const id = randomUUID();
    candidates.set(id, { targetKey: JSON.stringify(info.target), oldPath: info.oldPath, file: hit.path, expires: Date.now() + 600000 });
    return { id, title: path.basename(hit.path), path: hit.path, kind: hit.kind, size: hit.size };
  };
  let repairing = false;
  return {
    repairInfo: async (input: RepairTarget): Promise<RepairInfo> => context(input),
    repairSearch: async (input: RepairTarget, keyword: string) => {
      const info = await context(input);
      if (info.available) throw Error("原路径已恢复，请重新打开 / Original path is available again");
      const result = await searchEverything(z.string().max(500).parse(keyword), helperDirectory);
      return { total: result.total, items: result.items.filter(hit => path.isAbsolute(hit.path) &&
        !same(hit.path, path.parse(hit.path).root) && (info.missingRecord || !same(hit.path, info.oldPath)) &&
        (hit.kind === "folder" || fileType.test(hit.path) || /\.lnk$/i.test(hit.path))).map(hit => register(info, hit)) };
    },
    repairBrowse: async (input: RepairTarget, mode: "folder" | "file") => {
      const info = await context(input); z.enum(["folder", "file"]).parse(mode);
      const result = await dialog.showOpenDialog(getWindow(), { title: "选择漫画的新位置 / Select comic location",
        properties: mode === "folder" ? ["openDirectory"] : ["openFile"],
        filters: [{ name: "Manga", extensions: ["zip", "cbz", "rar", "cbr", "7z", "pdf", "jpg", "png", "webp", "svg"] }, { name: "All", extensions: ["*"] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      return register(info, { path: result.filePaths[0], kind: mode });
    },
    repairApply: async (input: RepairTarget, candidateId: string): Promise<RepairResult> => {
      if (repairing) throw Error("另一项路径修复正在进行 / Another repair is running");
      repairing = true;
      try {
        const info = await context(input), selected = candidates.get(z.string().uuid().parse(candidateId));
        if (!selected || selected.expires < Date.now() || selected.targetKey !== JSON.stringify(info.target) || !same(selected.oldPath, info.oldPath))
          throw Error("搜索结果已过期，请重新搜索 / Search result expired");
        if (info.available) throw Error("原路径已恢复或已被修正，请重新打开 / Location is already available");
        const destination = await fs.realpath(await target(selected.file)), stat = await fs.stat(destination);
        if (same(destination, path.parse(destination).root) || (!stat.isDirectory() && !fileType.test(destination)))
          throw Error("请选择漫画目录或支持的漫画文件 / Select a comic folder or supported file");
        const list = await pages(destination);
        if (!list.length && (info.bookId || !stat.isDirectory())) throw Error("所选位置没有可阅读的图片 / No readable pages at this location");
        const rewrite = (file: string | null | undefined) => {
          if (!file) return file;
          if (same(file, info.oldPath)) return destination;
          if (stat.isDirectory() && !fileType.test(info.oldPath) && within(file, info.oldPath)) return path.join(destination, path.relative(info.oldPath, file));
          return file;
        };
        const books: Row[] = await db.prepare("SELECT * FROM books").all();
        const sources: Row[] = await db.prepare("SELECT * FROM sources").all();
        const favorites: Row[] = await db.prepare("SELECT * FROM favorites").all();
        const hasAi = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_edits'").get();
        const aiRows: Row[] = hasAi ? await db.prepare("SELECT * FROM ai_edits").all() : [];
        const exclusions: Row[] = await db.prepare("SELECT * FROM source_exclusions").all();
        const originalBooks = [...books];
        if (info.bookId && !books.some(book => book.id === info.bookId)) books.push({ id: info.bookId, path: info.oldPath,
          title: info.title, pages: list.length, progress: info.page || 0, tags: "", author: "" });
        const statements: Array<{ sql: string; args: any[] }> = [], checks: any[] = [];
        const before: Record<string, Row[]> = { books: [], sources: [], favorites: [], ai_edits: [] };
        const insert = (table: string, row: Row) => ({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) });
        const recordChange = (table: string, rows: Row[], output: Row) => {
          for (const row of rows) {
            before[table].push(row);
            checks.push({ sql: `SELECT * FROM ${table} WHERE id=?`, args: [row.id], expected: row });
            statements.push({ sql: `DELETE FROM ${table} WHERE id=?`, args: [row.id] });
          }
          statements.push(insert(table, output));
        };
        const group = (rows: Row[], key: (row: Row) => string) => {
          const groups = new Map<string, Row[]>();
          for (const row of rows) { const id = key(row); groups.set(id, [...(groups.get(id) || []), row]); }
          return [...groups.values()];
        };
        const bookIds = new Map<string, string>(), repairedBooks = new Map<string, Book>();
        for (const cohort of group(books, row => String(rewrite(row.path)).toLowerCase())) {
          if (!cohort.some(row => rewrite(row.path) !== row.path || row.id === info.bookId && info.missingRecord)) continue;
          const preferred = cohort.find(row => row.id === info.bookId) || cohort.find(row => rewrite(row.path) !== row.path)!;
          const merged: Row = { ...preferred, path: rewrite(preferred.path),
            tags: [...new Set(cohort.flatMap(row => String(row.tags || "").split(/[,;，]/)).map(v => v.trim()).filter(Boolean))].join(", "),
            author: [...new Set(cohort.map(row => row.author).filter(Boolean))].join(" / "),
            progress: Math.max(...cohort.map(row => row.progress || 0)) };
          if (same(merged.path, destination)) { merged.pages = list.length; merged.progress = Math.max(0, Math.min(merged.progress, list.length - 1)); }
          const existing = cohort.filter(row => originalBooks.some(old => old.id === row.id));
          if (!existing.some(row => row.id === preferred.id)) checks.push({ sql: "SELECT * FROM books WHERE id=?", args: [preferred.id], expected: null });
          recordChange("books", existing, merged);
          for (const row of cohort) bookIds.set(row.id, merged.id);
          repairedBooks.set(merged.id, merged as Book);
        }
        const resolvedSources = new Map<string, string>();
        for (const source of sources) {
          try { resolvedSources.set(source.id, path.resolve(await target(source.path))); } catch {}
        }
        const mappedSource = (row: Row) => rewrite(resolvedSources.get(row.id) || row.path) !== (resolvedSources.get(row.id) || row.path)
          ? rewrite(resolvedSources.get(row.id) || row.path) : row.path;
        const sourceIds = new Map<string, string>();
        const nodeChanges = new Map<string, string>();
        let sourceId = info.sourceId;
        for (const cohort of group(sources, row => String(mappedSource(row)).toLowerCase())) {
          if (!cohort.some(row => mappedSource(row) !== row.path)) continue;
          const preferred = cohort.find(row => row.id === info.sourceId) || cohort.find(row => mappedSource(row) !== row.path)!;
          const merged: Row = { ...preferred, path: mappedSource(preferred) };
          recordChange("sources", cohort, merged);
          for (const row of cohort) { sourceIds.set(row.id, merged.id); nodeChanges.set(row.id, merged.path); }
        }
        sourceId = sourceId ? sourceIds.get(sourceId) || sourceId : undefined;
        if (!sources.some(source => within(destination, mappedSource(source))) || sourceId && !sources.some(source => source.id === sourceId)) {
          const existing = sources.find(source => same(mappedSource(source), destination));
          sourceId = existing ? sourceIds.get(existing.id) || existing.id : sourceId || hash(destination);
          if (!existing) statements.push({ sql: "INSERT OR IGNORE INTO sources(id,path,title) VALUES(?,?,?)", args: [sourceId, destination, path.basename(destination)] });
        }
        if (info.sourceId && sourceId) sourceIds.set(info.sourceId, sourceId);
        const favoriteIds = new Map<string, string>();
        const mappedFavorites = favorites.map(row => {
          const id = bookIds.get(row.book_id) || row.book_id;
          const copy: Row = { ...row, book_id: id, book_path: rewrite(row.book_path), source_path: rewrite(row.source_path),
            source_id: sourceIds.get(row.source_id) || row.source_id };
          if (id && repairedBooks.has(id)) copy.book_path = repairedBooks.get(id)!.path;
          if (copy.kind === "source" && sourceIds.has(row.source_id)) {
            const source = sources.find(source => source.id === row.source_id); copy.source_path = source ? mappedSource(source) : destination;
          }
          if (copy.kind === "page" && copy.book_path && same(copy.book_path, destination)) {
            let page = list.findIndex(page => page.title === copy.page_title);
            if (page < 0) { const matches = list.map((page, index) => ({ page, index })).filter(({ page }) => path.basename(page.title) === path.basename(copy.page_title || "")); if (matches.length === 1) page = matches[0].index; }
            if (page >= 0) { copy.page_index = page; copy.page_title = list[page].title; }
          }
          copy.target_key = hash(JSON.stringify([copy.kind, copy.kind === "source" ? copy.source_path : copy.book_path, copy.page_title]));
          return copy;
        });
        for (const cohort of group(mappedFavorites, row => row.target_key)) {
          if (!cohort.some(row => JSON.stringify(row) !== JSON.stringify(favorites.find(old => old.id === row.id)))) continue;
          const preferred = cohort.find(row => row.id === info.favoriteId) || cohort.find(row => favorites.find(old => old.id === row.id)?.target_key !== row.target_key) || cohort[0];
          const merged: Row = { ...preferred, rating: Math.max(...cohort.map(row => row.rating)), updated_at: Math.max(...cohort.map(row => row.updated_at)) };
          recordChange("favorites", favorites.filter(row => cohort.some(item => item.id === row.id)), merged);
          for (const row of cohort) favoriteIds.set(row.id, merged.id);
        }
        for (const row of aiRows) {
          const record = JSON.parse(row.data), changedPath = rewrite(record.bookPath);
          if (!bookIds.has(record.bookId) && changedPath === record.bookPath) continue;
          if (record.status === "generating") throw Error("相关AI任务仍在生成，请完成后修复 / Wait for the AI job to finish");
          record.bookId = bookIds.get(record.bookId) || record.bookId;
          record.bookPath = repairedBooks.get(record.bookId)?.path || changedPath;
          record.destination = rewrite(record.destination);
          if (same(record.bookPath, destination) && !stat.isDirectory()) record.destination = imageType.test(destination) ? path.dirname(destination) : path.join(path.dirname(destination), path.parse(destination).name + "_AI");
          if (record.savedPath && rewrite(record.savedPath) !== record.savedPath) {
            try { await fs.access(rewrite(record.savedPath)!); record.savedPath = rewrite(record.savedPath); } catch {}
          }
          before.ai_edits.push(row); checks.push({ sql: "SELECT * FROM ai_edits WHERE id=?", args: [row.id], expected: row });
          statements.push({ sql: "UPDATE ai_edits SET book_id=?,data=? WHERE id=?", args: [record.bookId, JSON.stringify(record), row.id] });
        }
        for (const row of exclusions) if (rewrite(row.path) !== row.path) statements.push(
          { sql: "DELETE FROM source_exclusions WHERE path=?", args: [row.path] },
          { sql: "INSERT OR IGNORE INTO source_exclusions(path) VALUES(?)", args: [rewrite(row.path)] });
        statements.push({ sql: "DELETE FROM source_exclusions WHERE path=?", args: [destination] });
        statements.push({ sql: "CREATE TABLE IF NOT EXISTS path_repairs(id TEXT PRIMARY KEY,created INTEGER,old_path TEXT,new_path TEXT,before_data TEXT)", args: [] },
          { sql: "INSERT INTO path_repairs VALUES(?,?,?,?,?)", args: [randomUUID(), Date.now(), info.oldPath, destination, JSON.stringify(before)] });
        await db.call("transaction", { statements, checks });
        for (const [id, file] of nodeChanges) nodes.set(id, file);
        for (const [id, file] of nodes) if (rewrite(file) !== file) nodes.set(id, rewrite(file)!);
        if (sourceId) nodes.set(sourceId, destination);
        candidates.delete(candidateId);
        const repairedId = info.bookId ? bookIds.get(info.bookId) || info.bookId : undefined;
        const book = repairedId ? await db.prepare("SELECT * FROM books WHERE id=?").get(repairedId) : undefined;
        const favoriteId = info.favoriteId ? favoriteIds.get(info.favoriteId) || info.favoriteId : undefined;
        const favorite = favoriteId ? await db.prepare("SELECT page_index FROM favorites WHERE id=?").get(favoriteId) : undefined;
        return { book, sourceId, favoriteId, page: favorite?.page_index ?? info.page };
      } finally { repairing = false; }
    },
  };
}
