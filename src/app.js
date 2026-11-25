import { listZipEntries, readZipEntryText } from "./zip.js";
import { parseExport } from "./parsers.js";
import { DEFAULT_SETTINGS, TIERS, EQUIVALENTS, PRICE_SOURCE, classifyModel, priceFor, rowMetrics, summarize, subscriptionCost } from "./model.js";

const SOURCES = { chatgpt: "ChatGPT", claude: "Claude", claudecode: "Claude Code" };
const API_HEADERS = { "X-EnergIA": "1" };
const DATA_KEY = "EnergIA.data.v1";
const SETTINGS_KEY = "EnergIA.settings.v1";
const MANUAL_RATE_KEY = "EnergIA.rateManual";

// Reprise des données enregistrées sous l'ancienne écriture du nom (« energia. »).
for (const key of [DATA_KEY, SETTINGS_KEY, MANUAL_RATE_KEY]) {
  const legacy = key.replace("EnergIA.", "energia.");
  const value = localStorage.getItem(legacy);
  if (value === null) continue;
  if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  localStorage.removeItem(legacy);
}
const DEFAULT_RATE_DATE = "2026-11-24"; // date du taux BCE inscrit dans defaults.json

const METRICS = {
  energy: { label: "Énergie", get: (m) => m.wh, units: [["Wh", 1], ["kWh", 1000]] },
  co2: { label: "CO₂", get: (m) => m.co2g, units: [["g CO₂e", 1], ["kg CO₂e", 1000]] },
  water: { label: "Eau", get: (m) => m.waterL * 1000, units: [["mL", 1], ["L", 1000]] },
  cost: { label: "Coût", get: (m) => m.eur, units: [["€", 1]] },
};

const $ = (id) => document.getElementById(id);

// ---------- État ----------

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function mergeSettings(saved) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return s;
  // 0,9 était une valeur provisoire d'une version précédente, jamais un choix de l'utilisateur.
  if (saved.eurPerUsd === 0.9) delete saved.eurPerUsd;
  for (const key of Object.keys(s)) {
    if (key === "tiers") {
      for (const tier of Object.keys(s.tiers)) Object.assign(s.tiers[tier], saved.tiers?.[tier]);
    } else if (key === "subs") {
      Object.assign(s.subs, saved.subs);
    } else if (typeof saved[key] === "number") {
      s[key] = saved[key];
    }
  }
  return s;
}

const state = {
  data: loadJSON(DATA_KEY, {}), // { chatgpt: { rows, conversations, importedAt }, claude: {...} }
  settings: mergeSettings(loadJSON(SETTINGS_KEY, null)),
  period: "all",
  source: "all",
  metric: "energy",
  showTable: false,
  rateDate: DEFAULT_RATE_DATE, // date du taux BCE utilisé, ou null s'il est saisi à la main
};
if (localStorage.getItem(MANUAL_RATE_KEY)) state.rateDate = null;

function saveData() {
  const persistable = {};
  for (const [source, entry] of Object.entries(state.data)) {
    if (!entry.sample && !entry.live) persistable[source] = entry;
  }
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(persistable));
  } catch {
    setStatus("Données analysées, mais trop volumineuses pour être mémorisées dans ce navigateur.", true);
  }
}

// ---------- Outils d'affichage ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const number3 = new Intl.NumberFormat("fr-FR", { maximumSignificantDigits: 3 });
const integer = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumSignificantDigits: 3 });
const nfBig = (x) => (Math.abs(x) >= 1e6 ? compact.format(x) : nf(x));
const nf = (x) => (Math.abs(x) >= 1000 ? integer.format(x) : number3.format(x));

function pickUnit(units, value) {
  let chosen = units[0];
  for (const unit of units) if (value >= unit[1]) chosen = unit;
  return chosen;
}

