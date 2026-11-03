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

    def test_spoons_of_a_spice_in_grams(self):
        spice = {"amount_unit": "g", "category": "sauces_spices", "name": "Ground cumin"}
        self.assertEqual(amounts.convert(1, "tsp", spice), 2.5)
        self.assertEqual(amounts.convert(1, "tsp", {**spice, "name": "Salt"}), 6)
        self.assertEqual(amounts.convert(1, "tbsp", {**spice, "density": 0.6}), 9)
        self.assertIsNone(amounts.convert(1, "tsp", {"amount_unit": "g", "category": "other"}))

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

    def test_explicit_amount_in_another_unit(self):
        self.store.upsert_user_template({"name": "Potatoes", "amount_unit": "g", "pack_amount": 2000, "per": {"each": 170}})
        self.assertEqual(self.add("Potatoes", amount=4, amount_unit="each")["amount"], 680)
        self.assertEqual(self.add("Plain flour", amount=0.2, amount_unit="kg")["amount"], 200)
        self.assertEqual(self.add("Plain flour", amount=300)["amount"], 300)                     # template unit
        self.assertEqual(self.add("Plain flour", amount=2, amount_unit="banana")["amount"], 1500)  # can't convert -> pack

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

    def test_recipe_matching_is_strict(self):
        self.store.upsert_user_template({"name": "Coriander", "aliases": ["fresh coriander"], "category": "vegetables"})
        self.store.upsert_user_template({"name": "Ultimate Chilli", "category": "dinner", "kind": "dish"})
        self.store.upsert_user_template({"name": "Chickpeas", "aliases": ["chick peas"], "category": "other"})
        self.store.upsert_user_template({"name": "Chickpea flour", "category": "other"})
        m = self.store.match_ingredient
        self.assertEqual(m("coriander")["name"], "Coriander")
        self.assertEqual(m("Fresh Coriander")["name"], "Coriander")
        self.assertIsNone(m("coriander seeds"))          # no containment
        self.assertIsNone(m("red chilli"))               # meals never match
        self.assertIsNone(m("ultimate chilli"))
        self.assertEqual(m("chickpea")["name"], "Chickpeas")   # plural folded
        self.assertEqual(m("chickpea flour")["name"], "Chickpea flour")

    def test_line_can_name_its_template(self):
        item = self.add("Plain flour", amount=500)
        self.store.consume_ingredients([{"food": "something odd", "template_id": self.flour["id"], "quantity": 100, "unit": "g"}])
        self.assertEqual(self.store.items[item["id"]]["amount"], 400)

    def test_backfill_older_items(self):
        item = self.add("Plain flour", quantity="2")
        for key in ("amount", "amount_initial", "amount_unit"):
            item.pop(key)
        loose = self.add("Dragon fruit")                    # no template
        self.assertEqual(self.store.backfill_amounts(), 1)
        self.assertEqual(item["amount"], 3000)
        self.assertEqual(item["amount_unit"], "g")
        self.assertNotIn("amount", loose)
        self.assertEqual(self.store.backfill_amounts(), 0)  # already done

    def test_setting_pack_size_backfills(self):
        plain = self.store.upsert_user_template({"name": "Rice vinegar", "category": "other"})
        item = self.add("Rice vinegar")
        self.assertNotIn("amount", item)
        self.store.upsert_user_template({"id": plain["id"], "name": "Rice vinegar", "amount_unit": "ml", "pack_amount": 150})
        self.assertEqual(item["amount"], 150)

    def test_linking_a_template_starts_tracking(self):
        item = self.add("Chia seeds", quantity="300 g")
        self.assertNotIn("amount", item)
        self.store.update_item(item["id"], {"template_id": self.flour["id"]})
        self.assertEqual(item["amount"], 300)                  # scanned size kept

    def test_template_keeps_amount_fields(self):
        tpl = self.store.upsert_user_template({"id": self.flour["id"], "name": "Plain flour", "notes": "x"})
        self.assertEqual(tpl["pack_amount"], 1500)
        self.assertEqual(tpl["per"], {"cup": 125})


