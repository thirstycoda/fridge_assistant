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
 * Loose ingredients on the plan (notes such as "Avocado") get an "Eaten"
 * button that takes it out of Fridge Assistant: the amount at the start of
 * the note ("40 g cannellini beans", "½ avocado", "1 tin chickpeas"), or one
 * of the thing when there's none.
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
  if (!m || !m[3]) return { quantity: 1, unit: "each", food: raw };
  let q = m[1].toLowerCase().replace(",", ".");
  let quantity;
  if (q.startsWith("half")) quantity = 0.5;
  else if (q === "a" || q === "an") quantity = 1;
  else if (q.includes("/")) { const [a, b] = q.split("/").map(Number); quantity = b ? a / b : 1; }
  else {
    const frac = Object.keys(FRACTIONS).find((f) => q.includes(f));
    quantity = (parseFloat(q.replace(frac || "", "")) || 0) + (frac ? FRACTIONS[frac] : 0);
  }
  return { quantity: quantity || 1, unit: m[2] ? m[2].toLowerCase() : "each", food: m[3].trim() };
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

function dayLabel(offset, date) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
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

  connectedCallback() {
    this._onPlan = (plan) => { this._plan = plan; this._error = null; this._render(); };
    planListeners.add(this._onPlan);
    if (this._hass) { this._load(); this._subscribe(); }
    // Refresh now and then, and when the date rolls over.
    if (!this._tick) this._tick = setInterval(() => this._load(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    planListeners.delete(this._onPlan);
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  // ---- data -------------------------------------------------------------------

  _load(force = false) {
    if (!this._hass || !this._config) return;
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

  _date() { return addDays(new Date(), Number(this._config.day) || 0); }

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

  /* A loose ingredient on the plan (a note such as "Avocado") was eaten: take
   * one of it out of Fridge Assistant and record it on the to-do list so the
   * card remembers. */
  async _eaten(entry) {
    const id = String(entry.mealplan_id);
    const amount = parseAmount(entry.title);
    const food = amount.food;
    if (!food || this._busy.has(id) || this._done.has(id)) return;
    this._busy.add(id);
    this._notes.delete(id);
    this._render();
    try {
      const res = await this._hass.callWS({
        type: "call_service", domain: "fridge_assistant", service: "consume_ingredients",
        service_data: { ingredients: [{ food, quantity: amount.quantity, unit: amount.unit }] }, return_response: true,
      });
      const line = (res && res.response && res.response.lines && res.response.lines[0]) || {};
      const name = line.template || food;
      const unit = line.amount_unit;
      if (line.status === "taken" || line.status === "short") {
        const left = (line.taken || []).reduce((sum, t) => sum + (t.left || 0), 0);
        const took = unit === "each" ? `${fmtAmount(line.need, unit)} ${name.toLowerCase()}` : `${fmtAmount(line.need, unit)} of ${name.toLowerCase()}`;
        const rest = line.status === "short" ? " · that was the last of it"
          : left > 0 ? ` · ${fmtAmount(left, unit)} left in that pack` : " · that pack is finished";
        this._notes.set(id, { text: `Took ${took}${rest}` });
        await this._recordDone(entry, { eaten: true, at: new Date().toISOString() });
        this._done.set(id, { eaten: true });
        this._open = null;
      } else {
        const why = {
          untracked: `${food} isn't tracked in Fridge Assistant`,
          not_in_stock: `There's no ${name.toLowerCase()} in Fridge Assistant`,
          no_amount_tracked: `There's no ${name.toLowerCase()} in Fridge Assistant`,
          no_conversion: amount.unit === "each"
            ? `Fridge Assistant can't tell how much one ${name.toLowerCase()} is; put the amount in the plan, e.g. "40 g ${food.toLowerCase()}"`
            : `Fridge Assistant can't convert ${amount.unit} of ${name.toLowerCase()}`,
          no_quantity: "No amount to take",
        }[line.status] || `Nothing taken (${line.status || "unknown"})`;
        this._notes.set(id, { text: why, bad: true });
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
        .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 8px 10px; }
        .actions button { flex: 1 1 100px; display: flex; align-items: center; justify-content: center; gap: 6px;
          font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; border-radius: 12px; padding: 10px 8px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .actions button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        .actions button:disabled { opacity: .6; cursor: default; }
        .actions ha-icon { --mdc-icon-size: 20px; }
        .actions button.on { border-color: var(--primary-color); color: var(--primary-color); }
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
      const sub = done ? "Eaten" : entry.description || "";
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
        <button data-act="open" data-id="${id}"><ha-icon icon="mdi:open-in-new"></ha-icon>Open in Mealie</button>
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
    const offset = Number(this._config.day) || 0;
    const date = this._date();
    const entries = this._entries();
    // Notes that aren't a meal slot (e.g. a side note for one person) go below.
    const extras = entries.filter((e) => !e.recipe && !["breakfast", "lunch", "dinner"].includes(e.entry_type));
    const meals = entries.filter((e) => !extras.includes(e));
    const sections = SECTIONS.map((s) => ({ ...s, items: meals.filter((e) => SECTION_OF[e.entry_type] === s.key) }))
      .filter((s) => s.items.length);
    // Recipes before plain notes within a section.
    sections.forEach((s) => s.items.sort((a, b) => (b.recipe ? 1 : 0) - (a.recipe ? 1 : 0)));
    const head = `<div class="day">${esc(dayLabel(offset, date))}</div>
      ${offset <= 1 ? `<div class="date">${esc(date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</div>` : ""}`;
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
 * The coming week's meal plan as a shopping list in three sections:
 * Need (what the recipes use and stock doesn't cover), Added (in the basket)
 * and Have (covered by stock, or marked as had). Tap an ingredient to see the
 * meals it's for and move it between sections. Marks are shared by everyone
 * (kept by Fridge Assistant); marking an untracked ingredient (a spice, say)
 * as Have sticks until it's undone, a tracked one lapses after a week.
 *
 *   type: custom:fridge-assistant-shopping-card
 *   mealie_entry: 01ABC...           # optional, the Mealie config entry
 *   todo_entity: todo.planned_meals  # meals already made are left out
 *   ignore: [water]                  # foods never put on the list
 *   week_start: saturday             # the plan's weeks start on this day
 *   plan_day: thursday               # from this day on, show the coming week
 */

const PEPPERS = ["red pepper", "yellow pepper", "green pepper", "orange pepper", "sweet pepper", "bell pepper"];

/* Household rules shared with the cook script: peppers are romano peppers
 * (except in a lasagne) and vegetable stock is bouillon powder, 4 tsp a litre. */
function recipeLines(recipe, source, ignore) {
  const lasagna = /lasagn/i.test(recipe.name || "");
  const out = [];
  for (const i of recipe.ingredients || []) {
    if (!i.food) continue;
    let food = String(i.food.name || "").toLowerCase();
    let unit = i.unit ? i.unit.name : "";
    let quantity = i.quantity || 0;
    if (PEPPERS.includes(food) && !lasagna) food = "romano pepper";
    if (food === "vegetable stock") {
      const u = String(unit).toLowerCase();
      const ml = /^(ml|millilit(re|er)s?)$/.test(u) ? quantity : /^(l|lit(re|er)s?)$/.test(u) ? quantity * 1000 : 0;
      food = "vegetable bouillon powder"; unit = "teaspoon"; quantity = ml ? Math.max(Math.round(ml / 1000 * 4), 1) : 0;
    }
    if (ignore.has(food)) continue;
    out.push({ food, quantity, unit, source });
  }
  return out;
}

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
    if (this.shadowRoot) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    if (first) { this._subscribe(); this._load(); }
  }

  getCardSize() { return 8; }

  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  connectedCallback() {
    if (this._hass) { this._subscribe(); this._load(); }
    if (!this._tick) this._tick = setInterval(() => this._load(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  _subscribe() {
    if (!this._hass || this._unsub || !this.isConnected || !this._config.todo_entity) return;
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
      this._week = week;
      const ignore = new Set((this._config.ignore || []).map((x) => String(x).toLowerCase()));
      const lines = [];
      const meals = [];
      for (const e of plan) {
        if (this._done.has(String(e.mealplan_id))) continue;
        const day = new Date(`${e.mealplan_date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
        if (e.recipe) {
          meals.push(e);
          const recipe = await this._recipe(e.recipe.slug);
          lines.push(...recipeLines(recipe, `${recipe.name} · ${day}`, ignore));
        } else if (["breakfast", "lunch", "dinner"].includes(e.entry_type) && e.title) {
          const a = parseAmount(e.title);
          if (!ignore.has(a.food.toLowerCase())) {
            lines.push({ food: a.food.toLowerCase(), quantity: a.quantity, unit: a.unit === "each" ? "" : a.unit, source: `${e.title} · ${day}` });
          }
        }
      }
      const res = await this._hass.callWS({ type: "fridge_assistant/stock_check", lines });
      this._groups = res.groups;
      this._marks = res.marks || {};
      this._mealCount = meals.length;
      this._error = null;
      this._loadedOnce = true;
    } catch (err) {
      this._error = err.message || String(err);
    } finally {
      this._loading = false;
      this._render();
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
    const need = []; const added = []; const have = [];
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
      if (covered) have.push({ g, text: covered, stock });
    }
    return { need, added, have };
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
        .sec { margin-top: 18px; }
        .sec-h { display: flex; align-items: center; gap: 6px; font-size: 13px; text-transform: uppercase;
          letter-spacing: .04em; color: var(--secondary-text-color); margin-bottom: 4px; }
        .sec-h b { font-weight: 600; }
        .row { border-bottom: 1px solid var(--divider-color); }
        .row:last-child { border-bottom: none; }
        .line { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 10px 2px; text-align: left;
          font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
        .line .n { flex: 1 1 auto; }
        .line .a { color: var(--secondary-text-color); font-size: 14px; white-space: nowrap; }
        .sec.added .line .n, .sec.have .line .n { color: var(--secondary-text-color); }
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
        .err { margin-top: 12px; color: var(--error-color); font-size: 14px; }
      </style>
      <ha-card><div id="body"></div></ha-card>`;
    root.getElementById("body").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "refresh") { this._load(true); return; }
      if (btn.dataset.act === "prev" || btn.dataset.act === "next") {
        this._offset += btn.dataset.act === "next" ? 1 : -1;
        this._groups = null; this._open = null;
        this._load(true);
        return;
      }
      const group = (this._groups || []).find((g) => g.key === btn.dataset.key);
      if (!group) return;
      const rowId = `${btn.dataset.sec}|${group.key}`;
      if (btn.dataset.act === "toggle") { this._open = this._open === rowId ? null : rowId; this._render(); }
      else if (btn.dataset.act === "added") this._mark(group, "added");
      else if (btn.dataset.act === "have") this._mark(group, "have");
      else if (btn.dataset.act === "need") this._mark(group, null);
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
      else if (sec === "added") btns = b("have", "Have", "mdi:check") + b("need", "Back to Need", "mdi:undo");
      else if (row.marked) btns = b("need", "Back to Need", "mdi:undo");
      const stock = row.stock ? `<div class="stockline">In stock: ${esc(row.stock)}</div>` : "";
      detail = `<div class="detail"><div class="meals">${meals}</div>${stock}${btns ? `<div class="btns">${btns}</div>` : ""}</div>`;
    }
    return `<div class="row">
      <button class="line" data-act="toggle" data-key="${k}" data-sec="${sec}" aria-expanded="${open}">
        <span class="n">${esc(g.name)}</span><span class="a">${esc(row.text)}</span>
      </button>${detail}</div>`;
  }

  _render() {
    if (!this.shadowRoot) return;
    const body = this.shadowRoot.getElementById("body");
    const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const w = this._week || shoppingWeek(this._config.week_start, this._config.plan_day, this._offset);
    const which = this._offset === 0 ? "" : this._offset === 1 ? "the week after · " : this._offset === -1 ? "the week before · " : "";
    const count = this._groups ? ` · ${this._mealCount} meal${this._mealCount === 1 ? "" : "s"}` : "";
    const sub = `${which}${fmtDay(isoDate(w.start))} – ${fmtDay(isoDate(w.end))}${count}`;
    const head = `<div class="head"><div class="title">${esc(this._config.title)}</div>
      <button class="refresh" data-act="prev" title="Week before"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <button class="refresh" data-act="next" title="Week after"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      <button class="refresh" data-act="refresh" title="Refresh"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
      <div class="sub">${esc(sub)}</div>`;
    if (!this._groups) {
      body.innerHTML = head + (this._error ? `<div class="err">${esc(this._error)}</div>` : `<div class="empty">Loading…</div>`);
      return;
    }
    const { need, added, have } = this._rows();
    const section = (key, label, rows, empty) => `<div class="sec ${key}">
      <div class="sec-h"><b>${label}</b> · ${rows.length}</div>
      ${rows.length ? rows.map((r) => this._rowHtml(key, r)).join("") : `<div class="empty">${empty}</div>`}
    </div>`;
    body.innerHTML = head
      + section("need", "Need", need, "Nothing else to get.")
      + section("added", "Added", added, "Nothing in the basket yet.")
      + section("have", "Have", have, "Nothing from stock yet.")
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
