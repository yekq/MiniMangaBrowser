export interface SearchScheme {
  id: string;
  name: string;
  template: string;
}

export const builtInSearchSchemes: readonly (SearchScheme & { sourceUrl: string })[] = [
  { id: "e-hentai", name: "E-Hentai", sourceUrl: "https://e-hentai.org/", template: "https://e-hentai.org/?f_search={query}" },
  { id: "nhentai", name: "nHentai", sourceUrl: "https://nhentai.net/", template: "https://nhentai.net/search?q={query}" },
];

export interface OnlineTitleSearch {
  id: number;
  sourceUrl: string;
  url: string;
  keyword: string;
  template: string;
}

const placeholder = "{query}";
const marker = "minimanga-search-keyword-placeholder";

export function searchKeyword(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
}

export function expandSearch(template: string, keyword: string) {
  template = template.trim();
  if (template.length > 2000 || !template.includes(placeholder))
    throw Error("网址模板需要包含 {query} / URL template must contain {query}");
  let example: URL;
  try { example = new URL(template.replaceAll(placeholder, marker)); }
  catch { throw Error("请输入完整搜索网址 / Enter a full search URL"); }
  if (!["https:", "http:"].includes(example.protocol) || example.username || example.password ||
      example.host.includes(marker) || ![example.pathname, example.search, example.hash].some(part => part.includes(marker)))
    throw Error("关键词只能放在 HTTP(S) 网址的路径、参数或片段中 / Put the keyword in the path, query or fragment of an HTTP(S) URL");
  const url = new URL(template.replaceAll(placeholder, encodeURIComponent(searchKeyword(keyword))));
  if (url.href.length > 4096) throw Error("搜索网址过长 / Search URL is too long");
  return url;
}

export function appSearchSource(url: URL) {
  if (url.port || url.hash) return undefined;
  if (/^(www\.)?e-hentai\.org$/.test(url.hostname) && url.pathname === "/" && url.searchParams.has("f_search"))
    return "https://e-hentai.org/";
  if (/^(www\.)?nhentai\.net$/.test(url.hostname) && /^\/search\/?$/.test(url.pathname) && url.searchParams.has("q"))
    return "https://nhentai.net/";
}
