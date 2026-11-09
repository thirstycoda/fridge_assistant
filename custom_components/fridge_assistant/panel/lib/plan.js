/* Fridge Assistant — the Mealie meal plan, shared by the plan, shopping and
 * stock cards: fetching a week of it, which week is "this week", and turning
 * recipes and notes into ingredient lines. */

const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const AMOUNT_UNITS = [
  "kg", "g", "grams?", "ml", "l", "litres?", "tsp", "teaspoons?", "tbsp", "tablespoons?", "cups?",
  "tins?", "cans?", "jars?", "packs?", "handfuls?", "slices?", "pots?", "blocks?", "pieces?", "cloves?", "bunch(?:es)?",
];
const AMOUNT_RE = new RegExp(
  `^\\s*(half(?:\\s+an?)?(?=\\s)|an?(?=\\s)|\\d+\\s*/\\s*\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])\\s*`
  + `(?:(${AMOUNT_UNITS.join("|")})\\b\\.?\\s*)?(?:of\\s+)?(.+)$`, "i",
);
export function parseAmount(text) {
  const raw = String(text || "").trim();
  const m = AMOUNT_RE.exec(raw);
  if (!m || !m[3]) return { quantity: 1, unit: "each", food: raw, explicit: false };
  let q = m[1].toLowerCase().replace(",", ".");
  let quantity;
  if (q.startsWith("half")) quantity = 0.5;
  else if (q === "a" || q === "an") quantity = 1;
  else if (q.includes("/")) { const [a, b] = q.split("/").map(Number); quantity = b ? a / b : 1; }
  else {
    const frac = Object.keys(FRACTIONS).find((f) => q.includes(f));
    quantity = (parseFloat(q.replace(frac || "", "")) || 0) + (frac ? FRACTIONS[frac] : 0);
  }
  return { quantity: quantity || 1, unit: m[2] ? m[2].toLowerCase() : "each", food: m[3].trim(), explicit: true };
}

/* What a note on the plan (no recipe) is made of.
 *
 * A note with text is a small meal: the title names it ("Evie's breakfast")
 * and the text lists its ingredients, one per line, written like a recipe
 * line ("30 g oats", "½ banana", "1 tbsp peanut butter"). A note with only a
 * title is one loose ingredient ("Avocado", "40 g cannellini beans"), which
 * counts only in a breakfast, lunch or dinner slot (other notes there are
 * reminders, not food).
 *
 * Returns {items: [{quantity, unit, food, text}], unreadable: [text]}. A line
 * that reads like a dish rather than one thing ("Pumpkin, walnut and flaxseed
 * porridge"), or a longer name with no amount ("Red pepper sauce pasta"), is
 * unreadable: it can't be shopped for, so it's flagged instead of guessed at.
 * Without an amount, only a name of a word or two counts ("Blueberries"). */
export function noteItems(entry) {
  const items = [];
  const unreadable = [];
  if (!entry || entry.recipe) return { items, unreadable };
  const text = String(entry.description || "").trim();
  if (text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "").trim();
      if (!line) continue;
      const a = parseAmount(line);
      const words = a.food.split(/\s+/).filter(Boolean).length;
      // Without an amount only a short name is taken as one thing.
      const dishy = /[,·&+]|\b(?:with|and|on|in)\b/i.test(a.food) || words > (a.explicit ? 5 : 2);
      if (!a.food || (!a.explicit && dishy)) unreadable.push(line);
      else items.push({ ...a, text: line });
    }
  } else if (entry.title && ["breakfast", "lunch", "dinner"].includes(entry.entry_type)) {
    items.push({ ...parseAmount(entry.title), text: entry.title });
  }
  return { items, unreadable };
}

export const pad = (n) => String(n).padStart(2, "0");
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

let entryIdPromise = null;

export function mealieEntryId(hass, configured) {
  if (configured) return Promise.resolve(configured);
  if (!entryIdPromise) {
    entryIdPromise = hass.callWS({ type: "config_entries/get", domain: "mealie" })
      .then((entries) => {
        const e = (entries || []).find((x) => x.state === "loaded") || (entries || [])[0];
        if (!e) throw new Error("The Mealie integration isn't set up");
        return e.entry_id;
      })
      .catch((err) => { entryIdPromise = null; throw err; });
  }
  return entryIdPromise;
}

/* A plan for any range (the shopping list's week), not shared. */
export function fetchPlanRange(hass, configuredEntry, startISO, endISO) {
  return mealieEntryId(hass, configuredEntry).then((entry) => hass.callWS({
    type: "call_service", domain: "mealie", service: "get_mealplan",
    service_data: { config_entry_id: entry, start_date: startISO, end_date: endISO },
    return_response: true,
  })).then((res) => (res && res.response && res.response.mealplan) || []);
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/* The shopping week: weeks start on `weekStart`; from `planDay` on, the
 * coming week is shown (it's been planned), before that the current one. */
export function shoppingWeek(weekStart, planDay, offset = 0) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const ws = Math.max(0, WEEKDAYS.indexOf(String(weekStart).toLowerCase()));
  const pd = Math.max(0, WEEKDAYS.indexOf(String(planDay).toLowerCase()));
  const into = (today.getDay() - ws + 7) % 7;           // days since the week began
  let start = addDays(today, -into);
  if (into >= (pd - ws + 7) % 7 && (pd - ws + 7) % 7 !== 0) start = addDays(start, 7);
  start = addDays(start, offset * 7);
  return { start, end: addDays(start, 6), today };
}

export function recipeLines(recipe, source, date, ignore) {
  const out = [];
  for (const i of recipe.ingredients || []) {
    if (!i.food) continue;
    const food = String(i.food.name || "").toLowerCase();
    if (ignore.has(food)) continue;
    out.push({ food, quantity: i.quantity || 0, unit: i.unit ? i.unit.name : "", source, date,
      label: i.food.label ? i.food.label.name : null });
  }
  return out;
}

