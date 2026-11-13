// Beyond in Owlbear — the real D&D Beyond character sheet in the Owlbear side panel, plus a small drawer
// with the shared roll log, party and battle tracker. D&D Beyond handles the sheets. They are served by
// Beyond Relay on the DM's computer, which fetches them with the DM's login: nobody signs in (browsers
// like Chrome and Edge never pass a D&D Beyond login to a page embedded in Owlbear). Rolls arrive through
// the relay too (see bg.js); initiative rolls fill the battle tracker.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, KEYS, HIDDEN_LOG, LOG_MAX, uid, sortEntries, advanceTurn, emptyBattle, describe, cleanRelayCode, relayUrl, relaySheetUrl } from "./shared.js?v=0.9.1";

const VERSION = "0.9.1";
const RELAY_MIN = "0.10.0"; // monster search, stat blocks and monster rolls need this Beyond Relay version
const SIZES = { compact: [440, 620], tall: [440, 900], wide: [620, 900] };
const DDB = "https://www.dndbeyond.com";
const LOCAL = !OBR.isAvailable;   // opened outside Owlbear: local test mode with a fake room
const RELAY_TEST = LOCAL ? new URLSearchParams(location.search).get("relay") || "" : ""; // local test: ?relay=ws://localhost:8799/?k=test

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let ME = { id: "", name: "", role: "PLAYER" }, META = {};
let PREF = { zoom: 0.8, size: "tall", char: "", drawer: "" }; // char = the character this player opened last (marked in the list)
try { Object.assign(PREF, JSON.parse(localStorage.getItem("bio-pref") || "{}")); } catch {}
if (!PREF.char && PREF.last) PREF.char = (String(PREF.last).match(/\/characters\/(\d+)/) || [])[1] || ""; // from before 0.9
delete PREF.last;
const savePref = () => { try { localStorage.setItem("bio-pref", JSON.stringify(PREF)); } catch {} };
const UI = {
  confirmClear: 0,
  add: { name: "", hp: "", ac: "", bonus: "", count: "" }, // Battle add row (kept across redraws)
  search: { q: "", items: [], busy: false, err: "" },      // monster search results for the add row
  pick: null,                                              // { id, name } of the picked monster
  sheet: null,                                             // { entryId } of the open monster sheet
  last: "",                                                // last monster roll, shown in the sheet
};
const MON = {}; // monster id -> stat block from the relay (this panel session)

// Room storage: Owlbear room metadata, or localStorage when testing outside Owlbear.
const MOCK = "bio-mock-meta";
const room = LOCAL ? {
  get: async () => { try { return JSON.parse(localStorage.getItem(MOCK) || "{}"); } catch { return {}; } },
  set: async (patch) => { const m = await room.get(); Object.assign(m, patch); localStorage.setItem(MOCK, JSON.stringify(m)); META = m; renderAll(); },
  on: (cb) => window.addEventListener("storage", (e) => { if (e.key === MOCK) room.get().then(cb); }),
  send: async () => {},
} : {
  get: async () => (await OBR.room.getMetadata()) || {},
  set: (patch) => OBR.room.setMetadata(patch),
  on: (cb) => OBR.room.onMetadataChange(cb),
  send: (ch, data) => OBR.broadcast.sendMessage(ch, data, { destination: "ALL" }),
};

const config = () => META[KEYS.cfg] || { campaignUrl: "" };
const battle = () => META[KEYS.battle] || emptyBattle();
const parseCampaign = (t) => { const m = String(t || "").match(/campaigns\/(\d{3,})/); return m ? `${DDB}/campaigns/${m[1]}` : ""; };

// ------------------------------------------------------------------ direct line to Beyond Relay (DM panel only)
// Requests (monster search, stat blocks, monster rolls) go straight from this panel to the relay; the
// background page keeps handling the roll feed. Opened on first use.
let rws = null, rwsUrl = "", ropen = null, rreq = 0, relayVer = "";
const rwait = new Map();
const verOk = (v) => { const a = String(v || "0").split(".").map(Number), b = RELAY_MIN.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; } return true; };
function relaySock() {
  const url = (LOCAL && new URLSearchParams(location.search).get("relay")) || relayUrl(config().relayCode);
  if (!url) return Promise.reject(new Error("No relay code set: start Beyond Relay and paste its code in ⚙"));
  if (rws && rwsUrl === url && rws.readyState === 1) return Promise.resolve(rws);
  if (ropen && rwsUrl === url) return ropen;
  if (rws) { rws.onclose = null; try { rws.close(); } catch {} rws = null; }
  rwsUrl = url; relayVer = "";
  const s = new WebSocket(url); rws = s;
  ropen = new Promise((res, rej) => {
    const t = setTimeout(() => { rej(new Error("Beyond Relay doesn't answer. Is it running, with this code?")); try { s.close(); } catch {} }, 12000);
    s.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "hello") { relayVer = m.version || "0"; clearTimeout(t); res(s); return; }
      if (m.type === "reply" && rwait.has(m.reqId)) { const w = rwait.get(m.reqId); rwait.delete(m.reqId); w.resolve(m); }
    };
    s.onerror = () => {};
    s.onclose = (ev) => {
      clearTimeout(t);
      if (rws === s) { rws = null; ropen = null; }
      rej(new Error(ev.code === 4001 ? "Wrong relay code: copy the current one from the Beyond Relay window" : "Can't reach Beyond Relay. Is it running?"));
      for (const [, w] of rwait) w.reject(new Error("The connection to Beyond Relay closed"));
      rwait.clear();
    };
  });
  ropen.then(() => { ropen = null; }, () => { ropen = null; });
  return ropen;
}
async function relayCall(type, data, ms = 20000) {
  const s = await relaySock();
  if (!verOk(relayVer)) throw new Error(`Monsters need Beyond Relay ${RELAY_MIN} or newer (running: ${relayVer}). Download the new version.`);
  const reqId = ++rreq;
  const m = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { rwait.delete(reqId); reject(new Error("Beyond Relay took too long to answer")); }, ms);
    rwait.set(reqId, { resolve: (x) => { clearTimeout(t); resolve(x); }, reject: (e) => { clearTimeout(t); reject(e); } });
    s.send(JSON.stringify({ type, reqId, ...data }));
  });
  if (!m.ok) throw new Error(m.error || "Beyond Relay couldn't do that");
  return m;
}

