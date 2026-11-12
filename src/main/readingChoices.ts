import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Book, Page, ReadingChoices } from "../contracts";
import type { Backend } from "./backend";

const image = /\.(jpe?g|png|webp|avif|gif|bmp|svg|ico)$/i;
const readable = /\.(pdf|zip|cbz|rar|cbr|7z|cb7|tar|cbt|gz|gzip|tgz|bz2|bzip2|tbz|tbz2|xz|txz|zst|tzst|cab|lzh|lha|cpio)$/i;
const order = new Intl.Collator("zh", { numeric: true });
const compare = (a: { title: string }, b: { title: string }) =>
  order.compare(a.title, b.title) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;

export function createReadingChoiceHandlers({ db, nodes, target, pages, thumb }: {
  db: Backend;
  nodes: Map<string, string>;
  target(file: string): Promise<string>;
  pages(file: string): Promise<Page[]>;
  thumb(url: string): Promise<string>;
}) {
  // Only IDs discovered from a registered book's parent gain a cover capability.
  const choices = new Map<string, string>();
  return {
    readingChoices: async (bookId: string): Promise<ReadingChoices> => {
      z.string().uuid().parse(bookId);
      const book: Book | undefined = await db.prepare("SELECT * FROM books WHERE id=?").get(bookId);
      if (!book) throw Error("漫画不存在 / Book not found");
      const current = await fs.realpath(await target(book.path));
      const parent = path.dirname(current);
      const excluded: Array<{ path: string }> = await db.prepare("SELECT path FROM source_exclusions").all();
      const exclusions = new Set(excluded.map(row => key(path.resolve(row.path))));
      const seen = new Set([key(current)]);
      const items: ReadingChoices["items"] = [];
      const children = (await fs.readdir(parent, { withFileTypes: true }))
        .sort((a, b) => compare({ title: a.name }, { title: b.name }));
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink() && !readable.test(child.name) && !/\.lnk$/i.test(child.name)) continue;
        const file = path.join(parent, child.name);
        if (exclusions.has(key(file))) continue;
        try {
          const real = await fs.realpath(await target(file));
          if (seen.has(key(real)) || exclusions.has(key(real))) continue;
          const stat = await fs.stat(real);
          if (stat.isDirectory()) {
            // One level only: collection containers and empty folders are not books.
            const entries = await fs.readdir(real, { withFileTypes: true });
            if (!entries.some(entry => entry.isFile() && image.test(entry.name))) continue;
          } else if (!readable.test(real)) continue;
          const id = createHash("sha256").update(file).digest("hex");
          nodes.set(id, file);
          choices.set(id, file);
          seen.add(key(real));
          items.push({ id, title: child.name.replace(/\.lnk$/i, ""), kind: stat.isDirectory() ? "folder" : "file" });
        } catch { /* An unavailable sibling must not hide healthy choices. */ }
      }
      items.sort(compare);
      return { items, nextId: items.find(item => compare(item, { title: path.basename(current) }) > 0)?.id };
    },
    readingChoiceCover: async (id: string): Promise<string> => {
      z.string().regex(/^[a-f0-9]{64}$/).parse(id);
      const file = choices.get(id);
      if (!file || nodes.get(id) !== file) throw Error("漫画选项已失效 / Choice unavailable");
      const list = await pages(file);
      return list[0] ? thumb(list[0].url) : "";
    },
  };
}
