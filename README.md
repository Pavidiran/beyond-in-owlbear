# Beyond in Owlbear

An Owlbear Rodeo extension that opens your party's **D&D Beyond character sheets inside Owlbear**.
No browser extension, no copying of stats: the real sheet, live, in a window on top of the map.

Install in Owlbear: **Extensions → Add → paste**

```
https://pavidiran.github.io/beyond-in-owlbear/manifest.json
```

## How it works

- The DM pastes each character's D&D Beyond link into the extension's panel once per room.
- Anyone clicks **Open sheet** and the sheet opens in a large window inside Owlbear.
- Players click **Sign in** inside that window to log into D&D Beyond (a pop-up, because D&D Beyond
  refuses to show its login page inside a frame). After that they can edit HP, spells, etc. as usual.
- Sheets must be **Public** in D&D Beyond (character → Edit → Home → Character Privacy) so they can
  be viewed before signing in.

## Limits

- Rolls made with D&D Beyond's own dice stay in that player's sheet. Use a dice extension such as
  Dice+ for rolls the whole table should see.
- Firefox and Safari isolate third-party cookies, so the framed sheet may stay logged out there.
  Use **New tab** in that case.

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.