// ------------------------------------------------------------------ sheet frame
// The frame shows the picked character's sheet, served by Beyond Relay. It is cross-origin, so the
// browser never tells us what happens inside: we only know the address we opened ourselves.
let shown = "", wasLive = false;
let openId = ""; // the character picked in this session: the panel always starts at the character list
const relayLive = () => !!RELAY_TEST || relayState().cls === "live";
function sheetUrl(id) {
  if (RELAY_TEST) { try { const u = new URL(RELAY_TEST); return `http://${u.host}/characters/${id}?k=${u.searchParams.get("k")}`; } catch { return ""; } }
  return relaySheetUrl(config().relayCode, id);
}
// Called on every room change: loads the sheet when the relay (re)appears or its code changes, and
// covers the frame with a note while the relay is off. force = load again even if nothing changed.
function showSheet(force = false) {
  const live = relayLive(), ps = party(), id = openId;
  const known = !!id && (!ps.length || ps.some((p) => p.entityId === id));
  const url = live && known ? sheetUrl(id) : "";
  const off = $("off");
  if (url) {
    off.hidden = true;
    if (force || url !== shown || !wasLive) { shown = url; $("frame").src = url; }
  } else {
    const dm = ME.role === "GM";
    const html = !live
      ? `<b>No character sheets right now</b><div>${dm ? esc(relayState().text) : "They appear while the DM's Beyond Relay is running."}</div>${dm ? `<div>The relay code is set in the room settings (⚙).</div>` : ""}` +
        `<button data-act="tab">Open D&amp;D Beyond in a browser tab</button>`
      : `<b>Pick a character</b><div>${ps.length ? "Press ↻ and choose your character." : "Waiting for the campaign's character list from Beyond Relay..."}</div>`;
    if (off.__html !== html) { off.__html = html; off.innerHTML = html; }
    off.hidden = false;
    if (live && ps.length && $("picker").hidden) showPicker(true); // nothing picked yet (or that character left the campaign)
  }
  wasLive = live;
}
function hint(t) { $("hint").textContent = t; $("hint").hidden = !t; }

// Scale from outside: the frame is rendered larger, then shrunk with a transform. (Cropping the site
// header away was tried and dropped: D&D Beyond's dialogs are pinned to the frame top and got cut too.)
function layout() {
  const z = PREF.zoom;
  const f = $("frame");
  f.style.width = `${100 / z}%`;
  f.style.height = `${100 / z}%`;
  f.style.transform = `scale(${z})`;
  $("zoomLbl").textContent = `${Math.round(z * 100)}%`;
  $("sizeBtn").textContent = PREF.size === "compact" ? "⤓" : PREF.size === "tall" ? "⤢" : "⤡";
}
async function applySize() {
  const [w, h] = SIZES[PREF.size] || SIZES.tall;
  try { await OBR.action.setWidth(w); await OBR.action.setHeight(h); } catch {}
}
function renderBar() {
  $("campaignBtn").hidden = !config().campaignUrl;
  $("gmBtn").hidden = ME.role !== "GM";
}

// ------------------------------------------------------------------ room writes (always re-read first)
async function saveConfig(fn) {
  const m = await room.get();
  const cfg = JSON.parse(JSON.stringify(m[KEYS.cfg] || { campaignUrl: "" }));
  fn(cfg);
  META = { ...m, [KEYS.cfg]: cfg }; renderAll();
  await room.set({ [KEYS.cfg]: cfg });
}
// A panel never writes back its own possibly stale copy: it re-reads the room right before writing.
async function updateBattle(fn) {
  const m = await room.get();
  const b = JSON.parse(JSON.stringify(m[KEYS.battle] || emptyBattle()));
  fn(b);
  b.turn = b.entries.length ? Math.max(0, Math.min(b.entries.length - 1, b.turn || 0)) : 0;
  META = { ...m, [KEYS.battle]: b }; renderDrawer();
  await room.set({ [KEYS.battle]: b });
  return b;
}
const rollD20 = () => 1 + Math.floor(Math.random() * 20); // quick enemy initiative when adding rows
function closeSheet() { UI.sheet = null; renderSheet(); }
async function announceTurn(b) {
  const e = b.entries[b.turn]; if (!e) return;
  await room.send(`${NS}/turn`, { name: e.name, round: b.round || 1 }).catch(() => {});
}

// ------------------------------------------------------------------ drawer: roll log + battle
function keepFocus() {
  const el = document.activeElement;
  if (!el || !$("drawer").contains(el) || el.tagName !== "INPUT") return null;
  const sel = el.id ? `#${el.id}` : el.dataset.field ? `[data-field="${el.dataset.field}"]` : null;
  return sel ? { sel, value: el.value, s: el.selectionStart, e: el.selectionEnd } : null;
}
function restoreFocus(k) {
  if (!k) return;
  const el = $("drawer").querySelector(k.sel); if (!el) return;
  if (el.value !== k.value) { el.value = k.value; el.__pending = true; }
  try { el.setSelectionRange(k.s, k.e); } catch {}
  el.focus({ preventScroll: true });
}

