// Beyond in Owlbear — background page. Runs in every player's Owlbear tab while the room is open.
// Everyone: shows pop-ups for relayed rolls and turn changes.
// DM only: connects to Beyond Relay through the relay code (a public Cloudflare quick-tunnel address
// plus a secret, set in the panel's settings), writes every D&D Beyond roll into the room's roll log,
// puts characters into the battle tracker when they roll initiative, and keeps the relay status in the room.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, KEYS, LOG_MAX, uid, campaignIdOf, flattenRoll, sortEntries, emptyBattle, describe, relayUrl } from "./shared.js?v=0.4.1";

let role = "PLAYER", ws = null, wsUrl = "", relayCampaign = "", retry = null, lastRelay = "", beat = null;

const meta = async () => (await OBR.room.getMetadata()) || {};

async function writeRelay(connected, note = "") {
  const key = `${connected}|${note}|${relayCampaign}`;
  const changed = lastRelay !== key;
  lastRelay = key;
  if (!changed && !connected) return; // don't rewrite the same "off" state; "on" is refreshed as a heartbeat
  await OBR.room.setMetadata({ [KEYS.relay]: { connected, note, campaignId: relayCampaign, t: Date.now() } });
}

async function onRoll(roll, replay = false) {
  const m = await meta();
  const wanted = campaignIdOf((m[KEYS.cfg] || {}).campaignUrl);
  if (wanted && relayCampaign && wanted !== relayCampaign) return; // this relay serves another campaign
  const log = m[KEYS.log] || [];
  const fresh = flattenRoll(roll).filter((e) => !log.some((x) => x.id === e.id));
  if (!fresh.length) return;
  const patch = { [KEYS.log]: [...fresh.reverse(), ...log].slice(0, LOG_MAX) };
  if (/^initiative$/i.test(roll.action || "") && roll.rolls[0] && roll.rolls[0].total != null) {
    const b = JSON.parse(JSON.stringify(m[KEYS.battle] || emptyBattle()));
    const init = roll.rolls[0].total;
    const e = b.entries.find((x) => x.kind === "pc" && x.entityId === roll.entityId);
    if (e) { e.init = init; e.name = roll.who; } else b.entries.push({ id: uid(), kind: "pc", entityId: roll.entityId, name: roll.who, init });
    sortEntries(b);
    patch[KEYS.battle] = b;
  }
  await OBR.room.setMetadata(patch);
  if (!replay) OBR.broadcast.sendMessage(`${NS}/roll`, fresh, { destination: "ALL" }).catch(() => {});
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
      } else if (msg.type === "status") {
        if (msg.campaignId) relayCampaign = String(msg.campaignId);
        await writeRelay(!!msg.connected, msg.error || "");
      } else if (msg.type === "roll") {
        await onRoll(msg);
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
