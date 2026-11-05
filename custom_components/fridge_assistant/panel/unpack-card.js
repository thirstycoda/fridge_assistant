/* Fridge Assistant — unpack card.
 *
 * A dashboard card for putting a delivery away. It shows the open lines of a
 * to-do list (filled from an order, e.g. by the Ocado integration), lets you
 * scan a product's barcode or tap a line, and then press where it goes:
 * Cupboard, Fridge, Freezer or Pantry. The item is added to Fridge Assistant
 * (the barcode is remembered for next time). The line is counted down and,
 * once everything on it is put away, ticked off; ticked lines stay on the list
 * showing where things went, with an undo.
 *
 *   type: custom:fridge-assistant-unpack-card
 *   todo_entity: todo.ocado_delivery
 *   delivery_entity: sensor.ocado_uk_deliveries_next_delivery   # optional countdown
 *   title: Unpack            # optional
 *   notes: Ocado             # optional, saved on items that came from a line
 *
 * Each line's description may hold JSON from the filling automation:
 *   {"name": "<product title>", "qty": 2, "location": "auto"|"fridge"|...,
 *    "ordered": "<original product, when this line is a substitute>"}
 * Without it, the summary ("2 × Product") is parsed instead. The card adds
 * "total" (the ordered quantity), keeps "qty" as what's left to put away and
 * records each placement in "placed": [{"id", "name", "location", "qty"}].
 *
 * When the product's food tracks amounts, a "How much" box is filled in from
 * the scanned product's size, a size in its name ("400g", "4 x 400g",
 * "4 Jacket Potatoes") or the usual pack size, and can be changed (in the
 * food's own unit or a sensible other one: 4 potatoes, 0.2 kg) before
 * picking where it goes.
 *
 * The delivery entity's state is the window start (a timestamp); its
 * "delivery_window" attribute ("20:00 - 21:00") gives the end.
 */

// Aisles and food emoji, shared with the shopping list (same version as this file).
const { AISLES, aisleOf, foodEmoji } = await import(new URL(`./lib/food-look.js${new URL(import.meta.url).search}`, import.meta.url));

const LOCATIONS = [
  { key: "cupboard", label: "Cupboard", icon: "mdi:cupboard-outline" },
  { key: "fridge", label: "Fridge", icon: "mdi:fridge" },
  { key: "freezer", label: "Freezer", icon: "mdi:snowflake" },
  { key: "pantry", label: "Pantry", icon: "mdi:basket-outline" },
];
const LOCATION_LABEL = Object.fromEntries(LOCATIONS.map((l) => [l.key, l.label]));

const QTY_RE = /^\s*(\d+)\s*[×x]\s*/i;
// Words that say nothing about what a product is, ignored when comparing a
// scanned product's name with an order line.
const STOP = new Set([
  "the", "and", "with", "of", "in", "a", "an", "for", "from", "to",
  "organic", "british", "fresh", "free", "range", "pack", "family", "large",
  "medium", "small", "loose", "ocado", "m", "s", "ms", "tesco", "sainsbury",
  "sainsburys", "waitrose", "essential", "finest", "plant", "kitchen", "vegan",
  "g", "kg", "ml", "l", "x",
]);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => w.replace(/(ies)$/, "y").replace(/(oes)$/, "o").replace(/([^s])s$/, "$1"));
}

function parseLine(item) {
  let info = {};
  try { info = JSON.parse(item.description || "{}") || {}; } catch (e) { info = {}; }
  const m = QTY_RE.exec(item.summary || "");
  const done = item.status === "completed";
  const total = Number(info.total) || (m ? Number(m[1]) : 0) || Number(info.qty) || 1;
  const left = done ? 0 : (info.qty != null && info.qty !== "" ? Number(info.qty) : total);
  const placed = Array.isArray(info.placed) ? info.placed : [];
  const name = info.name
    || (item.summary || "").replace(QTY_RE, "").replace(/\s*\(substitute\)\s*$/i, "").trim();
  return { uid: item.uid, summary: item.summary, info, qty: Math.max(0, left), total, placed, done, name };
}

function pad(n) { return String(n).padStart(2, "0"); }

const UNIT_NAMES = { kg: "kg", g: "g", gram: "g", grams: "g", ml: "ml", cl: "cl", l: "l", litre: "l", litres: "l", liter: "l", liters: "l", ltr: "l" };

/* A pack size from a barcode's product data or a product title: "4 x 400g"
 * -> {quantity: 1600, unit: "g"}, "1L" -> 1 l, "M&S 4 Jacket Potatoes" or
 * "Pack of 6" -> 4 / 6 each. */
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
  const unit = tpl.amount_unit;
  const per = Object.keys(tpl.per || {});
  const family = (u) => (u === "g" || u === "kg" ? ["g", "kg"] : u === "ml" || u === "l" ? ["ml", "l"] : [u]);
  const out = [...family(unit)];
  for (const k of per) {
    if (["g", "ml"].includes(k)) out.push(...family(k));
    else if (["each", "can", "tin", "pot", "block", "pack", "bottle", "jar"].includes(k)) out.push(k);
  }
  return [...new Set(out)];
}

