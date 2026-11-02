"""Item amounts, unit conversion and taking recipe ingredients out of stock."""

import unittest

from tests.hastubs import fake_hass, load_module

amounts = load_module("amounts")
store_mod = load_module("store")

FLOUR = {"amount_unit": "g", "pack_amount": 1500, "per": {"cup": 125}}
MISO = {"amount_unit": "g", "pack_amount": 300, "per": {"tbsp": 18, "tsp": 6}}
GARLIC = {"amount_unit": "clove", "pack_amount": 10, "per": {"each": 10, "g": 0.2}}
SOY = {"amount_unit": "ml", "pack_amount": 1000}
CHICKPEAS = {"amount_unit": "g", "pack_amount": 400, "per": {"can": 400}}


def make_store():
    store = store_mod.FridgeStore(fake_hass("en"))
    store._seed = store._read_seed()
    store.hidden = set(store._seed)  # only our own templates, like the live setup
    return store


class TestUnits(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(amounts.normalize_unit("Tablespoons"), "tbsp")
        self.assertEqual(amounts.normalize_unit("T"), "tbsp")
        self.assertEqual(amounts.normalize_unit("t"), "tsp")
        self.assertEqual(amounts.normalize_unit("millilitre"), "ml")
        self.assertEqual(amounts.normalize_unit("tins"), "can")
        self.assertEqual(amounts.normalize_unit(None), "each")

    def test_metric_and_kitchen_units(self):
        self.assertEqual(amounts.convert(0.3, "kg", FLOUR), 300)
        self.assertEqual(amounts.convert(2, "cup", FLOUR), 250)          # template conversion
        self.assertEqual(amounts.convert(1.5, "tbsp", MISO), 27)
        self.assertEqual(amounts.convert(2, "tablespoon", SOY), 30)      # volume base
        self.assertEqual(amounts.convert(1, "l", SOY), 1000)
        self.assertEqual(amounts.convert(1, "tin", CHICKPEAS), 400)

    def test_count_units(self):
        self.assertEqual(amounts.convert(3, "cloves", GARLIC), 3)
        self.assertEqual(amounts.convert(1, None, GARLIC), 10)           # a whole bulb
        self.assertEqual(amounts.convert(10, "g", GARLIC), 2)            # via g -> clove

    def test_unknown_conversion_is_none(self):
        self.assertIsNone(amounts.convert(1, "cup", MISO))               # no density given
        self.assertIsNone(amounts.convert(1, "g", SOY))
        self.assertIsNone(amounts.convert(1, "g", {}))

    def test_initial_amount(self):
        self.assertEqual(amounts.initial_amount(FLOUR, "2"), 3000)       # two packs
        self.assertEqual(amounts.initial_amount(FLOUR, None), 1500)
        self.assertEqual(amounts.initial_amount(FLOUR, "500g"), 500)     # scanned size
        self.assertEqual(amounts.initial_amount(SOY, "1L"), 1000)
        self.assertEqual(amounts.initial_amount(CHICKPEAS, "4 x 400g"), 1600)
        self.assertIsNone(amounts.initial_amount({"amount_unit": "g"}, "1"))

    def test_format(self):
        self.assertEqual(amounts.format_amount(1250, "g"), "1.25 kg")
        self.assertEqual(amounts.format_amount(320, "g"), "320 g")
        self.assertEqual(amounts.format_amount(3, "clove"), "3 cloves")
        self.assertEqual(amounts.format_amount(1, "clove"), "1 clove")


class TestConsume(unittest.TestCase):
    def setUp(self):
        self.store = make_store()
        self.flour = self.store.upsert_user_template({"name": "Plain flour", **FLOUR, "shelf_life": {"pantry": 365}})
        self.miso = self.store.upsert_user_template({"name": "White miso", **MISO, "shelf_life": {"fridge": 180}})

    def add(self, name, location="cupboard", **extra):
        item = self.store.build_item({"name": name, "location": location, **extra})
        return self.store.add_item(item)

    def test_new_item_gets_pack_amount(self):
        item = self.add("Plain flour")
        self.assertEqual(item["amount"], 1500)
        self.assertEqual(item["amount_unit"], "g")
        self.assertEqual(self.add("Plain flour", quantity="2")["amount"], 3000)

    def test_takes_from_stock(self):
        item = self.add("Plain flour", amount=500)
        res = self.store.consume_ingredients([{"food": "plain flour", "quantity": 300, "unit": "gram"}])
        self.assertEqual(res["lines"][0]["status"], "taken")
        self.assertEqual(self.store.items[item["id"]]["amount"], 200)

    def test_opened_pack_first_then_soonest(self):
        full = self.add("Plain flour")
        opened = self.add("Plain flour")
        self.store.update_item(opened["id"], {"amount": 100})
        res = self.store.consume_ingredients([{"food": "plain flour", "quantity": 250, "unit": "g"}])
        taken = res["lines"][0]["taken"]
        self.assertEqual([t["id"] for t in taken], [opened["id"], full["id"]])
        self.assertNotIn(opened["id"], self.store.items)             # used up -> eaten
        self.assertEqual(self.store.items[full["id"]]["amount"], 1350)
        self.assertEqual(len(res["completed"]), 1)
        self.assertEqual(res["completed"][0]["action"], "eaten")

    def test_short_when_not_enough(self):
        self.add("Plain flour", amount=100)
        res = self.store.consume_ingredients([{"food": "plain flour", "quantity": 1, "unit": "cup"}])
        line = res["lines"][0]
        self.assertEqual(line["status"], "short")
        self.assertEqual(line["short"], 25)

    def test_factor_scales(self):
        item = self.add("White miso")
        self.store.consume_ingredients([{"food": "white miso", "quantity": 2, "unit": "tbsp"}], factor=0.5)
        self.assertEqual(self.store.items[item["id"]]["amount"], 282)

    def test_dry_run_changes_nothing(self):
        item = self.add("Plain flour", amount=500)
        res = self.store.consume_ingredients([{"food": "plain flour", "quantity": 500, "unit": "g"}], dry_run=True)
        self.assertTrue(res["lines"][0]["taken"][0]["used_up"])
        self.assertEqual(self.store.items[item["id"]]["amount"], 500)

    def test_statuses_for_lines_it_cannot_take(self):
        self.store.upsert_user_template({"name": "Soy sauce", **SOY})
        res = self.store.consume_ingredients([
            {"food": "dragon fruit", "quantity": 1},                  # no template
            {"food": "soy sauce", "quantity": 1, "unit": "tbsp"},     # nothing in stock
            {"food": "white miso", "quantity": 0},                    # no amount ("to taste")
            {"food": "plain flour", "quantity": 1, "unit": "pinch"},
            {"food": "white miso", "quantity": 1, "unit": "cup"},     # can't convert
        ])
        self.add("White miso")
        self.assertEqual([r["status"] for r in res["lines"]],
                         ["untracked", "not_in_stock", "not_in_stock", "not_in_stock", "not_in_stock"])
        res = self.store.consume_ingredients([
            {"food": "white miso", "quantity": 0},
            {"food": "white miso", "quantity": 1, "unit": "pinch"},
            {"food": "white miso", "quantity": 1, "unit": "cup"},
        ])
        self.assertEqual([r["status"] for r in res["lines"]], ["no_quantity", "negligible", "no_conversion"])

    def test_untracked_item_starts_as_full_pack(self):
        item = self.add("Plain flour")
        item.pop("amount"); item.pop("amount_initial"); item.pop("amount_unit")
        self.store.consume_ingredients([{"food": "plain flour", "quantity": 100, "unit": "g"}])
        self.assertEqual(self.store.items[item["id"]]["amount"], 1400)

    def test_template_keeps_amount_fields(self):
        tpl = self.store.upsert_user_template({"id": self.flour["id"], "name": "Plain flour", "notes": "x"})
        self.assertEqual(tpl["pack_amount"], 1500)
        self.assertEqual(tpl["per"], {"cup": 125})


if __name__ == "__main__":
    unittest.main()