function relayState() {
  const r = META[KEYS.relay];
  const fresh = r && Date.now() - (r.t || 0) < 3 * 60 * 1000;
  if (r && r.connected && fresh) return { cls: "live", text: "D&D Beyond rolls are live" };
  if (ME.role === "GM") return { cls: "off", text: r && r.note ? r.note : "Beyond Relay is not running on this computer" };
  return { cls: "off", text: "D&D Beyond rolls are not live (the DM's relay is off)" };
}

function hiddenLog() { if (ME.role !== "GM") return []; try { return JSON.parse(localStorage.getItem(HIDDEN_LOG) || "[]"); } catch { return []; } }
function renderLog() {
  const log = [...(META[KEYS.log] || []), ...hiddenLog()].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, LOG_MAX);
  if (!log.length) return `<div class="muted pad">No rolls yet. Roll in a D&D Beyond sheet of this campaign.</div>`;
  return log.map((e) => {
    const time = new Date(e.t || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const cls = e.nat20 ? " nat20" : e.nat1 ? " nat1" : "";
    const what = e.action && e.action.toLowerCase() !== (e.type || "").toLowerCase() ? `${esc(e.action)} <span class="muted">${esc(e.type)}</span>` : esc(e.action || e.type);
    return `<div class="le${cls}${e.hidden ? " hid" : ""}"><span class="who">${esc(e.who)}</span>${e.hidden ? `<span class="htag" title="Only you see this roll">hidden</span>` : ""} ${what}<span class="tot">${esc(e.total)}</span>${e.nat20 ? " <b>nat 20</b>" : e.nat1 ? " <b>nat 1</b>" : ""}<div class="det">${esc(e.text)}<span>${time}</span></div></div>`;
  }).join("");
}

// Party hit points come from D&D Beyond through the relay (read-only; players change HP in their own sheet).
const party = () => (META[KEYS.party] || {}).chars || [];
const pcHp = (entityId) => party().find((p) => p.entityId === String(entityId));
function hpBadge(p) {
  if (!p) return "";
  const pct = p.max ? Math.max(0, Math.min(100, Math.round((100 * p.hp) / p.max))) : 0;
  const cls = p.dead ? "dead" : p.hp <= 0 ? "zero" : pct <= 33 ? "low" : pct <= 66 ? "mid" : "ok";
  const txt = p.dead ? "dead" : p.hp <= 0 ? (p.stable ? "0 · stable" : "0 · dying") : `${p.hp}/${p.max}`;
  return `<span class="php ${cls}" title="${esc(p.name)}: ${p.hp}/${p.max}${p.temp ? ` +${p.temp} temp` : ""}"><span class="hbar"><i style="width:${pct}%"></i></span>${txt}${p.temp ? `<span class="tmp">+${p.temp}</span>` : ""}</span>`;
}
// DM only: change a player character's HP; the relay writes it to D&D Beyond.
// Number box + labeled buttons, so nothing depends on a sign convention. Empty box = 1.
function pcControls(entityId) {
  if (ME.role !== "GM" || !pcHp(entityId)) return "";
  const id = esc(entityId);
  return `<span class="pctl"><button class="sm dmgb" data-act="pDmg" data-id="${id}" title="Damage by the amount (temporary HP absorbs it first)">−</button>` +
    `<input type="number" min="1" class="amt" data-field="amt:${id}" placeholder="1" title="Amount (empty = 1)">` +
    `<button class="sm heal" data-act="pHeal" data-id="${id}" title="Heal by the amount">+</button>` +
    `<button class="sm" data-act="pTemp" data-id="${id}" title="Set temporary HP to the amount">Temp</button></span>`;
}
function amountFor(entityId) {
  const el = $("drawer").querySelector(`[data-field="amt:${CSS.escape(String(entityId))}"]`);
  const n = el ? parseInt(el.value, 10) : NaN;
  if (el) el.value = "";
  return isNaN(n) || n < 1 ? 1 : Math.min(n, 999);
}
let hpReq = 0;
async function sendHp(entityId, delta, temp, src) {
  const who = (pcHp(entityId) || {}).name || entityId;
  const what = temp != null ? `temp HP ${temp}` : delta > 0 ? `heal ${delta}` : `${-delta} damage`;
  if (LOCAL) { toast(`(local test) ${who}: ${what} [${src}]`); return; }
  toast(`${who}: ${what}...`);
  await OBR.broadcast.sendMessage(`${NS}/hp`, { reqId: ++hpReq, entityId, delta: delta || 0, temp: temp ?? null, src: `${src} on ${who}` }, { destination: "LOCAL" });
}
// Floating note: never pushes the layout, so buttons can't move under the pointer.
let toastT = null;
function toast(text, ms = 3000) {
  const el = $("toast"); el.textContent = text; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, ms);
}
function deathSaves(p) {
  if (!p || p.hp > 0 || !p.ds) return "";
  const dot = (n, cls) => [0, 1, 2].map((i) => `<i class="${i < n ? cls : ""}"></i>`).join("");
  return `<span class="dsv" title="Death saves: ${p.ds[0]} successes, ${p.ds[1]} failures">${dot(p.ds[0], "ok")}<b>/</b>${dot(p.ds[1], "bad")}</span>`;
}
const condChips = (p) => (p && p.conditions && p.conditions.length) ? `<span class="conds">${p.conditions.map((c) => `<span class="cond">${esc(c)}</span>`).join("")}</span>` : "";
function renderPartyTab() {
  const ps = party();
  if (!ps.length) return `<div class="muted pad">The party appears here while the DM's Beyond Relay is running.</div>`;
  return ps.map((p) => {
    const stats = [
      p.ac != null ? `<b>AC ${esc(p.ac)}</b>` : "",
      p.pp != null ? `<span title="Passive Perception / Insight / Investigation">Passive ${esc(p.pp)} · ${esc(p.pins)} · ${esc(p.pinv)}</span>` : "",
      p.dc && p.dc.length ? `<span title="Spell save DC">DC ${p.dc.map(esc).join("/")}</span>` : "",
      p.speed ? `<span>${esc(p.speed)} ft</span>` : "",
      ...(p.senses || []).map((x) => `<span>${esc(x)}</span>`),
      p.insp ? `<span class="insp" title="Inspiration">★ Inspiration</span>` : "",
    ].filter(Boolean).join("<i class='sep'>·</i>");
    return `<div class="pcard"><div class="pline"><span class="pn" data-act="openChar" data-id="${esc(p.entityId)}" title="Open this sheet">${esc(p.name)}</span>` +
      `<span class="muted pcls">${esc(p.cls || "")}</span>${hpBadge(p)}${pcControls(p.entityId)}</div>` +
      `<div class="pstats">${stats}${condChips(p)}${deathSaves(p)}</div></div>`;
  }).join("");
}

