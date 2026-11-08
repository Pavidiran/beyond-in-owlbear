// Shared between the panel (app.js) and the background page (bg.js).
export const NS = "com.pavi.beyond-in-owlbear";
export const KEYS = {
  cfg: `${NS}/config`,     // { campaignUrl }
  log: `${NS}/log`,        // last rolls, newest first
  battle: `${NS}/battle`,  // { round, turn, entries: [{ id, kind: "pc"|"npc", entityId?, name, init, hp?, maxHp?, bonus? }] }
  relay: `${NS}/relay`,    // { connected, note, campaignId, t }
};
export const RELAY_URL = "ws://localhost:8790";
export const LOG_MAX = 25;
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const campaignIdOf = (url) => { const m = String(url || "").match(/campaigns\/(\d+)/); return m ? m[1] : ""; };
export const emptyBattle = () => ({ round: 1, turn: 0, entries: [] });

// One relay message can hold several rolls (rare); each becomes one log line.
export function flattenRoll(roll) {
  return (roll.rolls || []).map((r, i) => {
    const d20 = (r.dice || []).find((x) => x.d === "d20" && x.v != null && x.kept !== false);
    return { id: roll.id + (i ? ":" + i : ""), t: roll.t, who: roll.who, entityId: roll.entityId, action: roll.action || "",
             type: r.type || "roll", kind: r.kind || "", total: r.total, text: r.text || "", notation: r.notation || "",
             nat20: !!d20 && d20.v === 20, nat1: !!d20 && d20.v === 1 };
  });
}

// Highest initiative first; player characters before enemies on ties; keep the current turn pointer.
export function sortEntries(b) {
  const cur = b.entries[b.turn];
  b.entries.sort((x, y) => (y.init ?? -99) - (x.init ?? -99) || (x.kind === "pc" ? -1 : 1) - (y.kind === "pc" ? -1 : 1));
  b.turn = cur ? Math.max(0, b.entries.indexOf(cur)) : 0;
}

export function advanceTurn(b, dir) {
  const n = b.entries.length; if (!n) return;
  for (let i = 0; i < n; i++) {
    const was = b.turn;
    b.turn = (b.turn + dir + n) % n;
    if (dir > 0 && b.turn <= was && i === 0) b.round = (b.round || 1) + 1;
    if (dir < 0 && b.turn >= was && i === 0) b.round = Math.max(1, (b.round || 1) - 1);
    const e = b.entries[b.turn];
    if (!(e.kind === "npc" && e.hp <= 0)) return; // skip downed enemies
  }
}

export function describe(e) {
  const what = e.action && e.type && e.action.toLowerCase() !== e.type ? `${e.action} ${e.type}` : (e.action || e.type);
  return `${e.who}: ${what} ${e.total != null ? e.total : ""}`.trim();
}
