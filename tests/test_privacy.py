"""Sensitive details must not reach the dataset the site publishes."""

import json
import unittest

from safety.dataset import build
from safety.privacy import WITHHELD_NOTES, WITHHELD_PLACE, is_sensitive, scrub_notes
from safety.taxonomy import FAMILIES


class FakeStore:
    def __init__(self, rows):
        self.rows = rows

    def incidents(self, campuses):
        return self.rows


def row(id_, type_, place, notes):
    return {
        "id": id_, "type": type_, "family": FAMILIES[0]["id"], "campus": "MIES", "place": place,
        "lat": 41.83, "lon": -87.62, "geo_quality": "building", "address": "3101 S Wabash", "area": "Housing",
        "notes": notes, "disposition": "Closed", "reported_at": "2026-01-05T10:00:00-06:00",
        "post_date": "2026-01-06T08:00:00", "post_id": 1, "post_link": "https://example.test/1", "post_title": "Log",
    }


class RuleTests(unittest.TestCase):
    def test_sensitive_types(self):
        for name in ("Stalking", "Sex Offenses – Sexual Assault", "Suicide – Attempted Suicide",
                     "Battery-Simple – Dating Violence", "Domestic Violence", "Harassment – Phone"):
            self.assertTrue(is_sensitive(name, ""), name)

    def test_sensitive_notes_in_ordinary_report_types(self):
        self.assertTrue(is_sensitive("Injured/Sick Person – Report Only", "A student reporting suicidal ideations"))
        self.assertTrue(is_sensitive("Injured/Sick Person", "transported for a mental health evaluation"))
        self.assertTrue(is_sensitive("Disturbance", "responded to a mentally unstable person"))

    def test_words_that_only_look_sensitive(self):
        self.assertFalse(is_sensitive("Fire", "during an experimental process; Environmental Health responded"))

    def test_room_numbers_come_out(self):
        for note in ("Carman Hall room 502 for a call", "LEAK FROM ROOM 2.2 NORTH", "5th floor room #503", "in room 1C7-1 at"):
            self.assertIn("[room withheld]", scrub_notes(note))
            self.assertNotRegex(scrub_notes(note), r"(?i)room #?\d")

    def test_scrubbing_leaves_other_numbers_and_punctuation(self):
        self.assertEqual(scrub_notes("CFD (ambulance #35) arrived."), "CFD (ambulance #35) arrived.")
        self.assertEqual(scrub_notes("In room 201."), "In [room withheld].")


class DatasetTests(unittest.TestCase):
    def test_withheld_report_keeps_type_and_loses_details(self):
        data = build(FakeStore([row(1, "Stalking", "Kacek Hall", "Reported being followed")]))
        place = data["places"][data["incidents"]["place"][0]]
        self.assertEqual(data["types"], ["Stalking"])
        self.assertEqual(data["incidents"]["notes"], [WITHHELD_NOTES])
        self.assertEqual((place["name"], place["lat"], place["address"]), (WITHHELD_PLACE, None, ""))
        published = json.dumps(data)
        self.assertNotIn("Kacek", published)
        self.assertNotIn("followed", published)
        self.assertNotIn("3101 S Wabash", published)

    def test_ordinary_report_keeps_details_without_the_room(self):
        data = build(FakeStore([row(1, "Alarm – Fire", "Kacek Hall", "Alarm in room 224")]))
        self.assertEqual(data["places"][0]["name"], "Kacek Hall")
        self.assertEqual(data["incidents"]["notes"], ["Alarm in [room withheld]"])


if __name__ == "__main__":
    unittest.main()
