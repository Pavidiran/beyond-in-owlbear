// Beyond in Owlbear — background page. Runs in every player's Owlbear tab while the room is open,
// but only the GM's copy does anything: it connects to Beyond Relay on this computer
// (ws://localhost:8790), writes every D&D Beyond roll into the room's roll log, puts characters
// into the battle tracker when they roll initiative, and keeps the relay status in the room.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, KEYS, RELAY_URL, LOG_MAX, uid, campaignIdOf, flattenRoll, sortEntries, emptyBattle, describe } from "./shared.js?v=0.4.0";

let role = "PLAYER", ws = null, relayCampaign = "", retry = null, lastRelay = "", beat = null;

const meta = async () => (await OBR.room.getMetadata()) || {};

async function writeRelay(connected, note = "") {
  const key = `${connected}|${note}|${relayCampaign}`;
  const stale = lastRelay !== key;
  lastRelay = key;
  if (!stale && !connected) return; // don't spam metadata with repeated "not running"
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

function connect() {
  if (role !== "GM" || (ws && ws.readyState <= 1)) return;
  try { ws = new WebSocket(RELAY_URL); } catch { schedule(); return; }
  ws.onopen = () => { clearInterval(beat); beat = setInterval(() => writeRelay(true).catch(() => {}), 60000); };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    try {
      if (msg.type === "hello") {
        relayCampaign = String(msg.campaignId || "");
        lastRelay = ""; await writeRelay(!!msg.connected, msg.connected ? "" : "relay running, not connected to D&D Beyond yet");
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
  ws.onclose = () => { clearInterval(beat); writeRelay(false, "Beyond Relay is not running on this computer").catch(() => {}); schedule(); };
  ws.onerror = () => {};
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
  OBR.player.onChange((p) => { if (p.role !== role) { role = p.role; if (role === "GM") connect(); else if (ws) ws.close(); } });
  if (role === "GM") connect();
});