class TestStockCheck(unittest.TestCase):
    def setUp(self):
        self.store = make_store()
        self.store.upsert_user_template({"name": "Plain flour", **FLOUR})
        self.store.upsert_user_template({"name": "Romano pepper", "aliases": ["romano peppers"],
                                         "amount_unit": "each", "pack_amount": 2, "per": {"g": 0.006}})
        self.store.upsert_user_template({"name": "Coconut water", "category": "drinks"})

    def add(self, name, **extra):
        return self.store.add_item(self.store.build_item({"name": name, "location": "cupboard", **extra}))

    def groups(self, lines):
        return {g["name"]: g for g in self.store.stock_check(lines)}

    def test_splits_need_and_have(self):
        self.add("Romano pepper", quantity="1", amount=1)
        g = self.groups([
            {"food": "romano pepper", "quantity": 1, "source": "Fajitas"},
            {"food": "romano peppers", "quantity": 1, "source": "Paella"},
        ])["Romano pepper"]
        self.assertEqual((g["need"], g["stock"], g["have"], g["short"]), (2, 1, 1, 1))
        self.assertEqual([s["source"] for s in g["sources"]], ["Fajitas", "Paella"])

    def test_sums_in_template_unit(self):
        self.add("Plain flour", amount=200)
        g = self.groups([
            {"food": "plain flour", "quantity": 1, "unit": "cup"},      # 125 g
            {"food": "plain flour", "quantity": 0.1, "unit": "kg"},     # 100 g
        ])["Plain flour"]
        self.assertEqual((g["need"], g["have"], g["short"]), (225, 200, 25))

    def test_untracked_and_unconvertible(self):
        res = self.groups([
            {"food": "ground cumin", "quantity": 1, "unit": "tsp", "source": "Chilli"},
            {"food": "ground cumin", "quantity": 2, "unit": "teaspoon", "source": "Daal"},
            {"food": "salt", "quantity": 0},
            {"food": "plain flour", "quantity": 1, "unit": "handful"},
        ])
        cumin = res["Ground cumin"]
        self.assertFalse(cumin["tracked"])
        self.assertEqual(cumin["other"], {"tsp": 3})
        self.assertTrue(res["Salt"]["to_taste"])
        self.assertEqual(res["Plain flour"]["other"], {"handful": 1})
        self.assertEqual(res["Plain flour"]["need"], 0)

    def test_template_without_amounts_reports_presence(self):
        self.add("Coconut water")
        g = self.groups([{"food": "coconut water", "quantity": 1}])["Coconut water"]
        self.assertTrue(g["in_stock"])
        self.assertIsNone(g["stock"])

    def test_nothing_changes(self):
        item = self.add("Plain flour", amount=200)
        self.store.stock_check([{"food": "plain flour", "quantity": 500, "unit": "g"}])
        self.assertEqual(self.store.items[item["id"]]["amount"], 200)

    def test_have_adds_stock_for_a_tracked_food(self):
        res = self.store.stock_have("romano peppers", 3, "each", "fridge")
        item = self.store.add_item(self.store.build_item(res["item"]))
        self.assertEqual((item["name"], item["location"], item["amount"]), ("Romano pepper", "fridge", 3))
        g = self.groups([{"food": "romano pepper", "quantity": 2}])["Romano pepper"]
        self.assertEqual((g["have"], g["short"]), (2, 0))

    def test_have_creates_a_spice(self):
        res = self.store.stock_have("smoked paprika", 30, "g", None, spoons=True)
        tpl = res["template"]
        self.assertEqual((tpl["category"], tpl["amount_unit"], tpl["pack_amount"]), ("sauces_spices", "g", 30))
        item = self.store.add_item(self.store.build_item(res["item"]))
        self.assertEqual((item["amount"], item["location"]), (30, "cupboard"))
        out = self.store.consume_ingredients([{"food": "smoked paprika", "quantity": 2, "unit": "tsp"}])
        self.assertEqual(out["lines"][0]["need"], 5)                 # 2 tsp ~ 5 g
        self.assertEqual(self.store.items[item["id"]]["amount"], 25)

    def test_have_starts_tracking_a_food_without_amounts(self):
        res = self.store.stock_have("coconut water", 1000, "ml")
        self.assertEqual(res["template"]["amount_unit"], "ml")
        self.assertEqual(res["template"]["pack_amount"], 1000)

    def test_check_reasons(self):
        flour = self.add("Plain flour")                          # usual pack size: a guess
        g = self.groups([{"food": "plain flour", "quantity": 200, "unit": "g", "date": "2026-11-06"}])["Plain flour"]
        self.assertEqual(g["check"], ["guessed"])
        self.store.update_item(flour["id"], {"amount": 1000})   # someone said how much
        g = self.groups([{"food": "plain flour", "quantity": 900, "unit": "g"}])["Plain flour"]
        self.assertEqual(g["check"], [])                          # checked this week wins
        flour["amount_checked_at"] = "2026-01-01T00:00:00+00:00"
        flour["created_at"] = "2026-01-01T00:00:00+00:00"
        flour["expiry_date"] = "2026-11-04"
        g = self.groups([{"food": "plain flour", "quantity": 900, "unit": "g", "date": "2026-11-06"}])["Plain flour"]
        self.assertEqual(g["check"], ["expires", "opened", "tight", "stale"])

    def test_everyday_and_untracked(self):
        self.store.upsert_user_template({"name": "Soy milk", "amount_unit": "ml", "pack_amount": 1000, "everyday": True})
        self.add("Soy milk", amount=1000)
        self.store.items[next(iter(self.store.items))]["amount_checked_at"] = "2026-01-01T00:00:00+00:00"
        self.assertIn("everyday", self.groups([{"food": "soy milk", "quantity": 100, "unit": "ml"}])["Soy milk"]["check"])
        self.add("Coconut water")
        self.assertEqual(self.groups([{"food": "coconut water", "quantity": 1}])["Coconut water"]["check"], ["untracked"])

    def test_confirm_stock(self):
        tpl = self.store.match_ingredient("plain flour")
        a = self.add("Plain flour", amount=300)
        b = self.add("Plain flour")                               # 1500, a guess
        res = self.store.confirm_stock(tpl["id"])                 # it's right
        self.assertEqual(res["stock"], 1800)
        self.assertTrue(all(i.get("amount_checked_at") for i in (a, b)))
        res = self.store.confirm_stock(tpl["id"], 1.0, "kg")      # less: opened pack goes first
        self.assertEqual(res["stock"], 1000)
        self.assertEqual(self.store.items[b["id"]]["amount"], 1000)
        res = self.store.confirm_stock(tpl["id"], 1200, "g")      # more: added to the fullest
        self.assertEqual(self.store.items[b["id"]]["amount"], 1200)

    def test_marks(self):
        self.store.set_shopping_mark("t:x", "added")
        self.store.set_shopping_mark("f:cumin", "have", sticky=True)
        self.assertEqual(set(self.store.shopping_marks_now()), {"t:x", "f:cumin"})
        self.store.shopping_marks["t:x"]["at"] = "2020-01-01T00:00:00+00:00"
        self.store.shopping_marks["f:cumin"]["at"] = "2020-01-01T00:00:00+00:00"
        self.assertEqual(set(self.store.shopping_marks_now()), {"f:cumin"})   # sticky survives
        self.store.set_shopping_mark("f:cumin", None)
        self.assertEqual(self.store.shopping_marks_now(), {})


if __name__ == "__main__":
    unittest.main()
