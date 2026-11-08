#!/usr/bin/env python3
"""Beyond Relay - shows your D&D Beyond campaign's dice rolls inside Owlbear Rodeo.

Only the DM runs this. It opens a small window: paste the campaign link, click "Sign in to D&D Beyond"
and log in normally in the window that opens. The relay keeps the session, listens to the campaign's
game log (the same feed the D&D Beyond website uses) and hands every roll to the "Beyond in Owlbear"
extension in the Owlbear tab on this computer through a local connection (ws://127.0.0.1:8790).
Players install nothing.

Settings are saved in beyond-relay.json next to this program and never leave this computer.
Unofficial D&D Beyond endpoints: may break when they change things.
Run with --console for a terminal-only mode.
"""
import asyncio
import base64
import json
import queue
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime
from pathlib import Path

try:
    import websockets
except ImportError:  # pragma: no cover
    print("Missing dependency: run  pip install websockets pywebview")
    sys.exit(1)

for _s in (sys.stdout, sys.stderr):  # Windows consoles default to a legacy code page
    try:
        if _s: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

VERSION = "0.9.0"
DDB = "https://www.dndbeyond.com"
AUTH_URL = "https://auth-service.dndbeyond.com/v1/cobalt-token"
WS_URL = "wss://game-log-api-live.dndbeyond.com/v1"
NAMEID_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
ROLL_EVENT = "dice/roll/fulfilled"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
FROZEN = getattr(sys, "frozen", False)
HERE = Path(sys.executable).parent if FROZEN else Path(__file__).parent
CONFIG = HERE / "beyond-relay.json"
RAWLOG = HERE / "relay-raw.jsonl"        # last raw roll messages, for debugging the format
LOGFILE = HERE / "relay.log"            # everything the window log shows, for troubleshooting
LOGIN_RESULT = HERE / ".login-result"    # handed from the login window process to the main window
DEFAULT_PORT = 8790
COOKIE_HELP = (
    "Manual alternative: paste the value of your D&D Beyond 'CobaltSession' cookie.\n\n"
    "Firefox:  open dndbeyond.com, press F12, tab 'Storage', 'Cookies', 'https://www.dndbeyond.com',\n"
    "          row 'CobaltSession' - copy its Value.\n"
    "Chrome / Edge:  open dndbeyond.com, press F12, tab 'Application', 'Cookies',\n"
    "          'https://www.dndbeyond.com', row 'CobaltSession' - copy its Value."
)

EVENTS = queue.Queue()          # messages from worker threads to the window
RECENT = deque(maxlen=30)       # normalized rolls, replayed to a panel when it connects
SEEN = deque(maxlen=2000)       # message ids, to drop replays after a reconnect
CLIENTS = set()                 # connected Owlbear panels
STATE = {"connected": False, "campaignId": "", "userId": "", "error": ""}


def emit(kind, payload):
    EVENTS.put((kind, payload))
    if kind != "log":
        return
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {payload}"
    if sys.stdout:
        try:
            print(line, flush=True)
        except Exception:
            pass
    try:  # relay.log next to the program, for troubleshooting (rotated at 1 MB)
        if LOGFILE.exists() and LOGFILE.stat().st_size > 1_000_000:
            LOGFILE.replace(LOGFILE.with_suffix(".log.1"))
        with LOGFILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def log(text): emit("log", text)
def status(text, ok=None): emit("status", (text, ok))


# ---------------------------------------------------------------- config
def parse_campaign(text):
    m = re.search(r"campaigns/(\d+)", text or "") or re.fullmatch(r"\s*(\d+)\s*", text or "")
    return m.group(1) if m else ""


def clean_cookie(text):
    c = re.sub(r"^\s*CobaltSession=", "", text or "").strip().strip(";").strip()
    return c if len(c) >= 20 else ""


def load_config():
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text())
        except Exception:
            pass
    return {"campaignId": "", "cobalt": "", "port": DEFAULT_PORT}


def save_config(cfg):
    CONFIG.write_text(json.dumps(cfg, indent=2))


# ---------------------------------------------------------------- D&D Beyond auth
def fetch_token(cobalt):
    req = urllib.request.Request(AUTH_URL, data=b"{}", method="POST", headers={
        "Cookie": f"CobaltSession={cobalt}", "Content-Type": "application/json", "User-Agent": UA,
        "Accept": "application/json", "Origin": DDB, "Referer": DDB + "/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read().decode())
    token, ttl = body.get("token"), int(body.get("ttl") or 300)
    if not token:
        raise RuntimeError(f"no token in response: {body}")
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload).decode())
    return token, ttl, str(claims.get(NAMEID_CLAIM) or "")


# ---------------------------------------------------------------- party hit points (read-only)
_TOKEN_CACHE = {"token": "", "until": 0.0}


def cached_token(cobalt):
    if time.time() < _TOKEN_CACHE["until"]:
        return _TOKEN_CACHE["token"]
    token, ttl, _ = fetch_token(cobalt)
    _TOKEN_CACHE.update(token=token, until=time.time() + ttl - 30)
    return token


def ddb_get(url, cobalt):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {cached_token(cobalt)}", "Cookie": f"CobaltSession={cobalt}",
        "User-Agent": UA, "Accept": "application/json", "Referer": DDB + "/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read().decode())
    return body.get("data", body) if isinstance(body, dict) else body


