/* Fridge Assistant — how foods look on the dashboard cards: supermarket
 * aisles (in the order you'd walk them) and an emoji per food. Shared by the
 * shopping list and unpack cards. */

/* Supermarket-style aisles, in the order you'd walk them, from Mealie's food
 * labels (else Fridge Assistant's category). */
export const AISLES = [
  { key: "fruit", name: "Fruit", emoji: "🍎", color: "#e57373",
    labels: ["Fruits", "Berries"], categories: ["fruit"] },
  { key: "veg", name: "Vegetables", emoji: "🥦", color: "#66bb6a",
    labels: ["Vegetables & Greens", "Mushrooms"], categories: ["vegetables"] },
  { key: "chilled", name: "Chilled & plant-based", emoji: "🧊", color: "#4fc3f7",
    labels: ["Dairy-Free & Meat Substitutes", "Dairy & Eggs", "Cheese"], categories: ["dairy", "eggs"] },
  { key: "ready", name: "Ready meals", emoji: "🍱", color: "#ba68c8",
    labels: [], categories: ["dinner", "lunch", "leftovers"] },
  { key: "bakery", name: "Bakery", emoji: "🍞", color: "#d7a86e",
    labels: ["Bread & Salty Snacks", "Bread & Salty Snackssta", "Pre-Made Doughs & Wrappers"], categories: ["bread_bakery"] },
  { key: "grains", name: "Pasta, rice & grains", emoji: "🍝", color: "#ffca28",
    labels: ["Pasta", "Grains & Cereals"], categories: ["breakfast"] },
  { key: "beans", name: "Beans & lentils", emoji: "🫘", color: "#a1887f", labels: ["Legumes"], categories: [] },
  { key: "tins", name: "Tins & jars", emoji: "🥫", color: "#ef6c00",
    labels: ["Canned Food", "Soups, Stews & stock"], categories: [] },
  { key: "sauces", name: "Sauces, oils & vinegars", emoji: "🫙", color: "#8d6e63",
    labels: ["Condiments", "Sauces, Spreads & dip", "Dressings & Vinegars", "Oils & Fats", "Wine, Beer & Spirits"], categories: [] },
  { key: "spices", name: "Herbs & spices", emoji: "🌿", color: "#9ccc65",
    labels: ["Herbs & Spices", "Seasonings & Spice Blends"], categories: ["sauces_spices"] },
  { key: "nuts", name: "Nuts & seeds", emoji: "🥜", color: "#bcaaa4", labels: ["Nuts & Seeds"], categories: [] },
  { key: "baking", name: "Baking & sweeteners", emoji: "🧁", color: "#f48fb1",
    labels: ["Baking", "Sugar & Sweeteners", "Desserts & Sweet Snacks", "Supplements & Extracts"], categories: ["snack"] },
  { key: "frozen", name: "Frozen", emoji: "❄️", color: "#90caf9", labels: [], categories: [] },
  { key: "drinks", name: "Drinks", emoji: "🥤", color: "#7986cb", labels: ["Beverages"], categories: ["drinks"] },
  { key: "baby", name: "Baby", emoji: "🍼", color: "#f8bbd0", labels: [], categories: [] },
  { key: "household", name: "Household", emoji: "🧻", color: "#b0bec5", labels: [], categories: [] },
  { key: "other", name: "Other", emoji: "🛒", color: "#9e9e9e", labels: [], categories: [] },
];
const AISLE_BY_LABEL = new Map(AISLES.flatMap((a) => a.labels.map((l) => [l.toLowerCase(), a])));
const AISLE_BY_CATEGORY = new Map(AISLES.flatMap((a) => a.categories.map((c) => [c, a])));
/* An emoji for a food by its name, when it has no photo or emoji of its own. */
const FOOD_EMOJI = [
  [/toilet|tissue|kitchen roll/, "🧻"], [/infant|baby|toddler|\b\d+\+ ?months/, "🍼"], [/juice|smoothie/, "🧃"], [/\boils?\b/, "🫒"],
  [/coconut milk/, "🥥"], [/\bmilk\b|\bdrink\b|\bcream\b|yoghurt|yogurt|little yeos/, "🥛"],
  [/salt/, "🧂"], [/garlic/, "🧄"], [/spring onion|leek/, "🌱"], [/onion|shallot/, "🧅"], [/carrot/, "🥕"],
  [/sweet potato/, "🍠"], [/potato/, "🥔"], [/tomato|passata/, "🍅"], [/chilli|jalape|harissa|sriracha|gochujang/, "🌶️"],
  [/pepper(?!corn)/, "🫑"], [/aubergine|eggplant/, "🍆"], [/cucumber|courgette/, "🥒"], [/broccoli|gai lan|tenderstem/, "🥦"],
  [/sweetcorn|corn|polenta/, "🌽"], [/mushroom|shiitake/, "🍄"], [/avocado/, "🥑"], [/spinach|kale|cabbage|lettuce|rocket|pak choi|chard/, "🥬"],
  [/lemon/, "🍋"], [/lime/, "🍋‍🟩"], [/banana/, "🍌"], [/apple/, "🍎"], [/pear/, "🍐"], [/mango/, "🥭"], [/pineapple/, "🍍"],
  [/kiwi/, "🥝"], [/blueberr|raspberr|strawberr|berry/, "🫐"], [/grape/, "🍇"], [/coconut/, "🥥"], [/\bdates?\b/, "🌴"],
  [/ginger/, "🫚"], [/pea\b|peas|edamame|green bean|mangetout/, "🫛"], [/bean|lentil|chickpea|split pea/, "🫘"],
  [/rice/, "🍚"], [/noodle|ramen|udon|soba/, "🍜"], [/pasta|spaghetti|macaroni|fusilli|lasagne|orzo/, "🍝"],
  [/bread|ciabatta|roll|wrap|tortilla|pastry|breadcrumb|panko/, "🍞"], [/flour|baking/, "🌾"], [/oat|cereal|quinoa|freekeh|grain/, "🌾"],
  [/peanut|cashew|almond|walnut|hazelnut|nut|seed|tahini/, "🥜"], [/milk|cream|yoghurt|yogurt/, "🥛"],
  [/cheese/, "🧀"], [/butter/, "🧈"], [/egg/, "🥚"], [/tofu|tempeh|seitan|soy curl/, "🧊"],
  [/vinegar|soy sauce|sauce|ketchup|mustard|mayo/, "🫙"], [/sugar|syrup|honey|agave/, "🍯"], [/vanilla|chocolate|cocoa/, "🍫"],
  [/wine|mirin|sake/, "🍶"], [/stock|bouillon|dashi|miso/, "🥣"], [/water/, "💧"],
  [/basil|oregano|thyme|parsley|rosemary|sage|mint|coriander|dill|chive|bay leaf|herb/, "🌿"],
];
export function foodEmoji(name) {
  const low = String(name || "").toLowerCase();
  const hit = FOOD_EMOJI.find(([re]) => re.test(low));
  return hit ? hit[1] : null;
}

