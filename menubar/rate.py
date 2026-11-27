"""Euro/dollar exchange rate: the ECB reference rate, fetched once a day.
It is the plugin's only connection to the Internet; it downloads a public
file and sends no data.

On macOS, the download goes through /usr/bin/curl, which uses the system's
certificates (the Python launched by SwiftBar does not always have its
own). Elsewhere, Python does it itself.
"""

import json
import os
import re
import subprocess
import threading
import time
import urllib.request

from paths import PATHS

URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
CACHE = os.path.join(PATHS["cache"], "rate.json")
CURL = "/usr/bin/curl"
MAX_AGE = 12 * 3600  # a more recent fetch is not repeated
RETRY = 3600         # delay before retrying after a failure

_DATE = re.compile(r"time=['\"](\d{4}-\d{2}-\d{2})['\"]")
_USD = re.compile(r"currency=['\"]USD['\"]\s+rate=['\"](\d+(?:\.\d+)?)['\"]")


def parse(xml):
    """{"date", "eurPerUsd"} from the ECB file (dollars for 1 euro)."""
    date, usd = _DATE.search(xml), _USD.search(xml)
    if not date or not usd:
        raise ValueError("taux introuvable dans la réponse de la BCE")
    usd_per_eur = float(usd.group(1))
    if not 0.5 < usd_per_eur < 2:
        raise ValueError(f"taux invraisemblable : {usd_per_eur}")
    return {"date": date.group(1), "eurPerUsd": round(1 / usd_per_eur, 4)}


def download(url=URL):
    if not url.startswith("https://"):
        raise ValueError("adresse non sécurisée")
    if not os.path.exists(CURL):
        with urllib.request.urlopen(url, timeout=20) as response:
            return response.read(1_000_000).decode("utf-8")
    done = subprocess.run([CURL, "-sS", "--fail", "--max-time", "20", "--proto", "=https", url],
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
        """The last rate fetched ({"date", "eurPerUsd"}), or None."""
        with self._lock:
            return {"date": self._rate["date"], "eurPerUsd": self._rate["eurPerUsd"]} if self._rate else None

    def refresh(self):
        """Fetches the rate if it is out of date. A failure keeps the last known rate."""
        with self._lock:
            now = self.clock()
            if self._rate and now - self._rate["fetched_at"] < MAX_AGE:
                return
            if self._tried_at is not None and now - self._tried_at < RETRY:
                return
            self._tried_at = now
        try:  # outside the lock: the download must not block the page
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
            pass  # the rate stays in memory
