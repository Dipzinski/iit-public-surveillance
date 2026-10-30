#!/usr/bin/env python3
"""IIT Public Surveillance server.

Serves the static dashboard and a small JSON API:
  /api/safety/*   the Illinois Tech Public Safety log archive (safety/ package),
                  kept in sync in a background thread
  /api/cameras    Illinois DOT traffic cameras (this file)
  /api/crime, /api/traffic, /api/alerts   neighborhood add-on feeds (feeds.py)
Standard library only, so it runs on any Python 3.9+.

    SAFETY_SYNC=0 python3 server.py   # serve the archive without syncing it

    python3 server.py            # http://localhost:8000
    PORT=9000 python3 server.py
"""

import errno
import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import feeds
from safety.dataset import Dataset
from safety.store import Store
from safety.sync import Sync

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
BOUNDARY_FILE = ROOT / "data" / "chicago_boundary.json"

PORT = int(os.environ.get("PORT", "8000"))
FEED_TTL_SECONDS = 60
USER_AGENT = "ChicagoCameraDashboard/0.1 (+local dev)"

# IDOT's public camera layer (also powers gettingaroundillinois.com).
FEED_URL = (
    "https://services2.arcgis.com/aIrBD8yn1TDTEXoz/ArcGIS/rest/services/"
    "TrafficCamerasTM_Public/FeatureServer/0/query"
)
# Rough box around the city; the exact city-limits test happens below.
FEED_PARAMS = {
    "where": "y > 41.64 AND y < 42.03 AND x > -87.95 AND x < -87.52",
    "outFields": "CameraLocation,CameraDirection,x,y,SnapShot,ImgPath,AgeInMinutes,TooOld",
    "returnGeometry": "false",
    "resultRecordCount": "2000",
    "f": "json",
}
SNAPSHOT_HOST = "cctv.travelmidwest.com"

# Snapshot names look like IL-IDOTD1_1_Cook_SB_I-90_4186990_-8764490_1_NONE.jpg
SNAPSHOT_RE = re.compile(
    r"^(?P<agency>[^_]+)_\d+_(?P<county>[^_]+)_(?P<dir>[A-Z]*)_(?P<road>[^_]+)_"
)
DIRECTIONS = {
    "NB": "Northbound", "SB": "Southbound", "EB": "Eastbound", "WB": "Westbound",
    "NEB": "Northeastbound", "NWB": "Northwestbound",
    "SEB": "Southeastbound", "SWB": "Southwestbound",
    "N": "North", "S": "South", "E": "East", "W": "West",
}


def expressway_name(road, lat):
    """Local name for a route code, using latitude where one route changes names."""
    if road in ("I-90", "I-94", "Kennedy-Reversibles"):
        if road == "I-94" and lat >= 41.965:
            return "Edens Expy"
        if road == "I-94" and lat < 41.716:  # south of the I-57 junction
            return "Bishop Ford Fwy"
        return "Kennedy Expy" if lat >= 41.875 else "Dan Ryan Expy"
    return {
        "I-290": "Eisenhower Expy",
        "IL-110": "Eisenhower Expy",
        "I-55": "Stevenson Expy",
        "I-57": "I-57",
        "I-190": "Kennedy Expy (O'Hare)",
        "I-294": "Tri-State Tollway",
        "US-41": "Lake Shore Dr",
        "Ohio-Feeder": "Ohio St Feeder",
        "Stony-Island-Feeder": "Stony Island Ave",
    }.get(road, road)


# --- City limits -------------------------------------------------------------

def _load_boundary():
    with open(BOUNDARY_FILE) as fh:
        return json.load(fh)


BOUNDARY = _load_boundary()


def _in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_chicago(lon, lat):
    for polygon in BOUNDARY["coordinates"]:
        outer, holes = polygon[0], polygon[1:]
        if _in_ring(lon, lat, outer) and not any(_in_ring(lon, lat, h) for h in holes):
            return True
    return False


# --- Camera feed -------------------------------------------------------------

def normalize(attrs):
    snapshot = attrs.get("SnapShot") or ""
    filename = snapshot.rsplit("/", 1)[-1]
    if not filename.endswith(".jpg") or urllib.parse.urlparse(snapshot).hostname != SNAPSHOT_HOST:
        return None
    lat, lon = attrs.get("y"), attrs.get("x")
    if lat is None or lon is None:
        return None

    match = SNAPSHOT_RE.match(filename)
    road = match.group("road") if match else ""
    travel_dir = match.group("dir") if match else ""
    # Multi-view intersection cameras report the view in CameraDirection instead.
    view = attrs.get("CameraDirection") or "NONE"
    direction = DIRECTIONS.get(view if view != "NONE" else travel_dir, "")

    try:
        age = int(attrs.get("AgeInMinutes") or 0)
    except ValueError:
        age = None

    return {
        "id": filename[:-4],
        "name": (attrs.get("CameraLocation") or "Unnamed camera").strip(),
        "road": road,
        "roadName": expressway_name(road, lat),
        "direction": direction,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "ageMinutes": age,
        "tooOld": str(attrs.get("TooOld")).lower() == "true",
        "agency": match.group("agency") if match else "",
        "sourceUrl": attrs.get("ImgPath") or "",
        "_snapshot": snapshot,
    }


