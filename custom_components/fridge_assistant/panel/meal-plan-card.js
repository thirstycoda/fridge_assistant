/* Fridge Assistant — meal plan card.
 *
 * One day of a Mealie meal plan: Breakfast, Lunch and Dinner sections (each
 * only when something is planned), every meal with its picture and name. Tap
 * a meal for three buttons: "Open in Mealie" (the recipe, in a new tab or the
 * browser), "Made it", which runs a script that takes the recipe's
 * ingredients out of Fridge Assistant, and "Print label", which adds the
 * cooked meal to Fridge Assistant as a dish (choose how many portions, and
 * Freezer or Fridge, and what's going in when it's only part of the meal,
 * e.g. "Carbonara sauce", remembered per recipe) and prints a sticker for
 * each portion. Meals already made show a tick.
 * Notes on the plan get an "Eaten" button that takes them out of Fridge
 * Assistant. A note with text is a small meal whose text lists its
 * ingredients, one per line ("30 g oats", "½ banana"); a note with only a
 * title is one loose ingredient ("Avocado", "40 g cannellini beans", "1 tin
 * chickpeas"), one of the thing when there's no amount.
 *
 *   type: custom:fridge-assistant-meal-plan-card
 *   day: 0                          # 0 = today, 1 = tomorrow, ...
 *   mealie_url: http://mealie.local:9000
 *   group: home                     # Mealie group slug in recipe links
 *   todo_entity: todo.planned_meals # where made meals are recorded
 *   script: script.cook_planned_meal
 *   label_location: freezer         # Print label's default: freezer or fridge
 *
 * The plan comes from the Mealie integration's mealie.get_mealplan action
 * (shared by every card on the page). The script is called with
 * {mealplan_id, slug, name, entry_type, date}; a meal counts as made once the
 * to-do list holds a line whose JSON description has that mealplan_id and a
 * "done" record.
 */

