import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "menubar"))

import estimate  # noqa: E402
import paths  # noqa: E402
import server  # noqa: E402
import rate  # noqa: E402
import tray  # noqa: E402
from claudecode import UsageStore, local_day  # noqa: E402


def assistant(msg_id, model="claude-sonnet-5-5", ts="2026-11-25T12:00:00Z", **usage):
    usage = {"input_tokens": 10, "cache_creation_input_tokens": 90, "cache_read_input_tokens": 1000,
             "output_tokens": 50, **usage}
    return json.dumps({"type": "assistant", "timestamp": ts, "uuid": "u-" + msg_id,
                       "message": {"id": msg_id, "model": model, "usage": usage}}, separators=(",", ":"))


def user(uuid, **extra):
    return json.dumps({"type": "user", "uuid": uuid, "timestamp": "2026-11-25T12:00:00Z",
                       "message": {"role": "user", "content": "bonjour"}, **extra}, separators=(",", ":"))


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.dir.name, "projects")
        os.makedirs(os.path.join(self.root, "-p", "s", "subagents"))
        self.cache = os.path.join(self.dir.name, "cache", "c.json")
        self.log = os.path.join(self.root, "-p", "a.jsonl")

    def tearDown(self):
        self.dir.cleanup()

    def write(self, path, lines, mode="a", end="\n"):
        with open(path, mode, encoding="utf-8") as f:
            f.write("\n".join(lines) + end)

    def test_counts_dedup_and_increments(self):
        self.write(self.log, [
            user("q1"), assistant("m1"), assistant("m1"),  # same response written twice
            user("meta", isMeta=True), user("side", isSidechain=True),
            json.dumps({"type": "user", "uuid": "t1", "message": {"content": [{"type": "tool_result"}]}}),
            assistant("syn", model="<synthetic>"), "ligne illisible {",
        ])
        self.write(os.path.join(self.root, "-p", "s", "subagents", "agent.jsonl"),
                   [assistant("m1"), assistant("m2", model="claude-haiku-5-5")])  # m1 copied again
        store = UsageStore(self.root, self.cache)
        self.assertTrue(store.scan())
        rows = {r["model"]: r for r in store.rows()}
        day = local_day("2026-11-25T12:00:00Z")
        self.assertEqual(rows["claude-sonnet-5-5"], {
            "requests": 1, "responses": 1, "inTok": 10, "cw5Tok": 90, "cw1Tok": 0, "cacheTok": 1000,
            "outTok": 50, "searches": 0,
            "day": day, "model": "claude-sonnet-5-5", "source": "claudecode"})
        self.assertEqual(rows["claude-haiku-5-5"]["responses"], 1)
        self.assertEqual(len(rows), 2)
        self.assertFalse(store.scan())  # nothing new

        # A request read on its own, then its response on the next pass; a line still being written is ignored.
        self.write(self.log, [user("q2")])
        store.scan()
        self.write(self.log, [assistant("m3"), assistant("m4")[:40]], end="")
        store.scan()
        row = {r["model"]: r for r in store.rows()}["claude-sonnet-5-5"]
        self.assertEqual((row["requests"], row["responses"]), (2, 2))

        # The cache gives back the same counters without recounting anything.
        again = UsageStore(self.root, self.cache)
        self.assertEqual(again.rows(), store.rows())
        self.assertFalse(again.scan())
        self.assertEqual(again.rows(), store.rows())

    def test_cache_durations_dates_and_long_haiku(self):
        self.write(self.log, [
            assistant("a", model="claude-haiku-4-5-20251001", cache_creation={"ephemeral_1h_input_tokens": 60},
                      server_tool_use={"web_search_requests": 2}),
            assistant("b", model="claude-haiku-5-5", cache_read_input_tokens=99_900),   # exactly 100,000
            assistant("c", model="claude-haiku-5-5", cache_read_input_tokens=99_901),   # beyond
        ])
        store = UsageStore(self.root, self.cache)
        store.scan()
        rows = {r["model"]: r for r in store.rows()}
        self.assertEqual(sorted(rows), ["claude-haiku-4-5", "claude-haiku-5-5", "claude-haiku-5-5-long"])
        old = rows["claude-haiku-4-5"]
        self.assertEqual((old["inTok"], old["cw5Tok"], old["cw1Tok"], old["searches"]), (10, 30, 60, 2))

    def test_cowork_sessions_are_a_separate_source(self):
        cowork = os.path.join(self.dir.name, "cowork")
        logs = os.path.join(cowork, "org", "user", "local_1", ".claude", "projects", "session")
        os.makedirs(logs)
        self.write(self.log, [user("q1"), assistant("m1")])
        self.write(os.path.join(logs, "s.jsonl"), [user("q2"), assistant("m2"), assistant("m1")])  # m1 already counted
        self.write(os.path.join(cowork, "org", "user", "local_1", "audit.jsonl"), [assistant("m9")])  # not a log
        store = UsageStore({"claudecode": self.root, "cowork": cowork}, self.cache)
        store.scan()
        by_source = {r["source"]: (r["requests"], r["responses"]) for r in store.rows()}
        self.assertEqual(by_source, {"claudecode": (1, 1), "cowork": (1, 1)})
        self.assertEqual(UsageStore({"claudecode": self.root, "cowork": cowork}, self.cache).rows(), store.rows())

    def test_missing_root(self):
        store = UsageStore(os.path.join(self.dir.name, "absent"), self.cache)
        self.assertFalse(store.scan())
        self.assertEqual(store.rows(), [])


