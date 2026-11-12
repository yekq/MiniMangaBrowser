import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { RepairCandidate, RepairInfo, RepairResult, RepairTarget } from "../contracts";
import { useLocale } from "./settings";

type Action = (result?: RepairResult) => void | Promise<void>;
type Request = { target: RepairTarget; info: RepairInfo; action: Action };
const RepairContext = createContext<{ ensure(target: RepairTarget, action: Action): Promise<void> } | null>(null);
export function usePathRepair() { const value = useContext(RepairContext); if (!value) throw Error("Missing path repair provider"); return value; }

export function PathRepairProvider({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const [request, setRequest] = useState<Request | null>(null), [error, setError] = useState("");
  const current = useRef<Request | null>(null);
  const ensure = useCallback(async (target: RepairTarget, action: Action) => {
    if (current.current) return;
    const info = await window.manga.repairInfo(target);
    if (info.available) { await action(); return; }
    const next = { target, info, action }; current.current = next; setRequest(next);
  }, []);
  const value = useMemo(() => ({ ensure }), [ensure]);
  const close = () => { current.current = null; setRequest(null); };
  return <RepairContext.Provider value={value}>{children}
    {request && <RepairDialog request={request} onClose={close} onApply={async candidate => {
      const result = await window.manga.repairApply(request.target, candidate.id);
      await Promise.all(["books", "sources", "children", "pages", "cover", "favorites", "favorite-cover", "ai-history", "ai-record", "ai-original", "reading-choices"].map(key =>
        client.invalidateQueries({ queryKey: [key] })));
      close();
      try { await request.action(result); } catch (failure) { setError(String(failure)); }
    }} />}
    {error && <div className="repair-global-error" role="alert" onClick={() => setError("")}>{error} ×</div>}
  </RepairContext.Provider>;
}

function RepairDialog({ request, onClose, onApply }: { request: Request; onClose(): void; onApply(candidate: RepairCandidate): Promise<void> }) {
  const [lang] = useLocale(), zh = lang === "zh";
  const [keyword, setKeyword] = useState(request.info.keyword), [items, setItems] = useState<RepairCandidate[]>([]);
  const [selected, setSelected] = useState<string>(), [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false), [searching, setSearching] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0);
  const search = async (name: string) => {
    const number = ++sequence.current; setSearching(true); setError(""); setSelected(undefined); setItems([]);
    try {
      const result = await window.manga.repairSearch(request.target, name);
      if (number === sequence.current) { setItems(result.items); setTotal(result.total); }
    } catch (failure) { if (number === sequence.current) setError(String(failure)); }
    finally { if (number === sequence.current) setSearching(false); }
  };
  useEffect(() => { void search(request.info.keyword); return () => { sequence.current++; }; }, []);
  const browse = async (mode: "folder" | "file") => {
    setBusy(true); setError("");
    try { const item = await window.manga.repairBrowse(request.target, mode); if (item) { setItems(old => [item, ...old]); setSelected(item.id); } }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  };
  return createPortal(<div className="modal repair-modal" role="dialog" aria-modal="true" aria-label={zh ? "查找漫画新位置" : "Find comic location"}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); } }}>
    <div className="repair-dialog">
      <div className="repair-heading"><h2>{zh ? "查找漫画新位置" : "Find comic location"}</h2><button disabled={busy} onClick={onClose} aria-label={zh ? "关闭路径修复" : "Close path repair"}>×</button></div>
      <strong>{request.info.title}</strong>
      <p>{request.info.missingRecord ? (zh ? "原漫画已不在书库中，可找回文件并重建关联。" : "The book record is missing. Select a file to restore its link.") : (zh ? "原位置已不存在。选择新位置后修正书库路径。" : "The original location is missing. Select the new location.")}</p>
      <code className="repair-original">{request.info.oldPath}</code>
      <form className="repair-search" onSubmit={event => { event.preventDefault(); void search(keyword); }}>
        <input autoFocus aria-label={zh ? "漫画名称关键词" : "Comic name keyword"} value={keyword} disabled={busy} onChange={event => setKeyword(event.target.value)} />
        <button disabled={busy || searching || !keyword.trim()} type="submit">{searching ? "…" : (zh ? "Everything 搜索" : "Search Everything")}</button>
      </form>
      <small>{zh ? "按名称查找索引；可修改关键词。只在你确认后修正路径。" : "Search the index by name; edit the keyword if needed. Paths change only after confirmation."}</small>
      {searching && <p role="status">{zh ? "正在搜索 Everything 索引…" : "Searching Everything…"}</p>}
      {error && <p className="repair-error" role="alert">{error}</p>}
      {!searching && !error && !items.length && <p>{zh ? "没有找到候选位置，可修改关键词或手动选择。" : "No matches. Change the keyword or choose a location manually."}</p>}
      <div className="repair-results" role="radiogroup" aria-label={zh ? "候选漫画位置" : "Candidate locations"}>
        {items.map(item => <label key={item.id} className={selected === item.id ? "repair-result selected" : "repair-result"}>
          <input type="radio" name="repair-location" value={item.id} checked={selected === item.id} disabled={busy} onChange={() => setSelected(item.id)} />
          <span>{item.kind === "folder" ? "▸" : "▥"}</span><div><strong>{item.title}</strong><small>{item.path}</small><em>{item.kind === "folder" ? (zh ? "目录" : "Folder") : (zh ? "文件" : "File")}{typeof item.size === "number" ? ` · ${(item.size / 1048576).toFixed(1)} MB` : ""}</em></div>
        </label>)}
      </div>
      {!!items.length && <small>{zh ? `显示 ${items.length} 项，索引命中 ${total} 项。选择后会重新检查文件。` : `${items.length} shown, ${total} indexed matches. The selected location will be checked again.`}</small>}
      <div className="repair-footer"><button disabled={busy} onClick={() => void browse("folder")}>{zh ? "手动选择目录" : "Choose folder"}</button><button disabled={busy} onClick={() => void browse("file")}>{zh ? "手动选择文件" : "Choose file"}</button><span />
        <button disabled={busy} onClick={onClose}>{zh ? "取消" : "Cancel"}</button>
        <button className="primary" disabled={busy || !selected} onClick={async () => {
          const item = items.find(item => item.id === selected); if (!item) return;
          setBusy(true); setError(""); try { await onApply(item); } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
        }}>{busy ? "…" : (zh ? "修正路径并打开" : "Repair and open")}</button>
      </div>
    </div>
  </div>, document.fullscreenElement || document.body);
}
