# Beyond in Owlbear

An Owlbear Rodeo extension that opens your party's **D&D Beyond character sheets inside Owlbear**.
No browser extension, no copying of stats: the real sheet, live, in a window on top of the map.

Install in Owlbear: **Extensions → Add → paste**

```
https://pavidiran.github.io/beyond-in-owlbear/manifest.json
```

## How it works

- The panel shows the real D&D Beyond page, in D&D Beyond's own mobile layout, scaled down. Nothing is translated or re-implemented.
- Toolbar: ↻ reload (back to My characters), Campaign (if the DM set a campaign link), Sign in (pop-up), zoom,
  panel size (compact / tall / wide), open in a browser tab, DM room settings.
- Players open their own sheet from D&D Beyond's "My characters" page after signing in. The DM can
  add the campaign link once per room so everyone gets a Campaign button.

## Limits

- Sign in only through the panel's **Sign in** button: D&D Beyond refuses to show its login page inside
  a frame, so the login opens in a pop-up and the panel reloads when you come back.
- **Firefox and Safari** give a framed site its own empty cookie jar, and their automatic exception
  only applies when the framed site itself opens the pop-up, which D&D Beyond never does. Those
  players do a one-time step: Firefox → shield icon left of the address bar → turn off Enhanced
  Tracking Protection for owlbear.rodeo; Safari → Privacy → turn off "Prevent cross-site tracking".
  Chrome and Edge need nothing. The panel checks the browser's cross-site cookie access and shows the
  instruction only while it is actually blocked. (Verified 2026-11-08; `test/depth.html` reproduces it.)
- Rolls made with D&D Beyond's own dice stay in that player's sheet. Use a dice extension such as
  Dice+ for rolls the whole table should see.

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.

## Roll relay (DM only)

Players roll in their D&D Beyond sheet as usual. To show those rolls in Owlbear (roll log, pop-ups,
initiative straight into the battle tracker) and the party's hit points (read from D&D Beyond every
20 seconds, shown in the Battle tab), the DM runs **Beyond Relay** during the session. The DM can
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
   the panel means rolls are live. The code changes every time the relay starts.

How it reaches Owlbear: browsers no longer let a web page connect to a program on your own
computer, so the relay opens a free Cloudflare "quick tunnel" (no account, no domain) that gives it a
temporary public https address. The relay downloads Cloudflare's helper on first start (checksum
verified) unless it is already installed. Only clients that know the code's secret part get in.
Cloudflare gives quick tunnels no uptime guarantee; if one drops, the relay opens a new one and
shows a new code.

Settings and the D&D Beyond login stay in `beyond-relay.json` next to the program. Unofficial
D&D Beyond feed: may break when D&D Beyond changes things.
