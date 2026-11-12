import { parentPort } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// PDF.js stays external so its ESM parser and Node canvas support retain their
// own module paths (including cmap/font/wasm assets) in packaged applications.
let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
type Document = Awaited<ReturnType<(typeof import("pdfjs-dist"))["getDocument"]>["promise"]>;
type LoadingTask = ReturnType<(typeof import("pdfjs-dist"))["getDocument"]>;
const documents = new Map<string, { fingerprint: string; document: Document; task: LoadingTask }>();
const base = path.dirname(require.resolve("pdfjs-dist/package.json"));
const assets = (name: string) => path.join(base, name).replace(/\\/g, "/") + "/";
let queue = Promise.resolve();

async function load(file: string) {
  const stat = await fs.stat(file);
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const previous = documents.get(file);
  if (previous?.fingerprint === fingerprint) {
    documents.delete(file);
    documents.set(file, previous);
    return previous.document;
  }
  if (previous) { await previous.task.destroy(); documents.delete(file); }
  while (documents.size >= 2) {
    const [key, cached] = documents.entries().next().value!;
    documents.delete(key);
    await cached.task.destroy();
  }
  const library = await (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
  library.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const task = library.getDocument({
    url: pathToFileURL(file).href,
    cMapUrl: assets("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assets("standard_fonts"),
    wasmUrl: assets("wasm"),
    useSystemFonts: false,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let document: Document;
  try { document = await task.promise; }
  catch (error) { await task.destroy(); throw error; }
  documents.set(file, { fingerprint, document, task });
  return document;
}

async function run(job: { op: string; file: string; page: number; dest: string; thumbnail?: boolean }) {
  const document = await load(job.file);
  if (job.op === "count") return document.numPages;
  if (!Number.isInteger(job.page) || job.page < 0 || job.page >= document.numPages) throw new Error("Unknown PDF page");
  const page = await document.getPage(job.page + 1);
  const unit = page.getViewport({ scale: 1 });
  // Covers are rendered at thumbnail size, never at full reader resolution.
  const scale = job.thumbnail
    ? Math.min(320 / unit.width, 480 / unit.height)
    : Math.min(2.5, 4096 / Math.max(unit.width, unit.height), Math.sqrt(12_000_000 / (unit.width * unit.height)));
  const viewport = page.getViewport({ scale });
  const factory = document.canvasFactory as any;
  const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    await page.render({ canvasContext: target.context, viewport, background: "rgb(255,255,255)" } as any).promise;
    await fs.mkdir(path.dirname(job.dest), { recursive: true });
    await fs.writeFile(job.dest + ".part", await target.canvas.encode("png"));
    await fs.rename(job.dest + ".part", job.dest);
    return job.dest;
  } finally {
    factory.destroy(target);
    page.cleanup();
  }
}

// One page render at a time bounds native canvas memory; the UI and database
// use separate threads. Two recently used documents retain parser resources.
parentPort!.on("message", (job) => {
  queue = queue.then(async () => {
    try { parentPort!.postMessage({ id: job.id, value: await run(job) }); }
    catch (error) { parentPort!.postMessage({ id: job.id, error: String(error) }); }
  });
});
