"""SQLite archive of the DPS log: raw posts in, parsed and geocoded incidents out.

Posts are stored with their raw HTML, so improving the parser or geocoder only
needs a local rebuild (`python3 -m safety.sync --rebuild`), never a re-download.
"""

import os
import sqlite3
import threading
import time
from collections import Counter
from pathlib import Path

from common import DATA_DIR
from safety.geocode import Geocoder
from safety.parser import PARSER_VERSION, parse_post
from safety.taxonomy import family_of

DB_PATH = Path(os.environ.get("SAFETY_DB", DATA_DIR / "safety.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id        INTEGER PRIMARY KEY,
    date      TEXT NOT NULL,       -- WordPress post date, Chicago local time
    modified  TEXT NOT NULL,
    title     TEXT NOT NULL,
    link      TEXT NOT NULL,
    html      TEXT NOT NULL,
    kind      TEXT                 -- log | empty | other, set by rebuild()
);
CREATE TABLE IF NOT EXISTS incidents (
    id           INTEGER PRIMARY KEY,   -- post_id * 100 + seq: stable across rebuilds
    post_id      INTEGER NOT NULL REFERENCES posts(id),
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL,
    category     TEXT NOT NULL,
    family       TEXT NOT NULL,
    campus       TEXT NOT NULL,
    area         TEXT,
    place        TEXT,
    address      TEXT,
    lat          REAL,
    lon          REAL,
    geo_quality  TEXT NOT NULL,
    reported_at  TEXT,
    occurred     TEXT,
    notes        TEXT,
    disposition  TEXT,
    raw_location TEXT
);
CREATE INDEX IF NOT EXISTS incidents_reported ON incidents(reported_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


class Store:
    def __init__(self, path=DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.Lock()
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    # --- meta ----------------------------------------------------------------

    def get_meta(self, key, default=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, conn, key, value):
        conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, str(value)))

    # --- posts ---------------------------------------------------------------

    def upsert_posts(self, posts):
        """posts: dicts with id, date, modified, title, link, html. Returns how many were new or changed."""
        changed = 0
        with self._write_lock, self.connect() as conn:
            for p in posts:
                row = conn.execute("SELECT modified FROM posts WHERE id = ?", (p["id"],)).fetchone()
                if row and row["modified"] == p["modified"]:
                    continue
                changed += 1
                conn.execute(
                    "INSERT INTO posts(id, date, modified, title, link, html) VALUES (:id, :date, :modified, :title, :link, :html) "
                    "ON CONFLICT(id) DO UPDATE SET date=excluded.date, modified=excluded.modified, "
                    "title=excluded.title, link=excluded.link, html=excluded.html",
                    p,
                )
        return changed

    def post_count(self):
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]

    def latest_modified(self):
        with self.connect() as conn:
            return conn.execute("SELECT MAX(modified) FROM posts").fetchone()[0]

    # --- parse + geocode everything --------------------------------------------

    def rebuild(self):
        """Re-parse every stored post, learn building addresses, geocode, and replace all incidents."""
        started = time.time()
        with self._write_lock, self.connect() as conn:
            posts = conn.execute("SELECT id, html FROM posts ORDER BY date").fetchall()
            parsed, kinds = [], {}
            for post in posts:
                kind, incidents = parse_post(post["html"])
                kinds[post["id"]] = kind
                parsed += [(post["id"], seq, inc) for seq, inc in enumerate(incidents)]

            geocoder = Geocoder()
            geocoder.learn(inc for _, _, inc in parsed)

            conn.execute("DELETE FROM incidents")
            conn.executemany("UPDATE posts SET kind = ? WHERE id = ?", [(k, i) for i, k in kinds.items()])
            rows = []
            for post_id, seq, inc in parsed:
                where = geocoder.locate(inc)
                rows.append((
                    post_id * 100 + seq, post_id, seq, inc["type"], inc["category"], family_of(inc["raw_type"]),
                    inc["campus"], inc["area"], where["place"], where["address"], where["lat"], where["lon"],
                    where["quality"], inc["reported_at"], inc["occurred"], inc["notes"], inc["disposition"],
                    inc["raw_location"],
                ))
            conn.executemany(f"INSERT INTO incidents VALUES ({','.join('?' * 18)})", rows)
            self.set_meta(conn, "parser_version", PARSER_VERSION)
            self.set_meta(conn, "rebuilt_at", time.time())
        return {"posts": len(posts), "incidents": len(rows), "seconds": round(time.time() - started, 2)}

    def needs_rebuild(self):
        return self.post_count() and self.get_meta("parser_version") != str(PARSER_VERSION)

    # --- reads -----------------------------------------------------------------

    def incidents(self, campuses):
        marks = ",".join("?" * len(campuses))
        with self.connect() as conn:
            return conn.execute(
                f"SELECT i.*, p.date AS post_date, p.link AS post_link, p.title AS post_title "
                f"FROM incidents i JOIN posts p ON p.id = i.post_id WHERE i.campus IN ({marks}) "
                f"ORDER BY COALESCE(i.reported_at, p.date)", campuses,
            ).fetchall()

    def stats(self):
        with self.connect() as conn:
            kinds = dict(Counter(r["kind"] for r in conn.execute("SELECT kind FROM posts")))
            campus = dict(conn.execute("SELECT campus, COUNT(*) FROM incidents GROUP BY campus").fetchall())
            quality = dict(conn.execute(
                "SELECT geo_quality, COUNT(*) FROM incidents WHERE campus IN ('MIES','OFF','UNKNOWN') GROUP BY geo_quality"
            ).fetchall())
            years = dict(conn.execute(
                "SELECT substr(COALESCE(i.reported_at, p.date), 1, 4) y, COUNT(*) FROM incidents i "
                "JOIN posts p ON p.id = i.post_id WHERE i.campus IN ('MIES','OFF','UNKNOWN') GROUP BY y"
            ).fetchall())
            span = conn.execute("SELECT MIN(date), MAX(date) FROM posts WHERE kind IN ('log','empty')").fetchone()
            timed = conn.execute("SELECT COUNT(*) FROM incidents WHERE reported_at IS NOT NULL").fetchone()[0]
        total = sum(campus.values())
        return {
            "posts": sum(kinds.values()),
            "postKinds": kinds,
            "incidents": total,
            "byCampus": campus,
            "withTime": timed,
            "geoQuality": quality,
            "byYear": years,
            "firstLog": span[0],
            "lastLog": span[1],
            "parserVersion": PARSER_VERSION,
            "rebuiltAt": float(self.get_meta("rebuilt_at", 0) or 0),
        }