function renderBattle() {
  const b = battle(), isGM = ME.role === "GM";
  const rows = b.entries.map((e, i) => {
    const cur = i === b.turn, down = e.kind === "npc" && e.hp <= 0;
    const init = isGM ? `<input type="number" data-field="binit:${e.id}" value="${e.init ?? ""}" title="Initiative">` : `<b>${e.init ?? "–"}</b>`;
    let hp = "";
    const pc = e.kind === "pc" ? pcHp(e.entityId) : null;
    const ac = e.kind === "pc" ? (pc && pc.ac != null ? `<span class="bac" title="Armor class">${esc(pc.ac)}</span>` : `<span class="bac"></span>`)
      : isGM ? `<input type="number" class="bac" data-field="bac:${e.id}" value="${e.ac ?? ""}" placeholder="AC" title="Armor class (only you see it)">` : `<span class="bac"></span>`;
    if (e.kind === "npc" && isGM) {
      hp = hpBadge({ name: e.name, hp: e.hp || 0, max: e.maxHp || 0, temp: 0 }) +
        `<span class="pctl"><button class="sm dmgb" data-act="eDmg" data-id="${e.id}" title="Damage by the amount">−</button>` +
        `<input type="number" min="1" class="amt" data-field="amt:${e.id}" placeholder="1" title="Amount (empty = 1)">` +
        `<button class="sm heal" data-act="eHeal" data-id="${e.id}" title="Heal by the amount">+</button></span>`;
    } else if (down) hp = `<span class="muted">down</span>`;
    else if (e.kind === "pc") hp = condChips(pc) + deathSaves(pc) + hpBadge(pc);
    return `<div class="brow${cur ? " cur" : ""}${down ? " down" : ""}${e.kind === "pc" ? " pc" : ""}"${isGM ? ` data-act="bSetTurn" data-i="${i}"` : ""}>
      <span class="mk">${cur ? "▶" : ""}</span><span class="bi">${init}</span>${isGM && e.monsterId ? `<span class="bn mlink" data-act="mOpen" data-id="${e.id}" title="Open the stat block and roll for ${esc(e.name)}">${esc(e.name)}</span>` : `<span class="bn">${esc(e.name)}</span>`}${ac}${hp}
      ${isGM ? `<button class="ic ghost" data-act="bRemove" data-id="${e.id}" title="Remove">×</button>` : ""}</div>`;
  }).join("");
  const empty = !b.entries.length ? `<div class="muted pad">Nobody in the fight yet. Players: roll Initiative in your D&D Beyond sheet.${isGM ? " Add enemies below." : ""}</div>` : "";
  const now = b.entries[b.turn];
  const ctrl = isGM ? `<div class="bctl">
      <button class="primary" data-act="bNext" ${b.entries.length ? "" : "disabled"}>Next ▶</button>
      <button data-act="bPrev" ${b.entries.length ? "" : "disabled"}>◀</button>
      <span class="tag">Round ${b.round || 1}</span><span class="spacer"></span>
      <button data-act="bSort" ${b.entries.length ? "" : "disabled"}>Sort</button>
      <button data-act="bReroll" ${b.entries.some((e) => e.kind === "npc") ? "" : "disabled"} title="Re-roll initiative for all enemies">Re-roll enemies</button>
      <button class="ghost" data-act="bClear" ${b.entries.length ? "" : "disabled"}>${UI.confirmClear > Date.now() ? "Really clear?" : "Clear"}</button></div>
    <div class="badd">
      <input type="text" id="bName" placeholder="Enemy name or monster search" autocomplete="off" value="${esc(UI.add.name)}">
      <input type="number" id="bHpN" placeholder="HP" min="1" value="${esc(UI.add.hp)}">
      <input type="number" id="bAc" placeholder="AC" min="1" value="${esc(UI.add.ac)}">
      <input type="number" id="bBonus" placeholder="init +" value="${esc(UI.add.bonus)}">
      <input type="number" id="bCount" placeholder="×1" min="1" max="30" value="${esc(UI.add.count)}">
      <button data-act="bAdd">Add</button></div>${renderSearch()}`
    : `<div class="muted pad">Round ${b.round || 1}${now ? ` · ${esc(now.name)}'s turn` : ""}</div>`;
  return rows + empty + ctrl;
}