def campaign_character_ids(cfg):
    """IDs of the active characters in the campaign (the DM's session can read this)."""
    data = ddb_get(f"{DDB}/api/campaign/stt/active-short-characters/{cfg['campaignId']}", cfg["cobalt"])
    items = data if isinstance(data, list) else (data or {}).get("characters") or []
    ids = []
    for it in items:
        cid = it.get("id") or it.get("characterId") if isinstance(it, dict) else None
        if cid:
            ids.append(str(cid))
    return ids


def ability_score(c, stat_id, sub_type):
    over = next((s.get("value") for s in c.get("overrideStats") or [] if s.get("id") == stat_id), None)
    if over is not None:
        return over
    score = next((s.get("value") for s in c.get("stats") or [] if s.get("id") == stat_id), None) or 10
    score += next((s.get("value") for s in c.get("bonusStats") or [] if s.get("id") == stat_id), None) or 0
    sets = []
    for lst in (c.get("modifiers") or {}).values():
        for m in lst or []:
            if m.get("subType") == sub_type and m.get("type") == "bonus" and isinstance(m.get("value"), (int, float)):
                score += m["value"]
            elif m.get("subType") == sub_type and m.get("type") == "set" and isinstance(m.get("value"), (int, float)):
                sets.append(m["value"])  # e.g. Amulet of Health
    return max([score] + sets)


def hit_points(c):
    """Same numbers the D&D Beyond sheet shows: current / max (+ temporary)."""
    level = sum(int(x.get("level") or 0) for x in c.get("classes") or []) or 1
    if c.get("overrideHitPoints") is not None:
        mx = int(c["overrideHitPoints"])
    else:
        con_mod = (ability_score(c, 3, "constitution-score") - 10) // 2
        mx = int(c.get("baseHitPoints") or 0) + int(c.get("bonusHitPoints") or 0) + con_mod * level
        for lst in (c.get("modifiers") or {}).values():
            for m in lst or []:
                if m.get("type") != "bonus" or not isinstance(m.get("value"), (int, float)) or m.get("dice"):
                    continue  # dice-based "hit-points" entries are healing potions etc., not max HP
                if m.get("subType") == "hit-points-per-level":
                    mx += int(m["value"]) * level
                elif m.get("subType") == "hit-points":
                    mx += int(m["value"])
    cur = max(0, mx - int(c.get("removedHitPoints") or 0))
    ds = c.get("deathSaves") or {}
    return {"entityId": str(c.get("id")), "name": c.get("name") or "?", "hp": cur, "max": mx,
            "temp": int(c.get("temporaryHitPoints") or 0), "dead": bool(ds.get("failCount", 0) >= 3),
            "stable": bool(ds.get("isStabilized"))}


PARTY = {"chars": [], "ids": [], "roster_at": 0.0, "written": {}, "fresh_until": {}}
EVENT_TYPES_SEEN = set()
HP_URL = "https://character-service.dndbeyond.com/character/v5/life/hp/damage-taken"
HP_LOCK = asyncio.Lock()
# Batch character summaries, as used by D&D Beyond's own map tool: one request for the whole party,
# HP already computed by D&D Beyond (current / maximum / temp).
SCDS_URL = "https://character-service-scds.dndbeyond.com/v2/characters"
POLL_SECONDS = 5
CHAR_UPDATE_EVENT = "character-sheet/character-update/fulfilled"


def character_changed(entity_id):
    """D&D Beyond reported that this character was saved: read it now instead of waiting for the next poll."""
    wake = PARTY.get("wake")
    if entity_id and wake is not None:
        PARTY["pending"].add(str(entity_id))
        wake.set()


