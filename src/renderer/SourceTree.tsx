import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Book, ItemTarget } from "../contracts";
import { ItemActions } from "./Favorites";
import { useLocale } from "./settings";
import { usePathRepair } from "./PathRepair";
export type SourceReveal = { ids: string[]; request: number };
export const SourceTree = React.memo(function SourceTree({
  onOpen,
  browseSourceId,
  reveal,
  onTrash,
  onError,
}: {
  onOpen: (b: Book) => void;
  browseSourceId?: string;
  reveal?: SourceReveal;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { data: roots = [] } = useQuery({
    queryKey: ["sources"],
    queryFn: () => window.manga.sources(),
  });
  return (
    <div className="source-tree">
      {roots.map((n) => (
        <Node
          key={n.id}
          node={n}
          onOpen={onOpen}
          browseSourceId={browseSourceId}
          reveal={reveal}
          onTrash={onTrash}
          onError={onError}
        />
      ))}
    </div>
  );
});
function Node({
  node,
  onOpen,
  ancestors = [],
  browseSourceId,
  reveal,
  onTrash,
  onError,
}: {
  node: { id: string; title: string; leaf: boolean; bookId?: string };
  onOpen: (b: Book) => void;
  ancestors?: string[];
  browseSourceId?: string;
  reveal?: SourceReveal;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const client = useQueryClient();
  const repair = usePathRepair();
  const [expanded, setExpanded] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [lang] = useLocale();
  const button = useRef<HTMLButtonElement>(null);
  const revealHere = !!reveal && reveal.ids[ancestors.length] === node.id &&
    ancestors.every((id, index) => reveal.ids[index] === id);
  const selected = reveal ? revealHere && node.id === reveal.ids.at(-1) : node.id === browseSourceId;
  useEffect(() => {
    if (node.id === browseSourceId || revealHere) setExpanded(true);
  }, [browseSourceId, node.id, reveal?.request]);
  useEffect(() => {
    if (!selected || !reveal) return;
    const frame = requestAnimationFrame(() => {
      button.current?.focus({ preventScroll: true });
      button.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, reveal?.request]);
  const cycle = ancestors.includes(node.id);
  const { data: children = [] } = useQuery({
    queryKey: ["children", node.id],
    queryFn: () => window.manga.children(node.id),
    enabled: expanded && !node.leaf && !cycle,
  });
  return (
    <div>
      <div
        className={
          "source-row" + (selected ? " source-current" : "")
        }
        data-source-id={node.id}
      >
        <button
          ref={button}
          title={node.title}
          data-comic-title={node.title}
          aria-current={selected ? "true" : undefined}
          aria-expanded={!node.leaf ? expanded : undefined}
          onClick={async () => {
            if (opening) return;
            setOpening(true);
            try {
              await repair.ensure({ kind: "source", id: node.id }, async repaired => {
              if (!node.leaf && expanded && !repaired) { setExpanded(false); return; }
              if (!cycle) setExpanded(!expanded || !!repaired);
              await client.invalidateQueries({ queryKey: ["children", node.id] });
              const book = await window.manga.openSource(repaired?.sourceId || node.id);
              // Folder clicks can register its immediate books lazily.
              await client.invalidateQueries({ queryKey: ["books"] });
              if (book) {
                onOpen(book);
              }
              });
            } catch (e) {
              onError(String(e));
            } finally { setOpening(false); }
          }}
        >
          {opening ? "…" : node.leaf ? "▥" : expanded ? "▾" : "▸"}　<span className="comic-title-text">{node.title}</span>
        </button>
        <button
          className="source-forget"
          title={
            lang === "zh"
              ? "移除导入记录，保留原文件"
              : "Remove import, keep files"
          }
          aria-label={
            node.title + (lang === "zh" ? " 移除导入" : " Remove import")
          }
          onClick={() => void onTrash({ kind: "source", sourceId: node.id })}
        >
          ×
        </button>
        <details className="source-actions" onToggle={event => {
          if (event.target === event.currentTarget) setActionsOpen(event.currentTarget.open);
        }}>
          <summary
            aria-label={`${node.title} ${lang === "zh" ? "目录操作" : "folder actions"}`}
          >
            ⋯
          </summary>
          {actionsOpen && <ItemActions
            target={{ kind: "source", sourceId: node.id }}
            title={node.title}
            onTrash={onTrash}
            onError={onError}
          />}
        </details>
      </div>
      {expanded && (
        <div style={{ paddingLeft: 12 }}>
          {children.map((n) => (
            <Node
              key={n.id}
              node={n}
              onOpen={onOpen}
              ancestors={[...ancestors, node.id]}
              browseSourceId={browseSourceId}
              reveal={reveal}
              onTrash={onTrash}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
