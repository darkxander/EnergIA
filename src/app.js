import { listZipEntries, readZipEntryText } from "./zip.js";
import { parseExport } from "./parsers.js";
import { DEFAULT_SETTINGS, EQUIVALENTS, PRICE_SOURCE, classifyModel, priceFor, rowMetrics, summarize, subscriptionCost } from "./model.js";
import { LANG, LANG_KEY, LOCALE, PAGE_EN, t } from "./i18n.js";

const SOURCES = { chatgpt: "ChatGPT", claude: "Claude", claudecode: "Claude Code", cowork: "Claude Cowork" };
const LIVE_SOURCES = ["claudecode", "cowork"]; // mesurées sur ce Mac par le plugin, sans import
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
  energy: { label: t("metric.energy"), get: (m) => m.wh, units: [["Wh", 1], ["kWh", 1000]] },
  co2: { label: t("metric.co2"), get: (m) => m.co2g, units: [["g CO₂e", 1], ["kg CO₂e", 1000]] },
  water: { label: t("metric.water"), get: (m) => m.waterL * 1000, units: [["mL", 1], ["L", 1000]] },
  cost: { label: t("metric.cost"), get: (m) => m.eur, units: [["€", 1]] },
};

const $ = (id) => document.getElementById(id);

// ---------- Langue ----------
// index.html est écrit en français ; en anglais, ses textes sont remplacés ici.
// Changer de langue enregistre le choix et recharge la page.

document.documentElement.lang = LANG;
if (LANG === "en") {
  document.title = PAGE_EN["page.title"];
  for (const node of document.querySelectorAll("[data-i18n]")) node.innerHTML = PAGE_EN[node.dataset.i18n];
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", PAGE_EN[node.dataset.i18nAria]);
}
const langButton = $("lang"); // absent d'une ancienne page restée en cache
if (langButton) {
  langButton.textContent = t("lang.switch");
  langButton.lang = LANG === "fr" ? "en" : "fr";
  langButton.addEventListener("click", () => {
    localStorage.setItem(LANG_KEY, LANG === "fr" ? "en" : "fr");
    location.reload();
  });
}

// ---------- État ----------

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function mergeSettings(saved) {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
    setStatus(t("status.tooBig"), true);
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

const number3 = new Intl.NumberFormat(LOCALE, { maximumSignificantDigits: 3 });
const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(LANG, { notation: "compact", maximumSignificantDigits: 3 });
const nfBig = (x) => (Math.abs(x) >= 1e6 ? compact.format(x) : nf(x));
const nf = (x) => (Math.abs(x) >= 1000 ? integer.format(x) : number3.format(x));

function pickUnit(units, value) {
  let chosen = units[0];
  for (const unit of units) if (value >= unit[1]) chosen = unit;
  return chosen;
}

function fmt(metricKey, value) {
  if (metricKey === "cost") {
    return t("euro", {
      amount: value < 100
        ? value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : nf(value),
    });
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
    if (!wanted.length) throw new Error(t("status.noConversations", { file: file.name }));
    for (const entry of wanted) texts.push(await readZipEntryText(file, entry));
  } else {
    texts.push(await file.text());
  }
  return texts;
}

async function importFiles(files) {
  if (!files.length) return;
  setStatus(t("status.parsing"));
  const imported = {};
  try {
    for (const file of files) {
      for (const text of await readFile(file)) {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(t("status.notJson", { file: file.name }));
        }
        const parsed = parseExport(json);
        if (!parsed) throw new Error(t("status.unknownFormat", { file: file.name }));
        const target = (imported[parsed.source] ??= { rows: [], conversations: 0 });
        target.rows.push(...parsed.rows);
        target.conversations += parsed.conversations;
      }
    }
  } catch (error) {
    setStatus(error.code ? t(error.code, error.vars) : error.message, true);
    return;
  }

  // Les données d'exemple disparaissent dès qu'un vrai fichier est importé.
  for (const source of Object.keys(state.data)) if (state.data[source].sample) delete state.data[source];
  const summary = [];
  for (const [source, entry] of Object.entries(imported)) {
    state.data[source] = { ...entry, importedAt: new Date().toISOString() };
    const requests = entry.rows.reduce((sum, row) => sum + row.requests, 0);
    summary.push(t("status.importedSource", { source: SOURCES[source], conversations: nf(entry.conversations), requests: nf(requests) }));
  }
  saveData();
  setStatus(t("status.imported", { summary: summary.join(" · ") }));
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
  setStatus(t("status.sample"));
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
  const shortFormat = new Intl.DateTimeFormat(LOCALE, byDay
    ? { day: "numeric", month: "short", timeZone: "UTC" }
    : { month: "short", year: "2-digit", timeZone: "UTC" });
  const longFormat = new Intl.DateTimeFormat(LOCALE, byDay
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
        t(entry.ready ? "source.live" : "source.reading", { source: SOURCES[source] })));
      continue;
    }
    const when = entry.sample
      ? t("source.sample")
      : t("source.importedOn", { date: new Date(entry.importedAt).toLocaleDateString(LOCALE) });
    box.append(el("span", {},
      el("span", { class: `swatch ${source}` }),
      t("source.line", { source: SOURCES[source], conversations: nf(entry.conversations), when }),
      el("button", {
        class: "link", type: "button",
        onclick: () => { delete state.data[source]; saveData(); setStatus(""); render(); },
      }, t("source.remove"))));
  }
}