def scds_summaries(ids, cobalt):
    req = urllib.request.Request(SCDS_URL, data=json.dumps({"characterIds": [int(i) for i in ids]}).encode(), method="POST", headers={
        "Authorization": f"Bearer {cached_token(cobalt)}", "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": UA, "Origin": DDB, "Referer": DDB + "/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read().decode() or "{}")
    return body.get("foundCharacters") or [], [str(x) for x in body.get("queuedIds") or []], [str(x) for x in body.get("notFoundIds") or []]


def summary_to_char(sm):
    hpi = sm.get("hitPointInfo") or {}
    ds = sm.get("deathSaveInfo") or {}
    conds = [(x.get("name") if isinstance(x, dict) else str(x)) for x in sm.get("conditions") or []]
    ci = sm.get("castingInfo") or {}
    dcs = sorted({int(x.get("value")) for x in ci.get("saveDcs") or [] if x.get("value") is not None})
    walk = next((x.get("distance") for x in sm.get("speeds") or [] if str(x.get("name", "")).lower() == "walking"), None)
    classes = " / ".join(f"{c.get('name')} {c.get('level')}" for c in sm.get("classes") or [] if c.get("name"))
    return {"entityId": str(sm.get("characterId")), "name": sm.get("name") or "?",
            "hp": int(hpi.get("current") or 0), "max": int(hpi.get("maximum") or 0), "temp": int(hpi.get("temp") or 0),
            "dead": int(ds.get("failCount") or 0) >= 3, "stable": int(ds.get("successCount") or 0) >= 3,
            "conditions": [c for c in conds if c],
            # stats for the Party and Battle tabs, as D&D Beyond reports them
            "ac": sm.get("armorClass"), "cls": classes, "level": sm.get("level"),
            "pp": sm.get("passivePerception"), "pins": sm.get("passiveInsight"), "pinv": sm.get("passiveInvestigation"),
            "dc": dcs, "speed": walk, "insp": bool(sm.get("inspiration")),
            "senses": [f"{x.get('name')} {x.get('distance')}".strip() for x in sm.get("senses") or [] if x.get("name")],
            "ds": [int(ds.get("successCount") or 0), int(ds.get("failCount") or 0)]}


def ddb_put(url, payload, cobalt):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="PUT", headers={
        "Authorization": f"Bearer {cached_token(cobalt)}", "Cookie": f"CobaltSession={cobalt}", "User-Agent": UA,
        "Content-Type": "application/json", "Accept": "application/json", "Origin": DDB, "Referer": DDB + "/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")


def apply_hp_change(c, delta, temp, mx=None):
    """5e rules on D&D Beyond's stored values. delta < 0: damage (temporary HP absorb it first);
    delta > 0: healing (up to max); temp: set temporary HP. Returns (removedHitPoints, temporaryHitPoints).
    mx: D&D Beyond's maximum HP for this character (from its summary); computed only if unknown."""
    if mx is None:
        mx = hit_points(c)["max"]
    removed = int(c.get("removedHitPoints") or 0)
    tmp = int(c.get("temporaryHitPoints") or 0)
    if temp is not None:
        tmp = max(0, int(temp))
    if delta:
        d = int(delta)
        if d < 0:
            dmg = -d
            soak = min(tmp, dmg)
            tmp -= soak
            removed = min(mx, removed + dmg - soak)
        else:
            removed = max(0, removed - d)
    return removed, tmp


async def change_hp(entity_id, delta, temp):
    """DM-side hit point change from Owlbear, written to D&D Beyond (re-read right before writing)."""
    cfg = STATE.get("cfg")
    if not cfg or not re.fullmatch(r"\d+", entity_id or ""):
        return {"ok": False, "error": "relay not ready"}
    if entity_id not in PARTY["ids"] and entity_id not in {x["entityId"] for x in PARTY["chars"]}:
        return {"ok": False, "error": "not a character of this campaign"}
    url = f"https://character-service.dndbeyond.com/character/v5/character/{entity_id}"
    async with HP_LOCK:
        try:
            c = await asyncio.to_thread(ddb_get, url, cfg["cobalt"])  # authoritative stored values right before writing
            known = next((x for x in PARTY["chars"] if x["entityId"] == entity_id), None)
            mx = known["max"] if known and known.get("max") else None
            removed, tmp = apply_hp_change(c, delta, temp, mx)
            resp = await asyncio.to_thread(ddb_put, HP_URL, {"characterId": int(entity_id), "removedHitPoints": removed,
                                                             "temporaryHitPoints": tmp}, cfg["cobalt"])
            # D&D Beyond answers with the stored values; use them instead of a second read.
            data = (resp or {}).get("data") or {}
            log(f"  stored damage {c.get('removedHitPoints') or 0} / temp {c.get('temporaryHitPoints') or 0} -> sent {removed} / {tmp}; D&D Beyond answered {data}")
            removed = int(data.get("removedHitPoints", removed)); tmp = int(data.get("temporaryHitPoints", tmp))
            if known and mx:
                fresh = dict(known, hp=max(0, mx - removed), temp=tmp)
            else:
                c["removedHitPoints"], c["temporaryHitPoints"] = removed, tmp
                fresh = hit_points(c)
            PARTY["written"][entity_id] = time.time()
        except urllib.error.HTTPError as e:
            msg = f"D&D Beyond refused the change (HTTP {e.code})"
            log(msg); return {"ok": False, "error": msg}
        except Exception as e:
            log(f"HP change failed: {e}"); return {"ok": False, "error": str(e)}
    chars = [fresh if x["entityId"] == entity_id else x for x in PARTY["chars"]]
    if fresh["entityId"] not in {x["entityId"] for x in chars}:
        chars.append(fresh)
    PARTY["chars"] = sorted(chars, key=lambda x: x["name"].lower())
    what = f"set temp HP {temp}" if temp is not None and not delta else (f"{-int(delta)} damage" if int(delta or 0) < 0 else f"healed {int(delta or 0)}")
    log(f"{fresh['name']}: {what} -> {fresh['hp']}/{fresh['max']}" + (f" +{fresh['temp']} temp" if fresh["temp"] else ""))
    await send_all({"type": "party", "chars": PARTY["chars"]})
    return {"ok": True, "char": fresh}


async def party_watch(cfg):
    """Keeps the party's hit points current: reads a character right away when D&D Beyond announces a
    change to it, and reads the whole party in one batch request every few seconds as a safety net."""
    PARTY["wake"], PARTY["pending"] = asyncio.Event(), set()
    batch_at = 0.0
    while True:
        try:
            if time.time() - PARTY["roster_at"] > 300 or not PARTY["ids"]:
                PARTY["ids"] = await asyncio.to_thread(campaign_character_ids, cfg)
                PARTY["roster_at"] = time.time()
            seen = {r["entityId"] for r in RECENT if r.get("entityType") == "character"}
            ids = list(dict.fromkeys(PARTY["ids"] + sorted(seen)))
            asked_at, got = time.time(), {}
            announced = sorted(PARTY["pending"]); PARTY["pending"].clear()
            # Announced changes: the full character is current within about a second (the batch summary lags ~2 s).
            for cid in announced:
                try:
                    got[cid] = hit_points(await asyncio.to_thread(ddb_get, f"https://character-service.dndbeyond.com/character/v5/character/{cid}", cfg["cobalt"]))
                except Exception as e:
                    log(f"Could not read character {cid}: {e}")
            if time.time() - batch_at >= POLL_SECONDS:
                batch_at = time.time()
                found, queued, missing = await asyncio.to_thread(scds_summaries, ids, cfg["cobalt"])
                for sm in found:
                    ch = summary_to_char(sm)
                    got.setdefault(ch["entityId"], ch)  # a fresh full read of an announced character wins
                # D&D Beyond reports these as not (yet) in its summary store: read them in full instead.
                for cid in queued + missing:
                    if cid in ids and cid not in got:
                        try:
                            got[cid] = hit_points(await asyncio.to_thread(ddb_get, f"https://character-service.dndbeyond.com/character/v5/character/{cid}", cfg["cobalt"]))
                        except Exception as e:
                            log(f"Could not read character {cid}: {e}")
            async with HP_LOCK:
                current = {x["entityId"]: x for x in PARTY["chars"]}
                merged = dict(current)
                for cid, x in got.items():
                    # A DM edit that landed while we were asking is newer than what we got: keep it.
                    if cid in current and PARTY["written"].get(cid, 0) >= asked_at - 1:
                        continue
                    # Keep the fresher full read of an announced character over a lagging batch summary.
                    if cid in current and PARTY["fresh_until"].get(cid, 0) > time.time() and cid not in announced:
                        continue
                    if cid in current:  # a full read carries only HP: keep the other known fields
                        x = {**current[cid], **x} if "ac" not in x else x
                    merged[cid] = x
                for cid in announced:
                    PARTY["fresh_until"][cid] = time.time() + 4
                chars = sorted((merged[c] for c in merged if c in ids or c in got), key=lambda x: x["name"].lower())
                view = lambda cs: json.dumps(cs, sort_keys=True)
                if view(chars) != view(PARTY["chars"]):
                    PARTY["chars"] = chars
                    log(("Party HP (announced change): " if announced else "Party HP: ") +
                        ", ".join(f"{x['name']} {x['hp']}/{x['max']}" + (f"+{x['temp']}" if x["temp"] else "") for x in chars))
                    await send_all({"type": "party", "chars": chars})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"Party HP update failed: {e}")
        try:  # sleep until the next batch read, or until D&D Beyond announces a change
            await asyncio.wait_for(PARTY["wake"].wait(), timeout=max(0.5, POLL_SECONDS - (time.time() - batch_at)))
            PARTY["wake"].clear()
        except asyncio.TimeoutError:
            pass


# ---------------------------------------------------------------- login window (runs as its own process)
def run_login():
    """Opens D&D Beyond's sign-in page in an embedded browser window and waits for the session cookie."""
    import os
    try:
        import webview
    except ImportError:
        return 2
    # Sign-in providers (Google, Apple, Twitch, ...) open a pop-up that must stay linked to the page that
    # opened it. pywebview would send it to the system browser or load it in place (both break the
    # login), so on Windows the request is left unhandled: the Edge engine then opens a proper pop-up.
    try:
        from webview.platforms import edgechromium
        edgechromium.EdgeChrome.on_new_window_request = lambda self, sender, args: None
    except Exception:
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
    found, closed = {}, {"v": False}
    limit = int(os.environ.get("RELAY_LOGIN_TIMEOUT", "900"))  # seconds

    def poll(w):
        for _ in range(limit):
            time.sleep(1)
            if closed["v"]:
                break
            try:
                for jar in w.get_cookies():
                    for name, morsel in jar.items():
                        if name == "CobaltSession" and len(morsel.value) >= 20:
                            found["v"] = morsel.value
            except Exception:
                pass
            if found:
                break
        try:
            w.destroy()
        except Exception:
            pass

    w = webview.create_window("Sign in to D&D Beyond", f"{DDB}/sign-in?returnUrl=%2Fmy-campaigns", width=640, height=780)
    w.events.closed += lambda: closed.__setitem__("v", True)
    # Own browser profile next to the program, so it never collides with another WebView2 user,
    # and the login is remembered for the next time.
    webview.start(poll, w, private_mode=False, storage_path=str(HERE / ".webview"))
    if found:
        LOGIN_RESULT.write_text(found["v"])
    os._exit(0 if found else 1)  # no lingering helper process, whatever threads are left


def login_command():
    return [sys.executable, "--login"] if FROZEN else [sys.executable, str(Path(__file__).resolve()), "--login"]


# ---------------------------------------------------------------- public address (Cloudflare quick tunnel)
# Browsers no longer let an internet page connect to a program on the player's own computer, so the
# relay gets a temporary public https address through a Cloudflare "quick tunnel" (free, no account,
# no domain). The address changes every start; together with a per-run secret it forms the relay
# code the DM pastes into the extension.
TUNNEL = {"url": "", "proc": None}
TOKEN = secrets.token_urlsafe(9).replace("-", "x").replace("_", "y")
CF_NAME = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
CF_PIDFILE = HERE / ".cloudflared.pid"
TUNNEL_RE = re.compile(r"https://([a-z0-9-]+)\.trycloudflare\.com")


def relay_code():
    m = TUNNEL_RE.search(TUNNEL["url"] or "")
    return f"{m.group(1)}/{TOKEN}" if m else ""


def cf_asset():
    import platform
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
    if sys.platform == "win32":
        return f"cloudflared-windows-{arch}.exe"
    if sys.platform == "darwin":
        return f"cloudflared-darwin-{arch}.tgz"
    return f"cloudflared-linux-{arch}"


def find_cloudflared():
    import shutil
    for p in (HERE / CF_NAME, Path(shutil.which("cloudflared") or ""),
              Path(r"C:\Program Files (x86)\cloudflared\cloudflared.exe"), Path(r"C:\Program Files\cloudflared\cloudflared.exe")):
        if str(p) not in ("", ".") and p.is_file():
            return p
    return None


def download_cloudflared():
    """Fetch Cloudflare's official tunnel helper from its GitHub releases and check the published SHA-256."""
    import hashlib, tarfile, io
    api = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
    with urllib.request.urlopen(urllib.request.Request(api, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"}), timeout=30) as r:
        rel = json.loads(r.read().decode())
    name = cf_asset()
    asset = next((a for a in rel.get("assets", []) if a.get("name") == name), None)
    if not asset:
        raise RuntimeError(f"no {name} in cloudflared release {rel.get('tag_name')}")
    with urllib.request.urlopen(urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": UA}), timeout=300) as r:
        data = r.read()
    digest = str(asset.get("digest") or "")
    if digest.startswith("sha256:") and hashlib.sha256(data).hexdigest() != digest.split(":", 1)[1]:
        raise RuntimeError("checksum mismatch, download discarded")
    if name.endswith(".tgz"):
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            member = next(m for m in t.getmembers() if m.name.endswith("cloudflared"))
            data = t.extractfile(member).read()
    target = HERE / CF_NAME
    target.write_bytes(data)
    target.chmod(0o755)
    return target


def kill_stale_tunnel():
    """A relay that was killed hard can leave its tunnel helper running; stop that one (and only that one)."""
    try:
        pid = int(CF_PIDFILE.read_text().strip())
    except Exception:
        return
    try:
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
            if "cloudflared" in out.lower():
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        else:
            import os, signal
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    CF_PIDFILE.unlink(missing_ok=True)


async def run_tunnel(port):
    """Keeps a quick tunnel to the local endpoint open; restarts it (with a new address) if it drops."""
    kill_stale_tunnel()
    exe = find_cloudflared()
    if not exe:
        status("Downloading Cloudflare's tunnel helper (one time, about 40 MB)...")
        try:
            exe = await asyncio.to_thread(download_cloudflared)
            log(f"Tunnel helper saved as {exe.name}")
        except Exception as e:
            msg = f"Could not download the tunnel helper: {e}"
            log(msg); status(msg, False); return
    while True:
        flags = {"creationflags": 0x08000000} if sys.platform == "win32" else {}  # CREATE_NO_WINDOW
        proc = await asyncio.create_subprocess_exec(str(exe), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}",
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, **flags)
        TUNNEL["proc"] = proc
        CF_PIDFILE.write_text(str(proc.pid))
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                m = TUNNEL_RE.search(line.decode(errors="replace"))
                if m and m.group(0) != TUNNEL["url"]:
                    TUNNEL["url"] = m.group(0)
                    log(f"Public address ready: {TUNNEL['url']}")
                    emit("code", relay_code())
            await proc.wait()
        except asyncio.CancelledError:
            stop_tunnel()
            raise
        TUNNEL["url"] = ""
        emit("code", "")
        log("Tunnel closed; opening a new one (the relay code will change)")
        await asyncio.sleep(5)


def stop_tunnel():
    p = TUNNEL.get("proc")
    if p and p.returncode is None:
        try:
            p.terminate()
        except Exception:
            pass
    TUNNEL["proc"] = None
    CF_PIDFILE.unlink(missing_ok=True)


# ---------------------------------------------------------------- roll normalisation
def normalize(m):
    d = m.get("data") or {}
    ctx = d.get("context") or {}
    rolls = []
    for r in d.get("rolls") or []:
        res = r.get("result") or {}
        dn = r.get("diceNotation") or {}
        dice = []
        for s in dn.get("set") or []:
            die_type = s.get("dieType") or "d?"
            if s.get("dice"):
                for die in s["dice"]:
                    dice.append({"d": die_type, "v": die.get("dieValue"), "kept": die.get("isKept", die.get("kept", True))})
            else:
                for _ in range(int(s.get("count") or 0)):
                    dice.append({"d": die_type, "v": None, "kept": True})
        vals = res.get("values") or []
        if dice and all(x["v"] is None for x in dice) and vals:
            for i, x in enumerate(dice):
                if i < len(vals):
                    x["v"] = vals[i]
        notation = r.get("diceNotationStr") or "+".join(f"{s.get('count', 1)}{s.get('dieType', '')}" for s in dn.get("set") or [])
        const = res.get("constant", dn.get("constant"))
        if const:
            notation += f"{const:+d}" if isinstance(const, int) else f"+{const}"
        rolls.append({"type": r.get("rollType"), "kind": r.get("rollKind"), "notation": notation,
                      "total": res.get("total"), "text": res.get("text"), "dice": dice})
    try:
        t = int(m.get("dateTime") or 0)
    except (TypeError, ValueError):
        t = 0
    return {"type": "roll", "id": d.get("rollId") or m.get("id"), "t": t or int(time.time() * 1000), "who": ctx.get("name") or "?",
            "entityId": str(ctx.get("entityId") or m.get("entityId") or ""), "entityType": ctx.get("entityType") or m.get("entityType"),
            "action": d.get("action") or "", "userId": str(m.get("userId") or ""), "rolls": rolls}


def describe(roll):
    parts = []
    for r in roll["rolls"]:
        dice = ",".join(str(x["v"]) for x in r["dice"] if x["v"] is not None)
        parts.append(f"{r['type'] or 'roll'} {r['total']} ({r['notation']}{': ' + dice if dice else ''})")
    return f"{roll['who']} - {roll['action'] or 'roll'}: " + "; ".join(parts)


# ---------------------------------------------------------------- local server (Owlbear panel side)
async def send_all(obj):
    if not CLIENTS:
        return
    msg = json.dumps(obj)
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except Exception:
            CLIENTS.discard(ws)


async def client_handler(ws):
    # Reachable from the internet through the tunnel, so only clients that know this run's secret get in.
    from urllib.parse import urlparse, parse_qs
    try:
        k = (parse_qs(urlparse(ws.request.path).query).get("k") or [""])[0]
    except Exception:
        k = ""
    if not secrets.compare_digest(k, TOKEN):
        await ws.close(code=4001, reason="wrong relay code")
        return
    CLIENTS.add(ws)
    log(f"Owlbear connected ({len(CLIENTS)} tab{'s' if len(CLIENTS) != 1 else ''})")
    try:
        await ws.send(json.dumps({"type": "hello", "version": VERSION, "campaignId": STATE["campaignId"],
                                  "connected": STATE["connected"], "recent": list(RECENT), "party": PARTY["chars"]}))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if isinstance(msg, dict) and msg.get("type") == "hp":
                log(f"HP request from Owlbear: {json.dumps({k: msg.get(k) for k in ('entityId', 'delta', 'temp', 'src', 'reqId')})}")
                result = await change_hp(str(msg.get("entityId") or ""), msg.get("delta"), msg.get("temp"))
                await ws.send(json.dumps({"type": "hp-result", "reqId": msg.get("reqId"), **result}))
    except Exception:
        pass
    finally:
        CLIENTS.discard(ws)
        log(f"Owlbear disconnected ({len(CLIENTS)} tab{'s' if len(CLIENTS) != 1 else ''})")


async def set_status(connected, text, error=""):
    STATE["connected"], STATE["error"] = connected, error
    status(text, connected)
    await send_all({"type": "status", "connected": connected, "error": error, "campaignId": STATE["campaignId"]})


# ---------------------------------------------------------------- D&D Beyond game log client
async def game_log(cfg):
    backoff = [1, 2, 5, 10, 20, 30]
    attempt = 0
    while True:
        await set_status(False, "Connecting to D&D Beyond...")
        try:
            token, ttl, user_id = await asyncio.to_thread(fetch_token, cfg["cobalt"])
        except urllib.error.HTTPError as e:
            msg = f"D&D Beyond no longer accepts the saved session (HTTP {e.code}). Click 'Sign in to D&D Beyond' again."
            log(msg); emit("signin_needed", None); await set_status(False, msg, msg); return
        except Exception as e:
            msg = f"Could not reach D&D Beyond: {e}"
            log(msg); await set_status(False, msg, msg); await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)]); attempt += 1; continue
        STATE["userId"] = user_id
        url = f"{WS_URL}?gameId={cfg['campaignId']}&userId={user_id}&stt={token}"
        lifetime = max(30, ttl - 40)  # reconnect with a fresh token before this one expires
        opened = time.time()
        try:
            async with websockets.connect(url, additional_headers={"Origin": DDB, "User-Agent": UA},
                                          ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024) as ws:
                await set_status(True, f"Connected. Listening to campaign {cfg['campaignId']} - roll something in D&D Beyond.")
                log(f"Connected to campaign {cfg['campaignId']} as user {user_id}")
                attempt = 0
                while True:
                    remaining = lifetime - (time.time() - opened)
                    if remaining <= 0:
                        log("Refreshing session token"); break
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    except asyncio.TimeoutError:
                        continue
                    try:
                        m = json.loads(raw)
                    except Exception:
                        continue  # keepalive / non-json frame
                    if not isinstance(m, dict):
                        continue
                    et = str(m.get("eventType") or "")
                    ent = str(m.get("entityId") or ((m.get("data") or {}).get("context") or {}).get("entityId") or "")
                    if et == CHAR_UPDATE_EVENT:
                        cid = str((m.get("data") or {}).get("characterId") or ent)
                        log(f"D&D Beyond announced a change to character {cid}")
                        character_changed(cid)
                    if et and et != ROLL_EVENT:
                        if et not in EVENT_TYPES_SEEN:
                            EVENT_TYPES_SEEN.add(et)
                            log(f"Game log event type seen: {et} (entity {m.get('entityType')}:{ent}, data keys {sorted((m.get('data') or {}).keys())[:12]})")
                    if et != ROLL_EVENT or not m.get("id"):
                        continue
                    # D&D Beyond can deliver the same roll more than once (different message ids, same rollId).
                    key = (m.get("data") or {}).get("rollId") or m["id"]
                    if key in SEEN:
                        continue
                    SEEN.append(key)
                    if (m.get("data") or {}).get("__b20Override__") is True:
                        continue  # already bridged by Beyond20 on that player's side
                    try:
                        with RAWLOG.open("a", encoding="utf-8") as f:
                            f.write(raw.strip() + "\n")
                    except Exception:
                        pass
                    roll = normalize(m)
                    RECENT.append(roll)
                    log(describe(roll))
                    await send_all(roll)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"Game log connection closed: {e!r}")
            await set_status(False, f"Connection lost, reconnecting... ({e.__class__.__name__})", str(e))
            if time.time() - opened > 15:
                attempt = 0
            await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)])
            attempt += 1


