import React, { useEffect, useRef, useState } from "react";
import { appSearchSource, builtInSearchSchemes, expandSearch, searchKeyword, type SearchScheme } from "../contracts/titleSearch";
import { useSettings } from "./settings";

type Lang = "zh" | "en";
const titleSelector = "[data-comic-title]";

export function selectedTitle(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return "";
  if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return "";
  return searchKeyword(selection.toString());
}

export function contextTitle(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return "";
  const element = target.closest<HTMLElement>(titleSelector);
  return element ? selectedTitle(element) || searchKeyword(element.dataset.comicTitle ?? "") : "";
}

function SchemeSettings({ lang, schemes, onBack }: { lang: Lang; schemes: SearchScheme[]; onBack?: () => void }) {
  const zh = lang === "zh";
  const custom = useSettings(state => state.searchSchemes);
  const defaultId = useSettings(state => state.defaultSearchScheme);
  const setDefault = useSettings(state => state.setDefaultSearchScheme);
  const save = useSettings(state => state.saveSearchScheme);
  const remove = useSettings(state => state.removeSearchScheme);
  const [draft, setDraft] = useState<SearchScheme | null>(null);
  const [error, setError] = useState("");
  return <>
    <label>
      {zh ? "默认搜索方案" : "Default search scheme"}
      <select aria-label={zh ? "默认搜索方案" : "Default search scheme"} value={defaultId} onChange={event => setDefault(event.target.value)}>
        {schemes.map(scheme => <option value={scheme.id} key={scheme.id}>{scheme.name}</option>)}
      </select>
    </label>
    {custom.length > 0 && <ul className="title-schemes">
      {custom.map(scheme => <li key={scheme.id}>
        <span><strong>{scheme.name}</strong><small title={scheme.template}>{scheme.template}</small></span>
        <button onClick={() => { setDraft(scheme); setError(""); }}>{zh ? "编辑" : "Edit"}</button>
        <button onClick={() => { remove(scheme.id); if (draft?.id === scheme.id) setDraft(null); }}>{zh ? "移除" : "Remove"}</button>
      </li>)}
    </ul>}
    {draft ? <form onSubmit={event => {
      event.preventDefault();
      try {
        const name = draft.name.trim();
        if (!name) throw Error(zh ? "请输入方案名称" : "Enter a scheme name");
        expandSearch(draft.template, "example");
        save({ ...draft, id: draft.id || crypto.randomUUID(), name, template: draft.template.trim() });
        setDraft(null);
        setError("");
      } catch (failure) { setError(String(failure)); }
    }}>
      <label>{zh ? "方案名称" : "Scheme name"}
        <input value={draft.name} maxLength={80} required onChange={event => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <label>{zh ? "搜索网址模板" : "Search URL template"}
        <input value={draft.template} maxLength={2000} required placeholder="https://example.com/search?q={query}"
          onChange={event => setDraft({ ...draft, template: event.target.value })} />
      </label>
      <small>{zh ? "用 {query} 代替网址中的关键词。" : "Use {query} in place of the keyword in the URL."}</small>
      {error && <p className="online-error" role="alert">{error}</p>}
      <div className="title-search-actions">
        <button type="submit" className="primary">{zh ? "保存方案" : "Save scheme"}</button>
        <button type="button" onClick={() => { setDraft(null); setError(""); }}>{zh ? "取消编辑" : "Cancel edit"}</button>
      </div>
    </form> : <div className="title-search-actions">
      <button className="primary" onClick={() => { setDraft({ id: "", name: "", template: "" }); setError(""); }}>
        {zh ? "＋ 添加搜索方案" : "＋ Add search scheme"}
      </button>
      {onBack && <button onClick={onBack}>{zh ? "返回搜索" : "Back to search"}</button>}
    </div>}
  </>;
}

export function TitleSearch({ lang, initial, onClose, onLocal, onOnline }: {
  lang: Lang;
  initial?: string;
  onClose(): void;
  onLocal(keyword: string): void;
  onOnline(search: { sourceUrl: string; url: string; keyword: string; template: string }): void;
}) {
  const zh = lang === "zh";
  const custom = useSettings(state => state.searchSchemes);
  const defaultId = useSettings(state => state.defaultSearchScheme);
  const schemes = [...builtInSearchSchemes, ...custom];
  const [keyword, setKeyword] = useState(initial ?? "");
  const [selected, setSelected] = useState<string>();
  const [configuring, setConfiguring] = useState(initial === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const chosen = schemes.find(scheme => scheme.id === (selected ?? defaultId)) ?? schemes[0];
  const term = searchKeyword(keyword);
  let url: URL | undefined;
  try { if (term) url = expandSearch(chosen.template, term); } catch {}
  const sourceUrl = url && appSearchSource(url);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const openOnline = () => {
    if (sourceUrl && url) onOnline({ sourceUrl, url: url.href, keyword: term, template: chosen.template });
  };
  const openBrowser = async () => {
    if (!url || busy) return;
    setBusy(true);
    setError("");
    try { await window.manga.onlineExternal(url.href); onClose(); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  return <dialog className="title-search-dialog" ref={dialog} aria-labelledby="title-search-heading"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => event.stopPropagation()}>
    <div className="title-search-heading">
      <h2 id="title-search-heading">{configuring ? (zh ? "搜索方案" : "Search schemes") : (zh ? "搜索漫画标题" : "Search comic title")}</h2>
      <button type="button" disabled={busy} onClick={onClose} aria-label={zh ? "关闭搜索" : "Close search"}>×</button>
    </div>
    {configuring ? <SchemeSettings lang={lang} schemes={schemes} onBack={initial === undefined ? undefined : () => setConfiguring(false)} /> :
      <form onSubmit={event => {
        event.preventDefault();
        if (sourceUrl) openOnline();
        else void openBrowser();
      }}>
        <label>{zh ? "搜索关键词" : "Search keyword"}
          <input autoFocus value={keyword} maxLength={200} onChange={event => setKeyword(event.target.value)} />
        </label>
        <label>{zh ? "搜索方案" : "Search scheme"}
          <select aria-label={zh ? "搜索方案" : "Search scheme"} value={chosen.id} onChange={event => { setSelected(event.target.value); setError(""); }}>
            {schemes.map(scheme => <option value={scheme.id} key={scheme.id}>{scheme.name}</option>)}
          </select>
        </label>
        {url && !sourceUrl && <small>{zh ? "此方案在浏览器打开结果。" : "This scheme opens results in the browser."}</small>}
        {error && <p className="online-error" role="alert">{error}</p>}
        <div className="title-search-actions">
          <button type="button" className="primary" disabled={!sourceUrl || busy} onClick={openOnline}>{zh ? "在 Mini Manga 搜索" : "Search in Mini Manga"}</button>
          <button type="button" disabled={!url || busy} onClick={() => void openBrowser()}>{zh ? "在浏览器搜索" : "Search in browser"}</button>
          <button type="button" disabled={!term || busy} onClick={() => onLocal(term)}>{zh ? "搜索本地书库" : "Search local library"}</button>
          <button type="button" disabled={busy} onClick={() => setConfiguring(true)}>{zh ? "配置方案" : "Configure schemes"}</button>
        </div>
      </form>}
  </dialog>;
}
