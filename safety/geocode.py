"""Place DPS log locations on the map with a street model learned from city data.

No outside geocoding service is used. data/geo/streets.json (built by
tools/calibrate_streets.py) says where every street near campus runs; this
module turns the log's location text into a point:

  address        "KACEK HALL – 3101 S WABASH"          house number on a street
  intersection   "INTERSECTIONS : 33RD & DEARBORN"      where two streets cross
  block          "FEDERAL : 3200-3300 SOUTH"            middle of a block range
  building       "HERMANN HALL"                         a name whose address was seen elsewhere in
                                                        the archive, or listed in data/geo/aliases.json
  street         "STREET LOCATIONS : 33RD STREET"        that street where it passes campus
  notes          off-campus reports that name a corner in the notes ("at 31st & State")
  campus         somewhere on the Mies Campus, location not given
"""

import json
import re
from collections import Counter, defaultdict

from common import CENTER, DATA_DIR, miles_from_center, title

STREETS_FILE = DATA_DIR / "geo" / "streets.json"
ALIASES_FILE = DATA_DIR / "geo" / "aliases.json"
MAX_MILES = 3.0  # anything farther than this from campus is a misread, not a location

SUFFIXES = {"ST", "STREET", "AVE", "AVENUE", "BLVD", "BOULEVARD", "DR", "DRIVE", "PL", "PLACE", "CT", "COURT",
            "PKWY", "PARKWAY", "RD", "ROAD", "WAY", "TER", "LN", "LANE"}
DIRECTIONS = {"N": "N", "NORTH": "N", "S": "S", "SOUTH": "S", "E": "E", "EAST": "E", "W": "W", "WEST": "W"}
# Location segments that describe a kind of place rather than name one.
GENERIC = {"INTERSECTIONS", "INTERSECTION", "STREET LOCATIONS", "OTHER", "OFF CAMPUS LOCATION", "OFF CAMPUS",
           "GENERAL PARKING LOCATIONS", "RESIDENTIAL BUILDINGS", "ACADEMIC ADMINISTRATIVE BUILDINGS", "UNKNOWN"}

ADDRESS_RE = re.compile(r"^(\d{1,5})\s*(NORTH|SOUTH|EAST|WEST|[NSEW])\.?\s+(.+)$")
RANGE_RE = re.compile(r"^(\d{1,5})\s*-\s*(\d{1,5})\s*(NORTH|SOUTH|EAST|WEST|[NSEW])?\.?$")
INTERSECTION_RE = re.compile(r"^(.+?)\s*(?:&|/|\bAND\b)\s*(.+)$")
# "31st & State", "35th and Michigan" in free-text notes.
NOTES_CORNER_RE = re.compile(r"\b(\d{1,3}(?:ST|ND|RD|TH))(?:\s+(?:ST|STREET|PL))?\.?\s*(?:&|AND)\s+([A-Z][A-Z]+)", re.I)
NOTES_ADDRESS_RE = re.compile(r"\b(\d{2,5})\s+(?:BLOCK OF\s+)?(?:(NORTH|SOUTH|EAST|WEST|[NSEW])\.?\s+)([A-Z0-9]+)", re.I)


def words_of(text):
    return re.sub(r"[^A-Z0-9 ]", " ", (text or "").upper()).split()


def street_key(name):
    """'S WABASH AVE', 'WABASH', 'South Wabash Avenue' -> 'WABASH'; '33RD STREET' -> '33RD'."""
    words = words_of(name)
    if len(words) > 1 and words[0] in DIRECTIONS:
        words = words[1:]
    while len(words) > 1 and words[-1] in SUFFIXES:
        words = words[:-1]
    return " ".join(words)


def name_key(name):
    return " ".join(words_of(name))


ACRONYMS = {"IIT", "MSV", "SSV", "HUB", "ROTC", "CTA", "UIC", "IDOT", "DPS", "CPD", "ATM"}


def place_title(text):
    """Title-case a place name, keeping acronyms and Mc names: 'RV MIDDLE' -> 'RV Middle', 'MCCORMICK' -> 'McCormick'."""
    out = []
    for word in title(text).split(" "):
        bare = re.sub(r"[^A-Za-z]", "", word).upper()
        keep = bare in ACRONYMS or (len(bare) > 1 and not re.search(r"[AEIOUY]", bare))
        out.append(word.upper() if keep else re.sub(r"^Mc([a-z])", lambda m: "Mc" + m.group(1).upper(), word))
    return " ".join(out)


