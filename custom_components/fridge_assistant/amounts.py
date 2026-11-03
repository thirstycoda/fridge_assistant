"""Amounts: how much of an item is left, and converting recipe quantities.

An item can carry a numeric ``amount`` in an ``amount_unit`` (``g``, ``ml``,
``each`` or any count word such as ``clove``). Its template says how big a
pack is (``pack_amount``) and how recipe units translate into its own unit
(``per``: ``{"tbsp": 18, "can": 400}`` means a tablespoon is 18 of the
template's unit and a can is 400). Metric units convert on their own; a
kitchen measure only converts through ``per``, or through the volume/weight
base it shares with the template's unit, so nothing is guessed.

Everything here is pure, so it can be tested without Home Assistant.
"""

from __future__ import annotations

import re
from typing import Any

# Canonical unit names, keyed by every spelling recipes (and Mealie) use.
_UNIT_ALIASES: dict[str, str] = {}
for _canon, _names in {
    "g": ("g", "gram", "grams", "gramme", "grammes", "gr"),
    "kg": ("kg", "kilogram", "kilograms", "kilo", "kilos"),
    "mg": ("mg", "milligram", "milligrams"),
    "ml": ("ml", "millilitre", "millilitres", "milliliter", "milliliters", "mls"),
    "l": ("l", "litre", "litres", "liter", "liters", "ltr"),
    "cl": ("cl", "centilitre", "centilitres", "centiliter"),
    "tsp": ("tsp", "teaspoon", "teaspoons", "tsps", "t"),
    "tbsp": ("tbsp", "tablespoon", "tablespoons", "tbsps", "tbs", "tbl", "tb", "T"),
    "cup": ("cup", "cups", "c"),
    "fl oz": ("fl oz", "fluid ounce", "fluid ounces", "floz"),
    "oz": ("oz", "ounce", "ounces"),
    "lb": ("lb", "lbs", "pound", "pounds"),
    "pinch": ("pinch", "pinches"),
    "dash": ("dash", "dashes"),
    "each": ("", "each", "whole", "piece", "pieces", "pc", "pcs", "x"),
    "clove": ("clove", "cloves"),
    "can": ("can", "cans", "tin", "tins"),
    "jar": ("jar", "jars"),
    "pack": ("pack", "packs", "packet", "packets"),
    "bag": ("bag", "bags"),
    "bottle": ("bottle", "bottles"),
    "block": ("block", "blocks"),
    "bunch": ("bunch", "bunches"),
    "head": ("head", "heads"),
    "handful": ("handful", "handfuls"),
    "slice": ("slice", "slices"),
    "stick": ("stick", "sticks", "stalk", "stalks"),
    "sprig": ("sprig", "sprigs"),
    "leaf": ("leaf", "leaves"),
    "portion": ("portion", "portions", "serving", "servings"),
    "cm": ("cm", "centimetre", "centimetres", "centimeter"),
}.items():
    for _name in _names:
        _UNIT_ALIASES[_name] = _canon

# Units that convert to a metric base on their own: unit -> (base, factor).
_METRIC: dict[str, tuple[str, float]] = {
    "g": ("g", 1.0), "kg": ("g", 1000.0), "mg": ("g", 0.001), "oz": ("g", 28.35), "lb": ("g", 453.6),
    "ml": ("ml", 1.0), "l": ("ml", 1000.0), "cl": ("ml", 10.0), "fl oz": ("ml", 28.41),
    "tsp": ("ml", 5.0), "tbsp": ("ml", 15.0), "cup": ("ml", 240.0),
}
# Too small to track: a pinch of salt never moves the inventory.
NEGLIGIBLE_UNITS = {"pinch", "dash"}
# Leftovers smaller than this share of a pack count as used up.
EMPTY_SHARE = 0.02


def normalize_unit(unit: str | None) -> str:
    """Canonical unit name ('' and unknown words pass through lower-cased)."""
    raw = (unit or "").strip().rstrip(".")
    if raw in _UNIT_ALIASES:  # case matters only for "T" (tablespoon)
        return _UNIT_ALIASES[raw]
    low = raw.lower()
    return _UNIT_ALIASES.get(low, low)


