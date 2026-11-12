import { spawn } from "node:child_process";
import path from "node:path";

export type EverythingHit = { path: string; kind: "folder" | "file"; size?: number };
export function literalSearch(keyword: string) {
  const name = keyword.replace(/["\r\n\0]/g, " ").trim();
  if (!name || name.length > 500) throw Error("请输入名称关键词（最多500字符） / Enter a name keyword");
  return `<folder:|ext:zip;cbz;rar;cbr;7z;cb7;tar;cbt;gz;gzip;tgz;bz2;bzip2;tbz;tbz2;xz;txz;zst;tzst;cab;lzh;lha;cpio;pdf;lnk;jpg;jpeg;png;webp;avif;gif;bmp;svg;ico> "${name}"`;
}
export function searchEverything(keyword: string, directory: string): Promise<{ items: EverythingHit[]; total: number }> {
  const query = literalSearch(keyword);
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(directory, "EverythingSearch.exe"), [], {
      cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let length = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 12000);
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) { timedOut = true; child.kill(); } else chunks.push(chunk);
    });
    child.once("error", error => { clearTimeout(timer); reject(Error("Everything 搜索组件不可用 / Search helper unavailable: " + error.message)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) return reject(Error("Everything 搜索超时，请确认程序已启动 / Everything search timed out"));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value.error || code !== 0) throw Error(value.error || "Search failed");
        if (!Array.isArray(value.items) || typeof value.total !== "number") throw Error("Invalid search response");
        resolve({ items: value.items.slice(0, 200), total: value.total });
      } catch (error) {
        reject(Error("无法读取 Everything 索引；请确认 Everything 已启动且权限相同。 / Check Everything is running with matching privileges. " + String(error)));
      }
    });
    child.stdin.end(JSON.stringify({ query, limit: 200 }));
  });
}
