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
            user("q1"), assistant("m1"), assistant("m1"),  # même réponse écrite deux fois
            user("meta", isMeta=True), user("side", isSidechain=True),
            json.dumps({"type": "user", "uuid": "t1", "message": {"content": [{"type": "tool_result"}]}}),
            assistant("syn", model="<synthetic>"), "ligne illisible {",
        ])
        self.write(os.path.join(self.root, "-p", "s", "subagents", "agent.jsonl"),
                   [assistant("m1"), assistant("m2", model="claude-haiku-5-5")])  # m1 recopié
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
        self.assertFalse(store.scan())  # rien de nouveau

        # Une requête lue seule, puis sa réponse au passage suivant ; ligne en cours d'écriture ignorée.
        self.write(self.log, [user("q2")])
        store.scan()
        self.write(self.log, [assistant("m3"), assistant("m4")[:40]], end="")
        store.scan()
        row = {r["model"]: r for r in store.rows()}["claude-sonnet-5-5"]
        self.assertEqual((row["requests"], row["responses"]), (2, 2))

        # Le cache redonne les mêmes compteurs sans rien recompter.
        again = UsageStore(self.root, self.cache)
        self.assertEqual(again.rows(), store.rows())
        self.assertFalse(again.scan())
        self.assertEqual(again.rows(), store.rows())

    def test_cache_durations_dates_and_long_haiku(self):
        self.write(self.log, [
            assistant("a", model="claude-haiku-4-5-20251001", cache_creation={"ephemeral_1h_input_tokens": 60},
                      server_tool_use={"web_search_requests": 2}),
            assistant("b", model="claude-haiku-5-5", cache_read_input_tokens=99_900),   # 100 000 tout juste
            assistant("c", model="claude-haiku-5-5", cache_read_input_tokens=99_901),   # au-delà
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
        self.write(os.path.join(logs, "s.jsonl"), [user("q2"), assistant("m2"), assistant("m1")])  # m1 déjà compté
        self.write(os.path.join(cowork, "org", "user", "local_1", "audit.jsonl"), [assistant("m9")])  # pas un journal
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
        # Claude Code déplacé par sa variable d'environnement.
        self.assertEqual(paths.locate("linux", {"CLAUDE_CONFIG_DIR": "/x"}, "/home/a")["claudecode"], j("/x", "projects"))


class EstimateTest(unittest.TestCase):
    def test_same_numbers_as_model_js(self):
        settings = estimate.load_settings("/nonexistent")
        row = {"model": "gpt-4o", "inTok": 2000, "outTok": 300}
        self.assertAlmostEqual(estimate.wh(row, settings), 0.3)
        cached = {"model": "claude-sonnet-5-5", "inTok": 0, "cacheTok": 100000, "outTok": 0}
        self.assertAlmostEqual(estimate.wh(cached, settings), 0.12)  # 100 000 × 0,02 × 0,1 / 1000 × 0,6
        for model, tier in [("gpt-4o-mini", "leger"), ("claude-haiku-5-5", "leger"), ("claude-fable-5-2", "grand"),
                            ("claude-opus-5-5", "grand"), ("o3", "raisonnement"), ("gpt-5-pro", "raisonnement"),
                            ("claude-sonnet-5-5", "standard"), ("claude", "standard")]:
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

    def test_language(self):
        # macOS : français si c'est la première langue préférée, anglais sinon.
        self.assertEqual(estimate.system_lang(lambda: '(\n    "fr-FR",\n    "en-FR"\n)'), "fr")
        self.assertEqual(estimate.system_lang(lambda: '(\n    "en-GB",\n    "fr-FR"\n)'), "en")
        self.assertEqual(estimate.system_lang(lambda: ""), "en")
        # Linux (variable LANG) et Windows (nom de locale).
        self.assertEqual(estimate.system_lang(lambda: "fr_FR.UTF-8"), "fr")
        self.assertEqual(estimate.system_lang(lambda: "en_US.UTF-8"), "en")
        self.assertEqual(estimate.system_lang(lambda: "French_France"), "fr")
        self.assertEqual(estimate.system_lang(lambda: "C"), "en")
        # La langue choisie dans la page l'emporte sur celle du système.
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
            self.assertNotIn("lang", s)  # seules « fr » et « en » sont acceptées
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
            store.refresh()  # relevé récent : pas de nouvel appel
            self.assertEqual((len(calls), store.current()), (1, {"date": "2026-11-24", "eurPerUsd": 0.9122}))
            now[0] += rate.MAX_AGE + 1
            store.refresh()  # échec : l'ancien taux reste
            store.refresh()  # pas de nouvelle tentative avant RETRY
            self.assertEqual((len(calls), store.current()["eurPerUsd"]), (2, 0.9122))
            self.assertEqual(rate.RateStore(cache, fetch).current()["eurPerUsd"], 0.9122)  # relu du cache
            now[0] += rate.RETRY + 1
            store.refresh()
            self.assertEqual(store.current(), {"date": "2026-11-26", "eurPerUsd": 0.8})


class GateTest(unittest.TestCase):
    def test_title_waits_for_closed_popover(self):
        now = [0.0]
        gate = server.TitleGate(beat_timeout=4, clock=lambda: now[0])
        gate.offer("a")
        self.assertEqual(gate.take(), "a")
        self.assertIsNone(gate.take())  # inchangé : pas renvoyé
        gate.beat()
        gate.offer("b")
        self.assertIsNone(gate.take())  # fenêtre ouverte
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
                                     picker=self.pick)
        self.picked = None
        self.pick_langs = []
        estimate._system_lang = "fr"  # indépendant de la langue de la machine de test
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
        # (1000 + (100 + 1000 × 0,02) × 0,1) / 1000 × 0,6 = 0,607 Wh
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
        # La page envoie sa langue avec les réglages : le titre passe au point décimal.
        status, _, _ = self.get("/api/settings", {**api, "Content-Type": "application/json"},
                                json.dumps({"tiers": {"standard": {"whOut": 6}}, "lang": "en"}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(self.dash.title(), "⚡ 6.07 Wh")
        # Seuil d'énergie par jour : le point rouge remplace l'éclair quand il est dépassé.
        post = lambda saved: self.get("/api/settings", {**api, "Content-Type": "application/json"},
                                      json.dumps(saved).encode())[0]
        self.assertEqual(post({"dailyBudgetWh": 0.5}), 200)
        self.assertEqual(self.dash.title(), "🔴 0,61 Wh")
        self.assertEqual(post({"dailyBudgetWh": 5}), 200)
        self.assertEqual(self.dash.title(), "⚡ 0,61 Wh")
        self.assertEqual(post({"dailyBudgetWh": 0}), 200)   # 0 : pas de seuil
        self.assertEqual(self.dash.title(), "⚡ 0,61 Wh")

    def test_server_only_mode(self):
        api = {"X-EnergIA": "1"}
        # Fenêtre de SwiftBar par défaut ; le mode « serveur seul » dit à la page qu'elle
        # est dans un vrai navigateur (sélecteur de fichier et liens ordinaires).
        self.assertEqual(json.loads(self.get("/api/beat", api)[2]), {"ok": True, "window": True})
        self.dash.window = False
        self.assertEqual(json.loads(self.get("/api/beat", api)[2]), {"ok": True, "window": False})

        args = server.parse_args(["--serve", "--port", "1234", "--no-browser"])
        self.assertEqual((args.serve, args.port, args.no_browser), (True, 1234, True))
        self.assertFalse(server.parse_args([]).serve)                 # SwiftBar : aucun argument
        self.assertFalse(server.parse_args(["argument-inconnu"]).serve)

        # Port déjà pris : message clair et code de sortie 1, sans lever d'exception.
        import io
        out = io.StringIO()
        self.assertEqual(server.serve_only(self.port, browser=False, out=out), 1)
        self.assertIn(str(self.port), out.getvalue())

    def test_open_only_known_links(self):
        api = {"X-EnergIA": "1"}
        self.assertEqual(self.get("/api/open?link=sponsor", api)[0], 200)
        self.assertEqual(self.opened, ["https://github.com/sponsors/darkxander"])
        for bad in ("/api/open", "/api/open?link=autre", "/api/open?link=https://example.com"):
            self.assertEqual(self.get(bad, api)[0], 404, bad)
        self.assertEqual(self.get("/api/open?link=source")[0], 403)  # sans en-tête
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
        self.assertEqual(self.post("/api/pick", api)[0], 204)  # annulé
        self.assertEqual(self.pick_langs, ["fr"])  # l'invite suit la langue de la page
        export = os.path.join(self.dir.name, "mon export é.json")
        with open(export, "w") as f:
            f.write('[{"chat_messages": []}]')
        self.picked = export
        self.assertEqual(self.post("/api/pick", api), (200, "mon%20export%20%C3%A9.json", b'[{"chat_messages": []}]'))
        self.picked = os.path.join(self.dir.name, "c.json.absent")
        self.assertEqual(self.post("/api/pick", api)[0], 400)   # mauvaise extension
        self.picked = os.path.join(self.dir.name, "absent.zip")
        self.assertEqual(self.post("/api/pick", api)[0], 400)   # fichier introuvable
        self.picked = export
        self.assertEqual(self.post("/api/pick")[0], 403)        # sans en-tête

    def test_guards_and_static(self):
        self.assertEqual(self.get("/api/claudecode")[0], 403)                      # sans en-tête
        self.assertEqual(self.get("/", {"Host": "evil.example"})[0], 403)          # mauvais Host
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


if __name__ == "__main__":
    unittest.main()
