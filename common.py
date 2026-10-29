"""Shared helpers: site config, HTTP fetching, Chicago time, distances and text casing."""

import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE = json.loads((DATA_DIR / "site.json").read_text())
CENTER = SITE["center"]
CHICAGO_TZ = ZoneInfo("America/Chicago")
USER_AGENT = "IITPublicSurveillance/0.3 (+https://github.com/Dipzinski/iit-public-surveillance)"
METERS_PER_MILE = 1609.34
MILES_PER_DEGREE_LAT = 69.05

FETCH_ERRORS = (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, ET.ParseError)


def fetch(url, params=None, accept=None, timeout=20):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
        return resp.read()


def fetch_json(url, params=None, accept=None, timeout=20):
    return json.loads(fetch(url, params, accept, timeout))


def miles_between(lat1, lon1, lat2, lon2):
    dx = (lon1 - lon2) * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, lat1 - lat2) * MILES_PER_DEGREE_LAT


def miles_from_center(lat, lon):
    return miles_between(lat, lon, CENTER["lat"], CENTER["lon"])


def chicago_now():
    return datetime.now(CHICAGO_TZ)


def title(text):
    """Title-case without str.title()'s '35Th St': only letters that start a word go up."""
    return re.sub(r"\b[a-z]", lambda m: m.group(0).upper(), (text or "").lower())


def nice(text):
    """'ACCIDENT : MOTOR VEHICLE' -> 'Accident – Motor Vehicle'."""
    return " – ".join(title(part.strip()) for part in (text or "").split(":") if part.strip())