/* Delivery window from the delivery entity: {start, end} as Dates, or null. */
function deliveryWindow(stateObj) {
  if (!stateObj) return null;
  const start = new Date(stateObj.state);
  if (Number.isNaN(start.getTime())) return null;
  let end = null;
  const w = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(stateObj.attributes.delivery_window || "");
  if (w) {
    const mins = (Number(w[3]) * 60 + Number(w[4])) - (Number(w[1]) * 60 + Number(w[2]));
    end = new Date(start.getTime() + ((mins + 1440) % 1440 || 60) * 60000);
  } else end = new Date(start.getTime() + 3600000);
  return { start, end };
}

function until(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"} ${h % 24} h`;
  return `${h} h ${pad(m % 60)} min`;
}

function makeDetector() {
  const wanted = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];
  return window.BarcodeDetector.getSupportedFormats()
    .then((sup) => wanted.filter((f) => sup.includes(f)))
    .catch(() => null)
    .then((formats) => (formats && formats.length
      ? new window.BarcodeDetector({ formats })
      : new window.BarcodeDetector()));
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

class FridgeAssistantUnpackCard extends HTMLElement {
  static getStubConfig() {
    return { todo_entity: "todo.ocado_delivery" };
  }

  setConfig(config) {
    if (!config || !config.todo_entity) throw new Error("Set todo_entity (e.g. todo.ocado_delivery)");
    this._config = { title: "Unpack", notes: "Ocado", ...config };
    this._lines = this._lines || [];
    this._all = this._all || [];
    this._loaded = this._loaded || false;
    this._matchCache = this._matchCache || new Map();
    this._sel = this._sel || null;
    if (this.shadowRoot) this._renderAll();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    if (first || !this._unsub) this._subscribe();
    const ent = this._config && this._config.delivery_entity;
    const st = ent ? hass.states[ent] : null;
    if (st !== this._deliveryState) { this._deliveryState = st; this._renderHead(); }
  }

  getCardSize() { return 6; }

  connectedCallback() {
    if (this._hass && !this._unsub) this._subscribe();
    if (!this._tick) this._tick = setInterval(() => this._renderHead(), 30000);
  }

  disconnectedCallback() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this._stopCamera();
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  // ---- data ---------------------------------------------------------------

  _subscribe() {
    if (!this._hass || !this._config || this._unsub || !this.isConnected) return;
    this._unsub = this._hass.connection.subscribeMessage(
      (msg) => {
        this._all = (msg.items || []).map(parseLine);
        this._lines = this._all.filter((l) => !l.done && l.qty > 0);
        this._loaded = true;
        if (this._sel && this._sel.line) {
          const fresh = this._all.find((l) => l.uid === this._sel.line.uid) || null;
          this._sel.line = fresh;
          if (fresh) this._sel.qty = Math.min(Math.max(1, this._sel.qty), Math.max(1, fresh.qty));
        }
        this._renderList();
        this._renderSel();
        this._lines.forEach((l) => this._match(l.name).then(() => this._renderList()));
      },
      { type: "todo/item/subscribe", entity_id: this._config.todo_entity },
    ).catch((err) => {
      this._unsub = null;
      this._status(`Couldn't read ${this._config.todo_entity}: ${err.message || err}`, true);
      return null;
    });
  }

  _match(text) {
    const key = String(text || "").trim().toLowerCase();
    if (!key) return Promise.resolve(null);
    if (!this._matchCache.has(key)) {
      const p = this._hass.callWS({ type: "fridge_assistant/match_template", query: text })
        .catch(() => null)
        .then((v) => { p._value = v; return v; });
      this._matchCache.set(key, p);
    }
    return this._matchCache.get(key);
  }

  _cachedMatch(text) {
    const p = this._matchCache.get(String(text || "").trim().toLowerCase());
    return p && p._value;
  }

  // ---- selection ------------------------------------------------------------

  async _lineLocation(line) {
    const loc = line && line.info && line.info.location;
    if (loc && loc !== "auto" && LOCATION_LABEL[loc]) return loc;
    const res = line ? await this._match(line.name) : null;
    return (res && res.location) || null;
  }

