"""Neighborhood add-on feeds around the watched site (see data/site.json).
The Public Safety log itself lives in the safety/ package.

Each feed is pulled from an official public source, trimmed to the area around
the site, summarized for the dashboard, and cached so a page full of panels
doesn't hammer the upstream APIs.

    crime()       Chicago Police Department crime reports (City of Chicago Data Portal)
    traffic()     live IDOT roadway incidents + City of Chicago traffic crash reports
    alerts()      National Weather Service alerts + City of Chicago 311 service requests
    chicago_*()   citywide police reports, injury crashes and live traffic for the main map
"""

import math
import re
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from common import (
    CENTER, CHICAGO_TZ, FETCH_ERRORS, METERS_PER_MILE, SITE,
    chicago_now, fetch_json, miles_from_center, nice, title,
)
from safety.taxonomy import family_of

CHICAGO_DATA = "https://data.cityofchicago.org/resource"
CRIMES = f"{CHICAGO_DATA}/ijzp-q8t2.json"
CRASHES = f"{CHICAGO_DATA}/85ca-t3if.json"
SERVICE_REQUESTS = f"{CHICAGO_DATA}/v6vf-nfxy.json"
IDOT_INCIDENTS = (
    "https://services2.arcgis.com/aIrBD8yn1TDTEXoz/ArcGIS/rest/services/"
    "Illinois_Roadway_Incidents/FeatureServer/0/query"
)
NWS_ALERTS = "https://api.weather.gov/alerts/active"


# --- helpers -----------------------------------------------------------------

def socrata_time(value):
    """The city's datasets store naive Chicago local times like 2026-10-19T20:40:00.000."""
    return datetime.fromisoformat(value[:19]).replace(tzinfo=CHICAGO_TZ)


def socrata_where(radius_mi, time_field, since):
    radius_m = round(radius_mi * METERS_PER_MILE)
    return (
        f"within_circle(location,{CENTER['lat']},{CENTER['lon']},{radius_m}) "
        f"AND {time_field} > '{since:%Y-%m-%dT%H:%M:%S}'"
    )


def block(text):
    """Police reports hide exact addresses: '037XX S CALUMET AVE' -> '3700 block of S Calumet Ave'."""
    m = re.match(r"^(\d*?)(X+)\s+(.*)$", (text or "").strip())
    if not m:
        return title(text)
    number = int(m.group(1) or 0) * 10 ** len(m.group(2))
    return f"{number} block of {title(m.group(3))}"


def by_hour(times):
    hours = [0] * 24
    for t in times:
        hours[t.hour] += 1
    return hours


def top_counts(values, limit):
    counts = Counter(values).most_common()
    top = [{"label": label, "count": n} for label, n in counts[:limit]]
    rest = sum(n for _, n in counts[limit:])
    if rest:
        top.append({"label": "Other", "count": rest})
    return top


def point(lat, lon):
    try:
        return round(float(lat), 6), round(float(lon), 6)
    except (TypeError, ValueError):
        return None


FAILED_RETRY_SECONDS = 60


class Cache:
    """Per-key TTL cache. On a failed refresh it keeps serving the last good copy."""

    def __init__(self):
        self._entries = {}
        self._locks = {}
        self._guard = threading.Lock()

    def get(self, key, ttl, loader):
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            entry = self._entries.get(key)
            # A source that has never answered gets retried soon; good data lasts its full TTL.
            wait = ttl if entry and entry["data"] is not None else FAILED_RETRY_SECONDS
            if entry and time.time() - entry["at"] < wait:
                return entry
            try:
                entry = {"at": time.time(), "data": loader(), "error": None}
            except FETCH_ERRORS as exc:
                if not entry:
                    entry = {"at": time.time(), "data": None, "error": str(exc)}
                else:
                    entry = {**entry, "at": time.time(), "error": str(exc)}
            self._entries[key] = entry
            return entry


CACHE = Cache()


def cached(key, ttl, loader):
    entry = CACHE.get(key, ttl, loader)
    if entry["data"] is None:
        return {"error": f"{key} unavailable: {entry['error']}"}
    return {
        **entry["data"],
        "fetchedAt": datetime.fromtimestamp(entry["at"], timezone.utc).isoformat(),
        "stale": entry["error"] is not None,
    }


