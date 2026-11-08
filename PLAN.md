# Beyond in Owlbear — plan (draft, 2026-11-07)

## Goal
Use the real D&D Beyond character sheets inside Owlbear Rodeo, so future campaigns with
player-built characters do not need hand-transcribed sheets. The Stormwreck extension stays
as it is for the current campaign.

## What we verified on 2026-10-22
- A D&D Beyond character page loads inside a cross-origin iframe (no frame-ancestors header).
- The sign-in page refuses to load in a frame, so login must happen in a pop-up window.
- An Owlbear extension cannot call D&D Beyond's API with the player's session (origin check).
- Rolls made inside D&D Beyond only leave it through the unofficial "game log" websocket,
  which needs a server holding the DM's session cookie (ToS grey area).
- Firefox/Safari isolate third-party cookies: the framed sheet may stay logged out there.

## Revision 2026-11-08 (after testing v0.1 in a room)
The framed D&D Beyond page is too big and shows everything; a compact panel like the Stormwreck
one is wanted, and characters should come from the campaign, not from pasted links. Both need
character data, and only the DM's login can read the campaign, so the relay becomes the data
source for everything. D&D Beyond stays the source of truth; Owlbear shows a compact view of it.

Data flow:
1. **Relay** (Python, runs on the DM's PC during sessions, DM cookie + campaign id):
   reads the campaign roster, pulls each character's full data (refreshes every ~15 s and when
   a game-log event arrives), reduces it to a compact sheet (~2 KB), listens to the game log for
   rolls, and later applies HP/slot changes back to D&D Beyond.
