"""Barcode → product lookup via OpenFoodFacts (free, no API key).

Runs in Home Assistant Core (server side), so the panel never has to reach an
external host directly — avoids browser CORS/CSP limits entirely.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_CATEGORY, resolve_language

_LOGGER = logging.getLogger(__name__)

OFF_URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
_FIELDS = (
    "product_name,product_name_en,product_name_nl,generic_name_en,lang,brands,quantity,"
    "categories_tags,image_front_small_url"
)

# Map OpenFoodFacts category tags onto our own coarse categories.
_CATEGORY_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("milk", "dairy", "yogurt", "yoghurt", "cheese", "butter", "cream"), "dairy"),
    (("egg",), "eggs"),
    (("beverage", "soda", "water", "juice", "drink", "cola", "coffee", "tea"), "drinks"),
    (("meat", "poultry", "chicken", "beef", "pork", "sausage", "ham"), "meat"),
    (("fish", "seafood", "salmon", "tuna", "shrimp"), "fish"),
    (("vegetable", "legume"), "vegetables"),
    (("fruit",), "fruit"),
    (("bread", "bakery", "pastr"), "bread_bakery"),
    (("sauce", "condiment", "spread", "spice", "herb"), "sauces_spices"),
    (("meal", "pizza", "ready-made"), "dinner"),
]


def _category_from_tags(tags: list[str] | None) -> str:
    text = " ".join(tags or []).lower()
    for keys, category in _CATEGORY_KEYWORDS:
        if any(k in text for k in keys):
            return category
    return DEFAULT_CATEGORY


def pick_name(product: dict[str, Any], lang: str) -> str:
    """The product's name in Home Assistant's language where there is one.

    OpenFoodFacts' plain ``product_name`` is in whatever language the product
    was first entered in (German for many Alpro packs, Spanish for some
    Linwoods ones), so the language's own field comes first. The plain name
    counts as that language when the product's main language is it, and is
    only used otherwise when nothing better exists.
    """
    def get(key: str) -> str:
        return str(product.get(key) or "").strip()

    main = get("product_name")
    own_main = main if get("lang").lower() == lang else ""
    if lang == "nl":
        order = [get("product_name_nl"), own_main, get("product_name_en"), get("generic_name_en")]
    else:
        order = [get("product_name_en"), own_main, get("generic_name_en")]
    order += [main, get("product_name_nl"), get("brands").split(",")[0].strip()]
    return next((n for n in order if n), "")


def normalize_barcode(value: Any) -> str:
    """Keep only the digits of a scanned barcode."""
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def is_store_only(code: str) -> bool:
    """True for GS1 restricted-circulation numbers, which each shop assigns
    for itself (M&S packs carry 8-digit 00…/29… codes, weighed and loose
    goods 2… codes). The same number means a different product elsewhere,
    so a worldwide database can't say what it is: 29000906 is M&S spring
    onions but Trader Joe's tomato soup on OpenFoodFacts.
    """
    code = normalize_barcode(code)
    if len(code) == 8:
        return code[0] in "02"
    if len(code) == 12:   # UPC-A is EAN-13 with a leading 0
        code = "0" + code
    if len(code) == 13:
        return code[:2] in ("02", "04") or code[0] == "2"
    return False


async def async_lookup_barcode(
    hass: HomeAssistant, code: str
) -> dict[str, Any] | None:
    """Return product details for an EAN/UPC, or None if unknown/unreachable."""
    code = normalize_barcode(code)
    if not code or is_store_only(code):
        return None
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            OFF_URL.format(code=code),
            params={"fields": _FIELDS},
            timeout=aiohttp.ClientTimeout(total=12),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
    except Exception as err:  # noqa: BLE001 - lookup is best-effort
        _LOGGER.debug("OpenFoodFacts lookup failed for %s: %s", code, err)
        return None

    if data.get("status") != 1 or not isinstance(data.get("product"), dict):
        return None
    product = data["product"]
    name = pick_name(product, resolve_language(hass))
    if not name:
        return None
    return {
        "barcode": code,
        "name": name,
        "brand": (product.get("brands") or "").split(",")[0].strip(),
        "quantity": (product.get("quantity") or "").strip(),
        "category": _category_from_tags(product.get("categories_tags")),
        "photo": product.get("image_front_small_url") or "",
        "source": "openfoodfacts",
    }
