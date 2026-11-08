#!/usr/bin/env python3
"""Beyond Relay - forwards your D&D Beyond campaign's dice rolls to the "Beyond in Owlbear" extension.

Only the DM runs this. It listens to the campaign's game log (the same feed the D&D Beyond website
uses) with the DM's own session cookie and hands every roll to the Owlbear tab on this computer
through a local connection (ws://127.0.0.1:8790). Players install nothing.

First run asks for the campaign link and the session cookie and saves them next to this program in
beyond-relay.json. Delete that file to start over.

Unofficial D&D Beyond endpoints: may break when they change things. Nothing is sent anywhere except
to dndbeyond.com and to your own browser.
"""
import asyncio
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime
from pathlib import Path

try:
    import websockets
except ImportError:  # pragma: no cover
    print("Missing dependency: run  pip install websockets")
    sys.exit(1)

for _s in (sys.stdout, sys.stderr):  # Windows consoles default to a legacy code page
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

VERSION = "0.1.0"
AUTH_URL = "https://auth-service.dndbeyond.com/v1/cobalt-token"
WS_URL = "wss://game-log-api-live.dndbeyond.com/v1"
NAMEID_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
ROLL_EVENT = "dice/roll/fulfilled"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
FROZEN = getattr(sys, "frozen", False)
HERE = Path(sys.executable).parent if FROZEN else Path(__file__).parent
CONFIG = HERE / "beyond-relay.json"
RAWLOG = HERE / "relay-raw.jsonl"  # last raw roll messages, for debugging the format

RECENT = deque(maxlen=30)      # normalized rolls, replayed to a panel when it connects
SEEN = deque(maxlen=2000)      # message ids, to drop replays after a reconnect
CLIENTS = set()                # connected Owlbear panels
STATE = {"connected": False, "campaignId": "", "userId": "", "error": ""}


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- config / first run
def ask(prompt):
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def first_run():
    print()
    print("=== Beyond Relay - first-time setup ===")
    print("1) Your D&D Beyond campaign link, e.g. https://www.dndbeyond.com/campaigns/1234567")
    link = ask("   Campaign link: ")
    m = re.search(r"campaigns/(\d+)", link) or re.fullmatch(r"\s*(\d+)\s*", link)
    if not m:
        print("   That is not a campaign link. Run again."); return None
    print()
    print("2) Your D&D Beyond session cookie (never share it; it stays in beyond-relay.json on this PC).")
    print("   Firefox: open dndbeyond.com, press F12 > Storage > Cookies > https://www.dndbeyond.com > CobaltSession > copy Value")
    print("   Chrome/Edge: open dndbeyond.com, press F12 > Application > Cookies > https://www.dndbeyond.com > CobaltSession > copy Value")
    cookie = ask("   CobaltSession value: ")
    cookie = re.sub(r"^CobaltSession=", "", cookie).strip().strip(";").strip()
    if len(cookie) < 20:
        print("   That does not look like the cookie value. Run again."); return None
    cfg = {"campaignId": m.group(1), "cobalt": cookie, "port": 8790}
    CONFIG.write_text(json.dumps(cfg, indent=2))
    print(f"\nSaved to {CONFIG}\n")
    return cfg


def ask_cookie():
    print("Your D&D Beyond session cookie (never share it; it stays in beyond-relay.json on this PC).")
    print("   Firefox: open dndbeyond.com, press F12 > Storage > Cookies > https://www.dndbeyond.com > CobaltSession > copy Value")
    print("   Chrome/Edge: open dndbeyond.com, press F12 > Application > Cookies > https://www.dndbeyond.com > CobaltSession > copy Value")
    cookie = ask("   CobaltSession value: ")
    cookie = re.sub(r"^CobaltSession=", "", cookie).strip().strip(";").strip()
    return cookie if len(cookie) >= 20 else ""


def load_config():
    if not CONFIG.exists():
        return first_run()
    try:
        cfg = json.loads(CONFIG.read_text())
    except Exception as e:
        print(f"Cannot read {CONFIG}: {e}. Delete it and run again."); return None
    if not re.fullmatch(r"\d+", str(cfg.get("campaignId") or "")):
        print(f"{CONFIG.name} has no campaignId. Delete it and run again."); return None
    if not cfg.get("cobalt") or "PASTE" in str(cfg.get("cobalt")):
        print(f"\n=== Beyond Relay - campaign {cfg['campaignId']} needs your session cookie ===")
        cookie = ask_cookie()
        if not cookie:
            print("   That does not look like the cookie value. Run again."); return None
        cfg["cobalt"] = cookie
        CONFIG.write_text(json.dumps(cfg, indent=2))
        print(f"Saved to {CONFIG}\n")
    return cfg


