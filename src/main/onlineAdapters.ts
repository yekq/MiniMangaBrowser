import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { publicUrl, webLink, type OnlineRequest, type OnlineResponse } from "./onlineNetwork";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Site = "eh" | "nh";
export type ImageLink = { url: string; referer?: string };
export type GalleryPage = { image(signal?: AbortSignal): Promise<ImageLink>; thumbnail?: ImageLink };
export type Gallery = { url: string; title: string; pages: GalleryPage[]; firstImage?: OnlineResponse };
const maxPages = 2000;
const matches = {
  eh: /^\/g\/(\d+)\/[a-f0-9]+\/?$/i,
  nh: /^\/g\/(\d+)\/?$/,
};

export function siteOf(url: URL): Site | undefined {
  if (/^(www\.)?e-hentai\.org$/i.test(url.hostname)) return "eh";
  if (/^(www\.)?nhentai\.net$/i.test(url.hostname)) return "nh";
}

export function galleryUrl(value: URL) {
  const site = siteOf(value);
  if (site && matches[site].test(value.pathname)) {
    const origin = site === "eh" ? "https://e-hentai.org" : "https://nhentai.net";
    return new URL(value.pathname.replace(/\/?$/, "/"), origin);
  }
  return value;
}

function* elements(node: Node): Generator<Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node) for (const child of node.childNodes) yield* elements(child);
}
const attr = (el: Element | undefined, name: string) => el?.attrs.find(item => item.name === name)?.value;
const hasClass = (el: Element, name: string) => (attr(el, "class") ?? "").split(/\s+/).includes(name);
const byId = (root: Node, id: string) => first(root, el => attr(el, "id") === id);
function first(root: Node | undefined, predicate: (el: Element) => boolean) {
  if (root) for (const element of elements(root)) if (predicate(element)) return element;
}
function content(node: Node | undefined): string {
  if (!node) return "";
  if ("value" in node) return node.value;
  if ("tagName" in node && ["script", "style", "noscript"].includes(node.tagName)) return "";
  return "childNodes" in node ? node.childNodes.map(content).join("") : "";
}
const label = (el?: Element) => content(el).replace(/\s+/g, " ").trim().slice(0, 300);
const imageUrl = (element: Element | undefined, base: string) =>
  webLink(attr(element, "data-src") || attr(element, "data-original") || attr(element, "src"), base);
const imagePath = /\.(?:jpe?g|png|webp|avif|gif|bmp)$/i;
const imageLink = (url: string, referer: string) => ({ url, referer });
const directPage = (link: ImageLink): GalleryPage => ({ image: async () => link });

function html(response: OnlineResponse) {
  if (!["text/html", "application/xhtml+xml"].includes(response.type))
    throw Error("网址没有返回可读取的网页 / URL did not return an HTML page");
  const document = parse(response.bytes.toString("utf8"), { scriptingEnabled: true });
  const title = label(first(document, node => node.tagName === "title"));
  if (/^(just a moment|attention required|access denied|request blocked)/i.test(title))
    throw Error("网站要求验证，请在浏览器打开 / Site requires browser verification");
  return document;
}

export function catalogUrl(value: URL, keyword: string) {
  const site = siteOf(value);
  if (!site || !keyword) return value;
  const url = new URL(site === "nh" ? "/search" : "/", value);
  url.searchParams.set(site === "nh" ? "q" : "f_search", keyword);
  return url;
}

export function catalog(response: OnlineResponse, site: Site) {
  const document = html(response);
  const items = new Map<string, { title: string; url: string; cover?: ImageLink }>();
  for (const anchor of elements(document)) {
    if (anchor.tagName !== "a") continue;
    const href = webLink(attr(anchor, "href"), response.url);
    if (!href) continue;
    const url = new URL(href);
    if (siteOf(url) !== site || !matches[site].test(url.pathname)) continue;
    const canonical = galleryUrl(url).href;
    if (items.has(canonical)) continue;
    const title = label(first(anchor, el => hasClass(el, site === "eh" ? "glink" : "caption"))) ||
      label(anchor) || attr(anchor, "title")?.slice(0, 300);
    if (!title) continue;
    const scope = site === "eh" && anchor.parentNode && "tagName" in anchor.parentNode
      ? rowOf(anchor) ?? anchor : anchor;
    const urlOfCover = imageUrl(first(scope, el => el.tagName === "img" && !!imageUrl(el, response.url)), response.url);
    items.set(canonical, { title, url: canonical, cover: urlOfCover ? imageLink(urlOfCover, response.url) : undefined });
    if (items.size >= 100) break;
  }
  const navigation = (next: boolean) => {
    const link = first(document, el => el.tagName === "a" && (
      attr(el, "id") === (next ? "dnext" : "dprev") || attr(el, "rel") === (next ? "next" : "prev") ||
      hasClass(el, next ? "next" : "previous")));
    const href = webLink(attr(link, "href"), response.url);
    return href && href !== response.url && siteOf(new URL(href)) === site ? href : undefined;
  };
  return { url: response.url, items: [...items.values()], next: navigation(true), previous: navigation(false) };
}

function rowOf(anchor: Element) {
  let parent = anchor.parentNode;
  while (parent && "tagName" in parent) {
    if (parent.tagName === "tr") return parent;
    parent = parent.parentNode;
  }
}