async def relay_main(cfg):
    STATE["campaignId"] = str(cfg["campaignId"])
    STATE["cfg"] = cfg
    port = int(cfg.get("port") or DEFAULT_PORT)
    try:
        server = await websockets.serve(client_handler, "localhost", port)
    except OSError as e:
        status(f"Port {port} is already in use (is another relay running?): {e}", False); return
    async with server:
        log(f"Local endpoint: ws://127.0.0.1:{port}")
        await asyncio.gather(game_log(cfg), party_watch(cfg))


TUNNEL_OFF = bool(__import__("os").environ.get("RELAY_NO_TUNNEL"))  # for local testing only


class Relay:
    """Runs the asyncio relay in a background thread; can be restarted with new settings.
    The tunnel lives for the whole run, so re-connecting to D&D Beyond keeps the same relay code."""
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.task = None
        self.tunnel = None
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def start(self, cfg):
        def _go():
            if self.task and not self.task.done():
                self.task.cancel()
            self.task = self.loop.create_task(relay_main(cfg))
            if not self.tunnel and not TUNNEL_OFF:
                self.tunnel = self.loop.create_task(run_tunnel(int(cfg.get("port") or DEFAULT_PORT)))
        self.loop.call_soon_threadsafe(_go)

    def stop(self):
        def _stop():
            for t in (self.task, self.tunnel):
                if t and not t.done():
                    t.cancel()
            stop_tunnel()
        try:
            self.loop.call_soon_threadsafe(_stop)
            time.sleep(0.5)  # let the tunnel helper terminate before the program exits
        except Exception:
            pass