# --- Chicago Police crime reports ----------------------------------------------

def _load_crime():
    # The city publishes reports about a week late, so look back far enough to
    # cover a full 30 days ending at the newest report.
    rows = fetch_json(CRIMES, {
        "$select": "id,date,primary_type,description,block,location_description,arrest,latitude,longitude",
        "$where": socrata_where(SITE["watchRadiusMi"], "date", chicago_now() - timedelta(days=45)),
        "$order": "date DESC",
        "$limit": "3000",
    })
    if not rows:
        return {"windowDays": 30, "latest": None, "total": 0, "byType": [], "byHour": [0] * 24, "recent": [], "points": []}

    latest = socrata_time(rows[0]["date"])
    start = latest - timedelta(days=30)
    reports = []
    for row in rows:
        when = socrata_time(row["date"])
        if when <= start:
            continue
        reports.append({
            "id": row.get("id"),
            "when": when,
            "type": title(row.get("primary_type") or "Unknown"),
            "description": (row.get("description") or "").capitalize(),
            "block": block(row.get("block")),
            "place": (row.get("location_description") or "").capitalize(),
            "arrest": bool(row.get("arrest")),
            "point": point(row.get("latitude"), row.get("longitude")),
        })

    def public(r):
        return {**{k: v for k, v in r.items() if k not in ("when", "point")}, "date": r["when"].isoformat(),
                "lat": r["point"][0] if r["point"] else None, "lon": r["point"][1] if r["point"] else None}

    return {
        "source": "Chicago Police Department via City of Chicago Data Portal",
        "sourceUrl": "https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-Present/ijzp-q8t2",
        "radiusMi": SITE["watchRadiusMi"],
        "windowDays": 30,
        "windowStart": start.isoformat(),
        "latest": latest.isoformat(),
        "total": len(reports),
        "arrests": sum(r["arrest"] for r in reports),
        "byType": top_counts([r["type"] for r in reports], 6),
        "byHour": by_hour(r["when"] for r in reports),
        "recent": [public(r) for r in reports[:12]],
        "points": [public(r) for r in reports if r["point"]],
    }


def crime():
    return cached("crime", 30 * 60, _load_crime)


# --- Traffic: live IDOT incidents + city crash reports ----------------------

INCIDENT_KINDS = {
    "CONGESTION": "Congestion",
    "ACCIDENT": "Crash",
    "ROAD_CLOSURE": "Closure",
    "CONSTRUCTION": "Construction",
    "PLANNED EVENT": "Event",
    "DISABLED_VEHICLE": "Disabled vehicle",
    "ROAD_HAZARD": "Hazard",
    "WEATHER": "Weather",
}


def _epoch_ms(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).astimezone(CHICAGO_TZ) if value else None


def _load_live_traffic():
    area = SITE["trafficAreaMi"]
    dlat = area / 69.05
    dlon = area / (69.05 * math.cos(math.radians(CENTER["lat"])))
    box = (CENTER["lon"] - dlon, CENTER["lat"] - dlat, CENTER["lon"] + dlon, CENTER["lat"] + dlat)
    return {
        "source": "Illinois DOT roadway incidents",
        "sourceUrl": "https://www.gettingaroundillinois.com/",
        "areaMi": area,
        "incidents": _idot_incidents(box, area),
    }


