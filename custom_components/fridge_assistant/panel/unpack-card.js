/* Fridge Assistant — unpack card.
 *
 * A dashboard card for putting a delivery away. It shows the open lines of a
 * to-do list (filled from an order, e.g. by the Ocado integration), lets you
 * scan a product's barcode or tap a line, and then press where it goes:
 * Cupboard, Fridge, Freezer or Pantry. The item is added to Fridge Assistant
 * (the barcode is remembered for next time) and the line is counted down or
 * removed from the list.
 *
 *   type: custom:fridge-assistant-unpack-card
 *   todo_entity: todo.ocado_delivery
 *   title: Unpack            # optional
 *   notes: Ocado             # optional, saved on items that came from a line
 *
 * Each line's description may hold JSON from the filling automation:
 *   {"name": "<product title>", "qty": 2, "location": "auto"|"fridge"|...,
 *    "ordered": "<original product, when this line is a substitute>"}
 * Without it, the summary ("2 × Product") is parsed instead.
 */

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
  const qty = Number(info.qty) || (m ? Number(m[1]) : 1) || 1;
  const name = info.name
    || (item.summary || "").replace(QTY_RE, "").replace(/\s*\(substitute\)\s*$/i, "").trim();
  return { uid: item.uid, summary: item.summary, info, qty, name };
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
  }

  getCardSize() { return 6; }

  connectedCallback() { if (this._hass && !this._unsub) this._subscribe(); }

  disconnectedCallback() {
    this._stopCamera();
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
  }

  // ---- data ---------------------------------------------------------------

  _subscribe() {
    if (!this._hass || !this._config || this._unsub || !this.isConnected) return;
    this._unsub = this._hass.connection.subscribeMessage(
      (msg) => {
        this._lines = (msg.items || [])
          .filter((i) => i.status === "needs_action")
          .map(parseLine);
        this._loaded = true;
        if (this._sel && this._sel.line && !this._lines.find((l) => l.uid === this._sel.line.uid)) {
          this._sel.line = null;
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
      qty: line.qty,
      suggested: null,
    };
    this._renderSel();
    this._sel.suggested = await this._lineLocation(line);
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
      } : null,
      qty: line ? line.qty : 1,
      suggested: null,
    };
    if (!name) this._status(`Barcode ${code} isn't known yet — tap its line below, then pick where it goes.`);
    else if (!line) this._status(`Not on the list — pick its line below, or just pick where it goes.`);
    else this._status("");
    this._renderSel();
    const sugLine = line ? await this._lineLocation(line) : null;
    const sugProd = !sugLine && name ? ((await this._match(name)) || {}).location : null;
    if (this._sel && this._sel.barcode === code) {
      this._sel.suggested = sugLine || sugProd || null;
      this._renderSel();
    }
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

    this._busy = true;
    this._renderSel();
    try {
      const res = await this._hass.callWS({ type: "fridge_assistant/add_item", item });
      if (line) {
        const left = line.qty - qty;
        const target = { entity_id: this._config.todo_entity };
        if (left <= 0) {
          await this._hass.callService("todo", "remove_item", { item: line.uid }, target);
        } else {
          const info = { ...line.info, qty: left };
          const rename = QTY_RE.test(line.summary)
            ? line.summary.replace(QTY_RE, `${left} × `)
            : `${left} × ${line.summary}`;
          await this._hass.callService("todo", "update_item",
            { item: line.uid, rename, description: JSON.stringify(info) }, target);
        }
      }
      const added = res && res.item;
      this._status(`✓ ${added ? added.name : contents}${qty > 1 ? ` ×${qty}` : ""} → ${LOCATION_LABEL[location]}`
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
        .locs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 12px; }
        @media (min-width: 560px) { .locs { grid-template-columns: repeat(4, 1fr); } }
        .loc { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 16px 8px; font-weight: 600; }
        .loc ha-icon { --mdc-icon-size: 32px; }
        .loc.sug { border: 2px solid var(--primary-color); }
        .loc small { font-weight: 400; color: var(--primary-color); font-size: 12px; min-height: 1em; }
        .cancel { margin-top: 10px; background: none; border: none; color: var(--secondary-text-color); padding: 4px 0; }
        .list { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
        .row { display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; padding: 10px 12px; }
        .row.on { border-color: var(--primary-color); background: var(--secondary-background-color); }
        .row .n { flex: 1 1 auto; }
        .chip { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
        .empty { color: var(--secondary-text-color); margin-top: 14px; }
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
    this._renderAll();
  }

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "scan") { this._showManual(false); this._cam ? this._stopCamera() : this._startCamera(); }
    else if (act === "type") { this._stopCamera(); this._showManual(this.shadowRoot.getElementById("manual").hidden); }
    else if (act === "line") {
      const line = this._lines.find((l) => l.uid === el.dataset.uid);
      if (line) this._selectLine(line);
    } else if (act === "loc") this._place(el.dataset.loc);
    else if (act === "cancel") { this._sel = null; this._status(""); this._renderSel(); this._renderList(); }
    else if (act === "minus" && this._sel) { this._sel.qty = Math.max(1, this._sel.qty - 1); this._renderSel(); }
    else if (act === "plus" && this._sel) {
      const max = this._sel.line ? this._sel.line.qty : 99;
      this._sel.qty = Math.min(max, this._sel.qty + 1);
      this._renderSel();
    }
  }

  async _onChange(e) {
    if (e.target.id !== "pick" || !this._sel) return;
    const line = this._lines.find((l) => l.uid === e.target.value) || null;
    this._sel.line = line;
    this._sel.qty = line ? line.qty : 1;
    this._sel.suggested = line ? await this._lineLocation(line)
      : (this._sel.product ? ((await this._match(this._sel.product.name)) || {}).location : null);
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
    h.innerHTML = `
      <div class="title">${esc(this._config.title)}
        <div class="sub">${this._loaded ? (n ? `${n} line${n === 1 ? "" : "s"} to put away` : "Nothing left on the list") : "Loading…"}</div>
      </div>
      <button class="primary" data-act="scan"><ha-icon icon="${this._cam ? "mdi:close" : "mdi:barcode-scan"}"></ha-icon>
        ${this._cam ? "Stop" : "Scan"}</button>
      <button data-act="type" title="Type a barcode"><ha-icon icon="mdi:keyboard-outline"></ha-icon></button>`;
  }

  _renderSel() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("sel");
    if (!box) return;
    const sel = this._sel;
    box.hidden = !sel;
    if (!sel) { box.innerHTML = ""; return; }
    const p = sel.product;
    const line = sel.line;
    const title = line ? line.name : (p ? p.name : `Barcode ${sel.barcode}`);
    const subParts = [];
    if (p && line && p.name !== line.name) subParts.push(`Scanned: ${p.name}`);
    if (!line) subParts.push(this._lines.length ? "Not matched to a line" : "Not on the list");
    if (line && line.info.ordered) subParts.push(`Substitute for ${line.info.ordered}`);
    const options = [`<option value="">— not on the list —</option>`]
      .concat(this._lines.map((l) => `<option value="${esc(l.uid)}"${line && l.uid === line.uid ? " selected" : ""}>${esc(l.summary)}</option>`))
      .join("");
    const max = line ? line.qty : 99;
    box.innerHTML = `
      <div class="prod">
        ${p && p.photo ? `<img src="${esc(p.photo)}" alt="">` : ""}
        <div>
          <div class="pname">${esc(title)}</div>
          <div class="pline">${esc(subParts.join(" · "))}</div>
        </div>
      </div>
      ${sel.barcode && this._lines.length ? `<select id="pick" aria-label="Order line">${options}</select>` : ""}
      ${max > 1 || sel.qty > 1 ? `
        <div class="qty">
          <button data-act="minus" ${sel.qty <= 1 ? "disabled" : ""}>−</button>
          <span>${sel.qty}${line ? ` of ${line.qty}` : ""}</span>
          <button data-act="plus" ${sel.qty >= max ? "disabled" : ""}>+</button>
        </div>` : ""}
      <div class="locs">
        ${LOCATIONS.map((l) => `
          <button class="loc${sel.suggested === l.key ? " sug" : ""}" data-act="loc" data-loc="${l.key}" ${this._busy || (!line && !p) ? "disabled" : ""}>
            <ha-icon icon="${l.icon}"></ha-icon>${l.label}<small>${sel.suggested === l.key ? "usual place" : ""}</small>
          </button>`).join("")}
      </div>
      <button class="cancel" data-act="cancel">Cancel</button>`;
  }

  _renderList() {
    const box = this.shadowRoot && this.shadowRoot.getElementById("list");
    if (!box) return;
    this._renderHead();
    if (!this._loaded) { box.innerHTML = ""; return; }
    if (!this._lines.length) {
      box.innerHTML = `<div class="empty">Scan anything to add it to Fridge Assistant.</div>`;
      return;
    }
    const selUid = this._sel && this._sel.line && this._sel.line.uid;
    box.innerHTML = `<div class="list">${this._lines.map((l) => {
      const fixed = l.info.location && l.info.location !== "auto" ? l.info.location : null;
      const m = this._cachedMatch(l.name);
      const where = fixed || (m && m.location) || "";
      return `<button class="row${l.uid === selUid ? " on" : ""}" data-act="line" data-uid="${esc(l.uid)}">
        <span class="n">${esc(l.summary)}</span>
        <span class="chip">${esc(LOCATION_LABEL[where] || "")}</span>
      </button>`;
    }).join("")}</div>`;
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
