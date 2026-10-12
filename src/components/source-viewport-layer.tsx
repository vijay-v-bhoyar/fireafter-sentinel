"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchSourceViewport } from "@/lib/source-viewport-client";
import { MapViewportError, type MapBounds } from "@/lib/map-viewport-contract";
import type { SourceViewportQuery, SourceViewportResponse } from "@/lib/source-viewport-contract";
import type { ResponderAuthority } from "@/lib/responder-command";
import type { MapLineCollection, MapLineState } from "@/lib/map-line-renderer";
import { MapLineCanvas } from "./map-line-canvas";

export const sourceLayerStyles = {
  "tiger-roads": { title: "Roads", label: "road", color: "#f0e2b8", width: 1.2 },
  "3dhp-flowlines": { title: "Streams", label: "stream", color: "#83cae6", width: 1.2 },
  "usgs-pwfdf": { title: "Basin outlines", label: "basin", color: "#e69562", width: 1.8 },
};
export function sourceViewportLines(data: SourceViewportResponse): MapLineCollection {
  return { features: data.features.flatMap(feature => {
    const paths = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.flat() : feature.geometry.coordinates;
    return paths.map(coordinates => ({ geometry: { type: "LineString", coordinates } }));
  }) };
}
export function SourceViewportLayer({ query, authority, host, bounds }: {
  query: SourceViewportQuery; authority: ResponderAuthority; host: HTMLDivElement | null; bounds: MapBounds;
}) {
  const [enabled, setEnabled] = useState(true), [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data: SourceViewportResponse; lines: MapLineCollection } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [drawing, setDrawing] = useState<{ lines: MapLineCollection; state: MapLineState } | null>(null);
  const { incidentId, revision, layer, bbox, zoom } = query, { actorId, organizationId } = authority;
  const key = `${incidentId}:${revision}:${layer}:${bbox}:${zoom}:${actorId}:${organizationId}:${retry}`;
  const current = enabled && loaded?.key === key ? loaded : null, failure = enabled && failed?.key === key ? failed.message : null;
  const style = sourceLayerStyles[layer];
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSourceViewport({ incidentId, revision, layer, bbox, zoom }, { actorId, organizationId }, controller.signal)
        .then(data => { if (!controller.signal.aborted) { setLoaded({ key, data, lines: sourceViewportLines(data) }); setFailed(null); } })
        .catch(error => { if (!controller.signal.aborted) setFailed({ key, message: error instanceof MapViewportError ? error.message : "Source view unavailable. Retry or review the source status." }); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, key, incidentId, revision, layer, bbox, zoom, actorId, organizationId]);
  const state = current && drawing?.lines === current.lines ? drawing.state : null;
  const data = current?.data, ready = data?.mode === "ready";
  return <div className="min-w-0 rounded border border-slate-600 bg-slate-950/35 p-2 text-xs text-slate-200" aria-label={`${style.title} source layer`}>
    <label className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold text-slate-100">
      <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setRetry(value => value + 1); }} className="h-4 w-4" />
      <span aria-hidden="true" className="h-1 w-5 rounded" style={{ backgroundColor: style.color }} />{style.title}
    </label>
    <p role="status" aria-live="polite" className="break-words leading-5">
      {!enabled ? "Layer off." : failure ?? (!data ? "Loading this view; previous geometry hidden."
        : data.mode === "zoom_required" ? `Zoom in to load this view without truncation. ${data.totalRecords?.toLocaleString()} saved records in the source.`
          : data.mode === "unavailable" ? "No verified indexed geometry. Review source details; a refresh may be needed."
            : `${data.features.length.toLocaleString()} records overlap this view of ${data.totalRecords?.toLocaleString()} saved. ${state?.status === "ready" ? "Geometry drawn." : state?.status === "unavailable" ? "Drawing unavailable; no partial layer shown." : "Drawing geometry."}`)}
    </p>
    {(failure || state?.status === "unavailable") && <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-11 underline">Retry {style.title.toLowerCase()}</button>}
    {data?.source && <details className="mt-1 break-words leading-5">
      <summary className="min-h-11 cursor-pointer text-slate-200">Source details</summary>
      <p className="font-semibold">{data.source.name}</p>
      <p>Saved geometry, not a current hazard ranking. {data.source.freshness} at the time of this read.</p>
      <p>Provider time: {data.source.timeBasis === "provider" ? data.source.sourceUpdatedAt : "Not verified"}. Retrieved: {data.source.fetchedAt}.</p>
      <p>{data.source.detail}</p>
      {data.source.warnings.map((warning, i) => <p key={i} className="text-amber-200">{warning}</p>)}
      {data.source.url && <a href={data.source.url} target="_blank" rel="noopener noreferrer" className="underline text-sky-200">Open original source</a>}
    </details>}
    {host && ready && current && createPortal(<MapLineCanvas key={key} collection={current.lines} bounds={bounds} label={style.label} color={style.color} width={style.width}
      showStatus={false} onState={(lines, value) => setDrawing({ lines, state: value })} />, host)}
  </div>;
}
