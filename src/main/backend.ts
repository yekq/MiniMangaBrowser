import { Worker } from "node:worker_threads";
import path from "node:path";
export class Backend {
  private worker: Worker;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  constructor(database: string) {
    this.worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { database },
    });
    this.worker.on("message", (r) => {
      const p = this.pending.get(r.id);
      this.pending.delete(r.id);
      if (r.error) p?.reject(Error(r.error));
      else p?.resolve(r.value);
    });
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }
  call(op: string, data: object) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...data });
    });
  }
  prepare(sql: string) {
    return Object.fromEntries(
      ["all", "get", "run"].map((op) => [
        op,
        (...args: unknown[]) => this.call(op, { sql, args }),
      ]),
    ) as Record<"all" | "get" | "run", (...args: any[]) => Promise<any>>;
  }
  close() {
    return this.worker.terminate();
  }
}
