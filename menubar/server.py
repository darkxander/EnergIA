"""Plugin SwiftBar « streamable » : un seul processus qui sert la page EnergIA
sur 127.0.0.1, relit l'usage de Claude Code chaque minute et envoie le titre
de la barre de menus (l'énergie estimée du jour).

Chaque `~~~` fait reconstruire l'élément par SwiftBar, ce qui vide une page
ouverte. Un titre inchangé n'est donc jamais renvoyé, et un titre modifié
attend que la page cesse d'envoyer ses battements (fenêtre refermée).
"""

import json
import os
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import estimate
from claudecode import UsageStore
from rate import RateStore

PORT = 18791
POLL = 60                 # secondes entre deux lectures des journaux
WIDTH, HEIGHT = 860, 680  # taille de la fenêtre, en pixels
BEAT_TIMEOUT = 4.0        # sans battement pendant ce délai : fenêtre refermée
LABEL = "⚡"
MAX_BODY = 20_000
SITE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), ".."))
STATIC = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8", ".json": "application/json"}


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
                 rates=None):
        self.store = store or UsageStore()
        self.rates = rates or RateStore()
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
        return f"{LABEL} {estimate.format_energy(total)}"

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
        if path == "/api/beat":
            dash.gate.beat()
            return self._json({"ok": True})
        if path.startswith("/api/"):
            return self.send_error(404)
        return self._static(path)

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._allowed(path):
            return self.send_error(403)
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


def emit(title, port=PORT):
    print("~~~", flush=True)
    print(f"{title} | href=http://127.0.0.1:{port}/ webview=true "
          f"webvieww={WIDTH} webviewh={HEIGHT}", flush=True)


def main():
    dash = Dashboard()
    try:
        serve(dash)
    except OSError as e:
        print("~~~", flush=True)
        print(f"{LABEL} ⚠️", flush=True)
        print("---", flush=True)
        print(f"port {PORT} indisponible : {e.strerror}", flush=True)
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
