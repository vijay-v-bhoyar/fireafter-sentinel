import { rankPublishedHazards } from "@/lib/published-hazard";
import type { Asset, SourceSnapshot } from "@/lib/types";

export function PublishedHazardReview({ assets, sources, onReview }: {
  assets: Asset[];
  sources: SourceSnapshot[];
  onReview: (asset: Asset) => void;
}) {
  const current = sources.some(source => source.sourceKey === "usgs-pwfdf" && source.freshness?.state === "current");
  const rows = current ? rankPublishedHazards(assets) : [];
  return <section aria-label="Published USGS hazard review" className="mx-4 mb-4 rounded-md border border-sky-400/40 bg-sky-950/30 p-3">
    <h3 className="font-semibold text-sky-100">Published USGS hazard review</h3>
    <p className="mt-2 text-sm text-slate-200">Assets inside assessed basins, ordered High, Moderate, then Low. These are published design-storm classes, not FireAfter risk scores or current-event predictions.</p>
    <p className="mt-2 text-xs text-amber-200">The assessment-to-selected-fire match is a candidate, not verified cross-provider identity. Verify the named assessment and its rainfall scenario before operational use. Point containment does not establish downstream runout or structural damage.</p>
    {!rows.length ? <p role="status" className="mt-3 text-sm text-slate-300">No current, validated basin-to-asset matches are available. This does not establish low hazard.</p> : <>
      <p className="mt-3 text-sm text-sky-200">{rows.length} linked assets. Highest published class first; ties use asset name, not a fabricated score.</p>
      <div className="mt-3 max-h-96 space-y-3 overflow-y-auto">
        {rows.map((asset, index) => {
          const hazard = asset.publishedHazard!;
          return <article key={asset.id} className="rounded border border-slate-600 p-3 text-sm [overflow-wrap:anywhere]">
            <p className="font-semibold">{index + 1}. {asset.name}</p>
            <p className="mt-1 text-sky-200">USGS combined hazard: {hazard.combinedHazard}</p>
            <p className="mt-1">{hazard.fireName} | {hazard.assessmentId}</p>
            <p>Assessment date: {hazard.assessmentDate.slice(0, 10)}</p>
            <p>Rainfall scenario: {hazard.rainfallScenario}</p>
            <p>Probability class: {hazard.probabilityClass}; volume class: {hazard.volumeClass}</p>
            <p className="text-xs text-slate-400">Basin: {hazard.basinId}</p>
            <p className="mt-1 text-xs text-slate-300">Where basins overlap, the highest published class is shown. FireAfter screening may remain Unknown.</p>
            <div className="mt-2 flex flex-wrap gap-4">
              <a href={hazard.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-200 underline">Official assessment</a>
              <button type="button" onClick={() => onReview(asset)} className="text-sky-200 underline">Review asset evidence</button>
            </div>
          </article>;
        })}
      </div>
    </>}
  </section>;
}
