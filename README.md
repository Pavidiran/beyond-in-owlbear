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
- Sign in always through the panel's own **Sign in** button: it opens D&D Beyond's login in a pop-up
  (the login page refuses to load inside a frame) and the panel reloads when you come back.
  Firefox and Safari isolate third-party cookies; they grant them to the frame after you interact
  with that pop-up. If the sheet still stays logged out: Firefox → shield icon → turn off Enhanced
  Tracking Protection for owlbear.rodeo; Safari → Privacy → turn off "Prevent cross-site tracking".

## Local testing

Run `serve.ps1` and open http://localhost:8787/sheet.html?ddb=CHARACTER_ID to test the viewer
outside Owlbear.