class PathsTest(unittest.TestCase):
    def test_folders_per_system(self):
        j = os.path.join
        mac = paths.locate("darwin", {}, "/Users/a")
        self.assertEqual(mac["claudecode"], j("/Users/a", ".claude", "projects"))
        self.assertEqual(mac["cache"], j("/Users/a", "Library", "Caches", "EnergIA"))
        self.assertEqual(mac["config"], j("/Users/a", "Library", "Application Support", "EnergIA"))
        self.assertEqual(mac["cowork"], j("/Users/a", "Library", "Application Support", "Claude",
                                          "local-agent-mode-sessions"))
        win = paths.locate("win32", {"APPDATA": "R", "LOCALAPPDATA": "L"}, "H")
        self.assertEqual(win, {"claudecode": j("H", ".claude", "projects"),
                               "cowork": j("R", "Claude", "local-agent-mode-sessions"),
                               "cache": j("L", "EnergIA", "Cache"), "config": j("R", "EnergIA")})
        self.assertEqual(paths.locate("win32", {}, "H")["config"], j("H", "AppData", "Roaming", "EnergIA"))
        linux = paths.locate("linux", {}, "/home/a")
        self.assertEqual(linux["cache"], j("/home/a", ".cache", "EnergIA"))
        self.assertEqual(linux["config"], j("/home/a", ".config", "EnergIA"))
        xdg = paths.locate("linux", {"XDG_CACHE_HOME": "/c", "XDG_CONFIG_HOME": "/k"}, "/home/a")
        self.assertEqual((xdg["cache"], xdg["config"]), (j("/c", "EnergIA"), j("/k", "EnergIA")))
        # Claude Code moved by its environment variable.
        self.assertEqual(paths.locate("linux", {"CLAUDE_CONFIG_DIR": "/x"}, "/home/a")["claudecode"], j("/x", "projects"))


