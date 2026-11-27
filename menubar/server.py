"""SwiftBar "streamable" plugin: a single process that serves the EnergIA page
on 127.0.0.1, rereads the Claude Code usage every minute and sends the menu
bar title (the day's estimated energy).

Each `~~~` makes SwiftBar rebuild the item, which empties an open page. An
unchanged title is therefore never sent again, and a changed title waits
until the page stops sending its heartbeats (window closed).

With --serve, the same server runs without SwiftBar, on any system: it
opens the dashboard in the default browser.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

import estimate
from claudecode import UsageStore
from rate import RateStore

PORT = 18791
POLL = 60                 # seconds between two readings of the logs
WIDTH, HEIGHT = 860, 680  # size of the window, in pixels
TRAY_REFRESH = 2.0        # seconds between two updates of the Windows notification-area icon
BEAT_TIMEOUT = 4.0        # no heartbeat for this long: window closed
LABEL = "⚡"
OVER_COLOR = "#ff453a"  # compact title above the threshold: red text, for lack of room for an icon
OVER_LABEL = "🔴"  # replaces the lightning bolt when a threshold chosen in the page is exceeded
MAX_BODY = 20_000
MAX_EXPORT = 50_000_000  # a CSV export of several years stays well below
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")
SITE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), ".."))
# The only links the page can have opened in the default browser.
LINKS = {"sponsor": "https://github.com/sponsors/darkxander",
         "source": "https://github.com/darkxander/EnergIA",
         "method": "https://github.com/darkxander/EnergIA/blob/main/METHOD.md",
         "method-fr": "https://github.com/darkxander/EnergIA/blob/main/METHOD.fr.md"}
STATIC = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8", ".json": "application/json"}


PICK_PROMPT = {"fr": "Choisissez votre export ChatGPT, Claude, Gemini ou Copilot (.zip, .json ou .csv)",
               "en": "Choose your ChatGPT, Claude, Gemini or Copilot export (.zip, .json or .csv)"}
PORT_ERROR = {"fr": "port {port} indisponible : {reason}", "en": "port {port} unavailable: {reason}"}
SERVING = {"fr": "EnergIA : tableau de bord sur {url} (Ctrl+C pour arrêter)",
           "en": "EnergIA: dashboard at {url} (Ctrl+C to stop)"}
PORT_HINT = {"fr": "EnergIA tourne peut-être déjà (barre de menus ou autre fenêtre). Essayez --port avec un autre numéro.",
             "en": "EnergIA may already be running (menu bar or another window). Try --port with another number."}
PICK_TYPES = '{"public.zip-archive", "public.json", "public.comma-separated-values-text", "zip", "json", "csv"}'
PICK_EXTENSIONS = (".zip", ".json", ".csv")


def pick_file(lang="fr"):
    """Opens the macOS file picker and returns the chosen path, or None if
    the user cancels. The menu bar window cannot open this picker itself."""
    done = subprocess.run(
        ["/usr/bin/osascript", "-e", "tell me to activate",
         "-e", f'POSIX path of (choose file with prompt "{PICK_PROMPT[lang]}" of type {PICK_TYPES})'],
        capture_output=True, text=True, timeout=900, check=False)
    return done.stdout.strip() or None


def reveal(path):
    """Shows the file in the Finder."""
    subprocess.run(["/usr/bin/open", "-R", path], check=False, timeout=10)


def open_in_browser(url):
    subprocess.run(["/usr/bin/open", url], check=False, timeout=10)


class TitleGate:
    def __init__(self, beat_timeout=BEAT_TIMEOUT, clock=time.monotonic):
        self._clock, self._timeout = clock, beat_timeout
        self._lock = threading.Lock()
        self._last_beat = None
        self._shown = self._wanted = None

    def beat(self):
        with self._lock:
            self._last_beat = self._clock()

    def offer(self, title):
        with self._lock:
            self._wanted = title

    def take(self):
        """The title to send now, or None."""
        with self._lock:
            is_open = self._last_beat is not None and self._clock() - self._last_beat < self._timeout
            if self._wanted is None or self._wanted == self._shown or is_open:
                return None
            self._shown = self._wanted
            return self._shown


class Dashboard:
    def __init__(self, store=None, settings_path=estimate.SETTINGS, today=lambda: date.today().isoformat(),
                 rates=None, opener=open_in_browser, picker=pick_file, window=True,
                 downloads=DOWNLOADS, revealer=reveal):
        self.store = store or UsageStore()
        # True: page displayed in the SwiftBar window, which can neither open a
        # file picker nor follow an external link. False: real browser.
        self.window = window
        self.rates = rates or RateStore()
        self.opener = opener
        self.picker = picker
        self.downloads, self.revealer = downloads, revealer
        self.settings_path, self.today = settings_path, today
        self.gate = TitleGate()
        self._lock = threading.Lock()
        self._updated_at = self._error = None
        self.gate.offer(f"{LABEL} …")

    def poll(self):
        try:
            self.store.scan()
            with self._lock:
                self._updated_at, self._error = time.time(), None
        except Exception as e:  # the plugin must survive a failed read
            with self._lock:
                self._error = str(e) or type(e).__name__
        self.gate.offer(self.title())
        self.rates.refresh()  # never raises; only fetches the rate if it is out of date

    def poller(self):
        while True:
            self.poll()
            time.sleep(POLL)

    def title(self):
        with self._lock:
            if self._error:
                return f"{LABEL} ⚠️"
            if self._updated_at is None:
                return f"{LABEL} …"
        settings = estimate.load_settings(self.settings_path)
        today = self.today()
        rows = self.store.rows()
        total = sum(estimate.wh(row, settings) for row in rows if row["day"] == today)
        label = OVER_LABEL if estimate.over_budget(rows, settings, today) else LABEL
        lang = estimate.lang_of(settings)
        if settings.get("compactTitle"):
            # Chosen in the page: neither icon nor spaces, fewer digits. Above the
            # threshold, the text turns red (SwiftBar parameter placed after the tab).
            text = estimate.format_energy(total, lang, compact=True)
            return f"{text}\tcolor={OVER_COLOR}" if label == OVER_LABEL else text
        return f"{label} {estimate.format_energy(total, lang)}"

    def today_status(self):
        """For the Windows notification-area icon: the day's energy as text ("…" until
        the first reading, "⚠️" after a failed one) and whether a threshold is exceeded."""
        with self._lock:
            if self._error:
                return "⚠️", False
            if self._updated_at is None:
                return "…", False
        settings = estimate.load_settings(self.settings_path)
        today = self.today()
        rows = self.store.rows()
        total = sum(estimate.wh(row, settings) for row in rows if row["day"] == today)
        return estimate.format_energy(total, estimate.lang_of(settings)), estimate.over_budget(rows, settings, today)

    def pick(self):
        """The file chosen in the macOS picker, displayed in the page's language."""
        return self.picker(estimate.lang_of(estimate.load_settings(self.settings_path)))

    def export(self, data, extension="csv"):
        """Writes an export of the page (CSV or image) to the Downloads folder, without
        ever replacing an existing file, and shows it. The name is chosen here, not by the page."""
        os.makedirs(self.downloads, exist_ok=True)
        for n in range(1, 1000):
            name = f"EnergIA-{self.today()}{'' if n == 1 else f'-{n}'}.{extension}"
            path = os.path.join(self.downloads, name)
            try:
                with open(path, "xb") as f:
                    f.write(data)
            except FileExistsError:
                continue
            self.revealer(path)
            return path
        raise OSError("trop de fichiers du même nom")

    def payload(self):
        with self._lock:
            return {"ok": self._error is None, "error": self._error, "updated_at": self._updated_at,
                    "ready": self._updated_at is not None, "rows": self.store.rows(),
                    "rate": self.rates.current()}

    def save_settings(self, saved):
        estimate.save_settings(saved, self.settings_path)
        self.gate.offer(self.title())


