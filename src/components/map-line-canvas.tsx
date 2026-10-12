"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { drawMapLineCollection, type MapBounds, type MapLineCollection, type MapLineState } from "@/lib/map-line-renderer";

export function MapLineCanvas({ collection, bounds, label, color, width, onState, showStatus = true }: {
  collection: MapLineCollection; bounds: MapBounds; label: string; color: string; width: number;
  onState: (collection: MapLineCollection, state: MapLineState) => void;
  showStatus?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [west, south, east, north] = bounds;
  const key = `${west},${south},${east},${north},${color},${width}`;
  const [result, setResult] = useState<{ collection: MapLineCollection; key: string; state: MapLineState }>();
  const [retry, setRetry] = useState(0);
  const report = useEffectEvent((source: MapLineCollection, drawKey: string, value: MapLineState) => {
    setResult({ collection: source, key: drawKey, state: value });
    if (value.status !== "drawing" || value.vertices === 0) onState(source, value);
  });
  useEffect(() => {
    const surface = canvas.current!; let stop: (() => void) | undefined, active = true, dimensions = "";
    const restart = () => {
      const rect = surface.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
      const next = `${rect.width},${rect.height},${ratio}`;
      if (next === dimensions) return;
      dimensions = next; stop?.(); surface.style.visibility = "hidden";
      report(collection, key, { status: "drawing", parts: 0, vertices: 0 });
      if (rect.width <= 0 || rect.height <= 0) return;
      const pixelWidth = Math.ceil(rect.width * ratio), pixelHeight = Math.ceil(rect.height * ratio);
      if (!Number.isSafeInteger(pixelWidth * pixelHeight) || pixelWidth * pixelHeight > 8_000_000) {
        report(collection, key, { status: "unavailable", parts: 0, vertices: 0 }); return;
      }
      try {
        surface.width = pixelWidth; surface.height = pixelHeight;
        const pen = surface.getContext("2d");
        if (!pen || pen.isContextLost?.()) throw new Error("Canvas unavailable");
        pen.setTransform(ratio, 0, 0, ratio, 0, 0); pen.strokeStyle = color; pen.lineWidth = width;
        stop = drawMapLineCollection({ collection, bounds: [west, south, east, north], width: rect.width, height: rect.height, pen,
          onState: state => {
            if (active) report(collection, key, state.status === "ready" && pen.isContextLost?.()
              ? { status: "unavailable", parts: 0, vertices: 0 } : state);
          } });
      } catch { report(collection, key, { status: "unavailable", parts: 0, vertices: 0 }); }
    };
    const lost = (event: Event) => {
      event.preventDefault(); stop?.(); surface.style.visibility = "hidden";
      report(collection, key, { status: "unavailable", parts: 0, vertices: 0 });
    };
    const restored = () => { dimensions = ""; restart(); };
    surface.addEventListener("contextlost", lost); surface.addEventListener("contextrestored", restored);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(restart);
    observer?.observe(surface); window.addEventListener("resize", restart); restart();
    return () => {
      active = false; stop?.(); observer?.disconnect(); window.removeEventListener("resize", restart);
      surface.removeEventListener("contextlost", lost); surface.removeEventListener("contextrestored", restored);
    };
  }, [collection, west, south, east, north, color, width, retry, key]);
  const state = result?.collection === collection && result.key === key ? result.state : undefined;
  const ready = state?.status === "ready";
  return <>
    <canvas ref={canvas} role="img" aria-label={ready ? `${state.parts.toLocaleString()} ${label} parts; ${state.vertices.toLocaleString()} vertices drawn` : `${label} layer not yet verified`}
      data-render-status={state?.status ?? "drawing"} data-parts={ready ? state.parts : 0} data-vertices={ready ? state.vertices : 0}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", visibility: ready ? "visible" : "hidden" }} />
    {!ready && showStatus && <div role="status" className="absolute left-3 z-20 max-w-[calc(100%-1.5rem)] rounded bg-slate-950/95 px-3 py-2 text-xs text-amber-200"
      style={{ bottom: label === "road" ? 12 : 58 }}>
      {state?.status === "unavailable" ? <>{label === "road" ? "Road" : "Hydrography"} layer unavailable. No partial layer shown.
        <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Retry {label} drawing</button></>
        : `Drawing ${label} geometry${state?.parts ? `: ${state.parts.toLocaleString()} parts processed` : ""}.`}
    </div>}
  </>;
}
