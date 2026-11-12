import fs from "node:fs/promises";
import path from "node:path";
type Entry = { size: number; time: number };
type Cache = { files: Map<string, Entry>; total: number; scannedAt: number;
  keep: Map<string, number>; work: Promise<void> };
const caches = new Map<string, Cache>();
const filename = /^[a-f0-9-]+\.[a-z0-9]+$/i;
export function trimCache(root: string, limit: number, keep: string) {
  root = path.resolve(root);
  keep = path.resolve(keep);
  // Only application-generated cache entries in this exact directory qualify.
  if (path.dirname(keep) !== root || !filename.test(path.basename(keep)) || !Number.isFinite(limit) || limit < 0)
    return Promise.resolve();
  let state = caches.get(root);
  if (!state) {
    state = { files: new Map(), total: 0, scannedAt: 0, keep: new Map(), work: Promise.resolve() };
    caches.set(root, state);
  }
  const cache = state;
  cache.keep.set(keep, (cache.keep.get(keep) || 0) + 1);
  const next = cache.work
    .catch(() => {})
    .then(async () => {
      // Reconcile external cache changes periodically, not once per thumbnail.
      if (!cache.scannedAt || Date.now() - cache.scannedAt >= 60000) {
        const names = (await fs.readdir(root)).filter(name => filename.test(name) && !name.endsWith('.part'));
        const files = new Map<string, Entry>();
        let total = 0;
        for (let i = 0; i < names.length; i += 32) await Promise.all(names.slice(i, i + 32).map(async name => {
          const file = path.join(root, name);
          try {
            const stat = await fs.stat(file);
            if (!stat.isFile()) return;
            files.set(file, { size: stat.size, time: stat.mtimeMs }); total += stat.size;
          } catch {}
        }));
        cache.files = files; cache.total = total; cache.scannedAt = Date.now();
      }
      const old = cache.files.get(keep);
      const stat = await fs.stat(keep).catch(() => undefined);
      if (stat?.isFile()) {
        cache.total += stat.size - (old?.size || 0);
        cache.files.set(keep, { size: stat.size, time: stat.mtimeMs });
      } else if (old) { cache.total -= old.size; cache.files.delete(keep); }
      if (cache.total <= limit) return;
      for (const [file, entry] of [...cache.files].sort((a, b) => a[1].time - b[1].time)) {
        if (cache.total <= limit) break;
        if (cache.keep.has(file)) continue;
        try {
          await fs.unlink(file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        cache.total -= entry.size; cache.files.delete(file);
      }
    })
    .catch(() => {})
    .finally(() => {
      const count = cache.keep.get(keep)! - 1;
      if (count) cache.keep.set(keep, count); else cache.keep.delete(keep);
    });
  cache.work = next;
  return next;
}
