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
    // Réponse régénérée : même parent que a2, compte aussi.
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

test("estimation des tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcde"), 2);
});

test("export ChatGPT", () => {
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

test("export ChatGPT : une réponse en plusieurs messages compte pour un seul tour", () => {
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
      t1: { parent: "u1", message: part("assistant", "thoughts", "b".repeat(200), 1750000001) },        // sans modèle
      r1: { parent: "t1", message: part("assistant", "reasoning_recap", "c".repeat(40), 1750000002) },  // sans modèle
      a1: { parent: "r1", message: part("assistant", "text", "d".repeat(800), 1750000003, { model_slug: "gpt-5-thinking" }) },
      u2: { parent: "a1", message: part("user", "text", "e".repeat(40), 1750000010) },
      a2: { parent: "u2", message: part("assistant", "text", "f".repeat(400), 1750000011, { model_slug: "auto", resolved_model_slug: "gpt-5-2" }) },
    },
  }]);
  const byModel = Object.fromEntries(out.rows.map((r) => [r.model, r]));
  assert.deepEqual(Object.keys(byModel).sort(), ["gpt-5-2", "gpt-5-thinking"]);
  const thinking = byModel["gpt-5-thinking"];
  assert.deepEqual([thinking.requests, thinking.responses, thinking.inTok, thinking.outTok], [1, 1, 100, 50 + 10 + 200]);
  const next = byModel["gpt-5-2"]; // le modèle réellement utilisé, pas « auto »
  assert.deepEqual([next.requests, next.responses, next.inTok, next.outTok], [1, 1, 100 + 260 + 10, 100]);
});

test("export Claude", () => {
  const out = parseExport(claudeExport);
  assert.equal(out.source, "claude");
  assert.equal(out.rows.length, 2);
  const [d1, d2] = out.rows.sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual([d1.day, d1.requests, d1.inTok, d1.outTok], ["2026-03-01", 1, 100, 200]);
  assert.deepEqual([d2.day, d2.requests, d2.inTok, d2.outTok], ["2026-03-02", 1, 310, 100]);
});

test("format inconnu", () => {
  assert.equal(parseExport({ foo: 1 }), null);
  assert.equal(parseExport([{ foo: 1 }]), null);
});

test("catégories de modèles", () => {
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

test("modèle d'estimation", () => {
  const row = { day: "2026-03-01", source: "chatgpt", model: "modele-sans-prix", requests: 1, responses: 1, inTok: 2000, outTok: 300 };
  const m = rowMetrics(row, DEFAULT_SETTINGS);
  assert.ok(Math.abs(m.wh - 0.3) < 1e-9); // (300 + 2000 × 0,1) / 1000 × 0,6
  assert.ok(Math.abs(m.co2g - 0.12) < 1e-9);
  assert.ok(Math.abs(m.waterL - 0.0003) < 1e-12);
  assert.ok(Math.abs(m.eur - 0.008) < 1e-12);
  const total = summarize([row, row], DEFAULT_SETTINGS);
  assert.ok(Math.abs(total.wh - 0.6) < 1e-9);
  assert.equal(total.requests, 2);
  const settings = { ...DEFAULT_SETTINGS, subs: { chatgpt: 20, claude: 0 } };
  assert.equal(subscriptionCost([row, { ...row, day: "2026-04-02" }], settings), 40);
});

test("prix réels par modèle", () => {
  const million = { day: "2026-11-01", source: "claudecode", requests: 0, responses: 1,
    inTok: 1e6, cw5Tok: 1e6, cw1Tok: 1e6, cacheTok: 1e6, outTok: 1e6 };
  const eur = (model, extra = {}) => rowMetrics({ ...million, model, ...extra }, DEFAULT_SETTINGS).eur / DEFAULT_SETTINGS.eurPerUsd;
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(eur("claude-opus-5-5"), 4 + 5 + 8 + 0.2 + 20);
  close(eur("claude-fable-5-2"), 8 + 10 + 16 + 0.2 + 40);
  close(eur("claude-fable-5"), 10 + 12.5 + 20 + 1 + 50);
  close(eur("claude-haiku-4-5-20251001"), 1 + 1.25 + 2 + 0.1 + 5); // suffixe de date ignoré
  close(eur("claude-haiku-5-5-long"), 0.5 + 0.625 + 1 + 0.05 + 2.5);
  close(eur("claude-sonnet-5-5", { searches: 1000 }), 2 + 2.5 + 4 + 0.1 + 10 + 10);
  // Modèles OpenAI : pas d'écriture de cache facturée à part ; lecture de cache au tarif "cached".
  close(eur("gpt-4o"), 2.5 * 3 + 1.25 + 10);
  close(eur("gpt-5-pro"), 15 * 4 + 120); // pas de tarif de cache publié
  // Noms tels qu'écrits dans l'export ChatGPT.
  assert.equal(priceFor("gpt-4-1"), priceFor("gpt-4.1"));
  assert.deepEqual(priceFor("gpt-5-thinking"), { in: 1.25, out: 10, read: 0.125 });
  assert.equal(priceFor("gpt-5-1-instant"), priceFor("gpt-5-1"));
  assert.equal(priceFor("gpt-5-t-mini"), priceFor("gpt-5-mini"));
  assert.equal(priceFor("gpt-6-2-astra").out, 40);
  for (const unknown of ["o3-mini-high", "o4-mini", "gpt-4", "text-davinci-002-render-sha", "claude", "inconnu", ""]) {
    assert.equal(priceFor(unknown), null, unknown); // repli sur le tarif indicatif de la catégorie
  }
  // Énergie : les écritures de cache comptent comme des tokens lus ordinaires.
  const wh = rowMetrics({ ...million, model: "claude-sonnet-5-5" }, DEFAULT_SETTINGS).wh;
  close(wh, ((1e6 + (3e6 + 1e6 * 0.02) * 0.1) / 1000) * 0.6);
});

test("lecture d'une archive zip", async () => {
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
