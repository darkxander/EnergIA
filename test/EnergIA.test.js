import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listZipEntries, readZipEntryText } from "../src/zip.js";
import { parseExport, estimateTokens } from "../src/parsers.js";
import { DEFAULT_SETTINGS, classifyModel, priceFor, rowMetrics, summarize, subscriptionCost } from "../src/model.js";

const msg = (role, text, time, extra = {}) => ({
  author: { role }, create_time: time, content: { content_type: "text", parts: [text] }, metadata: extra,
});

const chatgptExport = [{
  title: "Test", create_time: 1750000000,
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["u1"] },
    u1: { id: "u1", parent: "root", message: msg("user", "a".repeat(400), 1750000000) },
    a1: { id: "a1", parent: "u1", message: msg("assistant", "b".repeat(800), 1750000010, { model_slug: "gpt-4o" }) },
    u2: { id: "u2", parent: "a1", message: msg("user", "c".repeat(40), 1750000020) },
    a2: { id: "a2", parent: "u2", message: msg("assistant", "d".repeat(400), 1750000030, { model_slug: "o3" }) },
    // Regenerated response: same parent as a2, counts too.
    a2b: { id: "a2b", parent: "u2", message: msg("assistant", "e".repeat(400), 1750000040, { model_slug: "o3" }) },
  },
}];

const claudeExport = [{
  uuid: "x", name: "Test", created_at: "2026-03-01T10:00:00Z",
  chat_messages: [
    { sender: "human", text: "a".repeat(400), created_at: "2026-03-01T10:00:00Z" },
    { sender: "assistant", content: [{ type: "text", text: "b".repeat(800) }], text: "b".repeat(800), created_at: "2026-03-01T10:00:05Z" },
    { sender: "human", text: "c".repeat(40), created_at: "2026-03-02T10:00:00Z" },
    { sender: "assistant", text: "d".repeat(400), created_at: "2026-03-02T10:00:05Z" },
  ],
}];

test("token estimation", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcde"), 2);
});

test("ChatGPT export", () => {
  const out = parseExport(chatgptExport);
  assert.equal(out.source, "chatgpt");
  assert.equal(out.conversations, 1);
  const gpt4o = out.rows.find((r) => r.model === "gpt-4o");
  assert.deepEqual({ ...gpt4o, day: undefined }, { day: undefined, source: "chatgpt", model: "gpt-4o", requests: 1, responses: 1, inTok: 100, outTok: 200 });
  const o3 = out.rows.find((r) => r.model === "o3");
  assert.equal(o3.requests, 1);
  assert.equal(o3.responses, 2);
  assert.equal(o3.inTok, 2 * (100 + 200 + 10));
  assert.equal(o3.outTok, 200);
  assert.equal(gpt4o.day, "2025-06-15");
});

test("ChatGPT export: a response in several messages counts as a single turn", () => {
  const part = (role, type, text, time, extra = {}) => ({
    author: { role }, create_time: time, metadata: extra,
    content: type === "thoughts" ? { content_type: type, thoughts: [{ summary: "s", content: text }] }
      : type === "reasoning_recap" ? { content_type: type, content: text }
        : { content_type: type, parts: [text] },
  });
  const out = parseExport([{
    create_time: 1750000000, default_model_slug: "gpt-5",
    mapping: {
      root: { message: null, parent: null },
      u1: { parent: "root", message: part("user", "text", "a".repeat(400), 1750000000) },
      t1: { parent: "u1", message: part("assistant", "thoughts", "b".repeat(200), 1750000001) },        // no model
      r1: { parent: "t1", message: part("assistant", "reasoning_recap", "c".repeat(40), 1750000002) },  // no model
      a1: { parent: "r1", message: part("assistant", "text", "d".repeat(800), 1750000003, { model_slug: "gpt-5-thinking" }) },
      u2: { parent: "a1", message: part("user", "text", "e".repeat(40), 1750000010) },
      a2: { parent: "u2", message: part("assistant", "text", "f".repeat(400), 1750000011, { model_slug: "auto", resolved_model_slug: "gpt-5-2" }) },
    },
  }]);
  const byModel = Object.fromEntries(out.rows.map((r) => [r.model, r]));
  assert.deepEqual(Object.keys(byModel).sort(), ["gpt-5-2", "gpt-5-thinking"]);
  const thinking = byModel["gpt-5-thinking"];
  assert.deepEqual([thinking.requests, thinking.responses, thinking.inTok, thinking.outTok], [1, 1, 100, 50 + 10 + 200]);
  const next = byModel["gpt-5-2"]; // the model actually used, not "auto"
  assert.deepEqual([next.requests, next.responses, next.inTok, next.outTok], [1, 1, 100 + 260 + 10, 100]);
});

