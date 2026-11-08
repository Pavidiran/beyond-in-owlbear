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

VERSION = "0.3.1"
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
    if sys.stdout and kind == "log":
        try:
            print(f"[{datetime.now():%H:%M:%S}] {payload}", flush=True)
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


# ---------------------------------------------------------------- login window (runs as its own process)
def run_login():
    """Opens D&D Beyond's sign-in page in an embedded browser window and waits for the session cookie."""
    import os
    try:
        import webview
    except ImportError:
        return 2
    # Keep Google/Apple/Twitch sign-in pop-ups inside this window instead of the system browser.
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
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except Exception:
            CLIENTS.discard(ws)


async def client_handler(ws):
    CLIENTS.add(ws)
    log(f"Owlbear connected ({len(CLIENTS)} tab{'s' if len(CLIENTS) != 1 else ''})")
    try:
        await ws.send(json.dumps({"type": "hello", "version": VERSION, "campaignId": STATE["campaignId"],
                                  "connected": STATE["connected"], "recent": list(RECENT)}))
        async for _ in ws:
            pass
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
    port = int(cfg.get("port") or DEFAULT_PORT)
    try:
        server = await websockets.serve(client_handler, "127.0.0.1", port)
    except OSError as e:
        status(f"Port {port} is already in use (is another relay running?): {e}", False); return
    async with server:
        log(f"Local endpoint for the Owlbear extension: ws://127.0.0.1:{port}")
        await game_log(cfg)


class Relay:
    """Runs the asyncio relay in a background thread; can be restarted with new settings."""
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.task = None
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def start(self, cfg):
        def _go():
            if self.task and not self.task.done():
                self.task.cancel()
            self.task = self.loop.create_task(relay_main(cfg))
        self.loop.call_soon_threadsafe(_go)

    def stop(self):
        def _stop():
            if self.task and not self.task.done():
                self.task.cancel()
        self.loop.call_soon_threadsafe(_stop)


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

    status_var = tk.StringVar(value="Not connected")
    status_lbl = ttk.Label(frm, textvariable=status_var, wraplength=540)
    status_lbl.grid(row=4, column=0, columnspan=3, sticky="w", pady=(10, 4))

    logbox = tk.Text(frm, height=12, state="disabled", wrap="word")
    logbox.grid(row=5, column=0, columnspan=3, sticky="nsew")
    frm.rowconfigure(5, weight=1)
    ttk.Label(frm, text=f"Settings stay on this computer (beyond-relay.json next to this program). Local endpoint ws://127.0.0.1:{cfg.get('port') or DEFAULT_PORT}",
              foreground="#777", wraplength=540).grid(row=6, column=0, columnspan=3, sticky="w", pady=(6, 0))

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
    try:
        asyncio.run(relay_main(cfg))
    except KeyboardInterrupt:
        print("\nStopped.")
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
