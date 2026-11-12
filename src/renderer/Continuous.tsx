import React, { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Page } from "../contracts";
export function Continuous({
  pages,
  index,
  zoom,
  onIndexChange,
  onEndChange,
}: {
  pages: Page[];
  index: number;
  zoom: number;
  onIndexChange: (index: number) => void;
  onEndChange: (complete: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reported = useRef(index);
  const frame = useRef(0);
  const checkEnd = () => {
    const element = ref.current;
    if (!element) return;
    const last = element?.querySelector<HTMLImageElement>(`[data-index="${pages.length - 1}"] img`);
    onEndChange(!!element && !!last?.complete && last.naturalWidth > 0 &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 3);
  };
  const rows = useVirtualizer({
    count: pages.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 900 * zoom,
    overscan: 2,
  });
  useEffect(() => {
    if (reported.current !== index || !ref.current?.scrollTop) {
      reported.current = index;
      rows.scrollToIndex(index, { align: "start" });
    }
  }, [index, pages.length]);
  useEffect(() => { const id = requestAnimationFrame(checkEnd); return () => cancelAnimationFrame(id); }, [index, pages.length, zoom, rows.getTotalSize()]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return (
    <div ref={ref} className="continuous-reader" style={{ height: "100%", overflow: "auto" }} onScroll={() => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        checkEnd();
        const top = (ref.current?.scrollTop || 0) + 1;
        const visible = rows.getVirtualItems().find((row) => row.start <= top && row.end > top);
        if (visible && visible.index !== reported.current) {
          reported.current = visible.index;
          onIndexChange(visible.index);
        }
      });
    }}>
      <div style={{ height: rows.getTotalSize(), position: "relative" }}>
        {rows.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={rows.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
              textAlign: "center",
            }}
          >
            <img
              src={pages[row.index].url}
              style={{ width: Math.min(100, 70 * zoom) + "%", height: "auto" }}
              onLoad={() => { requestAnimationFrame(checkEnd); }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