test("Claude export", () => {
  const out = parseExport(claudeExport);
  assert.equal(out.source, "claude");
  assert.equal(out.rows.length, 2);
  const [d1, d2] = out.rows.sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual([d1.day, d1.requests, d1.inTok, d1.outTok], ["2026-03-01", 1, 100, 200]);
  assert.deepEqual([d2.day, d2.requests, d2.inTok, d2.outTok], ["2026-03-02", 1, 310, 100]);
});

test("unknown format", () => {
  assert.equal(parseExport({ foo: 1 }), null);
  assert.equal(parseExport([{ foo: 1 }]), null);
});

test("model categories", () => {
  assert.equal(classifyModel("gpt-4o-mini"), "leger");
  assert.equal(classifyModel("gpt-4o"), "standard");
  assert.equal(classifyModel("o3"), "raisonnement");
  assert.equal(classifyModel("gpt-5-thinking"), "raisonnement");
  assert.equal(classifyModel("gpt-5-pro"), "raisonnement");
  assert.equal(classifyModel("claude"), "standard");
  assert.equal(classifyModel("gpt-6-luna"), "leger");
  assert.equal(classifyModel("gpt-6-2-astra"), "grand");
  assert.equal(classifyModel("gpt-6-2-sol"), "standard");
});

test("estimation model", () => {
  const row = { day: "2026-03-01", source: "chatgpt", model: "modele-sans-prix", requests: 1, responses: 1, inTok: 2000, outTok: 300 };
  const m = rowMetrics(row, DEFAULT_SETTINGS);
  assert.ok(Math.abs(m.wh - 0.3) < 1e-9); // (300 + 2000 × 0.1) / 1000 × 0.6
  assert.ok(Math.abs(m.co2g - 0.13749) < 1e-9); // 0.0003 kWh × 458.3 g (2025 world average)
  assert.ok(Math.abs(m.waterL - 0.0003) < 1e-12);
  assert.ok(Math.abs(m.eur - 0.008) < 1e-12);
  const total = summarize([row, row], DEFAULT_SETTINGS);
  assert.ok(Math.abs(total.wh - 0.6) < 1e-9);
  assert.equal(total.requests, 2);
  const settings = { ...DEFAULT_SETTINGS, subs: { chatgpt: 20, claude: 0 } };
  assert.equal(subscriptionCost([row, { ...row, day: "2026-04-02" }], settings), 40);
});