def convert(quantity: float, unit: str | None, template: dict[str, Any] | None) -> float | None:
    """``quantity`` of ``unit`` in the template's amount unit, or None if unknown."""
    if not template or not template.get("amount_unit"):
        return None
    target = normalize_unit(template["amount_unit"])
    per = {normalize_unit(k): float(v) for k, v in (template.get("per") or {}).items() if v}
    u = normalize_unit(unit)
    if u == target:
        return quantity
    if u in per:
        return quantity * per[u]
    if u in _METRIC:
        base, factor = _METRIC[u]
        amount = quantity * factor
        if base == target:
            return amount
        if target in _METRIC and _METRIC[target][0] == base:
            return amount / _METRIC[target][1]
        if base in per:  # e.g. g per ml (a density) or each per g
            return amount * per[base]
        # Spoons of something kept in grams (spices, mostly): approximate
        # through the template's density (g per ml), or a ground spice's.
        if base == "ml" and target in ("g", "kg"):
            density = template_density(template)
            if density:
                grams = amount * density
                return grams if target == "g" else grams / 1000
    return None


# A level teaspoon (5 ml) of ground spice weighs about 2.5 g. Denser things
# kept with the spices are listed so a spoon of them isn't under-counted.
SPICE_DENSITY = 0.5
_DENSITIES = (
    (("salt",), 1.2),
    (("sugar",), 0.85),
    (("baking powder", "bicarbonate", "baking soda", "cream of tartar"), 0.9),
    (("yeast",), 0.6),
    (("leaves", "dried herbs", "oregano", "thyme", "basil", "parsley", "rosemary", "mixed herbs"), 0.25),
)


def guess_density(name: str) -> float:
    """Grams per ml for a dry seasoning by its name (a ground spice by default)."""
    low = (name or "").lower()
    for words, density in _DENSITIES:
        if any(w in low for w in words):
            return density
    return SPICE_DENSITY


def template_density(template: dict[str, Any] | None) -> float | None:
    """Grams per ml: the template's own ``density``, else a spice's guess for
    seasonings (category ``sauces_spices``) kept in grams."""
    if not template:
        return None
    if template.get("density"):
        return float(template["density"])
    if template.get("category") == "sauces_spices":
        return guess_density(template.get("name", ""))
    return None


_QTY_RE = re.compile(r"^\s*(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*([a-zA-Z ]*?)\s*$")


def parse_quantity(text: str | None) -> tuple[float, str] | None:
    """'400 g' -> (400, 'g'); '2' -> (2, 'each'); '4 x 125g' -> (500, 'g')."""
    m = _QTY_RE.match(str(text or ""))
    if not m:
        return None
    mult = float(m.group(1)) if m.group(1) else 1.0
    return mult * float(m.group(2).replace(",", ".")), normalize_unit(m.group(3)) or "each"


def initial_amount(template: dict[str, Any] | None, quantity: str | None) -> float | None:
    """Starting amount for a new item, in the template's unit.

    A bare count ('2', or nothing) means that many packs; a measured
    quantity ('1.5 kg', from a scanned barcode) is converted directly.
    """
    if not template or not template.get("amount_unit"):
        return None
    parsed = parse_quantity(quantity) if quantity else (1.0, "each")
    if parsed is None:
        parsed = (1.0, "each")
    qty, unit = parsed
    if unit == "each" and normalize_unit(template["amount_unit"]) != "each":
        pack = template.get("pack_amount")
        return qty * float(pack) if pack else None
    if unit == "each" and template.get("pack_amount"):
        return qty * float(template["pack_amount"])
    return convert(qty, unit, template)


def format_amount(amount: float | None, unit: str | None) -> str:
    """Human-friendly '320 g', '1.2 kg', '3 cloves'."""
    if amount is None:
        return ""
    u = normalize_unit(unit)
    if u == "g" and amount >= 1000:
        return f"{amount / 1000:.3g} kg"
    if u == "ml" and amount >= 1000:
        return f"{amount / 1000:.3g} l"
    value = f"{amount:.0f}" if amount >= 10 or float(amount).is_integer() else f"{amount:.1f}"
    if u in ("each", ""):
        return value
    if u in ("g", "ml"):
        return f"{value} {u}"
    return f"{value} {u}{'' if amount == 1 else 's'}"