class Geocoder:
    def __init__(self, streets=None, aliases=None):
        data = streets if streets is not None else json.loads(STREETS_FILE.read_text())
        self.models = defaultdict(list)  # street key -> models (numbered streets have E and W halves)
        for full_name, model in data["streets"].items():
            self.models[street_key(full_name)].append(model)
        if aliases is None:
            aliases = json.loads(ALIASES_FILE.read_text()) if ALIASES_FILE.exists() else {}
        self.street_aliases = {street_key(k): street_key(v) for k, v in aliases.get("streets", {}).items()}
        self.curated = {name_key(k): v for k, v in aliases.get("buildings", {}).items()}
        self.learned = {}

    # --- streets -----------------------------------------------------------

    def street(self, name):
        key = street_key(name)
        key = self.street_aliases.get(key, key)
        return key if key in self.models else None

    def _axis_value(self, key, axis):
        """The fixed coordinate of a street: longitude of a N-S street, latitude of an E-W one."""
        models = [m for m in self.models[key] if m["axis"] == axis]
        if not models:
            return None
        field = "lon" if axis == "ns" else "lat"
        total = sum(m["points"] for m in models)
        return sum(m[field] * m["points"] for m in models) / total

    def address(self, number, direction, street_name):
        key = self.street(street_name)
        direction = DIRECTIONS.get(direction.upper())
        if not key or not direction:
            return None
        signed = -number if direction in "SW" else number
        axis = "ns" if direction in "NS" else "ew"
        models = [m for m in self.models[key] if m["axis"] == axis]
        if not models:
            return None
        # Prefer the half of the street (e.g. W vs E 35th) whose numbers include this one.
        model = min(models, key=lambda m: 0 if m["range"][0] - 100 <= signed <= m["range"][1] + 100 else 1)
        if axis == "ns":
            a, b = model["lat"]
            return self._checked(a + b * signed, model["lon"])
        a, b = model["lon"]
        return self._checked(model["lat"], a + b * signed)

    def intersection(self, first, second):
        keys = [self.street(first), self.street(second)]
        if None in keys:
            return None
        for ns, ew in (keys, keys[::-1]):
            lon, lat = self._axis_value(ns, "ns"), self._axis_value(ew, "ew")
            if lon is not None and lat is not None:
                return self._checked(lat, lon)
        return None

    def along_street(self, name):
        """A street with no number: use the point where it passes closest to campus."""
        key = self.street(name)
        if not key:
            return None
        lon = self._axis_value(key, "ns")
        if lon is not None:
            return self._checked(CENTER["lat"], lon)
        lat = self._axis_value(key, "ew")
        return self._checked(lat, CENTER["lon"]) if lat is not None else None

    @staticmethod
    def _checked(lat, lon):
        return (round(lat, 6), round(lon, 6)) if miles_from_center(lat, lon) <= MAX_MILES else None

    # --- buildings ---------------------------------------------------------

    def learn(self, incidents):
        """Remember 'NAME – ADDRESS' pairs so later mentions of NAME alone can be placed."""
        seen = defaultdict(Counter)
        for incident in incidents:
            pieces = incident["pieces"]
            for i, piece in enumerate(pieces):
                if i and ADDRESS_RE.match(piece.upper()) and self._is_name(pieces[i - 1]):
                    seen[name_key(pieces[i - 1])][piece.upper()] += 1
        self.learned = {name: counts.most_common(1)[0][0] for name, counts in seen.items()}

    def building(self, name):
        key = name_key(name)
        text = self.curated.get(key) or self.learned.get(key)
        if not text:
            # Older entries are often cut off ("MCCORMICK STUDENT"): accept a prefix of a
            # known name when every name it could be shares one address.
            known = {**self.learned, **self.curated}
            matches = {address for full, address in known.items() if full.startswith(key + " ")}
            text = matches.pop() if len(matches) == 1 else None
        if not text:
            return None
        m = ADDRESS_RE.match(text.upper())
        return self.address(int(m.group(1)), m.group(2), m.group(3)) if m else None

    def _is_name(self, piece):
        upper = piece.upper()
        return (name_key(piece) not in GENERIC and not ADDRESS_RE.match(upper) and not RANGE_RE.match(upper)
                and not INTERSECTION_RE.match(upper) and not self.street(piece))

    # --- the whole location ------------------------------------------------

    def locate(self, incident):
        """Return {lat, lon, quality, place, address} for a parsed incident (lat/lon None if unknown)."""
        pieces = [p for p in incident["pieces"] if name_key(p) not in GENERIC]
        upper = [p.upper() for p in pieces]
        names = [p for p in pieces if self._is_name(p)]
        label = " · ".join(place_title(n) for n in names)

        for i, text in enumerate(upper):
            m = ADDRESS_RE.match(text)
            if m:
                point = self.address(int(m.group(1)), m.group(2), m.group(3))
                if point:
                    return self._result(point, "address", label or title(pieces[i]), title(pieces[i]))

        for text in upper:
            m = INTERSECTION_RE.match(text)
            if m:
                point = self.intersection(m.group(1), m.group(2))
                if point:
                    return self._result(point, "intersection", label or f"{title(m.group(1))} & {title(m.group(2))}")

        for i, text in enumerate(upper):
            m = RANGE_RE.match(text)
            if m and i and self.street(pieces[i - 1]):
                low, high = int(m.group(1)), int(m.group(2))
                direction = m.group(3) or ("S" if self.models[self.street(pieces[i - 1])][0]["axis"] == "ns" else "W")
                point = self.address((low + high) // 2, direction, pieces[i - 1])
                if point:
                    where = f"{title(pieces[i - 1])}, {low}–{high} {DIRECTIONS[direction.upper()]}"
                    return self._result(point, "block", where)

        for name in reversed(names):
            point = self.building(name)
            if point:
                return self._result(point, "building", label or place_title(name))

        for piece in pieces:
            point = self.along_street(piece)
            if point:
                return self._result(point, "street", title(piece))

        point, where = self._from_notes(incident.get("notes", ""))
        if point:
            return self._result(point, "notes", where)

        if incident["campus"] == "MIES":
            return self._result((CENTER["lat"], CENTER["lon"]), "campus", label or "Mies Campus")
        return {"lat": None, "lon": None, "quality": "none", "place": label or "Off campus", "address": ""}

    def _from_notes(self, notes):
        for m in NOTES_CORNER_RE.finditer(notes or ""):
            point = self.intersection(m.group(1), m.group(2))
            if point:
                return point, f"{title(m.group(1))} & {title(m.group(2))}"
        for m in NOTES_ADDRESS_RE.finditer(notes or ""):
            point = self.address(int(m.group(1)), m.group(2), m.group(3))
            if point:
                return point, f"{m.group(1)} {m.group(2).upper()[0]} {title(m.group(3))}"
        return None, ""

    @staticmethod
    def _result(point, quality, place, address=""):
        return {"lat": point[0], "lon": point[1], "quality": quality, "place": place, "address": address}