# ---------------------------------------------------------------- D&D Beyond auth
def fetch_token(cobalt):
    req = urllib.request.Request(AUTH_URL, data=b"{}", method="POST", headers={
        "Cookie": f"CobaltSession={cobalt}", "Content-Type": "application/json", "User-Agent": UA,
        "Accept": "application/json", "Origin": "https://www.dndbeyond.com", "Referer": "https://www.dndbeyond.com/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read().decode())
    token, ttl = body.get("token"), int(body.get("ttl") or 300)
    if not token:
        raise RuntimeError(f"no token in response: {body}")
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload).decode())
    user_id = str(claims.get(NAMEID_CLAIM) or "")
    return token, ttl, user_id


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
    return {"type": "roll", "id": m.get("id"), "t": t or int(time.time() * 1000), "who": ctx.get("name") or "?",
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
    dead = []
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)


async def client_handler(ws):
    CLIENTS.add(ws)
    log(f"Owlbear panel connected ({len(CLIENTS)} total)")
    try:
        await ws.send(json.dumps({"type": "hello", "version": VERSION, "campaignId": STATE["campaignId"],
                                  "connected": STATE["connected"], "recent": list(RECENT)}))
        async for _ in ws:  # the panel does not need to send anything; keep the socket open
            pass
    except Exception:
        pass
    finally:
        CLIENTS.discard(ws)
        log(f"Owlbear panel disconnected ({len(CLIENTS)} total)")


async def set_status(connected, error=""):
    STATE["connected"], STATE["error"] = connected, error
    await send_all({"type": "status", "connected": connected, "error": error, "campaignId": STATE["campaignId"]})


# ---------------------------------------------------------------- D&D Beyond game log client
async def game_log(cfg):
    backoff = [1, 2, 5, 10, 20, 30]
    attempt = 0
    while True:
        try:
            token, ttl, user_id = await asyncio.to_thread(fetch_token, cfg["cobalt"])
        except urllib.error.HTTPError as e:
            msg = f"D&D Beyond rejected the session cookie (HTTP {e.code}). It has probably expired: delete {CONFIG.name} and run again to paste a fresh one."
            log(msg); await set_status(False, msg); await asyncio.sleep(60); continue
        except Exception as e:
            msg = f"Could not reach D&D Beyond: {e}"
            log(msg); await set_status(False, msg); await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)]); attempt += 1; continue
        if not user_id:
            log("Token has no user id; continuing anyway")
        STATE["userId"] = user_id
        url = f"{WS_URL}?gameId={cfg['campaignId']}&userId={user_id}&stt={token}"
        lifetime = max(30, ttl - 40)  # reconnect with a fresh token before this one expires
        opened = time.time()
        try:
            async with websockets.connect(url, additional_headers={"Origin": "https://www.dndbeyond.com", "User-Agent": UA},
                                          ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024) as ws:
                log(f"Listening to campaign {cfg['campaignId']} as user {user_id}. Roll something in D&D Beyond...")
                await set_status(True)
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
                    if not isinstance(m, dict) or m.get("eventType") != ROLL_EVENT or not m.get("id"):
                        continue
                    if m["id"] in SEEN:
                        continue
                    SEEN.append(m["id"])
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
        except Exception as e:
            log(f"Game log connection closed: {e!r}")
            await set_status(False, str(e))
            if time.time() - opened > 15:
                attempt = 0
            await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)])
            attempt += 1


async def main_async(cfg):
    STATE["campaignId"] = str(cfg["campaignId"])
    port = int(cfg.get("port") or 8790)
    async with websockets.serve(client_handler, "127.0.0.1", port):
        log(f"Beyond Relay v{VERSION} - local endpoint ws://127.0.0.1:{port} (keep this window open during the session)")
        await game_log(cfg)


def main():
    cfg = load_config()
    if not cfg:
        return 1
    try:
        asyncio.run(main_async(cfg))
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    code = 0
    try:
        code = main()
    except Exception as e:  # keep the console window readable when double-clicked
        print(f"\nError: {e!r}")
        code = 1
    if FROZEN and code:
        ask("\nPress Enter to close.")
    sys.exit(code)
