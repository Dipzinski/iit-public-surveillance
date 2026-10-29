"""End-to-end: posts go into a temporary archive and come out of the HTTP API."""

import gzip
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"
TMP = tempfile.TemporaryDirectory()
os.environ["SAFETY_DB"] = str(Path(TMP.name) / "test.db")  # must be set before importing server

import server  # noqa: E402


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        posts = []
        for i, path in enumerate(sorted(FIXTURES.glob("*.html")), start=1):
            posts.append({"id": i, "date": f"2026-01-{i:02d}T08:00:00", "modified": "2026-01-01T08:00:00",
                          "title": path.stem, "link": f"https://example.test/{path.stem}", "html": path.read_text()})
        server.STORE.upsert_posts(posts)
        server.STORE.rebuild()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        TMP.cleanup()

    def get(self, path, **headers):
        return urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers), timeout=10)

    def test_dataset_is_gzipped_and_columnar(self):
        with self.get("/api/safety/dataset", **{"Accept-Encoding": "gzip"}) as resp:
            self.assertEqual(resp.headers["Content-Encoding"], "gzip")
            data = json.loads(gzip.decompress(resp.read()))
        # 4 + 3 + 5 + 4 incidents in the fixtures, all Mies campus or off campus.
        self.assertEqual(data["count"], 16)
        cols = data["incidents"]
        self.assertTrue(all(len(v) == 16 for v in cols.values()))
        self.assertEqual(len(data["families"]), 9)
        self.assertIn("Robbery", data["types"])
        place = data["places"][cols["place"][0]]
        self.assertIn("quality", place)

    def test_dataset_etag_gives_304(self):
        with self.get("/api/safety/dataset") as resp:
            etag = resp.headers["ETag"]
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/api/safety/dataset", **{"If-None-Match": etag})
        self.assertEqual(caught.exception.code, 304)

    def test_status_reports_parse_stats(self):
        with self.get("/api/safety/status") as resp:
            status = json.loads(resp.read())
        self.assertEqual(status["posts"], 6)
        self.assertEqual(status["postKinds"], {"log": 4, "empty": 1, "other": 1})
        self.assertIn("phase", status["sync"])


if __name__ == "__main__":
    unittest.main()
