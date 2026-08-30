import { useMemo, useState } from "react";
import { areaGeometrySource } from "../data/area-geometry.de.js";

type District = {
  ags: string;
  name: string;
  stateName: string;
  path: string;
  labelX: number;
  labelY: number;
};
type Geometry = { attribution: string; viewBox: string; districts: District[] };

export type MapArea = {
  ags: string;
  name: string;
  stateName: string;
  status: string;
  lastRunAt: string | null;
  nextDueAt: string | null;
  lastError: string | null;
  foundSources: number;
  incompleteRuns: number;
};

export type AreaStage =
  | "unknown"
  | "pending"
  | "due"
  | "running"
  | "incomplete"
  | "empty"
  | "harvested";

const geometry = JSON.parse(areaGeometrySource) as Geometry;

export const stageLabels: Record<AreaStage, string> = {
  harvested: "Abgearbeitet, mit Fund",
  empty: "Abgearbeitet, ohne Fund",
  incomplete: "Unvollständig, Wiedervorlage",
  running: "In Arbeit",
  due: "Fällig",
  pending: "Offen",
  unknown: "Kein Gebietseintrag",
};
const stageColors: Record<AreaStage, string> = {
  harvested: "#3f9f6a",
  empty: "#2c5a52",
  incomplete: "#c07d33",
  running: "#2f9fb0",
  due: "#c2b04a",
  pending: "#2f5f68",
  unknown: "#1a3237",
};

export function areaStage(area: MapArea | undefined, now: number): AreaStage {
  if (!area) return "unknown";
  if (area.status === "running") return "running";
  if (area.status !== "done") return "pending";
  if ((area.lastError ?? "").startsWith("discovery_incomplete")) return "incomplete";
  if (area.nextDueAt !== null && new Date(area.nextDueAt).getTime() <= now) return "due";
  return area.foundSources > 0 ? "harvested" : "empty";
}

const stageOrder: AreaStage[] = [
  "harvested",
  "empty",
  "incomplete",
  "running",
  "due",
  "pending",
  "unknown",
];
const dateText = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("de-DE") : "—";

function fill(stage: AreaStage, foundSources: number): string {
  if (stage !== "harvested") return stageColors[stage];
  const weight = Math.min(1, Math.log1p(foundSources) / Math.log1p(30));
  const lightness = 30 + Math.round(weight * 24);
  return `hsl(152 42% ${lightness}%)`;
}

