// Estimation model: tokens -> energy -> CO2, water, cost.
// All the factors are orders of magnitude, which the user can change.
// The default values are in defaults.json, shared with the menu bar plugin.
//
// tiers.*.whOut: Wh per 1,000 tokens generated (data centre included).
// tiers.*.eurIn / eurOut: euros per million tokens read / generated, indicative rate
//   used only for models absent from prices.json (public prices, in dollars).
// inputRatio: energy of a token read, as a fraction of a token generated.
// cacheReadRatio: weight of a token re-read from the cache, as a fraction of a token read.
// eurPerUsd: euros per 1 dollar. ECB reference rate of 24/11/2026
//   (€1 = $1.0963), https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
// "raisonnement" covers the models whose hidden thinking does not appear in the exports.

// The JSON files are read next to this module. An `import … with { type: "json" }`
// would be shorter, but browsers from before 2024-2025 do not understand it and
// would display nothing at all.
async function loadJSON(name) {
  const url = new URL(name, import.meta.url);
  url.search = new URL(import.meta.url).search; // same version number as this module
  if (url.protocol === "file:") { // tests, outside the browser
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(url, "utf8"));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} : ${response.status}`);
  return response.json();
}

const [DEFAULTS, PRICES, CARBON_DATA] = await Promise.all(
  [loadJSON("./defaults.json"), loadJSON("./prices.json"), loadJSON("./carbon.json")]);

export const PRICE_SOURCE = { url: PRICES.source, checked: PRICES.checked };

// Public prices of the model (dollars per million tokens), or null if it is unknown.
// The ChatGPT export writes versions with hyphens (gpt-4-1) and appends the response
// mode to the name (gpt-5-thinking, gpt-5-t-mini): it is removed to find the model.
export function priceFor(model) {
  let id = String(model || "").toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  const lookup = (name) => PRICES.models[PRICES.aliases[name] || name];
  return lookup(id)
    || lookup(id.replace(/-t-mini$/, "-mini").replace(/-(thinking|instant|high|medium|low|auto)(?=-|$)/g, ""))
    || null;
}

export const DEFAULT_SETTINGS = DEFAULTS;

// Carbon intensity of electricity by country (g CO₂e/kWh), source in carbon.json.
export const CARBON = CARBON_DATA;

// Same rule as menubar/estimate.py: keep the two in agreement.
export function classifyModel(model) {
  const m = String(model || "").toLowerCase();
  if (/(^|[-_ ])mini|nano|haiku|flash|instant|lite|luna/.test(m)) return "leger"; // "gemini" is not "mini"
  if (/opus|fable|mythos|astra/.test(m)) return "grand";
  if (/^o\d|thinking|reason|research|(^|-)pro($|-)/.test(m)) return "raisonnement";
  return "standard";
}

export function rowMetrics(row, settings) {
  const tier = settings.tiers[classifyModel(row.model)];
  const write5m = row.cw5Tok || 0;
  const write1h = row.cw1Tok || 0;
  const cached = row.cacheTok || 0;
  // Tokens written to the cache are calculated as ordinary read tokens.
  const read = row.inTok + write5m + write1h + cached * settings.cacheReadRatio;
  const wh = ((row.outTok + read * settings.inputRatio) / 1000) * tier.whOut;
  const kwh = wh / 1000;
  const price = priceFor(row.model);
  const eur = price
    ? ((row.inTok * price.in + write5m * (price.write5m ?? price.in) + write1h * (price.write1h ?? price.in)
        + cached * (price.read ?? price.in)
        + row.outTok * price.out) / 1e6
      + ((row.searches || 0) * PRICES.webSearchUsdPer1000) / 1000) * settings.eurPerUsd
    : (read * tier.eurIn + row.outTok * tier.eurOut) / 1e6;
  return {
    wh,
    co2g: kwh * settings.gCO2PerKWh,
    waterL: kwh * settings.waterLPerKWh,
    eur,
  };
}

export function summarize(rows, settings) {
  const total = { wh: 0, co2g: 0, waterL: 0, eur: 0, requests: 0, responses: 0, tokens: 0, outTok: 0 };
  for (const row of rows) {
    const m = rowMetrics(row, settings);
    total.wh += m.wh;
    total.co2g += m.co2g;
    total.waterL += m.waterL;
    total.eur += m.eur;
    total.requests += row.requests;
    total.responses += row.responses;
    total.tokens += row.inTok + (row.cw5Tok || 0) + (row.cw1Tok || 0) + (row.cacheTok || 0) + row.outTok;
    total.outTok += row.outTok;
  }
  return total;
}

// Paid subscriptions: a month is counted as soon as it contains activity.
export function subscriptionCost(rows, settings) {
  const months = {};
  for (const row of rows) (months[row.source] ??= new Set()).add(row.day.slice(0, 7));
  let total = 0;
  for (const source of Object.keys(months)) total += months[source].size * (settings.subs[source] || 0);
  return total;
}

export const EQUIVALENTS = {
  smartphoneChargeWh: 15,
  electricCarWhPerKm: 170,
  petrolCarGPerKm: 170, // average petrol car, manufacturing included (ADEME, impactco2.fr)
  glassL: 0.25,
  showerL: 60,
};
