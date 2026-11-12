import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Book, TreeNode } from "../contracts";
import type { Backend } from "./backend";

const hash = (file: string) => createHash("sha256").update(file).digest("hex");
const within = (file: string, parent: string) => {
  const relative = path.relative(parent, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};

export function createSourceLocator({ db, nodes, parents, target, children }: {
  db: Backend; nodes: Map<string, string>; parents: Map<string, string>;
  target(file: string): Promise<string>;
  children(id: string): Promise<TreeNode[]>;
}) {
  return async (bookId: string): Promise<string[]> => {
    z.string().uuid().parse(bookId);
    const book: Book | undefined = await db.prepare("SELECT * FROM books WHERE id=?").get(bookId);
    if (!book) throw Error("漫画不存在 / Book not found");
    const current = await fs.realpath(await target(book.path));
    const roots: Array<{ id: string; path: string }> = await db.prepare("SELECT id,path FROM sources ORDER BY path").all();
    const rootIds = new Set(roots.map(root => root.id));
    const candidates: Array<{ chain: string[]; real: string }> = [];
    for (const root of roots) {
      nodes.set(root.id, root.path);
      try {
        const real = await fs.realpath(await target(root.path));
        if (within(current, real)) candidates.push({ chain: [root.id], real });
      } catch { /* Offline roots do not prevent locating a healthy book. */ }
    }
    // Preserve a known route through shortcuts whose targets live outside a root.
    if (!candidates.length) for (const [id, file] of nodes) {
      const chain = [id];
      let cursor = id;
      while (!rootIds.has(cursor) && parents.has(cursor) && chain.length < 64) {
        cursor = parents.get(cursor)!;
        if (chain.includes(cursor)) break;
        chain.unshift(cursor);
      }
      if (!rootIds.has(chain[0])) continue;
      try {
        const real = await fs.realpath(await target(file));
        if (within(current, real)) candidates.push({ chain, real });
      } catch {}
    }
    candidates.sort((a, b) => b.real.length - a.real.length || a.chain.length - b.chain.length);
    for (const candidate of candidates) {
      try {
        const chain = [...candidate.chain];
        let real = candidate.real;
        const relative = path.relative(real, current);
        for (const segment of relative ? relative.split(path.sep) : []) {
          const file = path.join(real, segment), id = hash(file);
          const available = await children(chain.at(-1)!);
          if (!available.some(node => node.id === id)) throw Error("Source entry unavailable");
          chain.push(id);
          real = await fs.realpath(await target(file));
        }
        return chain;
      } catch { /* Try another imported route before adding a direct entry. */ }
    }
    // A comic opened from read-next/favorites may have no sidebar source yet.
    // Register only this book; never scan or import its surrounding drive.
    await db.prepare("INSERT OR IGNORE INTO sources(id,path,title) VALUES(?,?,?)")
      .run(hash(current), current, path.basename(current));
    const source = await db.prepare("SELECT id FROM sources WHERE path=?").get(current);
    await db.prepare("DELETE FROM source_exclusions WHERE path=?").run(current);
    nodes.set(source.id, current);
    return [source.id];
  };
}
