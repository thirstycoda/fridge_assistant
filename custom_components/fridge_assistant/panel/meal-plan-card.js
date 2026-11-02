/* Fridge Assistant — meal plan card.
 *
 * One day of a Mealie meal plan: Breakfast, Lunch and Dinner sections (each
 * only when something is planned), every meal with its picture and name. Tap
 * a meal for three buttons: "Open in Mealie" (the recipe, in a new tab or the
 * browser), "Made it", which runs a script that takes the recipe's
 * ingredients out of Fridge Assistant, and "Print label", which adds the
 * cooked meal to Fridge Assistant as a dish (choose how many portions, and
 * Freezer or Fridge) and prints a sticker for each portion. Meals already made show a tick.
 * Loose ingredients on the plan (notes such as "Avocado") get an "Eaten"
 * button that takes one of it out of Fridge Assistant.
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
    const food = String(entry.title || "").trim();
    if (!food || this._busy.has(id) || this._done.has(id)) return;
    this._busy.add(id);
    this._notes.delete(id);
    this._render();
    try {
      const res = await this._hass.callWS({
        type: "call_service", domain: "fridge_assistant", service: "consume_ingredients",
        service_data: { ingredients: [{ food, quantity: 1, unit: "each" }] }, return_response: true,
      });
      const line = (res && res.response && res.response.lines && res.response.lines[0]) || {};
      const name = line.template || food;
      const unit = line.amount_unit;
      if (line.status === "taken" || line.status === "short") {
        const left = (line.taken || []).reduce((sum, t) => sum + (t.left || 0), 0);
        const took = unit === "each" ? `1 ${name.toLowerCase()}` : `${fmtAmount(line.need, unit)} of ${name.toLowerCase()}`;
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
          no_conversion: `Fridge Assistant can't tell how much one ${name.toLowerCase()} is`,
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
    try {
      const added = await this._hass.callWS({
        type: "fridge_assistant/add_item",
        item: {
          name: r.name, contents: r.name, kind: "dish", location: where,
          portions: opts.portions,
          photo: this._imageUrl(r) || null,
          notes: this._config.label_notes || null,
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
      else if (btn.dataset.act === "label") { this._labelOpen = this._labelOpen === id ? null : id; this._printed.delete(id); this._render(); }
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
