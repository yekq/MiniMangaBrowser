import { Worker } from "node:worker_threads";
import path from "node:path";

export class PdfRenderer {
  private worker: Worker;
  private next = 0;
  private failure?: Error;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor() {
    this.worker = new Worker(path.join(__dirname, "pdf-worker.js"));
    this.worker.on("message", (response) => {
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      if (response.error) pending?.reject(new Error(response.error));
      else pending?.resolve(response.value);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", () => fail(new Error("PDF worker stopped")));
  }
  private call(data: object): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...data, id });
    });
  }
  count(file: string): Promise<number> {
    return this.call({ op: "count", file });
  }
  render(file: string, page: number, dest: string, thumbnail = false): Promise<string> {
    return this.call({ op: "render", file, page, dest, thumbnail });
  }
  close() { return this.worker.terminate(); }
}
