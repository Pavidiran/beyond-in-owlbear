# Beyond in Owlbear

An Owlbear Rodeo extension that opens your party's **D&D Beyond character sheets inside Owlbear**.
No browser extension, no copying of stats: the real sheet, live, in a window on top of the map.

Install in Owlbear: **Extensions → Add → paste**

```
https://pavidiran.github.io/beyond-in-owlbear/manifest.json
```

## How it works

- The panel shows the real D&D Beyond character sheet, in D&D Beyond's own mobile layout, scaled down.
  Nothing is translated or re-implemented.
- **Nobody signs in.** The sheets are served by **Beyond Relay**, a small program the DM runs during the
  session (see below). It fetches each sheet from D&D Beyond with the DM's login and passes it on to the
  panel. This works the same in every browser, and players install nothing.
- Toolbar: ↻ character list (the campaign's characters; picking one opens its sheet, and the panel
  remembers it), Campaign (if the DM set a campaign link; opens in a browser tab), zoom, panel size
  (compact / tall / wide), ↗ open the character on dndbeyond.com in a browser tab, DM room settings.
- A sheet reloads by itself when the DM changes that character's HP.

## Limits

- **Everyone uses the sheets with the DM's rights.** D&D Beyond lets the DM edit the campaign's
  characters, so every player in the room can open and edit every character of the campaign. Meant for a
  table of friends. The relay only serves this campaign's character sheets and the services a sheet
  needs, but that is not a hard wall: the sheet needs a short-lived access key of the DM's login, and
  that key reaches the players' browsers.
- Dice settings (dice set, who sees the 3D dice) are the DM's, for everybody.
- Without a running relay there are no sheets in the panel; ↗ opens D&D Beyond in a normal browser tab.
- Why not each player's own login: Chrome, Edge and every other Chromium browser never send D&D
  Beyond's login cookie to a page embedded in another site (the cookie has no SameSite attribute, so it
  counts as "Lax"; reproduced 2026-11-13 in Chrome 157 and Edge 157). No browser setting changes that.
- The relay changes three things in D&D Beyond's sheet page: the service addresses in its settings point
  to the relay, a small script reroutes the sheet's remaining requests (the 3D dice files are only handed
  out to D&D Beyond's own site), and the cookie-banner loader is removed. It can break when D&D Beyond
  changes its site.

## Logo

The calligraphic B is from the font Great Vibes (SIL Open Font License 1.1, `branding/OFL-GreatVibes.txt`).
`branding/make_logo.py` regenerates `icon.svg` and the relay's icons.

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.

## Beyond Relay (DM only)

The relay serves the character sheets (see above). Players roll in their sheet as usual; the relay also
shows those rolls in Owlbear (roll log, pop-ups,
initiative straight into the battle tracker) and the party's hit points (updated as soon as D&D Beyond
announces a change, plus one small batch read every 5 seconds; shown in the Battle tab), the DM runs **Beyond Relay** during the session. The DM can
also change a player's HP in the Battle tab's party list (− [amount] +, empty box = 1, Temp sets
temporary HP);
the relay writes it to D&D Beyond, so the sheet and the tracker always agree.
Players install nothing.

1. Download the program for your system from the
   [releases page](https://github.com/Pavidiran/beyond-in-owlbear/releases) (Windows, macOS, Linux).
2. Start it, paste your campaign link, click **Sign in to D&D Beyond** and log in the usual way
   (email, Google, Apple, ...). The login is kept for next time.
3. The relay shows a **relay code** and copies it to the clipboard. In Owlbear open the
   Beyond in Owlbear panel, click the gear icon, paste it under *Relay code*, save. The green dot in
   the panel means the relay is live: sheets, rolls and hit points all come through it. The code changes
   every time the relay starts; when a new code is saved, every player's panel switches to it by itself.

How it reaches Owlbear: browsers no longer let a web page connect to a program on your own
computer, so the relay opens a free Cloudflare "quick tunnel" (no account, no domain) that gives it a
temporary public https address. The relay downloads Cloudflare's helper on first start (checksum
verified) unless it is already installed. Only clients that know the code's secret part get in.
Cloudflare gives quick tunnels no uptime guarantee; if one drops, the relay opens a new one and
shows a new code.

### Monsters (relay 0.10+)

In the Battle tab, type a monster's name in the add row: matching monsters from D&D Beyond's monster
list appear (free/basic-rules ones and anything your account can open; others are marked with a lock
and only fill in the name). Picking one fills HP (D&D Beyond's average), AC and initiative bonus.
Click a monster's name in the battle list to open its stat block: ability checks, saves, skills,
initiative, attack and damage values are buttons. Each click is rolled by the relay and posted into
the campaign's D&D Beyond game log as that monster (3D dice in open sheets that show shared dice), so it
appears in D&D Beyond and in Owlbear like any other roll. Monster rolls are visible to everyone by
default; *Monster rolls hidden from players* in the gear settings makes them DM-only. Multiattack is
shown as text (its dice are clickable). Without a running relay, monster search and rolls are unavailable.

Settings and the D&D Beyond login stay in `beyond-relay.json` next to the program. Unofficial
D&D Beyond feed: may break when D&D Beyond changes things.
