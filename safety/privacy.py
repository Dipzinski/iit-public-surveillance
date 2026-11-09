"""What this site leaves out of the Public Safety log.

The log is public, but a searchable map makes it far easier to point at one
person. Reports about sexual offenses, stalking, partner violence, harassment,
suicide or a mental health crisis keep their date and type and lose their notes
and location. Room numbers come out of every other report's notes.
"""

import re

WITHHELD_NOTES = "Details are withheld on this site to protect the people involved."
WITHHELD_PLACE = "Location withheld"

_SENSITIVE_TYPE = re.compile(
    r"sex offense|sexual|stalking|dating violence|domestic violence|suicide|self.?harm"
    r"|indecent|harassment|voyeur|trafficking",
    re.I,
)
# A report filed as a medical call or a well-being check can still be about one of these.
_SENSITIVE_NOTES = re.compile(
    r"suicid|self.?harm|harm(?:ing)? (?:him|her|them)sel|\bsexual|\brape|overdos|\bmental(?:ly)?\b|psychiatr|psych eval",
    re.I,
)
_ROOM = re.compile(r"\b(?:room|rm\.?|apt\.?|apartment|suite|unit)\s*#?\s*\d+(?:[.-]?\w+)*", re.I)


def is_sensitive(incident_type, notes):
    return bool(_SENSITIVE_TYPE.search(incident_type or "") or _SENSITIVE_NOTES.search(notes or ""))


def scrub_notes(notes):
    return _ROOM.sub("[room withheld]", notes or "")
