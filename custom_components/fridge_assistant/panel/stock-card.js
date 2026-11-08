/* Fridge Assistant — stock card.
 *
 * Everything in stock in one place (the pantry, by default), grouped by
 * supermarket aisle like the shopping list and unpack cards. Tap a food to
 * eat, toss, print its label, change its date, total (or a dish's portions)
 * or place, or add
 * another. Scan a shop barcode or a printed label to open the same popup;
 * a barcode that isn't in stock opens an add form filled in from the product.
 * Add finds a food from the templates (or makes a new one).
 *
 *   type: custom:fridge-assistant-stock-card
 *   location: pantry        # cupboard | fridge | freezer | pantry
 *   title: Pantry           # optional
 */

const VER = new URL(import.meta.url).search;
const { AISLES, aisleOf, foodEmoji } = await import(new URL(`./lib/food-look.js${VER}`, import.meta.url));
const { fmtAmount, esc } = await import(new URL(`./lib/format.js${VER}`, import.meta.url));

const WS = "fridge_assistant";
const LOCATIONS = [
  { key: "cupboard", label: "Cupboard", in: "in the cupboard", icon: "mdi:cupboard-outline" },
  { key: "fridge", label: "Fridge", in: "in the fridge", icon: "mdi:fridge-outline" },
  { key: "freezer", label: "Freezer", in: "in the freezer", icon: "mdi:snowflake" },
  { key: "pantry", label: "Pantry", in: "in the pantry", icon: "mdi:basket-outline" },
];
const LOC = Object.fromEntries(LOCATIONS.map((l) => [l.key, l]));
const OWN_CODE_RE = /^([A-Z]{2}\d{2}|\d{2}[A-Z]{2})(?:-(\d{1,2}))?$/;
const BASE_UNIT = { kg: ["g", 1000], l: ["ml", 1000], cl: ["ml", 10] };
const ANY_UNITS = ["each", "g", "kg", "ml", "l"];
const PRINT_REASONS = {
  printer_disabled: "Label printing is turned off in Fridge Assistant.",
  printer_not_connected: "The label printer isn't connected.",
  render_failed: "Couldn't draw the label.",
};

/* ---- helpers -------------------------------------------------------------- */

const UNIT_NAMES = { kg: "kg", g: "g", gram: "g", grams: "g", ml: "ml", cl: "cl", l: "l", litre: "l", litres: "l", liter: "l", liters: "l", ltr: "l" };

/* A pack size from product data or a name: "4 x 400g" -> 1600 g, "1L" -> 1 l,
 * "Pack of 6" -> 6 each. */
function parseSize(text) {
  const t = String(text || "").toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  let m = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l|litres?|liters?|ltr)\b/.exec(t);
  if (m) return { quantity: Number(m[1]) * Number(m[2]), unit: UNIT_NAMES[m[3]] };
  m = /(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml|cl|l|litres?|liters?|ltr)\b/.exec(t);
  if (m) return { quantity: Number(m[1]), unit: UNIT_NAMES[m[2]] };
  m = /pack of (\d+)\b/.exec(t) || /(?:^|\s)(\d{1,2})\s+(?:pack\s+)?[a-z]/.exec(t);
  if (m && Number(m[1]) > 1 && Number(m[1]) <= 30) return { quantity: Number(m[1]), unit: "each" };
  return null;
}

/* Units an amount for this template can be typed in. */
function amountUnits(tpl) {
  if (!tpl || !tpl.amount_unit) return ANY_UNITS;
  const family = (u) => (u === "g" || u === "kg" ? ["g", "kg"] : u === "ml" || u === "l" ? ["ml", "l"] : [u]);
  const out = [...family(tpl.amount_unit)];
  for (const k of Object.keys(tpl.per || {})) {
    if (["g", "ml"].includes(k)) out.push(...family(k));
    else if (["each", "can", "tin", "pot", "block", "pack", "bottle", "jar"].includes(k)) out.push(k);
  }
  return [...new Set(out)];
}

/* kg/l typed in are stored as g/ml. */
function toBase(amount, unit) {
  const b = BASE_UNIT[unit];
  return b ? { amount: Math.round(amount * b[1] * 100) / 100, unit: b[0] } : { amount, unit };
}

function daysText(dl) {
  if (dl == null) return "";
  if (dl < 0) return "Expired";
  if (dl === 0) return "Today";
  if (dl === 1) return "Tomorrow";
  if (dl < 14) return `${dl} days`;
  if (dl < 60) return `${Math.round(dl / 7)} weeks`;
  if (dl < 730) return `${Math.round(dl / 30.4)} months`;
  return `${Math.round(dl / 365)} years`;
}

function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

const byExpiry = (a, b) => (a.days_left == null) - (b.days_left == null) || (a.days_left ?? 0) - (b.days_left ?? 0)
  || String(a.added_date || "").localeCompare(String(b.added_date || ""));
const groupKey = (i) => i.template_id || `n:${String(i.name || "").trim().toLowerCase()}`;
const portionsOf = (i) => (Array.isArray(i.portions) && i.portions.length ? i.portions : [{ n: 1, status: "open" }]);
const openPortions = (i) => portionsOf(i).filter((p) => p.status === "open").map((p) => p.n);
const realEmoji = (e) => (e && e !== "🍽️" ? e : null);

function makeDetector() {
  const wanted = ["ean_13", "ean_8", "upc_a", "upc_e", "code_39", "code_128", "qr_code"];
  return window.BarcodeDetector.getSupportedFormats()
    .then((sup) => wanted.filter((f) => sup.includes(f)))
    .catch(() => null)
    .then((formats) => (formats && formats.length ? new window.BarcodeDetector({ formats }) : new window.BarcodeDetector()));
}