function fmt(metricKey, value) {
  if (metricKey === "cost") {
    return value < 100
      ? `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : `${nf(value)} €`;
  }
  const [name, factor] = pickUnit(METRICS[metricKey].units, value);
  return `${nf(value / factor)} ${name}`;
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.className = isError ? "error" : "";
}

// ---------- Import ----------

async function readFile(file) {
  const texts = [];
  if (/\.zip$/i.test(file.name)) {
    const entries = await listZipEntries(file);
    const wanted = entries.filter((e) => /(^|\/)conversations[^/]*\.json$/i.test(e.name));
    if (!wanted.length) throw new Error(`Aucun fichier de conversations trouvé dans ${file.name}.`);
    for (const entry of wanted) texts.push(await readZipEntryText(file, entry));
  } else {
    texts.push(await file.text());
  }
  return texts;
}

async function importFiles(files) {
  if (!files.length) return;
  setStatus("Analyse en cours…");
  const imported = {};
  try {
    for (const file of files) {
      for (const text of await readFile(file)) {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`${file.name} n'est pas un fichier JSON lisible.`);
        }
        const parsed = parseExport(json);
        if (!parsed) throw new Error(`${file.name} : format non reconnu (export ChatGPT ou Claude attendu).`);
        const target = (imported[parsed.source] ??= { rows: [], conversations: 0 });
        target.rows.push(...parsed.rows);
        target.conversations += parsed.conversations;
      }
    }
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  // Les données d'exemple disparaissent dès qu'un vrai fichier est importé.
  for (const source of Object.keys(state.data)) if (state.data[source].sample) delete state.data[source];
  const summary = [];
  for (const [source, entry] of Object.entries(imported)) {
    state.data[source] = { ...entry, importedAt: new Date().toISOString() };
    const requests = entry.rows.reduce((sum, row) => sum + row.requests, 0);
    summary.push(`${SOURCES[source]} : ${nf(entry.conversations)} conversations, ${nf(requests)} requêtes`);
  }
  saveData();
  setStatus(`Import terminé. ${summary.join(" · ")}.`);
  render();
}

function loadSample() {
  // Générateur pseudo-aléatoire déterministe.
  let seed = 42;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const plans = {
    chatgpt: [["gpt-4o", 7], ["gpt-4o-mini", 3], ["o3", 1.2]],
    claude: [["claude", 5]],
  };
  const today = new Date();
  for (const [source, models] of Object.entries(plans)) {
    const rows = [];
    for (let back = 420; back >= 0; back--) {
      const date = new Date(today.getTime() - back * 86400000);
      const day = date.toISOString().slice(0, 10);
      const growth = 0.4 + (420 - back) / 420;
      for (const [model, perDay] of models) {
        const requests = Math.round(perDay * growth * random() * 2);
        if (!requests) continue;
        rows.push({
          day, source, model, requests, responses: requests,
          inTok: Math.round(requests * (1500 + random() * 3000)),
          outTok: Math.round(requests * (250 + random() * 300)),
        });
      }
    }
    state.data[source] = { rows, conversations: Math.round(rows.length * 1.5), sample: true };
  }
  setStatus("Données d'exemple affichées. Importez votre export pour voir vos propres chiffres.");
  render();
}

// ---------- Calculs ----------

function filteredRows() {
  let cutoff = "";
  if (state.period !== "all") {
    // N jours, aujourd'hui compris, en date locale (« 1 » = aujourd'hui seulement).
    const start = new Date();
    start.setDate(start.getDate() - (Number(state.period) - 1));
    const two = (n) => String(n).padStart(2, "0");
    cutoff = `${start.getFullYear()}-${two(start.getMonth() + 1)}-${two(start.getDate())}`;
  }
  const rows = [];
  for (const [source, entry] of Object.entries(state.data)) {
    if (state.source !== "all" && state.source !== source) continue;
    for (const row of entry.rows) if (row.day >= cutoff) rows.push(row);
  }
  return rows;
}