  async _selectLine(line) {
    const keep = this._sel && !this._sel.line ? this._sel : null;   // a scan waiting for its line
    this._sel = {
      line,
      product: keep ? keep.product : null,
      barcode: keep ? keep.barcode : null,
      qty: Math.max(1, line.qty),
      suggested: null,
    };
    this._renderSel();
    this._renderList();
    this._sel.suggested = await this._lineLocation(line);
    await this._guessAmount(this._sel);
    this._renderSel();
    this.shadowRoot.getElementById("sel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async _bestLine(name) {
    if (!name || !this._lines.length) return null;
    const res = await this._match(name);
    const tplId = res && res.template && res.template.id;
    if (tplId) {
      const results = await Promise.all(this._lines.map((l) => this._match(l.name)));
      const same = this._lines.filter((l, i) => results[i] && results[i].template && results[i].template.id === tplId);
      if (same.length) return same[0];
    }
    const want = new Set(tokens(name));
    if (!want.size) return null;
    let best = null, bestScore = 0;
    for (const l of this._lines) {
      const have = new Set(tokens(l.name));
      let shared = 0;
      want.forEach((w) => { if (have.has(w)) shared += 1; });
      const score = shared / Math.max(want.size, 1);
      if (shared && score > bestScore) { best = l; bestScore = score; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  async _onBarcode(raw) {
    const code = String(raw || "").replace(/\D/g, "");
    if (!code) { this._status("That isn't a product barcode.", true); return; }
    this._stopCamera();
    this._status(`Looking up ${code}…`);
    let res = null;
    try { res = await this._hass.callWS({ type: "fridge_assistant/lookup_barcode", barcode: code }); }
    catch (e) { res = null; }
    const known = res && res.known;
    const product = (res && res.product) || null;
    const name = (known && known.name) || (product && product.name) || null;
    const line = await this._bestLine(name) || (product && product.brand
      ? await this._bestLine(`${product.brand} ${product.name}`) : null);
    this._sel = {
      line,
      barcode: code,
      product: name ? {
        name,
        known: !!known,
        photo: (known && known.photo) || (product && product.photo) || "",
        brand: (product && product.brand) || "",
        size: (product && product.quantity) || "",
      } : null,
      qty: line ? line.qty : 1,
      suggested: null,
    };
    if (!name) this._status(`Barcode ${code} isn't known yet — tap its line below, then pick where it goes.`);
    else if (!line) this._status(`Not on the list — pick its line below, or just pick where it goes.`);
    else this._status("");
    this._renderSel();
    this._renderList();
    const sugLine = line ? await this._lineLocation(line) : null;
    const sugProd = !sugLine && name ? ((await this._match(name)) || {}).location : null;
    if (this._sel && this._sel.barcode === code) {
      this._sel.suggested = sugLine || sugProd || null;
      await this._guessAmount(this._sel);
      this._renderSel();
    }
  }

  /* Best guess of how much one pack holds, for the amount box: the scanned
   * product's size, else a size in the product's or line's name, else the
   * template's usual pack size. Only for foods whose amount is tracked. */
  async _guessAmount(sel) {
    if (!sel) return;
    const name = (sel.line && sel.line.name) || (sel.product && sel.product.name) || "";
    const res = name ? await this._match(name) : null;
    const found = res && res.template;
    if (sel !== this._sel) return;
    sel.amountTouched = false;
    // Every line gets a How much box. A food that isn't counted yet starts
    // being counted in whatever unit is given here (Fridge Assistant sets it up).
    const tpl = found && found.amount_unit ? found : null;
    sel.tpl = tpl;
    const units = tpl ? amountUnits(tpl) : ["each", "g", "kg", "ml", "l"];
    sel.units = units;
    const fits = (g) => g && units.includes(g.unit) ? g : null;
    const sized = fits(parseSize(sel.product && sel.product.size))
      || fits(parseSize(sel.product && sel.product.name))
      || fits(parseSize(sel.line && sel.line.name));
    sel.sized = !!sized;   // read off the product, not the usual pack size
    sel.per = sized || (tpl && tpl.pack_amount ? { quantity: Number(tpl.pack_amount), unit: tpl.amount_unit } : null);
    const firstUnit = found && found.category === "drinks" ? "ml" : "each";
    sel.amountUnit = sel.per ? sel.per.unit : tpl ? tpl.amount_unit : firstUnit;
    this._syncAmount(sel);
  }

  _syncAmount(sel) {
    if (!sel || sel.amountTouched) return;
    const q = sel.per ? sel.per.quantity * Math.max(1, Number(sel.qty) || 1) : null;
    sel.amount = q == null ? "" : String(Math.round(q * 100) / 100);
  }

  async _place(location) {
    const sel = this._sel;
    if (!sel || this._busy) return;
    const line = sel.line;
    const qty = Math.max(1, Number(sel.qty) || 1);
    const contents = line ? line.name : (sel.product && sel.product.name) || "";
    if (!contents) { this._status("Tap the product's line first.", true); return; }
    const notes = [];
    if (line) {
      notes.push(this._config.notes);
      if (line.info.ordered) notes.push(`substitute for ${line.info.ordered}`);
    } else if (sel.barcode) notes.push(`Retail barcode ${sel.barcode}`);
    const item = {
      contents,
      location,
      quantity: String(qty),
      notes: notes.filter(Boolean).join(" — ") || null,
    };
    // A product scanned before keeps the name it was given then.
    if (sel.product && sel.product.known) item.name = sel.product.name;
    if (sel.barcode) item.barcode = sel.barcode;
    if (sel.product && sel.product.photo) item.photo = sel.product.photo;
    const amount = Number(sel.amount);
    // Only an amount read off the product or typed in counts as known; the
    // usual pack size is left for Fridge Assistant to guess (and to check).
    if (sel.units && sel.amount !== "" && amount > 0 && (sel.amountTouched || sel.sized)) {
      item.amount = amount;
      item.amount_unit = sel.amountUnit || (sel.tpl && sel.tpl.amount_unit) || "each";
    }

    this._busy = true;
    this._renderSel();
    try {
      const res = await this._hass.callWS({ type: "fridge_assistant/add_item", item });
      const added = res && res.item;
      if (line) {
        const left = Math.max(0, line.qty - qty);
        const placed = line.placed.concat([{
          id: added ? added.id : null, name: added ? added.name : contents, location, qty,
        }]);
        await this._saveLine(line, { qty: left, placed });
      }
      const amt = item.amount ? ` (${item.amount} ${item.amount_unit === "each" ? "" : item.amount_unit})`.replace(" )", ")") : "";
      this._status(`✓ ${added ? added.name : contents}${qty > 1 ? ` ×${qty}` : ""}${amt} → ${LOCATION_LABEL[location]}`
        + (added && added.code ? ` (label ${added.code})` : ""));
      const again = sel.fromCamera;
      this._sel = null;
      this._renderSel();
      if (again) this._startCamera();
    } catch (err) {
      this._status(`Couldn't add it: ${err.message || err}`, true);
    } finally {
      this._busy = false;
      this._renderSel();
    }
  }

  async _saveLine(line, changes) {
    const info = { ...line.info, total: line.total, ...changes };
    const left = Number(info.qty) || 0;
    await this._hass.callService("todo", "update_item", {
      item: line.uid,
      description: JSON.stringify(info),
      status: left > 0 ? "needs_action" : "completed",
    }, { entity_id: this._config.todo_entity });
  }

  async _undo(line, index) {
    const p = line.placed[index];
    if (!p || this._busy) return;
    this._busy = true;
    this._renderSel();
    try {
      if (p.id) {
        try { await this._hass.callWS({ type: "fridge_assistant/remove_item", item_id: p.id }); }
        catch (e) { if (e.code !== "not_found") throw e; }   // already eaten or removed
      }
      const placed = line.placed.filter((_, i) => i !== index);
      await this._saveLine(line, { qty: Math.min(line.total, line.qty + (Number(p.qty) || 1)), placed });
      this._status(`Undone: ${p.name || line.name} is back on the list.`);
    } catch (err) {
      this._status(`Couldn't undo: ${err.message || err}`, true);
    } finally {
      this._busy = false;
      this._renderSel();
    }
  }

  // ---- camera ---------------------------------------------------------------

  async _startCamera() {
    if (this._cam) return;
    const box = this.shadowRoot.getElementById("cam");
    const video = this.shadowRoot.getElementById("video");
    const bd = "BarcodeDetector" in window;
    const zxing = bd ? null : await loadZXing();
    if (!(bd || zxing) || !window.isSecureContext || !navigator.mediaDevices) {
      this._status("Live scanning needs HTTPS and a camera — type the barcode instead.", true);
      this._showManual(true);
      return;
    }
    const cam = { stopped: false, stream: null, timer: null };
    this._cam = cam;
    box.hidden = false;
    this._renderHead();
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, aspectRatio: { ideal: 4 / 3 } },
      });
    } catch (e) {
      this._stopCamera();
      this._status("No camera access — type the barcode instead.", true);
      this._showManual(true);
      return;
    }
    if (cam.stopped) { cam.stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = cam.stream;
    try { await video.play(); } catch (e) { /* autoplay quirks */ }
    const found = (raw) => {
      if (cam.stopped) return;
      this._onBarcode(raw).then(() => { if (this._sel) this._sel.fromCamera = true; });
    };
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
      tick();
    }
    this._status("Point the camera at the barcode.");
  }