// Monster search results under the add row (D&D Beyond's monster list, through the relay).
function renderSearch() {
  const s = UI.search;
  if (UI.pick && UI.pick.name === UI.add.name) return `<div class="muted msr-note">${UI.pick.id ? "From D&amp;D Beyond. After adding, click the name in the list to roll for it." : "Not on your D&amp;D Beyond account: type HP and AC yourself."}</div>`;
  if (!s.q || s.q !== UI.add.name.trim()) return "";
  if (s.err) return `<div class="muted msr-note">${esc(s.err)}</div>`;
  if (s.busy && !s.items.length) return `<div class="muted msr-note">Searching D&amp;D Beyond...</div>`;
  if (!s.items.length) return `<div class="muted msr-note">No monster called “${esc(s.q)}” on D&amp;D Beyond. Add it by hand.</div>`;
  return `<div class="msr">${s.items.map((x, i) => `<button class="mres${x.locked ? " locked" : ""}" data-act="mPick" data-i="${i}" title="${x.locked ? "Not available on your D&D Beyond account: only the name is filled in" : "Fill in HP, AC and initiative bonus"}">` +
    `<span class="mn">${esc(x.name)}</span><span class="muted">${x.cr ? `CR ${esc(x.cr)}` : ""}${x.legacy ? " · Legacy" : ""}</span>` +
    `<span class="mv">${x.locked ? "🔒" : `HP ${x.hp} · AC ${x.ac}`}</span></button>`).join("")}</div>`;
}
let searchT = null;
function onSearchInput() {
  clearTimeout(searchT);
  const q = UI.add.name.trim();
  if (UI.pick && UI.pick.name !== UI.add.name) UI.pick = null;
  if (q.length < 2 || ME.role !== "GM") { UI.search = { q: "", items: [], busy: false, err: "" }; renderDrawer(); return; }
  searchT = setTimeout(async () => {
    UI.search = { q, items: UI.search.q === q ? UI.search.items : [], busy: true, err: "" }; renderDrawer();
    try {
      const r = await relayCall("monster-search", { q });
      if (UI.add.name.trim() === q) { UI.search = { q, items: r.items || [], busy: false, err: "" }; renderDrawer(); }
    } catch (e) {
      if (UI.add.name.trim() === q) { UI.search = { q, items: [], busy: false, err: `Monster search: ${e.message}` }; renderDrawer(); }
    }
  }, 350);
}

// ------------------------------------------------------------------ monster sheet (DM): stat block with roll buttons
const sgn = (n) => (n >= 0 ? `+${n}` : `−${-n}`);
const d20 = (n) => `1d20${n >= 0 ? "+" : "-"}${Math.abs(n)}`;
const rollBtn = (label, dice, type, action, title = "", cls = "") =>
  `<button class="mroll${cls}" data-act="mRoll" data-dice="${esc(dice)}" data-type="${esc(type)}" data-action="${esc(action)}" title="${esc(title || `${action}: ${dice}`)}">${label}</button>`;
