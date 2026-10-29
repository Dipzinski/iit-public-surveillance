"""Parse Illinois Tech Department of Public Safety log posts into structured incidents.

The log has been posted to a WordPress blog since 2014 and its markup changed
several times. This parser reads every era:

  2019–now   <p>Incident Type: …</p><p>Location: …</p><p>Date/Time Reported: …</p>
             <p>Notes: …</p><p>Disposition: …</p>
  2014–2018  Incident Type:ROBBERY (no space), then an unlabeled line that holds
             both the location and the time:
             "ILLINOIS INSTITUTE OF TECHNOLOGY : MAIN CAMPUS : TOWER – 6/23/2015 08:55 AM"
             Markup is <p>, or nested <div><span> pasted from another app.
  2011–2013  safety tips and announcements, with no incidents.

It works on text lines rather than tags: block-level tags become line breaks,
then each "Label: value" line is mapped to a field. An incident starts at every
"Incident Type:" line.
"""

import html
import re
from datetime import datetime

from common import CHICAGO_TZ, nice, title

PARSER_VERSION = 3

LABELS = {
    "incident type": "type",
    "location": "location",
    "date/time reported": "reported",
    "date reported": "reported",
    "time reported": "reported",
    "incident occurred between": "occurred",
    "date/time occurred": "occurred",
    "notes": "notes",
    "disposition": "disposition",
    "idisposition": "disposition",  # a typo that shows up in 2019–2020 posts
}
DATETIME_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2,4})\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?", re.I)
BLOCK_TAGS_RE = re.compile(r"(?i)<br\s*/?>|</(?:p|div|li|tr|td|h[1-6]|blockquote)>")
NO_INCIDENTS_RE = re.compile(r"no (?:reportable )?incidents|nothing to report|no activity to report", re.I)
DASH_RE = re.compile(r"\s+[–—-]\s+|\s*[–—]\s*")
# Sign-offs that follow the last incident; never treat them as wrapped notes.
CLOSING_RE = re.compile(r"^(thank you|thanks|regards|sincerely|respectfully|stay safe|be safe|"
                        r"department of public safety|illinois tech community|good morning|hello)\b", re.I)

CAMPUSES = (
    ("MIES", ("MIES CAMPUS", "MAIN CAMPUS")),
    ("KENT", ("KENT CAMPUS", "CONVISER", "DOWNTOWN CAMPUS", "565 W ADAMS")),
    ("RICE", ("RICE CAMPUS", "WHEATON")),
    ("MOFFETT", ("MOFFETT", "BEDFORD PARK")),
    ("OFF", ("OFF CAMPUS",)),
)


def text_lines(fragment):
    text = BLOCK_TAGS_RE.sub("\n", fragment or "")
    text = html.unescape(re.sub(r"<[^>]+>", "", text)).replace("\xa0", " ")
    return [" ".join(line.split()) for line in text.split("\n") if line.strip()]


def parse_datetime(text):
    """'10/23/2026 03:48 PM' -> aware datetime in Chicago, or None."""
    m = DATETIME_RE.search(text or "")
    if not m:
        return None
    month, day, year, hour, minute, ampm = m.groups()
    year = int(year) + (2000 if len(year) == 2 else 0)
    hour = int(hour) % 12 + (12 if ampm.upper() == "P" else 0)
    try:
        return datetime(year, int(month), int(day), hour, int(minute), tzinfo=CHICAGO_TZ)
    except ValueError:
        return None


def campus_of(location):
    upper = (location or "").upper()
    for code, needles in CAMPUSES:
        if any(n in upper for n in needles):
            return code
    return "UNKNOWN"


def split_location(location):
    """'ILLINOIS INSTITUTE OF TECHNOLOGY : MIES CAMPUS : RESIDENTIAL BUILDINGS : KACEK HALL – 3101 S WABASH'
    -> ('MIES', 'Residential Buildings', ['KACEK HALL', '3101 S WABASH'])"""
    parts = [p.strip(" -–—") for p in (location or "").split(":")]
    parts = [p for p in parts if p]
    campus = campus_of(location)
    if parts and parts[0].upper().startswith("ILLINOIS INSTITUTE"):
        parts = parts[1:]
    if parts and campus != "UNKNOWN" and any(n in parts[0].upper() for _, ns in CAMPUSES for n in ns):
        parts = parts[1:]  # drop the campus segment itself
    area = ""
    if len(parts) > 1:
        area, parts = parts[0], parts[1:]
    # Split "NAME – ADDRESS" (and "NAME-ADDRESS") into separate pieces.
    pieces = []
    for p in parts:
        pieces += [x.strip() for x in DASH_RE.split(p) if x.strip()]
    return campus, title(area), pieces


def parse_post(content_html):
    """Return (kind, incidents). kind is 'log', 'empty' (a log with no incidents) or 'other'."""
    incidents, current = [], None
    lines = text_lines(content_html)
    for line in lines:
        key, sep, value = line.partition(":")
        field = LABELS.get(key.strip().lower()) if sep else None
        if field == "type":
            current = {"raw_type": value.strip()}
            incidents.append(current)
            continue
        if current is None:
            continue
        if field:
            # Keep the first value; a stray second "Location:" shouldn't overwrite it.
            current.setdefault(field, value.strip())
            continue
        if line.upper().startswith("ILLINOIS INSTITUTE") and "location" not in current:
            m = DATETIME_RE.search(line)
            current["location"] = (line[: m.start()] if m else line).strip(" -–—:")
            if m:
                current.setdefault("reported", m.group(0))
        elif "notes" in current and not current.get("disposition") and not CLOSING_RE.match(line):
            # Notes sometimes wrap onto a second paragraph.
            current["notes"] = f"{current['notes']} {line}".strip()

    if not incidents:
        is_log = any(NO_INCIDENTS_RE.search(line) for line in lines)
        return ("empty" if is_log else "other"), []
    return "log", [_finish(raw) for raw in incidents]


def _finish(raw):
    location = raw.get("location", "")
    campus, area, pieces = split_location(location)
    reported = parse_datetime(raw.get("reported"))
    type_parts = [p.strip() for p in raw["raw_type"].split(":") if p.strip()]
    return {
        "raw_type": raw["raw_type"],
        "type": nice(raw["raw_type"]),
        "category": title(type_parts[0]) if type_parts else "Unknown",
        "campus": campus,
        "area": area,
        "pieces": pieces,
        "raw_location": location,
        "reported_at": reported.isoformat() if reported else None,
        "occurred": raw.get("occurred", ""),
        "notes": raw.get("notes", ""),
        "disposition": nice(raw.get("disposition")),
    }
