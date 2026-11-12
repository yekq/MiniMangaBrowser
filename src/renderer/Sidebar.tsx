import React, { useEffect, useRef, useState } from "react";
import { useLocale, useSettings } from "./settings";

export function Sidebar({ children }: { children: React.ReactNode }) {
  const [lang] = useLocale();
  const saved = useSettings(state => state.sidebarWidth);
  const save = useSettings(state => state.setSidebarWidth);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const dragging = useRef<{ x: number; start: number; width: number } | null>(null);
  const max = Math.max(200, Math.min(640, viewport - 560));
  const clamp = (value: number) => Math.max(200, Math.min(max, Number.isFinite(value) ? value : 280));
  const width = clamp(preview ?? saved);
  const finish = () => {
    if (!dragging.current) return;
    save(clamp(dragging.current.width));
    dragging.current = null;
    setPreview(null);
    document.body.classList.remove("sidebar-resizing");
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    const blur = () => finishRef.current();
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);
  return <>
    <aside className="library-sidebar" id="library-sidebar" style={{ width }}>{children}</aside>
    <div className="sidebar-divider" role="separator" tabIndex={0}
      aria-label={lang === "zh" ? "调整侧栏宽度" : "Resize sidebar"} aria-orientation="vertical"
      aria-controls="library-sidebar" aria-valuemin={200} aria-valuemax={max} aria-valuenow={Math.round(width)}
      title={lang === "zh" ? "拖动调整宽度，双击恢复默认" : "Drag to resize; double-click to reset"}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        dragging.current = { x: event.clientX, start: width, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("sidebar-resizing");
      }}
      onPointerMove={event => {
        if (!dragging.current) return;
        dragging.current.width = clamp(dragging.current.start + event.clientX - dragging.current.x);
        setPreview(dragging.current.width);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => save(280)}
      onKeyDown={event => {
        event.stopPropagation();
        const next = event.key === "ArrowLeft" ? width - 16 : event.key === "ArrowRight" ? width + 16
          : event.key === "Home" ? 200 : event.key === "End" ? max : undefined;
        if (next !== undefined) { event.preventDefault(); save(clamp(next)); }
      }} />
  </>;
}
