import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Book, OnlineSource, OnlineTask } from "../contracts";
import { builtInSearchSchemes, expandSearch, searchKeyword, type OnlineTitleSearch } from "../contracts/titleSearch";

type Lang = "zh" | "en";
const address = (value: string) => /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : "https://" + value.trim();

export function taskText(task: OnlineTask, lang: Lang) {
  const zh = lang === "zh";
  if (task.state === "running" && task.retryAt) {
    const remaining = Math.max(0, Math.ceil((task.retryAt - Date.now()) / 1000));
    return zh ? `站点限流，${remaining} 秒后继续 · ${task.done}/${task.total}`
      : `Rate limited, resumes in ${remaining}s · ${task.done}/${task.total}`;
  }
  if (task.state === "running") return `${zh ? "正在缓存" : "Caching"} ${task.done}/${task.total}`;
  if (task.state === "done") return zh ? "已缓存到本地" : "Available offline";
  if (task.state === "cancelled") return zh ? "已取消" : "Cancelled";
  return zh ? "缓存失败" : "Cache failed";
}

export function OnlineLibrary({ lang, tasks, size, setSize, onRead, onLocal, initialSearch, onSearchSettings }: {
  lang: Lang;
  tasks: OnlineTask[];
  size: number;
  setSize(size: number): void;
  onRead(book: Book): void;
  onLocal(book: Book): void;
  initialSearch?: OnlineTitleSearch;
  onSearchSettings(): void;
}) {
  const zh = lang === "zh";
  const client = useQueryClient();
  const sources = useQuery({ queryKey: ["online-sources"], queryFn: () => window.manga.onlineSources(), retry: false });
  const [selected, setSelected] = useState(initialSearch?.sourceUrl ?? "");
  const source = sources.data?.find(item => item.url === selected) ?? sources.data?.[0];
  const [navigation, setNavigation] = useState(initialSearch?.url);
  const [template, setTemplate] = useState(initialSearch?.template);
  const [keyword, setKeyword] = useState(initialSearch?.keyword ?? "");
  const [group, setGroup] = useState(0);
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const listUrl = navigation ?? source?.url;
  const listing = useQuery({
    queryKey: ["online-catalog", listUrl],
    enabled: !!source?.builtIn && !!listUrl,
    queryFn: () => window.manga.onlineList(listUrl!, ""),
    staleTime: 60000,
    retry: false,
  });
  const changeSource = (item: OnlineSource) => {
    setSelected(item.url);
    setKeyword("");
    setNavigation(undefined);
    setTemplate(undefined);
    setGroup(0);
    setError("");
  };
  const run = async (operation: () => Promise<void>) => {
    setWorking(true);
    setError("");
    try { await operation(); }
    catch (failure) { setError(String(failure)); }
    finally { setWorking(false); }
  };
  const read = (url: string) => run(async () => onRead(await window.manga.onlineOpen(address(url))));
  const entries = listing.data?.items ?? [];
  const groups = Math.max(1, Math.ceil(entries.length / size));
  const page = Math.min(group, groups - 1);
  const browse = (url: string) => {
    setNavigation(url);
    setGroup(0);
  };

  return <div className="online-library">
    <div className="online-row online-sources">
      {sources.data?.map(item => <button key={item.url} aria-pressed={item.url === source?.url}
        className={item.url === source?.url ? "chosen" : ""} disabled={working} onClick={() => changeSource(item)}>{item.title}</button>)}
      <button aria-expanded={adding} onClick={() => setAdding(!adding)}>{zh ? "＋ 添加网址" : "＋ Add website"}</button>
      <button onClick={onSearchSettings}>{zh ? "搜索方案" : "Search schemes"}</button>
    </div>
    {adding && <form className="online-row" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const url = await window.manga.onlineSaveSource(address(sourceUrl), sourceName);
        const result = await sources.refetch();
        const added = result.data?.find(item => item.url === url);
        if (added) changeSource(added);
        setAdding(false);
        setSourceUrl("");
        setSourceName("");
      });
    }}>
      <input aria-label={zh ? "来源网址" : "Source URL"} value={sourceUrl} onChange={event => setSourceUrl(event.target.value)}
        placeholder="https://…" maxLength={4096} required />
      <input aria-label={zh ? "来源名称" : "Source name"} value={sourceName} onChange={event => setSourceName(event.target.value)}
        placeholder={zh ? "名称（选填）" : "Name (optional)"} maxLength={120} />
      <button className="primary" disabled={working}>{zh ? "保存网址" : "Save website"}</button>
    </form>}
    <form className="online-row" onSubmit={event => { event.preventDefault(); void read(link); }}>
      <input aria-label={zh ? "漫画网址" : "Comic URL"} placeholder={zh ? "粘贴画廊、图片页或图片直链" : "Paste a gallery, image page or direct image URL"}
        value={link} onChange={event => setLink(event.target.value)} maxLength={4096} required />
      <button disabled={working || !link.trim()}>{zh ? "打开漫画网址" : "Open comic URL"}</button>
      {link.trim() && <button type="button" disabled={working} onClick={() => void run(() => window.manga.onlineExternal(address(link)))}>
        {zh ? "在浏览器打开链接" : "Open link in browser"}
      </button>}
    </form>
    {source && <div className="online-row">
      {source.builtIn ? <form className="online-search" onSubmit={event => {
        event.preventDefault();
        const term = searchKeyword(keyword);
        try {
          const searchTemplate = template ?? builtInSearchSchemes.find(scheme => scheme.sourceUrl === source.url)?.template;
          setNavigation(searchTemplate && term ? expandSearch(searchTemplate, term).href : undefined);
          setError("");
        } catch (failure) { setError(String(failure)); }
        setGroup(0);
      }}>
        <input aria-label={zh ? "搜索在线漫画" : "Search online comics"} value={keyword} onChange={event => setKeyword(event.target.value)}
          placeholder={zh ? `搜索 ${source.title}` : `Search ${source.title}`} maxLength={200} />
        <button disabled={listing.isFetching}>{zh ? "搜索" : "Search"}</button>
      </form> : <>
        <span className="online-source-url">{source.url}</span>
        <button className="primary" disabled={working} onClick={() => void read(source.url)}>{zh ? "读取图片页" : "Read image page"}</button>
        <button disabled={working} onClick={() => void run(async () => {
          await window.manga.onlineRemoveSource(source.url);
          await sources.refetch();
          setSelected("");
        })}>{zh ? "移除网址" : "Remove website"}</button>
      </>}
      <button disabled={working} onClick={() => void run(() => window.manga.onlineExternal(listing.data?.url ?? listUrl ?? source.url))}>
        {listUrl === source.url ? (zh ? "在浏览器打开来源" : "Open source in browser") : (zh ? "在浏览器打开当前页" : "Open current page in browser")}
      </button>
    </div>}
    {(error || sources.error || listing.error) && <p className="online-error" role="alert">{error || String(sources.error || listing.error)}</p>}
    {working && <p role="status">{zh ? "正在打开或保存…" : "Opening or saving…"}</p>}
    {tasks.length > 0 && <details className="online-jobs" open={tasks.some(task => task.state === "running") || undefined}>
      <summary>{zh ? "缓存任务" : "Cache jobs"} · {tasks.length}</summary>
      {tasks.map(task => <div key={task.id} className="online-job">
        <strong title={task.title}>{task.title}</strong>
        <span>{taskText(task, lang)}</span>
        {task.state === "running" && <>
          <progress value={task.done} max={task.total} aria-label={zh ? "缓存进度" : "Cache progress"} />
          <button onClick={() => void run(() => window.manga.onlineCancel(task.id))}>{zh ? "取消缓存" : "Cancel cache"}</button>
        </>}
        {task.book && <button onClick={() => onLocal(task.book!)}>{zh ? "打开本地缓存" : "Open offline copy"}</button>}
        {task.error && <small className="online-error">{task.error}</small>}
      </div>)}
    </details>}
    {source?.builtIn && <>
      {listing.isFetching && <p role="status">{zh ? "正在加载在线书库…" : "Loading online library…"}</p>}
      {listing.isError && <button onClick={() => void listing.refetch()}>{zh ? "重试" : "Retry"}</button>}
      {listing.data && <>
        <div className="online-row online-controls">
          <button disabled={!listing.data.previous || listing.isFetching} onClick={() => browse(listing.data!.previous!)}>{zh ? "上一页结果" : "Previous results"}</button>
          <button disabled={!listing.data.next || listing.isFetching} onClick={() => browse(listing.data!.next!)}>{zh ? "下一页结果" : "Next results"}</button>
          <div className="spacer" />
          {[4, 9, 30].map(count => <button key={count} className={size === count ? "chosen" : ""}
            onClick={() => { setSize(count); setGroup(0); }}>{count === 30 ? (zh ? "图墙" : "Wall") : `${count} ${zh ? "宫格" : "grid"}`}</button>)}
          <button aria-label={zh ? "上一组封面" : "Previous covers"} disabled={!page} onClick={() => setGroup(page - 1)}>‹</button>
          <span>{page + 1} / {groups}</span>
          <button aria-label={zh ? "下一组封面" : "Next covers"} disabled={page + 1 >= groups} onClick={() => setGroup(page + 1)}>›</button>
        </div>
        {entries.length ? <div className={`grid g${size}`}>
          {entries.slice(page * size, (page + 1) * size).map(item => <article key={item.url} className="book-card">
            <button className="cover" title={item.title} data-comic-title={item.title} disabled={working} onClick={() => void read(item.url)}>
              <div className="art">{item.cover ? <img loading="lazy" src={item.cover} alt="" onError={event => { event.currentTarget.hidden = true; }} /> : <span>▥</span>}</div>
              <strong className="comic-title-text">{item.title}</strong>
            </button>
          </article>)}
        </div> : <p>{zh ? "这一页没有可读画廊。" : "No readable galleries on this page."}</p>}
      </>}
    </>}
  </div>;
}