2. **DM background page** (manifest `background_url`, runs whenever the DM's Owlbear tab is open):
   connects to the relay on localhost, keeps the compact sheets, writes a tiny per-character
   summary (name, HP, AC, initiative, level) plus battle and roll log into room metadata (16 KB
   cap), and broadcasts full sheets to players on change and on request.
3. **Panel** (everyone, action popover): compact sheet like the Stormwreck one: vitals, saves,
   skills, attacks, features, spells, battle tracker, roll log. Rolls go through Dice+ (with the
   internal fallback) exactly as before. HP changes are sent to the DM page → relay → D&D Beyond.
   Rolls players make inside D&D Beyond also appear (via the game log); initiative rolls, from
   either side, put the character in the battle tracker.
   "Open full sheet" keeps the v0.1 framed window for inventory, backstory etc.

Consequences: players need nothing installed; fresh data only flows while the DM's Owlbear tab
and the relay are running (players keep the last copy they saw, marked with its age).

## Architecture (v0.1, superseded above)
Separate static extension, own repo + GitHub Pages, deployed with git like the other one.

1. **Popover (roster)** — per-room list of characters stored in room metadata.
   DM pastes D&D Beyond links and a display name. Anyone clicks "Open sheet".
2. **Sheet window (Owlbear modal)** — our page with a toolbar (Sign in, Reload, New tab, Close)
   and the D&D Beyond sheet in an iframe underneath. Sign in opens the pop-up; when it closes
   the sheet reloads logged in.
3. **Later, optional: battle tracker** ported from Stormwreck sheets (initiative, hidden enemy
   HP, turn order). D&D Beyond has no shared initiative inside Owlbear. Initiative would be typed
   or rolled with Dice+, since we cannot read rolls from the sheet.
4. **Roll relay (DM only, no player setup).** Players roll normally in their D&D Beyond sheet
   (attacks, checks, saves, damage, initiative). Every roll goes into the campaign's game log.
   A small program the DM runs during the session subscribes to that game log with the DM's
   D&D Beyond session cookie and campaign ID, and pushes each roll to the DM's Owlbear panel over
   a local websocket (localhost). The panel writes it into the room's shared roll log and shows
   a pop-up, so everyone sees "Arthur: Battleaxe attack 17 (1d20+5)". Initiative rolls can fill
   the battle tracker automatically.
   - Prior art proving the game-log part: AstralBridge (Python, for Foundry) and beyond-mcp.
   - DM setup, once: install the relay, paste the CobaltSession cookie value and campaign ID.
     Players install nothing.
   - Unofficial API, ToS grey area, can break when D&D Beyond changes things. Only the DM's
     cookie is involved and it never leaves the DM's machine.
   - Owl20 (Beyond20 + Owlbear bridge) exists but needs browser extensions on every player's
     machine, which is what we want to avoid.
   - Dice+ stays useful for GM/enemy rolls inside Owlbear; it cannot read D&D Beyond rolls.

## Milestones
- M1: roster + sheet window. Test in a real room: public sheet renders, pop-up login works from
  inside Owlbear, edits persist after reload.
- M2: roll relay. Relay program + "Relay" status in the DM's panel + shared roll log in the room.
  Test: player rolls in D&D Beyond, everyone sees it in Owlbear within a second or two.
- M3: battle tracker port, fed by relayed initiative rolls.

## Risks
- D&D Beyond can add a frame-ancestors header any day; the extension would stop working overnight.
- Pop-ups might be blocked inside Owlbear's extension iframe. Fallback: "New tab" button.
- Sheets must be set to Public in D&D Beyond to be viewable before login.

## Decisions to make
- [ ] Repo: public `Pavidiran/beyond-in-owlbear` (public is required for free GitHub Pages).
- [ ] Relay runtime: Python script (DM installs Python once, same as AstralBridge) or a single
      .exe built from it. Suggest: Python first, .exe later if it proves itself.
- [ ] Cookie handling: DM pastes the CobaltSession cookie into a local config file (expires every
      few weeks, re-paste), or the relay opens a login window and grabs it itself (more code).
- [ ] What a relayed roll looks like in Owlbear: text in the shared roll log + pop-up. (3D dice
      cannot replay a given result.)
- [ ] Access: everyone can open every sheet (simple) vs. each player claims one.
- [ ] Sheet window: large modal (1280×900) or full screen?

## Outcome 2026-11-08 — v0.2.0 is the direction
The "translation layer" idea (relay + own compact panel) was rejected by the user: D&D Beyond
should handle everything, we only distort the page. v0.2.0 shows dndbeyond.com in the action
popover (440 wide → D&D Beyond's mobile layout), scaled, with the site header cropped, pop-up
sign-in, campaign home, character picker, panel size presets. User tested in a room: works,
including sign-in and the campaign page inside the panel.
Open ideas, only if asked: DM-only game-log relay for shared rolls; battle tracker port.

## Finding 2026-11-08 — Firefox/Safari sign-in
Framed D&D Beyond stays logged out in Firefox/Safari. Mozilla's opener heuristic only fires when the
framed site itself opens the pop-up; D&D Beyond never does, and only its own code could call the
Storage Access API. No code-side fix exists. Firefox/Safari players: one-time shield/cross-site
cookie exception for owlbear.rodeo. Chrome/Edge: nothing. The panel shows this per browser (v0.2.4).

## v0.4.0 (2026-11-08): roll log + battle tracker, and the localhost problem
- Panel gains a drawer: relay status dot, Rolls tab (shared log, last 25), Battle tab (initiative
  order, hidden enemy HP for the DM, Next/Back with turn pop-ups for everyone). All writes re-read
  the room first. Background page (manifest background_url) on the DM's side connects to Beyond
  Relay on ws://localhost:8790 and writes relayed rolls into the room; "Initiative" rolls enter the
  battle tracker keyed by D&D Beyond character id. Rooms whose campaign link differs ignore rolls.
- Real roll format confirmed (data.action "Initiative"/"Greatsword"/"dex", rolls[].rollType
  "roll"/"to hit"/"check", result.total/text, set[].dice[].dieValue).
- BLOCKER found: browsers now gate connections from internet pages to localhost ("Local Network
  Access"). Chrome 147+ blocks it inside iframes unless the parent (Owlbear) delegates the
  permission, which Owlbear does not; verified denied in Chromium 152. Firefox 154+ shows a
  permission prompt. => The localhost hop needs replacing by an internet hop (hosted hub both the
  relay and the extension connect out to). Decision pending with the user.

## v0.4.1 / relay 0.4.0 (2026-11-08): public address through a Cloudflare quick tunnel
User rejected hosted servers and third-party mailboxes; wants one small app, no accounts. Chosen:
the relay opens a Cloudflare quick tunnel (cloudflared, free, no account/domain, random
*.trycloudflare.com address per run). Relay code = "<subdomain>/<per-run secret>"; DM pastes it into
the panel settings (room metadata config.relayCode); the DM's background page connects to
wss://<subdomain>.trycloudflare.com/?k=<secret>. Relay rejects wrong secrets (close 4001).
Funding (asked by the user): Cloudflare's free tier is a deliberate business strategy — free traffic
strengthens ISP peering and threat intelligence, uses spare capacity, and feeds paid conversions.
Note: Claude was not allowed to open a tunnel itself; first real tunnel test is the user's.

## v0.5.0 / relay 0.5.0 (2026-11-08): party hit points
Read-only HP for every campaign character (roster: /api/campaign/stt/active-short-characters/{id},
character: character-service v5, DM bearer token). Max HP = override, else base + bonus + CON mod x level
+ "hit-points-per-level" x level + flat "hit-points" bonuses without dice (dice ones are potions).
Verified against a public sheet (37/45) and the user's campaign (2 characters). Polled every 20 s,
sent on change, stored in room metadata (KEYS.party), shown at the top of the Battle tab and on PC rows.
Note: dndbeyond-mcp's calculateMaxHp (base + bonus) is wrong — it ignores CON.

## v0.6.0 / relay 0.6.0 (2026-11-08): DM edits player HP, written back to D&D Beyond
Verified with the user's OK: the DM's session may write HP to a character owned by another account
(PUT character-service /character/v5/life/hp/damage-taken, body {characterId, removedHitPoints,
temporaryHitPoints} — temporaryHitPoints is required). Panel (DM) → LOCAL broadcast → bg → relay ws
{type:"hp"} → relay re-reads, applies 5e rules (temp HP soaks damage, clamp 0..max), writes, re-reads,
pushes party update. Only characters of the campaign are accepted.

## Finding 2026-11-08: open D&D Beyond sheets cannot be live-updated
Checked the character-app bundle (media.dndbeyond.com/character-app, main.*.js): the sheet loads the
character once on mount (characterLoadRequest guarded by a one-shot state), has no focus/interval
refetch, and its message broker only handles "character-sheet/item-shared/fulfilled" (re-requests the
party inventory). Game-log types present: dice/roll/{pending,fulfilled,rejected}, dice/set/update,
map/activate/fulfilled. => No signal makes an open sheet re-read HP; only a reload does. The panel
auto-reloads sheets it opened itself (party-list names); "My characters" flow needs ↻ + pick.

## v0.6.5 (2026-11-08): character list instead of "My characters"
Why: a sheet reached through D&D Beyond's own links is invisible to the panel (cross-origin), so it can't be
reloaded after a DM HP edit, and a player acting on stale HP can overwrite the DM's change. ↻ now shows the
campaign's characters (relay roster); the panel opens the picked sheet itself, remembers it, and reloads it
after any DM edit to that character, even if the player clicked elsewhere inside D&D Beyond (user's call).
Players may open any listed sheet; editing still needs the owner's D&D Beyond login.