function renderTiles(rows) {
  const s = state.settings;
  const total = summarize(rows, s);
  const range = (key, value) =>
    t("tile.range", { low: fmt(key, value * s.lowFactor), high: fmt(key, value * s.highFactor) });
  const subs = subscriptionCost(rows, s);
  const tiles = [
    {
      name: t("metric.energy"), value: fmt("energy", total.wh), range: range("energy", total.wh),
      equiv: t("tile.energyEquiv", {
        charges: nf(total.wh / EQUIVALENTS.smartphoneChargeWh),
        km: nf(total.wh / EQUIVALENTS.electricCarWhPerKm),
      }),
    },
    {
      name: t("metric.co2"), value: fmt("co2", total.co2g), range: range("co2", total.co2g),
      equiv: t("tile.co2Equiv", { km: nf(total.co2g / EQUIVALENTS.petrolCarGPerKm) }),
    },
    {
      name: t("metric.water"), value: fmt("water", total.waterL * 1000), range: range("water", total.waterL * 1000),
      equiv: total.waterL >= 2 * EQUIVALENTS.showerL
        ? t("tile.showers", { count: nf(total.waterL / EQUIVALENTS.showerL) })
        : t("tile.glasses", { count: nf(total.waterL / EQUIVALENTS.glassL) }),
    },
    {
      name: t("tile.costName"), value: fmt("cost", total.eur),
      range: t("tile.costNote"),
      equiv: subs > 0 ? t("tile.subs", { amount: fmt("cost", subs) }) : "",
    },
  ];
  $("tiles").replaceChildren(...tiles.map((t) =>
    el("div", { class: "tile" },
      el("div", { class: "name" }, t.name),
      el("div", { class: "value" }, t.value),
      el("p", { class: "range" }, t.range),
      t.equiv ? el("p", { class: "equiv" }, t.equiv) : null)));
  $("volume").textContent = t("volume", { requests: nf(total.requests), tokens: nfBig(total.tokens) });
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
    wrap.append(el("p", { class: "muted" }, t("chart.empty")));
    return;
  }

  const W = 720, H = 260, left = 52, right = 8, top = 10, bottom = 26;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(...data.map((b) => b.total)) || 1;
  const [unitName, unitFactor] = pickUnit(METRICS[state.metric].units, max);
  const step = niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const y = (value) => top + plotH - (value / yMax) * plotH;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("chart.aria", { metric: METRICS[state.metric].label, unit: unitName }) });
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
          ? el("div", { class: "line" }, el("span", {}, t("chart.total")), el("b", {}, fmt(state.metric, bucket.total)))
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
    [{ label: t("chart.period"), text: true }, ...sources.map((s) => ({ label: SOURCES[s] })), { label: t("chart.total") }],
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
      source === "claude" ? t("models.unknown") : model,
      t(`tier.${classifyModel(model)}`),
      nf(total.requests),
      nfBig(total.outTok),
      fmt("energy", total.wh),
      fmt("co2", total.co2g),
      fmt("water", total.waterL * 1000),
      fmt("cost", total.eur) + (priceFor(model) ? "" : " *"),
    ]);
  $("models").replaceChildren(table(
    [{ label: t("models.service"), text: true }, { label: t("models.model"), text: true }, { label: t("models.tier"), text: true },
      { label: t("models.requests") }, { label: t("models.outTokens") }, { label: t("metric.energy") }, { label: t("metric.co2") },
      { label: t("metric.water") }, { label: t("metric.cost") }],
    lines));
  const checked = new Date(PRICE_SOURCE.checked).toLocaleDateString(LOCALE);
  const rate = state.settings.eurPerUsd.toLocaleString(LOCALE, { maximumFractionDigits: 4 });
  const origin = state.rateDate
    ? t("price.ecb", { date: new Date(state.rateDate).toLocaleDateString(LOCALE) })
    : t("price.manual");
  $("price-note").textContent = t("price.note", { checked, rate, origin })
    + (lines.some((line) => line[8].endsWith("*")) ? t("price.asterisk") : "");
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
  [t("settings.energy"), [
    [t("settings.light"), "tiers.leger.whOut"],
    [t("settings.standard"), "tiers.standard.whOut"],
    [t("settings.large"), "tiers.grand.whOut"],
    [t("settings.reasoning"), "tiers.raisonnement.whOut"],
    [t("settings.inputRatio"), "inputRatio"],
    [t("settings.cacheRatio"), "cacheReadRatio"],
  ]],
  [t("settings.conversions"), [
    [t("settings.low"), "lowFactor"],
    [t("settings.high"), "highFactor"],
    [t("settings.carbon"), "gCO2PerKWh"],
    [t("settings.water"), "waterLPerKWh"],
    [t("settings.rate"), "eurPerUsd"],
  ]],
  [t("settings.unpriced"), [
    [t("settings.lightIn"), "tiers.leger.eurIn"],
    [t("settings.lightOut"), "tiers.leger.eurOut"],
    [t("settings.standardIn"), "tiers.standard.eurIn"],
    [t("settings.standardOut"), "tiers.standard.eurOut"],
    [t("settings.largeIn"), "tiers.grand.eurIn"],
    [t("settings.largeOut"), "tiers.grand.eurOut"],
    [t("settings.reasoningIn"), "tiers.raisonnement.eurIn"],
    [t("settings.reasoningOut"), "tiers.raisonnement.eurOut"],
  ]],
  [t("settings.subs"), [
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

$("pick").addEventListener("click", () => (menubar ? pickWithPlugin() : $("file").click()));

// La fenêtre de la barre de menus n'ouvre pas le sélecteur de fichier du
// navigateur : le plugin ouvre celui de macOS et renvoie le fichier choisi.
async function pickWithPlugin() {
  setStatus(t("status.picking"));
  try {
    const response = await fetch("/api/pick", { method: "POST", headers: API_HEADERS });
    if (response.status === 204) return setStatus(""); // annulé
    if (!response.ok) throw new Error(String(response.status));
    const name = decodeURIComponent(response.headers.get("X-Filename") || "export.zip");
    await importFiles([new File([await response.blob()], name)]);
  } catch {
    setStatus(t("status.pickFailed"), true);
  }
}
$("file").addEventListener("change", (event) => {
  importFiles([...event.target.files]);
  event.target.value = "";
});
$("sample").addEventListener("click", loadSample);

// Un fichier peut être déposé n'importe où dans la fenêtre, pas seulement sur
// la zone en pointillés. Sans cela, un dépôt à côté de la zone ferait quitter
// la page au navigateur, qui ouvrirait le fichier à sa place.
const drop = $("drop");
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  drop.classList.add("over");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) drop.classList.remove("over"); // le pointeur a quitté la fenêtre
});
document.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  drop.classList.remove("over");
  importFiles([...event.dataTransfer.files]);
});

