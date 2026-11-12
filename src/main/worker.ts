import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(workerData.database);
db.exec(
  "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT UNIQUE,title TEXT);CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,path TEXT UNIQUE,title TEXT,pages INTEGER DEFAULT 0,progress INTEGER DEFAULT 0,tags TEXT DEFAULT '',author TEXT DEFAULT '')",
);
db.exec(`
  CREATE TABLE IF NOT EXISTS source_exclusions(path TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    target_key TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('book','page','source')),
    title TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
    book_id TEXT,
    book_path TEXT,
    source_id TEXT,
    source_path TEXT,
    page_title TEXT,
    page_index INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS favorites_updated ON favorites(updated_at DESC);
  CREATE TABLE IF NOT EXISTS search_history (
    query TEXT PRIMARY KEY COLLATE NOCASE,
    used_at INTEGER NOT NULL
  );
`);
let imageLibrary: Promise<typeof import("sharp")["default"]> | undefined;
const getImageLibrary = () => imageLibrary ??= import("sharp").then(module => {
  module.default.cache({ memory: 64, items: 50 });
  return module.default;
});
let active = 0;
const queue: Array<() => void> = [];
async function thumbnail(job: any) {
  if (active >= 2) await new Promise<void>((r) => queue.push(r));
  else active++;
  try {
    const sharp = await getImageLibrary();
    return await sharp(job.file)
      .rotate()
      .resize({
        width: 320,
        height: 480,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toFile(job.dest);
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
parentPort!.on("message", async (job) => {
  try {
    if (job.op === "transaction") {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const check of job.checks || []) {
          const actual = db.prepare(check.sql).get(...check.args) ?? null;
          if (JSON.stringify(actual) !== JSON.stringify(check.expected)) throw Error("记录已发生变化，请重新修复 / Records changed; retry repair");
        }
        for (const statement of job.statements) db.prepare(statement.sql).run(...statement.args);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      parentPort!.postMessage({ id: job.id });
      return;
    }
    const value =
      job.op === "thumb"
        ? await thumbnail(job)
        : job.op === "all"
          ? db.prepare(job.sql).all(...job.args)
          : job.op === "get"
            ? db.prepare(job.sql).get(...job.args)
            : db.prepare(job.sql).run(...job.args);
    parentPort!.postMessage({ id: job.id, value });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: String(error) });
  }
});
