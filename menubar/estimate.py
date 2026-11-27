"""Energy estimate for the menu bar title.

Same calculation as src/model.js (keep the two in agreement), with the same
default values (src/defaults.json) and the settings made in the page.
"""

import copy
import json
import os
import re
import subprocess
import sys

from paths import PATHS

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULTS = os.path.join(HERE, "..", "src", "defaults.json")
PRICES = os.path.join(HERE, "..", "src", "prices.json")
SETTINGS = os.path.join(PATHS["config"], "settings.json")

LANGS = ("fr", "en")

_LEGER = re.compile(r"(^|[-_ ])mini|nano|haiku|flash|instant|lite|luna")  # "gemini" is not "mini"
_GRAND = re.compile(r"opus|fable|mythos|astra")
_RAISONNEMENT = re.compile(r"^o\d|thinking|reason|research|(^|-)pro($|-)")


def classify(model):
    m = str(model or "").lower()
    if _LEGER.search(m):
        return "leger"
    if _GRAND.search(m):
        return "grand"
    if _RAISONNEMENT.search(m):
        return "raisonnement"
    return "standard"


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value < 1e9


def merge(defaults, saved):
    """The saved settings on top of the default values; only plausible
    numbers on known keys are accepted."""
    out = copy.deepcopy(defaults)
    if not isinstance(saved, dict):
        return out
    for key, value in out.items():
        new = saved.get(key)
        if key in ("tiers", "subs"):
            if not isinstance(new, dict):
                continue
            for name, inner in value.items():
                if key == "subs":
                    if _number(new.get(name)):
                        value[name] = new[name]
                elif isinstance(new.get(name), dict):
                    for field in inner:
                        if _number(new[name].get(field)):
                            inner[field] = new[name][field]
        elif _number(new):
            out[key] = new
    if saved.get("lang") in LANGS:  # language displayed by the page, reused by the title
        out["lang"] = saved["lang"]
    return out


def _system_languages():
    """Text whose beginning gives the system language."""
    if sys.platform == "darwin":
        return subprocess.run(["/usr/bin/defaults", "read", "-g", "AppleLanguages"],
                              capture_output=True, text=True, timeout=5, check=False).stdout
    for name in ("LC_ALL", "LC_MESSAGES", "LANG"):
        if os.environ.get(name):
            return os.environ[name]
    import locale
    return locale.getlocale()[0] or ""  # on Windows: "French_France", "fr_FR"…


def system_lang(read=None):
    """System language: French if it is the first preferred language, English otherwise
    (same rule as the page with the browser's language)."""
    try:
        text = (read or _system_languages)()
    except (OSError, ValueError, subprocess.SubprocessError):
        return "en"
    first = re.search(r"[A-Za-z]{2,}", text or "")
    return "fr" if first and first.group(0).lower() in ("fr", "french", "fra", "fre") else "en"


_system_lang = None


def lang_of(settings):
    """The language chosen in the page, otherwise the system's (read only once)."""
    global _system_lang
    if settings.get("lang") in LANGS:
        return settings["lang"]
    if _system_lang is None:
        _system_lang = system_lang()
    return _system_lang


def load_settings(path=SETTINGS):
    with open(DEFAULTS, encoding="utf-8") as f:
        defaults = json.load(f)
    try:
        with open(path, encoding="utf-8") as f:
            return merge(defaults, json.load(f))
    except (OSError, ValueError):
        return defaults


def save_settings(saved, path=SETTINGS):
    with open(DEFAULTS, encoding="utf-8") as f:
        clean = merge(json.load(f), saved)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f)


def wh(row, settings):
    tier = settings["tiers"][classify(row["model"])]
    read = (row["inTok"] + row.get("cw5Tok", 0) + row.get("cw1Tok", 0)
            + row.get("cacheTok", 0) * settings["cacheReadRatio"])
    return (row["outTok"] + read * settings["inputRatio"]) / 1000 * tier["whOut"]


_prices = None
_MODE = re.compile(r"-(thinking|instant|high|medium|low|auto)(?=-|$)")


def price_for(model):
    """Public prices of the model (dollars per million tokens), or None if it is unknown.
    Same rule as priceFor in src/model.js."""
    global _prices
    if _prices is None:
        with open(PRICES, encoding="utf-8") as f:
            _prices = json.load(f)
    name = re.sub(r"-\d{8}$", "", str(model or "").lower().replace(".", "-"))
    plain = _MODE.sub("", re.sub(r"-t-mini$", "-mini", name))
    for candidate in (name, plain):
        price = _prices["models"].get(_prices["aliases"].get(candidate, candidate))
        if price:
            return price
    return None


def eur(row, settings):
    """Cost at the API rate, in euros. Same calculation as rowMetrics in src/model.js."""
    write5m, write1h, cached = row.get("cw5Tok", 0), row.get("cw1Tok", 0), row.get("cacheTok", 0)
    price = price_for(row["model"])
    if not price:
        tier = settings["tiers"][classify(row["model"])]
        read = row["inTok"] + write5m + write1h + cached * settings["cacheReadRatio"]
        return (read * tier["eurIn"] + row["outTok"] * tier["eurOut"]) / 1e6
    usd = (row["inTok"] * price["in"] + write5m * price.get("write5m", price["in"])
           + write1h * price.get("write1h", price["in"]) + cached * price.get("read", price["in"])
           + row["outTok"] * price["out"]) / 1e6
    usd += row.get("searches", 0) * _prices["webSearchUsdPer1000"] / 1000
    return usd * settings["eurPerUsd"]


def over_budget(rows, settings, today):
    """True if one of the thresholds chosen in the page is exceeded: energy or cost,
    for the day `today` (YYYY-MM-DD) or for its month."""
    month = [row for row in rows if row["day"][:7] == today[:7]]
    day = [row for row in month if row["day"] == today]
    checks = ((settings.get("dailyBudgetWh", 0), day, wh), (settings.get("monthlyBudgetKWh", 0) * 1000, month, wh),
              (settings.get("dailyBudgetEur", 0), day, eur), (settings.get("monthlyBudgetEur", 0), month, eur))
    return any(budget > 0 and sum(measure(row, settings) for row in period) > budget
               for budget, period, measure in checks)


def format_energy(value, lang="fr", compact=False):
    """12 Wh, 3,4 Wh, 1,25 kWh: three significant digits at most.
    Decimal comma in French, point in English.
    Compact: no space and fewer digits (523Wh, 12Wh, 1,3kWh)."""
    unit = "Wh"
    if value >= 1000:
        value, unit = value / 1000, "kWh"
    if compact:
        text = f"{value:.0f}" if value >= 10 else f"{value:.1f}"
    else:
        text = f"{value:.0f}" if value >= 100 else f"{value:.1f}" if value >= 10 else f"{value:.2f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return f"{text.replace('.', ',') if lang == 'fr' else text}{'' if compact else ' '}{unit}"
