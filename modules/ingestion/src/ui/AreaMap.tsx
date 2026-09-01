import { useMemo, useState } from "react";
import { areaGeometrySource } from "../data/area-geometry.de.js";

export type District = {
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
const boundsCache = new Map<string, Bounds>();

export type Bounds = { x: number; y: number; width: number; height: number };

function districtLabel(district: District): string {
  return district.name.split(",")[0] ?? "";
}

function pathCoordinates(path: string): Array<readonly [number, number]> {
  return [...path.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
}

export function districtBounds(ags: string): Bounds {
  const cached = boundsCache.get(ags);
  if (cached) return cached;
  const district = geometry.districts.find((entry) => entry.ags === ags);
  if (!district) throw new Error(`Unbekannter Gebietsschlüssel: ${ags}`);
  const numbers = pathCoordinates(district.path);
  if (numbers.length === 0) throw new Error(`Gebiet ohne Geometrie: ${ags}`);
  const xs = numbers.map(([x]) => x);
  const ys = numbers.map(([, y]) => y);
  const bounds = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(Math.max(...xs) - Math.min(...xs), 1),
    height: Math.max(Math.max(...ys) - Math.min(...ys), 1),
  };
  boundsCache.set(ags, bounds);
  return bounds;
}

export function labelFits(bounds: Bounds, label: string, fontSize: number): boolean {
  const labelWidth = label.length * fontSize * 0.55;
  return labelWidth <= bounds.width * 0.95 && fontSize * 1.2 <= bounds.height;
}

function labelRectangle(district: District, fontSize: number): Bounds {
  const label = districtLabel(district);
  const width = label.length * fontSize * 0.55;
  const height = fontSize * 1.2;
  return {
    x: district.labelX - width / 2,
    y: district.labelY - height / 2,
    width,
    height,
  };
}

function overlaps(first: Bounds, second: Bounds): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

export function labelsForState(stateName: string, fontSize: number): District[] {
  const kept: District[] = [];
  const rectangles: Bounds[] = [];
  const candidates = geometry.districts
    .filter((district) => district.stateName === stateName)
    .filter((district) => labelFits(
      districtBounds(district.ags),
      districtLabel(district),
      fontSize,
    ))
    .sort((first, second) => {
      const firstBounds = districtBounds(first.ags);
      const secondBounds = districtBounds(second.ags);
      return secondBounds.width * secondBounds.height - firstBounds.width * firstBounds.height;
    });
  for (const district of candidates) {
    const rectangle = labelRectangle(district, fontSize);
    if (rectangles.every((existing) => !overlaps(existing, rectangle))) {
      kept.push(district);
      rectangles.push(rectangle);
    }
  }
  return kept;
}

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
    const numbers = shapes.flatMap((district) => pathCoordinates(district.path));
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
  const visibleLabels = useMemo(() => {
    const labelAgs = new Set<string>();
    if (hovered !== null) labelAgs.add(hovered);
    if (selectedAgs !== null) labelAgs.add(selectedAgs);
    if (zoom >= 2.6) {
      for (const district of labelsForState(selectedState, 22 / zoom)) {
        labelAgs.add(district.ags);
      }
    }
    return geometry.districts.filter((district) => labelAgs.has(district.ags));
  }, [hovered, selectedAgs, selectedState, zoom]);
  const counts = useMemo(() => {
    const tally = new Map<AreaStage, number>();
    for (const district of geometry.districts) {
      if (selectedState !== "all" && district.stateName !== selectedState) continue;
      const stage = areaStage(byAgs.get(district.ags), now);
      tally.set(stage, (tally.get(stage) ?? 0) + 1);
    }
    return tally;
  }, [byAgs, selectedState, now]);
  const detailAgs = hovered ?? selectedAgs;
  const detailDistrict = detailAgs
    ? geometry.districts.find((district) => district.ags === detailAgs)
    : undefined;
  const detailArea = detailAgs ? byAgs.get(detailAgs) : undefined;
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
            {visibleLabels
              .map((district) => (
                <text
                  key={district.ags}
                  className="area-map-label"
                  x={district.labelX}
                  y={district.labelY}
                  fontSize={22 / zoom}
                  strokeWidth={5 / zoom}
                >
                  {districtLabel(district)}
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
            {detailDistrict ? (
              <>
                <strong>{detailDistrict.name}</strong>
                <span className="muted">{detailDistrict.stateName}</span>
                <dl>
                  <div>
                    <dt>Stand</dt>
                    <dd>{stageLabels[areaStage(detailArea, now)]}</dd>
                  </div>
                  <div>
                    <dt>Quellen</dt>
                    <dd>{detailArea?.foundSources ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Letzter Lauf</dt>
                    <dd>{dateText(detailArea?.lastRunAt ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Nächste Fälligkeit</dt>
                    <dd>{dateText(detailArea?.nextDueAt ?? null)}</dd>
                  </div>
                  {(detailArea?.incompleteRuns ?? 0) > 0 && (
                    <div>
                      <dt>Unvollständige Läufe</dt>
                      <dd>{detailArea?.incompleteRuns}</dd>
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
