// Beyond in Owlbear — popover: the room's roster of D&D Beyond characters.
// Sheets themselves open in an Owlbear modal (sheet.html) that frames dndbeyond.com.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";

const VERSION = "0.1.0";
const NS = "com.pavi.beyond-in-owlbear";
const CFG_KEY = `${NS}/config`;
const BASE = "https://pavidiran.github.io/beyond-in-owlbear";
const MODAL_ID = `${NS}/sheet`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const app = document.getElementById("app");
let ME = { id: "", name: "", role: "PLAYER" }, META = {}, UI = { err: "" };

const config = () => META[CFG_KEY] || { chars: [] };
// Accepts a full D&D Beyond link or a bare numeric id.
function parseDdbId(text) {
  const m = String(text || "").match(/characters\/(\d{4,})/) || String(text || "").trim().match(/^(\d{4,})$/);
  return m ? m[1] : null;
}
async function saveConfig(fn) {
  const m = (await OBR.room.getMetadata()) || {};
  const cfg = JSON.parse(JSON.stringify(m[CFG_KEY] || { chars: [] }));
  fn(cfg);
  META[CFG_KEY] = cfg; render();
  await OBR.room.setMetadata({ [CFG_KEY]: cfg });
}

function openSheet(ch) {
  const url = `${BASE}/sheet.html?ddb=${encodeURIComponent(ch.ddbId)}&name=${encodeURIComponent(ch.name)}&v=${VERSION}`;
  return OBR.modal.open({ id: MODAL_ID, url, width: 1280, height: 900 });
}

function render() {
  const isGM = ME.role === "GM";
  const chars = config().chars;
  const rows = chars.map((ch) => `<div class="row"><div class="nm">${esc(ch.name)}<small>dndbeyond.com/characters/${esc(ch.ddbId)}</small></div>
      <button class="sm primary" data-act="open" data-id="${esc(ch.id)}">Open sheet</button>
      ${isGM ? `<button class="sm ghost" data-act="remove" data-id="${esc(ch.id)}" title="Remove from this room">×</button>` : ""}</div>`).join("");
  const empty = !chars.length ? `<div class="muted">${isGM ? "No characters yet. Paste a D&D Beyond character link below." : "The DM has not added any characters yet."}</div>` : "";
  const add = isGM ? `<h2>Add a character</h2><div class="card add">
      <input type="text" id="link" placeholder="https://www.dndbeyond.com/characters/123456789">
      <div class="two"><input type="text" id="nm" placeholder="Name shown in the list"><button class="primary" data-act="add">Add</button></div>
      <div class="muted">The sheet must be set to <b>Public</b> in D&D Beyond (character → Edit → Home → Character Privacy), otherwise it shows "Access denied". Players sign in inside the sheet window to edit their own character.</div>
    </div>` : "";
  app.innerHTML = `<h1>D&D Beyond sheets</h1>
    ${UI.err ? `<div class="notice warn">${esc(UI.err)}</div>` : ""}
    <div class="card">${rows}${empty}</div>
    ${add}
    <div class="foot">Beyond in Owlbear v${VERSION} · ${esc(ME.name)} (${ME.role})</div>`;
}

async function onAction(act, el) {
  const id = el.dataset.id;
  if (act === "open") { const ch = config().chars.find((c) => c.id === id); if (ch) await openSheet(ch); }
  if (act === "remove") await saveConfig((cfg) => { cfg.chars = cfg.chars.filter((c) => c.id !== id); });
  if (act === "add") {
    const link = document.getElementById("link").value, name = document.getElementById("nm").value.trim();
    const ddbId = parseDdbId(link);
    UI.err = !ddbId ? "That does not look like a D&D Beyond character link (…/characters/123456789)." : !name ? "Give the character a name for the list." : "";
    if (UI.err) { render(); return; }
    await saveConfig((cfg) => { cfg.chars.push({ id: Math.random().toString(36).slice(2, 10), ddbId, name: name.slice(0, 40) }); });
  }
}

OBR.onReady(async () => {
  const [id, name, role] = await Promise.all([OBR.player.getId(), OBR.player.getName(), OBR.player.getRole()]);
  ME = { id, name, role };
  META = (await OBR.room.getMetadata()) || {};
  const applyTheme = (t) => document.documentElement.setAttribute("data-theme", t.mode === "LIGHT" ? "light" : "dark");
  applyTheme(await OBR.theme.getTheme()); OBR.theme.onChange(applyTheme);
  OBR.room.onMetadataChange((m) => { META = m || {}; render(); });
  OBR.player.onChange((p) => { ME = { id: p.id, name: p.name, role: p.role }; render(); });
  render();
  app.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    onAction(el.dataset.act, el).catch((e) => { UI.err = e.message; render(); });
  });
  app.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ["link", "nm"].includes(ev.target.id)) { ev.preventDefault(); app.querySelector('[data-act="add"]').click(); } });
});
