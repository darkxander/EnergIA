"""Usage de Claude Code, lu dans ses journaux locaux (~/.claude/projects).

Chaque réponse y est enregistrée avec son modèle et ses vrais nombres de
tokens. On n'en garde que des compteurs par jour et par modèle : aucun texte
de conversation n'est lu au-delà du nécessaire ni conservé.

La lecture est incrémentale : pour chaque fichier on mémorise jusqu'où il a
été lu, et l'identifiant de chaque message déjà compté (une même réponse est
écrite plusieurs fois, et les sessions reprises recopient l'historique).
Les compteurs survivent à la suppression des journaux par Claude Code.
"""

import json
import os
import re
import tempfile
import threading
from datetime import datetime

ROOT = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/Library/Caches/EnergIA/claudecode.json")
CACHE_VERSION = 2
MAX_PROMPT_LINE = 200_000  # au-delà, une ligne "user" est un résultat d'outil, pas une requête
# inTok : tokens lus non mis en cache ; cw5Tok / cw1Tok : écrits dans le cache
# (5 minutes / 1 heure) ; cacheTok : relus du cache ; searches : recherches web.
FIELDS = ("requests", "responses", "inTok", "cw5Tok", "cw1Tok", "cacheTok", "outTok", "searches")
DATE_SUFFIX = re.compile(r"-\d{8}$")
HAIKU_LONG_PROMPT = 100_000  # au-delà, Claude Haiku 5.5 est facturé à un tarif supérieur


def local_day(timestamp):
    """Jour local (AAAA-MM-JJ) d'un horodatage ISO, ou None."""
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().date().isoformat()
    except (AttributeError, ValueError):
        return None


class UsageStore:
    def __init__(self, root=ROOT, cache=CACHE):
        self.root, self.cache = root, cache
        self._lock = threading.Lock()
        self._offsets = {}  # chemin -> octets déjà lus
        self._seen = set()  # identifiants de messages déjà comptés
        self._rows = {}     # (jour, modèle) -> compteurs
        self._pending = {}  # chemin -> requêtes lues, en attente de leur réponse
        self._load()

    # cache ------------------------------------------------------------------
    def _load(self):
        try:
            with open(self.cache, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("version") != CACHE_VERSION:
                return
            self._offsets = dict(data["offsets"])
            self._pending = dict(data["pending"])
            self._seen = set(data["seen"])
            self._rows = {(day, model): dict(zip(FIELDS, counts)) for day, model, *counts in data["rows"]}
        except (OSError, ValueError, KeyError, TypeError):
            self._offsets, self._seen, self._rows, self._pending = {}, set(), {}, {}

    def _save(self):
        data = {"version": CACHE_VERSION, "offsets": self._offsets, "pending": self._pending, "seen": sorted(self._seen),
                "rows": [[day, model, *(row[k] for k in FIELDS)] for (day, model), row in self._rows.items()]}
        os.makedirs(os.path.dirname(self.cache), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.cache))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.cache)

    # lecture ----------------------------------------------------------------
    def _row(self, day, model):
        return self._rows.setdefault((day, model), dict.fromkeys(FIELDS, 0))

    def _line(self, line, pending):
        """Compte une ligne de journal. `pending` retient les requêtes de
        l'utilisateur en attente de la prochaine réponse, pour les rattacher
        à son modèle."""
        if b'"type":"assistant"' in line and b'"usage"' in line:
            record = json.loads(line)
            message = record.get("message") or {}
            usage = message.get("usage")
            day = local_day(record.get("timestamp"))
            model = message.get("model")
            if record.get("type") != "assistant" or not usage or not day or not model or model == "<synthetic>":
                return
            key = message.get("id") or record.get("uuid")
            if not key or key in self._seen:
                return
            self._seen.add(key)
            model = DATE_SUFFIX.sub("", model)
            uncached = usage.get("input_tokens") or 0
            written = usage.get("cache_creation_input_tokens") or 0
            write1h = min(written, (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0)
            cached = usage.get("cache_read_input_tokens") or 0
            if model == "claude-haiku-5-5" and uncached + written + cached > HAIKU_LONG_PROMPT:
                model += "-long"
            row = self._row(day, model)
            row["responses"] += 1
            row["requests"] += pending[0]
            pending[0] = 0
            row["inTok"] += uncached
            row["cw1Tok"] += write1h
            row["cw5Tok"] += written - write1h  # sans détail, une écriture est comptée à 5 minutes
            row["cacheTok"] += cached
            row["outTok"] += usage.get("output_tokens") or 0
            row["searches"] += (usage.get("server_tool_use") or {}).get("web_search_requests") or 0
        elif b'"type":"user"' in line and b'"tool_result"' not in line and len(line) < MAX_PROMPT_LINE:
            record = json.loads(line)
            if record.get("type") != "user" or record.get("isMeta") or record.get("isSidechain"):
                return
            key = record.get("uuid")
            if not key or key in self._seen:
                return
            self._seen.add(key)
            pending[0] += 1

    def _read(self, path):
        size = os.path.getsize(path)
        offset = self._offsets.get(path, 0)
        if size < offset:
            offset = 0  # fichier réécrit : les identifiants déjà vus évitent tout double compte
        if size == offset:
            return False
        start = offset
        pending = [self._pending.get(path, 0)]
        with open(path, "rb") as f:
            f.seek(offset)
            for line in f:
                if not line.endswith(b"\n"):
                    break  # ligne en cours d'écriture : relue au prochain passage
                offset += len(line)
                try:
                    self._line(line, pending)
                except (ValueError, AttributeError, TypeError):
                    pass  # ligne illisible : ignorée
        self._offsets[path] = offset
        self._pending[path] = pending[0]
        return offset != start  # une ligne inachevée seule ne change rien

    def scan(self):
        """Lit ce qui est nouveau. Renvoie True si quelque chose a changé."""
        changed = False
        with self._lock:
            for folder, _, names in os.walk(self.root):
                for name in names:
                    if name.endswith(".jsonl"):
                        try:
                            changed |= self._read(os.path.join(folder, name))
                        except OSError:
                            pass  # fichier disparu entre-temps
            if changed:
                self._save()
        return changed

    # résultats --------------------------------------------------------------
    def rows(self):
        with self._lock:
            return [dict(row, day=day, model=model, source="claudecode")
                    for (day, model), row in sorted(self._rows.items())]