const MAX_PORTIONS = 12;
const SECTIONS = [
  { key: "breakfast", label: "Breakfast", icon: "mdi:coffee-outline" },
  { key: "lunch", label: "Lunch", icon: "mdi:food-takeout-box-outline" },
  { key: "dinner", label: "Dinner", icon: "mdi:silverware-fork-knife" },
];
// Mealie's other entry types are shown with dinner.
const SECTION_OF = { breakfast: "breakfast", lunch: "lunch", dinner: "dinner", side: "dinner", dessert: "dinner", snack: "dinner", drink: "dinner" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function fmtAmount(amount, unit) {
  const n = Number(amount) || 0;
  const round = (x) => (x >= 10 || Number.isInteger(x) ? Math.round(x) : Math.round(x * 10) / 10);
  if (unit === "g" && n >= 1000) return `${round(n / 1000)} kg`;
  if (unit === "ml" && n >= 1000) return `${round(n / 1000)} l`;
  if (unit === "g" || unit === "ml") return `${round(n)} ${unit}`;
  if (!unit || unit === "each") return `${round(n)}`;
  return `${round(n)} ${unit}${round(n) === 1 ? "" : "s"}`;
}

/* "40 g cannellini beans", "½ avocado", "2 sweet potatoes", "1 tin chickpeas"
 * -> {quantity, unit, food}. Without an amount it's one of the thing. */
const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const AMOUNT_UNITS = [
  "kg", "g", "grams?", "ml", "l", "litres?", "tsp", "teaspoons?", "tbsp", "tablespoons?", "cups?",
  "tins?", "cans?", "jars?", "packs?", "handfuls?", "slices?", "pots?", "blocks?", "pieces?", "cloves?", "bunch(?:es)?",
];
const AMOUNT_RE = new RegExp(
  `^\\s*(half(?:\\s+an?)?(?=\\s)|an?(?=\\s)|\\d+\\s*/\\s*\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])\\s*`
  + `(?:(${AMOUNT_UNITS.join("|")})\\b\\.?\\s*)?(?:of\\s+)?(.+)$`, "i",
);
function parseAmount(text) {
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
function noteItems(entry) {
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

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// ---- shared plan fetch (all cards on a page share one call per minute) ------

const PLAN_TTL = 60 * 1000;
const RANGE_DAYS = 7;
let planCache = null; // {key, at, promise}
let entryIdPromise = null;
const planListeners = new Set();

function mealieEntryId(hass, configured) {
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

function fetchPlan(hass, configuredEntry, force = false) {
  const start = new Date();
  const key = isoDate(start);
  if (!force && planCache && planCache.key === key && Date.now() - planCache.at < PLAN_TTL) return planCache.promise;
  const promise = mealieEntryId(hass, configuredEntry).then((entry) => hass.callWS({
    type: "call_service",
    domain: "mealie",
    service: "get_mealplan",
    service_data: { config_entry_id: entry, start_date: key, end_date: isoDate(addDays(start, RANGE_DAYS - 1)) },
    return_response: true,
  })).then((res) => {
    const plan = (res && res.response && res.response.mealplan) || [];
    planListeners.forEach((fn) => fn(plan));
    return plan;
  });
  planCache = { key, at: Date.now(), promise };
  promise.catch(() => { if (planCache && planCache.promise === promise) planCache = null; });
  return promise;
}

/* A plan for any range (the shopping list's week), not shared. */
function fetchPlanRange(hass, configuredEntry, startISO, endISO) {
  return mealieEntryId(hass, configuredEntry).then((entry) => hass.callWS({
    type: "call_service", domain: "mealie", service: "get_mealplan",
    service_data: { config_entry_id: entry, start_date: startISO, end_date: endISO },
    return_response: true,
  })).then((res) => (res && res.response && res.response.mealplan) || []);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/* The shopping week: weeks start on `weekStart`; from `planDay` on, the
 * coming week is shown (it's been planned), before that the current one. */
function shoppingWeek(weekStart, planDay, offset = 0) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const ws = Math.max(0, WEEKDAYS.indexOf(String(weekStart).toLowerCase()));
  const pd = Math.max(0, WEEKDAYS.indexOf(String(planDay).toLowerCase()));
  const into = (today.getDay() - ws + 7) % 7;           // days since the week began
  let start = addDays(today, -into);
  if (into >= (pd - ws + 7) % 7 && (pd - ws + 7) % 7 !== 0) start = addDays(start, 7);
  start = addDays(start, offset * 7);
  return { start, end: addDays(start, 6), today };
}

/* The plan week an order is for: the first week starting on or after the day
 * it arrives (a Friday delivery feeds the week from Saturday), or after the
 * day it closes when there's no delivery date. */
function orderWeekStart(arrives, weekStart) {
  const ws = Math.max(0, WEEKDAYS.indexOf(String(weekStart).toLowerCase()));
  const d = new Date(arrives); d.setHours(12, 0, 0, 0);
  return addDays(d, (ws - d.getDay() + 7) % 7);
}

/* "Last week", "This week", "Next week"… for a week starting `start`,
 * counted from the calendar week today is in. */
function weekName(start, weekStart) {
  const ws = Math.max(0, WEEKDAYS.indexOf(String(weekStart).toLowerCase()));
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const current = addDays(today, -((today.getDay() - ws + 7) % 7));
  const s = new Date(start); s.setHours(12, 0, 0, 0);
  const n = Math.round((s - current) / (7 * 86400000));
  return n === 0 ? "This week" : n === 1 ? "Next week" : n === -1 ? "Last week"
    : n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}

/* When to look at the plan again: on coming back to the page, just after
 * midnight (the day moves on) and otherwise hourly, for plan edits made in
 * Mealie. Stock changes arrive by themselves. Returns a function that stops it. */
function scheduleRefresh(fn) {
  let midnight = null;
  const atMidnight = () => {
    const next = new Date(); next.setHours(24, 0, 30, 0);
    midnight = setTimeout(() => { fn(); atMidnight(); }, next - Date.now());
  };
  atMidnight();
  const hourly = setInterval(fn, 60 * 60 * 1000);
  const onVisible = () => { if (document.visibilityState === "visible") fn(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(midnight);
    clearInterval(hourly);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function dayLabel(offset, date) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

class FridgeAssistantMealPlanCard extends HTMLElement {
  static getStubConfig() {
    return { day: 0, mealie_url: "http://mealie.local:9000", todo_entity: "todo.planned_meals", script: "script.cook_planned_meal" };
  }

  setConfig(config) {
    if (!config || !config.mealie_url) throw new Error("Set mealie_url (e.g. http://192.168.1.10:9925)");
    this._config = {
      day: 0, group: "home", todo_entity: "todo.planned_meals", script: "script.cook_planned_meal", ...config,
    };
    this._config.mealie_url = String(this._config.mealie_url).replace(/\/+$/, "");
    this._plan = this._plan || null;
    this._done = this._done || new Map();
    this._open = this._open || null;
    this._busy = this._busy || new Set();
    this._printing = this._printing || new Set();
    this._printed = this._printed || new Map();
    this._labelState = this._labelState || new Map();
    this._notes = this._notes || new Map();
    this._labelOpen = this._labelOpen || null;
    if (this.shadowRoot) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    if (first) { this._load(); this._subscribe(); }
  }

  getCardSize() { return 4; }


  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  /* Inside the week card (config `date`), the plan is handed over. */
  set plan(plan) { this._plan = plan; this._error = null; if (this.shadowRoot) this._render(); }

  connectedCallback() {
    if (this._config && this._config.date) { if (this._hass) this._subscribe(); return; }
    this._onPlan = (plan) => { this._plan = plan; this._error = null; this._render(); };
    planListeners.add(this._onPlan);
    if (this._hass) { this._load(); this._subscribe(); }
    // Refresh now and then, and when the date rolls over.
    if (!this._tick) this._tick = scheduleRefresh(() => this._load());
  }

  disconnectedCallback() {
    if (this._onPlan) planListeners.delete(this._onPlan);
    if (this._tick) { this._tick(); this._tick = null; }
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  // ---- data -------------------------------------------------------------------

  _load(force = false) {
    if (!this._hass || !this._config || this._config.date) return;
    fetchPlan(this._hass, this._config.mealie_entry, force)
      .then((plan) => { this._plan = plan; this._error = null; this._render(); })
      .catch((err) => { this._error = err.message || String(err); this._render(); });
  }

  _subscribe() {
    if (!this._hass || !this._config || this._unsub || !this.isConnected) return;
    this._unsub = this._hass.connection.subscribeMessage((msg) => {
      const done = new Map();
      (msg.items || []).forEach((item) => {
        let info = {};
        try { info = JSON.parse(item.description || "{}") || {}; } catch (e) { info = {}; }
        // The "done" record is what counts: the script refuses to take a
        // meal out twice even if its line was unticked afterwards.
        if (info.mealplan_id != null && info.done) done.set(String(info.mealplan_id), info.done);
      });
      this._done = done;
      this._render();
    }, { type: "todo/item/subscribe", entity_id: this._config.todo_entity })
      .catch(() => { this._unsub = null; return null; });
  }

  _date() {
    return this._config.date ? new Date(`${this._config.date}T12:00:00`) : addDays(new Date(), Number(this._config.day) || 0);
  }

  _offset() {
    if (!this._config.date) return Number(this._config.day) || 0;
    const today = new Date(); today.setHours(12, 0, 0, 0);
    return Math.round((this._date() - today) / 86400000);
  }

  _entries() {
    const day = isoDate(this._date());
    return (this._plan || []).filter((e) => e.mealplan_date === day);
  }

  _imageUrl(recipe) {
    if (!recipe || !recipe.image) return null;
    return `${this._config.mealie_url}/api/media/recipes/${recipe.recipe_id}/images/min-original.webp?version=${encodeURIComponent(recipe.image)}`;
  }

  _recipeUrl(recipe) {
    return `${this._config.mealie_url}/g/${encodeURIComponent(this._config.group)}/r/${encodeURIComponent(recipe.slug)}`;
  }

  /* A note on the plan was eaten: take its ingredients (its lines, or the one
   * loose ingredient in its title, such as "Avocado") out of Fridge Assistant
   * and record it on the to-do list so the card remembers. */
  async _eaten(entry) {
    const id = String(entry.mealplan_id);
    const { items } = noteItems(entry);
    if (!items.length || this._busy.has(id) || this._done.has(id)) return;
    this._busy.add(id);
    this._notes.delete(id);
    this._render();
    try {
      const res = await this._hass.callWS({
        type: "call_service", domain: "fridge_assistant", service: "consume_ingredients",
        service_data: { ingredients: items.map((a) => ({ food: a.food, quantity: a.quantity, unit: a.unit })) }, return_response: true,
      });
      const got = (res && res.response && res.response.lines) || [];
      const took = [];
      const problems = [];
      items.forEach((amount, n) => {
        const line = got[n] || {};
        const food = amount.food;
        const name = String(line.template || food).toLowerCase();
        const unit = line.amount_unit;
        if (line.status === "taken" || line.status === "short") {
          const left = (line.taken || []).reduce((sum, t) => sum + (t.left || 0), 0);
          const what = unit === "each" ? `${fmtAmount(line.need, unit)} ${name}` : `${fmtAmount(line.need, unit)} of ${name}`;
          // One ingredient gets the detail; a list just says what came out.
          const rest = items.length > 1 ? (line.status === "short" ? " (the last of it)" : "")
            : line.status === "short" ? " · that was the last of it"
              : left > 0 ? ` · ${fmtAmount(left, unit)} left in that pack` : " · that pack is finished";
          took.push(`${what}${rest}`);
        } else if (line.status === "negligible") {
          // A pinch of something: nothing to take, nothing wrong.
        } else {
          problems.push({
            untracked: `${food} isn't tracked in Fridge Assistant`,
            not_in_stock: `there's no ${name} in Fridge Assistant`,
            no_amount_tracked: `there's no ${name} in Fridge Assistant`,
            no_conversion: amount.unit === "each"
              ? `Fridge Assistant can't tell how much one ${name} is; put the amount in the plan, e.g. "40 g ${food.toLowerCase()}"`
              : `Fridge Assistant can't convert ${amount.unit} of ${name}`,
            no_quantity: `no amount to take for ${food}`,
          }[line.status] || `nothing taken for ${food} (${line.status || "unknown"})`);
        }
      });
      if (took.length) {
        // Something came out, so it counts as eaten; say what didn't.
        const miss = problems.length ? ` · not taken: ${problems.join("; ")}` : "";
        this._notes.set(id, { text: `Took ${took.join(", ")}${miss}`, bad: problems.length > 0 });
        await this._recordDone(entry, { eaten: true, at: new Date().toISOString() });
        this._done.set(id, { eaten: true });
        this._open = null;
      } else {
        const why = problems.join("; ") || "Nothing taken";
        this._notes.set(id, { text: why.charAt(0).toUpperCase() + why.slice(1), bad: true });
      }
    } catch (err) {
      this._notes.set(id, { text: `Couldn't take it out: ${err.message || err}`, bad: true });
    } finally {
      this._busy.delete(id);
      this._render();
    }
  }

  async _recordDone(entry, done) {
    const target = { entity_id: this._config.todo_entity };
    const type = String(entry.entry_type || "meal");
    const day = new Date(`${entry.mealplan_date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const summary = `${type.charAt(0).toUpperCase()}${type.slice(1)}: ${entry.title} · ${day}`;
    const description = JSON.stringify({
      mealplan_id: entry.mealplan_id, name: entry.title, entry_type: entry.entry_type, date: entry.mealplan_date, done,
    });
    try {
      await this._hass.callService("todo", "add_item", { item: summary, description }, target);
      await this._hass.callService("todo", "update_item", { item: summary, status: "completed" }, target);
    } catch (err) { /* the stock change already happened; remembering it is a nicety */ }
  }

  async _madeIt(entry) {
    const id = String(entry.mealplan_id);
    if (this._busy.has(id) || this._done.has(id)) return;
    this._busy.add(id);
    this._render();
    const [domain, service] = this._config.script.includes(".") ? this._config.script.split(".") : ["script", this._config.script];
    try {
      await this._hass.callService(domain, service, {
        mealplan_id: entry.mealplan_id,
        slug: entry.recipe.slug,
        name: entry.recipe.name,
        entry_type: entry.entry_type,
        date: entry.mealplan_date,
      });
      // The script records the meal on the to-do list; show it as made now
      // rather than waiting for that update to arrive.
      this._done.set(id, { factor: 1 });
      this._open = null;
    } catch (err) {
      this._error = `Couldn't mark it as made: ${err.message || err}`;
    } finally {
      this._busy.delete(id);
      this._render();
    }
  }

  /* Put the cooked meal away as a Fridge Assistant dish (one item with a
   * portion per container) and print a sticker for each portion. */
  async _printLabel(entry) {
    const id = String(entry.mealplan_id);
    if (this._printing.has(id)) return;
    const opts = this._labelOpts(id);
    this._printing.add(id);
    this._printed.delete(id);
    this._render();
    const r = entry.recipe;
    const where = opts.location === "fridge" ? "fridge" : "freezer";
    const what = String(opts.name || "").trim() || r.name;
    try {
      // Remember what this recipe's leftovers are (e.g. just the sauce).
      if (what !== (opts.saved || r.name)) {
        this._hass.callWS({ type: "fridge_assistant/meal_label", recipe: r.recipe_id || r.slug, name: what === r.name ? "" : what })
          .catch(() => {});
      }
      const added = await this._hass.callWS({
        type: "fridge_assistant/add_item",
        item: {
          name: what, contents: what, kind: "dish", location: where,
          portions: opts.portions,
          photo: this._imageUrl(r) || null,
          notes: [what !== r.name ? `From ${r.name}` : "", this._config.label_notes || ""].filter(Boolean).join(" — ") || null,
        },
      });
      const item = added && added.item;
      // One sticker per portion (AB12-1, AB12-2, ...), in order.
      const targets = opts.portions > 1 ? Array.from({ length: opts.portions }, (_, i) => i + 1) : [null];
      let printed = 0;
      let failure = null;
      for (const n of targets) {
        const msg = { type: "fridge_assistant/print_sticker", item_id: item.id };
        if (n != null) msg.portion = n;
        const res = await this._hass.callWS(msg);
        if (!res || !res.printed) { failure = res; break; }
        printed += 1;
      }
      if (!failure) {
        const until = item.expiry_date
          ? ` · keeps until ${new Date(`${item.expiry_date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`
          : "";
        const what = printed > 1 ? `${printed} labels for ${item.code}` : `${item.code}`;
        this._printed.set(id, { text: `Printed ${what} · in the ${where}${until}` });
        this._labelOpen = null;
        this._labelState.delete(id); // next time starts at 1, freezer again
      } else {
        const reasons = {
          printer_disabled: "printing is turned off in Fridge Assistant",
          printer_unreachable: "the label printer can't be reached",
          printer_not_connected: "the printer isn't connected or is off",
        };
        const why = reasons[failure && failure.reason] || (failure && failure.reason) || "unknown error";
        const done = printed ? ` (${printed} of ${targets.length} printed)` : "";
        this._printed.set(id, { text: `Added ${item.code} to the ${where}, but the labels didn't all print${done}: ${why}`, bad: true });
      }
    } catch (err) {
      this._printed.set(id, { text: `Couldn't print: ${err.message || err}`, bad: true });
    } finally {
      this._printing.delete(id);
      this._render();
    }
  }

  /* Start the "What's going in" box with what this recipe was labelled as
   * last time, or the recipe's name. */
  async _loadLabelName(entry) {
    const id = String(entry.mealplan_id);
    const opts = this._labelOpts(id);
    if (opts.name != null) return;
    opts.name = entry.recipe.name;
    try {
      const res = await this._hass.callWS({ type: "fridge_assistant/meal_label", recipe: entry.recipe.recipe_id || entry.recipe.slug });
      if (res && res.name) { opts.saved = res.name; if (opts.name === entry.recipe.name) opts.name = res.name; this._render(); }
    } catch (err) { /* the recipe name will do */ }
  }

  _labelOpts(id) {
    if (!this._labelState.has(id)) {
      this._labelState.set(id, { portions: 1, location: this._config.label_location === "fridge" ? "fridge" : "freezer" });
    }
    return this._labelState.get(id);
  }

  // ---- rendering -----------------------------------------------------------------

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        [hidden] { display: none !important; }
        .day { font-size: 20px; font-weight: 600; }
        .date { color: var(--secondary-text-color); font-size: 14px; margin-top: 2px; }
        .sec { margin-top: 14px; }
        .sec-h { display: flex; align-items: center; gap: 6px; font-size: 13px; text-transform: uppercase;
          letter-spacing: .04em; color: var(--secondary-text-color); margin-bottom: 6px; }
        .sec-h ha-icon { --mdc-icon-size: 16px; }
        .meal { border-radius: 14px; background: var(--secondary-background-color); margin-top: 8px; overflow: hidden; }
        .meal-row { display: flex; align-items: center; gap: 12px; padding: 8px; width: 100%; text-align: left;
          font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
        .pic { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 10px; object-fit: cover;
          background: var(--divider-color); display: flex; align-items: center; justify-content: center; }
        .pic ha-icon { --mdc-icon-size: 28px; color: var(--secondary-text-color); }
        .note .pic { width: 40px; height: 40px; flex-basis: 40px; }
        .note .pic ha-icon { --mdc-icon-size: 20px; }
        .name { flex: 1 1 auto; font-weight: 500; line-height: 1.3; }
        .name small { display: block; font-weight: 400; color: var(--secondary-text-color); font-size: 13px; margin-top: 2px; }
        .made { color: var(--success-color, #43a047); --mdc-icon-size: 24px; flex: 0 0 auto; }
        .meal.is-made .name { color: var(--secondary-text-color); }
        /* Open in Mealie and Made it side by side, Print label underneath. */
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 8px 10px; }
        .actions button[data-act=label], .actions button:only-child { grid-column: 1 / -1; }
        .actions button { flex: 1 1 100px; display: flex; align-items: center; justify-content: center; gap: 6px;
          font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; border-radius: 12px; padding: 10px 8px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .actions button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        .actions button:disabled { opacity: .6; cursor: default; }
        .actions ha-icon { --mdc-icon-size: 20px; }
        .actions button.on { border-color: var(--primary-color); color: var(--primary-color); }
        /* Mealie's look: its orange, its icon. */
        .actions button.mealie { background: #E58325; color: #fff; border-color: transparent; white-space: nowrap; padding-block: 7px; }
        .actions button.mealie img { width: 22px; height: 22px; padding: 3px; border-radius: 50%; background: #fff; }
        .label { margin: 0 8px 10px; padding: 10px 12px; border-radius: 12px; background: var(--card-background-color);
          display: flex; flex-direction: column; gap: 10px; }
        .lrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 14px; }
        .lname { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
        .lname input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .stepper { display: flex; align-items: center; gap: 12px; }
        .stepper b { min-width: 1.5em; text-align: center; font-size: 18px; }
        .label button { font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .label button:disabled { opacity: .5; cursor: default; }
        .stepper button { width: 40px; height: 36px; font-size: 20px; line-height: 1; }
        .seg { display: flex; gap: 6px; }
        .seg button { display: flex; align-items: center; gap: 4px; padding: 7px 12px; font-size: 14px; }
        .seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        .seg ha-icon { --mdc-icon-size: 18px; }
        .label button.print { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px;
          font-weight: 500; background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        .label button.print ha-icon { --mdc-icon-size: 20px; }
        .printed { padding: 0 10px 10px; font-size: 13px; color: var(--secondary-text-color); }
        .printed.bad { color: var(--error-color); }
        .extra { margin-top: 14px; font-size: 14px; color: var(--secondary-text-color); }
        .extra b { color: var(--primary-text-color); font-weight: 500; }
        .empty { margin-top: 12px; color: var(--secondary-text-color); }
        .err { margin-top: 12px; color: var(--error-color); font-size: 14px; }
      </style>
      <ha-card><div id="body"></div></ha-card>`;
    root.getElementById("body").addEventListener("input", (ev) => {
      if (ev.target.dataset && ev.target.dataset.field === "name") this._labelOpts(ev.target.dataset.id).name = ev.target.value;
    });
    root.getElementById("body").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      const entry = this._entries().find((e) => String(e.mealplan_id) === id);
      if (!entry) return;
      if (btn.dataset.act === "toggle") { this._open = this._open === id ? null : id; this._render(); }
      else if (btn.dataset.act === "open") window.open(this._recipeUrl(entry.recipe), "_blank", "noopener");
      else if (btn.dataset.act === "made") this._madeIt(entry);
      else if (btn.dataset.act === "eaten") this._eaten(entry);
      else if (btn.dataset.act === "label") {
        this._labelOpen = this._labelOpen === id ? null : id;
        this._printed.delete(id);
        if (this._labelOpen) this._loadLabelName(entry);
        this._render();
      }
      else if (btn.dataset.act === "print") this._printLabel(entry);
      else if (btn.dataset.act === "less" || btn.dataset.act === "more") {
        const o = this._labelOpts(id);
        o.portions = Math.max(1, Math.min(MAX_PORTIONS, o.portions + (btn.dataset.act === "more" ? 1 : -1)));
        this._render();
      } else if (btn.dataset.act === "where") { this._labelOpts(id).location = btn.dataset.loc; this._render(); }
    });
  }

  _mealHtml(entry) {
    const id = String(entry.mealplan_id);
    const r = entry.recipe;
    const done = this._done.get(id);
    if (!r) {
      const busy = this._busy.has(id);
      const open = this._open === id;
      const note = this._notes.get(id);
      const sub = done ? "Eaten" : String(entry.description || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" · ");
      return `<div class="meal note ${done ? "is-made" : ""}">
        <button class="meal-row" data-act="toggle" data-id="${id}" aria-expanded="${open}">
          <div class="pic"><ha-icon icon="mdi:food-apple-outline"></ha-icon></div>
          <div class="name">${esc(entry.title || "")}${sub ? `<small>${esc(sub)}</small>` : ""}</div>
          ${done ? `<ha-icon class="made" icon="mdi:check-circle"></ha-icon>` : ""}
        </button>
        ${open ? `<div class="actions">
          <button class="primary" data-act="eaten" data-id="${id}" ${done || busy ? "disabled" : ""}>
            <ha-icon icon="mdi:check"></ha-icon>${busy ? "Taking out…" : "Eaten"}</button>
        </div>` : ""}
        ${note ? `<div class="printed ${note.bad ? "bad" : ""}">${esc(note.text)}</div>` : ""}
      </div>`;
    }
    const busy = this._busy.has(id);
    const printing = this._printing.has(id);
    const printed = this._printed.get(id);
    const labelOpen = this._labelOpen === id;
    const opts = this._labelOpts(id);
    const img = this._imageUrl(r);
    const pic = img
      ? `<img class="pic" src="${esc(img)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pic',innerHTML:'<ha-icon icon=&quot;mdi:silverware-fork-knife&quot;></ha-icon>'}))">`
      : `<div class="pic"><ha-icon icon="mdi:silverware-fork-knife"></ha-icon></div>`;
    const status = done ? (done.skipped ? "Skipped" : done.eaten ? "Eaten" : "Made") : "";
    const open = this._open === id;
    return `<div class="meal ${done ? "is-made" : ""}">
      <button class="meal-row" data-act="toggle" data-id="${id}" aria-expanded="${open}">
        ${pic}
        <div class="name">${esc(r.name)}${status ? `<small>${status}</small>` : ""}</div>
        ${done && !done.skipped ? `<ha-icon class="made" icon="mdi:check-circle"></ha-icon>` : ""}
      </button>
      ${open ? `<div class="actions">
        <button class="mealie" data-act="open" data-id="${id}"><img src="${esc(this._config.mealie_url)}/icons/android-chrome-192x192.png" alt=""
          onerror="this.style.display='none'">Open in Mealie</button>
        <button class="primary" data-act="made" data-id="${id}" ${done || busy ? "disabled" : ""}>
          <ha-icon icon="${done ? "mdi:check" : "mdi:pot-steam-outline"}"></ha-icon>${busy ? "Taking out…" : done ? "Made" : "Made it"}</button>
        <button data-act="label" data-id="${id}" class="${labelOpen ? "on" : ""}" aria-expanded="${labelOpen}">
          <ha-icon icon="mdi:printer-outline"></ha-icon>Print label</button>
      </div>` : ""}
      ${open && labelOpen ? `<div class="label">
        <label class="lname"><span>What's going in</span>
          <input data-id="${id}" data-field="name" value="${esc(opts.name ?? r.name)}" ${printing ? "disabled" : ""}></label>
        <div class="lrow"><span>Portions</span>
          <div class="stepper">
            <button data-act="less" data-id="${id}" ${opts.portions <= 1 || printing ? "disabled" : ""} aria-label="Fewer">−</button>
            <b>${opts.portions}</b>
            <button data-act="more" data-id="${id}" ${opts.portions >= MAX_PORTIONS || printing ? "disabled" : ""} aria-label="More">+</button>
          </div></div>
        <div class="lrow"><span>Goes in</span>
          <div class="seg">${["freezer", "fridge"].map((loc) => `<button data-act="where" data-loc="${loc}" data-id="${id}"
            class="${opts.location === loc ? "on" : ""}" ${printing ? "disabled" : ""}><ha-icon icon="${loc === "freezer" ? "mdi:snowflake" : "mdi:fridge"}"></ha-icon>${loc === "freezer" ? "Freezer" : "Fridge"}</button>`).join("")}</div></div>
        <button class="print" data-act="print" data-id="${id}" ${printing ? "disabled" : ""}>
          <ha-icon icon="mdi:printer"></ha-icon>${printing ? "Printing…" : `Print ${opts.portions} label${opts.portions === 1 ? "" : "s"}`}</button>
      </div>` : ""}
      ${printed ? `<div class="printed ${printed.bad ? "bad" : ""}">${esc(printed.text)}</div>` : ""}
    </div>`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const body = this.shadowRoot.getElementById("body");
    const offset = this._offset();
    const date = this._date();
    const entries = this._entries();
    this.classList.toggle("past", offset < 0);
    // Notes that aren't a meal slot (e.g. a side note for one person) go below.
    // A note listing its ingredients is a meal wherever it's planned.
    const extras = entries.filter((e) => !e.recipe && !["breakfast", "lunch", "dinner"].includes(e.entry_type)
      && !noteItems(e).items.length);
    const meals = entries.filter((e) => !extras.includes(e));
    const sections = SECTIONS.map((s) => ({ ...s, items: meals.filter((e) => SECTION_OF[e.entry_type] === s.key) }))
      .filter((s) => s.items.length);
    // Recipes before plain notes within a section.
    sections.forEach((s) => s.items.sort((a, b) => (b.recipe ? 1 : 0) - (a.recipe ? 1 : 0)));
    const head = `<div class="day">${esc(dayLabel(offset, date))}</div>
      ${Math.abs(offset) <= 1 ? `<div class="date">${esc(date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</div>` : ""}`;
    let content;
    if (this._plan === null && !this._error) content = `<div class="empty">Loading…</div>`;
    else if (!sections.length && !extras.length) content = `<div class="empty">Nothing planned.</div>`;
    else {
      content = sections.map((s) => `<div class="sec">
          <div class="sec-h"><ha-icon icon="${s.icon}"></ha-icon>${s.label}</div>
          ${s.items.map((e) => this._mealHtml(e)).join("")}
        </div>`).join("")
        + extras.map((e) => `<div class="extra"><b>${esc(e.title || "")}</b>${e.description ? `: ${esc(e.description)}` : ""}</div>`).join("");
    }
    body.innerHTML = head + content + (this._error ? `<div class="err">${esc(this._error)}</div>` : "");
  }
}

if (!customElements.get("fridge-assistant-meal-plan-card")) {
  customElements.define("fridge-assistant-meal-plan-card", FridgeAssistantMealPlanCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-meal-plan-card",
    name: "Fridge Assistant meal plan",
    description: "One day of a Mealie meal plan, with Open in Mealie and Made it buttons.",
  });
}

/* ---- Shopping list card ---------------------------------------------------
 *
 * A week's meal plan as a shopping list in four sections: Need (what the
 * recipes and notes use and stock doesn't cover), Check (stock covers it, but it's
 * worth a look: opened, a guessed amount, used day to day, only just enough,
 * may go off, or not checked for a month), Have, and Added (in the basket). Tap an ingredient to see the
 * meals it's for and move it between sections. Have asks how much there is
 * and where, and adds it to Fridge Assistant (setting the food up when it
 * isn't tracked yet), so stock stays the source of truth; Need on something
 * in Have takes it back out. The list follows stock changes as they happen.
 * "Added" (in the basket) marks are shared by everyone and lapse after a
 * week. The list moves on by itself: past days drop off just after midnight.
 *
 *   type: custom:fridge-assistant-shopping-card
 *   mealie_entry: 01ABC...           # optional, the Mealie config entry
 *   todo_entity: todo.planned_meals  # meals already made are left out
 *   ignore: [water]                  # foods never put on the list
 *   mealie_url: https://mealie.example   # links to recipes that need tidying
 *   week_start: saturday             # the plan's weeks start on this day
 *   plan_day: thursday               # from this day on, show the coming week
 *   deadline_entity: sensor.ocado_uk_deliveries_next_edit_deadline   # optional countdown
 *   delivery_entity: sensor.ocado_uk_deliveries_next_delivery        # optional, its window
 *
 * With deadline_entity (a timestamp: when the order stops taking changes)
 * the list shows how long is left to finalise the shopping, like the unpack
 * card's delivery countdown; it turns urgent in the last two hours and says
 * when the order has closed. It shows on the week the order is for: the
 * first plan week starting on or after the delivery (or closing) day.
 */

/* "5 h 12 min", "2 days 3 h", "40 min". */
function untilText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"} ${h % 24} h`;
  return `${h} h ${pad(m % 60)} min`;
}
const URGENT_MS = 2 * 3600 * 1000;

/* A recipe's lines for the shopping list, as Mealie has them (the house
 * rules — romano peppers, bouillon for stock — live in the recipes). */
function recipeLines(recipe, source, date, ignore) {
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

/* What in a recipe needs tidying in Mealie for the list to be right:
 * lines Mealie couldn't read, and the house rules (romano peppers except in
 * a lasagne; bouillon powder and water instead of vegetable stock). */
const OTHER_PEPPERS = ["red pepper", "yellow pepper", "green pepper", "orange pepper", "sweet pepper", "bell pepper"];
function recipeIssues(recipe) {
  const issues = [];
  const lasagna = /lasagn/i.test(recipe.name || "");
  for (const i of recipe.ingredients || []) {
    const text = String(i.original_text || i.note || i.display || "").trim();
    if (!i.food) {
      if (text && !/^could not detect/i.test(text)) issues.push(`couldn't read “${text}”`);
      continue;
    }
    const food = String(i.food.name || "").toLowerCase();
    if (!lasagna && OTHER_PEPPERS.includes(food)) issues.push(`“${food}” — you use romano peppers`);
    if (food === "vegetable stock") issues.push("vegetable stock — you use bouillon powder and water (4 tsp a litre)");
  }
  return [...new Set(issues)];
}

const CHECK_TEXT = {
  expires: "may go off before it's used",
  untracked: "amount isn't tracked",
  guessed: "amount is the usual pack size, never checked",
  opened: "opened",
  everyday: "used day to day too",
  tight: "only just enough",
  stale: "not checked for a month",
};
function checkText(g) {
  const parts = (g.check || []).map((r) => CHECK_TEXT[r] || r);
  return parts.length ? `Worth a look: ${parts.join(" · ")}` : "";
}

// Aisles and food emoji, shared with the unpack card (same version as this file).
const { AISLES, aisleOf, foodEmoji } = await import(new URL(`./lib/food-look.js${new URL(import.meta.url).search}`, import.meta.url));

function amountText(quantity, unit) {
  if (!quantity) return "";
  const u = String(unit || "");
  if (["g", "ml", "each", "", "kg", "l"].includes(u)) return fmtAmount(quantity, u);
  return fmtAmount(quantity, u.replace(/s$/, ""));
}

class FridgeAssistantShoppingCard extends HTMLElement {
  static getStubConfig() { return { todo_entity: "todo.planned_meals" }; }

  setConfig(config) {
    this._config = {
      todo_entity: "todo.planned_meals", ignore: ["water"], title: "Shopping",
      week_start: "saturday", plan_day: "thursday", ...config,
    };
    this._offset = this._offset || 0;
    this._groups = this._groups || null;
    this._marks = this._marks || {};
    this._done = this._done || new Set();
    this._open = this._open || null;
    this._recipes = this._recipes || new Map();
    this._form = this._form || null;
    this._notice = this._notice || null;
    if (!this._collapsed) {
      // Which sections are folded away, remembered on this device.
      try { this._collapsed = new Set(JSON.parse(localStorage.getItem("fridge-assistant-shopping-collapsed") || "[]")); }
      catch (e) { this._collapsed = new Set(); }
    }
    if (this.shadowRoot) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    if (first) { this._subscribe(); this._load(); }
    const c = this._config || {};
    const dl = c.deadline_entity ? hass.states[c.deadline_entity] : null;
    const dv = c.delivery_entity ? hass.states[c.delivery_entity] : null;
    if (dl !== this._deadlineState || dv !== this._deliveryState) {
      this._deadlineState = dl;
      this._deliveryState = dv;
      this._renderCountdown();
    }
  }

  getCardSize() { return 8; }

  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  connectedCallback() {
    if (this._hass) { this._subscribe(); this._load(); }
    if (!this._tick) this._tick = scheduleRefresh(() => this._load());
    if (!this._cdTimer) this._cdTimer = setInterval(() => this._renderCountdown(), 30 * 1000);
  }

  disconnectedCallback() {
    if (this._tick) { this._tick(); this._tick = null; }
    if (this._cdTimer) { clearInterval(this._cdTimer); this._cdTimer = null; }
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
    if (this._unsubFa) { this._unsubFa.then((u) => u && u()).catch(() => {}); this._unsubFa = null; }
  }

  _subscribe() {
    if (!this._hass || !this.isConnected) return;
    // Stock changes anywhere (eaten in the panel, put away, cooked) redo the sums.
    if (!this._unsubFa) {
      this._unsubFa = this._hass.connection.subscribeMessage(() => {
        clearTimeout(this._restockTimer);
        this._restockTimer = setTimeout(() => this._restock(), 800);
      }, { type: "fridge_assistant/subscribe" }).catch(() => { this._unsubFa = null; return null; });
    }
    if (this._unsub || !this._config.todo_entity) return;
    this._unsub = this._hass.connection.subscribeMessage((msg) => {
      const done = new Set();
      (msg.items || []).forEach((item) => {
        let info = {};
        try { info = JSON.parse(item.description || "{}") || {}; } catch (e) { info = {}; }
        if (info.mealplan_id != null && info.done) done.add(String(info.mealplan_id));
      });
      const changed = done.size !== this._done.size || [...done].some((d) => !this._done.has(d));
      this._done = done;
      if (changed && this._loadedOnce) this._load(true);
    }, { type: "todo/item/subscribe", entity_id: this._config.todo_entity }).catch(() => { this._unsub = null; return null; });
  }

  async _recipe(slug) {
    if (!this._recipes.has(slug)) {
      const p = mealieEntryId(this._hass, this._config.mealie_entry).then((entry) => this._hass.callWS({
        type: "call_service", domain: "mealie", service: "get_recipe",
        service_data: { config_entry_id: entry, recipe_id: slug }, return_response: true,
      })).then((res) => res.response.recipe);
      p.catch(() => this._recipes.delete(slug));
      this._recipes.set(slug, p);
    }
    return this._recipes.get(slug);
  }

  async _load(force = false) {
    if (!this._hass || this._loading) return;
    this._loading = true;
    if (force) this._recipes.clear();
    this._render();
    try {
      const week = shoppingWeek(this._config.week_start, this._config.plan_day, this._offset);
      // Days of the week already gone don't need shopping for.
      const from = week.start < week.today ? week.today : week.start;
      const plan = await fetchPlanRange(this._hass, this._config.mealie_entry, isoDate(from), isoDate(week.end));
      // Shopping ahead: the meals still to come before this week starts get
      // first claim on what's in stock, so only what's left over counts.
      const before = week.start > week.today
        ? await fetchPlanRange(this._hass, this._config.mealie_entry, isoDate(week.today), isoDate(addDays(week.start, -1)))
        : [];
      this._week = week;
      const ignore = new Set((this._config.ignore || []).map((x) => String(x).toLowerCase()));
      const lines = [];
      const meals = [];
      const warnings = [];
      const add = async (e, reserved) => {
        if (this._done.has(String(e.mealplan_id))) return;
        const day = new Date(`${e.mealplan_date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
        const mark = (l) => (reserved ? { ...l, reserved: true } : l);
        if (e.recipe) {
          const recipe = await this._recipe(e.recipe.slug);
          lines.push(...recipeLines(recipe, `${recipe.name} · ${day}`, e.mealplan_date, ignore).map(mark));
          if (reserved) return;
          meals.push(e);
          const issues = recipeIssues(recipe);
          if (issues.length && !warnings.some((w) => w.slug === recipe.slug)) warnings.push({ name: recipe.name, slug: recipe.slug, issues });
        } else {
          // A note: its ingredient lines (or the title, for one loose ingredient).
          const { items, unreadable } = noteItems(e);
          const name = e.title || "Note";
          // A note with its own ingredient list is a meal; a loose one isn't.
          if (!reserved && e.description && items.length) meals.push(e);
          for (const a of items) {
            if (ignore.has(a.food.toLowerCase())) continue;
            lines.push(mark({ food: a.food.toLowerCase(), quantity: a.quantity, unit: a.unit === "each" ? "" : a.unit, source: `${name} · ${day}`, date: e.mealplan_date }));
          }
          if (unreadable.length && !reserved) {
            warnings.push({ name: `${name} · ${day}`, note: true,
              issues: unreadable.map((t) => `couldn't read “${t}” — list one ingredient per line, with its amount, e.g. “30 g oats”`) });
          }
        }
      };
      for (const e of before) await add(e, true);
      for (const e of plan) await add(e, false);
      this._reservedMeals = before.filter((e) => e.recipe && !this._done.has(String(e.mealplan_id))).length;
      this._lines = lines;
      this._warnings = warnings;
      this._mealCount = meals.length;
      await this._restock(true);
      this._error = null;
      this._loadedOnce = true;
    } catch (err) {
      this._error = err.message || String(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  /* Compare the plan's lines with stock again (stock changed). */
  async _restock(throwErrors = false) {
    if (!this._lines || !this._hass) return;
    try {
      const res = await this._hass.callWS({ type: "fridge_assistant/stock_check", lines: this._lines });
      this._groups = res.groups;
      this._marks = res.marks || {};
      if (!throwErrors) this._render();
    } catch (err) {
      if (throwErrors) throw err;
      this._error = err.message || String(err);
      this._render();
    }
  }

  _unitsFor(g) {
    const family = (u) => (u === "g" || u === "kg" ? ["g", "kg"] : u === "ml" || u === "l" ? ["ml", "l"] : [u]);
    if (!g.unit) return g.spoons ? ["g", "ml", "each"] : ["each", "g", "ml"];
    const out = [...family(g.unit)];
    for (const k of g.per || []) {
      if (k === "g" || k === "ml") out.push(...family(k));
      else if (["each", "can", "tin", "pot", "block", "pack", "bottle", "jar"].includes(k)) out.push(k);
    }
    return [...new Set(out)];
  }

  _openHave(group) {
    const units = this._unitsFor(group);
    // Already in stock: start from what's recorded, to be corrected to the total.
    const amount = group.unit ? (group.in_stock && group.stock > 0 ? group.stock : (group.pack_amount || group.short || "")) : "";
    this._form = { key: group.key, amount: amount === "" ? "" : String(amount), unit: group.unit || units[0] };
    this._notice = null;
    this._render();
  }

  /* We have it: put it in Fridge Assistant (creating the food when it isn't
   * tracked yet), or, when some is already in stock, set the stock to this
   * total. Either way it moves to Have when there's enough. */
  async _have(group, location) {
    const f = this._form;
    const amount = Number(f && f.amount);
    if (!f || !(amount > 0)) { this._notice = { key: group.key, text: "How much do you have?", bad: true }; this._render(); return; }
    this._busy = true; this._render();
    try {
      const food = group.tracked ? group.name : (group.sources[0] && group.sources[0].food) || group.name;
      const res = await this._hass.callWS({
        type: "fridge_assistant/stock_have", food, amount, unit: f.unit, location: location || null,
        template_id: group.template_id || null, spoons: !!group.spoons,
      });
      if (this._marks[group.key]) {
        await this._hass.callWS({ type: "fridge_assistant/set_shopping_mark", key: group.key, state: null }).catch(() => {});
      }
      const where = (it) => ({ cupboard: "the cupboard", fridge: "the fridge", freezer: "the freezer", pantry: "the pantry" }[it.location] || it.location);
      this._notice = { key: `t:${res.template.id}`, text: res.updated
        ? `${res.template.name}: ${amountText(amount, f.unit)} in stock now`
        : `Added ${amountText(amount, f.unit)} ${res.item.name.toLowerCase()} to ${where(res.item)} (${res.item.code})` };
      this._form = null; this._open = null;
      await this._restock();
    } catch (err) {
      this._notice = { key: group.key, text: `Couldn't add it: ${err.message || err}`, bad: true };
    } finally {
      this._busy = false; this._render();
    }
  }

  /* It's gone after all (eaten, used): take the covered amount out of Fridge
   * Assistant, which moves it to Need. */
  async _backToNeed(group) {
    this._busy = true; this._render();
    try {
      await this._hass.callWS({
        type: "call_service", domain: "fridge_assistant", service: "consume_ingredients",
        service_data: { ingredients: [{ food: group.name, template_id: group.template_id, quantity: group.have, unit: group.unit }] },
        return_response: true,
      });
      this._notice = { key: group.key, text: `Took ${amountText(group.have, group.unit)} ${group.name.toLowerCase()} out of Fridge Assistant` };
      this._open = null;
      await this._restock();
    } catch (err) {
      this._notice = { key: group.key, text: `Couldn't take it out: ${err.message || err}`, bad: true };
    } finally {
      this._busy = false; this._render();
    }
  }

  /* Looked in the cupboard: what's there is right (or this much). */
  async _confirm(group) {
    const f = this._form || {};
    const amount = f.amount === "" || f.amount == null ? null : Number(f.amount);
    this._busy = true; this._render();
    try {
      const msg = { type: "fridge_assistant/confirm_stock", template_id: group.template_id };
      if (group.unit && amount != null && !Number.isNaN(amount)) { msg.amount = amount; msg.unit = f.unit || group.unit; }
      await this._hass.callWS(msg);
      this._notice = { key: group.key, text: `${group.name}: checked` };
      this._form = null; this._open = null;
      await this._restock();
    } catch (err) {
      this._notice = { key: group.key, text: `Couldn't save it: ${err.message || err}`, bad: true };
    } finally {
      this._busy = false; this._render();
    }
  }

  async _mark(group, state) {
    try {
      const res = await this._hass.callWS({
        type: "fridge_assistant/set_shopping_mark", key: group.key, state,
        sticky: state === "have" && !group.unit,
      });
      this._marks = res.marks || {};
      this._open = null;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._render();
  }

  /* Split every group into its Need / Added / Have rows. */
  _rows() {
    const need = []; const check = []; const have = []; const added = [];
    for (const g of this._groups || []) {
      const mark = this._marks[g.key];
      const other = Object.entries(g.other || {}).map(([u, q]) => amountText(q, u)).filter(Boolean);
      const measured = Boolean(g.unit) && (g.need > 0 || other.length > 0);
      let missing = "";     // what to get ("" = nothing)
      let covered = "";     // what stock covers ("" = nothing)
      if (!g.tracked) {
        // Not in Fridge Assistant (spices, say): always to get unless marked.
        missing = other.join(" + ") || "to taste";
      } else if (!measured) {
        // Known food without amounts (or only "to taste"): stock or not.
        if (g.in_stock || (g.stock || 0) > 0) covered = "in stock"; else missing = other.join(" + ") || "some";
      } else {
        const parts = [];
        if (g.short > 0) parts.push(amountText(g.short, g.unit));
        parts.push(...other);
        missing = parts.join(" + ");
        if (g.have > 0) covered = amountText(g.have, g.unit);
      }
      const total = [g.unit && g.need ? amountText(g.need, g.unit) : "", ...other].filter(Boolean).join(" + ")
        || (g.to_taste ? "to taste" : "");
      const stock = g.stock != null ? amountText(g.stock, g.unit) || "none" : "";
      if (mark && mark.state === "have") { have.push({ g, text: total, marked: true, stock }); continue; }
      if (missing) (mark && mark.state === "added" ? added : need).push({ g, text: missing, stock });
      if (covered) (g.check && g.check.length ? check : have).push({ g, text: covered, stock });
    }
    return { need, check, have, added };
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .head { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 20px; font-weight: 600; flex: 1 1 auto; }
        .sub { color: var(--secondary-text-color); font-size: 14px; margin-top: 2px; }
        .refresh { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; padding: 6px; }
        .sec { margin-top: 20px; }
        .sec-h { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; margin-bottom: 4px;
          padding: 8px 12px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 14%, transparent);
          width: 100%; border: none; font-family: inherit; color: var(--primary-text-color); cursor: pointer; text-align: left; }
        .sec-h .chev { --mdc-icon-size: 20px; color: var(--secondary-text-color); transition: transform .2s; }
        .sec.shut .sec-h .chev { transform: rotate(-90deg); }
        .sec-h ha-icon { --mdc-icon-size: 20px; color: var(--accent); }
        .sec-h .count { margin-left: auto; margin-right: -2px; font-size: 13px; font-weight: 600; color: var(--accent);
          background: var(--card-background-color); border-radius: 999px; padding: 1px 9px; }
        .sec.need { --accent: var(--primary-color); }
        .sec.check { --accent: var(--warning-color, #e69500); }
        .sec.have { --accent: var(--success-color, #43a047); }
        .sec.added { --accent: var(--secondary-text-color); }
        .aisle { margin-top: 8px; }
        .aisle-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .05em; color: var(--secondary-text-color); padding: 6px 2px 2px;
          border-bottom: 2px solid color-mix(in srgb, var(--tint) 45%, transparent); }
        .row { border-bottom: 1px solid var(--divider-color); }
        .row:last-child { border-bottom: none; }
        .line { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 2px; text-align: left;
          font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
        .th { width: 36px; height: 36px; flex: 0 0 36px; border-radius: 10px; object-fit: contain; background: #fff; }
        .th.emo { display: flex; align-items: center; justify-content: center; font-size: 20px;
          background: color-mix(in srgb, var(--tint) 20%, transparent); }
        .line .n { flex: 1 1 auto; }
        .line .a { color: var(--secondary-text-color); font-size: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .sec.added .line .n { color: var(--secondary-text-color); text-decoration: line-through; }
        .sec.added .th, .sec.have .th { opacity: .75; }
        .progress { margin-top: 12px; }
        .countdown { margin-top: 10px; padding: 12px 14px; border-radius: 14px;
          background: var(--secondary-background-color); display: flex; align-items: center; gap: 12px; }
        .countdown ha-icon { --mdc-icon-size: 28px; color: var(--primary-color); }
        .countdown .big { font-size: 22px; font-weight: 700; line-height: 1.2; }
        .countdown .when { color: var(--secondary-text-color); font-size: 14px; }
        .countdown.now { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .countdown.now ha-icon, .countdown.now .when { color: inherit; }
        .bar { height: 8px; border-radius: 999px; background: var(--divider-color); overflow: hidden; }
        .bar span { display: block; height: 100%; background: var(--primary-color); border-radius: 999px; transition: width .3s; }
        .ptext { font-size: 13px; color: var(--secondary-text-color); margin-top: 4px; }
        .detail { padding: 0 2px 12px; }
        .meals { font-size: 14px; color: var(--secondary-text-color); display: flex; flex-direction: column; gap: 2px; }
        .meals span b { color: var(--primary-text-color); font-weight: 500; }
        .stockline { font-size: 13px; color: var(--secondary-text-color); margin-top: 6px; }
        .btns { display: flex; gap: 8px; margin-top: 10px; }
        .btns button { flex: 1 1 0; display: flex; align-items: center; justify-content: center; gap: 6px;
          font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; border-radius: 12px; padding: 9px 10px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .btns button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        .btns ha-icon { --mdc-icon-size: 18px; }
        .empty { color: var(--secondary-text-color); font-size: 14px; padding: 6px 2px; }
        .why { font-size: 13px; color: var(--warning-color, #c77700); margin-top: 6px; }
        .warn { margin-top: 12px; padding: 8px 12px; border-radius: 12px; font-size: 14px;
          background: rgba(255, 152, 0, .12); }
        .warn summary { cursor: pointer; display: flex; align-items: center; gap: 6px; }
        .warn ha-icon { --mdc-icon-size: 18px; color: var(--warning-color, #c77700); }
        .wrec { margin-top: 8px; }
        .wrec a { color: var(--primary-color); font-weight: 500; }
        .wrec ul { margin: 4px 0 0; padding-left: 18px; color: var(--secondary-text-color); }
        .haveform { margin-top: 10px; padding: 10px 12px; border-radius: 12px; background: var(--secondary-background-color); }
        .amtrow { display: flex; align-items: center; gap: 8px; font-size: 14px; }
        .amtrow span { flex: 1 1 auto; }
        .amtrow input { width: 80px; font: inherit; padding: 7px 9px; border-radius: 10px; text-align: right;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .amtrow select { font: inherit; padding: 6px; border-radius: 10px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .sub2 { font-size: 14px; margin-top: 10px; }
        .locs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 6px; }
        @media (min-width: 560px) { .locs { grid-template-columns: repeat(4, 1fr); } }
        .locs button { display: flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 14px;
          font-weight: 500; padding: 10px 6px; border-radius: 12px; cursor: pointer; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .locs button.sug { border: 2px solid var(--primary-color); }
        .locs ha-icon { --mdc-icon-size: 18px; }
        .links { display: flex; justify-content: space-between; margin-top: 8px; }
        .link { background: none; border: none; padding: 4px 0; font: inherit; font-size: 13px; color: var(--secondary-text-color);
          cursor: pointer; text-decoration: underline; }
        .notice { font-size: 13px; padding: 8px 2px 0; color: var(--success-color, #43a047); }
        .notice.bad { color: var(--error-color); }
        .err { margin-top: 12px; color: var(--error-color); font-size: 14px; }
      </style>
      <ha-card><div id="body"></div></ha-card>`;
    const body = root.getElementById("body");
    const onField = (ev) => {
      if (!this._form || !ev.target.dataset.field) return;
      this._form[ev.target.dataset.field] = ev.target.value;
    };
    body.addEventListener("input", onField);
    body.addEventListener("change", onField);
    body.addEventListener("toggle", (ev) => {
      if (ev.target.classList && ev.target.classList.contains("warn")) this._warnOpen = ev.target.open;
    }, true);
    body.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "refresh") { this._load(true); return; }
      if (btn.dataset.act === "sec") {
        const key = btn.dataset.sec;
        if (this._collapsed.has(key)) this._collapsed.delete(key); else this._collapsed.add(key);
        try { localStorage.setItem("fridge-assistant-shopping-collapsed", JSON.stringify([...this._collapsed])); } catch (e) { /* fine */ }
        this._render();
        return;
      }
      if (btn.dataset.act === "prev" || btn.dataset.act === "next") {
        this._offset += btn.dataset.act === "next" ? 1 : -1;
        this._groups = null; this._open = null;
        this._load(true);
        return;
      }
      const group = (this._groups || []).find((g) => g.key === btn.dataset.key);
      if (!group) return;
      const rowId = `${btn.dataset.sec}|${group.key}`;
      if (btn.dataset.act === "toggle") { this._open = this._open === rowId ? null : rowId; this._form = null; this._notice = null; this._render(); }
      if (this._busy) return;
      else if (btn.dataset.act === "added") this._mark(group, "added");
      else if (btn.dataset.act === "have") this._openHave(group);
      else if (btn.dataset.act === "havewhere") this._have(group, btn.dataset.loc);
      else if (btn.dataset.act === "cancelhave") { this._form = null; this._render(); }
      else if (btn.dataset.act === "need") this._mark(group, null);
      else if (btn.dataset.act === "gone") this._backToNeed(group);
      else if (btn.dataset.act === "still") {
        this._form = { key: group.key, amount: group.stock != null ? String(group.stock) : "", unit: group.unit };
        this._notice = null;
        this._render();
      } else if (btn.dataset.act === "confirm") this._confirm(group);
    });
  }

  _rowHtml(sec, row) {
    const g = row.g;
    const rowId = `${sec}|${g.key}`;
    const open = this._open === rowId;
    const k = esc(g.key);
    let detail = "";
    if (open) {
      const meals = g.sources.map((s) => {
        const amt = s.quantity ? amountText(s.quantity, s.unit) : "";
        return `<span>${esc(s.source || s.food)}${amt ? ` — <b>${esc(amt)}</b>` : ""}</span>`;
      }).join("");
      const b = (act, label, icon, primary) =>
        `<button data-act="${act}" data-key="${k}" data-sec="${sec}" class="${primary ? "primary" : ""}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
      let btns = "";
      if (sec === "need") btns = b("added", "Added", "mdi:basket-plus-outline", true) + b("have", "Have", "mdi:check");
      else if (sec === "check") btns = b("still", "Still there", "mdi:check", true) + (g.unit && g.have > 0 ? b("gone", "Need", "mdi:cart-arrow-down") : "");
      else if (sec === "added") btns = b("have", "Have", "mdi:check") + b("need", "Back to Need", "mdi:undo");
      else if (row.marked) btns = b("need", "Back to Need", "mdi:undo");
      else if (g.unit && g.have > 0) btns = b("gone", "Need", "mdi:cart-arrow-down");
      const kept = g.reserved > 0 && g.unit ? ` · ${esc(amountText(g.reserved, g.unit))} kept for meals before then` : "";
      const stock = row.stock ? `<div class="stockline">In stock: ${esc(row.stock)}${kept}</div>` : "";
      const why = sec === "check" && g.check ? `<div class="why">${esc(checkText(g))}</div>` : "";
      const gone = (sec === "have" || sec === "check") && !row.marked && g.unit && g.have > 0
        ? `<div class="stockline">Need takes ${esc(amountText(g.have, g.unit))} out of Fridge Assistant.</div>` : "";
      const form = this._form && this._form.key === g.key && (sec === "need" || sec === "added") ? this._haveFormHtml(g, sec)
        : this._form && this._form.key === g.key && sec === "check" ? this._stillFormHtml(g, sec) : "";
      detail = `<div class="detail"><div class="meals">${meals}</div>${why}${stock}${gone}${form || (btns ? `<div class="btns">${btns}</div>` : "")}</div>`;
    }
    const note = this._notice && this._notice.key === g.key
      ? `<div class="notice ${this._notice.bad ? "bad" : ""}">${esc(this._notice.text)}</div>` : "";
    const aisle = aisleOf(g);
    const thumb = g.photo
      ? `<img class="th" src="${esc(g.photo)}" alt="" loading="lazy">`
      : `<span class="th emo" style="--tint:${aisle.color}">${esc((g.emoji && g.emoji !== "🍽️" ? g.emoji : null) || foodEmoji(g.name) || aisle.emoji)}</span>`;
    return `${note}<div class="row">
      <button class="line" data-act="toggle" data-key="${k}" data-sec="${sec}" aria-expanded="${open}">
        ${thumb}<span class="n">${esc(g.name)}</span><span class="a">${esc(row.text)}</span>
      </button>${detail}</div>`;
  }

  _recipeLink(slug) {
    const base = String(this._config.mealie_url || "").replace(/\/+$/, "");
    return base ? `${base}/g/${encodeURIComponent(this._config.group || "home")}/r/${encodeURIComponent(slug)}` : "#";
  }

  /* Only the countdown box, so the rest of the list (and anything being
   * typed into it) isn't redrawn every half minute. */
  _renderCountdown() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("countdown");
    if (box) box.innerHTML = this._countdownHtml();
  }

  /* How long is left to finalise the shopping: the order's edit deadline. */
  _countdownHtml() {
    const st = this._deadlineState;
    if (!st) return "";
    const deadline = new Date(st.state);
    if (Number.isNaN(deadline.getTime())) return "";
    const now = Date.now();
    const t = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dayOf = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    let delivery = "";
    const dv = this._deliveryState;
    const start = dv ? new Date(dv.state) : null;
    if (start && !Number.isNaN(start.getTime()) && start > deadline) {
      const w = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec((dv.attributes && dv.attributes.delivery_window) || "");
      delivery = ` · delivery ${dayOf(start)}, ${w ? `${w[1]}–${w[2]}` : t(start)}`;
    }
    // Only on the list for the week this order feeds.
    const arrives = delivery ? start : deadline;
    const shown = this._week || shoppingWeek(this._config.week_start, this._config.plan_day, this._offset);
    if (isoDate(orderWeekStart(arrives, this._config.week_start)) !== isoDate(shown.start)) return "";
    let cls = "", icon = "mdi:cart-arrow-right", big, when;
    if (now < deadline.getTime()) {
      const left = deadline.getTime() - now;
      if (left <= URGENT_MS) { cls = " now"; icon = "mdi:cart-clock"; }
      big = `Finalise in ${untilText(left)}`;
      when = `Order closes ${dayOf(deadline)}, ${t(deadline)}${delivery}`;
    } else {
      icon = "mdi:cart-check";
      big = "Order finalised";
      when = `Closed ${dayOf(deadline)}, ${t(deadline)}${delivery}`;
    }
    return `<div class="countdown${cls}"><ha-icon icon="${icon}"></ha-icon>
      <div><div class="big">${esc(big)}</div><div class="when">${esc(when)}</div></div></div>`;
  }

  /* Notes are edited on Mealie's meal planner. */
  _plannerLink() {
    const base = String(this._config.mealie_url || "").replace(/\/+$/, "");
    return base ? `${base}/household/mealplan/planner/edit` : "#";
  }

  _stillFormHtml(g, sec) {
    const f = this._form;
    const k = esc(g.key);
    const units = g.unit ? this._unitsFor(g) : [];
    return `<div class="haveform">
      ${g.unit ? `<div class="amtrow"><span>How much is there?</span>
        <input data-field="amount" type="number" inputmode="decimal" min="0" step="any" value="${esc(f.amount)}">
        <select data-field="unit">${units.map((u) => `<option value="${esc(u)}"${u === f.unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
      </div>` : ""}
      <div class="btns">
        <button class="primary" data-act="confirm" data-key="${k}" data-sec="${sec}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:check"></ha-icon>That's right</button>
        <button data-act="cancelhave" data-key="${k}" data-sec="${sec}">Cancel</button>
      </div>
    </div>`;
  }

  _haveFormHtml(g, sec) {
    const f = this._form;
    const k = esc(g.key);
    const units = this._unitsFor(g);
    if (g.in_stock) {
      // Some is already in stock: this is the total, saved where it already is.
      return `<div class="haveform">
      <div class="amtrow"><span>How much is there in total?</span>
        <input data-field="amount" type="number" inputmode="decimal" min="0" step="any" value="${esc(f.amount)}" placeholder="?">
        <select data-field="unit">${units.map((u) => `<option value="${esc(u)}"${u === f.unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
      </div>
      <div class="btns">
        <button class="primary" data-act="havewhere" data-loc="" data-key="${k}" data-sec="${sec}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:check"></ha-icon>Save</button>
        <button data-act="cancelhave" data-key="${k}" data-sec="${sec}">Cancel</button>
      </div>
    </div>`;
    }
    const locs = [["cupboard", "Cupboard", "mdi:cupboard-outline"], ["fridge", "Fridge", "mdi:fridge"],
      ["freezer", "Freezer", "mdi:snowflake"], ["pantry", "Pantry", "mdi:basket-outline"]];
    return `<div class="haveform">
      <div class="amtrow"><span>How much do you have?</span>
        <input data-field="amount" type="number" inputmode="decimal" min="0" step="any" value="${esc(f.amount)}" placeholder="?">
        <select data-field="unit">${units.map((u) => `<option value="${esc(u)}"${u === f.unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
      </div>
      <div class="sub2">Where is it?</div>
      <div class="locs">${locs.map(([key, label, icon]) => `<button data-act="havewhere" data-loc="${key}" data-key="${k}" data-sec="${sec}"
        class="${g.location === key ? "sug" : ""}" ${this._busy ? "disabled" : ""}><ha-icon icon="${icon}"></ha-icon>${label}</button>`).join("")}</div>
      <div class="links">
        <button class="link" data-act="cancelhave" data-key="${k}" data-sec="${sec}">Cancel</button>
      </div>
    </div>`;
  }

  _render() {
    if (!this.shadowRoot) return;
    const body = this.shadowRoot.getElementById("body");
    const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const w = this._week || shoppingWeek(this._config.week_start, this._config.plan_day, this._offset);
    const which = `${weekName(w.start, this._config.week_start)} · `;
    const count = this._groups ? ` · ${this._mealCount} meal${this._mealCount === 1 ? "" : "s"}` : "";
    const sub = `${which}${fmtDay(isoDate(w.start))} – ${fmtDay(isoDate(w.end))}${count}`;
    const head = `<div class="head"><div class="title">${esc(this._config.title)}</div>
      <button class="refresh" data-act="prev" title="Week before"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <button class="refresh" data-act="next" title="Week after"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      <button class="refresh" data-act="refresh" title="Refresh"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
      <div class="sub">${esc(sub)}</div>
      <div id="countdown">${this._countdownHtml()}</div>`;
    if (!this._groups) {
      body.innerHTML = head + (this._error ? `<div class="err">${esc(this._error)}</div>` : `<div class="empty">Loading…</div>`);
      return;
    }
    const { need, check, have, added } = this._rows();
    const byAisle = (key, rows) => AISLES.map((a) => {
      const these = rows.filter((r) => aisleOf(r.g) === a);
      return these.length ? `<div class="aisle"><div class="aisle-h" style="--tint:${a.color}"><span>${a.emoji}</span>${esc(a.name)}</div>
        ${these.map((r) => this._rowHtml(key, r)).join("")}</div>` : "";
    }).join("");
    const ICONS = { need: "mdi:cart-outline", check: "mdi:magnify", have: "mdi:check-circle-outline", added: "mdi:basket-check-outline" };
    const section = (key, label, rows, empty) => {
      const shut = this._collapsed.has(key);
      return `<div class="sec ${key}${shut ? " shut" : ""}">
      <button class="sec-h" data-act="sec" data-sec="${key}" aria-expanded="${!shut}">
        <ha-icon icon="${ICONS[key]}"></ha-icon><b>${label}</b><span class="count">${rows.length}</span>
        <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></button>
      ${shut ? "" : rows.length ? byAisle(key, rows) : `<div class="empty">${empty}</div>`}
    </div>`;
    };
    const toGet = need.length + added.length;
    const progress = toGet ? `<div class="progress"><div class="bar"><span style="width:${Math.round(added.length / toGet * 100)}%"></span></div>
      <div class="ptext">${added.length} of ${toGet} in the basket${check.length ? ` · ${check.length} to check` : ""}</div></div>` : "";
    const warn = (this._warnings || []).length ? `<details class="warn"${this._warnOpen ? " open" : ""}><summary><ha-icon icon="mdi:alert-outline"></ha-icon>
        ${this._warnings.length} ${this._warnings.every((w) => w.note) ? "note" : this._warnings.some((w) => w.note) ? "recipe or note" : "recipe"}${this._warnings.length === 1 ? "" : "s"} to tidy in Mealie, so the list is right</summary>
        ${this._warnings.map((w) => `<div class="wrec"><a href="${esc(w.note ? this._plannerLink() : this._recipeLink(w.slug))}" target="_blank" rel="noopener">${esc(w.name)}</a>
          <ul>${w.issues.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`).join("")}</details>` : "";
    body.innerHTML = head + progress + warn
      + section("need", "Need", need, "Nothing else to get.")
      + section("check", "Check", check, "Nothing to check.")
      + section("have", "Have", have, "Nothing from stock yet.")
      + section("added", "Added", added, "Nothing in the basket yet.")
      + (this._error ? `<div class="err">${esc(this._error)}</div>` : "");
  }
}

if (!customElements.get("fridge-assistant-shopping-card")) {
  customElements.define("fridge-assistant-shopping-card", FridgeAssistantShoppingCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-shopping-card",
    name: "Fridge Assistant shopping list",
    description: "The coming week's Mealie meal plan as Need, Added and Have.",
  });
}

/* ---- Use it up card ---------------------------------------------------------
 *
 * For planning the week: what in Fridge Assistant should be used soon —
 * going off within `days`, opened packs, cooked leftovers waiting — and the
 * Mealie recipes that use it, best matches first (the recipes using most of
 * those things). Recipes open in Mealie. Mealie's recipes are read once a day
 * and kept in the browser.
 *
 *   type: custom:fridge-assistant-use-up-card
 *   mealie_url: https://mealie.example
 *   mealie_entry: 01ABC...   # optional
 *   days: 10                 # "going off soon" means within this many days
 */

const RECIPE_INDEX_KEY = "fridge-assistant-recipe-index-v1";
const RECIPE_INDEX_TTL = 24 * 60 * 60 * 1000;

class FridgeAssistantUseUpCard extends HTMLElement {
  static getStubConfig() { return { mealie_url: "http://mealie.local:9000", days: 10 }; }

  setConfig(config) {
    this._config = { days: 10, group: "home", title: "Use it up", ...config };
    this._config.mealie_url = String(this._config.mealie_url || "").replace(/\/+$/, "");
    this._state = this._state || null;
    this._index = this._index || null;
    if (this.shadowRoot) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    if (first) { this._subscribe(); this._loadIndex(); }
  }

  getCardSize() { return 6; }

  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  connectedCallback() { if (this._hass) { this._subscribe(); } }

  disconnectedCallback() {
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  _subscribe() {
    if (!this._hass || this._unsub || !this.isConnected) return;
    this._unsub = this._hass.connection.subscribeMessage((state) => {
      this._state = state;
      this._match();
    }, { type: "fridge_assistant/subscribe" }).catch((err) => {
      this._unsub = null; this._error = err.message || String(err); this._render(); return null;
    });
  }

  /* Every recipe's foods, read from Mealie once a day. */
  async _loadIndex(force = false) {
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(RECIPE_INDEX_KEY) || "null");
        if (cached && Date.now() - cached.at < RECIPE_INDEX_TTL) { this._index = cached.recipes; this._match(); return; }
      } catch (e) { /* no cache */ }
    }
    try {
      const entry = await mealieEntryId(this._hass, this._config.mealie_entry);
      const call = (service, data) => this._hass.callWS({
        type: "call_service", domain: "mealie", service,
        service_data: { config_entry_id: entry, ...data }, return_response: true,
      }).then((r) => r.response);
      const list = ((await call("get_recipes", { result_limit: 1000 })).recipes || {}).items || [];
      const recipes = [];
      this._progress = [0, list.length];
      this._render();
      const queue = [...list];
      const worker = async () => {
        while (queue.length) {
          const r = queue.shift();
          try {
            const full = (await call("get_recipe", { recipe_id: r.slug })).recipe;
            recipes.push({
              slug: full.slug, name: full.name, recipe_id: full.recipe_id, image: full.image,
              foods: [...new Set((full.ingredients || []).filter((i) => i.food).map((i) => String(i.food.name).toLowerCase()))],
            });
          } catch (e) { /* skip that recipe */ }
          this._progress = [this._progress[0] + 1, list.length];
          if (this._progress[0] % 10 === 0) this._render();
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
      this._progress = null;
      this._index = recipes;
      try { localStorage.setItem(RECIPE_INDEX_KEY, JSON.stringify({ at: Date.now(), recipes })); } catch (e) { /* full */ }
      this._match();
    } catch (err) {
      this._progress = null;
      this._error = `Couldn't read the recipes: ${err.message || err}`;
      this._render();
    }
  }

  /* Things worth using up, and the recipes that use their foods. */
  async _match() {
    if (!this._state || !this._index) { this._render(); return; }
    const days = Number(this._config.days) || 10;
    const things = [];
    for (const item of this._state.items || []) {
      const reasons = [];
      if (item.kind === "dish") {
        const open = (item.portions || []).filter((p) => p.status === "open").length || 1;
        reasons.push(`${open} portion${open === 1 ? "" : "s"} in the ${item.location}`);
        things.push({ item, kind: "leftover", reasons, sort: item.days_left ?? 999 });
        continue;
      }
      if (item.days_left != null && item.days_left <= days) {
        reasons.push(item.days_left < 0 ? "past its date" : item.days_left === 0 ? "use today"
          : `use within ${item.days_left} day${item.days_left === 1 ? "" : "s"}`);
      }
      if (item.amount != null && item.amount_initial && item.amount < item.amount_initial * 0.98) reasons.push("opened");
      if (reasons.length && item.template_id) things.push({ item, kind: "ingredient", reasons, sort: item.days_left ?? 500 });
    }
    // Which template each recipe food is, using the same matching as recipes.
    const key = this._index.map((r) => r.slug).join("|");
    if (this._foodKey !== key) {
      const lines = [];
      for (const r of this._index) for (const food of r.foods) lines.push({ food, quantity: 0, source: r.slug });
      try {
        const res = await this._hass.callWS({ type: "fridge_assistant/stock_check", lines });
        const byTemplate = new Map();
        for (const g of res.groups) {
          if (!g.template_id) continue;
          byTemplate.set(g.template_id, new Set(g.sources.map((s) => s.source)));
        }
        this._byTemplate = byTemplate;
        this._foodKey = key;
      } catch (err) {
        this._error = err.message || String(err);
      }
    }
    const recipeBySlug = new Map(this._index.map((r) => [r.slug, r]));
    for (const t of things) {
      t.recipes = t.kind === "ingredient"
        ? [...((this._byTemplate && this._byTemplate.get(t.item.template_id)) || [])].map((s) => recipeBySlug.get(s)).filter(Boolean)
        : [];
    }
    // Recipes ranked by how many of those ingredients they'd use up.
    const score = new Map();
    for (const t of things) {
      for (const r of t.recipes) {
        const e = score.get(r.slug) || { recipe: r, uses: new Set(), soonest: 999 };
        e.uses.add(t.item.name);
        e.soonest = Math.min(e.soonest, t.item.days_left ?? 999);
        score.set(r.slug, e);
      }
    }
    this._best = [...score.values()].sort((a, b) => b.uses.size - a.uses.size || a.soonest - b.soonest).slice(0, 6);
    this._things = things.sort((a, b) => a.sort - b.sort);
    this._render();
  }

  _link(slug) {
    return this._config.mealie_url ? `${this._config.mealie_url}/g/${encodeURIComponent(this._config.group)}/r/${encodeURIComponent(slug)}` : "#";
  }

  _image(r) {
    return r.image && this._config.mealie_url
      ? `${this._config.mealie_url}/api/media/recipes/${r.recipe_id}/images/min-original.webp?version=${encodeURIComponent(r.image)}` : "";
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .head { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 20px; font-weight: 600; flex: 1 1 auto; }
        .sub { color: var(--secondary-text-color); font-size: 14px; margin-top: 2px; }
        .refresh { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; padding: 6px; }
        .sec-h { margin-top: 16px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
          color: var(--secondary-text-color); font-weight: 600; }
        .best { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-top: 8px; }
        .rc { display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; text-decoration: none;
          color: inherit; background: var(--secondary-background-color); }
        .rc .img { height: 84px; background: var(--divider-color) center/cover no-repeat; }
        .rc .t { padding: 8px 10px 2px; font-weight: 500; font-size: 14px; line-height: 1.25; }
        .rc .u { padding: 0 10px 8px; font-size: 12px; color: var(--secondary-text-color); }
        .thing { padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
        .thing:last-child { border-bottom: none; }
        .tl { display: flex; align-items: baseline; gap: 10px; }
        .tl .n { flex: 1 1 auto; font-weight: 500; }
        .tl .w { font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
        .tl .w.soon { color: var(--warning-color, #c77700); }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
        .chips a { font-size: 13px; padding: 4px 10px; border-radius: 999px; text-decoration: none;
          background: var(--secondary-background-color); color: var(--primary-text-color); }
        .none { font-size: 13px; color: var(--secondary-text-color); margin-top: 4px; }
        .empty { color: var(--secondary-text-color); font-size: 14px; margin-top: 12px; }
        .err { margin-top: 12px; color: var(--error-color); font-size: 14px; }
      </style>
      <ha-card><div id="body"></div></ha-card>`;
    root.getElementById("body").addEventListener("click", (ev) => {
      if (ev.target.closest("[data-act=refresh]")) { this._index = null; this._foodKey = null; this._loadIndex(true); }
    });
  }

  _render() {
    if (!this.shadowRoot) return;
    const body = this.shadowRoot.getElementById("body");
    const head = `<div class="head"><div class="title">${esc(this._config.title)}</div>
      <button class="refresh" data-act="refresh" title="Read the recipes again"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
      <div class="sub">What to use soon, and recipes that use it</div>`;
    if (!this._state || !this._index || !this._things) {
      const p = this._progress ? `Reading recipes… ${this._progress[0]} of ${this._progress[1]}` : "Loading…";
      body.innerHTML = head + (this._error ? `<div class="err">${esc(this._error)}</div>` : `<div class="empty">${p}</div>`);
      return;
    }
    if (!this._things.length) {
      body.innerHTML = head + `<div class="empty">Nothing needs using up right now.</div>`;
      return;
    }
    const best = this._best.length ? `<div class="sec-h">Good fits</div><div class="best">${this._best.map((e) => `
      <a class="rc" href="${esc(this._link(e.recipe.slug))}" target="_blank" rel="noopener">
        <div class="img" style="${this._image(e.recipe) ? `background-image:url('${esc(this._image(e.recipe))}')` : ""}"></div>
        <div class="t">${esc(e.recipe.name)}</div>
        <div class="u">Uses ${esc([...e.uses].join(", "))}</div></a>`).join("")}</div>` : "";
    const row = (t) => {
      const soon = t.item.days_left != null && t.item.days_left <= 3;
      const chips = t.kind === "leftover" ? `<div class="none">Already cooked: plan it in as a meal.</div>`
        : t.recipes.length ? `<div class="chips">${t.recipes.slice(0, 6).map((r) =>
          `<a href="${esc(this._link(r.slug))}" target="_blank" rel="noopener">${esc(r.name)}</a>`).join("")}</div>`
          : `<div class="none">No recipe uses it.</div>`;
      return `<div class="thing"><div class="tl"><span class="n">${esc(t.item.name)}</span>
        <span class="w ${soon ? "soon" : ""}">${esc(t.reasons.join(" · "))}</span></div>${chips}</div>`;
    };
    const leftovers = this._things.filter((t) => t.kind === "leftover");
    const ingredients = this._things.filter((t) => t.kind === "ingredient");
    body.innerHTML = head + best
      + (ingredients.length ? `<div class="sec-h">Use soon</div>${ingredients.map(row).join("")}` : "")
      + (leftovers.length ? `<div class="sec-h">Leftovers</div>${leftovers.map(row).join("")}` : "")
      + (this._error ? `<div class="err">${esc(this._error)}</div>` : "");
  }
}

if (!customElements.get("fridge-assistant-use-up-card")) {
  customElements.define("fridge-assistant-use-up-card", FridgeAssistantUseUpCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-use-up-card",
    name: "Fridge Assistant use it up",
    description: "What to use soon from Fridge Assistant, with the Mealie recipes that use it.",
  });
}

/* ---- Week plan card -----------------------------------------------------------
 *
 * The plan tab in one card: a week of the Mealie meal plan (weeks start on
 * `week_start`), one day card each, with arrows to the weeks before and
 * after. A week with nothing planned shows the Use it up suggestions instead
 * (what's going off, opened, leftovers in the freezer, and recipes that use
 * them); a planned week has them a tap away at the bottom.
 *
 *   type: custom:fridge-assistant-week-plan-card
 *   mealie_url: https://mealie.example
 *   mealie_entry: 01ABC...
 *   week_start: saturday
 *   todo_entity: todo.planned_meals
 *   script: script.cook_planned_meal
 *   days: 10                 # Use it up: "going off soon" window
 */

class FridgeAssistantWeekPlanCard extends HTMLElement {
  static getStubConfig() { return { mealie_url: "http://mealie.local:9000", week_start: "saturday" }; }

  setConfig(config) {
    if (!config || !config.mealie_url) throw new Error("Set mealie_url (e.g. http://192.168.1.10:9925)");
    this._config = { title: "Meal plan", week_start: "saturday", group: "home", todo_entity: "todo.planned_meals",
      script: "script.cook_planned_meal", days: 10, ...config };
    this._offset = this._offset || 0;
    this._days = this._days || new Map();
    if (this.shadowRoot) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    for (const card of this._days.values()) card.hass = hass;
    if (this._useUp) this._useUp.hass = hass;
    if (first) this._load();
  }

  getCardSize() { return 12; }

  connectedCallback() {
    if (this._hass) this._load();
    if (!this._tick) this._tick = scheduleRefresh(() => this._load());
  }

  disconnectedCallback() {
    if (this._tick) { this._tick(); this._tick = null; }
  }

  _week() {
    // This week (the one today is in), moved by the arrows.
    const w = shoppingWeek(this._config.week_start, this._config.week_start, this._offset);
    return w;
  }

  async _load() {
    if (!this._hass) return;
    const w = this._week();
    const key = `${isoDate(w.start)}|${this._offset}`;
    try {
      const plan = await fetchPlanRange(this._hass, this._config.mealie_entry, isoDate(w.start), isoDate(w.end));
      if (key !== `${isoDate(this._week().start)}|${this._offset}`) return;   // moved on meanwhile
      this._plan = plan;
      this._error = null;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._render();
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; }
        ha-card.bar { padding: 16px; margin-bottom: 12px; }
        .head { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 20px; font-weight: 600; flex: 1 1 auto; }
        .sub { color: var(--secondary-text-color); font-size: 14px; margin-top: 2px; }
        .refresh { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; padding: 6px; }
        .days { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; align-items: start; }
        .days > .past { opacity: .6; }
        .empty { padding: 4px 16px 16px; color: var(--secondary-text-color); }
        .more { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }
        .lead { margin: 0 0 12px; }
        /* Mealie's look: its orange, its icon. */
        .more > a.plan { align-self: center; width: auto; border: none; border-radius: 20px; padding: 8px 16px 8px 8px;
          background: #E58325; color: #fff; font-size: 15px; gap: 8px; }
        .more > a.plan img { width: 22px; height: 22px; padding: 3px; border-radius: 50%; background: #fff; }
        .more > button, .more > a { box-sizing: border-box; text-decoration: none; width: 100%; padding: 12px; border-radius: 12px; border: 1px dashed var(--divider-color);
          background: none; color: var(--primary-text-color); font: inherit; font-weight: 500; cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 8px; }
        .more ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
        .useup { margin-top: 12px; }
        .err { color: var(--error-color); padding: 8px 4px; }
      </style>
      <ha-card class="bar" id="bar"></ha-card>
      <div id="msg"></div>
      <div class="days" id="days"></div>
      <div class="more" id="more"></div>
      <div class="useup" id="useup"></div>`;
    root.getElementById("bar").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "refresh") { this._load(); return; }
      this._offset += b.dataset.act === "next" ? 1 : -1;
      this._plan = null;
      this._showIdeas = false;
      this._render();
      this._load();
    });
    root.getElementById("more").addEventListener("click", (ev) => {
      if (!ev.target.closest("[data-act=ideas]")) return;
      this._showIdeas = !this._showIdeas;
      this._render();
    });
  }

  _dayCard(dateIso) {
    if (!this._days.has(dateIso)) {
      const card = document.createElement("fridge-assistant-meal-plan-card");
      card.setConfig({
        date: dateIso, mealie_url: this._config.mealie_url, group: this._config.group,
        mealie_entry: this._config.mealie_entry, todo_entity: this._config.todo_entity,
        script: this._config.script, label_location: this._config.label_location,
      });
      if (this._hass) card.hass = this._hass;
      this._days.set(dateIso, card);
    }
    return this._days.get(dateIso);
  }

  _render() {
    if (!this.shadowRoot) return;
    const root = this.shadowRoot;
    const w = this._week();
    const fmt = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    // Same header as the shopping list.
    const which = `${weekName(w.start, this._config.week_start)} · `;
    const meals = (this._plan || []).filter((e) => e.recipe).length;
    const count = this._plan ? ` · ${meals} meal${meals === 1 ? "" : "s"}` : "";
    // Mealie's planner, editing this same week.
    const base = String(this._config.mealie_url).replace(/\/+$/, "");
    const planUrl = `${base}/household/mealplan/planner/edit?start=${isoDate(w.start)}&end=${isoDate(w.end)}`;
    root.getElementById("bar").innerHTML = `<div class="head"><div class="title">${esc(this._config.title)}</div>
      <button class="refresh" data-act="prev" title="Week before"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <button class="refresh" data-act="next" title="Week after"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      <button class="refresh" data-act="refresh" title="Refresh"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
      <div class="sub">${esc(`${which}${fmt(w.start)} – ${fmt(w.end)}${count}`)}</div>`;
    const days = root.getElementById("days");
    const msg = root.getElementById("msg");
    const more = root.getElementById("more");
    const useup = root.getElementById("useup");
    if (this._error) { msg.innerHTML = `<div class="err">${esc(this._error)}</div>`; return; }
    if (this._plan == null) { msg.innerHTML = `<div class="empty">Loading…</div>`; days.replaceChildren(); more.innerHTML = ""; return; }
    const planned = this._plan.length > 0;
    const mealieBtn = `<a class="plan" href="${esc(planUrl)}" target="_blank" rel="noopener"><img src="${esc(base)}/icons/android-chrome-192x192.png" alt=""
      onerror="this.style.display='none'">Plan in Mealie</a>`;
    msg.innerHTML = planned ? "" : `<div class="more lead">${mealieBtn}</div>
      <div class="empty">Nothing planned for ${esc(weekName(w.start, this._config.week_start).toLowerCase())} yet. Here's what could do with using up, and recipes that use it.</div>`;
    // Day cards, reused while the week stays the same.
    const dates = Array.from({ length: 7 }, (_, i) => isoDate(addDays(w.start, i)));
    for (const key of [...this._days.keys()]) if (!dates.includes(key)) this._days.delete(key);
    if (planned) {
      const cards = dates.map((d) => {
        const c = this._dayCard(d);
        c.plan = this._plan;
        return c;
      });
      days.replaceChildren(...cards);
    } else {
      days.replaceChildren();
    }
    const showIdeas = !planned || this._showIdeas;
    more.innerHTML = planned ? `${mealieBtn}<button data-act="ideas"><ha-icon icon="${this._showIdeas ? "mdi:chevron-up" : "mdi:lightbulb-on-outline"}"></ha-icon>
      ${this._showIdeas ? "Hide ideas" : "Ideas: what to use up, and leftovers in the freezer"}</button>` : "";
    if (showIdeas) {
      if (!this._useUp) {
        this._useUp = document.createElement("fridge-assistant-use-up-card");
        this._useUp.setConfig({ mealie_url: this._config.mealie_url, mealie_entry: this._config.mealie_entry,
          group: this._config.group, days: this._config.days, title: "Use it up" });
        if (this._hass) this._useUp.hass = this._hass;
      }
      if (useup.firstChild !== this._useUp) useup.replaceChildren(this._useUp);
    } else {
      useup.replaceChildren();
    }
  }
}

if (!customElements.get("fridge-assistant-week-plan-card")) {
  customElements.define("fridge-assistant-week-plan-card", FridgeAssistantWeekPlanCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-week-plan-card",
    name: "Fridge Assistant week plan",
    description: "A week of the Mealie meal plan by day, with use-it-up ideas when nothing's planned.",
  });
}
