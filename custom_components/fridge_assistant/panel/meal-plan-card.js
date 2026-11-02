/* Fridge Assistant — meal plan card.
 *
 * One day of a Mealie meal plan: Breakfast, Lunch and Dinner sections (each
 * only when something is planned), every meal with its picture and name. Tap
 * a meal for three buttons: "Open in Mealie" (the recipe, in a new tab or the
 * browser), "Made it", which runs a script that takes the recipe's
 * ingredients out of Fridge Assistant, and "Print label", which adds the
 * cooked meal to the fridge as a dish and prints its sticker for the
 * container. Meals already made show a tick.
 *
 *   type: custom:fridge-assistant-meal-plan-card
 *   day: 0                          # 0 = today, 1 = tomorrow, ...
 *   mealie_url: http://mealie.local:9000
 *   group: home                     # Mealie group slug in recipe links
 *   todo_entity: todo.planned_meals # where made meals are recorded
 *   script: script.cook_planned_meal
 *   label_location: fridge          # where "Print label" puts the dish
 *
 * The plan comes from the Mealie integration's mealie.get_mealplan action
 * (shared by every card on the page). The script is called with
 * {mealplan_id, slug, name, entry_type, date}; a meal counts as made once the
 * to-do list holds a line whose JSON description has that mealplan_id and a
 * "done" record.
 */

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

  /* Put the cooked meal in the fridge as a Fridge Assistant dish and print
   * its sticker (for the container). Each tap is a new container. */
  async _printLabel(entry) {
    const id = String(entry.mealplan_id);
    if (this._printing.has(id)) return;
    this._printing.add(id);
    this._printed.delete(id);
    this._render();
    const r = entry.recipe;
    try {
      const added = await this._hass.callWS({
        type: "fridge_assistant/add_item",
        item: {
          name: r.name, contents: r.name, kind: "dish",
          location: this._config.label_location || "fridge",
          photo: this._imageUrl(r) || null,
          notes: this._config.label_notes || null,
        },
      });
      const item = added && added.item;
      const res = await this._hass.callWS({ type: "fridge_assistant/print_sticker", item_id: item.id });
      if (res && res.printed) {
        const until = item.expiry_date
          ? ` · keeps until ${new Date(`${item.expiry_date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`
          : "";
        this._printed.set(id, { text: `Printed ${item.code}${until}` });
      } else {
        const reasons = {
          printer_disabled: "printing is turned off in Fridge Assistant",
          printer_unreachable: "the label printer can't be reached",
          printer_not_connected: "the printer isn't connected or is off",
        };
        const why = (res && (reasons[res.reason] || res.reason)) || "unknown error";
        this._printed.set(id, { text: `Added ${item.code} to the fridge, but the label didn't print: ${why}`, bad: true });
      }
    } catch (err) {
      this._printed.set(id, { text: `Couldn't print: ${err.message || err}`, bad: true });
    } finally {
      this._printing.delete(id);
      this._render();
    }
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
        .meal-row.note { cursor: default; }
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
      else if (btn.dataset.act === "print") this._printLabel(entry);
    });
  }

  _mealHtml(entry) {
    const id = String(entry.mealplan_id);
    const r = entry.recipe;
    if (!r) {
      return `<div class="meal"><div class="meal-row note">
        <div class="pic"><ha-icon icon="mdi:food-apple-outline"></ha-icon></div>
        <div class="name">${esc(entry.title || "")}${entry.description ? `<small>${esc(entry.description)}</small>` : ""}</div>
      </div></div>`;
    }
    const done = this._done.get(id);
    const busy = this._busy.has(id);
    const printing = this._printing.has(id);
    const printed = this._printed.get(id);
    const img = this._imageUrl(r);
    const pic = img
      ? `<img class="pic" src="${esc(img)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pic',innerHTML:'<ha-icon icon=&quot;mdi:silverware-fork-knife&quot;></ha-icon>'}))">`
      : `<div class="pic"><ha-icon icon="mdi:silverware-fork-knife"></ha-icon></div>`;
    const status = done ? (done.skipped ? "Skipped" : "Made") : "";
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
        <button data-act="print" data-id="${id}" ${printing ? "disabled" : ""}>
          <ha-icon icon="mdi:printer-outline"></ha-icon>${printing ? "Printing…" : "Print label"}</button>
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