class EstimateTest(unittest.TestCase):
    def test_same_numbers_as_model_js(self):
        settings = estimate.load_settings("/nonexistent")
        row = {"model": "gpt-4o", "inTok": 2000, "outTok": 300}
        self.assertAlmostEqual(estimate.wh(row, settings), 0.3)
        cached = {"model": "claude-sonnet-5-5", "inTok": 0, "cacheTok": 100000, "outTok": 0}
        self.assertAlmostEqual(estimate.wh(cached, settings), 0.12)  # 100,000 × 0.02 × 0.1 / 1000 × 0.6
        # Cost: same rows and same results as the "cost" test in test/EnergIA.test.js.
        priced = {"model": "claude-sonnet-5-5", "inTok": 1000, "cw5Tok": 200, "cw1Tok": 300, "cacheTok": 50000,
                  "outTok": 400, "searches": 2}
        self.assertAlmostEqual(estimate.eur(priced, settings), 0.02982894)
        self.assertAlmostEqual(estimate.eur({"model": "gpt-5-thinking", "inTok": 2000, "outTok": 300}, settings), 0.0050171)
        unknown = {"model": "modele-inconnu", "inTok": 2000, "cacheTok": 1000, "outTok": 300}
        self.assertAlmostEqual(estimate.eur(unknown, settings), 0.00805)
        # Thresholds: the day and the month are counted separately, yesterday does not count towards the day.
        rows = [dict(row, day="2026-11-24"), dict(row, day="2026-11-25"), dict(row, day="2026-10-31")]
        over = lambda **budgets: estimate.over_budget(rows, {**settings, **budgets}, "2026-11-25")
        self.assertFalse(over())
        self.assertEqual((over(dailyBudgetWh=0.29), over(dailyBudgetWh=0.31)), (True, False))
        self.assertEqual((over(monthlyBudgetKWh=0.00059), over(monthlyBudgetKWh=0.00061)), (True, False))
        day_cost = estimate.eur(row, settings)
        self.assertEqual((over(dailyBudgetEur=day_cost * 0.9), over(dailyBudgetEur=day_cost * 1.1)), (True, False))
        self.assertEqual((over(monthlyBudgetEur=day_cost * 1.9), over(monthlyBudgetEur=day_cost * 2.1)), (True, False))
        for model, tier in [("gpt-4o-mini", "leger"), ("claude-haiku-5-5", "leger"), ("claude-fable-5-2", "grand"),
                            ("claude-opus-5-5", "grand"), ("o3", "raisonnement"), ("gpt-5-pro", "raisonnement"),
                            ("claude-sonnet-5-5", "standard"), ("claude", "standard"),
                            ("gemini", "standard"), ("copilot", "standard"), ("o3-mini", "leger")]:
            self.assertEqual(estimate.classify(model), tier, model)

    def test_format(self):
        self.assertEqual(estimate.format_energy(0), "0 Wh")
        self.assertEqual(estimate.format_energy(3.456), "3,46 Wh")
        self.assertEqual(estimate.format_energy(12.34), "12,3 Wh")
        self.assertEqual(estimate.format_energy(250.4), "250 Wh")
        self.assertEqual(estimate.format_energy(1250), "1,25 kWh")
        self.assertEqual(estimate.format_energy(1250, "en"), "1.25 kWh")
        self.assertEqual(estimate.format_energy(3.456, "en"), "3.46 Wh")
        self.assertEqual(estimate.format_energy(250.4, "en"), "250 Wh")
        # Compact title: no space, fewer digits, but still the unit.
        self.assertEqual(estimate.format_energy(523.4, compact=True), "523Wh")
        self.assertEqual(estimate.format_energy(12.34, compact=True), "12Wh")
        self.assertEqual(estimate.format_energy(3.456, compact=True), "3,5Wh")
        self.assertEqual(estimate.format_energy(1250, compact=True), "1,2kWh")
        self.assertEqual(estimate.format_energy(1350, "en", compact=True), "1.4kWh")
        self.assertEqual(estimate.format_energy(12000, compact=True), "12kWh")

    def test_language(self):
        # macOS: French if it is the first preferred language, English otherwise.
        self.assertEqual(estimate.system_lang(lambda: '(\n    "fr-FR",\n    "en-FR"\n)'), "fr")
        self.assertEqual(estimate.system_lang(lambda: '(\n    "en-GB",\n    "fr-FR"\n)'), "en")
        self.assertEqual(estimate.system_lang(lambda: ""), "en")
        # Linux (LANG variable) and Windows (locale name).
        self.assertEqual(estimate.system_lang(lambda: "fr_FR.UTF-8"), "fr")
        self.assertEqual(estimate.system_lang(lambda: "en_US.UTF-8"), "en")
        self.assertEqual(estimate.system_lang(lambda: "French_France"), "fr")
        self.assertEqual(estimate.system_lang(lambda: "C"), "en")
        # The language chosen in the page takes precedence over the system's.
        self.assertEqual(estimate.lang_of({"lang": "en"}), "en")
        self.assertEqual(estimate.lang_of({"lang": "fr"}), "fr")

    def test_settings_are_sanitized(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            estimate.save_settings({"gCO2PerKWh": 50, "inputRatio": "x", "evil": 1, "lang": "xx",
                                    "tiers": {"standard": {"whOut": 1, "other": 2}, "new": {"whOut": 1}}}, path)
            s = estimate.load_settings(path)
            self.assertEqual(s["gCO2PerKWh"], 50)
            self.assertEqual(s["inputRatio"], 0.1)
            self.assertEqual(s["tiers"]["standard"], {"whOut": 1, "eurIn": 2.5, "eurOut": 10})
            self.assertNotIn("evil", s)
            self.assertNotIn("new", s["tiers"])
            self.assertNotIn("lang", s)  # only "fr" and "en" are accepted
            estimate.save_settings({"lang": "en"}, path)
            self.assertEqual(estimate.load_settings(path)["lang"], "en")


ECB = """<Cube><Cube time='2026-11-24'><Cube currency='USD' rate='1.0963'/><Cube currency='JPY' rate='170.1'/></Cube></Cube>"""


class RateTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(rate.parse(ECB), {"date": "2026-11-24", "eurPerUsd": 0.9122})
        for bad in ("", "<html>erreur</html>", ECB.replace("1.0963", "109.63"), ECB.replace("USD", "CHF")):
            with self.assertRaises(ValueError):
                rate.parse(bad)

    def test_daily_refresh_keeps_last_rate_on_failure(self):
        with tempfile.TemporaryDirectory() as d:
            cache, now, calls = os.path.join(d, "sub", "rate.json"), [1000.0], []

            def fetch():
                calls.append(now[0])
                if len(calls) == 2:
                    raise OSError("hors ligne")
                return ECB if len(calls) == 1 else ECB.replace("1.0963", "1.2500").replace("11-24", "11-26")

            store = rate.RateStore(cache, fetch, clock=lambda: now[0])
            self.assertIsNone(store.current())
            store.refresh()
            store.refresh()  # recent fetch: no new call
            self.assertEqual((len(calls), store.current()), (1, {"date": "2026-11-24", "eurPerUsd": 0.9122}))
            now[0] += rate.MAX_AGE + 1
            store.refresh()  # failure: the old rate stays
            store.refresh()  # no new attempt before RETRY
            self.assertEqual((len(calls), store.current()["eurPerUsd"]), (2, 0.9122))
            self.assertEqual(rate.RateStore(cache, fetch).current()["eurPerUsd"], 0.9122)  # read back from the cache
            now[0] += rate.RETRY + 1
            store.refresh()
            self.assertEqual(store.current(), {"date": "2026-11-26", "eurPerUsd": 0.8})


class GateTest(unittest.TestCase):
    def test_title_waits_for_closed_popover(self):
        now = [0.0]
        gate = server.TitleGate(beat_timeout=4, clock=lambda: now[0])
        gate.offer("a")
        self.assertEqual(gate.take(), "a")
        self.assertIsNone(gate.take())  # unchanged: not sent again
        gate.beat()
        gate.offer("b")
        self.assertIsNone(gate.take())  # window open
        now[0] = 5
        self.assertEqual(gate.take(), "b")


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = os.path.join(self.dir.name, "projects", "-p")
        os.makedirs(root)
        with open(os.path.join(root, "a.jsonl"), "w") as f:
            f.write(user("q1") + "\n" + assistant("m1", output_tokens=1000) + "\n")
        store = UsageStore(os.path.dirname(root), os.path.join(self.dir.name, "c.json"))
        self.settings = os.path.join(self.dir.name, "settings.json")
        rates = rate.RateStore(os.path.join(self.dir.name, "rate.json"), fetch=lambda: ECB)
        self.opened = []
        self.dash = server.Dashboard(store, self.settings, today=lambda: local_day("2026-11-25T12:00:00Z"),
                                     rates=rates, opener=self.opened.append,
                                     picker=self.pick, downloads=os.path.join(self.dir.name, "Downloads"),
                                     revealer=lambda path: self.revealed.append(path))
        self.revealed = []
        self.picked = None
        self.pick_langs = []
        estimate._system_lang = "fr"  # independent of the test machine's language
        self.server = server.serve(self.dash, port=0)
        self.port = self.server.server_address[1]

    def pick(self, lang):
        self.pick_langs.append(lang)
        return self.picked

    def tearDown(self):
        estimate._system_lang = None
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def get(self, path, headers=None, data=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers or {}, data=data)
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                return r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None, b""

    def test_title_and_payload(self):
        self.assertEqual(self.dash.title(), "⚡ …")
        self.dash.poll()
        # (1000 + (100 + 1000 × 0.02) × 0.1) / 1000 × 0.6 = 0.607 Wh
        self.assertEqual(self.dash.title(), "⚡ 0,61 Wh")
        api = {"X-EnergIA": "1"}
        status, ctype, body = self.get("/api/claudecode", api)
        payload = json.loads(body)
        self.assertEqual((status, ctype, payload["ready"], len(payload["rows"])), (200, "application/json", True, 1))
        self.assertEqual(payload["rate"], {"date": "2026-11-24", "eurPerUsd": 0.9122})
        status, _, _ = self.get("/api/settings", {**api, "Content-Type": "application/json"},
                                json.dumps({"tiers": {"standard": {"whOut": 6}}}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(self.dash.title(), "⚡ 6,07 Wh")
        # The page sends its language with the settings: the title switches to the decimal point.
        status, _, _ = self.get("/api/settings", {**api, "Content-Type": "application/json"},
                                json.dumps({"tiers": {"standard": {"whOut": 6}}, "lang": "en"}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(self.dash.title(), "⚡ 6.07 Wh")
        # Energy threshold per day: the red dot replaces the lightning bolt when it is exceeded.
        post = lambda saved: self.get("/api/settings", {**api, "Content-Type": "application/json"},
                                      json.dumps(saved).encode())[0]
        self.assertEqual(post({"dailyBudgetWh": 0.5}), 200)
        self.assertEqual(self.dash.title(), "🔴 0,61 Wh")
        self.assertEqual(post({"dailyBudgetWh": 5}), 200)
        self.assertEqual(self.dash.title(), "⚡ 0,61 Wh")
        self.assertEqual(post({"dailyBudgetWh": 0}), 200)   # 0: no threshold
        self.assertEqual(self.dash.title(), "⚡ 0,61 Wh")
        # The other thresholds: energy per month (in kWh), cost per day and per month (in euros).
        for key, low, high in [("monthlyBudgetKWh", 0.0005, 0.005), ("dailyBudgetEur", 0.0001, 100),
                               ("monthlyBudgetEur", 0.0001, 100)]:
            self.assertEqual(post({key: low}), 200)
            self.assertEqual(self.dash.title(), "🔴 0,61 Wh", key)
            self.assertEqual(post({key: high}), 200)
            self.assertEqual(self.dash.title(), "⚡ 0,61 Wh", key)
        # Compact title: neither icon nor spaces; the page then reads it back from the plugin.
        self.assertEqual(post({"compactTitle": 1, "tiers": {"standard": {"whOut": 600}}}), 200)
        self.assertEqual(self.dash.title(), "607Wh")
        self.assertEqual(json.loads(self.get("/api/beat", api)[2])["compactTitle"], 1)
        self.assertEqual(post({"compactTitle": 1, "dailyBudgetWh": 1, "tiers": {"standard": {"whOut": 600}}}), 200)
        # Above the threshold, the compact title turns red: the colour follows the title
        # after a tab, and becomes a parameter of the line sent to SwiftBar.
        self.assertEqual(self.dash.title(), "607Wh\tcolor=#ff453a")
        import io
        out = io.StringIO()
        server.emit(self.dash.title(), out=out)
        self.assertEqual(out.getvalue().splitlines()[1],
                         "607Wh | href=http://127.0.0.1:18791/ webview=true webvieww=860 webviewh=680 color=#ff453a")
        out = io.StringIO()
        server.emit("⚡ 607 Wh", out=out)
        self.assertEqual(out.getvalue().splitlines()[1],
                         "⚡ 607 Wh | href=http://127.0.0.1:18791/ webview=true webvieww=860 webviewh=680")

    def test_server_only_mode(self):
        api = {"X-EnergIA": "1"}
        # SwiftBar window by default; "server only" mode tells the page that it
        # is in a real browser (file picker and ordinary links).
        self.assertEqual(json.loads(self.get("/api/beat", api)[2]), {"ok": True, "window": True, "compactTitle": 0})
        self.dash.window = False
        self.assertEqual(json.loads(self.get("/api/beat", api)[2]), {"ok": True, "window": False, "compactTitle": 0})

        args = server.parse_args(["--serve", "--port", "1234", "--no-browser"])
        self.assertEqual((args.serve, args.port, args.no_browser), (True, 1234, True))
        self.assertFalse(server.parse_args([]).serve)                 # SwiftBar: no argument
        self.assertFalse(server.parse_args(["argument-inconnu"]).serve)

        # Port already taken: clear message and exit code 1, without raising an exception.
        import io
        out = io.StringIO()
        self.assertEqual(server.serve_only(self.port, browser=False, out=out), 1)
        self.assertIn(str(self.port), out.getvalue())

    def test_open_only_known_links(self):
        api = {"X-EnergIA": "1"}
        self.assertEqual(self.get("/api/open?link=sponsor", api)[0], 200)
        self.assertEqual(self.opened, ["https://github.com/sponsors/darkxander"])
        self.assertEqual(self.get("/api/open?link=method-fr", api)[0], 200)   # the method document
        self.assertEqual(self.opened.pop(), "https://github.com/darkxander/EnergIA/blob/main/METHOD.fr.md")
        for bad in ("/api/open", "/api/open?link=autre", "/api/open?link=https://example.com"):
            self.assertEqual(self.get(bad, api)[0], 404, bad)
        self.assertEqual(self.get("/api/open?link=source")[0], 403)  # without the header
        self.assertEqual(len(self.opened), 1)

    def post(self, path, headers=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers or {}, data=b"", method="POST")
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                return r.status, r.headers.get("X-Filename"), r.read()
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None, b""

    def test_pick_sends_the_chosen_file(self):
        api = {"X-EnergIA": "1"}
        self.assertEqual(self.post("/api/pick", api)[0], 204)  # cancelled
        self.assertEqual(self.pick_langs, ["fr"])  # the prompt follows the page's language
        export = os.path.join(self.dir.name, "mon export é.json")
        with open(export, "w") as f:
            f.write('[{"chat_messages": []}]')
        self.picked = export
        self.assertEqual(self.post("/api/pick", api), (200, "mon%20export%20%C3%A9.json", b'[{"chat_messages": []}]'))
        self.picked = os.path.join(self.dir.name, "c.json.absent")
        self.assertEqual(self.post("/api/pick", api)[0], 400)   # wrong extension
        self.picked = os.path.join(self.dir.name, "absent.zip")
        self.assertEqual(self.post("/api/pick", api)[0], 400)   # file not found
        self.picked = export
        self.assertEqual(self.post("/api/pick")[0], 403)        # without the header

    def test_export_saves_the_csv(self):
        api = {"X-EnergIA": "1", "Content-Type": "text/csv"}
        text = "\ufeffJour;Énergie (Wh)\r\n2026-11-25;0,61\r\n".encode()
        folder = os.path.join(self.dir.name, "Downloads")
        status, _, body = self.get("/api/export", api, text)
        first = os.path.join(folder, "EnergIA-2026-11-25.csv")
        self.assertEqual((status, json.loads(body)["path"]), (200, first))
        with open(first, "rb") as f:
            self.assertEqual(f.read(), text)
        # A second export on the same day does not replace the first.
        second = os.path.join(folder, "EnergIA-2026-11-25-2.csv")
        self.assertEqual(json.loads(self.get("/api/export", api, b"a;b\r\n")[2])["path"], second)
        with open(first, "rb") as f:
            self.assertEqual(f.read(), text)
        self.assertEqual(self.revealed, [first, second])     # shown in the Finder
        self.assertEqual(self.get("/api/export", {"Content-Type": "text/csv"}, text)[0], 403)  # without the header
        self.assertEqual(self.get("/api/export", api, b"\xff\xfe\x00")[0], 400)                 # not text
        self.assertEqual(sorted(os.listdir(folder)), ["EnergIA-2026-11-25-2.csv", "EnergIA-2026-11-25.csv"])
        # The summary image: a PNG, recognised by its signature.
        png = {"X-EnergIA": "1", "Content-Type": "image/png"}
        image = os.path.join(folder, "EnergIA-2026-11-25.png")
        self.assertEqual(json.loads(self.get("/api/export", png, b"\x89PNG\r\n\x1a\nabc")[2])["path"], image)
        with open(image, "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG\r\n\x1a\nabc")
        self.assertEqual(self.get("/api/export", png, b"pas une image")[0], 400)
        # The team file: JSON, and nothing else under that type.
        team = {"X-EnergIA": "1", "Content-Type": "application/json"}
        saved = os.path.join(folder, "EnergIA-2026-11-25.json")
        self.assertEqual(json.loads(self.get("/api/export", team, b'{"format": "energia-team"}')[2])["path"], saved)
        self.assertEqual(self.get("/api/export", team, b"{pas du json")[0], 400)
        os.remove(saved)
        # The monthly report: an HTML document.
        report = {"X-EnergIA": "1", "Content-Type": "text/html"}
        saved = os.path.join(folder, "EnergIA-2026-11-25.html")
        self.assertEqual(json.loads(self.get("/api/export", report, "<!doctype html><p>é</p>".encode())[2])["path"], saved)
        self.assertEqual(self.get("/api/export", report, b"\xff\xfe")[0], 400)
        os.remove(saved)
        self.assertEqual(len(os.listdir(folder)), 3)
        self.dash.window = False  # server-only mode: the browser downloads by itself
        self.assertEqual(self.get("/api/export", api, text)[0], 404)

    def test_guards_and_static(self):
        self.assertEqual(self.get("/api/claudecode")[0], 403)                      # without the header
        self.assertEqual(self.get("/", {"Host": "evil.example"})[0], 403)          # wrong Host
        self.assertEqual(self.get("/api/nope", {"X-EnergIA": "1"})[0], 404)
        self.assertEqual(self.get("/api/settings", {"X-EnergIA": "1"}, b"pas du json")[0], 400)
        status, ctype, body = self.get("/")
        self.assertEqual((status, ctype), (200, "text/html; charset=utf-8"))
        self.assertIn(b"EnergIA", body)
        self.assertEqual(self.get("/src/app.js")[1], "text/javascript; charset=utf-8")
        self.assertEqual(self.get("/src/defaults.json")[1], "application/json")
        for path in ("/EnergIA.py", "/menubar/server.py", "/src/../EnergIA.py", "/src/%2e%2e/EnergIA.py",
                     "/test/EnergIA.test.js", "/.claude/launch.json", "/src/absent.js"):
            self.assertEqual(self.get(path)[0], 404, path)


class FakeWin32:
    """Stands in for Windows: records what the icon asks for, and delivers posted
    messages to the window procedure the way a message loop would."""

    taskbar_created = 0xC123

    def __init__(self, add_works=True):
        import queue
        self.calls, self.queue, self.handler, self.menu_choice, self.add_works = [], queue.Queue(), None, 0, add_works

    def load_icon(self, path):
        return os.path.basename(path)

    def create_window(self, handler):
        self.handler = handler
        return 42

    def notify(self, action, hwnd, icon, tip):
        self.calls.append((action, icon, tip))
        return self.add_works or action != tray.NIM_ADD

    def popup_menu(self, hwnd, items):
        self.calls.append(("menu", [text for _, text in items]))
        return self.menu_choice

    def post(self, hwnd, message):
        self.queue.put(message)

    def destroy(self, hwnd):
        self.handler(hwnd, tray.WM_DESTROY, 0, 0)

    def default(self, hwnd, message, wparam, lparam):
        if message == tray.WM_CLOSE:
            self.destroy(hwnd)
        return 0

    def quit_loop(self):
        self.queue.put(None)

    def loop(self):
        while True:
            message = self.queue.get()
            if message is None:
                return
            self.handler(42, message, 0, 0)


class TrayTest(unittest.TestCase):
    def test_structure_layout(self):
        import ctypes
        data = tray.notify_struct()
        # 976 bytes on 64-bit Windows, where a character takes 2 bytes; elsewhere only
        # the 448 characters of the three text fields change the size.
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            self.assertEqual(ctypes.sizeof(data), 976 + 448 * (ctypes.sizeof(ctypes.c_wchar) - 2))
        self.assertEqual(data.szTip.size, 128 * ctypes.sizeof(ctypes.c_wchar))

    def test_icon_files(self):
        import struct
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "tools"))
        import make_icons
        files = []
        for over, path in tray.ICONS.items():
            with open(path, "rb") as f:
                data = f.read()
            files.append(data)
            self.assertEqual(struct.unpack("<HHH", data[:6]), (0, 1, len(make_icons.SIZES)))
            # The committed files are the ones the generator draws.
            self.assertEqual(data, make_icons.icon(make_icons.ICONS[os.path.basename(path)]), path)
        self.assertNotEqual(*files)

    def test_icon_follows_the_readings_and_the_clicks(self):
        api, opened, now = FakeWin32(), [], [100.0]
        icon = tray.Tray("fr", lambda: opened.append(1), api=api, clock=lambda: now[0])
        self.assertTrue(icon.start())
        self.assertEqual(api.calls, [(tray.NIM_ADD, "energia.ico", "EnergIA – … aujourd'hui")])

        def settle():  # lets the fake message loop deliver what was posted
            import time
            deadline = time.time() + 2
            while not api.queue.empty() and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.02)

        icon.update("523 Wh", False)
        settle()
        self.assertEqual(api.calls[-1], (tray.NIM_MODIFY, "energia.ico", "EnergIA – 523 Wh aujourd'hui"))
        count = len(api.calls)
        icon.update("523 Wh", False)   # nothing new: Windows is not asked again
        settle()
        self.assertEqual(len(api.calls), count)
        icon.update("1,2 kWh", True)   # above a threshold: the red icon
        settle()
        self.assertEqual(api.calls[-1], (tray.NIM_MODIFY, "energia-over.ico", "EnergIA – 1,2 kWh aujourd'hui (seuil dépassé)"))

        # A click opens the dashboard; the second click of a double click does not open it twice.
        api.handler(42, tray.TRAY_EVENT, 0, tray.WM_LBUTTONUP)
        api.handler(42, tray.TRAY_EVENT, 0, tray.WM_LBUTTONUP)
        self.assertEqual(len(opened), 1)
        now[0] += 5
        api.handler(42, tray.TRAY_EVENT, 0, tray.WM_LBUTTONUP)
        self.assertEqual(len(opened), 2)

        # Explorer restarted: the icon is added again, in its current state.
        api.handler(42, api.taskbar_created, 0, 0)
        self.assertEqual(api.calls[-1][:2], (tray.NIM_ADD, "energia-over.ico"))

        # Right click: the menu; "Open" opens, "Quit" removes the icon and ends the loop.
        now[0] += 5
        api.menu_choice = tray.MENU_OPEN
        api.handler(42, tray.TRAY_EVENT, 0, tray.WM_RBUTTONUP)
        self.assertEqual((api.calls[-1], len(opened)), (("menu", ["Ouvrir le tableau de bord", "Quitter EnergIA"]), 3))
        self.assertFalse(icon.closed.is_set())
        api.menu_choice = tray.MENU_QUIT
        api.handler(42, tray.TRAY_EVENT, 0, tray.WM_RBUTTONUP)
        self.assertTrue(icon.closed.wait(2))
        self.assertEqual(api.calls[-1][0], tray.NIM_DELETE)
        icon.update("2 kWh", False)    # after the end: no error, nothing sent
        icon.close()

    def test_close_from_another_thread_and_english(self):
        api = FakeWin32()
        icon = tray.Tray("en", lambda: None, api=api)
        self.assertTrue(icon.start())
        self.assertEqual(api.calls[0][2], "EnergIA – … today")
        icon.close()                   # what Ctrl+C does
        self.assertTrue(icon.closed.wait(2))
        self.assertEqual(api.calls[-1][0], tray.NIM_DELETE)

    def test_failed_icon_does_not_stop_the_dashboard(self):
        icon = tray.Tray("fr", lambda: None, api=FakeWin32(add_works=False))
        self.assertFalse(icon.start())
        self.assertTrue(icon.closed.is_set())
        self.assertIsInstance(icon.error, OSError)

        # In the "server only" mode: a message, then the program keeps serving.
        import io

        class Broken:
            error = "raison"
            def __init__(self, lang, on_open): pass
            def start(self): return False

        out, waited = io.StringIO(), []
        self.assertEqual(server.serve_only(0, browser=False, out=out, wait=lambda: waited.append(1), tray=Broken), 0)
        self.assertEqual(waited, [1])
        self.assertIn("raison", out.getvalue())

    def test_server_only_mode_feeds_the_icon(self):
        import io
        import threading
        seen = []

        class Icon:
            def __init__(self, lang, on_open):
                self.closed = threading.Event()
            def start(self): return True
            def update(self, energy, over):
                seen.append((energy, over))
                self.closed.set()      # as if "Quit" had been chosen
            def close(self): pass

        old, server.TRAY_REFRESH = server.TRAY_REFRESH, 0.01
        try:
            self.assertEqual(server.serve_only(0, browser=False, out=io.StringIO(), tray=Icon), 0)
        finally:
            server.TRAY_REFRESH = old
        self.assertEqual(len(seen), 1)
        self.assertIsInstance(seen[0][0], str)
        self.assertIn(seen[0][1], (True, False))
        self.assertTrue(server.parse_args(["--serve", "--no-tray"]).no_tray)
        self.assertFalse(server.parse_args(["--serve"]).no_tray)
        if sys.platform != "win32":
            self.assertIsNone(server.windows_tray("fr", lambda: None))


if __name__ == "__main__":
    unittest.main()
