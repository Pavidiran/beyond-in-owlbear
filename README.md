# Beyond in Owlbear

An Owlbear Rodeo extension that opens your party's **D&D Beyond character sheets inside Owlbear**.
No browser extension, no copying of stats: the real sheet, live, in a window on top of the map.

Install in Owlbear: **Extensions → Add → paste**

```
https://pavidiran.github.io/beyond-in-owlbear/manifest.json
```

## How it works

- The panel shows the real D&D Beyond page, in D&D Beyond's own mobile layout, scaled down and with
  the site header cropped away. Nothing is translated or re-implemented.
- Toolbar: home (campaign page), character picker, Sign in (pop-up), zoom, hide site header,
  panel size (compact / tall / wide), reload, open in a browser tab, and DM room settings.
- The DM pastes the campaign link and optionally character links once per room. Players need
  nothing installed; they sign in inside the panel to edit their own character.

## Limits

- Sign in only through the panel's **Sign in** button: D&D Beyond refuses to show its login page inside
  a frame, so the login opens in a pop-up and the panel reloads when you come back.
- **Firefox and Safari** give a framed site its own empty cookie jar, and their automatic exception
  only applies when the framed site itself opens the pop-up, which D&D Beyond never does. Those
  players do a one-time step: Firefox → shield icon left of the address bar → turn off Enhanced
  Tracking Protection for owlbear.rodeo; Safari → Privacy → turn off "Prevent cross-site tracking".
  Chrome and Edge need nothing. (Verified 2026-11-08; `test/depth.html` reproduces it.)
- Rolls made with D&D Beyond's own dice stay in that player's sheet. Use a dice extension such as
  Dice+ for rolls the whole table should see.

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.