def _idot_incidents(box, area=None):
    """Active IDOT incidents inside a (west, south, east, north) box, optionally within `area` miles of campus."""
    payload = fetch_json(IDOT_INCIDENTS, {
        "where": "1=1",
        "geometry": ",".join(str(v) for v in box),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "TRAFFIC_ITEM_TYPE_DESC,START_TIME,END_TIME,CRITICALITY_DESC,ROAD_CLOSED,"
                     "LOCATION_DEFINED_ORIGIN_RDWY,TRAFFIC_ITEM_DESCRIPTION",
        "returnGeometry": "true",
        "resultRecordCount": "2000",
        "f": "json",
    })
    if "error" in payload:
        raise ValueError(payload["error"].get("message", "IDOT incident layer error"))

    now = chicago_now()
    incidents = []
    for feature in payload.get("features", []):
        a, geom = feature.get("attributes", {}), feature.get("geometry") or {}
        start, end = _epoch_ms(a.get("START_TIME")), _epoch_ms(a.get("END_TIME"))
        if geom.get("y") is None or (start and start > now) or (end and end < now):
            continue
        distance = miles_from_center(geom["y"], geom["x"])
        if area is not None and distance > area:
            continue
        incidents.append({
            "kind": INCIDENT_KINDS.get(a.get("TRAFFIC_ITEM_TYPE_DESC"), nice(a.get("TRAFFIC_ITEM_TYPE_DESC")) or "Incident"),
            "road": a.get("LOCATION_DEFINED_ORIGIN_RDWY") or "",
            "description": a.get("TRAFFIC_ITEM_DESCRIPTION") or "",
            "critical": a.get("CRITICALITY_DESC") == "critical",
            "closed": str(a.get("ROAD_CLOSED")).lower() == "true",
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            # Multi-week construction and closures are context, not news.
            "longTerm": bool(start and end and end - start > timedelta(days=7)),
            "lat": round(geom["y"], 6),
            "lon": round(geom["x"], 6),
            "distanceMi": round(distance, 2),
        })
    incidents.sort(key=lambda i: (i["longTerm"], not i["critical"], i["distanceMi"]))
    return incidents


def _load_crashes():
    rows = fetch_json(CRASHES, {
        "$select": "crash_date,street_no,street_direction,street_name,first_crash_type,"
                   "injuries_total,most_severe_injury,hit_and_run_i,latitude,longitude",
        "$where": socrata_where(SITE["watchRadiusMi"], "crash_date", chicago_now() - timedelta(days=90)),
        "$order": "crash_date DESC",
        "$limit": "3000",
    })
    crashes = []
    for row in rows:
        when = socrata_time(row["crash_date"])
        street = " ".join(filter(None, [row.get("street_direction"), title(row.get("street_name"))]))
        crashes.append({
            "when": when,
            "date": when.isoformat(),
            "street": street,
            "address": " ".join(filter(None, [row.get("street_no"), street])),
            "type": (row.get("first_crash_type") or "").capitalize(),
            "injuries": int(float(row.get("injuries_total") or 0)),
            "hitAndRun": row.get("hit_and_run_i") == "Y",
            "point": point(row.get("latitude"), row.get("longitude")),
        })

    recent_cutoff = chicago_now() - timedelta(days=30)

    def public(c):
        return {**{k: v for k, v in c.items() if k not in ("when", "point")},
                "lat": c["point"][0] if c["point"] else None, "lon": c["point"][1] if c["point"] else None}

    return {
        "source": "Chicago Police crash reports via City of Chicago Data Portal",
        "sourceUrl": "https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if",
        "radiusMi": SITE["watchRadiusMi"],
        "windowDays": 90,
        "total": len(crashes),
        "withInjuries": sum(1 for c in crashes if c["injuries"]),
        "hitAndRun": sum(1 for c in crashes if c["hitAndRun"]),
        "byHour": by_hour(c["when"] for c in crashes),
        "topStreets": top_counts([c["street"] for c in crashes if c["street"]], 4),
        "recent": [public(c) for c in crashes[:6]],
        "points": [public(c) for c in crashes if c["point"] and c["when"] >= recent_cutoff],
    }


def traffic():
    return {
        "live": cached("live-traffic", 2 * 60, _load_live_traffic),
        "crashes": cached("crashes", 60 * 60, _load_crashes),
    }


# --- Alerts: weather warnings (outdoor sirens) + 311 requests ---------------

SEVERITY_ORDER = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}


