// Beyond in Owlbear — background page. Runs in every player's Owlbear tab while the room is open.
// Everyone: shows pop-ups for relayed rolls and turn changes.
// DM only: connects to Beyond Relay through the relay code (a public Cloudflare quick-tunnel address
// plus a secret, set in the panel's settings), writes every D&D Beyond roll into the room's roll log,
// puts characters into the battle tracker when they roll initiative, and keeps the relay status in the room.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, KEYS, LOG_MAX, HIDDEN_LOG, uid, campaignIdOf, flattenRoll, sortEntries, emptyBattle, describe, relayUrl } from "./shared.js?v=0.9.3";

let role = "PLAYER", ws = null, wsUrl = "", relayCampaign = "", retry = null, lastRelay = "", beat = null;

const meta = async () => (await OBR.room.getMetadata()) || {};

async function writeRelay(connected, note = "") {
  const key = `${connected}|${note}|${relayCampaign}`;
  const changed = lastRelay !== key;
  lastRelay = key;
  if (!changed && !connected) return; // don't rewrite the same "off" state; "on" is refreshed as a heartbeat
  await OBR.room.setMetadata({ [KEYS.relay]: { connected, note, campaignId: relayCampaign, t: Date.now() } });
}

// Initiative rolls put characters into the battle; a monster's roll sets the initiative of its own
// row (rows are named like the roll, e.g. "Goblin 2").
function initiativePatch(m, roll) {
  if (!/^initiative$/i.test(roll.action || "") || !roll.rolls[0] || roll.rolls[0].total == null) return null;
  const b = JSON.parse(JSON.stringify(m[KEYS.battle] || emptyBattle()));
  const init = roll.rolls[0].total;
  if (roll.entityType === "monster") {
    const e = b.entries.find((x) => x.kind === "npc" && x.name === roll.who && (!x.monsterId || x.monsterId === roll.entityId));
    if (!e) return null;
    e.init = init;
  } else {
    const e = b.entries.find((x) => x.kind === "pc" && x.entityId === roll.entityId);
    if (e) { e.init = init; e.name = roll.who; } else b.entries.push({ id: uid(), kind: "pc", entityId: roll.entityId, name: roll.who, init });
  }
  sortEntries(b);
  return b;
}

function hiddenLog() { try { return JSON.parse(localStorage.getItem(HIDDEN_LOG) || "[]"); } catch { return []; } }

async function onRoll(roll, replay = false) {
  const m = await meta();
  const wanted = campaignIdOf((m[KEYS.cfg] || {}).campaignUrl);
  if (wanted && relayCampaign && wanted !== relayCampaign) return; // this relay serves another campaign
  if (roll.hidden) { // for the DM only: stays in this browser, never in the room
    const log = hiddenLog();
    const fresh = flattenRoll(roll).filter((e) => !log.some((x) => x.id === e.id));
    if (!fresh.length) return;
    try { localStorage.setItem(HIDDEN_LOG, JSON.stringify([...fresh.reverse(), ...log].slice(0, LOG_MAX))); } catch {}
    const b = initiativePatch(m, roll);
    if (b) await OBR.room.setMetadata({ [KEYS.battle]: b });
    if (!replay) for (const e of fresh) OBR.notification.show(`(hidden) ${describe(e)}${e.nat20 ? " (nat 20!)" : e.nat1 ? " (nat 1)" : ""}`).catch(() => {});
    return;
  }
  const log = m[KEYS.log] || [];
  const fresh = flattenRoll(roll).filter((e) => !log.some((x) => x.id === e.id));
  if (!fresh.length) return;
  const patch = { [KEYS.log]: [...fresh.reverse(), ...log].slice(0, LOG_MAX) };
  const b = initiativePatch(m, roll);
  if (b) patch[KEYS.battle] = b;
  await OBR.room.setMetadata(patch);
  if (!replay) OBR.broadcast.sendMessage(`${NS}/roll`, fresh, { destination: "ALL" }).catch(() => {});
}

async function onParty(chars) {
  const m = await meta();
  const wanted = campaignIdOf((m[KEYS.cfg] || {}).campaignUrl);
  if (wanted && relayCampaign && wanted !== relayCampaign) return;
  const old = m[KEYS.party] || {};
  if (JSON.stringify(old.chars || []) === JSON.stringify(chars || [])) return;
  await OBR.room.setMetadata({ [KEYS.party]: { chars: chars || [], t: Date.now() } });
}

