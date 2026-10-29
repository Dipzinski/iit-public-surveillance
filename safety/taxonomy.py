"""Group the DPS log's ~150 raw incident types into a few families for charts and filters.

The order of FAMILIES is the order of the dashboard's categorical color palette,
so it must not be shuffled: colors follow the family, never its rank.
"""

import re

FAMILIES = [
    {"id": "medical", "label": "Medical"},
    {"id": "alarm", "label": "Alarms & fire"},
    {"id": "theft", "label": "Theft & fraud"},
    {"id": "traffic", "label": "Traffic"},
    {"id": "suspicious", "label": "Suspicious & trespass"},
    {"id": "conduct", "label": "Conduct & drugs"},
    {"id": "damage", "label": "Property damage"},
    {"id": "person", "label": "Crimes against persons"},
    {"id": "other", "label": "Service & other"},
]

# First match wins, so more specific patterns come first.
RULES = [
    ("traffic", r"ACCIDENT|MOTOR VEHICLE (?!THEFT)|TRAFFIC|PARKING|HIT AND RUN|VEHICLE (?:LOCKOUT|ASSIST)"),
    ("theft", r"THEFT|LARCENY|BURGLAR|FRAUD|FORGERY|DECEPTIVE|STOLEN|EMBEZZ|IDENTITY"),
    ("person", r"ROBBERY|BATTERY|ASSAULT|STALK|HARASS|SEX|RAPE|FONDL|INTIMIDAT|THREAT|DOMESTIC|KIDNAP|HOMICIDE|"
               r"DATING VIOLENCE|ARMED|WEAPON|SHOOT|GUN|STAB"),
    ("damage", r"DAMAGE|DEFAC|VANDAL|GRAFFITI|CRIMINAL MISCHIEF"),
    ("suspicious", r"SUSPICIOUS|TRESPASS|UNLAWFUL ENTRY|UNAUTHORIZED|SOLICIT|PROWL"),
    ("conduct", r"DRUG|NARCOTIC|CANNABIS|MARIJUANA|LIQUOR|ALCOHOL|INTOXICAT|CONDUCT|DISTURB|DISORDERLY|"
                r"NOISE|SMOK|GAMBL"),
    ("alarm", r"ALARM|FIRE|SMOKE|ODOR|GAS LEAK|EXPLOS"),
    ("medical", r"INJUR|SICK|MEDICAL|AMBULANCE|EMS|OVERDOSE|MENTAL|PSYCH|SUICID|WELFARE|HOSPITAL"),
]
_COMPILED = [(family, re.compile(pattern)) for family, pattern in RULES]


def family_of(raw_type):
    """'LARCENY/THEFT : FROM BUILDING' -> 'theft'."""
    text = (raw_type or "").upper()
    for family, pattern in _COMPILED:
        if pattern.search(text):
            return family
    return "other"