function buckets(rows) {
  if (!rows.length) return [];
  let first = rows[0].day;
  let last = rows[0].day;
  for (const row of rows) {
    if (row.day < first) first = row.day;
    if (row.day > last) last = row.day;
  }
  const spanDays = (new Date(last) - new Date(first)) / 86400000;
  const byDay = spanDays <= 92;
  const keyOf = (day) => (byDay ? day : day.slice(0, 7));

  const map = new Map();
  const cursor = new Date(`${keyOf(first)}${byDay ? "" : "-01"}T00:00:00Z`);
  const end = new Date(`${keyOf(last)}${byDay ? "" : "-01"}T00:00:00Z`);
  const shortFormat = new Intl.DateTimeFormat("fr-FR", byDay
    ? { day: "numeric", month: "short", timeZone: "UTC" }
    : { month: "short", year: "2-digit", timeZone: "UTC" });
  const longFormat = new Intl.DateTimeFormat("fr-FR", byDay
    ? { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
    : { month: "long", year: "numeric", timeZone: "UTC" });
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, byDay ? 10 : 7);
    map.set(key, { key, label: shortFormat.format(cursor), full: longFormat.format(cursor), rows: Object.fromEntries(Object.keys(SOURCES).map((s) => [s, []])) });
    if (byDay) cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const row of rows) map.get(keyOf(row.day))?.rows[row.source].push(row);

  const metric = METRICS[state.metric];
  return [...map.values()].map((bucket) => {
    const values = {};
    for (const source of Object.keys(SOURCES)) {
      values[source] = metric.get(summarize(bucket.rows[source], state.settings));
    }
    return { ...bucket, values, total: Object.values(values).reduce((a, b) => a + b, 0) };
  });
}

// ---------- Rendu ----------

function renderSources() {
  const box = $("sources");
  box.replaceChildren();
  for (const [source, entry] of Object.entries(state.data)) {
    if (entry.live) {
      box.append(el("span", {}, el("span", { class: `swatch ${source}` }),
        entry.ready ? "Claude Code : tokens mesurés en direct sur ce Mac" : "Claude Code : première lecture des journaux en cours…"));
      continue;
    }
    const when = entry.sample ? "exemple" : `importé le ${new Date(entry.importedAt).toLocaleDateString("fr-FR")}`;
    box.append(el("span", {},
      el("span", { class: `swatch ${source}` }),
      `${SOURCES[source]} : ${nf(entry.conversations)} conversations (${when}) `,
      el("button", {
        class: "link", type: "button",
        onclick: () => { delete state.data[source]; saveData(); setStatus(""); render(); },
      }, "Supprimer")));
  }
}

function renderTiles(rows) {
  const s = state.settings;
  const total = summarize(rows, s);
  const range = (key, value) =>
    `Fourchette : ${fmt(key, value * s.lowFactor)} – ${fmt(key, value * s.highFactor)}`;
  const subs = subscriptionCost(rows, s);
  const tiles = [
    {
      name: "Énergie", value: fmt("energy", total.wh), range: range("energy", total.wh),
      equiv: `≈ ${nf(total.wh / EQUIVALENTS.smartphoneChargeWh)} charges de smartphone, ou ${nf(total.wh / EQUIVALENTS.electricCarWhPerKm)} km en voiture électrique`,
    },
    {
      name: "CO₂", value: fmt("co2", total.co2g), range: range("co2", total.co2g),
      equiv: `≈ ${nf(total.co2g / EQUIVALENTS.petrolCarGPerKm)} km en voiture thermique`,
    },
    {
      name: "Eau", value: fmt("water", total.waterL * 1000), range: range("water", total.waterL * 1000),
      equiv: total.waterL >= 2 * EQUIVALENTS.showerL
        ? `≈ ${nf(total.waterL / EQUIVALENTS.showerL)} douches`
        : `≈ ${nf(total.waterL / EQUIVALENTS.glassL)} verres d'eau`,
    },
    {
      name: "Coût (au tarif de l'API)", value: fmt("cost", total.eur),
      range: "Ce que coûteraient ces tokens payés à l'usage, aux prix publics",
      equiv: subs > 0 ? `Abonnements sur la période : ${fmt("cost", subs)}` : "",
    },
  ];
  $("tiles").replaceChildren(...tiles.map((t) =>
    el("div", { class: "tile" },
      el("div", { class: "name" }, t.name),
      el("div", { class: "value" }, t.value),
      el("p", { class: "range" }, t.range),
      t.equiv ? el("p", { class: "equiv" }, t.equiv) : null)));
  $("volume").textContent =
    `${nf(total.requests)} requêtes · ${nfBig(total.tokens)} de tokens lus et générés`;
}

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

