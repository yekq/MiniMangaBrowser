import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiEdit, Book, Page } from "../contracts";
import { useLocale } from "./settings";
import { MaskEditor } from "./MaskEditor";

const statusText = (record: AiEdit, zh: boolean) => ({ generating: zh ? "生成中" : "Generating", ready: zh ? "待保存" : "Ready", saved: zh ? "已保存" : "Saved", failed: zh ? "失败" : "Failed", deleted: zh ? "结果已删除" : "Deleted" })[record.status];
export type AiSource = { book: Book; page: Page; index: number };

export function AiDialog({ source, recordId, onClose }: { source?: AiSource; recordId?: string; onClose(): void }) {
  const [lang] = useLocale(), zh = lang === "zh", client = useQueryClient();
  const [prompt, setPrompt] = useState(""), [profile, setProfile] = useState("");
  const [id, setId] = useState(recordId), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [local, setLocal] = useState(false), [mask, setMask] = useState<string>(), [parameters, setParameters] = useState<Record<string, number>>({});
  const [compare, setCompare] = useState(false);
  const profiles = useQuery({ queryKey: ["ai-profiles"], queryFn: () => window.manga.aiProfiles(), retry: false });
  const record = useQuery({ queryKey: ["ai-record", id], queryFn: () => window.manga.aiGet(id!), enabled: !!id, refetchInterval: q => q.state.data?.status === "generating" ? 1500 : false });
  const original = useQuery({ queryKey: ["ai-original", id], queryFn: () => window.manga.aiOriginal(id!), enabled: compare && !!id, retry: false });
  useEffect(() => { if (!profile && profiles.data) setProfile(profiles.data.defaultProfile); }, [profiles.data]);
  useEffect(() => setParameters({}), [profile]);
  const selected = profiles.data?.profiles.find(p => p.id === profile), masked = !!selected?.requiresMask || local;
  useEffect(() => { if (record.data && record.data.status !== "generating") void client.invalidateQueries({ queryKey: ["ai-history"] }); }, [record.data?.status]);
  const refresh = () => client.invalidateQueries({ queryKey: ["ai-history"] });
  const run = async (operation: () => Promise<void>) => { setPending(true); setError(""); try { await operation(); } catch (e) { setError(String(e)); } finally { setPending(false); } };
  const start = () => void run(async () => {
    if (!source) return;
    const created = await window.manga.aiStart(source.book.id, source.index, prompt, profile, { ...(masked && mask ? { mask } : {}), parameters });
    client.setQueryData(["ai-record", created.id], created); setId(created.id); await refresh();
  });
  const current = record.data;
  const body = <div className="modal ai-modal" role="dialog" aria-modal="true" aria-label={zh ? "AI修改" : "AI edit"}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") onClose(); }}>
    <div className="ai-dialog">
      <div className="ai-heading"><div><h2>{zh ? "AI 修改" : "AI edit"}</h2><small>{current ? `${current.bookTitle} · ${current.pageTitle}` : `${source?.book.title} · ${source?.page.title}`}</small></div><button onClick={onClose} aria-label={zh ? "关闭AI窗口" : "Close AI dialog"}>×</button></div>
      {!id ? <>
        <div className="ai-input-layout">
          {source && (masked ? <MaskEditor key={source.page.url} image={source.page.url} onChange={setMask} /> : <img className="ai-source" src={source.page.url} alt={zh ? "当前原图" : "Original page"} />)}
          <div>
            <label>{zh ? "模型" : "Model"}<select aria-label={zh ? "AI模型" : "AI model"} value={profile} onChange={e => setProfile(e.target.value)}>{profiles.data?.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <small className="ai-endpoint">{profiles.data?.profiles.find(p => p.id === profile)?.endpoint}</small>
            {!selected?.requiresMask && <label className="ai-local-toggle"><input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} />{zh ? "局部修改（涂抹选区）" : "Local edit (paint mask)"}</label>}
            {selected?.promptHint && <p className="ai-hint">{selected.promptHint}</p>}
            <label>{zh ? "修改要求" : "Edit instructions"}<textarea autoFocus rows={5} aria-label={zh ? "AI修改要求" : "AI edit instructions"} value={prompt} maxLength={6000} onChange={e => setPrompt(e.target.value)} placeholder={zh ? "描述要修改的内容，以及希望保留的内容…" : "Describe the change and what to preserve…"} onKeyDown={e => { if (e.ctrlKey && e.key === "Enter" && prompt.trim() && profile && !pending && (!masked || mask)) start(); }} /></label>
            {!!selected?.parameters?.length && <details className="ai-parameters"><summary>{zh ? "局部修改参数" : "Edit parameters"}</summary>{selected.parameters.map(p => <label key={p.key}>{p.label}<input aria-label={p.label} type="range" min={p.min} max={p.max} step={p.step} value={parameters[p.key] ?? p.default} onChange={e => setParameters(old => ({ ...old, [p.key]: Number(e.target.value) }))} /><output>{parameters[p.key] ?? p.default}</output></label>)}</details>}
            <p className="ai-hint">{zh ? "仅发送当前这一页。图片会按模型配置缩放；原图不会被覆盖。" : "Only this page is sent. The original will not be overwritten."}</p>
            <div className="ai-actions"><button className="primary" disabled={pending || !profile || !prompt.trim() || (masked && !mask)} onClick={start}>{pending ? (zh ? "提交中…" : "Submitting…") : (zh ? "发送并修改" : "Generate edit")}</button><button onClick={onClose}>{zh ? "关闭" : "Close"}</button></div>
            <div className="ai-config-actions"><button onClick={() => void run(() => window.manga.aiConfigure())}>{zh ? "打开模型配置" : "Model configuration"}</button><button onClick={() => void profiles.refetch()}>{zh ? "刷新配置" : "Reload profiles"}</button></div>
          </div>
        </div>
      </> : current ? <>
        <div className="ai-status" role="status">{statusText(current, zh)} · {current.profileName}{current.seconds !== undefined && ` · ${current.seconds.toFixed(1)}s`}</div>
        {current.status === "generating" && <p>{zh ? "正在执行图片修改。可关闭此窗口，稍后在“AI修改记录”查看结果。" : "Generating. You can close this dialog and return through AI history."}</p>}
        {current.imageUrl && <>
          <div className="ai-compare-actions"><button aria-pressed={compare} onClick={() => setCompare(v => !v)}>{compare ? (zh ? "只看修改结果" : "Show result only") : (zh ? "修改前后对比" : "Compare before / after")}</button></div>
          {compare ? original.isPending ? <p>{zh ? "正在加载原图…" : "Loading original…"}</p>
            : original.data ? <div className="ai-compare-grid">
              <div><strong>{zh ? "修改前 · 原图" : "Before · Original"}</strong><img src={original.data} alt={zh ? "修改前原图" : "Original before edit"} /></div>
              <div><strong>{zh ? "修改后 · AI结果" : "After · AI result"}</strong><img src={current.imageUrl} alt={zh ? "修改后图片" : "Edited image"} /></div>
            </div> : <p className="ai-error" role="status">{zh ? "原图无法读取，可能已被移动或删除。" : "Original is unavailable; it may have been moved or deleted."}{original.error && ` ${String(original.error)}`}</p>
            : <div className="ai-result"><img src={current.imageUrl} alt={zh ? "AI修改结果" : "AI edited result"} /></div>}
        </>}
        <details className="ai-prompt"><summary>{zh ? "查看修改要求" : "View instructions"}</summary><p>{current.prompt}</p>{current.localEdit && <small>{zh ? "局部遮罩修改：选区外由原图保留" : "Masked edit: the original is preserved outside the mask"}</small>}</details>
        {current.error && <p className="ai-error" role="alert">{current.error}</p>}
        {current.savedPath && <p className="ai-saved-path">{zh ? "已保存：" : "Saved: "}{current.savedPath}</p>}
        <div className="ai-actions">
          {(current.status === "ready" || current.status === "saved") && <button className="primary" disabled={pending || current.status === "saved"} onClick={() => void run(async () => { const saved = await window.manga.aiSave(current.id); client.setQueryData(["ai-record", id], saved); await refresh(); await client.invalidateQueries({ queryKey: ["pages", current.bookId] }); })}>{current.status === "saved" ? (zh ? "已保存" : "Saved") : (zh ? "保存到当前路径" : "Save beside original")}</button>}
          {current.status !== "generating" && current.status !== "deleted" && <button disabled={pending} onClick={() => {
            if (!window.confirm(zh ? "将此AI生成结果移到回收站？原图不受影响；已保存的副本也会一并删除。" : "Move this AI result and its saved copy to Recycle Bin? The original is unaffected.")) return;
            void run(async () => { await window.manga.aiDelete(current.id); await refresh(); onClose(); });
          }}>{zh ? "删除" : "Delete"}</button>}
          <button onClick={onClose}>{zh ? "关闭" : "Close"}</button>
        </div>
        <small className="ai-hint">{zh ? "关闭会保留记录。保存会新建PNG；压缩包/PDF的结果写入同级的“原文件名_AI”文件夹。" : "Closing keeps history. Saving creates a new PNG; archive/PDF edits use a sibling _AI folder."}</small>
      </> : <p>{zh ? "加载中…" : "Loading…"}</p>}
      {(error || profiles.error || record.error) && <p className="ai-error" role="alert">{error || String(profiles.error || record.error)}</p>}
    </div>
  </div>;
  return createPortal(body, document.fullscreenElement || document.body);
}

