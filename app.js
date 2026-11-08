// Beyond in Owlbear — the real D&D Beyond page in the Owlbear side panel.
// No data layer: D&D Beyond handles everything. This file only sizes, scales and navigates the frame.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";

const VERSION = "0.3.1";
const NS = "com.pavi.beyond-in-owlbear";
const CFG_KEY = `${NS}/config`;
const SIZES = { compact: [440, 620], tall: [440, 900], wide: [620, 900] };
const DDB = "https://www.dndbeyond.com";
const HOME = `${DDB}/characters`; // "My characters": each player picks their own sheet there

const $ = (id) => document.getElementById(id);
let ME = { id: "", name: "", role: "PLAYER" }, META = {};
let PREF = { zoom: 0.8, size: "tall", last: "" };
try { Object.assign(PREF, JSON.parse(localStorage.getItem("bio-pref") || "{}")); } catch {}
const savePref = () => { try { localStorage.setItem("bio-pref", JSON.stringify(PREF)); } catch {} };

const config = () => META[CFG_KEY] || { campaignUrl: "" };
const parseCampaign = (t) => { const m = String(t || "").match(/campaigns\/(\d{3,})/); return m ? `${DDB}/campaigns/${m[1]}` : ""; };

let current = "";
function go(url) {
  current = url; PREF.last = url; savePref();
  $("frame").src = url;
  hint(""); cookieWarned = false; cookieCheck(); // keep the cookie warning if it still applies
}
function hint(t) { $("hint").textContent = t; $("hint").hidden = !t; }

// Scale from outside: the frame is rendered larger, then shrunk with a transform. (Cropping the site
// header away was tried and dropped: D&D Beyond's dialogs are pinned to the frame top and got cut too.)
function layout() {
  const z = PREF.zoom;
  const f = $("frame");
  f.style.width = `${100 / z}%`;
  f.style.height = `${100 / z}%`;
  f.style.transform = `scale(${z})`;
  $("zoomLbl").textContent = `${Math.round(z * 100)}%`;
  $("sizeBtn").textContent = PREF.size === "compact" ? "⤓" : PREF.size === "tall" ? "⤢" : "⤡";
}
async function applySize() {
  const [w, h] = SIZES[PREF.size] || SIZES.tall;
  try { await OBR.action.setWidth(w); await OBR.action.setHeight(h); } catch {}
}
function renderBar() {
  $("campaignBtn").hidden = !config().campaignUrl;
  $("gmBtn").hidden = ME.role !== "GM";
}

function signIn() {
  // dndbeyond.com/sign-in refuses to load inside a frame, so the login happens in a pop-up window.
  const ret = current.startsWith(DDB) ? current.slice(DDB.length) : "/characters";
  const w = window.open(`${DDB}/sign-in?returnUrl=` + encodeURIComponent(ret), "ddb-signin", "width=560,height=760");
  if (!w) { hint("Pop-ups are blocked. Allow them for this site, or sign in via ↗ and come back."); return; }
  hint("Sign in in the pop-up, then come back here. The panel reloads by itself (or press ↻).");
  // Reload when the pop-up closes, or as soon as the player returns to Owlbear.
  let done = false, away = false;
  const finish = () => {
    if (done) return; done = true; clearInterval(t);
    window.removeEventListener("focus", onBack); document.removeEventListener("visibilitychange", onVis);
    for (const ev of ["pointerdown", "mousemove", "keydown"]) document.removeEventListener(ev, onBack, true);
    go(current);
  };
  const onBack = () => setTimeout(finish, 300);
  const onVis = () => { if (document.visibilityState === "visible") onBack(); };
  const t = setInterval(() => {
    if (w.closed) return finish();
    const focused = document.hasFocus();
    if (!focused) away = true; else if (away) finish();
  }, 700);
  setTimeout(() => {
    window.addEventListener("focus", onBack); document.addEventListener("visibilitychange", onVis);
    for (const ev of ["pointerdown", "mousemove", "keydown"]) document.addEventListener(ev, onBack, true);
  }, 1500);
}

