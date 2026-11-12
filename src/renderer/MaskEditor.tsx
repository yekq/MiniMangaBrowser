import React, { useRef, useState } from "react";
import { useLocale } from "./settings";

export function MaskEditor({ image, onChange }: { image: string; onChange(mask: string | undefined): void }) {
  const [lang] = useLocale(), zh = lang === "zh";
  const [brush, setBrush] = useState(48), [erase, setErase] = useState(false), [ratio, setRatio] = useState(1);
  const overlay = useRef<HTMLCanvasElement>(null), mask = useRef<HTMLCanvasElement | null>(null), drawing = useRef(false);
  const redraw = () => {
    if (!overlay.current || !mask.current) return;
    const ctx = overlay.current.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.current.width, overlay.current.height);
    ctx.drawImage(mask.current, 0, 0); ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "rgba(171, 235, 103, 0.55)"; ctx.fillRect(0, 0, overlay.current.width, overlay.current.height); ctx.globalCompositeOperation = "source-over";
  };
  const publish = () => {
    if (!mask.current) return;
    const pixels = mask.current.getContext("2d")!.getImageData(0, 0, mask.current.width, mask.current.height).data;
    let painted = false; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { painted = true; break; }
    if (!painted) { onChange(undefined); return; }
    const png = document.createElement("canvas"); png.width = mask.current.width; png.height = mask.current.height;
    const ctx = png.getContext("2d")!; ctx.fillStyle = "black"; ctx.fillRect(0, 0, png.width, png.height); ctx.drawImage(mask.current, 0, 0);
    onChange(png.toDataURL("image/png"));
  };
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * e.currentTarget.width / rect.width, y: (e.clientY - rect.top) * e.currentTarget.height / rect.height, scale: e.currentTarget.width / rect.width };
  };
  return <div className="ai-mask-editor">
    <div className="ai-mask-tools"><button aria-pressed={!erase} onClick={() => setErase(false)}>{zh ? "画笔" : "Brush"}</button><button aria-pressed={erase} onClick={() => setErase(true)}>{zh ? "橡皮" : "Eraser"}</button><button onClick={() => { if (mask.current) mask.current.getContext("2d")!.clearRect(0, 0, mask.current.width, mask.current.height); redraw(); onChange(undefined); }}>{zh ? "清空选区" : "Clear mask"}</button></div>
    <label className="ai-brush-size">{zh ? "画笔大小" : "Brush size"}<input type="range" min={8} max={160} step={4} value={brush} onChange={e => setBrush(Number(e.target.value))} aria-label={zh ? "画笔大小" : "Brush size"} /><span>{brush}</span></label>
    <div className="ai-mask-stage" style={{ width: `min(100%, ${65 * ratio}vh)`, aspectRatio: String(ratio) }}>
      <img src={image} alt={zh ? "当前原图，绿色覆盖处为修改区域" : "Original; green marks the edit region"} onLoad={e => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        const scale = Math.min(1, 2048 / Math.max(w, h)), canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale); mask.current = canvas;
        if (overlay.current) { overlay.current.width = canvas.width; overlay.current.height = canvas.height; }
        setRatio(w / h); onChange(undefined); redraw();
      }} />
      <canvas ref={overlay} aria-label={zh ? "涂抹修改区域" : "Paint edit region"} onPointerDown={e => {
        if (e.button !== 0 || !mask.current) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true;
        const { x, y, scale } = point(e), ctx = mask.current.getContext("2d")!;
        ctx.globalCompositeOperation = erase ? "destination-out" : "source-over"; ctx.fillStyle = "white"; ctx.strokeStyle = "white"; ctx.lineWidth = brush * scale; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.arc(x, y, brush * scale / 2, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(x, y); redraw();
      }} onPointerMove={e => { if (!drawing.current || !mask.current) return; const { x, y } = point(e), ctx = mask.current.getContext("2d")!; ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y); redraw(); }}
      onPointerUp={() => { if (drawing.current) { drawing.current = false; publish(); } }} onPointerCancel={() => { drawing.current = false; publish(); }} onLostPointerCapture={() => { if (drawing.current) { drawing.current = false; publish(); } }} />
    </div>
    <small className="ai-hint">{zh ? "绿色区域会被修改；请覆盖完整目标及少量边缘。" : "Green marks the editable region. Cover the full target and a small margin."}</small>
  </div>;
}