def _load_weather():
    payload = fetch_json(NWS_ALERTS, {"point": f"{CENTER['lat']},{CENTER['lon']}"}, accept="application/geo+json")
    alerts = []
    for feature in payload.get("features", []):
        p = feature.get("properties", {})
        alerts.append({
            "event": p.get("event", "Alert"),
            "headline": p.get("headline", ""),
            "severity": p.get("severity", "Unknown"),
            "urgency": p.get("urgency", ""),
            "effective": p.get("effective"),
            "expires": p.get("expires"),
            "description": p.get("description", ""),
            "instruction": p.get("instruction", ""),
            "sender": p.get("senderName", ""),
        })
    alerts.sort(key=lambda a: SEVERITY_ORDER.get(a["severity"], 9))
    return {"source": "National Weather Service", "sourceUrl": "https://www.weather.gov/lot/", "alerts": alerts}


def _load_service_requests():
    rows = fetch_json(SERVICE_REQUESTS, {
        "$select": "sr_number,sr_type,status,created_date,street_address,owner_department,duplicate,latitude,longitude",
        "$where": socrata_where(SITE["watchRadiusMi"], "created_date", chicago_now() - timedelta(days=7)),
        "$order": "created_date DESC",
        "$limit": "1000",
    })
    requests = [
        {
            "id": r.get("sr_number"),
            "type": r.get("sr_type", ""),
            "status": title(r.get("status")),
            "created": socrata_time(r["created_date"]).isoformat(),
            "address": title(r.get("street_address")),
            "department": (r.get("owner_department") or "").split(" - ")[-1],
            "lat": point(r.get("latitude"), r.get("longitude"))[0] if point(r.get("latitude"), r.get("longitude")) else None,
            "lon": point(r.get("latitude"), r.get("longitude"))[1] if point(r.get("latitude"), r.get("longitude")) else None,
        }
        for r in rows
        if not r.get("duplicate") and "information only" not in (r.get("sr_type") or "").lower()
    ]
    return {
        "source": "City of Chicago 311 service requests",
        "sourceUrl": "https://data.cityofchicago.org/Service-Requests/311-Service-Requests/v6vf-nfxy",
        "radiusMi": SITE["watchRadiusMi"],
        "windowDays": 7,
        "total": len(requests),
        "open": sum(1 for r in requests if r["status"] == "Open"),
        "byType": top_counts([r["type"] for r in requests], 4),
        "recent": requests[:15],
    }


def alerts():
    return {
        "weather": cached("weather", 2 * 60, _load_weather),
        "requests": cached("311", 5 * 60, _load_service_requests),
    }


# --- Chicago-wide activity for the main map and feed ---------------------------

CHICAGO_BOX = (-87.95, 41.63, -87.50, 42.03)
COMMUNITY_AREAS = (
    "", "Rogers Park", "West Ridge", "Uptown", "Lincoln Square", "North Center", "Lake View", "Lincoln Park",
    "Near North Side", "Edison Park", "Norwood Park", "Jefferson Park", "Forest Glen", "North Park", "Albany Park",
    "Portage Park", "Irving Park", "Dunning", "Montclare", "Belmont Cragin", "Hermosa", "Avondale", "Logan Square",
    "Humboldt Park", "West Town", "Austin", "West Garfield Park", "East Garfield Park", "Near West Side",
    "North Lawndale", "South Lawndale", "Lower West Side", "Loop", "Near South Side", "Armour Square", "Douglas",
    "Oakland", "Fuller Park", "Grand Boulevard", "Kenwood", "Washington Park", "Hyde Park", "Woodlawn", "South Shore",
    "Chatham", "Avalon Park", "South Chicago", "Burnside", "Calumet Heights", "Roseland", "Pullman", "South Deering",
    "East Side", "West Pullman", "Riverdale", "Hegewisch", "Garfield Ridge", "Archer Heights", "Brighton Park",
    "McKinley Park", "Bridgeport", "New City", "West Elsdon", "Gage Park", "Clearing", "West Lawn", "Chicago Lawn",
    "West Englewood", "Englewood", "Greater Grand Crossing", "Ashburn", "Auburn Gresham", "Beverly",
    "Washington Heights", "Mount Greenwood", "Morgan Park", "O'Hare", "Edgewater",
)
# Published by the city at block level, but not something to push out one by one in a live-style feed.
WITHHELD_POLICE_TYPES = {
    "CRIMINAL SEXUAL ASSAULT", "CRIM SEXUAL ASSAULT", "SEX OFFENSE", "OFFENSE INVOLVING CHILDREN",
    "HUMAN TRAFFICKING", "STALKING",
}


