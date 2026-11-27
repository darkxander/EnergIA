"""Plugin SwiftBar « streamable » : un seul processus qui sert la page EnergIA
sur 127.0.0.1, relit l'usage de Claude Code chaque minute et envoie le titre
de la barre de menus (l'énergie estimée du jour).

Chaque `~~~` fait reconstruire l'élément par SwiftBar, ce qui vide une page
ouverte. Un titre inchangé n'est donc jamais renvoyé, et un titre modifié
attend que la page cesse d'envoyer ses battements (fenêtre refermée).

Avec --serve, le même serveur tourne sans SwiftBar, sur n'importe quel
système : il ouvre le tableau de bord dans le navigateur par défaut.
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
POLL = 60                 # secondes entre deux lectures des journaux
WIDTH, HEIGHT = 860, 680  # taille de la fenêtre, en pixels
BEAT_TIMEOUT = 4.0        # sans battement pendant ce délai : fenêtre refermée
LABEL = "⚡"
COMPACT_SIZE = 11  # taille du texte du titre compact, en points (13 d'ordinaire)
OVER_LABEL = "🔴"  # remplace l'éclair quand l'énergie du jour dépasse le seuil choisi dans la page
MAX_BODY = 20_000
SITE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), ".."))
# Seuls liens que la page peut faire ouvrir dans le navigateur par défaut.
LINKS = {"sponsor": "https://github.com/sponsors/darkxander",
         "source": "https://github.com/darkxander/EnergIA"}
STATIC = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8", ".json": "application/json"}


PICK_PROMPT = {"fr": "Choisissez votre export ChatGPT ou Claude (.zip ou conversations.json)",
               "en": "Choose your ChatGPT or Claude export (.zip or conversations.json)"}
PORT_ERROR = {"fr": "port {port} indisponible : {reason}", "en": "port {port} unavailable: {reason}"}
SERVING = {"fr": "EnergIA : tableau de bord sur {url} (Ctrl+C pour arrêter)",
           "en": "EnergIA: dashboard at {url} (Ctrl+C to stop)"}
PORT_HINT = {"fr": "EnergIA tourne peut-être déjà (barre de menus ou autre fenêtre). Essayez --port avec un autre numéro.",
             "en": "EnergIA may already be running (menu bar or another window). Try --port with another number."}
PICK_TYPES = '{"public.zip-archive", "public.json", "zip", "json"}'
PICK_EXTENSIONS = (".zip", ".json")


def pick_file(lang="fr"):
    """Ouvre le sélecteur de fichier de macOS et renvoie le chemin choisi, ou
    None si l'utilisateur annule. La fenêtre de la barre de menus ne sait pas
    ouvrir ce sélecteur elle-même."""
    done = subprocess.run(
        ["/usr/bin/osascript", "-e", "tell me to activate",
         "-e", f'POSIX path of (choose file with prompt "{PICK_PROMPT[lang]}" of type {PICK_TYPES})'],
        capture_output=True, text=True, timeout=900, check=False)
    return done.stdout.strip() or None


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
        """Le titre à envoyer maintenant, ou None."""
        with self._lock:
            is_open = self._last_beat is not None and self._clock() - self._last_beat < self._timeout
            if self._wanted is None or self._wanted == self._shown or is_open:
                return None
            self._shown = self._wanted
            return self._shown


class Dashboard:
    def __init__(self, store=None, settings_path=estimate.SETTINGS, today=lambda: date.today().isoformat(),
                 rates=None, opener=open_in_browser, picker=pick_file, window=True):
        self.store = store or UsageStore()
        # True : page affichée dans la fenêtre de SwiftBar, qui ne sait ni ouvrir un
        # sélecteur de fichier ni suivre un lien externe. False : vrai navigateur.
        self.window = window
        self.rates = rates or RateStore()
        self.opener = opener
        self.picker = picker
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
        except Exception as e:  # le plugin doit survivre à une lecture ratée
            with self._lock:
                self._error = str(e) or type(e).__name__
        self.gate.offer(self.title())
        self.rates.refresh()  # ne lève jamais ; ne relève le taux que s'il date

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
        total = sum(estimate.wh(row, settings) for row in self.store.rows() if row["day"] == today)
        budget = settings.get("dailyBudgetWh", 0)
        label = OVER_LABEL if budget > 0 and total > budget else LABEL
        lang = estimate.lang_of(settings)
        if settings.get("compactTitle"):  # choisi dans la page : sans espaces, moins de chiffres
            return f"{label}{estimate.format_energy(total, lang, compact=True)}"
        return f"{label} {estimate.format_energy(total, lang)}"

    def compact(self):
        return bool(estimate.load_settings(self.settings_path).get("compactTitle"))

    def pick(self):
        """Le fichier choisi dans le sélecteur de macOS, affiché dans la langue de la page."""
        return self.picker(estimate.lang_of(estimate.load_settings(self.settings_path)))

    def payload(self):
        with self._lock:
            return {"ok": self._error is None, "error": self._error, "updated_at": self._updated_at,
                    "ready": self._updated_at is not None, "rows": self.store.rows(),
                    "rate": self.rates.current()}

    def save_settings(self, saved):
        estimate.save_settings(saved, self.settings_path)
        self.gate.offer(self.title())


class Handler(BaseHTTPRequestHandler):
    """La page et ses fichiers à la racine, du JSON sous /api/. Protection
    contre les autres pages locales : l'en-tête Host doit être notre adresse
    (pas de DNS rebinding) et les appels à l'API doivent porter X-EnergIA,
    qu'une page d'une autre origine ne peut pas ajouter sans une pré-requête
    CORS à laquelle ce serveur ne répond jamais."""

    def log_message(self, *args):
        pass  # la sortie standard appartient à SwiftBar

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
        with open(full, "rb") as f:  # relu à chaque requête : on modifie la page, on rouvre
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
            # Le titre compact est un réglage du plugin : la page le reprend d'ici, pour
            # qu'un autre navigateur ne l'efface pas avec ses propres réglages.
            compact = 1 if estimate.load_settings(dash.settings_path).get("compactTitle") else 0
            return self._json({"ok": True, "window": dash.window, "compactTitle": compact})
        if path.startswith("/api/"):
            return self.send_error(404)
        return self._static(path)

    def _pick(self):
        """Envoie à la page le fichier que l'utilisateur choisit dans le
        sélecteur de macOS : lui seul décide quel fichier est lu."""
        try:
            chosen = self.server.dash.pick()
        except Exception:
            return self.send_error(500)
        if not chosen:  # annulé
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

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._allowed(path):
            return self.send_error(403)
        if path == "/api/pick":
            return self._pick()
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


def emit(title, port=PORT, compact=False, out=None):
    size = f" size={COMPACT_SIZE}" if compact else ""  # titre compact : texte un peu plus petit
    print("~~~", file=out, flush=True)
    print(f"{title} | href=http://127.0.0.1:{port}/ webview=true "
          f"webvieww={WIDTH} webviewh={HEIGHT}{size}", file=out, flush=True)


def serve_only(port=PORT, browser=True, out=None, wait=None):
    """Mode « serveur seul » : pas de barre de menus, le tableau de bord s'ouvre
    dans le navigateur par défaut. Renvoie le code de sortie du programme."""
    out = out or sys.stdout
    if hasattr(out, "reconfigure"):
        out.reconfigure(errors="replace")  # consoles Windows sans UTF-8
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
    try:
        (wait or (lambda: threading.Event().wait()))()
    except KeyboardInterrupt:
        pass
    server.shutdown()
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog="EnergIA.py", description="EnergIA")
    parser.add_argument("--serve", action="store_true",
                        help="serveur seul, sans barre de menus (Windows, Linux, macOS) / server only, no menu bar")
    parser.add_argument("--port", type=int, default=PORT, help=f"port local / local port ({PORT})")
    parser.add_argument("--no-browser", action="store_true",
                        help="ne pas ouvrir le navigateur / do not open the browser")
    return parser.parse_known_args(argv)[0]  # SwiftBar peut ajouter ses propres arguments


def main(argv=None):
    args = parse_args(argv)
    if args.serve:
        sys.exit(serve_only(args.port, browser=not args.no_browser))
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
            emit(title, compact=dash.compact())
        time.sleep(0.5)


if __name__ == "__main__":
    main()
