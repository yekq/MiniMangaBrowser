import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const syntheticDns = new BlockList();
syntheticDns.addSubnet("198.18.0.0", 15, "ipv4");

function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function publicUrl(value: string, base?: string) {
  if (value.length > 4096) throw Error("网址过长 / URL is too long");
  const url = new URL(value, base);
  const imageNode = url.protocol === "https:" && /\.hath\.network$/i.test(url.hostname) && Number(url.port) >= 1024;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !imageNode))
    throw Error("请输入标准 HTTP 或 HTTPS 网址 / Use a standard HTTP or HTTPS URL");
  const host = url.hostname.replace(/^\[|\]$|\.$/g, "");
  if (isIP(host) ? !publicAddress(host) : !host.includes(".") || /\.(localhost|local|internal|home\.arpa)$/i.test(host))
    throw Error("请输入公开网站的网址 / Use a public website URL");
  url.hash = "";
  return url;
}

export function webLink(value: string | undefined, base: string): string | undefined {
  if (!value?.trim()) return;
  try { return publicUrl(value, base).href; } catch { return; }
}

export type OnlineResponse = { url: string; bytes: Buffer; type: string };
export type OnlineRequest = (url: string, kind: "document" | "image", referer?: string, signal?: AbortSignal) => Promise<OnlineResponse>;

export class OnlineRateLimitError extends Error {
  constructor(readonly host: string, readonly retryAt: number) {
    const until = new Date(retryAt).toLocaleString();
    super(`网站限流 HTTP 429（${host}），请在 ${until} 后重试 / Rate limited, retry after ${until}`);
  }
}

const rateLimits = new Map<string, { retryAt: number; strikes: number }>();

function registerRateLimit(host: string, header: string | undefined) {
  const now = Date.now();
  const previous = rateLimits.get(host);
  const recent = previous && now < previous.retryAt + 10 * 60_000;
  const cooling = previous && previous.retryAt > now;
  const strikes = cooling ? previous.strikes : recent ? previous.strikes + 1 : 1;
  const value = header?.trim();
  const date = value && /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value ?? "");
  const fallback = cooling ? previous.retryAt : now + Math.min(300_000, 30_000 * 2 ** (strikes - 1));
  const retryAt = Math.max(previous?.retryAt ?? 0,
    Number.isFinite(date) && date <= 8.64e15 ? Math.max(now + 1000, date) : fallback);
  for (const [key, limit] of rateLimits) {
    if (limit.retryAt + 10 * 60_000 <= now) rateLimits.delete(key);
  }
  rateLimits.set(host, { retryAt, strikes });
  return new OnlineRateLimitError(host, retryAt);
}

function request(url: URL, limit: number, accept: string, referer: string | undefined, signal: AbortSignal) {
  const host = url.hostname.replace(/\.$/, "");
  const cooling = rateLimits.get(host);
  if (cooling && cooling.retryAt > Date.now())
    return Promise.reject(new OnlineRateLimitError(host, cooling.retryAt));
  return new Promise<{ bytes: Buffer; type: string; location?: string }>((resolve, reject) => {
    const get = url.protocol === "https:" ? https.get : http.get;
    const options: http.RequestOptions & { autoSelectFamily: boolean } = {
      signal,
      autoSelectFamily: false,
      lookup(host, _options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error, "", 0);
          // TUN clients can synthesize DNS answers in this range. Only DNS
          // answers for HTTPS names qualify, and TLS still verifies the name.
          const usable = addresses.filter(item => publicAddress(item.address) ||
            (url.protocol === "https:" && item.family === 4 && syntheticDns.check(item.address, "ipv4")));
          if (!usable.length)
            return callback(Error("目标指向非公网地址 / Host resolves to a non-public address"), "", 0);
          const address = usable.find(item => item.family === 4) ?? usable[0];
          callback(null, address.address, address.family);
        });
      },
      headers: { "User-Agent": "Mini Manga/0.2.11", Accept: accept, ...(referer ? { Referer: referer } : {}) },
    };
    const req = get(url, options, response => {
      const status = response.statusCode ?? 0;
      const type = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (status === 429) {
        const header = response.headers["retry-after"];
        const error = registerRateLimit(host, Array.isArray(header) ? header[0] : header);
        response.destroy();
        return reject(error);
      }
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.destroy();
        return resolve({ bytes: Buffer.alloc(0), type, location: response.headers.location });
      }
      if (status !== 200 || Number(response.headers["content-length"]) > limit) {
        response.destroy();
        return reject(Error(status !== 200
          ? `网站返回 HTTP ${status} / Site returned HTTP ${status}`
          : "内容超出读取上限 / Response exceeds size limit"));
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) response.destroy(Error("内容超出读取上限 / Response exceeds size limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks, length), type }));
    });
    req.on("error", reject);
  });
}

export const fetchOnline: OnlineRequest = async (value, kind, referer, signal) => {
  let url = publicUrl(value);
  const deadline = AbortSignal.timeout(20000);
  const cancel = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const result = await request(url, kind === "image" ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
      kind === "image" ? "image/*" : "text/html,application/xhtml+xml,image/*;q=0.7", referer, cancel);
    if (!result.location) return { url: url.href, type: result.type, bytes: result.bytes };
    const next = publicUrl(result.location, url.href);
    if (next.origin !== url.origin) referer = undefined;
    url = next;
  }
  throw Error("网站重定向次数过多 / Too many redirects");
};

export function rasterExtension(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /^avi[fs]$/.test(bytes.toString("ascii", 8, 12))) return "avif";
  if (bytes.length >= 54 && bytes.toString("ascii", 0, 2) === "BM") return "bmp";
  throw Error("网站没有返回支持的图片 / Site did not return a supported image");
}
