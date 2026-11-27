"""Claude Code usage, read from its local logs (~/.claude/projects).

Each response is recorded there with its model and its real token counts.
Only counters per day and per model are kept from them: no conversation
text is read beyond what is necessary, nor kept.

Reading is incremental: for each file we remember how far it has been
read, and the identifier of each message already counted (the same response
is written several times, and resumed sessions copy the history again).
The counters survive the deletion of the logs by Claude Code.
"""

import json
import os
import re
import tempfile
import threading
from datetime import datetime

from paths import PATHS

ROOT = PATHS["claudecode"]
# The Cowork sessions of the Claude app keep their logs, in the same format,
# in a .claude/projects folder specific to each session.
COWORK_ROOT = PATHS["cowork"]
ROOTS = {"claudecode": ROOT, "cowork": COWORK_ROOT}
CACHE = os.path.join(PATHS["cache"], "claudecode.json")
CACHE_VERSION = 3
MAX_PROMPT_LINE = 200_000  # beyond that, a "user" line is a tool result, not a request
# inTok: tokens read and not cached; cw5Tok / cw1Tok: written to the cache
# (5 minutes / 1 hour); cacheTok: read back from the cache; searches: web searches.
FIELDS = ("requests", "responses", "inTok", "cw5Tok", "cw1Tok", "cacheTok", "outTok", "searches")
DATE_SUFFIX = re.compile(r"-\d{8}$")
HAIKU_LONG_PROMPT = 100_000  # beyond that, Claude Haiku 5.5 is billed at a higher rate


def local_day(timestamp):
    """Local day (YYYY-MM-DD) of an ISO timestamp, or None."""
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().date().isoformat()
    except (AttributeError, ValueError):
        return None


class UsageStore:
    def __init__(self, roots=None, cache=CACHE):
        """`roots`: {source: folder}, or a single folder counted as Claude Code."""
        self.roots = dict(ROOTS) if roots is None else {"claudecode": roots} if isinstance(roots, str) else dict(roots)
        self.cache = cache
        self._source = None  # source of the folder being read
        self._lock = threading.Lock()
        self._offsets = {}  # path -> bytes already read
        self._seen = set()  # identifiers of messages already counted
        self._rows = {}     # (day, source, model) -> counters
        self._pending = {}  # path -> requests read, awaiting their response
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
            self._rows = {(day, source, model): dict(zip(FIELDS, counts))
                          for day, source, model, *counts in data["rows"]}
        except (OSError, ValueError, KeyError, TypeError):
            self._offsets, self._seen, self._rows, self._pending = {}, set(), {}, {}

    def _save(self):
        data = {"version": CACHE_VERSION, "offsets": self._offsets, "pending": self._pending, "seen": sorted(self._seen),
                "rows": [[*key, *(row[k] for k in FIELDS)] for key, row in self._rows.items()]}
        os.makedirs(os.path.dirname(self.cache), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.cache))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.cache)

    # reading ----------------------------------------------------------------
    def _row(self, day, model):
        return self._rows.setdefault((day, self._source, model), dict.fromkeys(FIELDS, 0))

    def _line(self, line, pending):
        """Counts one log line. `pending` holds the user's requests awaiting
        the next response, so as to attach them to its model."""
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
            row["cw5Tok"] += written - write1h  # without a breakdown, a write is counted as 5 minutes
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
            offset = 0  # file rewritten: the identifiers already seen prevent any double counting
        if size == offset:
            return False
        start = offset
        pending = [self._pending.get(path, 0)]
        with open(path, "rb") as f:
            f.seek(offset)
            for line in f:
                if not line.endswith(b"\n"):
                    break  # line still being written: read again on the next pass
                offset += len(line)
                try:
                    self._line(line, pending)
                except (ValueError, AttributeError, TypeError):
                    pass  # unreadable line: ignored
        self._offsets[path] = offset
        self._pending[path] = pending[0]
        return offset != start  # an unfinished line alone changes nothing

    def scan(self):
        """Reads what is new. Returns True if something has changed."""
        changed = False
        with self._lock:
            for source, root in self.roots.items():
                self._source = source
                for folder, _, names in os.walk(root):
                    if source == "cowork" and "/.claude/projects" not in folder:
                        continue  # the other files of a Cowork session are not logs
                    for name in names:
                        if not name.endswith(".jsonl"):
                            continue
                        try:
                            changed |= self._read(os.path.join(folder, name))
                        except OSError:
                            pass  # file gone in the meantime
            if changed:
                self._save()
        return changed

    # results ----------------------------------------------------------------
    def rows(self):
        with self._lock:
            return [dict(row, day=day, model=model, source=source)
                    for (day, source, model), row in sorted(self._rows.items())]