export function AiHistoryView({ search, onPreview, onBook }: { search: string; onPreview(id: string): void; onBook(bookId: string, page: number, recordId: string): void }) {
  const [lang] = useLocale(), zh = lang === "zh";
  const [book, setBook] = useState("");
  const [removing, setRemoving] = useState<string>();
  const [removeError, setRemoveError] = useState("");
  const client = useQueryClient();
  const { data: records = [], error } = useQuery({ queryKey: ["ai-history", search], queryFn: () => window.manga.aiHistory(search), refetchInterval: 2000 });
  const books = new Map(records.map(r => [r.bookId, r.bookTitle]));
  const selected = records.filter(r => !book || r.bookId === book);
  const removeRecord = async (record: AiEdit) => {
    if (!window.confirm(zh ? "仅移除这条AI修改记录？生成图片及已保存的副本不会删除。" : "Remove this history entry only? Generated and saved images will be kept.")) return;
    setRemoving(record.id); setRemoveError("");
    try { await window.manga.aiRemove(record.id); await client.invalidateQueries({ queryKey: ["ai-history"] }); }
    catch (e) { setRemoveError(String(e)); }
    finally { setRemoving(undefined); }
  };
  return <div className="ai-history">
    <div className="ai-history-heading"><h2>{zh ? "AI 修改记录" : "AI edit history"}</h2><label>{zh ? "漫画" : "Book"}<select aria-label={zh ? "筛选AI记录漫画" : "Filter AI history by book"} value={book} onChange={e => setBook(e.target.value)}><option value="">{zh ? "全部漫画" : "All books"}</option>{Array.from(books).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label></div>
    {error && <p role="alert">{String(error)}</p>}
    {removeError && <p role="alert" className="ai-error">{removeError}</p>}
    {!records.length && <p>{zh ? "尚无修改记录。在漫画阅读工具栏点击“AI修改”即可开始。" : "No edits yet. Open a book and use AI edit in the toolbar."}</p>}
    {Array.from(books).filter(([id]) => !book || id === book).map(([id, title]) => <section key={id} className="ai-book-history"><button className="ai-book-title" onClick={() => { const record = selected.find(r => r.bookId === id)!; onBook(id, record.page, record.id); }}>{title} ↗</button><div className="ai-record-grid">{selected.filter(r => r.bookId === id).map(r => <article key={r.id} className="ai-record-card">
      <button className="ai-record-preview" onClick={() => onPreview(r.id)}>{r.imageUrl ? <img src={r.imageUrl} alt={r.pageTitle} loading="lazy" /> : <span>{statusText(r, zh)}</span>}</button>
      <strong>{r.pageTitle}</strong><small>{r.profileName} · {statusText(r, zh)}</small><small>{new Date(r.createdAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</small><p>{r.prompt}</p>
      <div className="ai-record-actions"><button onClick={() => onPreview(r.id)}>{zh ? "查看结果 / 操作" : "View / actions"}</button><button disabled={r.status === "generating" || removing === r.id} onClick={() => void removeRecord(r)}>{removing === r.id ? "…" : (zh ? "移除记录" : "Remove record")}</button></div>
    </article>)}</div></section>)}
  </div>;
}

/** Reader-local gallery: only images belonging to the open comic can replace the displayed page. */
export function AiHistoryPopup({ bookId, bookTitle, onSelect, onClose }: { bookId: string; bookTitle: string; onSelect(record: AiEdit): void; onClose(): void }) {
  const [lang] = useLocale(), zh = lang === "zh";
  const { data: records = [], error } = useQuery({ queryKey: ["ai-history", "", bookId], queryFn: () => window.manga.aiHistory("", bookId), refetchInterval: 2000 });
  const images = records.filter(record => record.imageUrl && (record.status === "ready" || record.status === "saved"));
  useEffect(() => {
    const dismiss = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);
  return createPortal(<div className="modal ai-modal ai-gallery-modal" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ai-gallery" role="dialog" aria-modal="true" aria-label={zh ? "阅读器AI修改记录" : "Reader AI edit history"}>
      <div className="ai-heading"><div><h2>{zh ? "AI修改记录" : "AI edit history"}</h2><small>{bookTitle} · {zh ? "选择图片在当前阅读界面查看" : "Select an image to show in the reader"}</small></div><button onClick={onClose} aria-label={zh ? "关闭AI修改记录" : "Close AI edit history"}>×</button></div>
      {error && <p role="alert" className="ai-error">{String(error)}</p>}
      {!images.length && <p>{zh ? "当前漫画暂无可查看的AI修改图片。" : "No AI edited images are available for this comic."}</p>}
      <div className="ai-gallery-grid" aria-label={zh ? "AI修改图片九宫格" : "AI image gallery"}>
        {images.map(record => <button key={record.id} className="ai-gallery-item" title={`${record.pageTitle} · ${record.prompt}`} onClick={() => onSelect(record)}>
          <img src={record.imageUrl} alt={record.pageTitle} loading="lazy" /><small>{record.page + 1} · {record.pageTitle}</small>
        </button>)}
      </div>
    </div>
  </div>, document.fullscreenElement || document.body);
}