function renderChart(data) {
  const wrap = $("chart");
  wrap.replaceChildren();
  const active = Object.keys(SOURCES).filter((source) => data.some((b) => b.values[source] > 0));
  $("legend").replaceChildren(...(active.length > 1
    ? active.map((source) => el("span", {}, el("span", { class: `swatch ${source}` }), SOURCES[source]))
    : []));
  if (!data.length) {
    wrap.append(el("p", { class: "muted" }, "Aucune donnée sur cette période."));
    return;
  }

  const W = 720, H = 260, left = 52, right = 8, top = 10, bottom = 26;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(...data.map((b) => b.total)) || 1;
  const [unitName, unitFactor] = pickUnit(METRICS[state.metric].units, max);
  const step = niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const y = (value) => top + plotH - (value / yMax) * plotH;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${METRICS[state.metric].label} par période, en ${unitName}` });
  for (let tick = 0; tick <= yMax + step / 2; tick += step) {
    root.append(svg("line", { class: tick === 0 ? "baseline" : "gridline", x1: left, x2: W - right, y1: y(tick), y2: y(tick) }));
    const label = svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end" });
    label.textContent = nf(tick / unitFactor);
    root.append(label);
  }
  const unitLabel = svg("text", { x: left, y: top + 2, "text-anchor": "start" });
  unitLabel.textContent = unitName;
  root.append(unitLabel);

  const slot = plotW / data.length;
  const barW = Math.max(1, Math.min(28, slot * 0.7));
  const gap = barW >= 4 ? 2 : 0;
  const labelEvery = Math.ceil(data.length / 10);
  const tooltip = el("div", { class: "tooltip", hidden: "" });

  data.forEach((bucket, i) => {
    const cx = left + slot * (i + 0.5);
    const x = cx - barW / 2;
    let base = 0;
    const present = active.filter((source) => bucket.values[source] > 0);
    present.forEach((source, index) => {
      const yTop = y(base + bucket.values[source]);
      let yBottom = y(base);
      if (index > 0) yBottom -= gap; // filet de surface entre deux segments empilés
      const height = Math.max(0, yBottom - yTop);
      const isTop = index === present.length - 1;
      const r = isTop ? Math.min(4, barW / 2, height) : 0;
      root.append(svg("path", {
        class: `bar ${source}`,
        d: `M${x},${yBottom} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yBottom} Z`,
      }));
      base += bucket.values[source];
    });

    if (i % labelEvery === 0) {
      const label = svg("text", { x: cx, y: H - 8, "text-anchor": "middle" });
      label.textContent = bucket.label;
      root.append(label);
    }

    const hit = svg("rect", { class: "hit", x: cx - slot / 2, y: top, width: slot, height: plotH });
    hit.addEventListener("mouseenter", () => {
      tooltip.replaceChildren(
        el("div", { class: "title" }, bucket.full),
        ...present.map((source) => el("div", { class: "line" },
          el("span", {}, el("span", { class: `swatch ${source}` }), SOURCES[source]),
          el("b", {}, fmt(state.metric, bucket.values[source])))),
        present.length > 1
          ? el("div", { class: "line" }, el("span", {}, "Total"), el("b", {}, fmt(state.metric, bucket.total)))
          : null);
      const percent = Math.min(85, Math.max(15, (cx / W) * 100));
      tooltip.style.left = `${percent}%`;
      tooltip.hidden = false;
    });
    hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    root.append(hit);
  });

  wrap.append(root, tooltip);
}

function table(headers, lines) {
  return el("table", {},
    el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { class: h.text ? "text" : "" }, h.label)))),
    el("tbody", {}, ...lines.map((cells) =>
      el("tr", {}, ...cells.map((cell, i) => el("td", { class: headers[i].text ? "text" : "" }, cell))))));
}

function renderChartTable(data) {
  const sources = Object.keys(SOURCES);
  $("chart-table").replaceChildren(table(
    [{ label: "Période", text: true }, ...sources.map((s) => ({ label: SOURCES[s] })), { label: "Total" }],
    data.map((b) => [b.full, ...sources.map((s) => fmt(state.metric, b.values[s])), fmt(state.metric, b.total)])));
}

function renderModels(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.source}|${row.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const lines = [...groups.entries()]
    .map(([key, group]) => {
      const [source, model] = key.split("|");
      return { source, model, total: summarize(group, state.settings) };
    })
    .sort((a, b) => b.total.wh - a.total.wh)
    .map(({ source, model, total }) => [
      SOURCES[source],
      source === "claude" ? "non précisé dans l'export" : model,
      TIERS[classifyModel(model)],
      nf(total.requests),
      nfBig(total.outTok),
      fmt("energy", total.wh),
      fmt("co2", total.co2g),
      fmt("water", total.waterL * 1000),
      fmt("cost", total.eur) + (priceFor(model) ? "" : " *"),
    ]);
  $("models").replaceChildren(table(
    [{ label: "Service", text: true }, { label: "Modèle", text: true }, { label: "Catégorie", text: true },
      { label: "Requêtes" }, { label: "Tokens générés" }, { label: "Énergie" }, { label: "CO₂" }, { label: "Eau" }, { label: "Coût" }],
    lines));
  const checked = new Date(PRICE_SOURCE.checked).toLocaleDateString("fr-FR");
  const rate = state.settings.eurPerUsd.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
  const origin = state.rateDate
    ? `taux de référence de la BCE du ${new Date(state.rateDate).toLocaleDateString("fr-FR")}`
    : "taux saisi dans les hypothèses";
  $("price-note").textContent = `Coût : prix publics des API Anthropic et OpenAI par modèle (relevés le ${checked}), convertis à ${rate} € pour 1 $ (${origin}).`
    + (lines.some((line) => line[8].endsWith("*")) ? " * Modèle sans prix public connu : tarif indicatif de sa catégorie." : "");
}

function render() {
  renderSources();
  const hasData = Object.keys(state.data).length > 0;
  $("results").hidden = !hasData;
  if (!hasData) return;
  const rows = filteredRows();
  const data = buckets(rows);
  renderTiles(rows);
  renderChart(data);
  renderChartTable(data);
  renderModels(rows);
  $("chart").hidden = state.showTable;
  $("legend").hidden = state.showTable;
  $("chart-table").hidden = !state.showTable;
}

// ---------- Hypothèses ----------

const SETTING_GROUPS = [
  ["Énergie pour 1 000 tokens générés (Wh)", [
    ["Modèles légers", "tiers.leger.whOut"],
    ["Modèles standard", "tiers.standard.whOut"],
    ["Grands modèles", "tiers.grand.whOut"],
    ["Modèles à raisonnement", "tiers.raisonnement.whOut"],
    ["Poids d'un token lu (contexte)", "inputRatio"],
    ["Poids d'un token relu du cache", "cacheReadRatio"],
  ]],
  ["Fourchette et conversions", [
    ["Fourchette basse (×)", "lowFactor"],
    ["Fourchette haute (×)", "highFactor"],
    ["Intensité carbone (g CO₂e/kWh)", "gCO2PerKWh"],
    ["Eau (L/kWh)", "waterLPerKWh"],
    ["Taux de change (€ pour 1 $)", "eurPerUsd"],
  ]],
  ["Modèles sans prix connu (€ par million de tokens)", [
    ["Légers, lus", "tiers.leger.eurIn"],
    ["Légers, générés", "tiers.leger.eurOut"],
    ["Standard, lus", "tiers.standard.eurIn"],
    ["Standard, générés", "tiers.standard.eurOut"],
    ["Grands, lus", "tiers.grand.eurIn"],
    ["Grands, générés", "tiers.grand.eurOut"],
    ["Raisonnement, lus", "tiers.raisonnement.eurIn"],
    ["Raisonnement, générés", "tiers.raisonnement.eurOut"],
  ]],
  ["Abonnements (€ par mois)", [
    ["ChatGPT", "subs.chatgpt"],
    ["Claude", "subs.claude"],
  ]],
];

function settingAt(path) {
  const parts = path.split(".");
  const last = parts.pop();
  let target = state.settings;
  for (const part of parts) target = target[part];
  return { target, last };
}

function renderSettings() {
  $("settings").replaceChildren(...SETTING_GROUPS.map(([title, fields]) =>
    el("fieldset", {}, el("legend", {}, title), ...fields.map(([label, path]) => {
      const { target, last } = settingAt(path);
      const input = el("input", { type: "number", min: "0", step: "any", value: String(target[last]) });
      input.addEventListener("input", () => {
        const value = Number(input.value);
        if (input.value === "" || !Number.isFinite(value) || value < 0) return;
        target[last] = value;
        if (path === "eurPerUsd") { // un taux saisi à la main n'est plus remplacé par celui de la BCE
          localStorage.setItem(MANUAL_RATE_KEY, "1");
          state.rateDate = null;
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
        pushSettings();
        render();
      });
      return el("label", {}, label, input);
    }))));
}

// ---------- Événements ----------

$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (event) => {
  importFiles([...event.target.files]);
  event.target.value = "";
});
$("sample").addEventListener("click", loadSample);

const drop = $("drop");
drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  importFiles([...event.dataTransfer.files]);
});

for (const key of ["period", "source", "metric"]) {
  $(key).addEventListener("change", (event) => { state[key] = event.target.value; render(); });
}
$("toggle-table").addEventListener("click", (event) => {
  state.showTable = !state.showTable;
  event.target.textContent = state.showTable ? "Voir le graphique" : "Voir le tableau";
  event.target.setAttribute("aria-pressed", String(state.showTable));
  render();
});
$("reset-settings").addEventListener("click", () => {
  state.settings = structuredClone(DEFAULT_SETTINGS);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(MANUAL_RATE_KEY);
  state.rateDate = DEFAULT_RATE_DATE;
  if (menubar) loadClaudeCode(); // reprend le taux relevé par le plugin
  pushSettings();
  renderSettings();
  render();
});

// ---------- Barre de menus ----------
// Servie par le plugin SwiftBar, la page reçoit en plus l'usage de Claude Code
// mesuré sur ce Mac. Ouverte autrement, /api n'existe pas et rien ne change.

let menubar = false;

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { ...API_HEADERS, ...options.headers } });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function pushSettings() {
  if (!menubar) return;
  api("/api/settings", { method: "POST", body: JSON.stringify(state.settings) }).catch(() => {});
}

// Taux BCE relevé chaque jour par le plugin, sauf si l'utilisateur a saisi le sien.
function applyRate(rate) {
  if (!rate || localStorage.getItem(MANUAL_RATE_KEY)) return;
  state.rateDate = rate.date;
  if (state.settings.eurPerUsd === rate.eurPerUsd) return;
  state.settings.eurPerUsd = rate.eurPerUsd;
  renderSettings();
}

async function loadClaudeCode() {
  if (document.visibilityState !== "visible") return;
  try {
    const payload = await api("/api/claudecode");
    state.data.claudecode = { rows: payload.rows, live: true, ready: payload.ready };
    applyRate(payload.rate);
    render();
  } catch { /* serveur momentanément injoignable : on garde l'affichage */ }
}

async function startMenubar() {
  try {
    await api("/api/beat");
  } catch {
    return; // page ouverte hors de la barre de menus
  }
  menubar = true;
  // Tant que la page est visible, le plugin retient ses changements de titre.
  setInterval(() => {
    if (document.visibilityState === "visible") api("/api/beat").catch(() => {});
  }, 1000);
  setInterval(loadClaudeCode, 30000);
  document.addEventListener("visibilitychange", loadClaudeCode);
  pushSettings();
  loadClaudeCode();
}

renderSettings();
render();
startMenubar();
