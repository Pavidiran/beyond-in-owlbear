// Beyond in Owlbear — the real D&D Beyond page in the Owlbear side panel, plus a small drawer with
// the shared roll log and battle tracker. D&D Beyond handles the sheets; the rolls arrive through
// Beyond Relay on the DM's computer (see bg.js), initiative rolls fill the battle tracker.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, KEYS, uid, sortEntries, advanceTurn, emptyBattle, describe, cleanRelayCode } from "./shared.js?v=0.7.1";

const VERSION = "0.7.1";
const SIZES = { compact: [440, 620], tall: [440, 900], wide: [620, 900] };
const DDB = "https://www.dndbeyond.com";
const HOME = `${DDB}/characters`; // "My characters": each player picks their own sheet there
const LOCAL = !OBR.isAvailable;   // opened outside Owlbear: local test mode with a fake room

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let ME = { id: "", name: "", role: "PLAYER" }, META = {};
let PREF = { zoom: 0.8, size: "tall", last: "", drawer: "" };
try { Object.assign(PREF, JSON.parse(localStorage.getItem("bio-pref") || "{}")); } catch {}
const savePref = () => { try { localStorage.setItem("bio-pref", JSON.stringify(PREF)); } catch {} };
const UI = { confirmClear: 0 };

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

// ------------------------------------------------------------------ sheet frame
// The frame is cross-origin, so the browser never tells us its address: we only know the page we
// opened ourselves.
let current = "";
// The sheet the panel opened (from the picker). After a DM edit it is reloaded even if the player
// clicked elsewhere inside D&D Beyond meanwhile: that brings them back to their sheet with fresh values.
const sheetId = () => (current.match(/\/characters\/(\d+)/) || [])[1] || "";
function go(url) {
  current = url; PREF.last = url; savePref();
  $("frame").src = url;
  hint(""); cookieWarned = false; cookieCheck(); // keep the cookie warning if it still applies
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

function signIn() {
  // dndbeyond.com/sign-in refuses to load inside a frame, so the login happens in a pop-up window.
  const ret = current.startsWith(DDB) ? current.slice(DDB.length) : "/characters";
  const w = window.open(`${DDB}/sign-in?returnUrl=` + encodeURIComponent(ret), "ddb-signin", "width=560,height=760");
  if (!w) { hint("Pop-ups are blocked. Allow them for this site, or sign in via ↗ and come back."); return; }
  hint("Sign in in the pop-up, then come back here. The panel reloads by itself (or press ↻).");
  let done = false, away = false;
  const finish = () => {
    if (done) return; done = true; clearInterval(t);
    window.removeEventListener("focus", onBack); document.removeEventListener("visibilitychange", onVis);
    for (const ev of ["pointerdown", "mousemove", "keydown"]) document.removeEventListener(ev, onBack, true);
    go(current);
  };
  const onBack = () => setTimeout(finish, 300);
  const onVis = () => { if (document.visibilityState === "visible") onBack(); };
  const t = setInterval(() => {
    if (w.closed) return finish();
    if (!document.hasFocus()) away = true; else if (away) finish();
  }, 700);
  setTimeout(() => {
    window.addEventListener("focus", onBack); document.addEventListener("visibilitychange", onVis);
    for (const ev of ["pointerdown", "mousemove", "keydown"]) document.addEventListener(ev, onBack, true);
  }, 1500);
}

// Firefox and Safari give a framed site its own empty cookie jar, so the framed sheet stays logged
// out until the player allows cross-site cookies for Owlbear once. hasStorageAccess() tells us
// whether that is currently the case, so the warning shows only while it is needed.
let cookieWarned = false;
async function cookieCheck() {
  let ok = true;
  try { if (window.top !== window && document.hasStorageAccess) ok = await document.hasStorageAccess(); } catch {}
  if (ok) { if (cookieWarned) { cookieWarned = false; hint(""); } return; }
  const ua = navigator.userAgent;
  const msg = /Firefox\//.test(ua)
    ? "Firefox blocks cross-site cookies here, so the sheet stays logged out. One-time fix: click the shield icon left of the address bar and turn off Enhanced Tracking Protection for owlbear.rodeo."
    : /Safari\//.test(ua) && !/Chrome\//.test(ua)
      ? "Safari blocks cross-site cookies here, so the sheet stays logged out. One-time fix: Settings → Privacy → turn off \"Prevent cross-site tracking\"."
      : "This browser blocks third-party cookies here, so the sheet stays logged out. Allow them for owlbear.rodeo (Chrome: the eye icon at the right of the address bar), then reload.";
  cookieWarned = true; hint(msg);
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
const d20 = () => 1 + Math.floor(Math.random() * 20);
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

function renderLog() {
  const log = META[KEYS.log] || [];
  if (!log.length) return `<div class="muted pad">No rolls yet. Roll in a D&D Beyond sheet of this campaign.</div>`;
  return log.map((e) => {
    const time = new Date(e.t || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const cls = e.nat20 ? " nat20" : e.nat1 ? " nat1" : "";
    const what = e.action && e.action.toLowerCase() !== (e.type || "").toLowerCase() ? `${esc(e.action)} <span class="muted">${esc(e.type)}</span>` : esc(e.action || e.type);
    return `<div class="le${cls}"><span class="who">${esc(e.who)}</span> ${what}<span class="tot">${esc(e.total)}</span>${e.nat20 ? " <b>nat 20</b>" : e.nat1 ? " <b>nat 1</b>" : ""}<div class="det">${esc(e.text)}<span>${time}</span></div></div>`;
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
      <span class="mk">${cur ? "▶" : ""}</span><span class="bi">${init}</span><span class="bn">${esc(e.name)}</span>${ac}${hp}
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
      <input type="text" id="bName" placeholder="Enemy name">
      <input type="number" id="bHpN" placeholder="HP" min="1">
      <input type="number" id="bAc" placeholder="AC" min="1">
      <input type="number" id="bBonus" placeholder="init +">
      <input type="number" id="bCount" placeholder="×1" min="1" max="30">
      <button data-act="bAdd">Add</button></div>`
    : `<div class="muted pad">Round ${b.round || 1}${now ? ` · ${esc(now.name)}'s turn` : ""}</div>`;
  return rows + empty + ctrl;
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
  const camp = config().campaignUrl;
  el.innerHTML = `<div class="ptitle">Open a character sheet</div>` +
    (ps.length ? ps.map((p) => `<button class="pick" data-act="openChar" data-id="${esc(p.entityId)}"><span>${esc(p.name)}</span>${hpBadge(p)}</button>`).join("")
      : `<div class="muted">The campaign's characters appear here while the DM's Beyond Relay is running.</div>`) +
    `<div class="pother"><button class="ghost" data-act="ddbHome">My characters on D&amp;D Beyond</button>${camp ? `<button class="ghost" data-act="campaign">Campaign page</button>` : ""}</div>` +
    `<div class="muted">Sheets opened from this list reload by themselves when the DM changes their HP.</div>`;
}
function showPicker(on) { $("picker").hidden = !on; renderPicker(); }
function renderAll() { renderBar(); renderDrawer(); renderPicker(); }

// ------------------------------------------------------------------ actions
async function onAction(act, el) {
  const ds = el.dataset;
  switch (act) {
    case "home": if (party().length) showPicker(true); else go(HOME); break;
    case "ddbHome": showPicker(false); go(HOME); break;
    case "campaign": if (config().campaignUrl) { showPicker(false); go(config().campaignUrl); } break;
    case "login": signIn(); break;
    case "zoomOut": PREF.zoom = Math.max(0.5, +(PREF.zoom - 0.05).toFixed(2)); savePref(); layout(); break;
    case "zoomIn": PREF.zoom = Math.min(1.2, +(PREF.zoom + 0.05).toFixed(2)); savePref(); layout(); break;
    case "size": PREF.size = PREF.size === "compact" ? "tall" : PREF.size === "tall" ? "wide" : "compact"; savePref(); layout(); await applySize(); break;
    case "openChar": showPicker(false); go(`${DDB}/characters/${ds.id}`); break;
    case "tab": window.open(current, "_blank"); break;
    case "gm": $("campaign").value = config().campaignUrl; $("relayCode").value = config().relayCode || ""; $("gm").hidden = !$("gm").hidden; break;
    case "gmClose": $("gm").hidden = true; break;
    case "gmSave": {
      const raw = $("relayCode").value.trim(), code = cleanRelayCode(raw);
      if (raw && !code) { hint("That relay code doesn't look right. Copy it again from the Beyond Relay window (words/letters, e.g. brave-otter-lamp/Ab12Cd34)."); break; }
      await saveConfig((cfg) => { cfg.campaignUrl = parseCampaign($("campaign").value); cfg.relayCode = code; });
      $("gm").hidden = true; hint(""); break;
    }
    case "drawer": PREF.drawer = PREF.drawer === ds.v ? "" : ds.v; savePref(); renderDrawer(); break;

    case "bNext": { const b = await updateBattle((b) => advanceTurn(b, 1)); await announceTurn(b); break; }
    case "bPrev": { const b = await updateBattle((b) => advanceTurn(b, -1)); await announceTurn(b); break; }
    case "bSetTurn": { const b = await updateBattle((b) => { b.turn = +ds.i; }); await announceTurn(b); break; }
    case "bSort": await updateBattle(sortEntries); break;
    case "bReroll": await updateBattle((b) => { for (const e of b.entries) if (e.kind === "npc") e.init = d20() + (e.bonus || 0); sortEntries(b); }); break;
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
      if (document.activeElement) document.activeElement.blur();
      $("bName").value = ""; $("bHpN").value = ""; $("bCount").value = "";
      await updateBattle((b) => {
        const taken = b.entries.filter((e) => e.kind === "npc" && (e.name === name || e.name.startsWith(name + " "))).length;
        for (let i = 0; i < count; i++) {
          const n = count > 1 || taken ? `${name} ${taken + i + 1}` : name;
          b.entries.push({ id: uid(), kind: "npc", name: n, hp, maxHp: hp, ac, bonus, init: d20() + bonus });
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
    if (ev.data && sheetId() && String(ev.data.entityId) === sheetId()) {
      clearTimeout(refreshT); refreshT = setTimeout(() => go(current), 1500); // one reload after a burst of clicks
    }
  });
  renderAll(); layout(); await applySize();
  if (/\/characters\/\d+/.test(PREF.last || "")) go(PREF.last);
  else { go(HOME); if (party().length) showPicker(true); }
  await cookieCheck();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") cookieCheck(); });
  setInterval(renderDrawer, 60000); // relay staleness indicator
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
  document.body.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    if (["bName", "bHpN", "bAc", "bBonus", "bCount"].includes(ev.target.id)) { ev.preventDefault(); onAction("bAdd", ev.target).catch((e) => hint(e.message)); }
    else if (ev.target.dataset && ev.target.dataset.field) { ev.preventDefault(); ev.target.blur(); }
  });
  document.title = `Beyond in Owlbear v${VERSION}`;
}
if (LOCAL) start(); else OBR.onReady(start);