class CameraFeed:
    def __init__(self):
        self._lock = threading.Lock()
        self._cameras = {}
        self._fetched_at = 0.0
        self._error = None

    def _fetch(self):
        url = FEED_URL + "?" + urllib.parse.urlencode(FEED_PARAMS)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.load(resp)
        if "error" in payload:
            raise RuntimeError(payload["error"].get("message", "feed error"))

        cameras = {}
        for feature in payload.get("features", []):
            cam = normalize(feature.get("attributes", {}))
            if cam and in_chicago(cam["lon"], cam["lat"]):
                cameras[cam["id"]] = cam
        return cameras

    def get(self):
        with self._lock:
            if time.time() - self._fetched_at > FEED_TTL_SECONDS:
                try:
                    self._cameras = self._fetch()
                    self._error = None
                except (urllib.error.URLError, OSError, ValueError, RuntimeError) as exc:
                    # Keep serving the last good list; retry again after the TTL.
                    self._error = str(exc)
                self._fetched_at = time.time()
            return self._cameras, self._fetched_at, self._error


FEED = CameraFeed()


# --- HTTP --------------------------------------------------------------------

STORE = Store()
DATASET = Dataset(STORE)
SYNC = Sync(STORE, on_change=DATASET.invalidate)

FEED_ROUTES = {
    "/api/site": feeds.site,
    "/api/crime": feeds.crime,
    "/api/traffic": feeds.traffic,
    "/api/alerts": feeds.alerts,
}


class Handler(SimpleHTTPRequestHandler):
    serving_static = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        # Make browsers revalidate static files so edits show up on a normal reload.
        if self.serving_static:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/snapshot/" not in self.path:  # snapshots are too chatty to log
            super().log_message(fmt, *args)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/cameras":
            return self.send_cameras()
        if path == "/api/boundary":
            return self.send_json(BOUNDARY, cache="public, max-age=86400")
        if path.startswith("/api/snapshot/"):
            return self.send_snapshot(urllib.parse.unquote(path[len("/api/snapshot/"):]))
        if path == "/api/safety/dataset":
            return self.send_dataset()
        if path == "/api/safety/status":
            return self.send_json({**STORE.stats(), "sync": SYNC.status()})
        if path in FEED_ROUTES:
            return self.send_json(FEED_ROUTES[path]())
        if path.startswith("/api/"):
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        self.serving_static = True
        return super().do_GET()

    def accepts_gzip(self):
        return "gzip" in self.headers.get("Accept-Encoding", "")

    def send_json(self, body, status=HTTPStatus.OK, cache="no-store"):
        data = json.dumps(body, separators=(",", ":")).encode()
        compressed = len(data) > 2048 and self.accepts_gzip()
        if compressed:
            data = gzip.compress(data, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(data)

    def send_dataset(self):
        if not STORE.post_count():
            return self.send_json({"error": "The archive is still being built. Try again shortly.",
                                   "sync": SYNC.status()}, HTTPStatus.SERVICE_UNAVAILABLE)
        etag, raw, compressed = DATASET.encoded()
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        data = compressed if self.accepts_gzip() else raw
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        if data is compressed:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(data)

    def send_cameras(self):
        cameras, fetched_at, error = FEED.get()
        if not cameras and error:
            return self.send_json({"error": f"Camera feed unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
        public = [{k: v for k, v in c.items() if not k.startswith("_")} for c in cameras.values()]
        public.sort(key=lambda c: (-c["lat"], c["lon"]))
        self.send_json({
            "source": "Illinois Department of Transportation (IDOT) public traffic cameras",
            "fetchedAt": datetime.fromtimestamp(fetched_at, timezone.utc).isoformat(),
            "stale": error is not None,
            "count": len(public),
            "cameras": public,
        })

    def send_snapshot(self, cam_id):
        # Only relay images for cameras in the feed, so this is not an open proxy.
        cameras, _, _ = FEED.get()
        cam = cameras.get(cam_id)
        if not cam:
            return self.send_json({"error": "unknown camera"}, HTTPStatus.NOT_FOUND)

        # The snapshot host refuses requests carrying a third-party Referer, so the
        # server fetches it directly and passes along when the frame was captured.
        req = urllib.request.Request(cam["_snapshot"], headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                image = resp.read()
                last_modified = resp.headers.get("Last-Modified")
        except (urllib.error.URLError, OSError) as exc:
            return self.send_json({"error": f"snapshot unavailable: {exc}"}, HTTPStatus.BAD_GATEWAY)

        captured = ""
        if last_modified:
            try:
                captured = parsedate_to_datetime(last_modified).isoformat()
            except (TypeError, ValueError):
                pass

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(image)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Captured-At", captured)
        self.end_headers()
        self.wfile.write(image)


def main():
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        sys.exit(
            f"Port {PORT} is already in use. The dashboard may already be running at "
            f"http://localhost:{PORT}.\nTo start another copy, pick a different port: "
            f"PORT={PORT + 1} python3 server.py"
        )
    if os.environ.get("SAFETY_SYNC", "1") != "0":
        SYNC.start()
        if not STORE.post_count():
            print("Building the Public Safety log archive in the background (about a minute on first run)…")
    print(f"IIT Public Surveillance running at http://localhost:{PORT}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
