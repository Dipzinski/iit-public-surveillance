"""The compact dataset the dashboard downloads once and then filters in the browser.

Every Mies-campus incident in the archive goes out as parallel arrays plus small
lookup tables (types, places, dispositions, posts), so ~5,000 incidents with
their notes fit in a few hundred KB gzipped and the page can crossfilter
instantly without asking the server again.
"""

import gzip
import hashlib
import html
import json
import threading
from datetime import datetime

from common import CHICAGO_TZ, SITE
from safety.taxonomy import FAMILIES

# The Mies campus, plus off-campus reports and ones with no campus named
# (both are almost always handled by the Mies campus office).
CAMPUSES = ("MIES", "OFF", "UNKNOWN")
FAMILY_INDEX = {f["id"]: i for i, f in enumerate(FAMILIES)}


class Lookup:
    """Interns values into a list and hands back their index."""

    def __init__(self):
        self.items, self._index = [], {}

    def __call__(self, key, item=None):
        if key not in self._index:
            self._index[key] = len(self.items)
            self.items.append(key if item is None else item)
        return self._index[key]


def epoch(value):
    return int(datetime.fromisoformat(value).timestamp())


def build(store):
    rows = store.incidents(CAMPUSES)
    types, places, dispositions, posts = Lookup(), Lookup(), Lookup(), Lookup()
    cols = {k: [] for k in ("id", "t", "approx", "family", "type", "place", "disp", "post", "campus", "notes")}
    for r in rows:
        if r["reported_at"]:
            t, approx = epoch(r["reported_at"]), 0
        else:
            # No time in the log: use the post's date, which is the morning after.
            t, approx = epoch(datetime.fromisoformat(r["post_date"]).replace(tzinfo=CHICAGO_TZ).isoformat()), 1
        cols["id"].append(r["id"])
        cols["t"].append(t)
        cols["approx"].append(approx)
        cols["family"].append(FAMILY_INDEX[r["family"]])
        cols["type"].append(types(r["type"]))
        cols["place"].append(places(
            (r["place"], r["lat"], r["lon"], r["geo_quality"]),
            {"name": r["place"], "lat": r["lat"], "lon": r["lon"], "quality": r["geo_quality"],
             "address": r["address"] or "", "area": r["area"] or ""},
        ))
        cols["disp"].append(dispositions(r["disposition"]) if r["disposition"] else -1)
        cols["post"].append(posts(r["post_id"], {
            "id": r["post_id"], "date": r["post_date"], "link": r["post_link"], "title": html.unescape(r["post_title"]),
        }))
        cols["campus"].append(CAMPUSES.index(r["campus"]))
        cols["notes"].append(r["notes"] or "")

    return {
        "site": {"name": SITE["name"], "center": SITE["center"], "outline": SITE["campusOutline"]},
        "families": FAMILIES,
        "campuses": ["Mies Campus", "Off campus", "Not stated"],
        "types": types.items,
        "places": places.items,
        "dispositions": dispositions.items,
        "posts": posts.items,
        "count": len(rows),
        "incidents": cols,
    }


class Dataset:
    """Caches the encoded dataset until the archive is rebuilt."""

    def __init__(self, store):
        self.store = store
        self._lock = threading.Lock()
        self._cached = None

    def invalidate(self):
        with self._lock:
            self._cached = None

    def encoded(self):
        """Return (etag, json_bytes, gzip_bytes)."""
        with self._lock:
            if self._cached is None:
                body = json.dumps(build(self.store), separators=(",", ":")).encode()
                etag = '"%s"' % hashlib.sha1(body).hexdigest()[:16]
                self._cached = (etag, body, gzip.compress(body, compresslevel=6))
            return self._cached
