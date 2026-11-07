"""Picking a scanned product's name from OpenFoodFacts data."""

import unittest

from tests.hastubs import load_module

products = load_module("products")


class TestPickName(unittest.TestCase):
    def test_english_name_beats_foreign_main_name(self):
        p = {"product_name": "Fermentiertes Sojaprodukt, Ungesüßt", "lang": "de",
             "product_name_en": "Plain No Sugars Soya Yoghurt Alternative"}
        self.assertEqual(products.pick_name(p, "en"), "Plain No Sugars Soya Yoghurt Alternative")

    def test_main_name_used_when_it_is_english(self):
        p = {"product_name": "Shelled Hemp Seeds", "lang": "en", "generic_name_en": "Hemp seeds"}
        self.assertEqual(products.pick_name(p, "en"), "Shelled Hemp Seeds")

    def test_english_generic_name_beats_foreign_main_name(self):
        p = {"product_name": "Semillas de cáñamo", "lang": "es", "generic_name_en": "Shelled hemp seeds"}
        self.assertEqual(products.pick_name(p, "en"), "Shelled hemp seeds")

    def test_dutch_only_after_every_english_option(self):
        p = {"product_name_nl": "Sojadrink", "generic_name_en": "Soya drink", "brands": "Alpro, Danone"}
        self.assertEqual(products.pick_name(p, "en"), "Soya drink")

    def test_brand_when_there_is_no_name(self):
        self.assertEqual(products.pick_name({"brands": "Alpro, Danone"}, "en"), "Alpro")

    def test_foreign_main_name_is_the_last_resort(self):
        p = {"product_name": "Semillas de cáñamo", "lang": "es", "brands": "Linwoods"}
        self.assertEqual(products.pick_name(p, "en"), "Semillas de cáñamo")

    def test_dutch_first_in_dutch(self):
        p = {"product_name": "Soya drink", "lang": "en", "product_name_nl": "Sojadrink"}
        self.assertEqual(products.pick_name(p, "nl"), "Sojadrink")

    def test_nothing_at_all(self):
        self.assertEqual(products.pick_name({}, "en"), "")


class TestStoreOnly(unittest.TestCase):
    def test_shop_codes_are_store_only(self):
        # M&S spring onions, tofu, garlic, peas; a weighed red-onion code.
        for code in ["29000906", "00124485", "00283212", "29086566", "290834787844", "2012345678901", "0412345678905"]:
            self.assertTrue(products.is_store_only(code), code)

    def test_global_codes_are_not(self):
        # Alpro, Marigold (EAN-8 with a country prefix), a UPC-A, a German EAN.
        for code in ["5411188118121", "50160884", "628110454492", "4061462596162", "8005110001673"]:
            self.assertFalse(products.is_store_only(code), code)


if __name__ == "__main__":
    unittest.main()