function readLinks(root: Node | undefined, base: string, site: Site, galleryId: string) {
  const pages = new Map<number, { reader: string; thumbnail?: ImageLink }>();
  if (!root) return pages;
  for (const anchor of elements(root)) {
    if (anchor.tagName !== "a") continue;
    const reader = webLink(attr(anchor, "href"), base);
    if (!reader) continue;
    const url = new URL(reader);
    if (siteOf(url) !== site) continue;
    const match = (site === "eh" ? /^\/s\/[a-f0-9]+\/(\d+)-(\d+)\/?$/i : /^\/g\/(\d+)\/(\d+)\/?$/).exec(url.pathname);
    if (!match || match[1] !== galleryId) continue;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || number > maxPages) continue;
    const thumbnail = site === "nh" ? imageUrl(first(anchor, el => el.tagName === "img"), base) : undefined;
    pages.set(number, { reader, thumbnail: thumbnail ? imageLink(thumbnail, base) : undefined });
  }
  return pages;
}

function pageImage(request: OnlineRequest, reader: string, site: Site, signal?: AbortSignal) {
  return request(reader, "document", undefined, signal).then(response => {
    const root = html(response);
    const image = site === "eh" ? byId(root, "img") : first(byId(root, "image-container"), el => el.tagName === "img");
    const url = image?.tagName === "img" ? imageUrl(image, response.url) : undefined;
    if (!url) throw Error("阅读页没有返回图片 / Reader page did not contain an image");
    return imageLink(url, response.url);
  });
}

export async function openGallery(request: OnlineRequest, value: string, signal?: AbortSignal): Promise<Gallery> {
  const input = galleryUrl(publicUrl(value));
  const response = await request(input.href, "document", undefined, signal);
  const url = galleryUrl(publicUrl(response.url));
  if (response.type.startsWith("image/")) {
    return { url: url.href, title: url.pathname.split("/").pop() || url.hostname, pages: [directPage(imageLink(url.href, url.origin))], firstImage: response };
  }
  const root = html(response);
  const site = siteOf(url);
  const id = site && matches[site].exec(url.pathname)?.[1];
  if (site && !id) throw Error("请选择具体漫画的画廊网址 / Choose an individual gallery URL");
  if (site && id) {
    const title = label(site === "eh" ? byId(root, "gn") : first(byId(root, "info"), el => el.tagName === "h1")) ||
      label(first(root, el => el.tagName === "title")) || id;
    const links = readLinks(byId(root, site === "eh" ? "gdt" : "thumbnail-container"), url.href, site, id);
    if (!links.size) throw Error("画廊没有公开阅读页 / Gallery has no public reader pages");
    if (site === "nh") {
      const ordered = [...links.entries()].sort(([a], [b]) => a - b);
      if (ordered.some(([number], index) => number !== index + 1))
        throw Error("画廊页码不完整 / Incomplete gallery page list");
      return { url: url.href, title, pages: ordered.map(([, link]) => ({
        thumbnail: link.thumbnail, image: signal => pageImage(request, link.reader, site, signal),
      })) };
    }
    const countText = label(first(root, el => hasClass(el, "gpc")));
    const count = Number(/\bof\s+([\d,]+)\s+images?\b/i.exec(countText)?.[1].replace(/,/g, "") || links.size);
    if (!Number.isSafeInteger(count) || count < links.size || count > maxPages)
      throw Error("画廊页数超出支持范围 / Gallery page count is outside the supported range");
    const perListing = links.size;
    const listingRequests = new Map<number, Promise<void>>();
    const getReader = async (number: number, signal?: AbortSignal) => {
      if (!links.has(number)) {
        const index = Math.floor((number - 1) / perListing);
        if (!listingRequests.has(index)) {
          const listing = new URL(url);
          listing.searchParams.set("p", String(index));
          listingRequests.set(index, request(listing.href, "document", undefined, signal).then(response => {
            for (const [number, link] of readLinks(byId(html(response), "gdt"), response.url, site, id)) links.set(number, link);
          }).finally(() => listingRequests.delete(index)));
        }
        await listingRequests.get(index);
      }
      const reader = links.get(number)?.reader;
      if (!reader) throw Error(`画廊缺少第 ${number} 页 / Missing gallery page ${number}`);
      return reader;
    };
    return { url: url.href, title, pages: Array.from({ length: count }, (_, index) => ({
      image: async signal => pageImage(request, await getReader(index + 1, signal), site, signal),
    })) };
  }
  const scope = first(root, el => el.tagName === "main") ?? first(root, el => el.tagName === "article") ?? root;
  const links = new Set<string>();
  for (const element of elements(scope)) {
    const link = element.tagName === "img" ? imageUrl(element, response.url) : element.tagName === "a"
      ? webLink(attr(element, "href"), response.url) : undefined;
    if (!link || (element.tagName === "a" && !imagePath.test(new URL(link).pathname))) continue;
    if (element.tagName === "img" && element.parentNode && "tagName" in element.parentNode &&
        element.parentNode.tagName === "a") {
      const full = webLink(attr(element.parentNode, "href"), response.url);
      if (full && imagePath.test(new URL(full).pathname)) continue;
    }
    links.add(link);
    if (links.size > maxPages) throw Error("网页图片过多 / Too many images on this page");
  }
  if (!links.size) throw Error("没有找到静态图片，可在浏览器打开网址 / No static images found. Open the site in your browser.");
  return { url: url.href, title: label(first(scope, el => el.tagName === "h1")) ||
    label(first(root, el => el.tagName === "title")) || url.hostname,
  pages: [...links].map(link => directPage(imageLink(link, response.url))) };
}