test("actual prices per model", () => {
  const million = { day: "2026-11-01", source: "claudecode", requests: 0, responses: 1,
    inTok: 1e6, cw5Tok: 1e6, cw1Tok: 1e6, cacheTok: 1e6, outTok: 1e6 };
  const eur = (model, extra = {}) => rowMetrics({ ...million, model, ...extra }, DEFAULT_SETTINGS).eur / DEFAULT_SETTINGS.eurPerUsd;
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(eur("claude-opus-5-5"), 4 + 5 + 8 + 0.2 + 20);
  close(eur("claude-fable-5-2"), 8 + 10 + 16 + 0.2 + 40);
  close(eur("claude-fable-5"), 10 + 12.5 + 20 + 1 + 50);
  close(eur("claude-haiku-4-5-20251001"), 1 + 1.25 + 2 + 0.1 + 5); // date suffix ignored
  close(eur("claude-haiku-5-5-long"), 0.5 + 0.625 + 1 + 0.05 + 2.5);
  close(eur("claude-sonnet-5-5", { searches: 1000 }), 2 + 2.5 + 4 + 0.1 + 10 + 10);
  // OpenAI models: no cache writes billed separately; cache reads at the "cached" rate.
  close(eur("gpt-4o"), 2.5 * 3 + 1.25 + 10);
  close(eur("gpt-5-pro"), 15 * 4 + 120); // no cache rate published
  // Names as written in the ChatGPT export.
  assert.equal(priceFor("gpt-4-1"), priceFor("gpt-4.1"));
  assert.deepEqual(priceFor("gpt-5-thinking"), { in: 1.25, out: 10, read: 0.125 });
  assert.equal(priceFor("gpt-5-1-instant"), priceFor("gpt-5-1"));
  assert.equal(priceFor("gpt-5-t-mini"), priceFor("gpt-5-mini"));
  assert.equal(priceFor("gpt-6-2-astra").out, 40);
  // Old models withdrawn from the API: last published price.
  assert.deepEqual(priceFor("text-davinci-002-render-sha"), { in: 0.5, out: 1.5 }); // GPT-3.5 in ChatGPT
  assert.deepEqual(priceFor("o3-mini-high"), { in: 1.1, out: 4.4, read: 0.55 });
  assert.deepEqual(priceFor("o4-mini-high"), { in: 1.1, out: 4.4, read: 0.275 });
  assert.equal(priceFor("gpt-4-5").out, 150);
  assert.equal(priceFor("gpt-4").in, 30);
  // ChatGPT names with no official match to an API model.
  for (const unknown of ["gpt-6", "gpt-6-mini", "gpt-5-6", "gpt-5-3", "research", "auto", "claude", "inconnu", ""]) {
    assert.equal(priceFor(unknown), null, unknown); // falls back to the category's indicative rate
  }
  // Energy: cache writes count as ordinary read tokens.
  const wh = rowMetrics({ ...million, model: "claude-sonnet-5-5" }, DEFAULT_SETTINGS).wh;
  close(wh, ((1e6 + (3e6 + 1e6 * 0.02) * 0.1) / 1000) * 0.6);
});

test("reading a zip archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "EnergIA-"));
  writeFileSync(join(dir, "conversations.json"), JSON.stringify(claudeExport));
  writeFileSync(join(dir, "users.json"), "[]");
  execFileSync("zip", ["-q", "export.zip", "conversations.json", "users.json"], { cwd: dir });
  execFileSync("zip", ["-q", "-0", "stored.zip", "conversations.json"], { cwd: dir });
  for (const name of ["export.zip", "stored.zip"]) {
    const blob = new Blob([readFileSync(join(dir, name))]);
    const entries = await listZipEntries(blob);
    const entry = entries.find((e) => e.name === "conversations.json");
    assert.ok(entry, name);
    assert.equal(parseExport(JSON.parse(await readZipEntryText(blob, entry))).source, "claude");
  }
  await assert.rejects(listZipEntries(new Blob(["pas un zip"])));
});

test("i18n: same keys and same variables in French and in English", async () => {
  const { TEXTS, pickLang, translate } = await import("../src/i18n.js");
  assert.deepEqual(Object.keys(TEXTS.en).sort(), Object.keys(TEXTS.fr).sort());
  const variables = (text) => (text.match(/\{\w+\}/g) || []).sort();
  for (const key of Object.keys(TEXTS.fr)) {
    assert.deepEqual(variables(TEXTS.en[key]), variables(TEXTS.fr[key]), key);
  }

  // The saved choice wins; otherwise French for a browser in French, English elsewhere.
  assert.equal(pickLang("en", "fr-FR"), "en");
  assert.equal(pickLang(null, "fr-CA"), "fr");
  assert.equal(pickLang(null, "de-DE"), "en");
  assert.equal(pickLang("xx", ""), "en");

  assert.equal(translate("en", "tile.co2Equiv", { km: "5.74" }), "≈ 5.74 km by petrol car");
  assert.equal(translate("fr", "euro", { amount: "54,50" }), "54,50 €");
  assert.equal(translate("en", "euro", { amount: "54.50" }), "€54.50");
});

test("i18n: every text marked in index.html has its English version", async () => {
  const { PAGE_EN } = await import("../src/i18n.js");
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 30);
  for (const key of keys) assert.ok(PAGE_EN[key], key);
});

