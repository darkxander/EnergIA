"""Taux de change euro/dollar : taux de référence de la BCE, relevé une fois
par jour. C'est la seule connexion à Internet du plugin ; elle télécharge un
fichier public et n'envoie aucune donnée.

Le téléchargement passe par /usr/bin/curl, qui utilise les certificats du
système (le Python lancé par SwiftBar n'a pas toujours les siens).
"""

import json
import os
import re
import subprocess
import threading
import time

URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
CACHE = os.path.expanduser("~/Library/Caches/EnergIA/rate.json")
MAX_AGE = 12 * 3600  # un relevé plus récent n'est pas refait
RETRY = 3600         # délai avant de retenter après un échec

_DATE = re.compile(r"time=['\"](\d{4}-\d{2}-\d{2})['\"]")
_USD = re.compile(r"currency=['\"]USD['\"]\s+rate=['\"](\d+(?:\.\d+)?)['\"]")


def parse(xml):
    """{"date", "eurPerUsd"} à partir du fichier de la BCE (dollars pour 1 euro)."""
    date, usd = _DATE.search(xml), _USD.search(xml)
    if not date or not usd:
        raise ValueError("taux introuvable dans la réponse de la BCE")
    usd_per_eur = float(usd.group(1))
    if not 0.5 < usd_per_eur < 2:
        raise ValueError(f"taux invraisemblable : {usd_per_eur}")
    return {"date": date.group(1), "eurPerUsd": round(1 / usd_per_eur, 4)}


def download(url=URL):
    done = subprocess.run(["/usr/bin/curl", "-sS", "--fail", "--max-time", "20", "--proto", "=https", url],
                          capture_output=True, text=True, timeout=30, check=True)
    return done.stdout


class RateStore:
    def __init__(self, cache=CACHE, fetch=download, clock=time.time):
        self.cache, self.fetch, self.clock = cache, fetch, clock
        self._lock = threading.Lock()
        self._rate = None       # {"date", "eurPerUsd", "fetched_at"}
        self._tried_at = None
        try:
            with open(cache, encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved["eurPerUsd"], float) and isinstance(saved["fetched_at"], (int, float)):
                self._rate = {"date": str(saved["date"]), "eurPerUsd": saved["eurPerUsd"],
                              "fetched_at": saved["fetched_at"]}
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def current(self):
        """Le dernier taux relevé ({"date", "eurPerUsd"}), ou None."""
        with self._lock:
            return {"date": self._rate["date"], "eurPerUsd": self._rate["eurPerUsd"]} if self._rate else None

    def refresh(self):
        """Relève le taux s'il date. Un échec garde le dernier taux connu."""
        with self._lock:
            now = self.clock()
            if self._rate and now - self._rate["fetched_at"] < MAX_AGE:
                return
            if self._tried_at is not None and now - self._tried_at < RETRY:
                return
            self._tried_at = now
        try:  # hors verrou : le téléchargement ne doit pas bloquer la page
            rate = dict(parse(self.fetch()), fetched_at=now)
        except Exception:
            return
        with self._lock:
            self._rate = rate
        try:
            os.makedirs(os.path.dirname(self.cache), exist_ok=True)
            with open(self.cache, "w", encoding="utf-8") as f:
                json.dump(rate, f)
        except OSError:
            pass  # le taux reste en mémoire
