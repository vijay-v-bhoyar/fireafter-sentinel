"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { fetchMapViewport } from "@/lib/map-viewport-client";
import { MAP_VIEW_UNAVAILABLE, MapBoundsSchema, MapViewportError, type MapBounds, type MapViewportResponse } from "@/lib/map-viewport-contract";
import { viewportBounds, viewportPosition } from "@/lib/map-viewport-navigation";
import type { ResponderAuthority } from "@/lib/responder-command";
import type { Incident } from "@/lib/types";
import { SOURCE_VIEW_LAYERS } from "@/lib/source-viewport-contract";
import { SourceViewportLayer } from "./source-viewport-layer";

export function InventoryViewportMap(props: { incident: Incident; revision: string; authority: ResponderAuthority }) {
  const bounds = MapBoundsSchema.safeParse(props.incident.locationContext?.bbox);
  if (!bounds.success) return <p role="alert">County extent unavailable. Use the Action Queue.</p>;
  return <Viewport key={`${props.incident.id}:${props.revision}:${props.authority.actorId}:${props.authority.organizationId}`} {...props} extent={bounds.data} />;
}

function Viewport({ incident, revision, authority, extent }: { incident: Incident; revision: string; authority: ResponderAuthority; extent: MapBounds }) {
  const { actorId, organizationId } = authority;
  const [view, setView] = useState({ zoom: 0, bbox: extent });
  const [loaded, setLoaded] = useState<{ key: string; data: MapViewportResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; width: number; height: number; bounds: MapBounds } | null>(null);
  const key = `${view.zoom}:${view.bbox.join(",")}:${retry}`;
  const data = loaded?.key === key ? loaded.data : null;
  const message = failure?.key === key ? failure.message : null;
  const selectedPoint = data?.items.find(item => item.kind === "point" && item.id === selected);
  useEffect(() => {
    const controller = new AbortController();
    // A short debounce coalesces pan gestures without holding obsolete markers.
    const timer = setTimeout(() => {
      fetchMapViewport({ incidentId: incident.id, revision, bbox: view.bbox.join(","), zoom: String(view.zoom) }, { actorId, organizationId }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setLoaded({ key, data: result }); setFailure(null); } })
        .catch(error => { if (!controller.signal.aborted) setFailure({ key, message: error instanceof MapViewportError ? error.message : MAP_VIEW_UNAVAILABLE }); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [incident.id, revision, actorId, organizationId, view, key]);
  const center: [number, number] = [(view.bbox[0] + view.bbox[2]) / 2, (view.bbox[1] + view.bbox[3]) / 2];
  const zoom = (amount: number, target = center) => {
    const next = Math.max(0, Math.min(20, view.zoom + amount));
    setView({ zoom: next, bbox: viewportBounds(extent, next, target) }); setSelected(null);
  };
  const pan = (x: number, y: number) => {
    setView({ ...view, bbox: viewportBounds(extent, view.zoom, [center[0] + (view.bbox[2] - view.bbox[0]) * x,
      center[1] + (view.bbox[3] - view.bbox[1]) * y]) }); setSelected(null);
  };
  const boundary = incident.locationContext?.boundary;
  const rings = boundary?.type === "Polygon" ? boundary.coordinates : boundary?.type === "MultiPolygon" ? boundary.coordinates.flat() : [];
  const boundaryPath = rings.map(ring => `M${ring.map(point => {
    const at = viewportPosition(point, view.bbox); return `${parseFloat(at.left)},${parseFloat(at.top)}`;
  }).join(" L")} Z`).join(" ");
  return <section className="min-w-0 overflow-hidden rounded-md border border-slate-700 bg-[var(--ops-inset)]" aria-label="Saved inventory map">
    <div className="space-y-2 p-3">
      <h2 className="text-sm font-semibold">Saved inventory by map view</h2>
      <p className="text-xs text-slate-300">Counts are saved asset locations, not live hazard scores. Zoom or pan to inspect a smaller area.</p>
      <p className="text-xs text-slate-300">Source geometry loads by view. Dense layers ask you to zoom in rather than showing an incomplete set. Basin outlines are saved assessment context, not a live forecast.</p>
      <div role="group" aria-label="Map navigation" className="flex flex-wrap gap-2">
        {[
          { label: "Zoom in", run: () => zoom(1), disabled: view.zoom === 20 },
          { label: "Zoom out", run: () => zoom(-1), disabled: view.zoom === 0 },
          { label: "Pan west", run: () => pan(-0.35, 0), disabled: view.zoom === 0 },
          { label: "Pan east", run: () => pan(0.35, 0), disabled: view.zoom === 0 },
          { label: "Pan north", run: () => pan(0, 0.35), disabled: view.zoom === 0 },
          { label: "Pan south", run: () => pan(0, -0.35), disabled: view.zoom === 0 },
          { label: "Fit county", run: () => { setView({ zoom: 0, bbox: extent }); setSelected(null); }, disabled: false },
        ].map(control => <button key={control.label} type="button" disabled={control.disabled} onClick={control.run}
          className="min-h-11 rounded border border-slate-600 bg-slate-900 px-3 text-xs font-semibold text-slate-100 disabled:opacity-40">{control.label}</button>)}
      </div>
      <p role="status" aria-live="polite" className="text-xs text-slate-300">
        {message ?? (data ? `${data.inView.toLocaleString()} locations in this view; ${data.totalLocated.toLocaleString()} located of ${data.totalStored.toLocaleString()} stored; ${data.withheld.toLocaleString()} withheld. ${data.mode === "clusters" ? "Grid-cell counts, not exact asset positions; select a cluster to zoom." : "Individual saved locations."}` : "Loading this map view. Previous markers are hidden.")}
        {message && <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Retry view</button>}
      </p>
      <div className="grid min-w-0 gap-2 md:grid-cols-3">
        {SOURCE_VIEW_LAYERS.map(layer => <SourceViewportLayer key={layer} query={{ incidentId: incident.id, revision, bbox: view.bbox.join(","), zoom: String(view.zoom), layer }}
          authority={authority} bounds={view.bbox} host={overlayHost} />)}
      </div>
    </div>
    <div aria-label="Pan saved inventory map" role="group" tabIndex={0} data-testid="inventory-viewport"
      className="relative h-[420px] touch-none overflow-hidden bg-[linear-gradient(145deg,#34483b,#202e27_62%,#4b5036)] outline-offset-2 focus:outline-2 focus:outline-sky-300"
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const direction = ({ ArrowLeft: [-0.35, 0], ArrowRight: [0.35, 0], ArrowUp: [0, 0.35], ArrowDown: [0, -0.35] } as Record<string, number[]>)[event.key];
        if (direction) { event.preventDefault(); pan(direction[0], direction[1]); }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        const rect = event.currentTarget.getBoundingClientRect();
        drag.current = { x: event.clientX, y: event.clientY, width: Math.max(1, rect.width - 48), height: Math.max(1, rect.height - 48), bounds: view.bbox };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerUp={event => {
        const from = drag.current; drag.current = null;
        if (!from || !from.width || !from.height) return;
        const [w, s, e, n] = from.bounds;
        setView({ ...view, bbox: viewportBounds(extent, view.zoom, [(w + e) / 2 - (event.clientX - from.x) / from.width * (e - w),
          (s + n) / 2 + (event.clientY - from.y) / from.height * (n - s)]) }); setSelected(null);
      }}>
      <div className="absolute inset-6">
      <div ref={setOverlayHost} className="pointer-events-none absolute inset-0" aria-label="Saved source geometry" />
      <svg aria-label="County outline" role="img" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={boundaryPath} fill="none" stroke="rgba(225,223,197,0.65)" strokeWidth="0.25" vectorEffect="non-scaling-stroke" />
      </svg>
      {data?.items.map(item => <button type="button" key={item.id}
        aria-label={item.kind === "cluster" ? `Zoom into ${item.count} saved locations` : `Inspect ${item.name}`}
        className="absolute flex min-h-11 min-w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-amber-100 bg-[#664723] px-1 font-mono text-xs font-bold text-white shadow-md"
        style={viewportPosition(item.coordinates, view.bbox)} onClick={() => item.kind === "cluster" ? zoom(2, item.coordinates) : setSelected(item.id)}>
        {item.kind === "cluster" ? item.count.toLocaleString() : "+"}
      </button>)}
      </div>
    </div>
    <div className="space-y-2 p-3 text-xs text-slate-300">
      {selectedPoint?.kind === "point" && <p role="status">{selectedPoint.name} | {selectedPoint.type} | Saved location only; review evidence in the inventory or queue.</p>}
      <p>Zoom {view.zoom}. Saved asset locations are limited to this view. Source records whose bounds overlap the view keep all their geometry; parts may extend outside it. Withheld locations are not drawn.</p>
      {view.zoom === 20 && data?.mode === "clusters" && <p>Overlapping locations remain grouped at maximum zoom. Browse the saved records for individual details.</p>}
      <div className="flex flex-wrap gap-4">
        <Link prefetch={false} className="underline" href={`/?incidentId=${encodeURIComponent(incident.id)}`}>Complete Action Queue</Link>
        <Link prefetch={false} className="underline" href={`/assets/browse?incidentId=${encodeURIComponent(incident.id)}`}>Browse saved asset records</Link>
      </div>
    </div>
  </section>;
}
