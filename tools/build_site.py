"""Bake the whole app into plain files that GitHub Pages can serve.

    python3 tools/build_site.py      writes dist/

Every file has the name the frontend asks for, so the same pages run here and on
server.py. A source that fails keeps its last good file from the previous run
(the workflow restores dist/api from a cache), so one bad request upstream never
blanks part of the site.
"""

import json
import shutil
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402  (the routes, camera list and archive the local app uses)
from common import SITE, miles_between  # noqa: E402

DIST = ROOT / "dist"
API = DIST / "api"

# Far fewer than this means the source or the parser broke. Keep the last good site up instead.
MIN_REPORTS = 4000


def write(name, data):
    path = API / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def write_json(name, body):
    write(name, json.dumps(body, separators=(",", ":")).encode())


def read_json(name, default):
    try:
        return json.loads((API / name).read_text())
    except (OSError, ValueError):
        return default


def failed(body):
    """The first error in a feed's response, including its sub-sections."""
    parts = [body] + [v for v in body.values() if isinstance(v, dict)] if isinstance(body, dict) else []
    return next((p["error"] for p in parts if p.get("error")), None)


def bake_feeds():
    for route, feed in server.FEED_ROUTES.items():
        name = f"{route[len('/api/'):]}.json"
        body = feed()
        error = failed(body)
        if error and (API / name).exists():
            print(f"  {name}: keeping the last good copy ({error})")
            continue
        write_json(name, body)
        print(f"  {name}: {'error: ' + error if error else 'ok'}")


def bake_cameras():
    """Save the current frame from each camera around campus, with when it was taken."""
    cameras, fetched_at, error = server.FEED.get()
    if not cameras:
        print(f"  cameras: keeping the last good copy ({error})")
        return

    center = SITE["center"]
    featured = {f["id"] for f in SITE["featuredCameras"]}
    area = [
        c for c in cameras.values()
        if c["id"] in featured
        or miles_between(c["lat"], c["lon"], center["lat"], center["lon"]) <= SITE["cameraAreaMi"]
    ]

    captures = read_json("captures.json", {})
    published = []
    for cam in sorted(area, key=lambda c: (-c["lat"], c["lon"])):
        try:
            image, captured = server.fetch_snapshot(cam)
        except (urllib.error.URLError, OSError) as exc:
            print(f"  {cam['id']}: keeping the last frame ({exc})")
        else:
            write(f"snapshot/{cam['id']}.jpg", image)
            estimated = datetime.now(timezone.utc) - timedelta(minutes=cam["ageMinutes"] or 0)
            captures[cam["id"]] = captured or estimated.isoformat()
        if cam["id"] in captures:
            published.append({k: v for k, v in cam.items() if not k.startswith("_")})

    write_json("captures.json", captures)
    write_json("cameras.json", {
        "source": "Illinois Department of Transportation (IDOT) public traffic cameras",
        "fetchedAt": datetime.fromtimestamp(fetched_at, timezone.utc).isoformat(),
        "stale": False,
        "published": True,
        "count": len(published),
        "cameras": published,
    })
    print(f"  cameras: {len(published)} frames")


def main():
    print("Syncing the Public Safety log…")
    server.SYNC.run_once()
    body = server.DATASET.encoded()[1]
    count = json.loads(body)["count"]
    if count < MIN_REPORTS:
        sys.exit(f"Only {count} reports in the archive (expected at least {MIN_REPORTS}). Not publishing.")
    print(f"  {count} reports")

    shutil.copytree(server.STATIC_DIR, DIST, dirs_exist_ok=True)
    write("safety/dataset.json", body)
    write_json("safety/status.json", {**server.STORE.stats(), "sync": server.SYNC.status()})
    write_json("boundary.json", server.BOUNDARY)

    print("Fetching feeds…")
    bake_feeds()
    print("Saving camera frames…")
    bake_cameras()
    print(f"Done: {DIST}")


if __name__ == "__main__":
    main()