function schedule() { clearTimeout(retry); retry = setTimeout(connect, 5000); }

async function connect() {
  clearTimeout(retry);
  if (role !== "GM") return;
  const url = relayUrl(((await meta())[KEYS.cfg] || {}).relayCode);
  if (!url) { await writeRelay(false, "No relay code set: start Beyond Relay and paste its code in the panel settings (gear icon)").catch(() => {}); return; }
  if (ws && ws.readyState <= 1 && wsUrl === url) return;
  if (ws) { ws.onclose = null; ws.close(); }
  wsUrl = url;
  try { ws = new WebSocket(url); } catch { schedule(); return; }
  const sock = ws;
  sock.onopen = () => { clearInterval(beat); beat = setInterval(() => writeRelay(true).catch(() => {}), 60000); };
  sock.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    try {
      if (msg.type === "hello") {
        relayCampaign = String(msg.campaignId || "");
        lastRelay = ""; await writeRelay(!!msg.connected, msg.connected ? "" : "Beyond Relay is running but not connected to D&D Beyond");
        const recent = (msg.recent || []).filter((r) => Date.now() - (r.t || 0) < 10 * 60 * 1000);
        for (const r of recent) await onRoll(r, true);
        if (Array.isArray(msg.party) && msg.party.length) await onParty(msg.party);
      } else if (msg.type === "party") {
        await onParty(msg.chars);
      } else if (msg.type === "status") {
        if (msg.campaignId) relayCampaign = String(msg.campaignId);
        await writeRelay(!!msg.connected, msg.error || "");
      } else if (msg.type === "roll") {
        await onRoll(msg);
      } else if (msg.type === "hp-result") {
        OBR.broadcast.sendMessage(`${NS}/hp-result`, msg, { destination: "LOCAL" }).catch(() => {});
        if (msg.ok && msg.char) OBR.broadcast.sendMessage(`${NS}/hp-edited`, { entityId: msg.char.entityId }, { destination: "ALL" }).catch(() => {});
      }
    } catch (e) { console.error("beyond-in-owlbear bg", e); }
  };
  sock.onclose = (ev) => {
    if (sock !== ws) return;
    clearInterval(beat);
    const note = ev.code === 4001 ? "Wrong relay code: copy the current one from the Beyond Relay window"
      : "Can't reach Beyond Relay with this code. Is it running? It shows a new code after every restart.";
    writeRelay(false, note).catch(() => {});
    schedule();
  };
  sock.onerror = () => {};
}

OBR.onReady(async () => {
  // Everyone: pop-ups for relayed rolls and for turn changes in the battle tracker.
  OBR.broadcast.onMessage(`${NS}/roll`, (ev) => {
    for (const e of ev.data || []) OBR.notification.show(describe(e) + (e.nat20 ? " (nat 20!)" : e.nat1 ? " (nat 1)" : "")).catch(() => {});
  });
  OBR.broadcast.onMessage(`${NS}/turn`, (ev) => {
    if (ev.data && ev.data.name) OBR.notification.show(`Round ${ev.data.round || 1}: ${ev.data.name}'s turn`, "INFO").catch(() => {});
  });
  // DM's panel → this page → relay → D&D Beyond: hit point changes for player characters.
  OBR.broadcast.onMessage(`${NS}/hp`, (ev) => {
    const req = ev.data || {};
    if (role === "GM" && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "hp", ...req }));
    else OBR.broadcast.sendMessage(`${NS}/hp-result`, { reqId: req.reqId, ok: false, error: "Beyond Relay is not connected, so HP can't be changed from here" }, { destination: "LOCAL" }).catch(() => {});
  });
  role = await OBR.player.getRole();
  OBR.player.onChange((p) => { if (p.role !== role) { role = p.role; if (role === "GM") connect(); else if (ws) { ws.onclose = null; ws.close(); ws = null; } } });
  // A new relay code saved in the panel takes effect at once.
  let lastCode = ((await meta())[KEYS.cfg] || {}).relayCode || "";
  OBR.room.onMetadataChange((m) => {
    const code = ((m || {})[KEYS.cfg] || {}).relayCode || "";
    if (code !== lastCode) { lastCode = code; connect(); }
  });
  if (role === "GM") connect();
});
