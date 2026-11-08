// Beyond in Owlbear — the real D&D Beyond page in the Owlbear side panel.
// No data layer: D&D Beyond handles everything. This file only sizes, scales, crops and navigates the frame.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";

const VERSION = "0.2.2";
const NS = "com.pavi.beyond-in-owlbear";
const CFG_KEY = `${NS}/config`;
const SITE_HEADER_PX = 68; // height of dndbeyond.com's top bar in its mobile layout
const SIZES = { compact: [440, 620], tall: [440, 900], wide: [620, 900] };
const DEFAULT_HOME = "https://www.dndbeyond.com/characters";

const $ = (id) => document.getElementById(id);
let ME = { id: "", name: "", role: "PLAYER" }, META = {};
let PREF = { zoom: 0.8, crop: true, size: "tall", last: "" };
try { Object.assign(PREF, JSON.parse(localStorage.getItem("bio-pref") || "{}")); } catch {}
const savePref = () => { try { localStorage.setItem("bio-pref", JSON.stringify(PREF)); } catch {} };

const config = () => META[CFG_KEY] || { campaignUrl: "", chars: [] };
const parseDdbId = (t) => { const m = String(t || "").match(/characters\/(\d{4,})/) || String(t || "").trim().match(/^(\d{4,})$/); return m ? m[1] : null; };
const parseCampaign = (t) => { const m = String(t || "").match(/campaigns\/(\d{3,})/); return m ? `https://www.dndbeyond.com/campaigns/${m[1]}` : ""; };
const homeUrl = () => config().campaignUrl || (config().chars[0] ? `https://www.dndbeyond.com/characters/${config().chars[0].ddbId}` : DEFAULT_HOME);

let current = "";
function go(url) {
  current = url; PREF.last = url; savePref();
  $("frame").src = url;
  hint("");
}
function hint(t) { $("hint").textContent = t; $("hint").hidden = !t; }

// Scale and crop from outside: the frame is rendered larger, then shrunk with a transform,
// and shifted up so D&D Beyond's site header sits above the visible area.
function layout() {
  const z = PREF.zoom, crop = PREF.crop ? SITE_HEADER_PX : 0;
  const f = $("frame");
  f.style.width = `${100 / z}%`;
  f.style.height = `calc(${100 / z}% + ${crop}px)`;
  f.style.transform = `scale(${z})`;
  f.style.top = `${-crop * z}px`;
  $("zoomLbl").textContent = `${Math.round(z * 100)}%`;
  $("cropBtn").classList.toggle("on", PREF.crop);
  $("sizeBtn").textContent = PREF.size === "compact" ? "⤓" : PREF.size === "tall" ? "⤢" : "⤡";
}
async function applySize() {
  const [w, h] = SIZES[PREF.size] || SIZES.tall;
  try { await OBR.action.setWidth(w); await OBR.action.setHeight(h); } catch {}
}

function renderChars() {
  const sel = $("chars"), chars = config().chars;
  sel.hidden = !chars.length;
  sel.innerHTML = `<option value="">Characters…</option>` + chars.map((c) => `<option value="${c.ddbId}">${c.name.replace(/[<>&]/g, "")}</option>`).join("");
  $("gmBtn").hidden = ME.role !== "GM";
}

function signIn() {
  // dndbeyond.com/sign-in refuses to load inside a frame, so the login happens in a pop-up window.
  const ret = current.startsWith("https://www.dndbeyond.com") ? current.slice("https://www.dndbeyond.com".length) : "/characters";
  const w = window.open("https://www.dndbeyond.com/sign-in?returnUrl=" + encodeURIComponent(ret), "ddb-signin", "width=560,height=760");
  if (!w) { hint("Pop-ups are blocked. Allow them for this site, or sign in via ↗ and come back."); return; }
  hint("Finish signing in in the pop-up, then come back here. The panel reloads by itself.");
  // Reload when the pop-up closes, or as soon as the player returns to Owlbear (the pop-up may
  // have opened as a tab that stays open). Firefox grants the signed-in cookies to the frame
  // only after the player interacted with that pop-up, so the reload must come after it.
  let done = false;
  const finish = () => { if (done) return; done = true; clearInterval(t); window.removeEventListener("focus", onBack); document.removeEventListener("visibilitychange", onVis); go(current); };
  const onBack = () => setTimeout(finish, 300);
  const onVis = () => { if (document.visibilityState === "visible") onBack(); };
  const t = setInterval(() => { if (w.closed) finish(); }, 700);
  setTimeout(() => { window.addEventListener("focus", onBack); document.addEventListener("visibilitychange", onVis); }, 1500);
}

