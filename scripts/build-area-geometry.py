#!/usr/bin/env python3
"""Build the district outlines used by the area map.

Source geometry: Bundesamt fuer Kartographie und Geodaesie, VG2500 districts
(Datenlizenz Deutschland - Namensnennung - Version 2.0, dl-de/by-2-0), taken
from a published GeoJSON copy that keeps the official AGS key.

The script projects WGS84 into a fixed web-mercator viewport, simplifies the
rings and emits ready-to-render SVG path data so the browser does no geometry
work. Run it only when the district list or the source geometry changes:

    curl -sSLo /tmp/counties.geojson \\
      https://raw.githubusercontent.com/jgehrcke/covid-19-germany-gae/master/geodata/DE-counties.geojson
    python3 scripts/build-area-geometry.py /tmp/counties.geojson
"""
import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AREAS = REPO / "modules/ingestion/src/data/areas.de.json"
TARGET = REPO / "modules/ingestion/src/data/area-geometry.de.ts"
WIDTH = 1000.0
TOLERANCE = 0.55  # viewport units
MIN_RING_AREA = 0.8  # viewport units squared


def mercator(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon)
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        ax, ay = points[start]
        bx, by = points[end]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, worst_index = -1.0, -1
        for index in range(start + 1, end):
            px, py = points[index]
            if norm == 0:
                distance = math.hypot(px - ax, py - ay)
            else:
                distance = abs(dx * (ay - py) - (ax - px) * dy) / norm
            if distance > worst:
                worst, worst_index = distance, index
        if worst > tolerance and worst_index > 0:
            keep[worst_index] = True
            stack.append((start, worst_index))
            stack.append((worst_index, end))
    return [point for point, flag in zip(points, keep) if flag]


def ring_area(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for index in range(len(points)):
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def rings(geometry: dict) -> list[list[tuple[float, float]]]:
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:
        raise SystemExit(f"unsupported geometry {geometry['type']}")
    return [[(float(x), float(y)) for x, y in ring] for polygon in polygons for ring in polygon]


def main() -> None:
    source = Path(sys.argv[1])
    features = json.loads(source.read_text())["features"]
    districts = [area for area in json.loads(AREAS.read_text()) if area["level"] == "district"]
    wanted = {area["ags"]: area for area in districts}

    projected: dict[str, list[list[tuple[float, float]]]] = {}
    for feature in features:
        ags = feature["properties"]["AGS"]
        if ags not in wanted:
            continue
        projected.setdefault(ags, []).extend(
            [mercator(x, y) for x, y in ring] for ring in rings(feature["geometry"])
        )
    missing = sorted(set(wanted) - set(projected))
    if missing:
        raise SystemExit(f"no geometry for {missing}")

    xs = [x for shape in projected.values() for ring in shape for x, _ in ring]
    ys = [y for shape in projected.values() for ring in shape for _, y in ring]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    scale = WIDTH / (max_x - min_x)
    height = round((max_y - min_y) * scale, 2)

    def place(point: tuple[float, float]) -> tuple[float, float]:
        x, y = point
        return (x - min_x) * scale, (max_y - y) * scale

    shapes = []
    for ags, shape in projected.items():
        area = wanted[ags]
        paths = []
        for ring in shape:
            viewport = simplify([place(point) for point in ring], TOLERANCE)
            if len(viewport) < 4 or ring_area(viewport) < MIN_RING_AREA:
                continue
            head = f"M{viewport[0][0]:.1f} {viewport[0][1]:.1f}"
            tail = "".join(f"L{x:.1f} {y:.1f}" for x, y in viewport[1:])
            paths.append(f"{head}{tail}Z")
        if not paths:
            raise SystemExit(f"geometry of {ags} collapsed during simplification")
        centre_ring = max(shape, key=lambda ring: ring_area([place(point) for point in ring]))
        centre = [place(point) for point in centre_ring]
        shapes.append({
            "ags": ags,
            "name": area["name"],
            "stateName": area["stateName"],
            "path": " ".join(paths),
            "labelX": round(sum(x for x, _ in centre) / len(centre), 1),
            "labelY": round(sum(y for _, y in centre) / len(centre), 1),
        })
    shapes.sort(key=lambda shape: shape["ags"])

    payload = json.dumps({
        "attribution": "Geometrie: \u00a9 GeoBasis-DE / BKG (VG2500), dl-de/by-2-0",
        "viewBox": f"0 0 {WIDTH:.0f} {height:.0f}",
        "districts": shapes,
    }, ensure_ascii=False, separators=(",", ":"))
    literal = json.dumps(payload, ensure_ascii=False)
    TARGET.write_text(
        "// Generated by scripts/build-area-geometry.py - do not edit by hand.\n"
        "// Geometry: (c) GeoBasis-DE / BKG (VG2500), dl-de/by-2-0.\n"
        "// Serialised as a string so the compiler does not infer a type per outline.\n"
        f"export const areaGeometrySource: string = {literal};\n",
    )
    print(f"{len(shapes)} districts, viewBox 0 0 {WIDTH:.0f} {height:.0f}, {TARGET.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
