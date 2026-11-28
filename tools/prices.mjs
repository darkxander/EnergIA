// Brings src/prices.json up to date from a public, machine-readable price list.
//
//   node tools/prices.mjs            fetch the list, rewrite src/prices.json if needed
//   node tools/prices.mjs --check    show what would change, write nothing
//   node tools/prices.mjs --from f   read the list from a local file instead of the network
//
// Then:   node tools/stamp.mjs       (the page's version number depends on prices.json)
//
// The list is LiteLLM's (MIT licence), kept by its community from the providers' pricing
// pages. It is not an official source, hence the guards below:
//   - a field is only updated where src/prices.json already has it: the shape of each
//     entry (which cache prices a model has) stays the one read on the official pages;
//   - a model missing from the list keeps its price;
//   - a price that would move by more than MAX_FACTOR, or that is not a plausible number,
//     stops everything: nothing is written and the command fails;
//   - new models are added only if they look like a text model of Anthropic or OpenAI.
// A GitHub task runs this every week (.github/workflows/prices.yml).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FEED = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const MAX_FACTOR = 4;      // a price never moves by more than this in one update
export const MAX_PRICE = 1000;    // dollars per million tokens
export const STALE_DAYS = 30;     // with no change, the "checked" date is refreshed after this long

const PROVIDERS = ["anthropic", "openai"];
// Our field → the list's field (dollars per token there, per million tokens here).
const FIELDS = {
  in: "input_cost_per_token",
  out: "output_cost_per_token",
  read: "cache_read_input_token_cost",
  write5m: "cache_creation_input_token_cost",
  write1h: "cache_creation_input_token_cost_above_1hr",
};
// Fields given to a model that is new to us: cache writes are only billed by Anthropic.
const NEW_FIELDS = { anthropic: ["in", "write5m", "write1h", "read", "out"], openai: ["in", "out", "read"] };
const TEXT_MODEL = /^(claude-|gpt-|o\d)/;
const NOT_TEXT = /audio|(^|-)search|realtime|image|transcribe|tts|embedding|moderation|preview/; // "research" is fine
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})(-|$)/; // snapshots: the plain name is enough

// Same writing as priceFor in src/model.js: lower case, dots as hyphens.
const normalize = (name) => String(name).toLowerCase().replace(/\./g, "-");
const perMillion = (perToken) => Number((perToken * 1e6).toPrecision(10));
const plausible = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PRICE;

// The list's entries we can use, by normalized name. Names with a "/" are the same
// models sold by resellers (azure/…, bedrock/…): they are left out.
function usable(feed) {
  const entries = new Map();
  for (const [name, entry] of Object.entries(feed || {})) {
    if (name.includes("/") || !entry || typeof entry !== "object") continue;
    if (!PROVIDERS.includes(entry.litellm_provider)) continue;
    const key = normalize(name);
    if (!entries.has(key)) entries.set(key, entry);
  }
  return entries;
}

// { prices, changed: [{ model, field, from, to }], added: [model], refused: [text], dated }
// `prices` is a new object; `current` is left untouched. `refused` not empty means the
// list cannot be trusted this time: the caller must not write anything.
export function updatePrices(current, feed, today) {
  const entries = usable(feed);
  const prices = structuredClone(current);
  const changed = [], added = [], refused = [];
  if (entries.size < 20) refused.push(`only ${entries.size} usable entries in the list`);

  for (const [model, price] of Object.entries(prices.models)) {
    const entry = entries.get(model);
    if (!entry) continue;
    for (const field of Object.keys(price)) {
      const raw = entry[FIELDS[field]];
      if (raw === undefined || raw === null) continue;
      const to = perMillion(raw), from = price[field];
      if (to === from) continue;
      if (!plausible(to)) refused.push(`${model}.${field}: ${to} is not a plausible price`);
      else if (to > from * MAX_FACTOR || to < from / MAX_FACTOR) refused.push(`${model}.${field}: ${from} → ${to} moves by more than ×${MAX_FACTOR}`);
      else { price[field] = to; changed.push({ model, field, from, to }); }
    }
  }

  const aliases = prices.aliases || {};
  for (const [model, entry] of entries) {
    if (prices.models[model] || aliases[model]) continue;
    if (entry.mode !== "chat" || !TEXT_MODEL.test(model) || NOT_TEXT.test(model) || DATED.test(model)) continue;
    const price = {};
    for (const field of NEW_FIELDS[entry.litellm_provider]) {
      const raw = entry[FIELDS[field]];
      if (raw !== undefined && raw !== null) price[field] = perMillion(raw);
    }
    // Without both basic prices, or with an odd number, the model is simply not taken.
    if (!plausible(price.in) || !plausible(price.out) || !Object.values(price).every(plausible)) continue;
    prices.models[model] = price;
    added.push(model);
  }

  const age = (Date.parse(today) - Date.parse(current.checked)) / 86400000;
  const dated = !refused.length && (changed.length > 0 || added.length > 0 || !(age < STALE_DAYS));
  if (dated) prices.checked = today;
  return { prices, changed, added, refused, dated };
}

// src/prices.json as it is written: one model per line, so that a price change is a
// one-line change in the history.
export function formatPrices(prices) {
  const inline = (value) => (value && typeof value === "object"
    ? `{ ${Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${inline(inner)}`).join(", ")} }`
    : JSON.stringify(value));
  const lines = Object.entries(prices).map(([key, value]) => {
    if (!value || typeof value !== "object") return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    const inner = Object.entries(value).map(([name, entry]) => `    ${JSON.stringify(name)}: ${inline(entry)}`);
    return `  ${JSON.stringify(key)}: {\n${inner.join(",\n")}\n  }`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

// What happened, in a few lines (also used as the body of the automatic commit).
export function summary({ changed, added, refused, dated }) {
  const lines = [
    ...refused.map((text) => `refused: ${text}`),
    ...changed.map(({ model, field, from, to }) => `${model} ${field}: ${from} → ${to}`),
    ...(added.length ? [`added: ${added.join(", ")}`] : []),
  ];
  if (!lines.length) lines.push(dated ? "no price change; date of the check refreshed" : "no price change");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;
  const target = new URL("../src/prices.json", import.meta.url);
  const text = readFileSync(target, "utf8");

  let feed;
  if (from) feed = JSON.parse(readFileSync(from, "utf8"));
  else {
    const response = await fetch(FEED, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${FEED} : ${response.status}`);
    feed = await response.json();
  }

  const result = updatePrices(JSON.parse(text), feed, new Date().toISOString().slice(0, 10));
  console.log(summary(result));
  if (result.refused.length) {
    console.error("src/prices.json left as it is: check these prices by hand on the providers' pages.");
    process.exit(1);
  }
  const after = formatPrices(result.prices);
  if (after === text) console.log("src/prices.json already up to date");
  else if (check) console.log("src/prices.json would change (--check: nothing written)");
  else {
    writeFileSync(target, after);
    console.log("src/prices.json updated; now run: node tools/stamp.mjs");
  }
}
