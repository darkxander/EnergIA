"""Estimation d'énergie pour le titre de la barre de menus.

Même calcul que src/model.js (garder les deux en accord), avec les mêmes
valeurs par défaut (src/defaults.json) et les réglages faits dans la page.
"""

import copy
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULTS = os.path.join(HERE, "..", "src", "defaults.json")
SETTINGS = os.path.expanduser("~/Library/Application Support/EnergIA/settings.json")

LANGS = ("fr", "en")

_LEGER = re.compile(r"mini|nano|haiku|flash|instant|lite|luna")
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
    """Les réglages enregistrés par-dessus les valeurs par défaut ; seuls des
    nombres plausibles sur des clés connues sont acceptés."""
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
    if saved.get("lang") in LANGS:  # langue affichée par la page, reprise par le titre
        out["lang"] = saved["lang"]
    return out


def system_lang(read=None):
    """Langue de macOS : français si c'est la première langue préférée, anglais sinon
    (même règle que la page avec la langue du navigateur)."""
    try:
        text = read() if read else subprocess.run(
            ["/usr/bin/defaults", "read", "-g", "AppleLanguages"],
            capture_output=True, text=True, timeout=5, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return "en"
    first = re.search(r"[A-Za-z]{2,3}", text or "")
    return "fr" if first and first.group(0).lower() == "fr" else "en"


_system_lang = None


def lang_of(settings):
    """La langue choisie dans la page, sinon celle de macOS (lue une seule fois)."""
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


def format_energy(value, lang="fr"):
    """12 Wh, 3,4 Wh, 1,25 kWh : trois chiffres significatifs au plus.
    Virgule décimale en français, point en anglais."""
    unit = "Wh"
    if value >= 1000:
        value, unit = value / 1000, "kWh"
    text = f"{value:.0f}" if value >= 100 else f"{value:.1f}" if value >= 10 else f"{value:.2f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return f"{text.replace('.', ',') if lang == 'fr' else text} {unit}"