  _stopCamera() {
    const cam = this._cam;
    if (!cam) return;
    cam.stopped = true;
    if (cam.timer) clearTimeout(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    this._cam = null;
    if (this.shadowRoot) {
      this.shadowRoot.getElementById("cam").hidden = true;
      this.shadowRoot.getElementById("video").srcObject = null;
      this._renderHead();
    }
  }

  _showManual(show) {
    const m = this.shadowRoot.getElementById("manual");
    m.hidden = !show;
    if (show) setTimeout(() => this.shadowRoot.getElementById("code").focus(), 50);
  }

  // ---- rendering ------------------------------------------------------------

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        [hidden] { display: none !important; }
        .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .title { font-size: 20px; font-weight: 600; flex: 1 1 auto; }
        .sub { color: var(--secondary-text-color); font-size: 14px; }
        button { font: inherit; cursor: pointer; border-radius: 12px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); padding: 10px 14px; }
        button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
        button:disabled { opacity: .5; cursor: default; }
        .cam { position: relative; margin-top: 12px; border-radius: 12px; overflow: hidden; background: #000; }
        .cam video { width: 100%; display: block; max-height: 320px; object-fit: cover; }
        .cam .frame { position: absolute; left: 8%; right: 8%; top: 30%; bottom: 30%;
          border: 2px solid rgba(255,255,255,.85); border-radius: 10px; pointer-events: none; }
        .manual { display: flex; gap: 8px; margin-top: 12px; }
        .manual input { flex: 1; min-width: 0; font: inherit; padding: 10px 12px; border-radius: 12px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .status { margin-top: 10px; min-height: 1.2em; color: var(--secondary-text-color); }
        .status.bad { color: var(--error-color); }
        .sel { margin-top: 12px; padding: 12px; border-radius: 14px; background: var(--secondary-background-color); }
        .prod { display: flex; gap: 12px; align-items: center; }
        .prod img { width: 52px; height: 52px; object-fit: contain; border-radius: 8px; background: #fff; }
        .pname { font-weight: 600; }
        .pline { color: var(--secondary-text-color); font-size: 14px; margin-top: 2px; }
        select { font: inherit; max-width: 100%; margin-top: 8px; padding: 6px; border-radius: 8px;
          background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--divider-color); }
        .qty { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
        .qty button { padding: 4px 14px; font-size: 18px; }
        .amt { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
        .amt label { flex: 1 1 auto; color: var(--secondary-text-color); font-size: 14px; }
        .amt input { width: 90px; font: inherit; padding: 8px 10px; border-radius: 10px; text-align: right;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .amt select { margin-top: 0; }
        .locs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 12px; }
        @media (min-width: 560px) { .locs { grid-template-columns: repeat(4, 1fr); } }
        .loc { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 16px 8px; font-weight: 600; }
        .loc ha-icon { --mdc-icon-size: 32px; }
        .loc.sug { border: 2px solid var(--primary-color); }
        .loc small { font-weight: 400; color: var(--primary-color); font-size: 12px; min-height: 1em; }
        .cancel { margin-top: 10px; background: none; border: none; color: var(--secondary-text-color); padding: 4px 0; }
        .list { margin-top: 6px; display: flex; flex-direction: column; }
        .aisle-h { display: flex; align-items: center; gap: 6px; margin-top: 16px; font-size: 12px; font-weight: 600;
          text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color); padding: 0 2px 4px;
          border-bottom: 2px solid color-mix(in srgb, var(--tint) 45%, transparent); }
        .cnt { margin-left: auto; font-weight: 600; font-size: 12px; color: var(--secondary-text-color); }
        .th { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 12px; display: flex; align-items: center;
          justify-content: center; font-size: 22px; background: color-mix(in srgb, var(--tint) 20%, transparent); }
        /* Rows are flat list lines like the shopping list and pantry, not boxed buttons. */
        .row { display: flex; align-items: center; gap: 12px; text-align: left; width: 100%; padding: 9px 4px;
          background: none; border: none; border-radius: 0; color: inherit;
          border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 60%, transparent); }
        .row:last-child { border-bottom: none; }
        .row:hover { background: color-mix(in srgb, var(--secondary-background-color) 70%, transparent); }
        .row.on { background: var(--secondary-background-color); border-radius: 12px 12px 0 0; border-bottom-color: transparent; }
        .row.on:not(:has(+ .sel.inline)) { border-radius: 12px; }
        .sel.inline { margin: 0 0 6px; border-top-left-radius: 0; border-top-right-radius: 0; }
        .sel.inline .pname { display: none; }
        .sel.inline .prod:not(:has(img)):not(:has(.pline:not(:empty))) { display: none; }
        .row .n { flex: 1 1 auto; }
        .chip { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
        .empty { color: var(--secondary-text-color); margin-top: 14px; }
        .countdown { margin-top: 10px; padding: 12px 14px; border-radius: 14px;
          background: var(--secondary-background-color); display: flex; align-items: center; gap: 12px; }
        .countdown ha-icon { --mdc-icon-size: 28px; color: var(--primary-color); }
        .countdown .big { font-size: 22px; font-weight: 700; line-height: 1.2; }
        .countdown .when { color: var(--secondary-text-color); font-size: 14px; }
        .countdown.now { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .countdown.now ha-icon, .countdown.now .when { color: inherit; }
        .row.done { opacity: .6; }
        .row.done .n { text-decoration: line-through; }
        .tick { color: var(--success-color, #43a047); --mdc-icon-size: 20px; }
        .placed { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .placed div { display: flex; align-items: center; gap: 8px; }
        .placed span { flex: 1 1 auto; }
        .placed button { padding: 4px 12px; font-size: 14px; }
        .heading { margin-top: 22px; display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px;
          border-radius: 12px; border: none; font: inherit; font-size: 16px; font-weight: 600; text-align: left; cursor: pointer;
          color: var(--primary-text-color); background: color-mix(in srgb, var(--success-color, #43a047) 14%, transparent); }
        .heading ha-icon { --mdc-icon-size: 20px; color: var(--success-color, #43a047); }
        .heading .cnt { font-size: 13px; color: var(--success-color, #43a047); }
        .heading .chev { color: var(--secondary-text-color); transition: transform .2s; }
        .heading .chev.shut { transform: rotate(-90deg); }
      </style>
      <ha-card>
        <div class="head" id="head"></div>
        <div class="cam" id="cam" hidden><video id="video" playsinline muted></video><div class="frame"></div></div>
        <div class="manual" id="manual" hidden>
          <input id="code" inputmode="numeric" placeholder="Barcode number" autocomplete="off" enterkeyhint="search">
          <button class="primary" id="go">Look up</button>
        </div>
        <div class="status" id="status"></div>
        <div class="sel" id="sel" hidden></div>
        <div id="list"></div>
      </ha-card>`;
    root.getElementById("go").addEventListener("click", () => {
      const v = root.getElementById("code").value;
      root.getElementById("code").value = "";
      this._showManual(false);
      this._onBarcode(v);
    });
    root.getElementById("code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); root.getElementById("go").click(); }
    });
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("change", (e) => this._onChange(e));
    root.addEventListener("input", (e) => {
      if (e.target.id === "amt" && this._sel) { this._sel.amount = e.target.value; this._sel.amountTouched = true; }
    });
    this._renderAll();
  }

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "scan") { this._showManual(false); this._cam ? this._stopCamera() : this._startCamera(); }
    else if (act === "type") { this._stopCamera(); this._showManual(this.shadowRoot.getElementById("manual").hidden); }
    else if (act === "line") {
      const line = this._all.find((l) => l.uid === el.dataset.uid);
      if (line) this._selectLine(line);
    } else if (act === "loc") this._place(el.dataset.loc);
    else if (act === "undo" && this._sel && this._sel.line) this._undo(this._sel.line, Number(el.dataset.i));
    else if (act === "cancel") { this._sel = null; this._status(""); this._renderSel(); this._renderList(); }
    else if (act === "donetoggle") {
      this._doneShut = !this._doneShut;
      try { localStorage.setItem("fridge-assistant-unpack-done-shut", this._doneShut ? "1" : "0"); } catch (e) { /* fine */ }
      this._renderList();
    }
    else if (act === "minus" && this._sel) { this._sel.qty = Math.max(1, this._sel.qty - 1); this._syncAmount(this._sel); this._renderSel(); }
    else if (act === "plus" && this._sel) {
      const max = this._sel.line ? this._sel.line.qty : 99;
      this._sel.qty = Math.min(max, this._sel.qty + 1);
      this._syncAmount(this._sel);
      this._renderSel();
    }
  }

  async _onChange(e) {
    if (e.target.id === "amtunit" && this._sel) {
      this._sel.amountUnit = e.target.value;
      this._sel.amountTouched = true;
      return;
    }
    if (e.target.id !== "pick" || !this._sel) return;
    const line = this._lines.find((l) => l.uid === e.target.value) || null;
    this._sel.line = line;
    this._sel.qty = line ? line.qty : 1;
    this._sel.suggested = line ? await this._lineLocation(line)
      : (this._sel.product ? ((await this._match(this._sel.product.name)) || {}).location : null);
    await this._guessAmount(this._sel);
    this._renderSel();
    this._renderList();
  }

  _status(text, bad = false) {
    const s = this.shadowRoot && this.shadowRoot.getElementById("status");
    if (!s) return;
    s.textContent = text || "";
    s.classList.toggle("bad", !!bad);
  }

  _renderAll() { this._renderHead(); this._renderSel(); this._renderList(); }

  _renderHead() {
    const h = this.shadowRoot && this.shadowRoot.getElementById("head");
    if (!h || !this._config) return;
    const n = this._lines.length;
    const total = this._all.length;
    const sub = !this._loaded ? "Loading…"
      : !total ? "Nothing on the list yet"
        : n ? `${total - n} of ${total} lines put away`
          : `All ${total} lines put away`;
    h.innerHTML = `
      <div class="title">${esc(this._config.title)}
        <div class="sub">${sub}</div>
      </div>
      <button class="primary" data-act="scan" title="${this._cam ? "Stop scanning" : "Scan a barcode"}"
        aria-label="${this._cam ? "Stop scanning" : "Scan a barcode"}"><ha-icon icon="${this._cam ? "mdi:close" : "mdi:barcode-scan"}"></ha-icon></button>
      <button data-act="type" title="Type a barcode"><ha-icon icon="mdi:keyboard-outline"></ha-icon></button>
      ${this._countdownHtml()}`;
  }

  _countdownHtml() {
    const win = deliveryWindow(this._deliveryState);
    if (!win) return "";
    const now = Date.now();
    const t = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = win.start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    let cls = "", icon = "mdi:truck-delivery-outline", big, when;
    if (now < win.start.getTime()) {
      big = `Delivery in ${until(win.start.getTime() - now)}`;
      when = `${day}, ${t(win.start)}–${t(win.end)}`;
    } else if (now < win.end.getTime()) {
      cls = " now"; icon = "mdi:truck-fast-outline";
      big = "Delivery due now";
      when = `Window ends ${t(win.end)} (${until(win.end.getTime() - now)})`;
    } else {
      icon = "mdi:package-variant-closed-check";
      big = "Delivered";
      when = `${day}, ${t(win.start)}–${t(win.end)}`;
    }
    return `<div class="countdown${cls}" style="flex-basis:100%"><ha-icon icon="${icon}"></ha-icon>
      <div><div class="big">${esc(big)}</div><div class="when">${esc(when)}</div></div></div>`;
  }

  _renderSel() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("sel");
    if (!box) return;
    const sel = this._sel;
    box.hidden = !sel;
    if (!sel) { box.innerHTML = ""; this._placeSel(); return; }
    const p = sel.product;
    const line = sel.line;
    const open = !line || line.qty > 0;
    const title = line ? line.name : (p ? p.name : `Barcode ${sel.barcode}`);
    const subParts = [];
    if (p && line && p.name !== line.name) subParts.push(`Scanned: ${p.name}`);
    if (!line) subParts.push(this._lines.length ? "Not matched to a line" : "Not on the list");
    if (line && line.info.ordered) subParts.push(`Substitute for ${line.info.ordered}`);
    if (line && !open) subParts.push("All put away");
    const options = [`<option value="">— not on the list —</option>`]
      .concat(this._lines.map((l) => `<option value="${esc(l.uid)}"${line && l.uid === line.uid ? " selected" : ""}>${esc(l.summary)}</option>`))
      .join("");
    const max = line ? line.qty : 99;
    const placed = line ? line.placed : [];
    box.innerHTML = `
      <div class="prod">
        ${p && p.photo ? `<img src="${esc(p.photo)}" alt="">` : ""}
        <div>
          <div class="pname">${esc(title)}</div>
          <div class="pline">${esc(subParts.join(" · "))}</div>
        </div>
      </div>
      ${placed.length ? `<div class="placed">${placed.map((pl, i) => `
        <div><ha-icon class="tick" icon="mdi:check-circle"></ha-icon>
          <span>${esc(pl.qty > 1 ? `${pl.qty} × ` : "")}${esc(pl.name || line.name)} → ${esc(LOCATION_LABEL[pl.location] || pl.location || "?")}</span>
          <button data-act="undo" data-i="${i}" ${this._busy ? "disabled" : ""}>Undo</button></div>`).join("")}
      </div>` : ""}
      ${open && sel.barcode && this._lines.length ? `<select id="pick" aria-label="Order line">${options}</select>` : ""}
      ${open && (max > 1 || sel.qty > 1) ? `
        <div class="qty">
          <button data-act="minus" ${sel.qty <= 1 ? "disabled" : ""}>−</button>
          <span>${sel.qty}${line ? ` of ${line.qty} left` : ""}</span>
          <button data-act="plus" ${sel.qty >= max ? "disabled" : ""}>+</button>
        </div>` : ""}
      ${open && sel.units ? `
        <div class="amt">
          <label for="amt">${sel.qty > 1 ? "How much in total" : "How much"}</label>
          <input id="amt" type="number" inputmode="decimal" min="0" step="any" value="${esc(sel.amount || "")}" placeholder="?">
          <select id="amtunit" aria-label="Unit">${sel.units.map((u) =>
            `<option value="${esc(u)}"${u === sel.amountUnit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
        </div>` : ""}
      ${open ? `<div class="locs">
        ${LOCATIONS.map((l) => `
          <button class="loc${sel.suggested === l.key ? " sug" : ""}" data-act="loc" data-loc="${l.key}" ${this._busy || (!line && !p) ? "disabled" : ""}>
            <ha-icon icon="${l.icon}"></ha-icon>${l.label}<small>${sel.suggested === l.key ? "usual place" : ""}</small>
          </button>`).join("")}
      </div>` : ""}
      <button class="cancel" data-act="cancel">${open ? "Cancel" : "Close"}</button>`;
    this._placeSel();
  }

  /* The options open right under the line they're for; a scan that isn't
   * on the list keeps them at the top, by the Scan button. */
  _placeSel() {
    const root = this.shadowRoot;
    const node = root && root.getElementById("sel");
    const list = root && root.getElementById("list");
    if (!node || !list) return;
    const uid = this._sel && this._sel.line && this._sel.line.uid;
    const row = uid ? list.querySelector(`[data-act="line"][data-uid="${CSS.escape(uid)}"]`) : null;
    if (row) {
      if (row.nextElementSibling !== node) row.after(node);
      node.classList.add("inline");
    } else {
      if (node.parentNode !== list.parentNode || node.nextElementSibling !== list) list.before(node);
      node.classList.remove("inline");
    }
  }

  _rowHtml(l, selUid) {
    // Where it went, or how many are still to put away. Where it should go
    // shows when the line is tapped, so it isn't repeated on every row.
    const where = (pl) => LOCATION_LABEL[pl.location] || "";
    let chip = "";
    if (l.qty <= 0) chip = [...new Set(l.placed.map(where).filter(Boolean))].join(", ");
    else if (l.placed.length) chip = `${l.qty} left`;
    const look = this._look(l);
    return `<button class="row${l.qty <= 0 ? " done" : ""}${l.uid === selUid ? " on" : ""}" data-act="line" data-uid="${esc(l.uid)}">
      <span class="th" style="--tint:${look.aisle.color}">${esc(look.emoji)}</span>
      <span class="n">${esc(l.summary)}</span>
      ${l.qty <= 0 ? `<ha-icon class="tick" icon="mdi:check-circle"></ha-icon>` : ""}
      ${chip ? `<span class="chip">${esc(chip)}</span>` : ""}
    </button>`;
  }

  /* Which aisle a line belongs in and its emoji, from the matched food. */
  _look(l) {
    const m = this._cachedMatch(l.name);
    const tpl = m && m.template;
    const aisle = aisleOf({ category: tpl && tpl.category, name: (tpl && tpl.name) || l.name });
    const own = tpl && tpl.emoji && tpl.emoji !== "🍽️" ? tpl.emoji : null;
    return { aisle, emoji: own || foodEmoji(l.name) || foodEmoji(tpl && tpl.name) || aisle.emoji };
  }

  _grouped(lines, selUid) {
    return AISLES.map((a) => {
      const these = lines.filter((l) => this._look(l).aisle === a);
      return these.length ? `<div class="aisle-h" style="--tint:${a.color}"><span>${a.emoji}</span>${esc(a.name)}<span class="cnt">${these.length}</span></div>
        <div class="list">${these.map((l) => this._rowHtml(l, selUid)).join("")}</div>` : "";
    }).join("");
  }

  _renderList() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("list");
    if (!box) return;
    // The options box may be sitting inside the list: keep it out of the redraw.
    const selNode = this.shadowRoot.getElementById("sel");
    if (selNode && box.contains(selNode)) box.before(selNode);
    this._renderHead();
    if (!this._loaded) { box.innerHTML = ""; return; }
    if (!this._all.length) {
      box.innerHTML = `<div class="empty">The order appears here when the delivery window opens. Scan anything to add it to Fridge Assistant.</div>`;
      return;
    }
    const selUid = this._sel && this._sel.line && this._sel.line.uid;
    const done = this._all.filter((l) => l.qty <= 0);
    if (this._doneShut == null) {
      try { this._doneShut = localStorage.getItem("fridge-assistant-unpack-done-shut") === "1"; } catch (e) { this._doneShut = false; }
    }
    box.innerHTML = `
      ${this._lines.length ? this._grouped(this._lines, selUid) : ""}
      ${done.length ? `<button class="heading" data-act="donetoggle" aria-expanded="${!this._doneShut}">
          <ha-icon icon="mdi:check-circle-outline"></ha-icon>Put away<span class="cnt">${done.length}</span>
          <ha-icon class="chev${this._doneShut ? " shut" : ""}" icon="mdi:chevron-down"></ha-icon></button>
        ${this._doneShut ? "" : `<div class="list">${done.map((l) => this._rowHtml(l, selUid)).join("")}</div>`}` : ""}`;
    this._placeSel();
  }
}

if (!customElements.get("fridge-assistant-unpack-card")) {
  customElements.define("fridge-assistant-unpack-card", FridgeAssistantUnpackCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "fridge-assistant-unpack-card",
    name: "Fridge Assistant unpack",
    description: "Scan or tap each delivered item, then press Cupboard, Fridge, Freezer or Pantry.",
  });
}