# ---------------------------------------------------------------- window
def run_gui():
    import tkinter as tk
    from tkinter import ttk, messagebox, simpledialog

    cfg = load_config()
    relay = Relay()

    root = tk.Tk()
    root.title(f"Beyond Relay {VERSION}")
    root.minsize(580, 440)
    frm = ttk.Frame(root, padding=12)
    frm.pack(fill="both", expand=True)
    frm.columnconfigure(1, weight=1)

    ttk.Label(frm, text="Shows your D&D Beyond campaign's rolls in Owlbear. Keep this window open while playing.",
              wraplength=540).grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 10))

    ttk.Label(frm, text="Campaign link").grid(row=1, column=0, sticky="w")
    campaign_var = tk.StringVar(value=f"{DDB}/campaigns/{cfg['campaignId']}" if cfg.get("campaignId") else "")
    ttk.Entry(frm, textvariable=campaign_var).grid(row=1, column=1, columnspan=2, sticky="ew", pady=2)

    ttk.Label(frm, text="D&D Beyond login").grid(row=2, column=0, sticky="w")
    login_var = tk.StringVar(value="Signed in (session saved)" if clean_cookie(cfg.get("cobalt")) else "Not signed in")
    ttk.Label(frm, textvariable=login_var).grid(row=2, column=1, sticky="w")
    btns = ttk.Frame(frm); btns.grid(row=3, column=1, columnspan=2, sticky="w", pady=(6, 0))
    signin_btn = ttk.Button(btns, text="Sign in to D&D Beyond")
    signin_btn.pack(side="left")
    connect_btn = ttk.Button(btns, text="Save & connect")
    connect_btn.pack(side="left", padx=(8, 0))
    paste_btn = ttk.Button(btns, text="Paste cookie instead...")
    paste_btn.pack(side="left", padx=(8, 0))

    ttk.Label(frm, text="Relay code").grid(row=4, column=0, sticky="w", pady=(10, 0))
    code_var = tk.StringVar(value="(starts after connecting)")
    ttk.Entry(frm, textvariable=code_var, state="readonly").grid(row=4, column=1, sticky="ew", pady=(10, 0))
    def copy_code():
        if relay_code():
            root.clipboard_clear(); root.clipboard_append(relay_code())
            code_hint.set("Copied. Paste it in Owlbear: Beyond in Owlbear panel > gear icon > Relay code.")
    ttk.Button(frm, text="Copy", command=copy_code).grid(row=4, column=2, padx=(6, 0), pady=(10, 0))
    code_hint = tk.StringVar(value="Paste this code once per session in Owlbear (Beyond in Owlbear panel > gear icon). It changes every time the relay starts.")
    ttk.Label(frm, textvariable=code_hint, foreground="#777", wraplength=540).grid(row=5, column=0, columnspan=3, sticky="w")

    status_var = tk.StringVar(value="Not connected")
    status_lbl = ttk.Label(frm, textvariable=status_var, wraplength=540)
    status_lbl.grid(row=6, column=0, columnspan=3, sticky="w", pady=(10, 4))

    logbox = tk.Text(frm, height=12, state="disabled", wrap="word")
    logbox.grid(row=7, column=0, columnspan=3, sticky="nsew")
    frm.rowconfigure(7, weight=1)
    ttk.Label(frm, text="Settings stay on this computer (beyond-relay.json next to this program). The public address comes from a free Cloudflare quick tunnel; no account needed.",
              foreground="#777", wraplength=540).grid(row=8, column=0, columnspan=3, sticky="w", pady=(6, 0))

    def connect():
        cid, cookie = parse_campaign(campaign_var.get()), clean_cookie(cfg.get("cobalt"))
        if not cid:
            messagebox.showerror("Campaign link", f"Paste your campaign link, e.g. {DDB}/campaigns/1234567"); return
        if not cookie:
            messagebox.showinfo("Sign in", "Click 'Sign in to D&D Beyond' first."); return
        cfg.update({"campaignId": cid, "port": int(cfg.get("port") or DEFAULT_PORT)})
        save_config(cfg)
        relay.start(cfg)

    def got_cookie(cookie):
        cfg["cobalt"] = cookie
        save_config(cfg)
        login_var.set("Signed in (session saved)")
        if parse_campaign(campaign_var.get()):
            connect()
        else:
            status_var.set("Signed in. Now paste the campaign link and click Save & connect.")

    def sign_in():
        signin_btn.configure(state="disabled")
        status_var.set("A D&D Beyond sign-in window is open. Log in there; this window continues by itself.")
        status_lbl.configure(foreground="#333")
        try:
            LOGIN_RESULT.unlink()
        except FileNotFoundError:
            pass

        def wait():
            try:
                code = subprocess.run(login_command(), timeout=1000).returncode
            except Exception as e:
                code = -1; log(f"Sign-in window failed: {e!r}")
            cookie = ""
            try:
                cookie = clean_cookie(LOGIN_RESULT.read_text()); LOGIN_RESULT.unlink()
            except FileNotFoundError:
                pass
            EVENTS.put(("login_done", (code, cookie)))
        threading.Thread(target=wait, daemon=True).start()

    def paste_cookie():
        v = simpledialog.askstring("Session cookie", COOKIE_HELP + "\n\nCobaltSession value:", show="*", parent=root)
        c = clean_cookie(v)
        if c:
            got_cookie(c)
        elif v is not None:
            messagebox.showerror("Session cookie", "That does not look like the cookie value.")

    signin_btn.configure(command=sign_in)
    connect_btn.configure(command=connect)
    paste_btn.configure(command=paste_cookie)

    def pump():
        try:
            while True:
                kind, payload = EVENTS.get_nowait()
                if kind == "status":
                    text, ok = payload
                    status_var.set(text)
                    status_lbl.configure(foreground="#2a9d4a" if ok else "#c0392b" if ok is False else "#333")
                elif kind == "code":
                    code_var.set(payload or "(opening a public address...)")
                    if payload:
                        root.clipboard_clear(); root.clipboard_append(payload)
                        code_hint.set("New code, already copied. Paste it in Owlbear: Beyond in Owlbear panel > gear icon > Relay code.")
                elif kind == "signin_needed":
                    login_var.set("Session expired - sign in again")
                elif kind == "login_done":
                    code, cookie = payload
                    signin_btn.configure(state="normal")
                    if cookie:
                        got_cookie(cookie)
                    elif code == 2:
                        status_var.set("No embedded browser available on this system. Use 'Paste cookie instead...'.")
                    else:
                        status_var.set("Sign-in window closed without a login. Try again, or use 'Paste cookie instead...'.")
                else:
                    logbox.configure(state="normal")
                    logbox.insert("end", f"[{datetime.now():%H:%M:%S}] {payload}\n")
                    logbox.see("end")
                    logbox.configure(state="disabled")
        except queue.Empty:
            pass
        root.after(200, pump)

    pump()
    if cfg.get("campaignId") and clean_cookie(cfg.get("cobalt")):
        relay.start(cfg)  # settings known from last time: connect right away
    root.protocol("WM_DELETE_WINDOW", lambda: (relay.stop(), root.destroy()))
    root.mainloop()