function renderSheet() {
  const el = $("msheet");
  const entry = UI.sheet && battle().entries.find((e) => e.id === UI.sheet.entryId);
  if (!entry || ME.role !== "GM") { if (!el.hidden) { el.hidden = true; el.innerHTML = ""; el.__html = ""; } UI.sheet = null; return; }
  const m = MON[entry.monsterId];
  let html = `<div class="mhead"><span class="mt">${esc(entry.name)}</span>${m ? `<span class="muted">${esc(m.name)}${m.cr ? ` · CR ${esc(m.cr)}` : ""}${m.legacy ? " · Legacy" : ""}</span>` : ""}` +
    `<span class="spacer"></span>${m && m.url ? `<button class="ic ghost" data-act="mPage" title="D&amp;D Beyond page of this monster (new tab)">↗</button>` : ""}<button class="ic" data-act="mClose" title="Close">×</button></div>`;
  if (!m) html += `<div class="muted pad">${esc(UI.sheet.err || "Loading the stat block from D&D Beyond...")}</div>`;
  else {
    const vis = config().monsterHidden ? "Rolls are hidden: only you see them" : "Rolls are visible to everyone";
    html += `<div class="mstat"><b>AC ${esc(entry.ac ?? m.ac)}</b>${m.acNote ? ` <span class="muted">${esc(m.acNote)}</span>` : ""}<i class="sep">·</i>` +
      hpBadge({ name: entry.name, hp: entry.hp || 0, max: entry.maxHp || 0, temp: 0 }) + `<i class="sep">·</i>${esc(m.speed)}` +
      (m.senses ? `<i class="sep">·</i>${esc(m.senses)}` : "") + (m.pp != null ? `<i class="sep">·</i>Passive Perception ${esc(m.pp)}` : "") + `</div>` +
      `<div class="mline">${rollBtn(`Initiative ${sgn(m.init)}`, d20(m.init), "roll", "Initiative", "Roll initiative: sets this row's place in the battle")}` +
      `<span class="muted" title="Change in the room settings (gear icon)">${vis} (⚙)</span></div>` +
      `<div class="mabil">${m.abilities.map((a) => `<div class="mab"><b>${esc(a.key)}</b>` +
        rollBtn(`${a.score} (${sgn(a.mod)})`, d20(a.mod), "check", a.key.toLowerCase(), `${a.key} check`) +
        rollBtn(`save ${sgn(a.save)}`, d20(a.save), "save", a.key.toLowerCase(), `${a.key} saving throw${a.prof ? " (proficient)" : ""}`, a.prof ? " sv prof" : " sv") +
        `</div>`).join("")}</div>` +
      (m.skills.length ? `<div class="mskills">${m.skills.map((s) => rollBtn(`${esc(s.name)} ${sgn(s.bonus)}`, d20(s.bonus), "check", s.name, `${s.name} check`)).join("")}</div>` : "") +
      `<div class="mlast${UI.last ? "" : " empty"}">${esc(UI.last || "Click a value to roll it in D&D Beyond (3D dice in open sheets).")}</div>` +
      m.groups.map((g) => `<div class="mgrp"><div class="mgt">${esc(g.title)}</div>${g.items.map((it) => {
        const name = it.name ? `<b>${esc(it.recharge ? it.name.replace(/\s*\(Recharge[^)]*\)/i, "") : it.name)}.</b> ` : "";
        const range = it.recharge && it.recharge < 6 ? `${it.recharge}–6` : `${it.recharge}`;
        const rc = it.recharge ? rollBtn(`Recharge ${range}`, "1d6", "roll", `${it.name} recharge`, `Roll 1d6: recharges on ${range}`) + " " : "";
        const body = it.parts.map((p) => typeof p === "string" ? esc(p)
          : p.hit != null ? rollBtn(sgn(p.hit), d20(p.hit), "to hit", it.name || "Attack", `${it.name} attack roll`)
          : rollBtn(esc(p.dice), p.dice, p.dmg ? "damage" : "roll", it.name || "Roll", p.dmg ? `${it.name}: ${p.dice} ${p.dmg} damage` : `${it.name}: ${p.dice}`)).join("");
        return `<p>${name}${rc}${body}</p>`;
      }).join("")}</div>`).join("");
  }
  if (el.__html !== html) { el.__html = html; el.innerHTML = html; } // unchanged: leave the buttons alone
  el.hidden = false;
}
async function openSheet(entryId) {
  const entry = battle().entries.find((e) => e.id === entryId); if (!entry || !entry.monsterId) return;
  UI.sheet = { entryId }; UI.last = ""; showPicker(false); renderSheet();
  if (MON[entry.monsterId]) return;
  try { MON[entry.monsterId] = (await relayCall("monster-get", { id: entry.monsterId })).monster; }
  catch (e) { if (UI.sheet && UI.sheet.entryId === entryId) UI.sheet.err = `Couldn't load the stat block: ${e.message}`; }
  renderSheet();
}

let pressing = false, renderWaiting = false;
function renderDrawer() {
  if (pressing) { renderWaiting = true; return; }
  renderWaiting = false;
  const keep = keepFocus();
  const rs = relayState(), log = META[KEYS.log] || [], b = battle();
  const last = log[0] ? describe(log[0]) : "";
  const tab = (id, label) => `<button class="tab${PREF.drawer === id ? " on" : ""}" data-act="drawer" data-v="${id}">${label}</button>`;
  const body = PREF.drawer === "rolls" ? `<div class="dbody">${renderLog()}</div>`
    : PREF.drawer === "battle" ? `<div class="dbody">${renderBattle()}</div>`
    : PREF.drawer === "party" ? `<div class="dbody">${renderPartyTab()}</div>` : "";
  $("drawer").innerHTML = `<div class="dbar"><span class="dot ${rs.cls}" title="${esc(rs.text)}"></span>
      ${tab("rolls", "Rolls")}${tab("party", "Party")}${tab("battle", `Battle${b.entries.length ? ` · R${b.round || 1}` : ""}`)}
      <span class="last" title="${esc(last)}">${esc(last || rs.text)}</span></div>${body}`;
  restoreFocus(keep);
}
function renderPicker() {
  const el = $("picker"); if (el.hidden) return;
  const ps = party();
  const html = `<div class="ptitle">Open a character sheet</div>` +
    (ps.length ? ps.map((p) => `<button class="pick${p.entityId === PREF.char ? " on" : ""}" data-act="openChar" data-id="${esc(p.entityId)}"><span>${esc(p.name)}</span>${hpBadge(p)}</button>`).join("")
      : `<div class="muted">The campaign's characters appear here while the DM's Beyond Relay is running.</div>`) +
    `<div class="muted">The sheets are the real D&amp;D Beyond sheets, fetched by the DM's Beyond Relay: nobody needs to sign in. Your sheet reloads by itself when the DM changes your HP.</div>` +
    (openId && ps.some((p) => p.entityId === openId) ? `<div class="pother"><button class="ghost" data-act="pickerClose">Back to the sheet</button></div>` : "");
  if (el.__html !== html) { el.__html = html; el.innerHTML = html; } // unchanged: leave the buttons alone
}
function showPicker(on) { $("picker").hidden = !on; renderPicker(); }
function renderAll() { renderBar(); renderDrawer(); renderPicker(); renderSheet(); showSheet(); }

