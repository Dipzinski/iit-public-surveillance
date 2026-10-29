"""Keep the local archive in step with the IIT Public Safety blog.

The blog is WordPress, which publishes a public JSON API. The first run pages
through every post (100 per request, one request per second); after that, only
posts created or edited since the last sync are fetched, every 15 minutes.

    python3 -m safety.sync            # backfill if empty, then fetch anything new
    python3 -m safety.sync --rebuild  # re-parse and re-geocode the stored posts only
"""

import argparse
import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from common import FETCH_ERRORS, USER_AGENT
from safety.store import Store

API = "https://blogs.iit.edu/public_safety/wp-json/wp/v2/posts"
FIELDS = "id,date,modified,link,title,content"
PER_PAGE = 100
PAUSE_SECONDS = 1.0          # be gentle with IIT's server
INTERVAL_SECONDS = 15 * 60


def fetch_page(page, modified_after=None):
    params = {"per_page": PER_PAGE, "page": page, "_fields": FIELDS, "orderby": "date", "order": "desc"}
    if modified_after:
        params.update({"modified_after": modified_after, "orderby": "modified", "order": "asc"})
    request = urllib.request.Request(f"{API}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as resp:
        pages = int(resp.headers.get("X-WP-TotalPages", "1") or 1)
        items = json.loads(resp.read())
    posts = [{
        "id": item["id"],
        "date": item["date"],
        "modified": item["modified"],
        "title": item["title"]["rendered"],
        "link": item["link"],
        "html": item["content"]["rendered"],
    } for item in items]
    return posts, pages


class Sync:
    """Runs the archive sync and reports progress for the dashboard's status endpoint."""

    def __init__(self, store, on_change=None):
        self.store = store
        self.on_change = on_change or (lambda: None)
        self.state = {"phase": "idle", "page": 0, "pages": 0, "fetched": 0,
                      "lastSync": None, "lastError": None, "lastChange": None}
        self._lock = threading.Lock()

    def status(self):
        with self._lock:
            return dict(self.state)

    def _set(self, **changes):
        with self._lock:
            self.state.update(changes)

    def _pages(self, modified_after=None):
        page, pages, changed = 1, 1, 0
        while page <= pages:
            for attempt in range(3):
                try:
                    posts, pages = fetch_page(page, modified_after)
                    break
                except FETCH_ERRORS as exc:
                    # WordPress answers 400 for a page past the end, e.g. when no posts changed.
                    if getattr(exc, "code", None) == 400:
                        return changed
                    if attempt == 2:
                        raise
                    time.sleep(5 * (attempt + 1))
            changed += self.store.upsert_posts(posts)
            self._set(page=page, pages=pages, fetched=self.state["fetched"] + len(posts))
            page += 1
            time.sleep(PAUSE_SECONDS)
        return changed

    def run_once(self):
        """Backfill if the archive is empty, otherwise fetch what changed. Rebuilds when needed."""
        try:
            if self.store.post_count() == 0:
                self._set(phase="backfill", page=0, pages=0, fetched=0, lastError=None)
                changed = self._pages()
            else:
                self._set(phase="updating", page=0, pages=0, lastError=None)
                # Overlap a day so an edit near the boundary isn't missed; unchanged posts are skipped.
                since = datetime.fromisoformat(self.store.latest_modified()) - timedelta(days=1)
                changed = self._pages(modified_after=since.isoformat(timespec="seconds"))
            if changed or self.store.needs_rebuild():
                self._set(phase="parsing")
                self.store.rebuild()
                self._set(lastChange=time.time())
                self.on_change()
            self._set(phase="idle", lastSync=time.time())
        except FETCH_ERRORS as exc:
            self._set(phase="error", lastError=str(exc))
            if self.store.needs_rebuild():
                self.store.rebuild()
                self.on_change()

    def run_forever(self):
        if self.store.needs_rebuild():
            self.store.rebuild()
            self.on_change()
        while True:
            self.run_once()
            time.sleep(INTERVAL_SECONDS)

    def start(self):
        thread = threading.Thread(target=self.run_forever, name="safety-sync", daemon=True)
        thread.start()
        return thread


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rebuild", action="store_true", help="only re-parse the posts already stored")
    args = parser.parse_args()
    store = Store()
    if args.rebuild:
        print("rebuild:", store.rebuild())
    else:
        sync = Sync(store)
        done = threading.Event()
        threading.Thread(target=lambda: (sync.run_once(), done.set()), daemon=True).start()
        last = None
        while not done.wait(1):
            s = sync.status()
            if (s["phase"], s["page"]) != last:
                last = (s["phase"], s["page"])
                print(f"  {s['phase']}: page {s['page']}/{s['pages']}, {s['fetched']} posts", flush=True)
        if sync.status()["lastError"]:
            print("sync error:", sync.status()["lastError"])
    print(json.dumps(store.stats(), indent=1))


if __name__ == "__main__":
    main()
