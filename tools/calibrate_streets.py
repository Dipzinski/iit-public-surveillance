#!/usr/bin/env python3
"""Fit a street model of the area around campus from Chicago Police block records.

Chicago's police reports give a hundred-block address ("033XX S FEDERAL ST")
and a point on that block. Thousands of them are enough to learn where every
nearby street runs:

  * north-south streets (S/N addresses): a fixed longitude, and latitude as a
    linear function of the house number
  * east-west streets (E/W addresses): a fixed latitude, and longitude as a
    linear function of the signed house number (west negative)

plus two city-wide grid fits used as a fallback for streets with too few points.
The result is written to data/geo/streets.json and read by safety/geocode.py.

    python3 tools/calibrate_streets.py            # radius 1.6 mi, records since 2021
"""

import json
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import CENTER, DATA_DIR, METERS_PER_MILE, fetch_json  # noqa: E402

CRIMES = "https://data.cityofchicago.org/resource/ijzp-q8t2.json"
RADIUS_MI = 1.6
SINCE = "2021-01-01T00:00:00"
MIN_POINTS = 8
BLOCK_RE = re.compile(r"^(\d*?)(X+)\s+([NSEW])\s+(.+)$")


def linear_fit(xs, ys):
    """Least-squares y = a + b*x."""
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return my, 0.0
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return my - b * mx, b


def trimmed(points, axis_index, tolerance):
    """Drop points far from the street's median line (mis-geocoded records)."""
    center = statistics.median(p[axis_index] for p in points)
    return [p for p in points if abs(p[axis_index] - center) <= tolerance], center


def main():
    rows = fetch_json(CRIMES, {
        "$select": "block,latitude,longitude",
        "$where": (
            f"within_circle(location,{CENTER['lat']},{CENTER['lon']},{round(RADIUS_MI * METERS_PER_MILE)}) "
            f"AND date > '{SINCE}' AND latitude IS NOT NULL"
        ),
        "$limit": "60000",
    }, timeout=120)
    print(f"{len(rows)} police records")

    by_street = defaultdict(list)
    for row in rows:
        m = BLOCK_RE.match((row.get("block") or "").strip())
        if not m:
            continue
        number = int(m.group(1) or 0) * 10 ** len(m.group(2)) + 5 * 10 ** (len(m.group(2)) - 1)  # block midpoint
        direction, street = m.group(3), " ".join(m.group(4).upper().split())
        signed = -number if direction in "SW" else number
        by_street[(direction, street)].append((signed, float(row["latitude"]), float(row["longitude"])))

    streets, ns_points, ew_points = {}, [], []
    for (direction, street), points in by_street.items():
        axis = "ns" if direction in "NS" else "ew"
        if axis == "ns":
            points, lon = trimmed(points, 2, 0.0012)
            if len(points) < MIN_POINTS:
                continue
            a, b = linear_fit([p[0] for p in points], [p[1] for p in points])
            model = {"axis": "ns", "lon": round(lon, 6), "lat": [round(a, 7), b]}
            ns_points += [(p[0], p[1]) for p in points]
        else:
            points, lat = trimmed(points, 1, 0.0008)
            if len(points) < MIN_POINTS:
                continue
            a, b = linear_fit([p[0] for p in points], [p[2] for p in points])
            model = {"axis": "ew", "lat": round(lat, 6), "lon": [round(a, 7), b]}
            ew_points += [(p[0], p[2]) for p in points]
        numbers = [p[0] for p in points]
        model.update({"range": [min(numbers), max(numbers)], "points": len(points)})
        key = f"{direction} {street}"
        # The same street can appear as "S STATE ST" and "N STATE ST"; keep the better-sampled one.
        if key not in streets or streets[key]["points"] < model["points"]:
            streets[key] = model

    grid = {
        "lat": list(linear_fit([p[0] for p in ns_points], [p[1] for p in ns_points])),
        "lon": list(linear_fit([p[0] for p in ew_points], [p[1] for p in ew_points])),
    }
    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Chicago Police Department crime reports (City of Chicago Data Portal, ijzp-q8t2)",
        "center": CENTER,
        "radiusMi": RADIUS_MI,
        "note": "Signed house numbers: south and west are negative. lat/lon fits are [intercept, slope].",
        "grid": grid,
        "streets": dict(sorted(streets.items())),
    }
    path = DATA_DIR / "geo" / "streets.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{len(streets)} streets -> {path.relative_to(DATA_DIR.parent)}")
    for name in ("S STATE ST", "S DEARBORN ST", "S FEDERAL ST", "S WABASH AVE", "S MICHIGAN AVE", "W 33RD ST", "W 35TH ST", "W 31ST ST"):
        print(f"  {name:16} {streets.get(name)}")


if __name__ == "__main__":
    main()