// ------------------------------------------------------------------ actions
async function onAction(act, el) {
  const ds = el.dataset;
  switch (act) {
    case "home": if (party().length) showPicker(true); else toast("The character list appears while the DM's Beyond Relay is running"); break;
    case "pickerClose": showPicker(false); break;
    case "campaign": if (config().campaignUrl) window.open(config().campaignUrl, "_blank"); break;
    case "zoomOut": PREF.zoom = Math.max(0.5, +(PREF.zoom - 0.05).toFixed(2)); savePref(); layout(); break;
    case "zoomIn": PREF.zoom = Math.min(1.2, +(PREF.zoom + 0.05).toFixed(2)); savePref(); layout(); break;
    case "size": PREF.size = PREF.size === "compact" ? "tall" : PREF.size === "tall" ? "wide" : "compact"; savePref(); layout(); await applySize(); break;
    case "openChar": openId = PREF.char = String(ds.id); savePref(); showPicker(false); closeSheet(); showSheet(true); break;
    case "tab": window.open(openId ? `${DDB}/characters/${openId}` : `${DDB}/characters`, "_blank"); break;
    case "gm": $("campaign").value = config().campaignUrl; $("relayCode").value = config().relayCode || ""; $("mHidden").checked = !!config().monsterHidden; $("gm").hidden = !$("gm").hidden; break;
    case "gmClose": $("gm").hidden = true; break;
    case "gmSave": {
      const raw = $("relayCode").value.trim(), code = cleanRelayCode(raw);
      if (raw && !code) { hint("That relay code doesn't look right. Copy it again from the Beyond Relay window (words/letters, e.g. brave-otter-lamp/Ab12Cd34)."); break; }
      await saveConfig((cfg) => { cfg.campaignUrl = parseCampaign($("campaign").value); cfg.relayCode = code; cfg.monsterHidden = $("mHidden").checked; });
      $("gm").hidden = true; hint(""); break;
    }
    case "drawer": PREF.drawer = PREF.drawer === ds.v ? "" : ds.v; savePref(); renderDrawer(); break;

    case "bNext": { const b = await updateBattle((b) => advanceTurn(b, 1)); await announceTurn(b); break; }
    case "bPrev": { const b = await updateBattle((b) => advanceTurn(b, -1)); await announceTurn(b); break; }
    case "bSetTurn": { const b = await updateBattle((b) => { b.turn = +ds.i; }); await announceTurn(b); break; }
    case "bSort": await updateBattle(sortEntries); break;
    case "bReroll": await updateBattle((b) => { for (const e of b.entries) if (e.kind === "npc") e.init = rollD20() + (e.bonus || 0); sortEntries(b); }); break;
    case "mPick": {
      const it = UI.search.items[+ds.i]; if (!it) break;
      UI.add = it.locked ? { ...UI.add, name: it.name } : { name: it.name, hp: String(it.hp ?? ""), ac: String(it.ac ?? ""), bonus: String(it.init ?? ""), count: UI.add.count };
      UI.pick = { id: it.locked ? null : it.id, name: it.name };
      UI.search = { q: "", items: [], busy: false, err: "" };
      renderDrawer(); break;
    }
    case "mOpen": await openSheet(ds.id); break;
    case "mClose": closeSheet(); break;
    case "mPage": { const e = UI.sheet && battle().entries.find((x) => x.id === UI.sheet.entryId); const m = e && MON[e.monsterId]; if (m && m.url) window.open(m.url, "_blank"); break; }
    case "mRoll": {
      const e = UI.sheet && battle().entries.find((x) => x.id === UI.sheet.entryId); if (!e) break;
      const hidden = !!config().monsterHidden;
      try {
        const r = await relayCall("monster-roll", { monsterId: e.monsterId, name: e.name, action: ds.action, rollType: ds.type, dice: ds.dice, hidden });
        const x = (r.roll.rolls || [])[0] || {};
        UI.last = `${e.name}: ${ds.action} ${ds.type === "roll" ? "" : ds.type} → ${x.total} (${x.text})${hidden ? " · hidden" : ""}`.replace(/\s+/g, " ");
        renderSheet();
      } catch (err) { toast(`Roll not sent: ${err.message}`, 6000); }
      break;
    }
    case "bRemove": await updateBattle((b) => { const i = b.entries.findIndex((e) => e.id === ds.id); if (i >= 0) { b.entries.splice(i, 1); if (i < b.turn) b.turn--; } }); break;
    case "pHeal": await sendHp(ds.id, amountFor(ds.id), null, "Heal button"); break;
    case "pDmg": await sendHp(ds.id, -amountFor(ds.id), null, "Dmg button"); break;
    case "pTemp": await sendHp(ds.id, 0, amountFor(ds.id), "Temp button"); break;
    case "eHeal": case "eDmg": {
      const n = amountFor(ds.id) * (act === "eHeal" ? 1 : -1);
      await updateBattle((b) => { const e = b.entries.find((x) => x.id === ds.id); if (e) e.hp = Math.max(0, Math.min(e.maxHp || 999, (e.hp || 0) + n)); });
      break;
    }
    case "bHp": await updateBattle((b) => { const e = b.entries.find((x) => x.id === ds.id); if (e) e.hp = Math.max(0, Math.min(e.maxHp || 999, (e.hp || 0) + +ds.v)); }); break;
    case "bClear":
      if (UI.confirmClear > Date.now()) { UI.confirmClear = 0; await updateBattle((b) => { b.entries = []; b.turn = 0; b.round = 1; }); }
      else { UI.confirmClear = Date.now() + 4000; renderDrawer(); setTimeout(renderDrawer, 4100); }
      break;
    case "bAdd": {
      const name = $("bName").value.trim() || "Enemy";
      const hp = Math.max(1, parseInt($("bHpN").value, 10) || 1);
      const bonus = parseInt($("bBonus").value, 10) || 0;
      const acIn = parseInt($("bAc").value, 10); const ac = isNaN(acIn) ? null : acIn;
      const count = Math.max(1, Math.min(30, parseInt($("bCount").value, 10) || 1));
      const monsterId = UI.pick && UI.pick.id && UI.pick.name === name ? UI.pick.id : null;
      if (document.activeElement) document.activeElement.blur();
      UI.add = { name: "", hp: "", ac: "", bonus: "", count: "" }; UI.pick = null; UI.search = { q: "", items: [], busy: false, err: "" };
      await updateBattle((b) => {
        const taken = b.entries.filter((e) => e.kind === "npc" && (e.name === name || e.name.startsWith(name + " "))).length;
        for (let i = 0; i < count; i++) {
          const n = count > 1 || taken ? `${name} ${taken + i + 1}` : name;
          b.entries.push({ id: uid(), kind: "npc", name: n, hp, maxHp: hp, ac, bonus, init: rollD20() + bonus, ...(monsterId ? { monsterId } : {}) });
        }
        sortEntries(b);
      });
      break;
    }
  }
}