async function saveConfig(fn) {
  const m = (await OBR.room.getMetadata()) || {};
  const cfg = JSON.parse(JSON.stringify(m[CFG_KEY] || { campaignUrl: "", chars: [] }));
  fn(cfg);
  META[CFG_KEY] = cfg; renderChars();
  await OBR.room.setMetadata({ [CFG_KEY]: cfg });
}

async function onAction(act, el) {
  switch (act) {
    case "home": go(homeUrl()); break;
    case "pick": if (el.value) go(`https://www.dndbeyond.com/characters/${el.value}`); break;
    case "login": signIn(); break;
    case "zoomOut": PREF.zoom = Math.max(0.5, +(PREF.zoom - 0.05).toFixed(2)); savePref(); layout(); break;
    case "zoomIn": PREF.zoom = Math.min(1.2, +(PREF.zoom + 0.05).toFixed(2)); savePref(); layout(); break;
    case "crop": PREF.crop = !PREF.crop; savePref(); layout(); break;
    case "size": PREF.size = PREF.size === "compact" ? "tall" : PREF.size === "tall" ? "wide" : "compact"; savePref(); layout(); await applySize(); break;
    case "reload": go(current); break;
    case "tab": window.open(current, "_blank"); break;
    case "gm": { const c = config(); $("campaign").value = c.campaignUrl; $("links").value = c.chars.map((x) => `${x.name} | https://www.dndbeyond.com/characters/${x.ddbId}`).join("\n"); $("gm").hidden = !$("gm").hidden; break; }
    case "gmClose": $("gm").hidden = true; break;
    case "gmSave": {
      const chars = $("links").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const [a, b] = l.includes("|") ? l.split("|").map((s) => s.trim()) : ["", l];
        const ddbId = parseDdbId(b || a); return ddbId ? { ddbId, name: a || `Character ${ddbId}` } : null;
      }).filter(Boolean);
      await saveConfig((cfg) => { cfg.campaignUrl = parseCampaign($("campaign").value); cfg.chars = chars; });
      $("gm").hidden = true; go(homeUrl());
      break;
    }
  }
}

async function start() {
  if (OBR.isAvailable) {
    const [id, name, role] = await Promise.all([OBR.player.getId(), OBR.player.getName(), OBR.player.getRole()]);
    ME = { id, name, role };
    META = (await OBR.room.getMetadata()) || {};
    const applyTheme = (t) => document.documentElement.setAttribute("data-theme", t.mode === "LIGHT" ? "light" : "dark");
    applyTheme(await OBR.theme.getTheme()); OBR.theme.onChange(applyTheme);
    OBR.room.onMetadataChange((m) => { META = m || {}; renderChars(); });
    OBR.player.onChange((p) => { ME = { id: p.id, name: p.name, role: p.role }; renderChars(); });
  } else {
    ME = { id: "local", name: "local test", role: "GM" }; // opened outside Owlbear: layout testing only
  }
  renderChars(); layout(); await applySize();
  go(PREF.last && PREF.last.startsWith("https://www.dndbeyond.com/") ? PREF.last : homeUrl());
  // Firefox and Safari isolate third-party cookies, so the framed sheet stays logged out
  // until the player allows cross-site cookies for Owlbear. Chrome/Edge allow them by default.
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) hint("Firefox: use the Sign in button here (not the one inside the sheet). If the sheet still stays logged out afterwards: shield icon left of the address bar → turn off Enhanced Tracking Protection for owlbear.rodeo.");
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) hint("Safari: use the Sign in button here. If the sheet stays logged out afterwards: Settings → Privacy → turn off \"Prevent cross-site tracking\".");
  document.body.addEventListener("click", (ev) => { const el = ev.target.closest("[data-act]"); if (el && el.tagName !== "SELECT") onAction(el.dataset.act, el).catch((e) => hint(e.message)); });
  $("chars").addEventListener("change", (ev) => onAction("pick", ev.target));
  document.title = `Beyond in Owlbear v${VERSION}`;
}
if (OBR.isAvailable) OBR.onReady(start); else start();
