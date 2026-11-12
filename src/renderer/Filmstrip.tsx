import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Page } from "../contracts";
import { Thumbnail } from "./Thumbnail";
import { FILMSTRIP_DURATION, FILMSTRIP_PITCH, nearestPosition, visibleSlots, wrapPage } from "./filmstripMath";

export function Filmstrip({ pages, index, onSelect, onHide, lang, hidden = false }: {
  pages: Page[];
  index: number;
  onSelect: (index: number) => void;
  onHide: () => void;
  lang: "zh" | "en";
  hidden?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [position, setPosition] = useState(index);
  const [drag, setDrag] = useState<number | null>(null);
  const pointer = useRef<{ id: number; start: number } | null>(null);
  const ignoreClickUntil = useRef(0);
  const direction = useRef(0);
  const latest = useRef({ index, count: pages.length, onSelect });
  latest.current = { index, count: pages.length, onSelect };
  const zh = lang === "zh";
  const step = (delta: number) => {
    const value = latest.current;
    if (value.count > 1) {
      direction.current = Math.sign(delta);
      value.onSelect(wrapPage(value.index + delta, value.count));
    }
  };
  useLayoutEffect(() => {
    const preferred = direction.current;
    setPosition((value) => nearestPosition(value, index, pages.length, preferred));
    direction.current = 0;
  }, [index, pages.length]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    let distance = 0, lastEvent = 0, lastTurn = -Infinity;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) return;
      const now = performance.now();
      if (now - lastEvent > 120) distance = 0;
      lastEvent = now;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      distance += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      if (Math.abs(distance) >= 20 && now - lastTurn >= 40) {
        step(Math.sign(distance));
        distance = 0;
        lastTurn = now;
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, []);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const value = pointer.current;
    if (!value || value.id !== event.pointerId) return;
    const distance = event.clientX - value.start;
    pointer.current = null;
    setDrag(null);
    if (Math.abs(distance) > 16) {
      ignoreClickUntil.current = performance.now() + 40;
      if (!cancelled) step(Math.round(-distance / FILMSTRIP_PITCH) || -Math.sign(distance));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className={"filmstrip" + (hidden ? " is-idle" : "")} aria-hidden={hidden} inert={hidden} data-animation-ms={FILMSTRIP_DURATION} role="region"
    aria-label={zh ? "当前文件夹图片列表" : "Current folder images"}
    onKeyDown={(event) => {
      if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Home") onSelect(0);
        else if (event.key === "End") onSelect(pages.length - 1);
        else step(["ArrowRight", "PageDown"].includes(event.key) ? 1 : -1);
      }
    }}>
    <div className="filmstrip-header">
      <span>{zh ? "当前目录" : "Current folder"} · {index + 1} / {pages.length}</span>
      <small>{zh ? "滚轮 / 拖动 / 点击切换" : "Wheel / drag / click"}</small>
      <button onClick={onHide} aria-label={zh ? "隐藏图片列表" : "Hide image strip"} title={zh ? "隐藏 · T" : "Hide · T"}>×</button>
    </div>
    <div className="filmstrip-body">
      <button className="filmstrip-arrow" disabled={pages.length < 2} onClick={() => step(-1)} aria-label={zh ? "列表上一张" : "Strip previous image"}>‹</button>
      <div className="filmstrip-viewport" ref={viewport}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointer.current = { id: event.pointerId, start: event.clientX };
        }}
        onPointerMove={(event) => {
          if (pointer.current?.id !== event.pointerId) return;
          const distance = event.clientX - pointer.current.start;
          if (Math.abs(distance) > 6) {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag(distance);
          }
        }}
        onPointerUp={(event) => endDrag(event)}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={() => { pointer.current = null; setDrag(null); }}
        onClickCapture={(event) => {
          if (event.detail > 0 && performance.now() < ignoreClickUntil.current) {
            event.preventDefault(); event.stopPropagation();
          }
        }}>
        {visibleSlots(position, width, pages.length).map((slot) => {
          const pageIndex = wrapPage(slot, pages.length);
          const page = pages[pageIndex];
          const selected = slot === position;
          return <button key={slot} className={"filmstrip-card" + (selected ? " selected" : "")}
            data-page={pageIndex} aria-current={selected ? "page" : undefined} tabIndex={selected ? 0 : -1}
            title={`${pageIndex + 1} · ${page.title}`} aria-label={`${pageIndex + 1} · ${page.title}`}
            style={{ transform: `translate3d(${(slot - position) * FILMSTRIP_PITCH + (drag || 0)}px,0,0) translateX(-50%)`,
              transitionDuration: drag === null ? `${FILMSTRIP_DURATION}ms` : "0ms" }}
            onClick={() => { direction.current = Math.sign(slot - position); onSelect(pageIndex); }}>
            <Thumbnail url={page.url} title={page.title} compact />
            <span>{pageIndex + 1}</span>
          </button>;
        })}
      </div>
      <button className="filmstrip-arrow" disabled={pages.length < 2} onClick={() => step(1)} aria-label={zh ? "列表下一张" : "Strip next image"}>›</button>
    </div>
  </div>;
}