export function AreaMap({
  areas,
  selectedState,
  selectedAgs,
  onSelectDistrict,
  onSelectState,
}: {
  areas: MapArea[];
  selectedState: string;
  selectedAgs: string | null;
  onSelectDistrict: (ags: string | null) => void;
  onSelectState: (stateName: string) => void;
}) {
  const now = Date.now();
  const [hovered, setHovered] = useState<string | null>(null);
  const byAgs = useMemo(
    () => new Map(areas.filter((area) => area.ags.length === 5).map((area) => [area.ags, area])),
    [areas],
  );
  const [, , viewWidth, viewHeight] = geometry.viewBox.split(" ").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const frame = useMemo(() => {
    const shapes = geometry.districts.filter(
      (district) => selectedState === "all" || district.stateName === selectedState,
    );
    if (shapes.length === 0 || selectedState === "all") {
      return { x: 0, y: 0, width: viewWidth, height: viewHeight };
    }
    const numbers = shapes.flatMap((district) =>
      [...district.path.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map(
        (match) => [Number(match[1]), Number(match[2])] as const,
      ),
    );
    const xs = numbers.map(([x]) => x);
    const ys = numbers.map(([, y]) => y);
    const pad = 12;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const width = Math.max(Math.max(...xs) + pad - minX, 1);
    const height = Math.max(Math.max(...ys) + pad - minY, 1);
    const ratio = viewWidth / viewHeight;
    const boxed = width / height < ratio
      ? { width: height * ratio, height }
      : { width, height: width / ratio };
    return {
      x: minX - (boxed.width - width) / 2,
      y: minY - (boxed.height - height) / 2,
      ...boxed,
    };
  }, [selectedState, viewWidth, viewHeight]);
  const zoom = viewWidth / frame.width;
  const counts = useMemo(() => {
    const tally = new Map<AreaStage, number>();
    for (const district of geometry.districts) {
      if (selectedState !== "all" && district.stateName !== selectedState) continue;
      const stage = areaStage(byAgs.get(district.ags), now);
      tally.set(stage, (tally.get(stage) ?? 0) + 1);
    }
    return tally;
  }, [byAgs, selectedState, now]);
  const hoveredDistrict = hovered
    ? geometry.districts.find((district) => district.ags === hovered)
    : undefined;
  const hoveredArea = hovered ? byAgs.get(hovered) : undefined;
  const states = useMemo(
    () => [...new Set(geometry.districts.map((district) => district.stateName))].sort(),
    [],
  );

  return (
    <div className="area-map">
      <div className="area-map-toolbar">
        <button
          type="button"
          className={selectedState === "all" ? "area-map-chip active" : "area-map-chip"}
          onClick={() => onSelectState("all")}
        >
          Deutschland
        </button>
        {states.map((state) => (
          <button
            key={state}
            type="button"
            className={selectedState === state ? "area-map-chip active" : "area-map-chip"}
            onClick={() => onSelectState(state)}
          >
            {state}
          </button>
        ))}
      </div>
      <div className="area-map-body">
        <svg
          className="area-map-canvas"
          viewBox={geometry.viewBox}
          role="img"
          aria-label="Gebietskarte Deutschland"
          onMouseLeave={() => setHovered(null)}
        >
          <g
            className="area-map-zoom"
            style={{
              transform: `scale(${zoom}) translate(${-frame.x}px, ${-frame.y}px)`,
            }}
          >
            {geometry.districts.map((district, index) => {
              const area = byAgs.get(district.ags);
              const stage = areaStage(area, now);
              const dimmed = selectedState !== "all" && district.stateName !== selectedState;
              const classes = ["area-map-district", `stage-${stage}`];
              if (dimmed) classes.push("dimmed");
              if (selectedAgs === district.ags) classes.push("selected");
              if (hovered === district.ags) classes.push("hovered");
              return (
                <path
                  key={district.ags}
                  d={district.path}
                  className={classes.join(" ")}
                  fill={fill(stage, area?.foundSources ?? 0)}
                  strokeWidth={1 / zoom}
                  style={{ animationDelay: `${(index % 60) * 12}ms` }}
                  onMouseEnter={() => setHovered(district.ags)}
                  onClick={() =>
                    onSelectDistrict(selectedAgs === district.ags ? null : district.ags)
                  }
                >
                  <title>{`${district.name} — ${stageLabels[stage]}`}</title>
                </path>
              );
            })}
            {geometry.districts
              .filter(
                (district) =>
                  district.ags === hovered ||
                  district.ags === selectedAgs ||
                  (zoom >= 2.6 && district.stateName === selectedState),
              )
              .map((district) => (
                <text
                  key={district.ags}
                  className="area-map-label"
                  x={district.labelX}
                  y={district.labelY}
                  fontSize={22 / zoom}
                  strokeWidth={5 / zoom}
                >
                  {district.name.split(",")[0]}
                </text>
              ))}
          </g>
        </svg>
        <div className="area-map-side">
          <div className="area-map-legend">
            {stageOrder.map((stage) => (
              <div key={stage} className="area-map-legend-row">
                <span
                  className={`area-map-swatch stage-${stage}`}
                  style={{ background: stageColors[stage] }}
                />
                <span>{stageLabels[stage]}</span>
                <strong>{counts.get(stage) ?? 0}</strong>
              </div>
            ))}
          </div>
          <div className="area-map-detail">
            {hoveredDistrict ? (
              <>
                <strong>{hoveredDistrict.name}</strong>
                <span className="muted">{hoveredDistrict.stateName}</span>
                <dl>
                  <div>
                    <dt>Stand</dt>
                    <dd>{stageLabels[areaStage(hoveredArea, now)]}</dd>
                  </div>
                  <div>
                    <dt>Quellen</dt>
                    <dd>{hoveredArea?.foundSources ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Letzter Lauf</dt>
                    <dd>{dateText(hoveredArea?.lastRunAt ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Nächste Fälligkeit</dt>
                    <dd>{dateText(hoveredArea?.nextDueAt ?? null)}</dd>
                  </div>
                  {(hoveredArea?.incompleteRuns ?? 0) > 0 && (
                    <div>
                      <dt>Unvollständige Läufe</dt>
                      <dd>{hoveredArea?.incompleteRuns}</dd>
                    </div>
                  )}
                </dl>
              </>
            ) : (
              <span className="muted">
                Gebiet berühren für Einzelheiten, klicken für die Tabelle darunter.
              </span>
            )}
          </div>
          <span className="area-map-attribution">{geometry.attribution}</span>
        </div>
      </div>
    </div>
  );
}