let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingPromise) {
    zxingPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "/fridge_assistant_static/zxing.min.js";
      s.onload = () => resolve(window.ZXing || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return zxingPromise;
}

/* ---- styles --------------------------------------------------------------- */

const STYLE = `
  :host { --r: 14px; }
  [hidden] { display: none !important; }
  /* Room at the bottom so the floating buttons don't sit on the last row. */
  ha-card { padding: 16px 16px 88px; }
  button { font: inherit; cursor: pointer; color: var(--primary-text-color); background: none; border: none; padding: 0; }
  button:disabled { opacity: .45; cursor: default; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 12px;
    padding: 10px 14px; border: 1px solid var(--divider-color); background: var(--card-background-color); font-weight: 500; }
  .btn ha-icon { --mdc-icon-size: 20px; }
  .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .btn.danger { background: var(--error-color, #db4437); color: #fff; border-color: transparent; }
  .btn.soft { background: var(--secondary-background-color); border-color: transparent; }
  .btn.icon { width: 44px; height: 44px; padding: 0; flex: 0 0 auto; }

  .head { display: flex; align-items: center; gap: 8px; }
  .title { flex: 1 1 auto; font-size: 20px; font-weight: 600; line-height: 1.2; }
  .sub { font-size: 14px; font-weight: 400; color: var(--secondary-text-color); }
  .search { position: relative; margin-top: 12px; }
  .search ha-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); --mdc-icon-size: 20px; color: var(--secondary-text-color); }
  input, select { font: inherit; color: var(--primary-text-color); background: var(--card-background-color);
    border: 1px solid var(--divider-color); border-radius: 12px; padding: 10px 12px; box-sizing: border-box; min-width: 0; }
  input:focus, select:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
  .search input { width: 100%; padding-left: 40px; background: var(--secondary-background-color); border-color: transparent; }

  .aisle-h { display: flex; align-items: center; gap: 6px; margin-top: 18px; padding: 0 2px 4px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color);
    border-bottom: 2px solid color-mix(in srgb, var(--tint) 45%, transparent); }
  .list { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 9px 4px;
    border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 60%, transparent); }
  .row:last-child { border-bottom: none; }
  .row:hover { background: color-mix(in srgb, var(--secondary-background-color) 70%, transparent); }
  .th { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    font-size: 22px; background: color-mix(in srgb, var(--tint) 20%, transparent); overflow: hidden; }
  .th img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
  .th.big { width: 56px; height: 56px; flex-basis: 56px; font-size: 30px; border-radius: 16px; }
  .info { flex: 1 1 auto; min-width: 0; }
  .nm { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm .x { margin-left: 6px; font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 10px;
    background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .amt { font-size: 13px; color: var(--secondary-text-color); margin-top: 1px; }
  .days { flex: 0 0 auto; font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
  .days.soon { color: var(--warning-color, #f59f00); font-weight: 600; }
  .days.expired { color: var(--error-color, #db4437); font-weight: 600; }
  .empty { margin: 18px 4px 4px; color: var(--secondary-text-color); }

  dialog { border: none; padding: 0; border-radius: 22px; width: min(440px, calc(100vw - 32px)); max-width: none;
    max-height: min(88vh, 760px); background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  @media (max-width: 600px) {
    dialog { width: 100vw; margin: auto 0 0 0; border-radius: 22px 22px 0 0; max-height: 90vh; }
  }
  .dbody { padding: 18px 18px 20px; overflow-y: auto; }
  .dhead { display: flex; align-items: center; gap: 12px; }
  .dhead .info .nm { font-size: 18px; font-weight: 600; white-space: normal; }
  .dhead .amt { font-size: 14px; }
  .close { flex: 0 0 auto; align-self: flex-start; width: 36px; height: 36px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; color: var(--secondary-text-color); }
  .close:hover { background: var(--secondary-background-color); }
  .pager { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 12px;
    font-size: 13px; color: var(--secondary-text-color); }
  .pager button { width: 32px; height: 32px; border-radius: 50%; background: var(--secondary-background-color); display: flex;
    align-items: center; justify-content: center; }
  .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
  .acts .btn { padding: 14px 10px; flex-direction: column; gap: 4px; border-radius: 16px; }
  .acts .btn ha-icon { --mdc-icon-size: 24px; }
  .facts { margin-top: 18px; border-top: 1px solid var(--divider-color); }
  .fact { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--divider-color); min-height: 40px; }
  .fact > span { flex: 1 1 auto; color: var(--secondary-text-color); }
  .fact input[type=date] { padding: 6px 10px; }
  .step { display: flex; align-items: center; gap: 4px; }
  .step button { width: 34px; height: 34px; border-radius: 50%; background: var(--secondary-background-color); display: flex;
    align-items: center; justify-content: center; }
  .step b { min-width: 28px; text-align: center; }
  .total { display: flex; align-items: center; gap: 6px; }
  .total input { width: 84px; padding: 6px 10px; text-align: right; }
  .total select { padding: 6px 8px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; border-radius: 16px; font-size: 13px;
    background: var(--secondary-background-color); }
  .chip ha-icon { --mdc-icon-size: 16px; }
  .q { margin-top: 18px; font-weight: 600; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
  .field label { font-size: 13px; color: var(--secondary-text-color); }
  .inrow { display: flex; gap: 8px; }
  .inrow input { flex: 1 1 auto; }
  .big-in { font-size: 22px; text-align: center; }
  .hint { font-size: 13px; color: var(--secondary-text-color); margin-top: 6px; }
  .foot { display: flex; gap: 10px; margin-top: 20px; }
  .foot .btn { flex: 1 1 0; padding: 12px; }
  .checks { display: flex; flex-direction: column; margin-top: 10px; }
  .checks label { display: flex; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid var(--divider-color); }
  .checks input { width: 20px; height: 20px; accent-color: var(--primary-color); }
  .tlist { display: flex; flex-direction: column; margin-top: 8px; max-height: 50vh; overflow-y: auto; }
  .tlist .row { padding: 8px 4px; }
  .tlist .th { width: 34px; height: 34px; flex-basis: 34px; font-size: 19px; border-radius: 10px; }
  .cam { position: relative; margin-top: 14px; border-radius: 16px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; }
  .cam video { width: 100%; height: 100%; display: block; object-fit: cover; }
  .cam .frame { position: absolute; left: 8%; right: 8%; top: 30%; bottom: 30%; border: 2px solid rgba(255,255,255,.9);
    border-radius: 12px; pointer-events: none; box-shadow: 0 0 0 999px rgba(0,0,0,.25); }
  .sst { margin-top: 10px; min-height: 1.3em; color: var(--secondary-text-color); font-size: 14px; }
  .sst.bad { color: var(--error-color, #db4437); }
  .linkbtn { color: var(--primary-color); font-weight: 500; padding: 6px 0; }

  .fabs { display: none; position: fixed; margin: 0; padding: 0; border: none; background: transparent; overflow: visible;
    inset: auto calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) auto;
    align-items: center; gap: 12px; }
  .fabs:popover-open { display: flex; }
  @supports not selector(:popover-open) { .fabs { display: flex; z-index: 5; } }
  .fab { display: flex; align-items: center; justify-content: center; padding: 0; width: 56px; height: 56px;
    border-radius: 16px; border: none; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
  .fab ha-icon { --mdc-icon-size: 26px; }
  .fab.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .fab.mini { width: 48px; height: 48px; border-radius: 14px; background: var(--card-background-color); }
  .fab.mini ha-icon { --mdc-icon-size: 22px; }

  /* Above the floating buttons. */
  .toast { position: fixed; inset: auto 0 calc(88px + env(safe-area-inset-bottom, 0px)) 0; margin: 0 auto; width: max-content; max-width: calc(100vw - 32px);
    border: none; border-radius: 14px; padding: 12px 14px 12px 16px; background: #323232; color: #fff;
    box-shadow: 0 6px 20px rgba(0,0,0,.3); display: none; align-items: center; gap: 14px; font-size: 14px; }
  .toast:popover-open, .toast.inline { display: flex; }
  .toast.inline { position: static; margin: 12px 0 0; width: auto; }
  .toast.bad { background: var(--error-color, #b3261e); }
  .toast button { color: #8ab4f8; font-weight: 600; text-transform: uppercase; font-size: 13px; letter-spacing: .03em; }
  .toast.bad button { color: #fff; }
`;

/* ---- card ----------------------------------------------------------------- */

class FridgeAssistantStockCard extends HTMLElement {
  static getStubConfig() { return { location: "pantry" }; }

  setConfig(config) {
    const location = (config && config.location) || "pantry";
    if (!LOC[location]) throw new Error("location must be cupboard, fridge, freezer or pantry");
    this._config = { title: LOC[location].label, ...config, location };
    this._q = this._q || "";
    if (this.shadowRoot) this._renderAll();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) { this._build(); this._showFabs(this.isConnected); }
    if (first || !this._unsub) this._subscribe();
  }

  getCardSize() { return 8; }

  connectedCallback() {
    if (this._hass && !this._unsub) this._subscribe();
    this._showFabs(true);
  }

  disconnectedCallback() {
    this._showFabs(false);
    this._stopCamera();
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  /* ---- data ---------------------------------------------------------------- */

  _subscribe() {
    if (!this._hass || !this._config || this._unsub || !this.isConnected) return;
    this._unsub = this._hass.connection.subscribeMessage((msg) => {
      this._state = msg;
      this._tplById = new Map((msg.templates || []).map((t) => [t.id, t]));
      this._renderList();
      if (this._dlg && this._dlg.mode === "item") {
        // Don't redraw under a half-typed amount or a label choice.
        if (this._item(this._dlg.id)) { if (!this._dlg.sub || this._dlg.sub === "toss") this._renderDlg(); }
        else if (!this._busy) this._closeDlg();
      }
    }, { type: `${WS}/subscribe` }).catch((err) => {
      this._unsub = null;
      this._toast(`Couldn't load Fridge Assistant: ${err.message || err}`, { bad: true });
      return null;
    });
  }

  _ws(type, payload = {}) { return this._hass.callWS({ type: `${WS}/${type}`, ...payload }); }

  _items() { return (this._state && this._state.items) || []; }
  _item(id) { return this._items().find((i) => i.id === id) || null; }
  _tpl(id) { return (id && this._tplById && this._tplById.get(id)) || null; }

  /* Rows: same food in this place is one row with a count. */
  _groups() {
    const map = new Map();
    for (const it of this._items()) {
      if (it.location !== this._config.location) continue;
      const k = groupKey(it);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return [...map.entries()].map(([key, items]) => {
      items.sort(byExpiry);
      const first = items[0];
      const tpl = this._tpl(first.template_id);
      const name = first.name || (tpl && tpl.name) || "?";
      const aisle = aisleOf({ category: first.category || (tpl && tpl.category), name });
      const units = new Set(items.map((i) => (i.amount == null ? null : i.amount_unit || "each")));
      const openN = items.reduce((s, i) => s + openPortions(i).length, 0);
      const amount = units.size === 1 && !units.has(null)
        ? fmtAmount(items.reduce((s, i) => s + Number(i.amount || 0), 0), [...units][0])
        : items.some((i) => portionsOf(i).length > 1) ? `${openN} portion${openN === 1 ? "" : "s"}` : "";
      return {
        key, items, name, aisle, amount, first,
        photo: (items.find((i) => i.photo) || {}).photo || "",
        emoji: realEmoji(first.emoji) || realEmoji(tpl && tpl.emoji) || foodEmoji(name) || aisle.emoji,
        search: [name, ...items.map((i) => `${i.name} ${i.contents || ""}`), ...((tpl && tpl.aliases) || [])].join(" ").toLowerCase(),
      };
    });
  }

  _look(item) {
    const tpl = this._tpl(item.template_id);
    const name = item.name || (tpl && tpl.name) || "";
    const aisle = aisleOf({ category: item.category || (tpl && tpl.category), name });
    return { aisle, emoji: realEmoji(item.emoji) || realEmoji(tpl && tpl.emoji) || foodEmoji(name) || aisle.emoji };
  }

  _thumb(photo, emoji, tint, big) {
    return `<span class="th${big ? " big" : ""}" style="--tint:${tint}">${photo
      ? `<img src="${esc(photo)}" alt="" loading="lazy">` : esc(emoji)}</span>`;
  }

  /* ---- list ---------------------------------------------------------------- */

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
      <ha-card>
        <div class="head" id="head"></div>
        <div class="search"><ha-icon icon="mdi:magnify"></ha-icon>
          <input id="q" type="search" placeholder="Search" autocomplete="off" enterkeyhint="search"></div>
        <div id="list"></div>
        <div class="toast" id="toast" popover="manual"></div>
      </ha-card>
      <div class="fabs" id="fabs" popover="manual">
        <button class="fab mini" data-act="add" aria-label="Add" title="Add"><ha-icon icon="mdi:plus"></ha-icon></button>
        <button class="fab primary" data-act="scan" aria-label="Scan" title="Scan"><ha-icon icon="mdi:barcode-scan"></ha-icon></button>
      </div>
      <dialog id="dlg"></dialog>`;
    root.getElementById("q").value = this._q;
    root.getElementById("q").addEventListener("input", (e) => { this._q = e.target.value; this._renderList(); });
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("change", (e) => this._onChange(e));
    root.addEventListener("input", (e) => { if (e.target.id === "tq") this._renderPick(); });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target.id === "code") { e.preventDefault(); this._lookupTyped(); }
      else if (e.target.id === "left") { e.preventDefault(); this._saveLeft(); }
      else if (e.target.id === "total") { e.preventDefault(); e.target.blur(); }
      else if (e.target.id === "tq") { e.preventDefault(); const b = this.shadowRoot.querySelector("#tlist .row"); if (b) b.click(); }
    });
    const dlg = root.getElementById("dlg");
    dlg.addEventListener("close", () => { this._stopCamera(); this._dlg = null; dlg.innerHTML = ""; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) this._closeDlg(); });   // backdrop
    this._renderAll();
  }

  /* Floating Add / Scan buttons, in the top layer so nothing on the page
   * (HA's scrolling view, card containment) can clip or cover them. */
  _showFabs(on) {
    const f = this.shadowRoot && this.shadowRoot.getElementById("fabs");
    if (!f || !f.showPopover) return;
    try { if (on) f.showPopover(); else f.hidePopover(); } catch (e) { /* already in that state */ }
  }

  _renderAll() { this._renderHead(); this._renderList(); }

  _renderHead() {
    const h = this.shadowRoot && this.shadowRoot.getElementById("head");
    if (!h || !this._config) return;
    const n = this._items().filter((i) => i.location === this._config.location).length;
    h.innerHTML = `
      <div class="title">${esc(this._config.title)}
        <div class="sub">${this._state ? `${n} item${n === 1 ? "" : "s"}` : "Loading…"}</div></div>`;
  }

  _renderList() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("list");
    if (!box) return;
    this._renderHead();
    if (!this._state) { box.innerHTML = ""; return; }
    const q = this._q.trim().toLowerCase();
    const groups = this._groups().filter((g) => !q || q.split(/\s+/).every((w) => g.search.includes(w)));
    if (!groups.length) {
      box.innerHTML = `<div class="empty">${q ? `Nothing matches “${esc(this._q.trim())}”.`
        : `Nothing ${esc(LOC[this._config.location].in)} yet. Scan or add something.`}</div>`;
      return;
    }
    box.innerHTML = AISLES.map((a) => {
      const these = groups.filter((g) => g.aisle === a).sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
      if (!these.length) return "";
      return `<div class="aisle-h" style="--tint:${a.color}"><span>${a.emoji}</span>${esc(a.name)}</div>
        <div class="list">${these.map((g) => this._rowHtml(g)).join("")}</div>`;
    }).join("");
  }

  _rowHtml(g) {
    const f = g.first;
    return `<button class="row" data-act="open" data-id="${esc(f.id)}">
      ${this._thumb(g.photo, g.emoji, g.aisle.color)}
      <span class="info"><div class="nm">${esc(g.name)}${g.items.length > 1 ? `<span class="x">×${g.items.length}</span>` : ""}</div>
        ${g.amount ? `<div class="amt">${esc(g.amount)}</div>` : ""}</span>
      <span class="days ${esc(f.status || "")}">${esc(daysText(f.days_left))}</span>
    </button>`;
  }

  /* ---- events -------------------------------------------------------------- */

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const a = el.dataset.act;
    const d = this._dlg;
    switch (a) {
      case "open": this._openItem(el.dataset.id); break;
      case "add": this._openDlg({ mode: "pick" }); break;
      case "scan": this._openDlg({ mode: "scan" }); break;
      case "close": this._closeDlg(); break;
      case "back": if (d) { d.sub = null; this._renderDlg(); } break;
      case "prev": case "next": this._page(a === "next" ? 1 : -1); break;
      case "eat": if (d) { d.sub = "eat"; this._renderDlg(); this._focus("left"); } break;
      case "saveleft": this._saveLeft(); break;
      case "toss": if (d) { d.sub = "toss"; this._renderDlg(); } break;
      case "dotoss": this._complete("tossed"); break;
      case "print": this._print(); break;
      case "doprint": this._printChosen(); break;
      case "pminus": case "pplus": this._portions(a === "pplus" ? 1 : -1); break;
      case "move": this._move(el.dataset.loc); break;
      case "another": this._another(); break;
      case "type": if (d) { d.typing = !d.typing; this._renderScanExtras(); if (d.typing) this._focus("code"); } break;
      case "lookup": this._lookupTyped(); break;
      case "pick": this._pickTemplate(el.dataset.id); break;
      case "create": this._createTemplate(); break;
      case "doadd": this._addNew(); break;
      default: break;
    }
  }

  _onChange(e) {
    const t = e.target;
    if (t.id === "exp" && this._dlg && this._dlg.mode === "item") this._setExpiry(t.value);
    if (t.id === "total" && this._dlg && this._dlg.mode === "item") this._setTotal();
    if (t.id === "totalunit" && this._dlg && this._dlg.mode === "item") {
      // Switching g <-> kg or ml <-> l shows the same amount in the new unit;
      // only a unit for something not tracked yet saves straight away.
      const input = this.shadowRoot.getElementById("total");
      const from = t.dataset.unit;
      const to = t.value;
      const v = Number(input && input.value);
      t.dataset.unit = to;
      if (input && input.value !== "" && !Number.isNaN(v) && BASE_UNIT[from] && BASE_UNIT[from][0] === to) {
        input.value = String(Math.round(v * BASE_UNIT[from][1] * 100) / 100);
      } else if (input && input.value !== "" && !Number.isNaN(v) && BASE_UNIT[to] && BASE_UNIT[to][0] === from) {
        input.value = String(Math.round(v / BASE_UNIT[to][1] * 1000) / 1000);
      } else if (input && input.value !== "") this._setTotal();
    }
  }

  _focus(id) { setTimeout(() => { const el = this.shadowRoot.getElementById(id); if (el) { el.focus(); if (el.select) el.select(); } }, 60); }

  /* ---- dialog -------------------------------------------------------------- */

  _openDlg(state) {
    this._stopCamera();
    this._dlg = state;
    const dlg = this.shadowRoot.getElementById("dlg");
    this._renderDlg();
    if (!dlg.open) dlg.showModal();
    if (state.mode === "scan") this._startCamera();
    if (state.mode === "pick") this._focus("tq");
  }

  _closeDlg() {
    this._stopCamera();
    this._dlg = null;
    const dlg = this.shadowRoot && this.shadowRoot.getElementById("dlg");
    if (dlg && dlg.open) dlg.close();
  }

  _openItem(id) {
    const it = this._item(id);
    if (!it) return;
    this._openDlg({ mode: "item", id, sub: null });
  }

  /* The other items of the same food in the same place, earliest first. */
  _siblings(it) {
    const k = groupKey(it);
    return this._items().filter((i) => i.location === it.location && groupKey(i) === k).sort(byExpiry);
  }

  _page(step) {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it) return;
    const sib = this._siblings(it);
    const i = sib.findIndex((x) => x.id === it.id);
    const next = sib[(i + step + sib.length) % sib.length];
    if (next) { d.id = next.id; d.sub = null; this._renderDlg(); }
  }

  _renderDlg() {
    const dlg = this.shadowRoot.getElementById("dlg");
    const d = this._dlg;
    if (!d) return;
    const scroll = dlg.querySelector(".dbody");
    const top = scroll ? scroll.scrollTop : 0;
    let html = "";
    if (d.mode === "item") html = this._itemHtml(d);
    else if (d.mode === "new") html = this._newHtml(d);
    else if (d.mode === "pick") html = this._pickHtml();
    else if (d.mode === "scan") html = this._scanHtml(d);
    dlg.innerHTML = `<div class="dbody">${html}</div>`;
    const body = dlg.querySelector(".dbody");
    if (body && d.keepScroll) body.scrollTop = top;
    d.keepScroll = true;
    if (d.mode === "pick") this._renderPick();
    if (d.mode === "scan") this._renderScanExtras();
  }

  _closeBtn() { return `<button class="close" data-act="close" aria-label="Close"><ha-icon icon="mdi:close"></ha-icon></button>`; }

  /* ---- item popup ---------------------------------------------------------- */

  _itemHtml(d) {
    const it = this._item(d.id);
    if (!it) return "";
    const look = this._look(it);
    const sib = this._siblings(it);
    const idx = sib.findIndex((x) => x.id === it.id);
    const ports = portionsOf(it);
    const open = openPortions(it);
    const multi = ports.length > 1;
    const amountLine = [
      it.amount != null ? (it.amount_initial && it.amount_initial !== it.amount
        ? `${fmtAmount(it.amount, it.amount_unit)} of ${fmtAmount(it.amount_initial, it.amount_unit)} left`
        : `${fmtAmount(it.amount, it.amount_unit)}${it.amount_unit && it.amount_unit !== "each" ? "" : " left"}`) : "",
      multi ? `${open.length} of ${ports.length} portions` : "",
      it.location !== this._config.location ? `In the ${LOC[it.location] ? LOC[it.location].label.toLowerCase() : it.location}` : "",
    ].filter(Boolean).join(" · ");
    const head = `<div class="dhead">${this._thumb(it.photo, look.emoji, look.aisle.color, true)}
      <div class="info"><div class="nm">${esc(it.name)}</div>${amountLine ? `<div class="amt">${esc(amountLine)}</div>` : ""}</div>
      ${this._closeBtn()}</div>
      ${sib.length > 1 ? `<div class="pager"><button data-act="prev" aria-label="Previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
        <span>${idx + 1} of ${sib.length}${it.days_left != null ? ` · ${esc(daysText(it.days_left).toLowerCase())}` : ""}</span>
        <button data-act="next" aria-label="Next"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>` : ""}`;
    const busy = this._busy ? "disabled" : "";

    if (d.sub === "eat") {
      const byPortion = multi;
      const unit = it.amount != null ? (it.amount_unit || "each") : null;
      const value = byPortion ? open.length : it.amount != null ? Math.round(it.amount * 100) / 100 : "";
      return `${head}
        <div class="q">${byPortion ? "How many portions are left?" : "How much is left?"}</div>
        <div class="field"><div class="inrow">
          <input id="left" class="big-in" type="number" inputmode="decimal" min="0" step="any" value="${esc(value)}">
          ${byPortion ? "" : unit ? (unit === "each" ? "" : `<select id="leftunit">${(unit === "g" ? ["g", "kg"] : unit === "ml" ? ["ml", "l"] : [unit])
            .map((u) => `<option${u === unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>`)
            : `<select id="leftunit">${ANY_UNITS.map((u) => `<option>${u}</option>`).join("")}</select>`}
        </div><div class="hint">0 means it's finished and comes off the list.</div></div>
        <div class="foot"><button class="btn soft" data-act="back">Back</button>
          <button class="btn primary" data-act="saveleft" ${busy}>Save</button></div>`;
    }
    if (d.sub === "toss") {
      return `${head}
        <div class="q">Throw away ${esc(it.name)}?</div>
        ${multi && open.length > 1 ? `<div class="hint">All ${open.length} open portions go.</div>` : ""}
        <div class="foot"><button class="btn soft" data-act="back">Back</button>
          <button class="btn danger" data-act="dotoss" ${busy}>Throw away</button></div>`;
    }
    if (d.sub === "print") {
      return `${head}
        <div class="q">Which labels?</div>
        <div class="checks">${ports.map((p) => `<label><input type="checkbox" name="pp" value="${p.n}"${p.status === "open" ? " checked" : ""}>
          Portion ${p.n} <span class="amt">${esc(it.code)}-${p.n}${p.status !== "open" ? ` · ${esc(p.status)}` : ""}</span></label>`).join("")}</div>
        <div class="foot"><button class="btn soft" data-act="back">Back</button>
          <button class="btn primary" data-act="doprint" ${busy}>Print</button></div>`;
    }
    const consumed = ports.length - open.length;
    return `${head}
      <div class="acts">
        <button class="btn primary" data-act="eat" ${busy}><ha-icon icon="mdi:silverware-fork-knife"></ha-icon>Eaten</button>
        <button class="btn" data-act="toss" ${busy}><ha-icon icon="mdi:delete-outline"></ha-icon>Tossed</button>
        <button class="btn" data-act="print" ${busy}><ha-icon icon="mdi:printer-outline"></ha-icon>Print label</button>
        <button class="btn" data-act="another" ${busy}><ha-icon icon="mdi:plus"></ha-icon>Add another</button>
      </div>
      <div class="facts">
        <div class="fact"><span>Expires</span>${it.days_left != null && sib.length < 2
          ? `<small class="days ${esc(it.status || "")}">${esc(daysText(it.days_left))}</small>` : ""}
          <input id="exp" type="date" value="${esc(it.expiry_date || "")}" ${busy} aria-label="Expiry date"></div>
        ${it.kind === "dish" || multi ? `<div class="fact"><span>Portions</span><div class="step">
          <button data-act="pminus" aria-label="Fewer portions" ${ports.length <= Math.max(1, consumed + (open.length ? 1 : 0)) || this._busy ? "disabled" : ""}><ha-icon icon="mdi:minus"></ha-icon></button>
          <b>${ports.length}</b>
          <button data-act="pplus" aria-label="More portions" ${ports.length >= 24 || this._busy ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button></div></div>`
          : this._totalHtml(it, busy)}
        <div class="fact"><span>Move to</span><div class="chips">${LOCATIONS.filter((l) => l.key !== it.location).map((l) =>
          `<button class="chip" data-act="move" data-loc="${l.key}" ${busy}><ha-icon icon="${l.icon}"></ha-icon>${l.label}</button>`).join("")}</div></div>
      </div>`;
  }

  /* Total: how much of it there is, in its own unit (g/kg, ml/l, or a count
   * for things bought loose, like oranges or potatoes). Editing it sets the
   * amount Fridge Assistant tracks. */
  _totalHtml(it, busy) {
    const unit = it.amount != null ? (it.amount_unit || "each") : null;
    const units = unit === "g" ? ["g", "kg"] : unit === "ml" ? ["ml", "l"] : unit ? [unit] : ANY_UNITS;
    // Big amounts read better in kg or l.
    let shown = unit;
    let value = it.amount != null ? it.amount : "";
    if ((unit === "g" || unit === "ml") && it.amount >= 1000) { shown = unit === "g" ? "kg" : "l"; value = it.amount / 1000; }
    if (value !== "") value = Math.round(value * 100) / 100;
    const label = (u) => (u === "each" ? "portions" : u);
    return `<div class="fact"><span>Total</span><div class="total">
      <input id="total" type="number" inputmode="decimal" min="0" step="any" value="${esc(value)}" ${busy} aria-label="Total">
      <select id="totalunit" aria-label="Unit" data-unit="${shown || "each"}" ${busy}>${units.map((u) =>
        `<option value="${u}"${u === (shown || "each") ? " selected" : ""}>${label(u)}</option>`).join("")}</select></div></div>`;
  }

  async _setTotal() {
    const d = this._dlg;
    const it = d && this._item(d.id);
    const input = this.shadowRoot.getElementById("total");
    const sel = this.shadowRoot.getElementById("totalunit");
    if (!it || !input || !sel) return;
    const raw = input.value.trim();
    const v = Number(raw);
    if (raw === "" || Number.isNaN(v) || v < 0) { this._toast("Type how much there is (0 if it's finished).", { bad: true }); return; }
    if (v === 0) { this._complete("eaten"); return; }
    const b = toBase(v, sel.value);
    if (b.amount === it.amount && b.unit === (it.amount_unit || b.unit)) return;
    const changes = { amount: b.amount };
    if (it.amount == null || b.unit !== it.amount_unit) changes.amount_unit = b.unit;
    const before = { amount: it.amount, amount_unit: it.amount_unit };
    await this._run(async () => {
      await this._ws("update_item", { item_id: it.id, changes });
      this._toast(`${it.name}: ${fmtAmount(b.amount, b.unit)}`, {
        action: "Undo", onAction: () => this._ws("update_item", { item_id: it.id, changes: before }).catch(() => {}),
      });
    });
  }

  async _run(fn) {
    if (this._busy) return null;
    this._busy = true;
    if (this._dlg) this._renderDlg();
    try { return await fn(); }
    catch (err) { this._toast(err.message || String(err), { bad: true }); return null; }
    finally { this._busy = false; if (this._dlg) this._renderDlg(); }
  }

  async _saveLeft() {
    const d = this._dlg;
    const it = d && this._item(d.id);
    const input = this.shadowRoot.getElementById("left");
    if (!it || !input) return;
    const raw = input.value.trim();
    const v = Number(raw);
    if (raw === "" || Number.isNaN(v) || v < 0) { this._toast("Type how much is left (0 if it's finished).", { bad: true }); return; }
    if (v === 0) { this._complete("eaten"); return; }
    const sel = this.shadowRoot.getElementById("leftunit");
    const multi = portionsOf(it).length > 1;
    await this._run(async () => {
      if (multi) {
        const open = openPortions(it);
        const want = Math.round(v);
        if (want < open.length) {
          for (const n of open.slice(want).reverse()) await this._ws("consume_portion", { item_id: it.id, portion: n, action: "eaten" });
        } else if (want > open.length) {
          await this._ws("set_portions", { item_id: it.id, total: Math.min(24, portionsOf(it).length + (want - open.length)) });
        }
        this._closeDlg();
        this._toast(`${it.name}: ${want} portion${want === 1 ? "" : "s"} left`);
        return;
      }
      const unit = sel ? sel.value : (it.amount_unit || "each");
      const b = toBase(v, unit);
      const changes = { amount: b.amount };
      if (it.amount == null || unit !== it.amount_unit) changes.amount_unit = b.unit;
      const before = { amount: it.amount, amount_unit: it.amount_unit };
      await this._ws("update_item", { item_id: it.id, changes });
      this._closeDlg();
      this._toast(`${it.name}: ${fmtAmount(b.amount, b.unit)} left`, {
        action: "Undo", onAction: () => this._ws("update_item", { item_id: it.id, changes: before }).catch(() => {}),
      });
    });
  }

  async _complete(action) {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it) return;
    await this._run(async () => {
      const res = await this._ws("complete_item", { item_id: it.id, action });
      this._closeDlg();
      const ev = res && res.event;
      this._toast(`${it.name} ${action === "tossed" ? "thrown away" : "finished"}`, ev && ev.id ? {
        action: "Undo", onAction: () => this._ws("restore_item", { event_id: ev.id }).catch((e) => this._toast(e.message || String(e), { bad: true })),
      } : {});
    });
  }

  _printMsg(res, what) {
    if (res && res.printed) return this._toast(`Printing ${what}`);
    const reason = res && res.reason;
    this._toast(PRINT_REASONS[reason] || (res && res.detail) || "Couldn't print the label.", { bad: true });
  }

  async _print() {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it) return;
    if (portionsOf(it).length > 1) { d.sub = "print"; this._renderDlg(); return; }
    await this._run(async () => this._printMsg(await this._ws("print_sticker", { item_id: it.id }), "the label"));
  }

  async _printChosen() {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it) return;
    const picked = [...this.shadowRoot.querySelectorAll('input[name="pp"]:checked')].map((c) => Number(c.value));
    if (!picked.length) { this._toast("Tick at least one label.", { bad: true }); return; }
    await this._run(async () => {
      let last = null;
      for (const n of picked) {
        last = await this._ws("print_sticker", { item_id: it.id, portion: n });
        if (!last || !last.printed) break;
      }
      d.sub = null;
      this._printMsg(last, picked.length === 1 ? "the label" : `${picked.length} labels`);
    });
  }

  async _portions(step) {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it) return;
    const total = portionsOf(it).length + step;
    await this._run(async () => {
      await this._ws("set_portions", { item_id: it.id, total });
      if (step > 0) {
        this._toast(`Portion ${total} added`, {
          action: "Print label",
          onAction: () => this._ws("print_sticker", { item_id: it.id, portion: total }).then((r) => this._printMsg(r, "the label")),
        });
      }
    });
  }

  async _setExpiry(value) {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it || (value || "") === (it.expiry_date || "")) return;
    await this._run(() => this._ws("update_item", {
      item_id: it.id, changes: { expiry_date: value || null, expiry_source: value ? "manual" : "none" },
    }));
  }

  async _move(loc) {
    const d = this._dlg;
    const it = d && this._item(d.id);
    if (!it || !LOC[loc]) return;
    const from = it.location;
    await this._run(async () => {
      await this._ws("update_item", { item_id: it.id, changes: { location: loc } });
      if (loc !== this._config.location) this._closeDlg();
      this._toast(`${it.name} moved to the ${LOC[loc].label.toLowerCase()}`, {
        action: "Undo", onAction: () => this._ws("update_item", { item_id: it.id, changes: { location: from } }).catch(() => {}),
      });
    });
  }

  _another() {
    const it = this._dlg && this._item(this._dlg.id);
    if (!it) return;
    const tpl = this._tpl(it.template_id);
    const per = it.amount_initial != null && it.amount_unit
      ? { quantity: it.amount_initial, unit: it.amount_unit }
      : tpl && tpl.pack_amount && tpl.amount_unit ? { quantity: tpl.pack_amount, unit: tpl.amount_unit } : null;
    this._openNew({
      name: it.name, template_id: it.template_id || null, barcode: it.barcode || null,
      photo: it.photo || "", emoji: this._look(it).emoji, size: per,
    });
  }

  /* ---- add form ------------------------------------------------------------ */

  /* Fill in units and a best-by date for the food, then show the form. */
  async _openNew(seed) {
    const n = {
      name: seed.name || "", template_id: seed.template_id || null, barcode: seed.barcode || null,
      photo: seed.photo || "", emoji: seed.emoji || "", amount: "", unit: "each", units: ANY_UNITS, expiry: "", suggested: "",
    };
    let tpl = this._tpl(n.template_id);
    if (n.name) {
      try {
        const res = await this._ws("match_template", { query: n.name, location: this._config.location });
        if (!tpl && res && res.template) { tpl = res.template; n.template_id = tpl.id; }
        if (res && res.suggestion && (!n.template_id || res.template && res.template.id === n.template_id)) n.suggested = res.suggestion.expiry_date || "";
      } catch (e) { /* no suggestion */ }
    }
    if (tpl) {
      n.units = amountUnits(tpl);
      n.emoji = n.emoji || realEmoji(tpl.emoji) || "";
    }
    const fits = (g) => (g && n.units.includes(g.unit) ? g : null);
    const size = fits(seed.size) || fits(parseSize(seed.quantity)) || fits(parseSize(n.name))
      || (tpl && tpl.pack_amount && tpl.amount_unit ? { quantity: tpl.pack_amount, unit: tpl.amount_unit } : null);
    if (size) { n.amount = String(Math.round(size.quantity * 100) / 100); n.unit = size.unit; }
    else n.unit = tpl && tpl.amount_unit ? tpl.amount_unit : "each";
    if (!n.units.includes(n.unit)) n.units = [n.unit, ...n.units];
    n.expiry = n.suggested;
    if (!n.emoji) n.emoji = foodEmoji(n.name) || aisleOf({ category: tpl && tpl.category, name: n.name }).emoji;
    this._openDlg({ mode: "new", n });
    this._focus(n.name ? "namt" : "nname");
  }

  _newHtml(d) {
    const n = d.n;
    const tint = aisleOf({ category: (this._tpl(n.template_id) || {}).category, name: n.name }).color;
    return `<div class="dhead">${this._thumb(n.photo, n.emoji || "🛒", tint, true)}
        <div class="info"><div class="nm">Add to ${esc(LOC[this._config.location].label.toLowerCase())}</div></div>${this._closeBtn()}</div>
      <div class="field"><label for="nname">Name</label><input id="nname" value="${esc(n.name)}" autocomplete="off"></div>
      <div class="field"><label for="namt">Amount</label><div class="inrow">
        <input id="namt" type="number" inputmode="decimal" min="0" step="any" value="${esc(n.amount)}" placeholder="How much">
        <select id="nunit" aria-label="Unit">${n.units.map((u) => `<option${u === n.unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
      </div></div>
      <div class="field"><label for="nexp">Best before</label><input id="nexp" type="date" value="${esc(n.expiry)}"></div>
      <div class="foot"><button class="btn soft" data-act="close">Cancel</button>
        <button class="btn primary" data-act="doadd" ${this._busy ? "disabled" : ""}>Add</button></div>`;
  }

  async _addNew() {
    const d = this._dlg;
    if (!d || d.mode !== "new") return;
    const n = d.n;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const name = $("nname").value.trim();
    if (!name) { this._toast("Give it a name.", { bad: true }); $("nname").focus(); return; }
    const amount = Number($("namt").value);
    const unit = $("nunit").value;
    const expiry = $("nexp").value;
    const item = { name, contents: name, location: this._config.location };
    // A renamed item is matched to a food again by the server.
    if (n.template_id && name === n.name) item.template_id = n.template_id;
    if (n.barcode) item.barcode = n.barcode;
    if (n.photo) item.photo = n.photo;
    if ($("namt").value !== "" && amount > 0) { const b = toBase(amount, unit); item.amount = b.amount; item.amount_unit = b.unit; }
    if (expiry && expiry !== n.suggested) { item.expiry_date = expiry; item.expiry_source = "manual"; }
    await this._run(async () => {
      const res = await this._ws("add_item", { item });
      const added = res && res.item;
      this._closeDlg();
      this._toast(`${added ? added.name : name} added`, added ? {
        action: "Print label",
        onAction: () => this._ws("print_sticker", { item_id: added.id }).then((r) => this._printMsg(r, "the label")),
      } : {});
    });
  }

  /* ---- template picker ----------------------------------------------------- */

  _pickHtml() {
    return `<div class="dhead"><div class="info"><div class="nm">Add to ${esc(LOC[this._config.location].label.toLowerCase())}</div></div>${this._closeBtn()}</div>
      <div class="search"><ha-icon icon="mdi:magnify"></ha-icon><input id="tq" type="search" placeholder="Find a food" autocomplete="off" enterkeyhint="go"></div>
      <div class="tlist" id="tlist"></div>`;
  }

  _renderPick() {
    const box = this.shadowRoot.getElementById("tlist");
    const input = this.shadowRoot.getElementById("tq");
    if (!box || !input) return;
    const q = input.value.trim().toLowerCase();
    if (!q) { box.innerHTML = `<div class="empty">Type to find a food.</div>`; return; }
    const hidden = new Set(((this._state && this._state.hidden) || []).map((h) => (h && h.id) || h));
    const words = q.split(/\s+/);
    const scored = [];
    for (const t of (this._state && this._state.templates) || []) {
      if (hidden.has(t.id)) continue;
      const names = [t.name, ...(t.aliases || [])].map((s) => String(s || "").toLowerCase());
      if (!words.every((w) => names.some((s) => s.includes(w)))) continue;
      const score = names[0] === q ? 0 : names.some((s) => s === q) ? 1 : names[0].startsWith(q) ? 2 : names.some((s) => s.startsWith(q)) ? 3 : 4;
      scored.push([score, t]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    const exact = scored.some(([s]) => s <= 1);
    const typed = input.value.trim();
    box.innerHTML = scored.slice(0, 40).map(([, t]) => {
      const aisle = aisleOf({ category: t.category, name: t.name });
      return `<button class="row" data-act="pick" data-id="${esc(t.id)}">${this._thumb("", realEmoji(t.emoji) || foodEmoji(t.name) || aisle.emoji, aisle.color)}
        <span class="info"><div class="nm">${esc(t.name)}</div></span></button>`;
    }).join("") + (exact ? "" : `<button class="row" data-act="create">
        <span class="th" style="--tint:var(--primary-color)"><ha-icon icon="mdi:plus"></ha-icon></span>
        <span class="info"><div class="nm">Create “${esc(typed)}”</div><div class="amt">New food</div></span></button>`);
  }

  _pickTemplate(id) {
    const t = this._tpl(id);
    if (!t) return;
    this._openNew({ name: t.name, template_id: t.id, emoji: realEmoji(t.emoji) || "" });
  }

  async _createTemplate() {
    const input = this.shadowRoot.getElementById("tq");
    const name = input && input.value.trim();
    if (!name) return;
    const pretty = name.charAt(0).toUpperCase() + name.slice(1);
    const tpl = await this._run(async () => (await this._ws("add_template", { template: { name: pretty } })).template);
    if (tpl) this._openNew({ name: tpl.name, template_id: tpl.id });
  }

  /* ---- scanning ------------------------------------------------------------ */

  _scanHtml() {
    return `<div class="dhead"><div class="info"><div class="nm">Scan</div>
        <div class="amt">A shop barcode or one of your labels</div></div>${this._closeBtn()}</div>
      <div class="cam" id="cam"><video id="video" playsinline muted></video><div class="frame"></div></div>
      <div class="sst" id="sst"></div>
      <div id="scanx"></div>`;
  }

  _renderScanExtras() {
    const box = this.shadowRoot.getElementById("scanx");
    const d = this._dlg;
    if (!box || !d) return;
    box.innerHTML = d.typing
      ? `<div class="inrow" style="margin-top:8px"><input id="code" inputmode="text" autocapitalize="characters" placeholder="Barcode or label code" autocomplete="off" enterkeyhint="search">
          <button class="btn primary" data-act="lookup">Look up</button></div>`
      : `<button class="linkbtn" data-act="type">Type the number instead</button>`;
    this._camStatus(d.status || "", d.statusBad);
  }

  _camStatus(text, bad = false) {
    if (this._dlg) { this._dlg.status = text; this._dlg.statusBad = bad; }
    const s = this.shadowRoot.getElementById("sst");
    if (!s) return;
    s.textContent = text || "";
    s.classList.toggle("bad", !!bad);
  }

  async _startCamera() {
    if (this._cam) return;
    const video = this.shadowRoot.getElementById("video");
    if (!video) return;
    const bd = "BarcodeDetector" in window;
    const zxing = bd ? null : await loadZXing();
    if (!(bd || zxing) || !window.isSecureContext || !navigator.mediaDevices) {
      this.shadowRoot.getElementById("cam").hidden = true;
      if (this._dlg) this._dlg.typing = true;
      this._renderScanExtras();
      this._camStatus(window.isSecureContext ? "The camera can't read barcodes here — type the number." : "The camera needs the HTTPS address — type the number.", true);
      this._focus("code");
      return;
    }
    const cam = { stopped: false, stream: null, timer: null };
    this._cam = cam;
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, aspectRatio: { ideal: 4 / 3 } },
      });
    } catch (e) {
      this._stopCamera();
      const box = this.shadowRoot.getElementById("cam");
      if (box) box.hidden = true;
      if (this._dlg) this._dlg.typing = true;
      this._renderScanExtras();
      this._camStatus("No camera access — type the number.", true);
      this._focus("code");
      return;
    }
    if (cam.stopped) { cam.stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = cam.stream;
    try { await video.play(); } catch (e) { /* autoplay quirks */ }
    this._camStatus("Point the camera at the barcode.");
    const found = (raw) => { if (!cam.stopped) this._onCode(raw); };
    if (bd) {
      const det = await makeDetector();
      const tick = async () => {
        if (cam.stopped) return;
        try {
          const codes = await det.detect(video);
          if (codes && codes.length) { found(codes[0].rawValue); return; }
        } catch (e) { /* transient */ }
        cam.timer = setTimeout(tick, 170);
      };
      cam.resume = tick;
      tick();
    } else {
      const hints = new Map();
      hints.set(zxing.DecodeHintType.TRY_HARDER, true);
      const reader = new zxing.BrowserMultiFormatReader(hints);
      const crop = document.createElement("canvas");
      const ctx = crop.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (cam.stopped) return;
        const vw = video.videoWidth, vh = video.videoHeight;
        if (vw && vh) {
          const sx = Math.round(vw * 0.08), sy = Math.round(vh * 0.30);
          const sw = Math.round(vw * 0.84), sh = Math.round(vh * 0.40);
          if (crop.width !== sw) crop.width = sw;
          if (crop.height !== sh) crop.height = sh;
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          try {
            const src = new zxing.HTMLCanvasElementLuminanceSource(crop);
            const result = reader.decodeBitmap(new zxing.BinaryBitmap(new zxing.HybridBinarizer(src)));
            if (result) { found(result.getText()); return; }
          } catch (e) { /* nothing in this frame */ }
        }
        cam.timer = setTimeout(tick, 150);
      };
      cam.resume = tick;
      tick();
    }
  }

  _stopCamera() {
    const cam = this._cam;
    if (!cam) return;
    cam.stopped = true;
    if (cam.timer) clearTimeout(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    this._cam = null;
    const video = this.shadowRoot && this.shadowRoot.getElementById("video");
    if (video) video.srcObject = null;
  }

  /* Keep looking after a code that leads nowhere. */
  _resumeCamera(text) {
    this._camStatus(text, true);
    const cam = this._cam;
    if (cam && cam.resume) cam.timer = setTimeout(cam.resume, 1500);
  }

  _lookupTyped() {
    const input = this.shadowRoot.getElementById("code");
    const v = input && input.value.trim();
    if (v) this._onCode(v, true);
  }

  async _onCode(raw, typed = false) {
    const val = String(raw || "").trim().toUpperCase().replace(/^\*|\*$/g, "");
    if (this._looking) return;
    const own = OWN_CODE_RE.exec(val);
    if (own) {
      const it = this._items().find((i) => (i.code || "").toUpperCase() === own[1]);
      if (it) { this._openItem(it.id); return; }
      if (typed) this._camStatus(`Nothing in stock has label ${val}.`, true);
      else this._resumeCamera(`Nothing in stock has label ${val}.`);
      return;
    }
    const code = val.replace(/\D/g, "");
    if (!/^\d{8,14}$/.test(code) || code.length !== val.replace(/\s/g, "").length) {
      if (typed) this._camStatus("That isn't a barcode or label code.", true);
      else this._resumeCamera("That isn't a product barcode — try again.");
      return;
    }
    // In stock already: the one that runs out first, wherever it is
    // (this place first).
    const have = this._items().filter((i) => (i.barcode || "") === code)
      .sort((a, b) => (a.location !== this._config.location) - (b.location !== this._config.location) || byExpiry(a, b));
    if (have.length) { this._openItem(have[0].id); return; }
    this._looking = true;
    this._camStatus(`Looking up ${code}…`);
    let res = null;
    try { res = await this._ws("lookup_barcode", { barcode: code }); } catch (e) { res = null; }
    this._looking = false;
    if (!this._dlg || this._dlg.mode !== "scan") return;
    const known = res && res.known;
    const product = res && res.product;
    const src = known || product || {};
    this._stopCamera();
    await this._openNew({
      name: src.name || "",
      barcode: code,
      photo: src.photo || "",
      emoji: realEmoji(src.emoji) || "",
      quantity: (product && product.quantity) || src.quantity || "",
    });
    if (!src.name) this._toast("Barcode not recognised — give it a name.");
  }

  /* ---- toast --------------------------------------------------------------- */

  _toast(text, opts = {}) {
    const t = this.shadowRoot && this.shadowRoot.getElementById("toast");
    if (!t) return;
    clearTimeout(this._toastTimer);
    t.className = `toast${opts.bad ? " bad" : ""}`;
    t.innerHTML = `<span>${esc(text)}</span>${opts.action ? `<button type="button">${esc(opts.action)}</button>` : ""}`;
    const btn = t.querySelector("button");
    const hide = () => { try { t.hidePopover(); } catch (e) { t.classList.remove("inline"); } };
    if (btn) btn.addEventListener("click", () => { hide(); opts.onAction && opts.onAction(); });
    try { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); }
    catch (e) { t.classList.add("inline"); }
    this._toastTimer = setTimeout(hide, opts.action ? 7000 : 3500);
  }
}

if (!customElements.get("fridge-assistant-stock-card")) {
  customElements.define("fridge-assistant-stock-card", FridgeAssistantStockCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-stock-card",
    name: "Fridge Assistant stock",
    description: "What's in one place (pantry, fridge, …), by aisle — tap to eat, toss, print or move; scan or add.",
  });
}
