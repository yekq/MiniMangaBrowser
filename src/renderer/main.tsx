import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AiEdit, Book, ItemTarget } from "../contracts";
import "./style.css";
import { Continuous } from "./Continuous";
import { SourceTree } from "./SourceTree";
import type { SourceReveal } from "./SourceTree";
import { Sidebar } from "./Sidebar";
import { dict } from "./locales";
import { useLocale, useSettings } from "./settings";
import { Thumbnail } from "./Thumbnail";
import { Filmstrip } from "./Filmstrip";
import { ReadingChoices } from "./ReadingChoices";
import { useReaderChrome } from "./useReaderChrome";
import { ItemActions, FavoritesView } from "./Favorites";
import { PathRepairProvider, usePathRepair } from "./PathRepair";
import { AiDialog, AiHistoryView, AiHistoryPopup } from "./AiEdits";
import type { AiSource } from "./AiEdits";
import { OnlineLibrary, taskText } from "./OnlineLibrary";
import { contextTitle, selectedTitle, TitleSearch } from "./TitleSearch";
import { searchKeyword, type OnlineTitleSearch } from "../contracts/titleSearch";
function Cover({
  book,
  onClick,
  onTrash,
  onError,
}: {
  book: Book;
  onClick: () => void;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const q = useQuery({
    queryKey: ["cover", book.id],
    queryFn: () => window.manga.cover(book.id),
    staleTime: 300000,
    retry: false,
  });
  return (
    <article className="book-card">
      <button className="cover" data-comic-title={book.title} onClick={onClick}>
        <div className="art">
          {q.data ? <img loading="lazy" src={q.data} /> : <span>▥</span>}
        </div>
        <strong className="comic-title-text">{book.title}</strong>
        <small>
          {book.author || "—"}{" "}
          {book.progress > 0 ? " · " + (book.progress + 1) : ""}
        </small>
      </button>
      <ItemActions
        target={{ kind: "book", bookId: book.id }}
        title={book.title}
        onTrash={onTrash}
        onError={onError}
      />
    </article>
  );
}
function App() {
  const repair = usePathRepair();
  const [lang, setLang] = useLocale();
  const filmstripVisible = useSettings((state) => state.filmstripVisible);
  const setFilmstripVisible = useSettings((state) => state.setFilmstripVisible);
  const t = dict[lang];
  const client = useQueryClient();
  const { data: books = [] } = useQuery({
    queryKey: ["books"],
    queryFn: () => window.manga.list(),
  });
  const [search, setSearch] = useState(""),
    [favoritesView, setFavoritesView] = useState(false),
    [sourceScope, setSourceScope] = useState<{
      ids: string[];
      title: string;
    } | null>(null),
    [browseSourceId, setBrowseSourceId] = useState<string | undefined>(
      undefined,
    ),
    [size, setSize] = useState(9),
    [group, setGroup] = useState(0),
    [recent, setRecent] = useState(false),
    [tabs, setTabs] = useState<Book[]>([]),
    [active, setActive] = useState<string | null>(null),
    [mode, setMode] = useState("grid"),
    [index, setIndex] = useState(0),
    [zoom, setZoom] = useState(1),
    [rtl, setRtl] = useState(false),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [tags, setTags] = useState(""),
    [author, setAuthor] = useState("");
  const [aiView, setAiView] = useState(false);
  const [onlineView, setOnlineView] = useState(false);
  const [titleSearch, setTitleSearch] = useState<{ initial?: string } | null>(null);
  const [onlineSearch, setOnlineSearch] = useState<OnlineTitleSearch>();
  const searchRequest = useRef(0);
  const [watchCache, setWatchCache] = useState(false);
  const [aiDialog, setAiDialog] = useState<{ source?: AiSource; recordId?: string } | null>(null);
  const [aiGallery, setAiGallery] = useState(false);
  const [aiReaderImage, setAiReaderImage] = useState<Pick<AiEdit, "id" | "bookId" | "page" | "imageUrl"> | null>(null);
  const wheel = useRef(0);
  const [sourceReveal, setSourceReveal] = useState<SourceReveal>();
  const [locating, setLocating] = useState(false);
  const locateRequest = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const locateComic = async () => {
    if (!active) return;
    const id = active, request = ++locateRequest.current;
    setLocating(true);
    try {
      const ids = await window.manga.locateBook(id);
      await client.invalidateQueries({ queryKey: ["sources"] });
      await Promise.all(ids.slice(0, -1).map(sourceId => client.invalidateQueries({ queryKey: ["children", sourceId] })));
      if (request === locateRequest.current && activeRef.current === id) setSourceReveal({ ids, request });
    } catch (e) { if (activeRef.current === id) setError(String(e)); }
    finally { if (request === locateRequest.current) setLocating(false); }
  };
  const [scrollEnd, setScrollEnd] = useState({ bookId: null as string | null, complete: false });
  useEffect(() => setScrollEnd({ bookId: active, complete: false }), [active, mode]);
  const { data: history = [] } = useQuery({
    queryKey: ["search-history"],
    queryFn: () => window.manga.searchHistory(),
  });
  const rememberSearch = async (query = search) => {
    try {
      if (query.trim()) await window.manga.rememberSearch(query.trim());
      await client.invalidateQueries({ queryKey: ["search-history"] });
    } catch (e) {
      setError(String(e));
    }
  };
  const searchLibrary = (query: string) => {
    setOnlineView(false);
    setSearch(query);
    setSourceScope(null);
    setActive(null);
    setRecent(false);
    setGroup(0);
    void rememberSearch(query);
  };
  const beginTitleSearch = (initial?: string) => {
    setMenu(null);
    setTitleSearch({ initial });
  };
  const finishTitleSearch = () => {
    setTitleSearch(null);
    setAiView(false);
    setFavoritesView(false);
    setError("");
    if (document.fullscreenElement) void document.exitFullscreen().catch(failure => setError(String(failure)));
  };
  const trashItem = async (target: ItemTarget) => {
    try {
      if (!(await window.manga.trash(target))) return;
      const remaining = await window.manga.list();
      client.setQueryData(["books"], remaining);
      const ids = new Set(remaining.map((b) => b.id));
      setTabs((old) => old.filter((b) => b.onlineUrl || ids.has(b.id)));
      if (active && !ids.has(active)) setActive(null);
      await Promise.all(
        [
          "favorites",
          "favorite-cover",
          "sources",
          "children",
          "pages",
          "cover",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
    } catch (e) {
      setError(String(e));
    }
  };
  const forgetSource = useCallback(async (target: ItemTarget) => {
    if (target.kind !== "source") return;
    try {
      await window.manga.forgetSource(target.sourceId);
      const remaining = await window.manga.list();
      client.setQueryData(["books"], remaining);
      const ids = new Set(remaining.map((b) => b.id));
      setTabs((old) => old.filter((b) => b.onlineUrl || ids.has(b.id)));
      if (active && !ids.has(active)) setActive(null);
      await Promise.all(
        ["sources", "children", "favorites"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [active, client]);
  const readingRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const book = tabs.find((b) => b.id === active);
  const onlineReader = !!book?.onlineUrl;
  const zh = lang === "zh";
  const { data: onlineTasks = [] } = useQuery({
    queryKey: ["online-tasks"],
    queryFn: () => window.manga.onlineTasks(),
    enabled: onlineView || onlineReader || watchCache,
    refetchInterval: query => query.state.data?.some(task => task.state === "running") ? 650 : false,
    retry: false,
  });
  const cacheTask = onlineTasks.find(task => task.id === active);
  const completedCaches = onlineTasks.filter(task => task.state === "done").map(task => task.book?.id).join(",");
  useEffect(() => {
    if (completedCaches) {
      void client.invalidateQueries({ queryKey: ["books"] });
      void client.invalidateQueries({ queryKey: ["sources"] });
    }
  }, [client, completedCaches]);
  const startCache = async (id: string) => {
    setError("");
    try {
      await window.manga.onlineCache(id);
      setWatchCache(true);
      await client.invalidateQueries({ queryKey: ["online-tasks"] });
    } catch (failure) { setError(String(failure)); }
  };
  const chrome = useReaderChrome(stageRef, !!book && mode !== "grid", active);
  useEffect(() => {
    if (filmstripVisible) chrome.show();
    else chrome.hide();
  }, [filmstripVisible, active, mode]);
  const toggleStrip = () => {
    if (chrome.visible) {
      setFilmstripVisible(false);
      chrome.hide();
    } else {
      setFilmstripVisible(true);
      chrome.show();
    }
  };
  const fullscreenReader = () => {
    if (mode === "grid") setMode("single");
    setZoom(1);
    setMenu(null);
    void chrome.toggleFullscreen().catch((e) => setError(String(e)));
  };
  const { data: pages = [], error: pageError } = useQuery({
    queryKey: ["pages", active],
    queryFn: () => onlineReader ? window.manga.onlinePages(active!) : window.manga.open(active!),
    enabled: !!active,
  });
  const filtered = books.filter(
    (b) =>
      (!recent || b.progress > 0) &&
      (!sourceScope || sourceScope.ids.includes(b.id)) &&
      [b.title, b.author, b.tags]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const content = book ? pages : filtered,
    total = Math.max(1, Math.ceil(content.length / size));
  const applyOpen = useCallback((b: Book) => {
    setTabs((v) => (v.some((x) => x.id === b.id) ? v : [...v, b]));
    setActive(b.id);
    setIndex(b.progress);
    setMode("grid");
    setGroup(Math.floor(b.progress / size));
  }, [size]);
  const open = useCallback((b: Book) => {
    void repair.ensure({ kind: "book", id: b.id }, result => {
      setOnlineView(false);
      applyOpen(result?.book || b);
    }).catch(failure => setError(String(failure)));
  }, [repair, applyOpen]);
  const openOnline = (b: Book) => {
    setError("");
    setOnlineView(true);
    applyOpen(b);
  };
  const readNext = (b: Book) => {
    setTabs(old => old.some(item => item.id === b.id)
      ? old.map(item => item.id === b.id ? { ...b, progress: 0 } : item)
      : [...old, { ...b, progress: 0 }]);
    setActive(b.id);
    setIndex(0);
    setGroup(0);
    void client.invalidateQueries({ queryKey: ["books"] });
  };
  const openFavorite = async (id: string) => {
    try {
      await repair.ensure({ kind: "favorite", id }, async repaired => {
      const result = await window.manga.openFavorite(repaired?.favoriteId || id);
      if (result.book) {
        applyOpen(result.book);
        if (result.page !== undefined) {
          setIndex(result.page);
          setMode("single");
        }
      } else if (result.sourceId) {
        setFavoritesView(false);
        setRecent(false);
        setActive(null);
        setSearch("");
        setGroup(0);
        setSourceScope({
          ids: result.bookIds || [],
          title: result.title || "",
        });
        setBrowseSourceId(result.sourceId);
        setSourceReveal(undefined);
        await client.invalidateQueries({ queryKey: ["sources"] });
      }
      });
    } catch (e) {
      setError(String(e));
    }
  };
  const go = (n: number) =>
    { setAiReaderImage(null); setIndex(Math.max(0, Math.min(pages.length - 1, n))); };
  useEffect(() => { setAiGallery(false); setAiReaderImage(null); }, [active]);
  const selectAiImage = (record: AiEdit) => {
    if (!book || record.bookId !== book.id || !record.imageUrl || record.page < 0 || record.page >= pages.length) return;
    setIndex(record.page);
    setMode("single");
    setAiReaderImage({ id: record.id, bookId: record.bookId, page: record.page, imageUrl: record.imageUrl });
    setAiGallery(false);
  };
  useEffect(() => {
    if (!book) return;
    const saveProgress = onlineReader ? window.manga.onlineProgress : window.manga.progress;
    void saveProgress(book.id, index)
      .catch((e) => setError(String(e)));
    client.setQueryData<Book[]>(["books"], (old) =>
      old?.map((b) => (b.id === book.id ? { ...b, progress: index } : b)),
    );
    setTabs((v) =>
      v.map((b) => (b.id === book.id ? { ...b, progress: index } : b)),
    );
  }, [active, index]);
  useEffect(() => {
    if (pages.length && index >= pages.length) setIndex(pages.length - 1);
  }, [pages.length, index]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (document.querySelector(".ai-modal")) return;
      if (e.key === "F11") {
        e.preventDefault();
        if (book) fullscreenReader();
        else if (document.fullscreenElement) void document.exitFullscreen();
        else
          void document.documentElement
            .requestFullscreen()
            .catch((e) => setError(String(e)));
        return;
      }
      if ((e.target as HTMLElement).closest("input,select,textarea")) return;
      if (e.key === "Escape") {
        if (
          chrome.fullscreen ||
          document.fullscreenElement ||
          chrome.justExited()
        ) {
          e.preventDefault();
          if (document.fullscreenElement) void document.exitFullscreen();
          return;
        }
        setMenu(null);
        setMode("grid");
      }
      if (book && mode !== "grid") {
        if (
          e.key.toLowerCase() === "t" &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          toggleStrip();
        }
        if (e.key === "ArrowRight" || e.key === "PageDown")
          go(index + (mode === "double" ? 2 : 1));
        if (e.key === "ArrowLeft" || e.key === "PageUp")
          go(index - (mode === "double" ? 2 : 1));
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [book, mode, index, pages.length, chrome.fullscreen, chrome.visible]);
  useEffect(() => {
    const el = readingRef.current;
    if (!el || !book || mode === "grid") return;
    const handle = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        setZoom((v) =>
          Math.max(0.25, Math.min(4, v + (event.deltaY < 0 ? 0.1 : -0.1))),
        );
      } else if (
        mode !== "scroll" &&
        Math.abs(event.deltaY) > 30 &&
        Date.now() - wheel.current > 250
      ) {
        event.preventDefault();
        wheel.current = Date.now();
        go(index + (event.deltaY > 0 ? 1 : -1));
      }
    };
    el.addEventListener("wheel", handle, { passive: false });
    return () => el.removeEventListener("wheel", handle);
  }, [active, mode, index, pages.length]);
  const importBooks = async (mode: "folder" | "files" = "folder") => {
    setBusy(true);
    try {
      await window.manga.import(mode);
      await client.invalidateQueries({ queryKey: ["books"] });
      await client.invalidateQueries({ queryKey: ["sources"] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = (id: string, action: string) => {
    const i = tabs.findIndex((b) => b.id === id);
    const next =
      action === "all"
        ? []
        : action === "left"
          ? tabs.slice(i)
          : action === "right"
            ? tabs.slice(0, i + 1)
            : action === "others"
              ? [tabs[i]]
              : tabs.filter((b) => b.id !== id);
    setTabs(next);
    if (!next.some((b) => b.id === active)) {
      const selected = next.find((b) => b.id === id) ?? next.at(-1);
      setActive(selected?.id ?? null);
      if (selected) {
        setIndex(selected.progress);
        setOnlineView(!!selected.onlineUrl);
      }
    }
    setMenu(null);
  };
  return (
    <div
      className={"app" + (chrome.fullscreen ? " immersive" : "")}
      onClick={() => setMenu(null)}
      onClickCapture={event => {
        const title = event.target instanceof HTMLElement && event.target.closest<HTMLElement>(".comic-title-text");
        if (title && event.detail > 0 && selectedTitle(title)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={event => {
        if (event.defaultPrevented || titleSearch) return;
        const query = contextTitle(event.target);
        if (!query) return;
        event.preventDefault();
        beginTitleSearch(query);
      }}
    >
      <Sidebar>
        <div className="brand">
          <b>m.</b>
          <span>
            mini manga<small>{t.tagline}</small>
          </span>
        </div>
        <button
          className={!recent && !favoritesView && !aiView && !onlineView ? "nav selected" : "nav"}
          onClick={() => {
            setOnlineView(false);
            setAiView(false);
            setFavoritesView(false);
            setSourceScope(null);
            setSearch("");
            setGroup(0);
            setRecent(false);
            setActive(null);
          }}
        >
          ▦　{t.library}
          <em>{books.length}</em>
        </button>
        <button
          className={recent && !favoritesView && !aiView && !onlineView ? "nav selected" : "nav"}
          onClick={() => {
            setOnlineView(false);
            setAiView(false);
            setFavoritesView(false);
            setSourceScope(null);
            setSearch("");
            setGroup(0);
            setRecent(true);
            setActive(null);
          }}
        >
          ◷　{t.recent}
        </button>
        <button
          className={favoritesView && !aiView && !onlineView ? "nav selected" : "nav"}
          onClick={() => {
            setOnlineView(false);
            setAiView(false);
            setFavoritesView(true);
            setRecent(false);
            setActive(null);
            setSourceScope(null);
            setSearch("");
            setGroup(0);
          }}
        >
          ☆　{lang === "zh" ? "我的收藏" : "Favorites"}
        </button>
        <button className={aiView && !onlineView ? "nav selected" : "nav"} onClick={() => { setOnlineView(false); setAiView(true); setFavoritesView(false); setRecent(false); setActive(null); setSourceScope(null); setSearch(""); }}>
          ✦　{lang === "zh" ? "AI修改记录" : "AI edit history"}
        </button>
        <button className={onlineView ? "nav selected" : "nav"} onClick={() => {
          setOnlineView(true); setAiView(false); setFavoritesView(false); setRecent(false);
          setActive(null); setSourceScope(null); setSearch(""); setError("");
        }}>◎　{zh ? "在线阅读" : "Online reading"}</button>
        <div className="aside-label">{t.collection}</div>
        <form
          className="sidebar-search"
          onSubmit={(e) => {
            e.preventDefault();
            searchLibrary(search);
          }}
        >
          <input
            type="search"
            aria-label={
              lang === "zh" ? "搜索书库或收藏" : "Search library or favorites"
            }
            placeholder={
              lang === "zh"
                ? "搜索漫画、标签、作者…"
                : "Search books, tags, authors…"
            }
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setGroup(0);
            }}
          />
          <button type="submit">{lang === "zh" ? "搜索" : "Search"}</button>
        </form>
        {history.length > 0 && (
          <details className="search-history">
            <summary>
              {lang === "zh" ? "搜索记录" : "Search history"} ({history.length})
            </summary>
            <div>
              {history.map((query) => (
                <button
                  key={query}
                  title={query}
                  onClick={() => searchLibrary(query)}
                >
                  {query}
                </button>
              ))}
            </div>
            <button
              className="clear-history"
              onClick={() =>
                void window.manga
                  .clearSearchHistory()
                  .then(() =>
                    client.invalidateQueries({ queryKey: ["search-history"] }),
                  )
                  .catch((e) => setError(String(e)))
              }
            >
              {lang === "zh" ? "清空记录" : "Clear history"}
            </button>
          </details>
        )}
        <SourceTree
          onOpen={open}
          browseSourceId={browseSourceId}
          reveal={sourceReveal}
          onTrash={forgetSource}
          onError={setError}
        />
        <div className="aside-bottom">
          <small>mini.manga · 0.2.11</small>
        </div>
      </Sidebar>
      <main>
        <header>
          <div>
            <span className="eyebrow">
              MINI MANGA / {onlineView ? (zh ? "在线" : "ONLINE") : book ? t.reader : t.library}
            </span>
            <h1 data-comic-title={book?.title} className={book ? "comic-title-text" : undefined}>
              {book?.title ||
                (onlineView ? (zh ? "在线阅读" : "Online reading") : aiView ? (lang === "zh" ? "AI修改记录" : "AI edit history") : favoritesView
                  ? lang === "zh"
                    ? "我的收藏"
                    : "Favorites"
                  : sourceScope?.title || t.library)}
            </h1>
          </div>
          <button
            style={{ marginLeft: "auto", marginRight: 12 }}
            disabled={busy}
            onClick={() => importBooks("files")}
          >
            {t.openFiles}
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => importBooks()}
          >
            ＋ {busy ? "…" : t.import}
          </button>
          <select className="header-language" aria-label="Language" title={lang === "zh" ? "界面语言" : "Interface language"}
            value={lang} onChange={event => {
              setLang(event.target.value as "zh" | "en");
              localStorage.setItem("language", event.target.value);
            }}>
            <option value="zh">简体中文</option><option value="en">English</option>
          </select>
        </header>
        {tabs.length > 0 && (
          <div className="tabs">
            {tabs.map((b) => (
              <div
                className={active === b.id ? "tab current" : "tab"}
                key={b.id}
                onClick={() => {
                  if (b.onlineUrl) {
                    setOnlineView(true); setActive(b.id); setIndex(b.progress);
                    return;
                  }
                  void repair.ensure({ kind: "book", id: b.id }, result => {
                    const current = result?.book || b;
                    if (result?.book) setTabs(old => old.map(item => item.id === b.id ? current : item));
                    setOnlineView(false); setActive(current.id); setIndex(current.progress);
                  }).catch(failure => setError(String(failure)));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    id: b.id,
                    x: Math.min(e.clientX, innerWidth - 190),
                    y: Math.min(e.clientY, innerHeight - 212),
                  });
                }}
              >
                {b.title}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    close(b.id, "self");
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {(error || pageError) && (
          <div className="error" onClick={() => setError("")}>
            {error || String(pageError)} ×
          </div>
        )}
        {(book || !onlineView) && <div className="toolbar">
          {book ? (
            <>
              <button onClick={() => setActive(null)}>← {onlineReader ? (zh ? "返回在线书库" : "Back to online library") : t.back}</button>
              {["grid", "single", "double", "scroll"].map((m) => (
                <React.Fragment key={m}>
                  <button
                    className={mode === m ? "chosen" : ""}
                    onClick={() => setMode(m)}
                  >
                    {m === "grid" ? "▦" : t[m as "single"]}
                  </button>
                  {m === "double" && (
                    <>
                      {!onlineReader && <><button
                        disabled={!pages[index]}
                        title={t.revealHint}
                        onClick={() =>
                          void window.manga
                            .reveal(book.id, index)
                            .catch((e) => setError(String(e)))
                        }
                      >
                        {t.reveal}
                      </button>
                      <button disabled={locating} title={t.locateBookHint} onClick={() => void locateComic()}>
                        {t.locateBook}{locating ? "…" : ""}
                      </button></>}
                      <button
                        disabled={!pages.length}
                        onClick={fullscreenReader}
                        title={`${t.fullscreen} · F11`}
                      >
                        {t.fullscreen}
                      </button>
                    </>
                  )}
                </React.Fragment>
              ))}
              <button onClick={() => go(index - 1)}>‹</button>
              <input
                aria-label="Page"
                type="number"
                min={1}
                max={pages.length}
                value={index + 1}
                onChange={(e) => go(Number(e.target.value) - 1)}
              />
              <span>/ {pages.length}</span>
              {!onlineReader && <><button disabled={!pages[index]} title={pages[index] ? `${lang === "zh" ? "修改当前页" : "Edit current page"}: ${pages[index].title}` : ""} onClick={() => setAiDialog({ source: { book: { ...book }, page: { ...pages[index] }, index } })}>
                ✦ {lang === "zh" ? "AI修改" : "AI edit"}
              </button>
              <button onClick={() => setAiGallery(true)}>{lang === "zh" ? "AI修改记录" : "AI edit history"}</button>
              {aiReaderImage?.bookId === book.id && aiReaderImage.page === index && <button onClick={() => setAiReaderImage(null)}>{lang === "zh" ? "返回原图" : "Show original"}</button>}
              </>}
              {onlineReader && <>
                {cacheTask?.book ? <button className="primary" onClick={() => open(cacheTask.book!)}>{zh ? "打开本地缓存" : "Open offline copy"}</button>
                  : <button className="primary" disabled={onlineTasks.some(task => task.state === "running")} onClick={() => void startCache(book.id)}>
                    {cacheTask?.state === "running" ? taskText(cacheTask, lang) : cacheTask?.state === "failed" ? (zh ? "重试缓存" : "Retry cache") : zh ? "一键缓存到本地" : "Cache for offline reading"}
                  </button>}
                {cacheTask?.state === "running" && <button onClick={() => void window.manga.onlineCancel(book.id).catch(failure => setError(String(failure)))}>
                  {zh ? "取消缓存" : "Cancel cache"}
                </button>}
                {cacheTask?.error && <span className="online-error" role="alert">{cacheTask.error}</span>}
                <button onClick={() => void window.manga.onlineExternal(book.onlineUrl!).catch(failure => setError(String(failure)))}>
                  {zh ? "在浏览器打开原页" : "Open source page"}
                </button>
              </>}
              <button onClick={() => go(index + 1)}>›</button>
              <button onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}>
                −
              </button>
              <button onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button onClick={() => setZoom((v) => Math.min(4, v + 0.25))}>
                ＋
              </button>
              <button onClick={() => setRtl(!rtl)}>
                {rtl ? "← RTL" : "LTR →"}
              </button>
              {mode !== "grid" && (
                <button
                  aria-pressed={chrome.visible}
                  onClick={toggleStrip}
                  title={
                    lang === "zh"
                      ? "显示/隐藏图片列表 · T"
                      : "Toggle image strip · T"
                  }
                >
                  {lang === "zh" ? "图片列表" : "Image strip"}
                </button>
              )}
              {!onlineReader && <><div className="reader-actions-flat">
                <ItemActions
                  target={{ kind: "book", bookId: book.id }}
                  title={book.title}
                  flat
                  showTrash
                  label={lang === "zh" ? "整本漫画" : "Book"}
                  onTrash={trashItem}
                  onError={setError}
                />
                {pages[index] && (
                  <ItemActions
                    target={{ kind: "page", bookId: book.id, page: index }}
                    title={pages[index].title}
                    flat
                    showTrash
                    label={lang === "zh" ? "当前图片" : "Current page"}
                    onTrash={trashItem}
                    onError={setError}
                  />
                )}
              </div>
              <button
                onClick={() => {
                  setTags(book.tags);
                  setAuthor(book.author);
                  setEdit(true);
                }}
              >
                ✎
              </button>
              </>}
            </>
          ) : (
            <input
              className="search"
              placeholder={t.search}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setGroup(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rememberSearch();
              }}
            />
          )}
          {(!!book || !aiView) && (!book || mode === "grid") && (
            <>
              <div className="spacer" />
              {[4, 9, 30].map((s) => (
                <button
                  className={size === s ? "chosen" : ""}
                  key={s}
                  onClick={() => {
                    setSize(s);
                    setGroup(0);
                  }}
                >
                  {s === 4 ? t.grid4 : s === 9 ? t.grid9 : t.wall}
                </button>
              ))}
              {(!favoritesView || !!book) && (
                <>
                  <button
                    disabled={group === 0}
                    onClick={() => setGroup(group - 1)}
                  >
                    ‹
                  </button>
                  <span>
                    {group + 1} / {total}
                  </span>
                  <button
                    disabled={group >= total - 1}
                    onClick={() => setGroup(group + 1)}
                  >
                    ›
                  </button>
                </>
              )}
            </>
          )}
        </div>}
        <div
          ref={stageRef}
          className={
            "reader-stage" +
            (chrome.fullscreen && !chrome.visible ? " cursor-idle" : "")
          }
          onPointerMove={chrome.pointerMove}
          onPointerDown={chrome.pointerDown}
          onKeyDownCapture={(e) => {
            if ((e.target as HTMLElement).closest(".filmstrip")) chrome.show();
          }}
          onWheelCapture={(e) => {
            if ((e.target as HTMLElement).closest(".filmstrip")) chrome.show();
          }}
        >
          <section
            ref={readingRef}
            className={"content " + (book && mode !== "grid" ? "reading" : "")}
            onErrorCapture={event => {
              if (onlineReader && mode !== "grid" && event.target instanceof HTMLImageElement)
                setError(zh ? "图片加载失败。可切换页码重试，或在浏览器打开原页。" : "Image failed to load. Change pages to retry, or open the source page.");
            }}
            onWheel={(e) => {
              if (!book && (favoritesView || aiView || onlineView)) return;
              if (mode !== "grid" && book) return;
              if (
                e.ctrlKey ||
                Math.abs(e.deltaY) < 30 ||
                Date.now() - wheel.current < 400
              )
                return;
              wheel.current = Date.now();
              setGroup((v) =>
                Math.max(0, Math.min(total - 1, v + (e.deltaY > 0 ? 1 : -1))),
              );
            }}
          >
            {onlineView && <div hidden={!!book}>
              <OnlineLibrary key={onlineSearch?.id ?? 0} lang={lang} size={size} setSize={setSize} tasks={onlineTasks}
                onRead={openOnline} onLocal={open} initialSearch={onlineSearch} onSearchSettings={() => beginTitleSearch()} />
            </div>}
            {!book && onlineView ? null : !book && aiView ? <AiHistoryView search={search} onPreview={id => setAiDialog({ recordId: id })} onBook={(id, page, recordId) => {
              void repair.ensure({ kind: "ai", id: recordId }, result => {
                const found = result?.book || books.find(b => b.id === id);
                if (!found) throw Error("请重新打开AI记录 / Reopen the AI history");
                applyOpen(found); setIndex(Math.min(result?.page ?? page, Math.max(0, found.pages - 1))); setMode("single");
              }).catch(failure => setError(String(failure)));
            }} /> : !book && favoritesView ? (
              <FavoritesView
                search={search}
                size={size}
                onOpen={(id) => void openFavorite(id)}
                onTrash={trashItem}
                onError={setError}
              />
            ) : !book ? (
              filtered.length ? (
                <>
                  <div className="section-label">
                    {t.all}
                    <span>
                      {filtered.length} {t.books}
                    </span>
                  </div>
                  <div className={"grid g" + size}>
                    {filtered
                      .slice(group * size, (group + 1) * size)
                      .map((b) => (
                        <Cover
                          book={b}
                          key={b.id}
                          onClick={() => open(b)}
                          onTrash={trashItem}
                          onError={setError}
                        />
                      ))}
                  </div>
                </>
              ) : (
                <div className="empty">
                  <div>▥</div>
                  <h2>{t.empty}</h2>
                  <p>{t.hint}</p>
                  <button className="primary" onClick={() => importBooks()}>
                    ＋ {t.import}
                  </button>
                  <small>CBZ · CBR · ZIP · RAR · 7Z · FOLDER</small>
                </div>
              )
            ) : mode === "grid" ? (
              <div className={"grid pages g" + size}>
                {pages.slice(group * size, (group + 1) * size).map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      go(group * size + i);
                      setMode("single");
                    }}
                  >
                    <Thumbnail url={p.url} title={p.title} />
                    <small>
                      {group * size + i + 1} · {p.title}
                    </small>
                  </button>
                ))}
              </div>
            ) : mode === "scroll" ? (
              <Continuous
                key={active}
                pages={pages}
                index={index}
                zoom={zoom}
                onIndexChange={go}
                onEndChange={complete => setScrollEnd(old => old.bookId === active && old.complete === complete ? old : { bookId: active, complete })}
              />
            ) : (
              <div
                className="spread"
                style={{
                  flexDirection: rtl ? "row-reverse" : "row",
                  transform: `scale(${zoom})`,
                }}
              >
                {pages
                  .slice(index, index + (mode === "double" ? 2 : 1))
                  .map((p) => (
                    <img key={p.id} src={aiReaderImage?.bookId === book.id && aiReaderImage.page === index && p.id === pages[index]?.id ? aiReaderImage.imageUrl || p.url : p.url} />
                  ))}
              </div>
            )}
          </section>
          {book && !onlineReader && mode !== "grid" && pages.length > 0 && (
            <ReadingChoices key={book.id + ":" + mode} bookId={book.id} lang={lang} onOpen={readNext}
              complete={mode === "scroll" ? scrollEnd.bookId === active && scrollEnd.complete : index + (mode === "double" ? 2 : 1) >= pages.length} />
          )}
          {book && mode !== "grid" && pages.length > 0 && (
            <>
              <Filmstrip
                key={book.id}
                pages={pages}
                index={index}
                onSelect={go}
                lang={lang}
                hidden={!chrome.visible}
                onHide={() => {
                  setFilmstripVisible(false);
                  chrome.hide();
                }}
              />
              {!chrome.visible && !chrome.fullscreen && (
                <button
                  className="filmstrip-restore"
                  onClick={() => {
                    setFilmstripVisible(true);
                    chrome.show();
                  }}
                >
                  {lang === "zh" ? "显示图片列表 · T" : "Show image strip · T"}
                </button>
              )}
              {chrome.fullscreen && (
                <button
                  className={
                    "fullscreen-exit" + (!chrome.visible ? " is-idle" : "")
                  }
                  tabIndex={chrome.visible ? 0 : -1}
                  aria-hidden={!chrome.visible}
                  onClick={fullscreenReader}
                >
                  {t.exitFullscreen} · Esc / F11
                </button>
              )}
            </>
          )}
        </div>
        <footer>
          <span>●　{busy ? t.indexing : onlineView ? (zh ? "在线阅读" : "Online reading") : t.local}</span>
          <span>
            {book ? `${index + 1} / ${pages.length}` : "mini.manga"}　·　
            {onlineView ? (book?.onlineUrl ? new URL(book.onlineUrl).hostname : "Mini Manga") : zh ? "离线，专注阅读" : "Offline. Stay focused."}
          </span>
        </footer>
      </main>
      {menu && (
        <div className="context" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => {
            const tab = tabs.find(item => item.id === menu.id);
            if (tab) beginTitleSearch(searchKeyword(tab.title));
          }}>{zh ? "搜索漫画标题" : "Search comic title"}</button>
          {(["left", "right", "others", "all"] as const).map((a) => (
            <button key={a} onClick={() => close(menu.id, a)}>
              {a === "all" ? t.close : t[a]}
            </button>
          ))}
        </div>
      )}
      {titleSearch && <TitleSearch lang={lang} initial={titleSearch.initial} onClose={() => setTitleSearch(null)}
        onLocal={keyword => { finishTitleSearch(); searchLibrary(keyword); }}
        onOnline={request => {
          finishTitleSearch();
          setOnlineSearch({ ...request, id: ++searchRequest.current });
          setOnlineView(true);
          setActive(null);
          setRecent(false);
          setSourceScope(null);
          setSearch("");
          setGroup(0);
        }} />}
      {aiDialog && <AiDialog key={aiDialog.recordId || `${aiDialog.source?.book.id}:${aiDialog.source?.index}`} {...aiDialog} onClose={() => setAiDialog(null)} />}
      {aiGallery && book && <AiHistoryPopup bookId={book.id} bookTitle={book.title} onSelect={selectAiImage} onClose={() => setAiGallery(false)} />}
      {edit && book && (
        <div className="modal">
          <div>
            <h2>{book.title}</h2>
            <label>
              {t.tags}
              <input value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <label>
              {t.author}
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </label>
            <button
              className="primary"
              onClick={async () => {
                await window.manga.metadata(book.id, tags, author);
                setTabs((v) =>
                  v.map((b) => (b.id === book.id ? { ...b, tags, author } : b)),
                );
                await client.invalidateQueries({ queryKey: ["books"] });
                setEdit(false);
              }}
            >
              {t.save}
            </button>
            <button onClick={() => setEdit(false)}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })}>
    <PathRepairProvider><App /></PathRepairProvider>
  </QueryClientProvider>,
);
