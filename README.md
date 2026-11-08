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

- Rolls made with D&D Beyond's own dice stay in that player's sheet. Use a dice extension such as
  Dice+ for rolls the whole table should see.
- Firefox and Safari isolate third-party cookies, so the framed sheet stays logged out (and cannot
  roll) until the player allows them: Firefox → shield icon → turn off Enhanced Tracking Protection
  for owlbear.rodeo; Safari → Privacy → turn off "Prevent cross-site tracking". Chrome and Edge
  work out of the box. The panel shows this hint on those browsers.

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.
