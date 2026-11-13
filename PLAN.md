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

## Research 2026-11-08: how D&D Beyond's own map tool (Maps, /games/{campaignId}) gets character HP
- Batch summary endpoint: POST https://character-service-scds.dndbeyond.com/v2/characters, Bearer token,
  body {"characterIds":[...]} -> {foundCharacters, notFoundIds, queuedIds}. Each character has
  hitPointInfo {current, maximum, temp, removedHp, baseTotalHp, override} computed by DDB, plus
  conditions, deathSaveInfo, armorClass, initiativeBonus/Score. One request for the whole party, ~11 KB
  for 2 characters (vs ~260 KB per character from character/v5). Verified with the DM session.
- Maps embeds the sheet and bridges window messages between the sheet frame and the game log. On a
  "character-sheet/character-update/fulfilled" message for the shown character it reloads the embedded
  sheet, but only when that sheet does not have focus. Those messages never reached our relay's game-log
  feed (tested), so they seem to originate from sheets running inside Maps; not available to us.
- Cheap change marker also exists: character/v5/characters/list?userId=X (~660 B gzip, any campaign
  member readable with the DM session) has lastModifiedDate == character dateModified, which moves on
  every HP change (DM write, temp HP, sheet edit; verified to the second).

## Next session (noted 2026-11-08, end of day)
State: extension v0.7.0 and relay 0.9.0 live and working (user confirmed fast HP sync).
1. Monster quick-load ("grimoire"): load a monster's stats (HP, AC, initiative bonus, maybe attacks)
   into the battle tracker in one step instead of typing them. Check existing options first
   (e.g. D&D Beyond's monster service via the relay, or an existing Owlbear extension).
2. Monster tab: roll monster attacks, saves and damage from the panel.
3. Logos and relay window: nicer logos for the extension (Owlbear toolbar icon) and the relay
   (program icon), and make the relay window nicer to look at with fewer buttons (ask which;
   candidates: "Paste cookie instead...", the separate "Save & connect").
4. Music per map: check existing Owlbear extensions first; otherwise a separate extension.
Known open issue: a player acting in a stale sheet can overwrite a DM HP edit (mitigated by
auto-reload of sheets opened from the character list).

## Monsters: research and decisions (2026-11-09)
Source: GET https://monster-service.dndbeyond.com/v1/Monster?search=<q>&skip=0&take=<n>[&sources=<id>]
(no login needed; no CORS, so it goes through the relay). accessType per id: 1 = free with full stats,
4 = no access (search shows the name, HP/AC come back as 0). Basic rules: sources 1 (2014, 334) and 147
(2024, 510) -> 668 free monsters. Lookups from https://www.dndbeyond.com/api/config/json:
challengeRatings (id -> proficiencyBonus), abilitySkills (id -> name, stat).

Parsing measured over all 668 free monsters (both 2014 and 2024 wording):
- attack bonus 960/960; every dice expression extractable; damage incl. type fully parsed in 1133/1168
  entries (misses: riders, healing, "lightning or thunder"); saves 436 entries.
- structured fields: ability scores 668/668, hit dice 668/668, save proficiencies (bonus = mod + PB of CR,
  plus bonusModifier if set), skills with final value, initiativeBonus 329 (else Dex mod), recharge 154.
- Multiattack is free prose (simple pattern resolves only 152/322) -> NOT automated: show the sentence as a
  note above the attack buttons; dice inside it (e.g. Violet Fungus "1d4 Rotting Touch attacks") clickable.

Decisions (user):
- Quick-load in the Battle tab's add row: search via the relay, picking fills name/HP/AC/initiative bonus;
  locked monsters shown marked, values then typed by hand. HP = D&D Beyond's fixed average (no rolling, no toggle).
- Monster sheet with roll buttons: checks, saves, skills, initiative, HP, attacks, damage, recharge.
- Monster rolls VISIBLE TO EVERYONE by default, with a toggle in the room settings (gear) to hide them.

## Monster rolls into D&D Beyond's game log: VERIFIED (2026-11-12)
D&D Beyond's own map tool rolls monster dice client-side and dispatches a "dice/roll/fulfilled" message with
context {entityId: <monster id>, entityType: "monster", name, messageScope, messageTarget}. Scope "gameId" =
everyone, scope "userId" + messageTarget = DM user id = hidden (DM only).
Test: the relay's game-log websocket sent one hidden Goblin "Scimitar" roll (8); no echo on the socket, but
game-log-rest-live.../v1/getmessages shows it stored at the top of the history (scope userId).
Plan: click in our monster sheet -> Dice+ rolls (3D dice in Owlbear) -> its result is posted by the relay as
a monster roll (public or hidden per the room toggle) -> appears in D&D Beyond's game log and comes back into
our roll log/Battle tab like player rolls (dedupe by rollId).

## Monster rolls with D&D Beyond's 3D dice: VERIFIED (2026-11-12)
Sheets animate incoming rolls when: eventType "dice/roll/deferred", viewer's dice visibility "shared" (or
"self" and own userId), dice renderer ready, tab visible, roll newer than page load. Relay sent a public
Goblin roll as deferred (persist false) then fulfilled: the user saw the 3D dice in their open sheet.
Side effect: the roll was filed twice (same rollId): once by the relay, once by the user's open sheet, which
files a deferred roll carrying its own userId after the dice land (the relay posts with the DM's userId).
Verified again with a unique label ("Scimitar 1"): stored twice (relay + DM's open sheet), same rollId;
D&D Beyond's log display shows it once (merges by rollId).
DECISION (user): the game log is the truth for rolls; the relay is our only reader/writer of it (HP travels
via character data instead). Relay always sends "deferred" + "fulfilled"; a roll's identity is its rollId,
every reader dedupes by it (relay already does). No waiting/timing logic.
Dice+ no longer needed for monster rolls (optional extra only).

## Monsters built: extension 0.8.0, relay 0.10.0 (2026-11-13)
- Relay: monster-search / monster-get / monster-roll requests (reply {type:"reply", reqId, ok, ...}).
  Search = monster-service ?search (no login; the DM's session unlocked nothing extra in a test), free
  results first, exact/prefix match first, 20 shown. Stat block built from D&D Beyond data: saves = mod +
  PB(CR) + bonusModifier (matches printed blocks), skills parsed from skillsHtml (417/417), initiative =
  initiativeBonus else Dex mod, entry text split into text + attack buttons + dice buttons (damage type
  from "... (XdY + Z) <type> damage"), recharge from "(Recharge N-6)".
- Roll types used: only those seen in real rolls (to hit, damage, check, save, roll); checks/saves use
  the lowercase ability as action like D&D Beyond ("dex"). Relay rolls the dice (secrets), sends
  deferred, then fulfilled 4 s later (verified spacing); first copy seen (relay's or the DM sheet's,
  same values) is forwarded, the rest dropped by rollId. Verified 2026-11-13: hidden Goblin roll stored
  in getmessages with scope userId.
- Hidden rolls (scope userId, also players' "to DM" rolls) never enter the room: the DM's background
  page keeps them in localStorage "bio-hidden-log"; the DM's Rolls tab merges them, marked "hidden".
- Panel opens its own websocket to the relay (DM only, on first monster action) for requests; stat
  blocks stay in panel memory, battle rows store only monsterId. Monster initiative rolls set the row
  with the same name ("Goblin 2").
- Adding rows still rolls a quick local initiative (and Re-roll enemies); the sheet's Initiative
  button rolls through D&D Beyond.
- Advantage/disadvantage: not built. Decision (user): the DM simply rolls twice.

## Chrome/Edge can't be signed in inside the panel; relay-served sheets tested (2026-11-13)
PROBLEM (reproduced in Chrome 157 and Edge 157 with a local two-site test): D&D Beyond's login cookie
(CobaltSession) has no SameSite attribute; Chromium treats that as Lax and never sends it to a page
embedded in another site. So the framed sheet is always logged out in every Chromium browser, whatever
the settings (Storage Access only covers SameSite=None cookies; the Edge override policy is obsolete since
132). Firefox does not apply Lax-by-default, which is why the framed sheet works there. The README's
"Chrome and Edge need nothing" was never tested and is wrong.
REJECTED by the user: opening the sheet in its own window on Chromium (design change, not wanted).

IDEA (user likes it): players never log in; the panel frames the RELAY's address and the relay fetches
the sheet with the DM's login. FEASIBILITY TEST with a throwaway local proxy (not in the repo), results:
- The sheet page carries its service addresses as settings in the HTML (data-config: authUrl,
  CHARACTER_SERVICE, GAME_DATA_SERVICE, diceServiceUrl, ddbApiUrl, baseUrl, getMessagesUrl). Rewriting those
  + a small fetch/XHR reroute for leftovers is enough for the sheet itself. The big program files still
  load straight from media.dndbeyond.com.
- 3D dice need two more catches, because media.dndbeyond.com only allows www.dndbeyond.com to fetch:
  dice pictures (img with crossOrigin) and the dice workers' own fetches (shim prepended to
  /dice/mobile/*Worker*.js, which passes through the proxy).
- The game-log websocket opens directly from the foreign origin (no proxy needed).
- The DM login gets canEdit=true on characters owned by other accounts: the sheet is in edit mode.
- VERIFIED: sheet rendered, one Acrobatics roll with 3D dice, sent deferred + fulfilled, stored in the game
  log as character "Elf Wizard" (posted under the DM's user id). Also rendered inside a cross-site iframe
  in real Chrome 157 and Edge 157 (title, skills, websocket open; no D&D Beyond cookie in the browser).
- Requests seen through the proxy: auth-service cobalt-token; character-service character/v5/*
  (character, rule-data, featureflag, characters/list, vehicles, infusions, party inventory);
  gamedata-service; dice-service; api.dndbeyond.com campaigns; game-log-rest getmessages; www /app, /dice,
  /avatars, /content. api.dndbeyond.com/bi/events answers 403 (analytics, irrelevant).
NOT tested yet: through the Cloudflare tunnel inside Owlbear, Firefox/Safari, several players at once,
long sessions, other tabs of the sheet (spells, inventory, level-up), D&D Beyond's cookie banner (appears
in the frame; would reappear every session because the tunnel address changes).
OPEN DECISIONS (user): everyone acts with the DM's account (who may open/edit what; relay must restrict
to the campaign's sheets), dice settings are the DM's for everybody, account/ToS risk, whether Firefox
keeps the direct sheet, what the panel shows when the relay is off.

## Relay-served sheets built: extension 0.9.0, relay 0.11.0 (2026-11-13)
Decisions (user): everyone uses the sheets with the DM's login (friends only, editing each other's sheets
is accepted); ALL self-login removed (Sign in button, cookie warnings, "My characters"); cookie banner
removed; ↻ = the panel's own list of the campaign's characters (D&D Beyond's campaign page was checked:
unstyled through the relay and it is the DM view with Edit Campaign / invite / remove controls);
relay off = note in the panel + ↗ to D&D Beyond in a normal tab; Campaign button opens a browser tab.
- Relay: aiohttp server on the tunnel port serves BOTH the panel websocket (/?k=secret, unchanged) and
  the sheets. Sheet page keeps D&D Beyond's own path: /characters/<id>?k=<secret> (the sheet program reads
  the path; a /s/<secret>/ prefix on the page gave an empty sheet). Everything the page then loads uses
  /s/<secret>/... : /s/<secret>/__p/<host>/<path> = a D&D Beyond service, /s/<secret>/<path> = www file.
  Public static paths (/app, /content, /dice, /avatars, media/images hosts) need no secret and get no login.
- Allow-list: page only for campaign characters; auth-service /v1/cobalt-token; character-service
  /character/* with every characterId (path, query, JSON body; 0 = none) in the campaign; gamedata,
  dice-service; api /campaigns/...<campaignId>; game-log-rest getmessages for the campaign; api /bi/*
  answered 204 locally. Refusals are logged once each in the relay log.
- Known gap (told the user, accepted): the DM's short-lived cobalt token reaches the players' browsers.
- Panel: PREF.char = picked character id; frame = relaySheetUrl(code, id); reloads on relay code change,
  relay coming back, and DM HP edits; "off" note over the frame while the relay is not live.
- VERIFIED locally: sheet, spells/inventory tabs, sidebar, roll with 3D dice (arrives in the relay's roll
  feed), HP change (relay sees it in 1 s), refusals (wrong code, foreign character, account page), embedded
  cross-site in real Chrome 157 and Edge 157 (no cookies, no banner), built exe serves.
- NOT verified yet: through the Cloudflare tunnel in a real Owlbear room, Firefox/Safari, several players
  at once, sessions longer than a few minutes, level-up/builder pages.
- Noted: D&D Beyond's own header (with its Sign in link) is still part of the page; its links lead to
  the relay's "not available" note.

## Fixes after the first Owlbear test: extension 0.9.1, relay 0.11.1 (2026-11-13)
User tested 0.9.0 / 0.11.0 in Owlbear through the tunnel: the sheet loads and works. Reported:
- Gray circle at the top left while the relay is off: the status dot has class "off" (relay state) and
  the new note over the frame used the same class name. Note renamed to .nosheet.
- Top of the sheet (character name) covered by D&D Beyond's site header: the header's script is a module
  on media.dndbeyond.com, which only allows www.dndbeyond.com (CORS), so it never ran; the header kept
  its 66 px default while the sheet header sits at a fixed 47 px. The relay now rewrites that script's
  src to go through itself; with the script running the sheet header is placed below the site header
  (verified at 440 and 550 px). Side effects: the header menu shows the DM's account name/menu (its links
  are refused by the relay), and the script asks auth-service-stg (staging) for a token, which is refused.
- Panel should start at the character selection, not with the last sheet: openId (per session) decides
  what the frame shows; PREF.char only marks the last-used character in the list.
- Relay-off note for the DM no longer appends "Start Beyond Relay..." to notes like "Wrong relay code".

## Sheet reloaded every 4 min 20 s: fixed in extension 0.9.3, relay 0.11.2 (2026-11-13)
Cause (confirmed in the user's relay.log: "Sheet opened" 1-2 s after every "Refreshing session token"):
the relay reconnects its game-log socket with a fresh token every ttl-40 s and reported that as
connected=false then true; the panel reloaded the frame whenever the relay "came back" (!wasLive).
- Panel: never reloads because the relay came back. The frame is (re)loaded only when its address changes
  (first pick, new relay code) or on force (picked again from the list, DM changed that character's HP).
  A "not live" shorter than 20 s is ignored (no note over the frame). Verified with simulated state flips.
- Relay: a planned token renewal is no longer reported as disconnected (verified with ttl forced to 70 s:
  two renewals, only connected=true statuses sent).
- Extension 0.9.2 before that: default zoom 100% (browsers on the old saved default 0.8 move over once).