/* When there's no label and the category says little ("other"), the name. */
const NAME_AISLE = [
  [/toilet|kitchen roll|tissue|washing|detergent|soap|bin bag|foil|cling|nappy|nappies|wipes/, "household"],
  [/baby|infant|kids'|little yeos|toddler|pouch|\b\d+\+ ?months/, "baby"],
  [/bean|lentil|chick ?pea|split pea/, "beans"],
  [/rice|pasta|spaghetti|noodle|oat|quinoa|couscous|grain|cereal|polenta|freekeh/, "grains"],
  [/cashew|almond|walnut|hazelnut|peanut(?! butter)|pecan|pistachio|seed/, "nuts"],
  [/passata|chopped tomato|tinned|canned|coconut milk|sweetcorn/, "tins"],
  [/flour|sugar|syrup|baking|yeast|cocoa|vanilla/, "baking"],
  [/sauce|oil|vinegar|ketchup|mustard|mayo|pesto|tahini|peanut butter|miso|paste/, "sauces"],
  [/juice|water|drink|cola|lemonade|squash/, "drinks"],
  [/frozen/, "frozen"],
];
const AISLE_BY_KEY = new Map(AISLES.map((a) => [a.key, a]));

/* The aisle for a group/line: ``{label, category, name}`` (any may be missing). */
export function aisleOf(g) {
  const byLabel = g.label && AISLE_BY_LABEL.get(String(g.label).toLowerCase());
  if (byLabel) return byLabel;
  const byCategory = g.category && g.category !== "other" && AISLE_BY_CATEGORY.get(g.category);
  if (byCategory) return byCategory;
  const name = String(g.name || "").toLowerCase();
  const hit = NAME_AISLE.find(([re]) => re.test(name));
  return (hit && AISLE_BY_KEY.get(hit[1])) || AISLE_BY_KEY.get("other");
}