// Firefox and Safari give a framed site its own empty cookie jar, so the framed sheet stays logged
// out. Their automatic exception only applies when the framed site itself opens the sign-in pop-up
// (D&D Beyond never does), so the player has to allow cross-site cookies for Owlbear once.
// hasStorageAccess() tells us whether that is currently the case for this top-level site, so the
// warning shows only while it is needed and disappears by itself once the exception is set.
let cookieWarned = false;
async function cookieCheck() {
  let ok = true;
  try { if (window.top !== window && document.hasStorageAccess) ok = await document.hasStorageAccess(); } catch {}
  if (ok) { if (cookieWarned) { cookieWarned = false; hint(""); } return; }
  const ua = navigator.userAgent;
  const msg = /Firefox\//.test(ua)
    ? "Firefox blocks cross-site cookies here, so the sheet stays logged out. One-time fix: click the shield icon left of the address bar and turn off Enhanced Tracking Protection for owlbear.rodeo."
    : /Safari\//.test(ua) && !/Chrome\//.test(ua)
      ? "Safari blocks cross-site cookies here, so the sheet stays logged out. One-time fix: Settings → Privacy → turn off \"Prevent cross-site tracking\"."
      : "This browser blocks third-party cookies here, so the sheet stays logged out. Allow them for owlbear.rodeo (Chrome: the eye icon at the right of the address bar), then reload.";
  cookieWarned = true; hint(msg);
}

async function saveConfig(fn) {
  const m = (await OBR.room.getMetadata()) || {};
  const cfg = JSON.parse(JSON.stringify(m[CFG_KEY] || { campaignUrl: "" }));
  fn(cfg);
  META[CFG_KEY] = cfg; renderBar();
  await OBR.room.setMetadata({ [CFG_KEY]: cfg });
}

async function onAction(act) {
  switch (act) {
    case "home": go(HOME); break;
    case "campaign": if (config().campaignUrl) go(config().campaignUrl); break;
    case "login": signIn(); break;
    case "zoomOut": PREF.zoom = Math.max(0.5, +(PREF.zoom - 0.05).toFixed(2)); savePref(); layout(); break;
    case "zoomIn": PREF.zoom = Math.min(1.2, +(PREF.zoom + 0.05).toFixed(2)); savePref(); layout(); break;
    case "size": PREF.size = PREF.size === "compact" ? "tall" : PREF.size === "tall" ? "wide" : "compact"; savePref(); layout(); await applySize(); break;
    case "reload": go(current); break;
    case "tab": window.open(current, "_blank"); break;
    case "gm": $("campaign").value = config().campaignUrl; $("gm").hidden = !$("gm").hidden; break;
    case "gmClose": $("gm").hidden = true; break;
    case "gmSave": await saveConfig((cfg) => { cfg.campaignUrl = parseCampaign($("campaign").value); }); $("gm").hidden = true; break;
  }
}

async function start() {
  if (OBR.isAvailable) {
    const [id, name, role] = await Promise.all([OBR.player.getId(), OBR.player.getName(), OBR.player.getRole()]);
    ME = { id, name, role };
    META = (await OBR.room.getMetadata()) || {};
    const applyTheme = (t) => document.documentElement.setAttribute("data-theme", t.mode === "LIGHT" ? "light" : "dark");
    applyTheme(await OBR.theme.getTheme()); OBR.theme.onChange(applyTheme);
    OBR.room.onMetadataChange((m) => { META = m || {}; renderBar(); });
    OBR.player.onChange((p) => { ME = { id: p.id, name: p.name, role: p.role }; renderBar(); });
  } else {
    ME = { id: "local", name: "local test", role: "GM" }; // opened outside Owlbear: layout testing only
  }
  renderBar(); layout(); await applySize();
  go(PREF.last && PREF.last.startsWith(DDB + "/") ? PREF.last : HOME);
  await cookieCheck();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") cookieCheck(); });
  document.body.addEventListener("click", (ev) => { const el = ev.target.closest("[data-act]"); if (el) onAction(el.dataset.act).catch((e) => hint(e.message)); });
  document.title = `Beyond in Owlbear v${VERSION}`;
}
if (OBR.isAvailable) OBR.onReady(start); else start();
