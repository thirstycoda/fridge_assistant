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


/* ---- meals from the freezer ------------------------------------------------
 *
 * A planned recipe can be cooked fresh or come from a cooked dish already in
 * the freezer (or fridge). The choice is kept on the meal's line on the
 * planned meals to-do list ({"mealplan_id", ..., "source": "fresh" |
 * "freezer"}), where the plan, shopping and stock cards all read it. With no
 * choice made, a meal comes from the freezer when there's a dish of it left
 * over after the meals picked "from the freezer" have had theirs,
 * otherwise it's cooked. "Freezer" can be picked without a dish in stock (it
 * just isn't tracked); there's then nothing to take out. One dish portion is
 * one meal; portions go to meals in date order. */

/* The planned meals to-do list's lines by mealplan_id: {uid, summary, info}. */
export function planRecords(todoItems) {
  const out = new Map();
  for (const t of todoItems || []) {
    let info;
    try { info = JSON.parse(t.description || "{}") || {}; } catch (e) { continue; }
    if (info.mealplan_id == null) continue;
    const key = String(info.mealplan_id);
    const prev = out.get(key);
    // A line with a "done" record wins over a stray duplicate.
    if (!prev || (info.done && !prev.info.done)) out.set(key, { uid: t.uid, summary: t.summary, status: t.status, info });
  }
  return out;
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/* A cooked dish in the freezer or fridge that is this recipe: named like it,
 * or labelled "From <recipe>" (when only part of it went in, e.g. the sauce). */
export function isDishOf(recipe, item) {
  if (!recipe || !item || item.kind !== "dish" || !["freezer", "fridge"].includes(item.location)) return false;
  const name = norm(recipe.name);
  return !!name && (norm(item.name) === name || norm(item.notes).includes(`from ${name}`));
}

export const openPortions = (item) => (Array.isArray(item.portions) && item.portions.length ? item.portions : [{ n: 1, status: "open" }])
  .filter((p) => p.status === "open").map((p) => p.n);

const TYPE_ORDER = { breakfast: 0, lunch: 1, dinner: 2 };

/* Where each planned recipe comes from: Map mealplan_id -> {source: "fresh" |
 * "freezer", choice, can (there's a dish of it in stock), dish, portion
 * (when the dish has several), left (portions of it left after this one),
 * missing (from the freezer, but no dish of it in stock), done}. Meals
 * before `todayIso` don't hold on to a portion. */
export function mealSources(entries, records, items, todayIso) {
  const dishes = (items || []).filter((i) => i.kind === "dish" && ["freezer", "fridge"].includes(i.location))
    .sort((a, b) => String(a.expiry_date || "9999").localeCompare(String(b.expiry_date || "9999"))
      || String(a.added_date || "").localeCompare(String(b.added_date || "")));
  const left = new Map(dishes.map((d) => [d.id, openPortions(d)]));
  const out = new Map();
  const meals = (entries || []).filter((e) => e.recipe).slice().sort((a, b) =>
    String(a.mealplan_date).localeCompare(String(b.mealplan_date))
    || (TYPE_ORDER[a.entry_type] ?? 3) - (TYPE_ORDER[b.entry_type] ?? 3));
  const infoOf = (e) => (records && records.get(String(e.mealplan_id)) && records.get(String(e.mealplan_id)).info) || {};
  const choiceOf = (info) => (info.source === "fresh" || info.source === "freezer" ? info.source : null);
  // Meals picked "from the freezer" get first go at its portions, then the
  // undecided ones (in date order each time).
  const pass = (wantChoice) => {
    for (const e of meals) {
      const id = String(e.mealplan_id);
      const info = infoOf(e);
      if (info.done || out.has(id) || (choiceOf(info) === "freezer") !== wantChoice) continue;
      const choice = choiceOf(info);
      const avail = dishes.filter((d) => isDishOf(e.recipe, d) && left.get(d.id).length);
      const base = { choice, can: avail.length > 0 };
      if (choice === "fresh" || (!avail.length && choice !== "freezer")) {
        out.set(id, { ...base, source: "fresh" });
        continue;
      }
      if (!avail.length) {
        out.set(id, { ...base, source: "freezer", missing: true });
        continue;
      }
      const dish = avail[0];
      const ports = left.get(dish.id);
      const portion = ports[0];
      if (String(e.mealplan_date) >= todayIso) ports.shift();
      out.set(id, {
        ...base, source: "freezer", dish,
        portion: (dish.portions || []).length > 1 ? portion : null,
        left: avail.reduce((n, d) => n + left.get(d.id).length, 0),
      });
    }
  };
  for (const e of meals) {
    const info = infoOf(e);
    if (info.done) out.set(String(e.mealplan_id), { source: info.done.from === "freezer" ? "freezer" : "fresh", done: true, choice: choiceOf(info), can: false });
  }
  pass(true);
  pass(false);
  return out;
}

/* Record "fresh" / "freezer" for a planned meal on its to-do line (adding the
 * line when the meal doesn't have one yet). */
export async function setMealSource(hass, todoEntity, entry, record, source) {
  const target = { entity_id: todoEntity };
  if (record) {
    await hass.callService("todo", "update_item",
      { item: record.uid, description: JSON.stringify({ ...record.info, source }) }, target);
    return;
  }
  const type = String(entry.entry_type || "meal");
  const name = entry.recipe ? entry.recipe.name : entry.title;
  await hass.callService("todo", "add_item", {
    item: `${type.charAt(0).toUpperCase()}${type.slice(1)}: ${name}`,
    description: JSON.stringify({
      mealplan_id: entry.mealplan_id, slug: entry.recipe ? entry.recipe.slug : null, name,
      entry_type: entry.entry_type || "", date: entry.mealplan_date, source,
    }),
  }, target);
}

/* Put a planned recipe in the freezer stock as a cooked dish (one portion,
 * one meal), for a meal marked "from the freezer" that isn't in stock. */
export function addFreezerDish(hass, recipe, photo) {
  return hass.callWS({
    type: "fridge_assistant/add_item",
    item: { name: recipe.name, contents: recipe.name, kind: "dish", location: "freezer", portions: 1, photo: photo || null },
  });
}

/* Fridge Assistant's stock, one subscription shared by every card on the page. */
let stockSub = null;
let stockLast = null;
const stockFns = new Set();
export function watchStock(hass, fn) {
  stockFns.add(fn);
  if (stockLast) fn(stockLast);
  if (!stockSub) {
    stockSub = hass.connection.subscribeMessage((msg) => {
      stockLast = msg;
      stockFns.forEach((f) => f(msg));
    }, { type: "fridge_assistant/subscribe" }).catch(() => { stockSub = null; return null; });
  }
  return () => {
    stockFns.delete(fn);
    if (!stockFns.size && stockSub) {
      const s = stockSub;
      stockSub = null; stockLast = null;
      s.then((u) => u && u()).catch(() => {});
    }
  };
}