async function onField(field, el) {
  const [kind, id] = field.split(":"); const v = parseInt(el.value, 10);
  if (kind === "amt") return; // read by the Heal/Dmg/Temp buttons
  if (kind === "bdmg") { el.value = ""; if (isNaN(v) || !v) return; }
  await updateBattle((b) => {
    const e = b.entries.find((x) => x.id === id); if (!e) return;
    if (kind === "bhp" && !isNaN(v)) e.hp = Math.max(0, v);
    if (kind === "binit") { e.init = isNaN(v) ? null : v; sortEntries(b); }
    if (kind === "bac") e.ac = isNaN(v) ? null : v;
    if (kind === "bdmg") e.hp = Math.max(0, (e.hp || 0) - v);
  });
}

// ------------------------------------------------------------------ start
async function start() {
  if (!LOCAL) {
    const [id, name, role] = await Promise.all([OBR.player.getId(), OBR.player.getName(), OBR.player.getRole()]);
    ME = { id, name, role };
    const applyTheme = (t) => document.documentElement.setAttribute("data-theme", t.mode === "LIGHT" ? "light" : "dark");
    applyTheme(await OBR.theme.getTheme()); OBR.theme.onChange(applyTheme);
    OBR.player.onChange((p) => { ME = { id: p.id, name: p.name, role: p.role }; renderAll(); });
  } else {
    const q = new URLSearchParams(location.search);
    ME = { id: "local", name: "local test", role: (q.get("role") || "GM").toUpperCase() };
  }
  META = await room.get();
  room.on((m) => { META = m || {}; try { renderAll(); } catch (e) { console.error(e); } });
  if (!LOCAL) OBR.broadcast.onMessage(`${NS}/hp-result`, (ev) => {
    const r = ev.data || {};
    if (r.ok && r.char) toast(`${r.char.name}: ${r.char.hp}/${r.char.max}${r.char.temp ? ` +${r.char.temp} temp` : ""} (saved in D&D Beyond)`);
    else toast(`HP not changed: ${r.error || "unknown error"}`, 6000);
  });
  // After a DM edit, a sheet showing that character reloads (D&D Beyond doesn't notice outside changes).
  let refreshT = null;
  if (!LOCAL) OBR.broadcast.onMessage(`${NS}/hp-edited`, (ev) => {
    if (ev.data && openId && String(ev.data.entityId) === openId) {
      clearTimeout(refreshT); refreshT = setTimeout(() => showSheet(true), 1500); // one reload after a burst of clicks
    }
  });
  renderAll(); layout(); await applySize();
  setInterval(() => { renderDrawer(); showSheet(); }, 60000); // relay staleness
  document.addEventListener("pointerdown", () => { pressing = true; }, true);
  const release = () => { if (!pressing) return; pressing = false; if (renderWaiting) setTimeout(renderDrawer, 60); }; // after the click is delivered
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", release);
  document.body.addEventListener("click", (ev) => {
    if (ev.target.closest("input")) return; // typing into a battle row must not change the turn
    const el = ev.target.closest("[data-act]"); if (!el) return;
    onAction(el.dataset.act, el).catch((e) => hint(e.message));
  });
  document.body.addEventListener("change", (ev) => { const el = ev.target; if (el.dataset && el.dataset.field) { el.__pending = false; onField(el.dataset.field, el).catch((e) => hint(e.message)); } });
  document.body.addEventListener("focusout", (ev) => { const t = ev.target; if (t && t.__pending && t.dataset && t.dataset.field) { t.__pending = false; onField(t.dataset.field, t).catch(() => {}); } });
  const ADD_FIELDS = { bName: "name", bHpN: "hp", bAc: "ac", bBonus: "bonus", bCount: "count" };
  document.body.addEventListener("input", (ev) => {
    const f = ADD_FIELDS[ev.target.id]; if (!f) return;
    UI.add[f] = ev.target.value;
    if (f === "name") onSearchInput();
  });
  // Hidden rolls are written by the background page into this browser's storage.
  window.addEventListener("storage", (ev) => { if (ev.key === HIDDEN_LOG) renderDrawer(); });
  document.body.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ev.target.id === "bName" && UI.search.q) { UI.search = { q: "", items: [], busy: false, err: "" }; renderDrawer(); return; }
    if (ev.key !== "Enter") return;
    if (["bName", "bHpN", "bAc", "bBonus", "bCount"].includes(ev.target.id)) { ev.preventDefault(); onAction("bAdd", ev.target).catch((e) => hint(e.message)); }
    else if (ev.target.dataset && ev.target.dataset.field) { ev.preventDefault(); ev.target.blur(); }
  });
  document.title = `Beyond in Owlbear v${VERSION}`;
}
if (LOCAL) start(); else OBR.onReady(start);
