"""Model prices: the project's own price file, fetched once a day.

The plugin is installed with the prices of that day (src/prices.json). The
project brings that file up to date every week; this module downloads the
published copy so that an installed plugin follows without being reinstalled.
Like the exchange rate, it downloads a public file and sends no data.

What comes from the network is checked before use (shape, plausible numbers)
and only replaces the installed prices if it is at least as recent. A failure
changes nothing: the last good prices stay.
"""

import json
import os
import re
import threading
import time

from paths import PATHS
from rate import download

URL = "https://darkxander.github.io/EnergIA/src/prices.json"
CACHE = os.path.join(PATHS["cache"], "prices.json")
MAX_AGE = 24 * 3600  # a more recent fetch is not repeated
RETRY = 3600         # delay before retrying after a failure

MAX_PRICE = 1000     # dollars per million tokens
FIELDS = ("in", "out", "read", "write5m", "write1h")
TEXTS = ("source", "feed", "unit", "openaiSource", "openaiLegacySource")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _number(value, top):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= top


def _name(value):
    return isinstance(value, str) and 0 < len(value) <= 80


def clean(data):
    """The price file reduced to what we know how to use, or ValueError."""
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        raise ValueError("fichier de prix illisible")
    if not isinstance(data.get("checked"), str) or not _DAY.match(data["checked"]):
        raise ValueError("date du relevé absente")
    if not _number(data.get("webSearchUsdPer1000"), MAX_PRICE):
        raise ValueError("prix de la recherche web invraisemblable")
    models = {}
    for name, price in data["models"].items():
        if not _name(name) or not isinstance(price, dict) or not set(price) <= set(FIELDS):
            raise ValueError(f"modèle illisible : {str(name)[:80]}")
        if "in" not in price or "out" not in price or not all(_number(v, MAX_PRICE) for v in price.values()):
            raise ValueError(f"prix invraisemblable : {name}")
        models[name] = dict(price)
    if not 10 <= len(models) <= 2000:
        raise ValueError("nombre de modèles invraisemblable")
    aliases = data.get("aliases", {})
    if not isinstance(aliases, dict) or not all(_name(k) and _name(v) for k, v in aliases.items()):
        raise ValueError("alias illisibles")
    out = {"checked": data["checked"], "webSearchUsdPer1000": data["webSearchUsdPer1000"],
           "models": models, "aliases": dict(aliases)}
    for key in TEXTS:
        if isinstance(data.get(key), str):
            out[key] = data[key][:500]
    return out


class PriceStore:
    def __init__(self, cache=CACHE, fetch=lambda: download(URL), clock=time.time, bundled_checked=""):
        # bundled_checked: date of the installed prices; older fetched prices are ignored.
        self.cache, self.fetch, self.clock, self.bundled_checked = cache, fetch, clock, bundled_checked
        self._lock = threading.Lock()
        self._prices = self._fetched_at = self._tried_at = None
        try:
            with open(cache, encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved["fetched_at"], (int, float)):
                self._prices, self._fetched_at = clean(saved["prices"]), saved["fetched_at"]
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def current(self):
        """The fetched prices if they are at least as recent as the installed ones, else None."""
        with self._lock:
            if self._prices and self._prices["checked"] >= self.bundled_checked:
                return self._prices
            return None

    def refresh(self):
        """Fetches the prices if they are out of date. A failure keeps the last known ones."""
        with self._lock:
            now = self.clock()
            if self._fetched_at is not None and now - self._fetched_at < MAX_AGE:
                return
            if self._tried_at is not None and now - self._tried_at < RETRY:
                return
            self._tried_at = now
        try:  # outside the lock: the download must not block the page
            prices = clean(json.loads(self.fetch()))
        except Exception:
            return
        with self._lock:
            self._prices, self._fetched_at = prices, now
        try:
            os.makedirs(os.path.dirname(self.cache), exist_ok=True)
            with open(self.cache, "w", encoding="utf-8") as f:
                json.dump({"fetched_at": now, "prices": prices}, f)
        except OSError:
            pass  # the prices stay in memory
