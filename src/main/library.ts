import { dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Book, Favorite, FavoriteLocation, ItemTarget, Page } from "../contracts";
import type { Backend } from "./backend";

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("book"), bookId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("page"), bookId: z.string().uuid(), page: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("source"), sourceId: z.string().min(1).max(256) }).strict(),
]);
const image = /\.(jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (file: string, parent: string) => {
  const relative = path.relative(parent, file);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};
type FavoriteRow = {
  id: string; target_key: string; kind: ItemTarget["kind"]; title: string; rating: number;
  book_id: string | null; book_path: string | null; source_id: string | null;
  source_path: string | null; page_title: string | null; page_index: number | null;
};
type Dependencies = {
  db: Backend;
  nodes: Map<string, string>;
  target(file: string): Promise<string>;
  pages(file: string): Promise<Page[]>;
  resolve(url: string): Promise<string>;
  thumb(url: string): Promise<string>;
  getWindow(): BrowserWindow;
};

export function createLibraryHandlers({ db, nodes, target, pages, resolve, thumb, getWindow }: Dependencies) {
  const getBook = async (id: string): Promise<Book> => {
    const book = await db.prepare("SELECT * FROM books WHERE id=?").get(id);
    if (!book) throw Error("书籍记录不存在 / Book not found");
    return book;
  };
  const sourcePath = async (id: string): Promise<string> => {
    const file = nodes.get(id) || (await db.prepare("SELECT path FROM sources WHERE id=?").get(id))?.path;
    if (!file) throw Error("目录来源不存在 / Source not found");
    return file;
  };
  const getFavorite = async (id: string): Promise<FavoriteRow> => {
    z.string().uuid().parse(id);
    const row = await db.prepare("SELECT * FROM favorites WHERE id=?").get(id);
    if (!row) throw Error("收藏不存在 / Favorite not found");
    return row;
  };
  const ensureBook = async (file: string, title: string): Promise<Book> => {
    await db.prepare("INSERT OR IGNORE INTO books(id,path,title) VALUES(?,?,?)").run(randomUUID(), file, title);
    return db.prepare("SELECT * FROM books WHERE path=?").get(file);
  };
  const rowFile = (row: FavoriteRow) => row.kind === "source" ? row.source_path! : row.book_path!;
  const pageFor = async (row: FavoriteRow, file: string, knownList?: Page[]) => {
    const list = knownList || await pages(file);
    if (row.kind !== "page") return { list, index: 0 };
    const index = list.findIndex(page => page.title === row.page_title);
    if (index < 0) throw Error("收藏的图片已不存在 / Favorited page no longer exists");
    return { list, index };
  };

  return {
    favorites: async (query = ""): Promise<Favorite[]> => {
      const term = z.string().max(512).parse(query).trim().replace(/[\\%_]/g, "\\$&");
      const rows: FavoriteRow[] = await db.prepare(`SELECT f.* FROM favorites f LEFT JOIN books b ON b.path=f.book_path
        WHERE f.title LIKE ? ESCAPE '\\' OR COALESCE(b.title,'') LIKE ? ESCAPE '\\'
        OR COALESCE(b.tags,'') LIKE ? ESCAPE '\\' OR COALESCE(b.author,'') LIKE ? ESCAPE '\\'
        ORDER BY f.rating DESC,f.updated_at DESC,f.id`).all(...Array(4).fill("%" + term + "%"));
      const result: Favorite[] = [];
      const manifests = new Map<string, Promise<Page[]>>();
      for (const row of rows) {
        const currentBook: Book | undefined = row.book_path
          ? await db.prepare("SELECT * FROM books WHERE path=?").get(row.book_path) : undefined;
        let page = row.page_index ?? undefined, available = true;
        try {
          const file = await fs.realpath(await target(rowFile(row)));
          await fs.access(file);
          if (row.kind === "page") {
            if (!manifests.has(file)) manifests.set(file, pages(file));
            page = (await pageFor(row, file, await manifests.get(file)!)).index;
          }
        } catch { available = false; }
        const targetValue: ItemTarget = row.kind === "source"
          ? { kind: "source", sourceId: row.source_id! }
          : row.kind === "page"
            ? { kind: "page", bookId: currentBook?.id || row.book_id!, page: page ?? 0 }
            : { kind: "book", bookId: currentBook?.id || row.book_id! };
        // A saved source may be a child node, so restore its capability after restart.
        if (row.source_id && row.source_path) nodes.set(row.source_id, row.source_path);
        result.push({ id: row.id, kind: row.kind, title: row.title, rating: row.rating,
          target: targetValue, available, bookId: currentBook?.id || row.book_id || undefined,
          page, sourceId: row.source_id || undefined });
      }
      return result;
    },
    setFavorite: async (input: ItemTarget, rating: number): Promise<void> => {
      const item = targetSchema.parse(input);
      z.number().int().min(0).max(5).parse(rating);
      let book: Book | undefined, source: string | null = null, sourceId: string | null = null;
      let title: string, pageTitle: string | null = null, pageIndex: number | null = null;
      if (item.kind === "source") {
        sourceId = item.sourceId;
        source = await sourcePath(sourceId);
        const real = await fs.realpath(await target(source));
        await fs.access(real);
        book = await db.prepare("SELECT * FROM books WHERE path=?").get(real);
        title = path.basename(source).replace(/\.lnk$/i, "");
      } else {
        book = await getBook(item.bookId);
        await fs.access(await target(book.path));
        title = book.title;
        if (item.kind === "page") {
          const page = (await pages(book.path))[item.page];
          if (!page) throw Error("图片不存在 / Page not found");
          pageTitle = page.title;
          pageIndex = item.page;
          title += " / " + page.title;
        }
      }
      const key = hash(JSON.stringify([item.kind, source || book!.path, pageTitle]));
      await db.prepare(`INSERT INTO favorites(id,target_key,kind,title,rating,book_id,book_path,source_id,source_path,page_title,page_index,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(target_key) DO UPDATE SET title=excluded.title,rating=excluded.rating,
        book_id=excluded.book_id,page_index=excluded.page_index,updated_at=excluded.updated_at`).run(
        randomUUID(), key, item.kind, title, rating, book?.id || null, book?.path || null,
        sourceId, source, pageTitle, pageIndex, Date.now());
    },
    removeFavorite: async (id: string): Promise<void> => {
      z.string().uuid().parse(id);
      await db.prepare("DELETE FROM favorites WHERE id=?").run(id);
    },
    openFavorite: async (id: string): Promise<FavoriteLocation> => {
      const row = await getFavorite(id);
      const file = await fs.realpath(await target(rowFile(row)));
      const stat = await fs.stat(file);
      if (row.kind === "source" && stat.isDirectory()) {
        const direct = await pages(file);
        if (!direct.length) {
          const sourceId = row.source_id || hash(row.source_path!);
          await db.prepare("INSERT OR IGNORE INTO sources(id,path,title) VALUES(?,?,?)").run(sourceId, row.source_path, row.title);
          nodes.set(sourceId, row.source_path!);
          const books: Book[] = await db.prepare("SELECT * FROM books").all();
          return { sourceId, title: row.title, bookIds: books.filter(book => within(book.path, file)).map(book => book.id) };
        }
      }
      const book = await ensureBook(file, row.kind === "source" ? row.title : path.basename(file));
      const { index } = await pageFor(row, file);
      return { book, page: row.kind === "page" ? index : undefined };
    },
    favoriteCover: async (id: string): Promise<string> => {
      try {
        const row = await getFavorite(id);
        const file = await fs.realpath(await target(rowFile(row)));
        const { list, index } = await pageFor(row, file);
        return list[index] ? await thumb(list[index].url) : "";
      } catch { return ""; }
    },
    searchHistory: async (): Promise<string[]> => {
      const rows = await db.prepare("SELECT query FROM search_history ORDER BY used_at DESC,query LIMIT 30").all();
      return rows.map((row: { query: string }) => row.query);
    },
    rememberSearch: async (query: string): Promise<void> => {
      const term = z.string().max(512).parse(query).trim();
      if (!term) return;
      await db.call("transaction", { statements: [
        { sql: "INSERT INTO search_history(query,used_at) VALUES(?,?) ON CONFLICT(query) DO UPDATE SET query=excluded.query,used_at=excluded.used_at", args: [term, Date.now()] },
        { sql: "DELETE FROM search_history WHERE query NOT IN (SELECT query FROM search_history ORDER BY used_at DESC,query LIMIT 30)", args: [] },
      ] });
    },
    clearSearchHistory: async (): Promise<void> => { await db.prepare("DELETE FROM search_history").run(); },
    trash: async (input: ItemTarget): Promise<boolean> => {
      const item = targetSchema.parse(input);
      let file: string;
      if (item.kind === "source") file = await sourcePath(item.sourceId);
      else {
        const book = await getBook(item.bookId);
        const real = await fs.realpath(await target(book.path));
        if (item.kind === "page") {
          const stat = await fs.stat(real);
          if (!stat.isDirectory() && !image.test(real))
            throw Error("压缩包或 PDF 内的页面不能单独移到回收站，请定位原文件后处理。 / Pages inside archives or PDF cannot be trashed individually.");
          const page = (await pages(real))[item.page];
          if (!page) throw Error("图片不存在 / Page not found");
          file = await resolve(page.url);
        } else file = real;
      }
      const stat = await fs.lstat(file);
      const linkOnly = /\.lnk$/i.test(file) || stat.isSymbolicLink();
      const directory = stat.isDirectory() && !linkOnly;
      const answer = await dialog.showMessageBox(getWindow(), {
        type: "warning", title: "Mini Manga", noLink: true,
        message: `将“${path.basename(file)}”移到回收站？ / Move to Recycle Bin?`,
        detail: file + (linkOnly ? "\n仅移动快捷方式，保留目标文件。 / Only the shortcut will be moved." : directory ? "\n文件夹中的全部内容将一起移动。 / All folder contents will be moved." : ""),
        buttons: ["移到回收站 / Move to Recycle Bin", "取消 / Cancel"], defaultId: 1, cancelId: 1,
      });
      if (answer.response !== 0) return false;
      const matched = (candidate: string) => directory ? within(candidate, file) : path.relative(file, candidate) === "";
      const sourceRows: Array<{ id: string; path: string }> = await db.prepare("SELECT id,path FROM sources").all();
      const favoriteRows: FavoriteRow[] = await db.prepare("SELECT * FROM favorites").all();
      const books: Book[] = await db.prepare("SELECT * FROM books").all();
      const sourceIds = new Set<string>(), favoriteIds = new Set<string>();
      const removedBooks = linkOnly ? [] : books.filter(book => matched(book.path));
      const removedBookIds = new Set(removedBooks.map(book => book.id));
      for (const source of sourceRows) {
        if (matched(source.path)) sourceIds.add(source.id);
        else if (!linkOnly) {
          try { if (matched(await fs.realpath(await target(source.path)))) sourceIds.add(source.id); } catch {}
        }
      }
      for (const row of favoriteRows) {
        if (row.source_path && matched(row.source_path)) favoriteIds.add(row.id);
        else if (!linkOnly && row.kind === "source" && row.source_path) {
          try { if (matched(await fs.realpath(await target(row.source_path)))) favoriteIds.add(row.id); } catch {}
        }
        if (linkOnly) continue;
        if (row.book_id && removedBookIds.has(row.book_id)) favoriteIds.add(row.id);
        if (row.book_path && matched(row.book_path)) favoriteIds.add(row.id);
        if (row.kind === "page" && row.book_path && row.page_title && image.test(file)) {
          const pagePath = path.join(row.book_path, row.page_title);
          if (path.relative(file, pagePath) === "") favoriteIds.add(row.id);
        }
      }
      // The OS operation must succeed before changing the library. No unlink/rm
      // fallback is allowed when a volume does not support the Recycle Bin.
      await shell.trashItem(file);
      const statements = [
        ...removedBooks.map(book => ({ sql: "DELETE FROM books WHERE id=?", args: [book.id] })),
        ...Array.from(sourceIds, id => ({ sql: "DELETE FROM sources WHERE id=?", args: [id] })),
        ...Array.from(favoriteIds, id => ({ sql: "DELETE FROM favorites WHERE id=?", args: [id] })),
      ];
      if (statements.length) await db.call("transaction", { statements });
      if (!linkOnly && image.test(file)) {
        const parentBook = books.find(book => path.relative(book.path, path.dirname(file)) === "");
        if (parentBook && !removedBookIds.has(parentBook.id)) {
          const count = (await pages(parentBook.path)).length;
          await db.prepare("UPDATE books SET pages=?,progress=MIN(progress,?) WHERE id=?").run(count, Math.max(0, count - 1), parentBook.id);
        }
      }
      for (const [id, nodePath] of nodes) {
        if (sourceIds.has(id) || matched(nodePath)) nodes.delete(id);
      }
      return true;
    },
  };
}