test("zip: errors carry a code that the interface translates", async () => {
  const { TEXTS } = await import("../src/i18n.js");
  await assert.rejects(listZipEntries(new Blob(["pas un zip, mais assez long pour être lu"])), { code: "zip.invalid" });
  await assert.rejects(readZipEntryText(new Blob([new Uint8Array(64)]), { offset: 0, compSize: 1, method: 99 }),
    { code: "zip.method", vars: { method: 99 } });
  for (const code of ["zip.invalid", "zip.method", "zip.noDecompression"]) assert.ok(TEXTS.fr[code] && TEXTS.en[code], code);
});

test("the page does without the JSON import syntax, absent from old browsers", () => {
  for (const file of ["app.js", "model.js", "parsers.js", "zip.js", "i18n.js"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^import .* with \{/m, file);
  }
});

test("index.html carries the version number of the current files (otherwise: node tools/stamp.mjs)", async () => {
  const { assetVersion, stamped } = await import("../tools/stamp.mjs");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(stamped(html, assetVersion()), html);
  assert.match(html, /src="src\/app\.js\?v=[0-9a-f]{8}"/);
});

test("carbon intensity: a sourced list of countries, with distinct values", async () => {
  const { CARBON, DEFAULT_SETTINGS } = await import("../src/model.js");
  const values = CARBON.countries.map((country) => country.g);
  assert.equal(new Set(values).size, values.length); // the chosen country is found again from its value
  for (const country of CARBON.countries) assert.ok(country.code && country.fr && country.en && country.g > 0, country.code);
  const byCode = Object.fromEntries(CARBON.countries.map((country) => [country.code, country.g]));
  assert.equal(byCode.WLD, DEFAULT_SETTINGS.gCO2PerKWh); // the default value is the world average
  assert.equal(byCode.FR, 41.4);
  assert.equal(byCode.US, 384.4);
  assert.ok(CARBON.source && CARBON.citation && CARBON.year);
});

test("alert thresholds: disabled by default", async () => {
  const { DEFAULT_SETTINGS } = await import("../src/model.js");
  for (const key of ["dailyBudgetWh", "monthlyBudgetKWh", "dailyBudgetEur", "monthlyBudgetEur"]) {
    assert.equal(DEFAULT_SETTINGS[key], 0, key);
  }
});

// Same rows and same results as in test/test_menubar.py: the plugin redoes this calculation.
test("cost: same figures as the plugin", async () => {
  const { DEFAULT_SETTINGS, rowMetrics } = await import("../src/model.js");
  const close = (row, expected) => assert.ok(Math.abs(rowMetrics(row, DEFAULT_SETTINGS).eur - expected) < 1e-9, row.model);
  close({ model: "claude-sonnet-5-5", inTok: 1000, cw5Tok: 200, cw1Tok: 300, cacheTok: 50000, outTok: 400, searches: 2 }, 0.02982894);
  close({ model: "gpt-5-thinking", inTok: 2000, outTok: 300 }, 0.0050171);
  close({ model: "modele-inconnu", inTok: 2000, cacheTok: 1000, outTok: 300 }, 0.00805);
});

test("CSV: separator and decimals according to the language, cells protected", async () => {
  const { csvText } = await import("../src/csv.js");
  const lines = [["Jour", "Modèle", "Énergie (Wh)"], ["2026-11-25", "gpt-4o", 0.607], ["2026-11-26", 'a;b "c"', 1234.5678912]];
  assert.equal(csvText(lines, "fr"),
    '\uFEFFJour;Modèle;Énergie (Wh)\r\n2026-11-25;gpt-4o;0,607\r\n2026-11-26;"a;b ""c""";1234,57\r\n');
  assert.equal(csvText(lines, "en"),
    '\uFEFFJour,Modèle,Énergie (Wh)\r\n2026-11-25,gpt-4o,0.607\r\n2026-11-26,"a;b ""c""",1234.57\r\n');
  // Six significant figures; whole numbers stay whole, small numbers without scientific notation.
  assert.equal(csvText([[1200, 1234567, 0, 0.00035964, 0.0000004, 1e-14]], "en"), "\uFEFF1200,1234567,0,0.00035964,0.0000004,0\r\n");
  // A text that starts like a formula must not be executed by the spreadsheet.
  assert.equal(csvText([["=SOMME(A1)", "-1", "@x", "a,b"]], "en"), "\uFEFF'=SOMME(A1),'-1,'@x,\"a,b\"\r\n");
});

test("summary image: wrapping texts into lines", async () => {
  const { wrapLines } = await import("../src/card.js");
  const measure = (text) => text.length; // one character = one unit of width
  assert.deepEqual(wrapLines(measure, "un deux trois", 20), ["un deux trois"]);
  assert.deepEqual(wrapLines(measure, "un deux trois quatre", 10), ["un deux", "trois qua…"]);
  assert.deepEqual(wrapLines(measure, "un deux trois quatre", 10, 3), ["un deux", "trois", "quatre"]);
  assert.deepEqual(wrapLines(measure, "", 10), []);
});

test("cumulative imports: a conversation is counted only once", async () => {
  const { combine, parseExport, rowsOf } = await import("../src/parsers.js");
  const conv = (id, updated, answers) => ({
    id, create_time: 1750000000, update_time: updated,
    mapping: Object.fromEntries([["root", { message: null, parent: null }], ...answers.flatMap((length, n) => [
      [`u${n}`, { parent: n ? `a${n - 1}` : "root", message: msg("user", "q".repeat(40), 1750000000 + n * 10) }],
      [`a${n}`, { parent: `u${n}`, message: msg("assistant", "r".repeat(length), 1750000001 + n * 10, { model_slug: "gpt-4o" }) }],
    ])]),
  });
  const requests = (items) => rowsOf("chatgpt", items).reduce((sum, row) => sum + row.requests, 0);
  const first = parseExport([conv("a", 100, [400]), conv("b", 100, [400])]);
  assert.equal(first.conversations, 2);
  assert.equal(Object.keys(first.items).length, 2);
  assert.ok(Object.keys(first.items).every((key) => /^[0-9a-f]{16}$/.test(key)), "clés anonymes");
  assert.ok(!JSON.stringify(first.items).includes('"a"'), "l'identifiant n'est pas gardé");
  assert.deepEqual(first.rows, rowsOf("chatgpt", first.items));

  // The same export a second time: nothing changes.
  const again = combine(first.items, first.items);
  assert.deepEqual([again.added, again.updated, again.same, requests(again.items)], [0, 0, 2, 2]);

  // A more recent export: "a" unchanged, "b" has grown, "c" is new.
  const second = parseExport([conv("a", 100, [400]), conv("b", 200, [400, 800]), conv("c", 200, [400])]);
  const merged = combine(first.items, second.items);
  assert.deepEqual([merged.added, merged.updated, merged.same], [1, 1, 1]);
  assert.equal(Object.keys(merged.items).length, 3);
  assert.equal(requests(merged.items), 4); // 1 + 2 + 1, and not 2 + 4

  // An older export imported afterwards does not overwrite the recent version,
  // and a conversation deleted since then is still counted.
  const back = combine(merged.items, parseExport([conv("b", 100, [400])]).items);
  assert.deepEqual([back.kept, requests(back.items)], [1, 4]);
  assert.deepEqual(first.items, parseExport([conv("a", 100, [400]), conv("b", 100, [400])]).items, "combine ne modifie pas l'existant");

  // Two files from another account: everything is added.
  const other = combine(merged.items, parseExport([conv("z", 50, [400])]).items);
  assert.deepEqual([other.added, requests(other.items)], [1, 5]);

  // Claude: the key comes from the uuid, and is not confused with ChatGPT's.
  const claude = parseExport(claudeExport);
  assert.equal(Object.keys(claude.items).length, 1);
  assert.deepEqual(combine(claude.items, parseExport(claudeExport).items).same, 1);
});

test("Copilot export: the two CSV layouts", async () => {
  const { parseCsv, parseFileText } = await import("../src/parsers.js");
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, ""y""\nz",2\r\n'), [["a", "b"], ['x, "y"\nz', "2"]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
  const q = "q".repeat(40);
  const history = parseFileText([
    "Conversation,Time,Author,Message",
    `Voyage,2026-02-17T14:36:11,user,${q}`,
    `Voyage,2026-02-17T14:36:20,AI,"${"r".repeat(400)}"`,
    `Voyage,2026-02-17T14:40:00,user,${q}`,
    `Voyage,2026-02-17T14:40:09,AI,${"r".repeat(200)}`,
    // Same title a month later: another conversation, the context starts again from zero.
    `Voyage,2026-03-20T10:00:00,user,${q}`,
    `Voyage,2026-03-20T10:00:09,AI,${"r".repeat(200)}`,
  ].join("\r\n"));
  assert.deepEqual([history.source, history.conversations], ["copilot", 2]);
  const [first, second] = history.rows.sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual([first.day, first.model, first.requests, first.inTok, first.outTok], ["2026-02-17", "copilot", 2, 10 + 120, 150]);
  assert.deepEqual([second.day, second.requests, second.inTok, second.outTok], ["2026-03-20", 1, 10, 50]);

  const chat = parseFileText(`CreatedAt,MessageContent,Author,ChatName\n2/17/2026 11:36:11 PM -02:00,${q},user,Chat\n2/17/2026 11:36:30 PM -02:00,${"r".repeat(400)},Copilot,Chat\n`);
  assert.deepEqual(chat.rows.map((r) => [r.day, r.requests, r.inTok, r.outTok]), [["2026-02-18", 1, 10, 100]]); // 23:36 at UTC−2

  const prompts = parseFileText("Timestamp,ClientApp,Prompt\n2026-01-01T00:00:00,App,bonjour\n");
  assert.deepEqual([prompts.promptsOnly, prompts.rows.length], [true, 0]); // requests only: nothing to count
  assert.equal(parseFileText("x,y\n1,2\n"), null);
});

test("Gemini export: the three forms described, and nothing else from `My Activity`", async () => {
  const { parseFileText } = await import("../src/parsers.js");
  const { classifyModel } = await import("../src/model.js");
  const q = "q".repeat(40);
  const events = [
    { header: "Gemini Apps", title: q, titleUrl: "https://gemini.google.com/app/abc123", time: "2026-05-01T10:00:00.000Z",
      products: ["Gemini Apps"], safeHtmlItem: [{ html: `<p>${"r".repeat(400)}</p>` }] },
    { header: "Gemini", title: "Used Gemini Apps", titleUrl: "https://gemini.google.com/app/c/abc123", time: "2026-05-01T10:05:00.000Z",
      products: ["Gemini Apps"], details: [{ name: "Request", value: q }, { name: "Response", value: "r".repeat(200) }] },
    { header: "Gemini", title: "Used Gemini Apps", time: "2026-05-02T10:05:00.000Z", products: ["Gemini Apps"],
      userInteractions: [{ userInteraction: { endpoint: "x", request: JSON.stringify({ text: q }), response: JSON.stringify({ parts: [{ text: "r".repeat(200) }] }) } }] },
    { header: "YouTube", title: "Watched x", time: "2026-05-02T10:05:00.000Z", products: ["YouTube"] },
    { header: "Gemini", title: "Used Gemini Apps", time: "2026-05-03T10:05:00.000Z", products: ["Gemini Apps"] }, // neither request nor response
  ];
  const out = parseFileText(JSON.stringify(events));
  assert.deepEqual([out.source, out.conversations], ["gemini", 2]); // the first two share a link
  const [first, second] = out.rows.sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual([first.day, first.model, first.requests, first.inTok, first.outTok], ["2026-05-01", "gemini", 2, 10 + (10 + 100 + 10), 150]);
  assert.deepEqual([second.day, second.requests, second.inTok, second.outTok], ["2026-05-02", 1, 10, 50]);
  assert.equal(parseFileText(JSON.stringify([events[3]])), null);
  assert.equal(classifyModel("gemini"), "standard"); // "gemini" contains "mini" without being a light model
  assert.equal(classifyModel("o3-mini"), "leger");
});

test("install.sh: valid syntax, and no variable stuck to an accented character", () => {
  const path = new URL("../install.sh", import.meta.url);
  execFileSync("sh", ["-n", path.pathname]);
  // "$DOSSIER…": some shells take the non-ASCII character as the continuation of the name.
  assert.deepEqual(readFileSync(path, "utf8").match(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/g), null);
});

test("team file: counters only, and a file received is read with caution", async () => {
  const { parseFileText, teamFile } = await import("../src/parsers.js");
  const row = (extra) => ({ day: "2026-11-01", source: "chatgpt", model: "gpt-4o", requests: 2, responses: 2, inTok: 10, outTok: 20, ...extra });
  const file = teamFile("Alice", [row(), row({ cacheTok: 7 }), row({ day: "2026-11-02", source: "claudecode", model: "claude-opus-5-5" })], "2026-11-27T10:00:00.000Z");
  assert.deepEqual(Object.keys(file), ["format", "version", "member", "exportedAt", "rows"]);
  // Same day, service and model: one line, counters added up.
  assert.deepEqual(file.rows[0], { day: "2026-11-01", source: "chatgpt", model: "gpt-4o", requests: 4, responses: 4, inTok: 20, outTok: 40, cacheTok: 7 });
  assert.equal(file.rows.length, 2);

  const read = parseFileText(JSON.stringify(file));
  assert.deepEqual([read.team, read.member, read.exportedAt, read.rows.length], [true, "Alice", "2026-11-27T10:00:00.000Z", 2]);
  assert.deepEqual(read.rows[0], { day: "2026-11-01", source: "chatgpt", model: "gpt-4o", member: "Alice", requests: 4, responses: 4, inTok: 20, outTok: 40, cacheTok: 7 });

  // A file from someone else: malformed rows and implausible numbers are dropped.
  const odd = parseFileText(JSON.stringify({ format: "energia-team", member: "  Bob  ", exportedAt: "hier", rows: [
    row({ requests: -5, outTok: "beaucoup", inTok: 1e30, extra: "x" }), { day: "01/11/2026", source: "chatgpt", model: "m" },
    { day: "2026-11-01", source: 3, model: "m" }, null, "texte",
  ] }));
  assert.deepEqual([odd.member, odd.exportedAt, odd.rows.length], ["Bob", "", 1]);
  assert.deepEqual(odd.rows[0], { day: "2026-11-01", source: "chatgpt", model: "gpt-4o", member: "Bob", requests: 0, responses: 2, inTok: 0, outTok: 0 });
  assert.equal(parseFileText(JSON.stringify({ format: "energia-team", member: "", rows: [] })), null); // no name
  assert.equal(parseFileText(JSON.stringify({ format: "autre", rows: [] })), null);
});

test("monthly report: a standalone document in which every text is escaped", async () => {
  const { escapeHtml, reportHtml, shiftMonth } = await import("../src/report.js");
  assert.equal(escapeHtml(`<b a="1">&'`), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;");
  assert.deepEqual([shiftMonth("2026-11", 1), shiftMonth("2026-12", 1), shiftMonth("2026-01", -1), shiftMonth("2026-03", -5)],
    ["2026-12", "2027-01", "2025-12", "2025-10"]);
  const evil = '<img src=x onerror=alert(1)>';
  const html = reportHtml({
    lang: "fr", title: `Rapport ${evil}`, subtitle: evil,
    figures: [{ name: "Énergie", value: "1,1 kWh", detail: evil }],
    sections: [
      { heading: evil, paragraphs: [evil], note: evil, table: { headers: ["Membre", "Requêtes"], rows: [[evil, "12"], ["Bob & Co", "3"]] } },
      { heading: "Modèles", table: { headers: ["Service", "Modèle", "Coût"], textColumns: 2, rows: [["ChatGPT", "gpt-4o", "1 €"]] } },
    ],
    footer: evil,
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(!html.includes("<img") && !/<script/i.test(html), "nothing from the data becomes markup");
  assert.equal(html.split("&lt;img src=x onerror=alert(1)&gt;").length - 1, 9); // the title twice, and seven other places
  assert.ok(html.includes('<td class="text">Bob &amp; Co</td><td>3</td>'));
  assert.ok(html.includes('<td class="text">ChatGPT</td><td class="text">gpt-4o</td><td>1 €</td>')); // two text columns
  assert.ok(!/https?:\/\//.test(html), "no external resource");
});

test("organisation usage reports: the documented answers of the Anthropic and OpenAI usage APIs", async () => {
  const { combine, parseFileText, rowsOf } = await import("../src/parsers.js");
  // The example of the Anthropic API reference, plus a result without "group by model" and an empty day.
  const anthropic = {
    data: [
      { starting_at: "2025-08-01T00:00:00Z", ending_at: "2025-08-02T00:00:00Z", results: [
        { model: "claude-opus-5-5", uncached_input_tokens: 1500, cache_read_input_tokens: 200, output_tokens: 500,
          cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 }, server_tool_use: { web_search_requests: 10 } },
        { model: null, uncached_input_tokens: 5, output_tokens: 5 },
      ] },
      { starting_at: "2025-08-02T00:00:00Z", ending_at: "2025-08-03T00:00:00Z", results: [] },
    ],
    has_more: true, next_page: "page_x",
  };
  const read = parseFileText(JSON.stringify(anthropic));
  assert.deepEqual([read.source, read.conversations, read.rows.length], ["anthropicapi", 1, 2]); // one day with data
  assert.deepEqual(read.rows[0], { day: "2025-08-01", source: "anthropicapi", model: "claude-opus-5-5", requests: 0, responses: 0,
    inTok: 1500, outTok: 500, cw5Tok: 20, cw1Tok: 10, cacheTok: 200, searches: 10 });
  assert.equal(read.rows[1].model, "inconnu");

  // The example of the OpenAI API reference: input_tokens includes cached and cache-write tokens.
  const result = { object: "organization.usage.completions.result", input_tokens: 1000, input_cached_tokens: 400,
    input_cache_write_tokens: 100, input_uncached_tokens: 500, output_tokens: 500, num_model_requests: 5, model: "gpt-4o" };
  const openai = (results) => ({ object: "page", data: [{ object: "bucket", start_time: 1730419200, end_time: 1730505600, results }], has_more: false, next_page: null });
  const page = parseFileText(JSON.stringify(openai([result])));
  assert.deepEqual(page.rows, [{ day: "2024-11-01", source: "openaiapi", model: "gpt-4o", requests: 5, responses: 5,
    inTok: 500, outTok: 500, cw5Tok: 100, cacheTok: 400 }]);
  // An older answer without input_uncached_tokens: the uncached part is what remains.
  const { input_uncached_tokens, ...older } = result;
  assert.equal(parseFileText(JSON.stringify(openai([older]))).rows[0].inTok, 500);
  // Several pages in one file are added up; a day imported again replaces the previous one.
  const pages = parseFileText(JSON.stringify([openai([result]), openai([result])]));
  assert.equal(pages.rows[0].requests, 10);
  const merged = combine(pages.items, page.items);
  assert.deepEqual([Object.keys(merged.items).length, merged.updated, rowsOf("openaiapi", merged.items)[0].requests], [1, 1, 5]);
  assert.equal(parseFileText(JSON.stringify({ data: [{ foo: 1 }] })), null);
});

test("method document: both languages, the same structure, and the default values it quotes", () => {
  const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const [en, fr] = [read("METHOD.md"), read("METHOD.fr.md")];
  const headings = (text) => text.split("\n").filter((line) => /^#{1,3} /.test(line)).length;
  const links = (text) => [...text.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]).sort();
  assert.equal(headings(en), headings(fr));
  assert.deepEqual(links(en), links(fr)); // the same sources on both sides
  // The values quoted are the ones the code uses: update the document when a default changes.
  const s = DEFAULT_SETTINGS;
  assert.deepEqual([s.tiers.leger.whOut, s.tiers.standard.whOut, s.tiers.grand.whOut, s.tiers.raisonnement.whOut], [0.2, 0.6, 1.2, 2.5]);
  assert.deepEqual([s.inputRatio, s.cacheReadRatio, s.lowFactor, s.highFactor, s.gCO2PerKWh, s.waterLPerKWh], [0.1, 0.02, 0.5, 2, 458.3, 1]);
  for (const text of ["0.2 / 0.6 / 1.2 / 2.5 Wh", "458.3 g CO₂e/kWh", "1 L/kWh", "× 0.5 to × 2"]) assert.ok(en.includes(text), text);
});
