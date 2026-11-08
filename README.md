# Beyond in Owlbear

An Owlbear Rodeo extension that opens your party's **D&D Beyond character sheets inside Owlbear**.
No browser extension, no copying of stats: the real sheet, live, in a window on top of the map.

Install in Owlbear: **Extensions → Add → paste**

```
https://pavidiran.github.io/beyond-in-owlbear/manifest.json
```

## How it works

- The panel shows the real D&D Beyond page, in D&D Beyond's own mobile layout, scaled down. Nothing is translated or re-implemented.
- Toolbar: ⌂ My characters, Campaign (if the DM set a campaign link), Sign in (pop-up), zoom,
  panel size (compact / tall / wide), reload, open in a browser tab, DM room settings.
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

Players roll in their D&D Beyond sheet as usual. To show those rolls in Owlbear, the DM runs
**Beyond Relay** during the session. It reads the campaign's game log with the DM's own D&D Beyond
session and hands each roll to the Owlbear tab on the same computer. Players install nothing.

- Download the program for your system from the
  [releases page](https://github.com/Pavidiran/beyond-in-owlbear/releases) (Windows .exe, macOS, Linux),
  or run `python relay/relay.py` with `pip install websockets`.
- First start asks for your campaign link and your D&D Beyond session cookie (`CobaltSession`,
  copied from the browser's developer tools). Both are saved in `beyond-relay.json` next to the
  program and never leave your computer. The cookie expires after a few weeks: delete that file
  and run again to paste a fresh one.
- Keep the window open while playing. It prints every roll it sees.
- Unofficial D&D Beyond feed: can break when D&D Beyond changes things.
