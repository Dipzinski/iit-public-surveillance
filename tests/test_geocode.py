"""The geocoder places log locations using the street model in data/geo/streets.json."""

import unittest

from common import miles_between
from safety.geocode import Geocoder, place_title, street_key

# Reference points on the Chicago grid next to the Mies campus.
STATE_AND_33RD = (41.8346, -87.6269)
WABASH_AND_31ST = (41.8381, -87.6254)
FEDERAL_AND_33RD = (41.8346, -87.6291)


def incident(pieces, campus="MIES", notes=""):
    return {"pieces": pieces, "campus": campus, "notes": notes}


class GeocoderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.geo = Geocoder()

    def assertNear(self, point, expected, miles=0.08):
        self.assertIsNotNone(point)
        distance = miles_between(point[0], point[1], *expected)
        self.assertLess(distance, miles, f"{point} is {distance:.2f} mi from {expected}")

    def test_street_names_normalize(self):
        self.assertEqual(street_key("S WABASH AVE"), "WABASH")
        self.assertEqual(street_key("33RD STREET"), "33RD")
        self.assertEqual(street_key("South Wabash Avenue"), "WABASH")

    def test_address_on_north_south_street(self):
        self.assertNear(self.geo.address(3101, "S", "WABASH"), WABASH_AND_31ST)

    def test_address_on_east_west_street(self):
        # 55 W 34th is half a block west of State on 34th.
        point = self.geo.address(55, "W", "34TH")
        self.assertNear(point, (41.8328, -87.6280))

    def test_intersection_either_order(self):
        self.assertNear(self.geo.intersection("33RD", "STATE"), STATE_AND_33RD)
        self.assertNear(self.geo.intersection("STATE", "33RD"), STATE_AND_33RD)

    def test_locate_address(self):
        where = self.geo.locate(incident(["KACEK HALL", "3101 S WABASH"]))
        self.assertEqual((where["quality"], where["place"]), ("address", "Kacek Hall"))
        self.assertNear((where["lat"], where["lon"]), WABASH_AND_31ST)

    def test_locate_intersection(self):
        where = self.geo.locate(incident(["INTERSECTIONS", "33RD & FEDERAL"]))
        self.assertEqual(where["quality"], "intersection")
        self.assertNear((where["lat"], where["lon"]), FEDERAL_AND_33RD)

    def test_locate_block_range(self):
        where = self.geo.locate(incident(["FEDERAL", "3200-3300 SOUTH"]))
        self.assertEqual(where["quality"], "block")
        self.assertNear((where["lat"], where["lon"]), (41.8355, -87.6291), miles=0.1)

    def test_locate_truncated_building_name(self):
        where = self.geo.locate(incident(["MCCORMICK STUDENT"]))
        self.assertEqual(where["quality"], "building")

    def test_locate_from_notes_when_off_campus(self):
        where = self.geo.locate(incident([], campus="OFF", notes="Student robbed at 31st & State."))
        self.assertEqual(where["quality"], "notes")
        self.assertNear((where["lat"], where["lon"]), (41.8381, -87.6269))

    def test_unknown_off_campus_is_not_placed(self):
        where = self.geo.locate(incident([], campus="OFF", notes="Reported by phone."))
        self.assertEqual(where["quality"], "none")
        self.assertIsNone(where["lat"])

    def test_unknown_on_campus_falls_back_to_campus(self):
        self.assertEqual(self.geo.locate(incident(["ZONE 5"]))["quality"], "campus")

    def test_place_title_keeps_acronyms(self):
        self.assertEqual(place_title("RV MIDDLE"), "RV Middle")
        self.assertEqual(place_title("MTCC"), "MTCC")
        self.assertEqual(place_title("KACEK HALL"), "Kacek Hall")
        self.assertEqual(place_title("MCCORMICK TRIBUNE CAMPUS CENTER"), "McCormick Tribune Campus Center")


if __name__ == "__main__":
    unittest.main()