for (const key of ["period", "source", "metric"]) {
  $(key).addEventListener("change", (event) => { state[key] = event.target.value; render(); });
}
$("toggle-table").addEventListener("click", (event) => {
  state.showTable = !state.showTable;
  event.target.textContent = t(state.showTable ? "chart.showChart" : "chart.showTable");
  event.target.setAttribute("aria-pressed", String(state.showTable));
  render();
});
$("reset-settings").addEventListener("click", () => {
  state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
  // La langue affichée accompagne les réglages : le titre de la barre de menus la reprend.
  api("/api/settings", { method: "POST", body: JSON.stringify({ ...state.settings, lang: LANG }) }).catch(() => {});
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
    for (const source of LIVE_SOURCES) {
      const rows = payload.rows.filter((row) => row.source === source);
      // Claude Code reste affiché même vide ; Cowork seulement s'il a servi.
      if (rows.length || source === "claudecode") state.data[source] = { rows, live: true, ready: payload.ready };
      else delete state.data[source];
    }
    applyRate(payload.rate);
    render();
  } catch { /* serveur momentanément injoignable : on garde l'affichage */ }
}

async function startMenubar() {
  // Le plugin ne sert la page que sur 127.0.0.1 : ailleurs (version en ligne,
  // serveur local), inutile d'interroger une API qui n'existe pas.
  if (location.hostname !== "127.0.0.1") return;
  try {
    await api("/api/beat");
  } catch {
    return; // page ouverte hors de la barre de menus
  }
  menubar = true;
  // SwiftBar referme sa fenêtre dès qu'on commence à faire glisser un fichier :
  // ici, l'import passe par le bouton.
  $("drop-title").textContent = t("menubar.dropTitle");
  $("drop-hint").textContent = t("menubar.dropHint");
  // La fenêtre de la barre de menus n'ouvre pas les liens externes : le plugin
  // les ouvre dans le navigateur par défaut (liens connus de lui seulement).
  for (const link of document.querySelectorAll("a[data-link]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      api(`/api/open?link=${link.dataset.link}`).catch(() => {});
    });
  }
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
// La page a démarré : le message de secours d'index.html n'a plus lieu d'être
// (il a pu s'afficher si le chargement a été très lent).
window.EnergIAReady = true;
// Les boutons d'import sont inactifs dans index.html : avant ce point, un clic n'aurait rien fait.
for (const id of ["pick", "sample"]) $(id).disabled = false;
if ($("unsupported")) $("unsupported").hidden = true;
startMenubar();