def community_name(number):
    try:
        return COMMUNITY_AREAS[int(number)]
    except (TypeError, ValueError, IndexError):
        return ""


def police_report(row):
    """One city crime row as a feed item, or None if it shouldn't be listed individually."""
    primary = (row.get("primary_type") or "").upper()
    spot = point(row.get("latitude"), row.get("longitude"))
    if not spot or row.get("domestic") or primary in WITHHELD_POLICE_TYPES:
        return None
    return {
        "id": row.get("id"),
        "when": socrata_time(row["date"]).isoformat(),
        "type": title(primary),
        "detail": (row.get("description") or "").capitalize(),
        "block": block(row.get("block")),
        "setting": (row.get("location_description") or "").capitalize(),
        "area": community_name(row.get("community_area")),
        "arrest": bool(row.get("arrest")),
        "family": family_of(primary),
        "lat": spot[0],
        "lon": spot[1],
    }


def _load_city_police():
    rows = fetch_json(CRIMES, {
        "$select": "id,date,primary_type,description,block,location_description,arrest,domestic,community_area,latitude,longitude",
        "$where": f"date > '{chicago_now() - timedelta(days=21):%Y-%m-%dT%H:%M:%S}' AND latitude IS NOT NULL",
        "$order": "date DESC",
        "$limit": "9000",
    }, timeout=90)
    latest = socrata_time(rows[0]["date"]) if rows else None
    items = []
    for row in rows:
        if socrata_time(row["date"]) <= latest - timedelta(days=7):
            break
        item = police_report(row)
        if item:
            items.append(item)
    return {
        "source": "Chicago Police Department via City of Chicago Data Portal",
        "sourceUrl": "https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-Present/ijzp-q8t2",
        "windowDays": 7,
        "latest": latest.isoformat() if latest else None,
        "items": items,
    }


def _load_city_crashes():
    rows = fetch_json(CRASHES, {
        "$select": "crash_record_id,crash_date,street_no,street_direction,street_name,first_crash_type,injuries_total,"
                   "injuries_fatal,hit_and_run_i,latitude,longitude",
        "$where": f"crash_date > '{chicago_now() - timedelta(days=4):%Y-%m-%dT%H:%M:%S}' AND injuries_total > 0 AND latitude IS NOT NULL",
        "$order": "crash_date DESC",
        "$limit": "1500",
    }, timeout=60)
    items = []
    for row in rows:
        spot = point(row.get("latitude"), row.get("longitude"))
        if not spot:
            continue
        street = " ".join(filter(None, [row.get("street_no"), row.get("street_direction"), title(row.get("street_name"))]))
        items.append({
            "id": row.get("crash_record_id"),
            "when": socrata_time(row["crash_date"]).isoformat(),
            "type": (row.get("first_crash_type") or "Crash").capitalize(),
            "address": street,
            "injuries": int(float(row.get("injuries_total") or 0)),
            "fatal": int(float(row.get("injuries_fatal") or 0)),
            "hitAndRun": row.get("hit_and_run_i") == "Y",
            "lat": spot[0],
            "lon": spot[1],
        })
    return {
        "source": "Chicago Police crash reports via City of Chicago Data Portal",
        "sourceUrl": "https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if",
        "windowDays": 4,
        "items": items,
    }


def _load_city_traffic():
    return {
        "source": "Illinois DOT roadway incidents",
        "sourceUrl": "https://www.gettingaroundillinois.com/",
        "items": [i for i in _idot_incidents(CHICAGO_BOX) if not i["longTerm"]],
    }


def chicago_police():
    return cached("city-police", 30 * 60, _load_city_police)


def chicago_crashes():
    return cached("city-crashes", 15 * 60, _load_city_crashes)


def chicago_traffic():
    return cached("city-traffic", 2 * 60, _load_city_traffic)


def site():
    return SITE
