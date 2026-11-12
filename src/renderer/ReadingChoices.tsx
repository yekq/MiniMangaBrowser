import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Book, ReadingChoice } from "../contracts";
import { usePathRepair } from "./PathRepair";

function Choice({ item, next, lang, disabled, onOpen }: {
  item: ReadingChoice; next: boolean; lang: "zh" | "en";
  disabled: boolean; onOpen(): void;
}) {
  const cover = useQuery({
    queryKey: ["reading-choice-cover", item.id],
    queryFn: () => window.manga.readingChoiceCover(item.id),
    staleTime: 300000, retry: false, refetchOnWindowFocus: false,
  });
  return <button className="reading-choice" title={item.title} data-comic-title={item.title} disabled={disabled} onClick={onOpen}>
    <div className="reading-choice-art">
      {cover.data ? <img src={cover.data} alt="" loading="lazy" decoding="async" /> : <span title={cover.isError ? (lang === "zh" ? "封面不可用，仍可尝试打开" : "Cover unavailable; you can still try opening") : undefined}>▥</span>}
      {next && <em>{lang === "zh" ? "下一本" : "Next"}</em>}
    </div>
    <strong className="comic-title-text">{item.title}</strong>
    <small>{item.kind === "folder" ? (lang === "zh" ? "目录" : "Folder") : (lang === "zh" ? "文件" : "File")}</small>
  </button>;
}

export function ReadingChoices({ bookId, complete, lang, onOpen }: {
  bookId: string; complete: boolean; lang: "zh" | "en";
  onOpen(book: Book): void;
}) {
  const [visible, setVisible] = useState(complete);
  const repair = usePathRepair();
  const [group, setGroup] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  useEffect(() => {
    if (complete) setVisible(true);
  }, [complete]);
  const query = useQuery({
    queryKey: ["reading-choices", bookId],
    queryFn: () => window.manga.readingChoices(bookId),
    enabled: visible, staleTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  const items = query.data?.items || [];
  const total = Math.max(1, Math.ceil(items.length / 9));
  useEffect(() => setGroup(old => Math.min(old, total - 1)), [total]);
  const open = async (item: ReadingChoice) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await repair.ensure({ kind: "source", id: item.id }, async repaired => {
      const book = await window.manga.openSource(repaired?.sourceId || item.id);
      if (!book) throw Error(lang === "zh" ? "该目录已没有可阅读图片" : "This folder has no readable pages");
      if (current.current) onOpen(book);
      });
    } catch (e) { if (current.current) setError(String(e)); }
    finally { if (current.current) setBusy(false); }
  };
  if (!visible) return <button className="reading-choices-restore" onClick={() => setVisible(true)}>
    {lang === "zh" ? "同目录漫画 ›" : "Nearby comics ›"}
  </button>;
  return <div className="reading-choices" role="region" aria-label={lang === "zh" ? "继续阅读" : "Read next"}
    onWheel={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); setVisible(false); }
      e.stopPropagation();
    }}>
    <div className="reading-choices-heading">
      <div><strong>{complete ? (lang === "zh" ? "本篇已到末页" : "End of this comic") : (lang === "zh" ? "继续阅读" : "Read next")}</strong>
        <small>{lang === "zh" ? "同级漫画 · 名称排序" : "Sibling comics · Name order"}</small></div>
      <button aria-label={lang === "zh" ? "关闭继续阅读" : "Close read next"} onClick={() => setVisible(false)}>×</button>
    </div>
    {query.isPending ? <p role="status">{lang === "zh" ? "正在查找同级漫画…" : "Finding nearby comics…"}</p>
      : query.isError ? <div className="reading-choices-error" role="alert">{String(query.error)}<button onClick={() => void query.refetch()}>{lang === "zh" ? "重试" : "Retry"}</button></div>
      : items.length ? <div className="reading-choices-grid">
        {items.slice(group * 9, (group + 1) * 9).map(item => <Choice key={item.id} item={item} next={item.id === query.data?.nextId}
          lang={lang} disabled={busy} onOpen={() => void open(item)} />)}
      </div> : <p>{lang === "zh" ? "同级目录没有其他漫画" : "No other comics in this folder"}</p>}
    {error && <p className="reading-choices-error" role="alert">{error}</p>}
    <div className="reading-choices-footer">
      <button aria-label={lang === "zh" ? "上一组漫画" : "Previous comics"} disabled={group === 0 || busy} onClick={() => setGroup(group - 1)}>‹</button>
      <span>{busy ? (lang === "zh" ? "正在打开…" : "Opening…") : `${group + 1} / ${total} · ${items.length} ${lang === "zh" ? "本" : "comics"}`}</span>
      <button aria-label={lang === "zh" ? "下一组漫画" : "More comics"} disabled={group >= total - 1 || busy} onClick={() => setGroup(group + 1)}>›</button>
    </div>
  </div>;
}
