import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject, PointerEvent as ReactPointerEvent } from "react";

// Transient chrome is independent of the user's persisted strip preference.
export function useReaderChrome(stage: RefObject<HTMLDivElement | null>, enabled: boolean, identity: string | null) {
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holding = useRef(false);
  const wasFullscreen = useRef(false);
  const exitedAt = useRef(-Infinity);
  const clearTimer = useCallback(() => clearTimeout(timer.current), []);
  const show = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(true);
    if (!holding.current) timer.current = setTimeout(() => setVisible(false), 2000);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);
  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.current?.requestFullscreen();
  }, [stage]);
  useEffect(() => {
    const change = () => {
      const active = document.fullscreenElement === stage.current;
      if (wasFullscreen.current && !active) exitedAt.current = performance.now();
      wasFullscreen.current = active;
      setFullscreen(active);
      show();
    };
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, [stage, show]);
  useEffect(() => {
    holding.current = false;
    if (enabled) show();
    else {
      clearTimer();
      if (document.fullscreenElement === stage.current) void document.exitFullscreen();
    }
    return clearTimer;
  }, [enabled, identity, show, clearTimer, stage]);
  useEffect(() => {
    const release = () => {
      if (!holding.current) return;
      holding.current = false;
      show();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      clearTimer();
    };
  }, [show, clearTimer]);
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const bottom = event.currentTarget.getBoundingClientRect().bottom;
    if (bottom - event.clientY <= 64 || (event.target as HTMLElement).closest(".filmstrip,.fullscreen-exit")) show();
  };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    if ((event.target as HTMLElement).closest(".filmstrip")) holding.current = true;
    show();
  };
  // On Windows Chromium can leave fullscreen before delivering the same Escape
  // key to the page. Do not interpret that event as a second "back to grid".
  const justExited = () => performance.now() - exitedAt.current < 300;
  return { fullscreen, visible, show, hide, toggleFullscreen, pointerMove, pointerDown, justExited };
}