# ---------------------------------------------------------------- terminal fallback
def run_console():
    cfg = load_config()
    if not cfg.get("campaignId") or not clean_cookie(cfg.get("cobalt")):
        print("=== Beyond Relay setup ===")
        cid = parse_campaign(input("Campaign link: "))
        print(COOKIE_HELP)
        cookie = clean_cookie(input("CobaltSession value: "))
        if not cid or not cookie:
            print("Invalid input."); return 1
        cfg.update({"campaignId": cid, "cobalt": cookie, "port": int(cfg.get("port") or DEFAULT_PORT)})
        save_config(cfg)

    async def both():
        jobs = [relay_main(cfg)]
        if not TUNNEL_OFF:
            jobs.append(run_tunnel(int(cfg.get("port") or DEFAULT_PORT)))
        async def show_code():
            last = ""
            while True:
                await asyncio.sleep(1)
                if relay_code() and relay_code() != last:
                    last = relay_code(); print(f"\n  RELAY CODE (paste in Owlbear): {last}\n", flush=True)
        jobs.append(show_code())
        await asyncio.gather(*jobs)
    try:
        asyncio.run(both())
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        stop_tunnel()
    return 0


if __name__ == "__main__":
    if "--login" in sys.argv:
        sys.exit(run_login())
    if "--console" in sys.argv:
        sys.exit(run_console())
    try:
        run_gui()
    except ImportError:
        print("No window toolkit available (tkinter missing); falling back to the terminal.")
        sys.exit(run_console())
