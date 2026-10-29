"""The DPS log parser must read every format the blog has used since 2014."""

import unittest
from pathlib import Path

from safety.parser import parse_datetime, parse_post, split_location
from safety.taxonomy import family_of

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return (FIXTURES / f"{name}.html").read_text()


class ParsePostTests(unittest.TestCase):
    def test_2015_main_campus_combined_location_and_time(self):
        kind, incidents = parse_post(load("2015_main_campus"))
        self.assertEqual(kind, "log")
        self.assertEqual(len(incidents), 4)
        first = incidents[0]
        self.assertEqual(first["type"], "Injured/Sick Person")
        self.assertEqual(first["campus"], "MIES")  # "MAIN CAMPUS" was the Mies campus's old name
        self.assertEqual(first["pieces"], ["Tower"])
        self.assertEqual(first["reported_at"], "2015-06-23T08:55:00-05:00")
        # The sign-off after the last incident must not leak into its notes.
        self.assertNotIn("Thank you", incidents[-1]["notes"])

    def test_2017_div_markup_and_unspaced_label(self):
        kind, incidents = parse_post(load("2017_div_markup"))
        self.assertEqual(kind, "log")
        self.assertEqual(len(incidents), 3)
        robbery = incidents[0]
        self.assertEqual(robbery["type"], "Robbery")
        self.assertEqual(robbery["disposition"], "Cleared – No Further Action")
        self.assertIn("31st & State", robbery["notes"])
        self.assertEqual(robbery["reported_at"], "2017-08-21T09:55:00-05:00")

    def test_2020_labeled_fields(self):
        kind, incidents = parse_post(load("2020_labeled"))
        self.assertEqual(kind, "log")
        self.assertEqual(len(incidents), 5)
        self.assertEqual(incidents[0]["type"], "Larceny/Theft – Bicycles")
        # The original post leaves out the date for the smoke alarm; that gap is kept, not invented.
        self.assertEqual([bool(i["reported_at"]) for i in incidents], [True, True, True, False, True])

    def test_2026_labeled_fields(self):
        kind, incidents = parse_post(load("2026_labeled"))
        self.assertEqual(kind, "log")
        self.assertEqual(len(incidents), 4)
        crash = incidents[0]
        self.assertEqual(crash["type"], "Accident – Motor Vehicle")
        self.assertEqual(crash["area"], "Street Locations")
        self.assertEqual(crash["pieces"], ["FEDERAL", "3200-3300 SOUTH"])
        self.assertEqual(crash["disposition"], "Police Notified")
        self.assertTrue(crash["notes"].startswith("A student reported"))

    def test_no_incidents_day_is_a_log(self):
        self.assertEqual(parse_post(load("2026_no_incidents")), ("empty", []))

    def test_safety_tip_is_not_a_log(self):
        self.assertEqual(parse_post(load("2012_safety_tip")), ("other", []))


class PieceTests(unittest.TestCase):
    def test_split_location_name_and_address(self):
        campus, area, pieces = split_location(
            "ILLINOIS INSTITUTE OF TECHNOLOGY : MIES CAMPUS : RESIDENTIAL BUILDINGS : KACEK HALL – 3101 S WABASH")
        self.assertEqual((campus, area, pieces), ("MIES", "Residential Buildings", ["KACEK HALL", "3101 S WABASH"]))

    def test_split_location_hyphen_hugging_address(self):
        _, _, pieces = split_location("ILLINOIS INSTITUTE OF TECHNOLOGY : MIES CAMPUS : ACADEMIC/ADMINISTRATIVE "
                                      "BUILDINGS : FARR HALL -3300 S MICHIGAN")
        self.assertEqual(pieces, ["FARR HALL", "3300 S MICHIGAN"])

    def test_other_campuses_are_recognized(self):
        self.assertEqual(split_location("ILLINOIS INSTITUTE OF TECHNOLOGY : KENT CAMPUS : LOBBY")[0], "KENT")
        self.assertEqual(split_location("ILLINOIS INSTITUTE OF TECHNOLOGY : OFF CAMPUS LOCATION")[0], "OFF")

    def test_parse_datetime_variants(self):
        self.assertEqual(parse_datetime("10/23/2026 03:48 PM").isoformat(), "2026-10-23T15:48:00-05:00")
        self.assertEqual(parse_datetime("6/23/2015 12:05 AM").hour, 0)
        self.assertIsNone(parse_datetime("sometime last week"))

    def test_families(self):
        self.assertEqual(family_of("LARCENY/THEFT : FROM BUILDING"), "theft")
        self.assertEqual(family_of("ACCIDENT : MOTOR VEHICLE"), "traffic")
        self.assertEqual(family_of("MOTOR VEHICLE THEFT"), "theft")
        self.assertEqual(family_of("ALARM : FIRE"), "alarm")
        self.assertEqual(family_of("INJURED/SICK PERSON"), "medical")
        self.assertEqual(family_of("ROBBERY : STRONG-ARM"), "person")
        self.assertEqual(family_of("UTILITY INCIDENT"), "other")


if __name__ == "__main__":
    unittest.main()