class Handler(BaseHTTPRequestHandler):
    """The page and its files at the root, JSON under /api/. Protection
    against other local pages: the Host header must be our address (no DNS
    rebinding) and calls to the API must carry X-EnergIA, which a page from
    another origin cannot add without a CORS preflight request that this
    server never answers."""

    def log_message(self, *args):
        pass  # standard output belongs to SwiftBar

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(200, json.dumps(obj).encode(), "application/json")

    def _allowed(self, path):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_address[1]}":
            return False
        return not path.startswith("/api/") or self.headers.get("X-EnergIA") == "1"

    def _static(self, path):
        relative = "index.html" if path == "/" else path.lstrip("/")
        if relative not in ("index.html", "styles.css") and not relative.startswith("src/"):
            return self.send_error(404)
        full = os.path.realpath(os.path.join(SITE, relative))
        ctype = STATIC.get(os.path.splitext(full)[1])
        if not full.startswith(SITE + os.sep) or not ctype or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, "rb") as f:  # read again on each request: edit the page, reopen
            return self._send(200, f.read(), ctype)

    def do_GET(self):
        path = urlsplit(self.path).path
        if not self._allowed(path):
            return self.send_error(403)
        dash = self.server.dash
        if path == "/api/claudecode":
            return self._json(dash.payload())
        if path == "/api/open":
            url = LINKS.get(parse_qs(urlsplit(self.path).query).get("link", [""])[0])
            if not url:
                return self.send_error(404)
            dash.opener(url)
            return self._json({"ok": True})
        if path == "/api/beat":
            dash.gate.beat()
            # The compact title is a setting of the plugin: the page takes it from here, so
            # that another browser does not erase it with its own settings.
            compact = 1 if estimate.load_settings(dash.settings_path).get("compactTitle") else 0
            return self._json({"ok": True, "window": dash.window, "compactTitle": compact})
        if path.startswith("/api/"):
            return self.send_error(404)
        return self._static(path)

    def _pick(self):
        """Sends the page the file that the user chooses in the macOS
        picker: the user alone decides which file is read."""
        try:
            chosen = self.server.dash.pick()
        except Exception:
            return self.send_error(500)
        if not chosen:  # cancelled
            self.send_response(204)
            self.end_headers()
            return None
        if not chosen.lower().endswith(PICK_EXTENSIONS) or not os.path.isfile(chosen):
            return self.send_error(400)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(chosen)))
        self.send_header("X-Filename", quote(os.path.basename(chosen)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(chosen, "rb") as f:
            shutil.copyfileobj(f, self.wfile)
        return None

    def _export(self):
        """Saves the CSV or the PNG image sent by the page. Only in the SwiftBar
        window, which cannot download; a real browser downloads by itself."""
        dash = self.server.dash
        if not dash.window:
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", ""))
            if not 0 < length <= MAX_EXPORT:
                raise ValueError
            data = self.rfile.read(length)
            kind = self.headers.get("Content-Type", "").split(";")[0].strip()
            if kind == "image/png":
                extension = "png"
                if not data.startswith(PNG_SIGNATURE):
                    raise ValueError
            elif kind == "text/html":  # the monthly report
                extension = "html"
                data.decode("utf-8")
            elif kind == "application/json":  # the team file
                extension = "json"
                json.loads(data)
            else:
                extension = "csv"
                data.decode("utf-8")  # text, nothing else
        except ValueError:
            return self.send_error(400)
        try:
            path = dash.export(data, extension)
        except OSError:
            return self.send_error(500)
        return self._json({"ok": True, "path": path})

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._allowed(path):
            return self.send_error(403)
        if path == "/api/pick":
            return self._pick()
        if path == "/api/export":
            return self._export()
        if path != "/api/settings":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", ""))
            if not 0 < length <= MAX_BODY:
                raise ValueError
            saved = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_error(400)
        self.server.dash.save_settings(saved)
        return self._json({"ok": True})


def serve(dash, port=PORT):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.dash = dash
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def emit(title, port=PORT, out=None):
    """Sends the title to SwiftBar. A title can carry, after a tab, additional
    SwiftBar parameters (the colour of the text)."""
    text, _, extra = title.partition("\t")
    print("~~~", file=out, flush=True)
    print(f"{text} | href=http://127.0.0.1:{port}/ webview=true "
          f"webvieww={WIDTH} webviewh={HEIGHT}{' ' + extra if extra else ''}", file=out, flush=True)


def windows_tray(lang, on_open):
    """The notification-area icon, on Windows only; None elsewhere."""
    if sys.platform != "win32":
        return None
    import tray
    return tray.Tray(lang, on_open)


def serve_only(port=PORT, browser=True, out=None, wait=None, tray=windows_tray):
    """The "server only" mode: no menu bar, the dashboard opens in the default
    browser. On Windows, an icon in the notification area shows the day's energy.
    Returns the program's exit code."""
    out = out or sys.stdout
    if hasattr(out, "reconfigure"):
        out.reconfigure(errors="replace")  # Windows consoles without UTF-8
    lang = estimate.lang_of(estimate.load_settings())
    dash = Dashboard(window=False)
    try:
        server = serve(dash, port)
    except OSError as e:
        print(PORT_ERROR[lang].format(port=port, reason=e.strerror), file=out, flush=True)
        print(PORT_HINT[lang], file=out, flush=True)
        return 1
    threading.Thread(target=dash.poller, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(SERVING[lang].format(url=url), file=out, flush=True)
    if browser:
        webbrowser.open(url)
    icon = tray(lang, lambda: webbrowser.open(url)) if tray else None
    if icon and not icon.start():
        import tray as tray_texts
        print(tray_texts.TEXTS[lang]["failed"].format(reason=icon.error), file=out, flush=True)
        icon = None
    try:
        if icon:
            # The icon follows the readings; "Quit" in its menu ends the program.
            while not icon.closed.wait(TRAY_REFRESH):
                icon.update(*dash.today_status())
        else:
            (wait or (lambda: threading.Event().wait()))()
    except KeyboardInterrupt:
        if icon:
            icon.close()
            icon.closed.wait(2)
    server.shutdown()
    server.server_close()
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog="EnergIA.py", description="EnergIA")
    parser.add_argument("--serve", action="store_true",
                        help="serveur seul, sans barre de menus (Windows, Linux, macOS) / server only, no menu bar")
    parser.add_argument("--port", type=int, default=PORT, help=f"port local / local port ({PORT})")
    parser.add_argument("--no-browser", action="store_true",
                        help="ne pas ouvrir le navigateur / do not open the browser")
    parser.add_argument("--no-tray", action="store_true",
                        help="Windows : sans icône dans la zone de notification / Windows: no notification-area icon")
    return parser.parse_known_args(argv)[0]  # SwiftBar can add its own arguments


def main(argv=None):
    args = parse_args(argv)
    if args.serve:
        sys.exit(serve_only(args.port, browser=not args.no_browser, tray=None if args.no_tray else windows_tray))
    dash = Dashboard()
    try:
        serve(dash)
    except OSError as e:
        print("~~~", flush=True)
        print(f"{LABEL} ⚠️", flush=True)
        print("---", flush=True)
        lang = estimate.lang_of(estimate.load_settings())
        print(PORT_ERROR[lang].format(port=PORT, reason=e.strerror), flush=True)
        while True:
            time.sleep(3600)
    threading.Thread(target=dash.poller, daemon=True).start()
    while True:
        title = dash.gate.take()
        if title:
            emit(title)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
