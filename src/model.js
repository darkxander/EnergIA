// Modèle d'estimation : tokens -> énergie -> CO2, eau, coût.
// Tous les facteurs sont des ordres de grandeur, modifiables par l'utilisateur.
// Les valeurs par défaut sont dans defaults.json, partagé avec le plugin de barre de menus.
//
// tiers.*.whOut : Wh pour 1 000 tokens générés (centre de données compris).
// tiers.*.eurIn / eurOut : euros par million de tokens lus / générés, tarif indicatif
//   utilisé seulement pour les modèles absents de prices.json (prix publics, en dollars).
// inputRatio : énergie d'un token lu, en fraction d'un token généré.
// cacheReadRatio : poids d'un token relu depuis le cache, en fraction d'un token lu.
// eurPerUsd : euros pour 1 dollar. Taux de référence de la BCE du 24/11/2026
//   (1 € = 1,0963 $), https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
// "raisonnement" couvre les modèles dont la réflexion cachée n'apparaît pas dans les exports.

// Les deux fichiers JSON sont lus à côté de ce module. Un « import … with { type: "json" } »
// serait plus court, mais les navigateurs d'avant 2024-2025 ne le comprennent pas et
// n'afficheraient rien du tout.
async function loadJSON(name) {
  const url = new URL(name, import.meta.url);
  url.search = new URL(import.meta.url).search; // même numéro de version que ce module
  if (url.protocol === "file:") { // tests, hors navigateur
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

// Prix publics du modèle (dollars par million de tokens), ou null s'il est inconnu.
// L'export ChatGPT écrit les versions avec des tirets (gpt-4-1) et ajoute le mode
// de réponse au nom (gpt-5-thinking, gpt-5-t-mini) : on le retire pour retrouver le modèle.
export function priceFor(model) {
  let id = String(model || "").toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  const lookup = (name) => PRICES.models[PRICES.aliases[name] || name];
  return lookup(id)
    || lookup(id.replace(/-t-mini$/, "-mini").replace(/-(thinking|instant|high|medium|low|auto)(?=-|$)/g, ""))
    || null;
}

export const DEFAULT_SETTINGS = DEFAULTS;

// Intensité carbone de l'électricité par pays (g CO₂e/kWh), source dans carbon.json.
export const CARBON = CARBON_DATA;

// Même règle que menubar/estimate.py : garder les deux en accord.
export function classifyModel(model) {
  const m = String(model || "").toLowerCase();
  if (/(^|[-_ ])mini|nano|haiku|flash|instant|lite|luna/.test(m)) return "leger"; // « gemini » n'est pas « mini »
  if (/opus|fable|mythos|astra/.test(m)) return "grand";
  if (/^o\d|thinking|reason|research|(^|-)pro($|-)/.test(m)) return "raisonnement";
  return "standard";
}

export function rowMetrics(row, settings) {
  const tier = settings.tiers[classifyModel(row.model)];
  const write5m = row.cw5Tok || 0;
  const write1h = row.cw1Tok || 0;
  const cached = row.cacheTok || 0;
  // Les tokens écrits dans le cache sont calculés comme des tokens lus ordinaires.
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

// Abonnements payés : un mois compté dès qu'il contient de l'activité.
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
  petrolCarGPerKm: 200,
  glassL: 0.25,
  showerL: 60,
};
