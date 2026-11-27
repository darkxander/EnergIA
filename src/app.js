import { listZipEntries, readZipEntryText } from "./zip.js";
import { combine, parseFileText, rowsOf, teamFile } from "./parsers.js";
import { CARBON, DEFAULT_SETTINGS, EQUIVALENTS, PRICE_SOURCE, classifyModel, priceFor, rowMetrics, summarize, subscriptionCost } from "./model.js";
import { LANG, LANG_KEY, LOCALE, PAGE_EN, t } from "./i18n.js";
import { csvText } from "./csv.js";
import { drawCard } from "./card.js";
import { reportHtml, shiftMonth } from "./report.js";

const SOURCES = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", copilot: "Copilot", claudecode: "Claude Code", cowork: "Claude Cowork",
  anthropicapi: LANG === "fr" ? "API Anthropic" : "Anthropic API", openaiapi: LANG === "fr" ? "API OpenAI" : "OpenAI API",
};
const USAGE_SOURCES = ["anthropicapi", "openaiapi"]; // organisation usage reports: kept per day, not per conversation
const NO_MODEL = ["claude", "gemini", "copilot"]; // exports that do not say which model answered
const LIVE_SOURCES = ["claudecode", "cowork"]; // measured on this computer by the plugin, without an import
const API_HEADERS = { "X-EnergIA": "1" };
const DATA_KEY = "EnergIA.data.v1";
const SETTINGS_KEY = "EnergIA.settings.v1";
const TEAM_KEY = "EnergIA.team.v1";         // the team files received, one per member
const MEMBER_KEY = "EnergIA.memberName";    // the name written in one's own team file
const MANUAL_RATE_KEY = "EnergIA.rateManual";

// Picks up data saved under the old spelling of the name ("energia.").
for (const key of [DATA_KEY, SETTINGS_KEY, MANUAL_RATE_KEY]) {
  const legacy = key.replace("EnergIA.", "energia.");
  const value = localStorage.getItem(legacy);
  if (value === null) continue;
  if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  localStorage.removeItem(legacy);
}
const DEFAULT_RATE_DATE = "2026-11-24"; // date of the ECB rate recorded in defaults.json

const METRICS = {
  energy: { label: t("metric.energy"), get: (m) => m.wh, units: [["Wh", 1], ["kWh", 1000]] },
  co2: { label: t("metric.co2"), get: (m) => m.co2g, units: [["g CO₂e", 1], ["kg CO₂e", 1000]] },
  water: { label: t("metric.water"), get: (m) => m.waterL * 1000, units: [["mL", 1], ["L", 1000]] },
  cost: { label: t("metric.cost"), get: (m) => m.eur, units: [["€", 1]] },
};

const $ = (id) => document.getElementById(id);

// ---------- Language ----------
// index.html is written in French; in English, its texts are replaced here.
// Changing language saves the choice and reloads the page.

document.documentElement.lang = LANG;
if (LANG === "en") {
  document.title = PAGE_EN["page.title"];
  for (const node of document.querySelectorAll("[data-i18n]")) node.innerHTML = PAGE_EN[node.dataset.i18n];
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", PAGE_EN[node.dataset.i18nAria]);
}
const langButton = $("lang"); // missing from an old page still in the cache
if (langButton) {
  langButton.textContent = t("lang.switch");
  langButton.lang = LANG === "fr" ? "en" : "fr";
  langButton.addEventListener("click", () => {
    localStorage.setItem(LANG_KEY, LANG === "fr" ? "en" : "fr");
    location.reload();
  });
}

// ---------- State ----------

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
  // 0.9 was a provisional value from an earlier version, never a choice made by the user.
  if (saved.eurPerUsd === 0.9) delete saved.eurPerUsd;
  // 400 was the approximate world average before the country list: the sourced value is used again.
  if (saved.gCO2PerKWh === 400) delete saved.gCO2PerKWh;
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
  team: loadJSON(TEAM_KEY, {}),   // { key: { name, exportedAt, rows } }, from imported team files
  view: "mine",                   // "mine": one's own data; "team": the members' files added up
  period: "all",
  source: "all",
  metric: "energy",
  showTable: false,
  rateDate: DEFAULT_RATE_DATE, // date of the ECB rate in use, or null if it was entered by hand
};
if (localStorage.getItem(MANUAL_RATE_KEY)) state.rateDate = null;
// Imports are kept per conversation (`items`); the displayed rows are derived from them.
// An import made before this format has only rows: it is kept as is.
for (const [source, entry] of Object.entries(state.data)) {
  if (entry && entry.items) entry.rows = rowsOf(source, entry.items);
}

function saveData() {
  const persistable = {};
  for (const [source, entry] of Object.entries(state.data)) {
    if (entry.sample || entry.live) continue;
    const { rows, ...rest } = entry;
    persistable[source] = entry.items ? rest : entry; // with `items`, the rows are recalculated
  }
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(persistable));
  } catch {
    setStatus(t("status.tooBig"), true);
  }
}

// ---------- Display helpers ----------

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
  // The message sits at the top of the page; the import block may be at the bottom.
  if (message) status.scrollIntoView({ block: "nearest" });
}

// With nothing to show, the import and team blocks come first: they are what to do.
// Once there are figures, the figures come first and these blocks move down, just
// before the assumptions. They are moved in the document, so that reading order and
// keyboard order follow what is seen.
let blocksBelow = null;
function placeBlocks(hasData) {
  if (blocksBelow === hasData) return;
  blocksBelow = hasData;
  const before = hasData ? $("hypotheses-card") : $("results");
  before.before($("import-card"), $("team-card"));
}

// ---------- Import ----------

async function readFile(file) {
  const texts = [];
  if (/\.zip$/i.test(file.name)) {
    const entries = await listZipEntries(file);
    // ChatGPT and Claude: conversations.json; Google Takeout: the JSON file in the Gemini
    // apps folder; Microsoft: Copilot's CSV files.
    const wanted = entries.filter((e) => /(^|\/)conversations[^/]*\.json$/i.test(e.name)
      || /gemini[^/]*\/[^/]*\.json$/i.test(e.name) || /copilot[^/]*\.csv$/i.test(e.name));
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
  const teamFiles = [];
  try {
    for (const file of files) {
      for (const text of await readFile(file)) {
        let parsed;
        try {
          parsed = parseFileText(text);
        } catch {
          throw new Error(t("status.notJson", { file: file.name }));
        }
        if (!parsed) throw new Error(t("status.unknownFormat", { file: file.name }));
        if (parsed.promptsOnly) continue; // prompts without replies: nothing to count
        if (parsed.team) {
          teamFiles.push(parsed);
          continue;
        }
        imported[parsed.source] = combine(imported[parsed.source] || {}, parsed.items).items;
      }
    }
  } catch (error) {
    setStatus(error.code ? t(error.code, error.vars) : error.message, true);
    return;
  }

  // The sample data disappears as soon as a real file is imported.
  for (const source of Object.keys(state.data)) if (state.data[source].sample) delete state.data[source];
  const summary = [];
  for (const [source, incoming] of Object.entries(imported)) {
    // A new import is added to the previous one: a conversation already known is updated,
    // not counted twice. An import from before this format (without `items`) is replaced.
    const previous = state.data[source];
    const merged = combine(previous?.items || {}, incoming);
    const total = Object.keys(merged.items).length;
    state.data[source] = { items: merged.items, rows: rowsOf(source, merged.items), conversations: total, importedAt: new Date().toISOString() };
    if (USAGE_SOURCES.includes(source)) {
      summary.push(t("status.importedDays", { source: SOURCES[source], days: nf(total), added: nf(merged.added), updated: nf(merged.updated + merged.same) }));
      continue;
    }
    summary.push(t(previous?.items ? "status.mergedSource" : "status.importedSource", {
      source: SOURCES[source], conversations: nf(total), added: nf(merged.added), updated: nf(merged.updated),
      requests: nf(state.data[source].rows.reduce((sum, row) => sum + row.requests, 0)),
    }) + (previous && !previous.items ? ` ${t("status.replacedOld")}` : ""));
  }
  // Team files: one per member; a newer file from the same member replaces the previous one.
  for (const file of teamFiles) {
    const rows = file.rows.filter((row) => row.source in SOURCES);
    state.team[file.member.toLowerCase()] = { name: file.member, exportedAt: file.exportedAt, rows };
    summary.push(t("team.added", { name: file.member, requests: nf(rows.reduce((sum, row) => sum + row.requests, 0)) }));
  }
  if (teamFiles.length) {
    state.view = "team";
    saveTeam();
  }
  saveData();
  setStatus(t("status.imported", { summary: summary.join(" · ") }));
  render();
}

function saveTeam() {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(state.team));
  } catch {
    setStatus(t("status.tooBig"), true);
  }
}

function loadSample() {
  // Deterministic pseudo-random generator.
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

// ---------- Calculations ----------

// Local day (YYYY-MM-DD) `back` days ago; 0 = today.
function localDay(back = 0) {
  const date = new Date();
  date.setDate(date.getDate() - back);
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

const teamView = () => state.view === "team" && Object.keys(state.team).length > 0;

// Rows of the chosen service, from `from` (inclusive) to `to` (exclusive); "" = no bound.
// In the team view, the rows of every member's file (each row carries its `member`).
function rowsBetween(from, to, anySource = false) {
  const wanted = (source) => anySource || state.source === "all" || state.source === source;
  const inRange = (row) => row.day >= from && (!to || row.day < to);
  const rows = [];
  if (teamView()) {
    for (const member of Object.values(state.team)) {
      for (const row of member.rows) if (wanted(row.source) && inRange(row)) rows.push(row);
    }
    return rows;
  }
  for (const [source, entry] of Object.entries(state.data)) {
    if (!wanted(source)) continue;
    for (const row of entry.rows) if (inRange(row)) rows.push(row);
  }
  return rows;
}

// N days, today included, in local date ("1" = today only).
function filteredRows() {
  return rowsBetween(state.period === "all" ? "" : localDay(Number(state.period) - 1), "");
}

// The N days before the displayed period, or null for "Whole history".
function previousRows() {
  if (state.period === "all") return null;
  const days = Number(state.period);
  return rowsBetween(localDay(2 * days - 1), localDay(days - 1));
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

// ---------- Rendering ----------

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
      t(USAGE_SOURCES.includes(source) ? "source.daysLine" : "source.line",
        { source: SOURCES[source], conversations: nf(entry.conversations), when }),
      el("button", {
        class: "link", type: "button",
        onclick: () => { delete state.data[source]; saveData(); setStatus(""); render(); },
      }, t("source.remove"))));
  }
  for (const [key, member] of Object.entries(state.team)) {
    const requests = member.rows.reduce((sum, row) => sum + row.requests, 0);
    const when = member.exportedAt ? new Date(member.exportedAt).toLocaleDateString(LOCALE) : "?";
    box.append(el("span", {},
      t("team.line", { name: member.name, requests: nf(requests), date: when }),
      el("button", {
        class: "link", type: "button",
        onclick: () => { delete state.team[key]; saveTeam(); setStatus(""); render(); },
      }, t("source.remove"))));
  }
}

// Alert thresholds: energy or cost, for today or for the current month, across all
// services. Setting, period, displayed quantity, then threshold and total in the same unit.
const BUDGETS = [
  ["dailyBudgetWh", "day", "energy", (s) => s.dailyBudgetWh, (total) => total.wh],
  ["monthlyBudgetKWh", "month", "energy", (s) => s.monthlyBudgetKWh * 1000, (total) => total.wh],
  ["dailyBudgetEur", "day", "cost", (s) => s.dailyBudgetEur, (total) => total.eur],
  ["monthlyBudgetEur", "month", "cost", (s) => s.monthlyBudgetEur, (total) => total.eur],
];

function renderBudget() {
  const box = $("budget");
  if (teamView()) { // the thresholds are personal
    box.hidden = true;
    return;
  }
  const today = localDay(0);
  const totals = {};
  const lines = [];
  for (const [, period, metric, budgetOf, valueOf] of BUDGETS) {
    const budget = budgetOf(state.settings);
    if (!(budget > 0)) continue;
    totals[period] ??= summarize(rowsBetween(period === "day" ? today : `${today.slice(0, 8)}01`, "", true), state.settings);
    const value = valueOf(totals[period]);
    const over = value > budget;
    // A non-zero share that would round to 0%: "less than 1%".
    const share = value > 0 && value / budget < 0.005
      ? t("budget.lessThan", { percent: percent.format(0.01) })
      : percent.format(value / budget);
    lines.push(el("span", { class: over ? "over" : "" }, t(`budget.${period}.${over ? "over" : "under"}`, {
      value: fmt(metric, value), budget: fmt(metric, budget), percent: share,
    })));
  }
  box.hidden = !lines.length;
  box.replaceChildren(...lines);
}

const percent = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0 });
const signedPercent = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0, signDisplay: "always" });

// The four tiles (energy, CO₂, water, cost) and the total of the given rows.
function tilesFor(rows) {
  const s = state.settings;
  const total = summarize(rows, s);
  // Difference from the previous N days, when a period is chosen and they have data.
  const previous = previousRows();
  const before = previous && previous.length ? summarize(previous, s) : null;
  const change = (now, then) => {
    if (!before || !(then > 0)) return "";
    const vars = { change: signedPercent.format(now / then - 1), days: state.period };
    return t(state.period === "1" ? "tile.changeYesterday" : "tile.changeDays", vars);
  };
  const range = (key, value) =>
    t("tile.range", { low: fmt(key, value * s.lowFactor), high: fmt(key, value * s.highFactor) });
  // In the team view, each member pays their own subscriptions.
  const byMember = new Map();
  for (const row of rows) byMember.set(row.member, [...(byMember.get(row.member) || []), row]);
  const subs = [...byMember.values()].reduce((sum, group) => sum + subscriptionCost(group, s), 0);
  const tiles = [
    {
      name: t("metric.energy"), value: fmt("energy", total.wh), range: range("energy", total.wh),
      change: change(total.wh, before?.wh),
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
      change: change(total.eur, before?.eur),
      range: t("tile.costNote"),
      equiv: subs > 0 ? t("tile.subs", { amount: fmt("cost", subs) }) : "",
    },
  ];
  return { tiles, total };
}

function renderTiles(rows) {
  const { tiles, total } = tilesFor(rows);
  $("tiles").replaceChildren(...tiles.map((t) =>
    el("div", { class: "tile" },
      el("div", { class: "name" }, t.name),
      el("div", { class: "value" }, t.value),
      el("p", { class: "range" }, t.range),
      t.equiv ? el("p", { class: "equiv" }, t.equiv) : null,
      t.change ? el("p", { class: "change" }, t.change) : null)));
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
      if (index > 0) yBottom -= gap; // hairline of surface colour between two stacked segments
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
  // Only the services that have something to show in the displayed period.
  const sources = Object.keys(SOURCES).filter((source) => data.some((bucket) => bucket.values[source] > 0));
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
      NO_MODEL.includes(source) ? t("models.unknown") : model,
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

// Country whose electricity is used to calculate CO₂. The choice is not saved separately:
// it is deduced from the carbon intensity in the assumptions (all values are distinct).
const carbonCountries = [
  ...CARBON.countries.slice(0, 2), // World and European Union first
  ...CARBON.countries.slice(2).sort((a, b) => a[LANG].localeCompare(b[LANG], LANG)),
];

function renderCarbon() {
  const select = $("carbon");
  const current = state.settings.gCO2PerKWh;
  const option = (value, label) => el("option", { value }, label);
  const options = carbonCountries.map((country) =>
    option(country.code, t("carbon.option", { name: country[LANG], g: nf(country.g) })));
  const match = carbonCountries.find((country) => country.g === current);
  if (!match) options.unshift(option("custom", t("carbon.custom", { g: nf(current) })));
  select.replaceChildren(...options);
  select.value = match ? match.code : "custom";
  select.title = t("carbon.title", { year: CARBON.year, source: CARBON.citation });
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  pushSettings();
}

// The team view: who used what, over the displayed period and service.
function renderMembers(rows) {
  const section = $("members-card");
  section.hidden = !teamView();
  if (section.hidden) return;
  const groups = new Map();
  for (const row of rows) groups.set(row.member, [...(groups.get(row.member) || []), row]);
  const lines = [...groups.entries()].map(([name, group]) => ({ name, total: summarize(group, state.settings) }));
  const all = lines.reduce((sum, line) => sum + line.total.wh, 0);
  lines.sort((a, b) => b.total.wh - a.total.wh);
  const [first, ...others] = t("team.columns").split("|");
  $("members").replaceChildren(table(
    [{ label: first, text: true }, ...others.map((label) => ({ label }))],
    lines.map(({ name, total }) => [
      name, nf(total.requests), fmt("energy", total.wh), fmt("co2", total.co2g),
      fmt("water", total.waterL * 1000), fmt("cost", total.eur), all > 0 ? percent.format(total.wh / all) : "–",
    ])));
}

// The months that have data in the current view, most recent first, for the report.
function renderReportMonths() {
  const select = $("report-month");
  const months = [...new Set(rowsBetween("", "", true).map((row) => row.day.slice(0, 7)))].sort().reverse();
  const chosen = months.includes(select.value) ? select.value : months[0];
  const label = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
  select.replaceChildren(...months.map((month) => el("option", { value: month }, label.format(new Date(`${month}-01T00:00:00Z`)))));
  if (chosen) select.value = chosen;
}

function renderView() {
  const count = Object.keys(state.team).length;
  const hasOwn = Object.keys(state.data).length > 0;
  if (!count) state.view = "mine";
  else if (!hasOwn) state.view = "team"; // nothing of one's own to show
  $("view-label").hidden = !(count && hasOwn);
  $("view").options[1].textContent = t("view.team", { count });
  $("view").value = state.view;
}

function render() {
  renderView();
  renderSources();
  renderCarbon();
  const hasData = Object.keys(state.data).length > 0 || teamView();
  placeBlocks(hasData);
  $("results").hidden = !hasData;
  if (!hasData) return;
  const rows = filteredRows();
  const data = buckets(rows);
  renderReportMonths();
  renderMembers(rows);
  renderBudget();
  renderTiles(rows);
  renderChart(data);
  renderChartTable(data);
  renderModels(rows);
  $("chart").hidden = state.showTable;
  $("legend").hidden = state.showTable;
  $("chart-table").hidden = !state.showTable;
}

// ---------- Assumptions ----------

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
  [t("settings.budget"), [
    [t("settings.dailyBudget"), "dailyBudgetWh"],
    [t("settings.monthlyBudget"), "monthlyBudgetKWh"],
    [t("settings.dailyBudgetEur"), "dailyBudgetEur"],
    [t("settings.monthlyBudgetEur"), "monthlyBudgetEur"],
  ]],
  [t("settings.subs"), [
    ["ChatGPT", "subs.chatgpt"],
    ["Claude", "subs.claude"],
    ["Gemini", "subs.gemini"],
    ["Copilot", "subs.copilot"],
  ]],
];

function settingAt(path) {
  const parts = path.split(".");
  const last = parts.pop();
  let target = state.settings;
  for (const part of parts) target = target[part];
  return { target, last };
}

// Checkbox for a setting saved as 0 or 1.
function settingCheckbox(label, key) {
  const input = el("input", { type: "checkbox" });
  input.checked = Boolean(state.settings[key]);
  input.addEventListener("change", () => {
    state.settings[key] = input.checked ? 1 : 0;
    saveSettings();
  });
  return el("label", {}, label, input);
}

function renderSettings() {
  // Menu bar title settings: only in the plugin window.
  const menubarGroup = pluginWindow
    ? [el("fieldset", {}, el("legend", {}, t("settings.menubar")), settingCheckbox(t("settings.compactTitle"), "compactTitle"))]
    : [];
  $("settings").replaceChildren(...menubarGroup, ...SETTING_GROUPS.map(([title, fields]) =>
    el("fieldset", {}, el("legend", {}, title), ...fields.map(([label, path]) => {
      const { target, last } = settingAt(path);
      const input = el("input", { type: "number", min: "0", step: "any", value: String(target[last]) });
      input.addEventListener("input", () => {
        const value = Number(input.value);
        if (input.value === "" || !Number.isFinite(value) || value < 0) return;
        target[last] = value;
        if (path === "eurPerUsd") { // a rate entered by hand is no longer replaced by the ECB's
          localStorage.setItem(MANUAL_RATE_KEY, "1");
          state.rateDate = null;
        }
        saveSettings();
        render();
      });
      return el("label", {}, label, input);
    }))));
}

// ---------- Events ----------

$("pick").addEventListener("click", () => (pluginWindow ? pickWithPlugin() : $("file").click()));

// The menu bar window does not open the browser's file
// picker: the plugin opens the macOS one and sends back the chosen file.
async function pickWithPlugin() {
  setStatus(t("status.picking"));
  try {
    const response = await fetch("/api/pick", { method: "POST", headers: API_HEADERS });
    if (response.status === 204) return setStatus(""); // cancelled
    if (!response.ok) throw new Error(String(response.status));
    const name = decodeURIComponent(response.headers.get("X-Filename") || "export.zip");
    await importFiles([new File([await response.blob()], name)]);
  } catch {
    setStatus(t("status.pickFailed"), true);
  }
}
// CSV export: the rows of the displayed period and service, by day and by model.
function exportLines() {
  const rows = filteredRows().slice().sort((a, b) =>
    String(a.member || "").localeCompare(String(b.member || "")) || a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || String(a.model).localeCompare(String(b.model)));
  return rows.map((row) => {
    const m = rowMetrics(row, state.settings);
    return [
      ...(teamView() ? [row.member] : []), row.day, SOURCES[row.source], NO_MODEL.includes(row.source) ? t("models.unknown") : row.model,
      t(`tier.${classifyModel(row.model)}`), row.requests,
      row.inTok + (row.cw5Tok || 0) + (row.cw1Tok || 0), row.cacheTok || 0, row.outTok,
      m.wh, m.co2g, m.waterL, m.eur, t(priceFor(row.model) ? "export.no" : "export.yes"),
    ];
  });
}

// Delivers a file produced by the page: a download in a browser; in the
// menu bar window, which cannot download, the plugin writes it to the
// Downloads folder and shows it in the Finder.
async function deliver(blob, extension, stem = `EnergIA-${localDay(0)}`) {
  if (pluginWindow) {
    try {
      const saved = await api("/api/export", { method: "POST", body: blob, headers: { "Content-Type": blob.type } });
      setStatus(t("export.saved", { path: saved.path }));
    } catch {
      setStatus(t("export.failed"), true);
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${stem}.${extension}` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
  const lines = exportLines();
  if (!lines.length) return setStatus(t("export.empty"), true);
  const header = [...(teamView() ? [t("team.columns").split("|")[0]] : []), ...t("export.columns").split("|")];
  return deliver(new Blob([csvText([header, ...lines], LANG)], { type: "text/csv" }), "csv");
}
$("export-csv").addEventListener("click", exportCSV);
$("export-csv").title = t("export.title");

// Summary image: the four figures of the displayed period and service.
function cardContent(rows) {
  let first = rows[0].day;
  let last = rows[0].day;
  for (const row of rows) {
    if (row.day < first) first = row.day;
    if (row.day > last) last = row.day;
  }
  const day = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const date = (iso) => day.format(new Date(`${iso}T00:00:00Z`));
  const sources = Object.keys(state.data).filter((source) => state.source === "all" || state.source === source);
  const parts = [
    t("card.range", { from: date(first), to: date(last) }),
    state.source === "all" ? t("card.allServices") : SOURCES[state.source],
  ];
  if (teamView()) parts.push(t("card.members", { count: new Set(rows.map((row) => row.member)).size }));
  else if (sources.some((source) => state.data[source].sample)) parts.push(t("card.sample"));
  return {
    title: t(teamView() ? "card.teamTitle" : "card.title"),
    subtitle: parts.join(" · "),
    // The cost tile has no equivalent: its note is a reminder that this is not a bill.
    tiles: tilesFor(rows).tiles.map(({ name, value, equiv }, index) =>
      ({ name, value, equiv: index === 3 ? t("tile.costNote") : equiv })),
    note: t("card.note"),
    credit: "EnergIA · darkxander.github.io/EnergIA",
  };
}

async function shareImage() {
  const rows = filteredRows();
  if (!rows.length) return setStatus(t("export.empty"), true);
  try {
    const canvas = document.createElement("canvas");
    drawCard(canvas, cardContent(rows));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("canvas");
    await deliver(blob, "png");
  } catch {
    setStatus(t("share.failed"), true);
  }
}
$("share-image").addEventListener("click", shareImage);

// Team file: one's own counters, under a chosen name, to send to whoever adds up the team.
$("member-name").value = localStorage.getItem(MEMBER_KEY) || "";
$("member-name").addEventListener("input", (event) => localStorage.setItem(MEMBER_KEY, event.target.value.trim()));
$("team-export").addEventListener("click", () => {
  const name = $("member-name").value.trim();
  if (!name) return setStatus(t("team.needName"), true);
  const rows = [];
  for (const [source, entry] of Object.entries(state.data)) {
    if (!entry.sample) for (const row of entry.rows) rows.push({ ...row, source });
  }
  if (!rows.length) return setStatus(t("team.needData"), true);
  const file = teamFile(name, rows, new Date().toISOString());
  return deliver(new Blob([JSON.stringify(file)], { type: "application/json" }), "json", `EnergIA-team-${localDay(0)}`);
});
$("view").addEventListener("change", (event) => { state.view = event.target.value; render(); });

// Monthly report for the current view (one's own data or the team) and the chosen service.
function monthlyReport(month) {
  const s = state.settings;
  const rows = rowsBetween(`${month}-01`, `${shiftMonth(month, 1)}-01`);
  if (!rows.length) return null;
  const total = summarize(rows, s);
  const before = summarize(rowsBetween(`${shiftMonth(month, -1)}-01`, `${month}-01`), s);
  const monthName = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
  const nameOf = (value) => monthName.format(new Date(`${value}-01T00:00:00Z`));
  const change = (now, then) => (then > 0 ? t("report.change", { change: signedPercent.format(now / then - 1) }) : t("report.noChange"));
  const range = (key, value) => t("tile.range", { low: fmt(key, value * s.lowFactor), high: fmt(key, value * s.highFactor) });
  const share = (value) => (total.wh > 0 ? percent.format(value / total.wh) : "–");
  const grouped = (keyOf) => {
    const groups = new Map();
    for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) || []), row]);
    return [...groups.entries()].map(([key, group]) => ({ key, group, total: summarize(group, s) }))
      .sort((a, b) => b.total.wh - a.total.wh);
  };
  const figuresOf = (sum) => [nf(sum.requests), fmt("energy", sum.wh), fmt("co2", sum.co2g), fmt("water", sum.waterL * 1000), fmt("cost", sum.eur)];
  const columns = t("report.columns").split("|"); // Requests|Energy|CO₂|Water|Cost|Share of energy
  const team = teamView();
  const members = team ? new Set(rows.map((row) => row.member)).size : 0;
  const sample = !team && Object.values(state.data).some((entry) => entry.sample);

  const sections = [];
  if (team) {
    sections.push({ heading: t("report.byMember"), table: {
      headers: [t("team.columns").split("|")[0], ...columns],
      rows: grouped((row) => row.member).map(({ key, total: sum }) => [key, ...figuresOf(sum), share(sum.wh)]),
    } });
  }
  sections.push({ heading: t("report.byService"), table: {
    headers: [t("models.service"), ...columns],
    rows: grouped((row) => row.source).map(({ key, total: sum }) => [SOURCES[key], ...figuresOf(sum), share(sum.wh)]),
  } });
  const unpriced = rows.some((row) => !priceFor(row.model));
  sections.push({ heading: t("report.byModel"), note: unpriced ? t("report.indicative") : "", table: {
    headers: [t("models.service"), t("models.model"), t("models.tier"), ...columns], textColumns: 3,
    rows: grouped((row) => `${row.source}|${row.model}`).map(({ group, total: sum }) => {
      const { source, model } = group[0];
      const figures = figuresOf(sum);
      if (!priceFor(model)) figures[4] += " *";
      return [SOURCES[source], NO_MODEL.includes(source) ? t("models.unknown") : model, t(`tier.${classifyModel(model)}`), ...figures, share(sum.wh)];
    }),
  } });
  const history = [];
  for (let back = 5; back >= 0; back--) {
    const start = shiftMonth(month, -back);
    const sum = summarize(rowsBetween(`${start}-01`, `${shiftMonth(start, 1)}-01`), s);
    if (sum.requests || history.length) history.push([nameOf(start), ...figuresOf(sum)]);
  }
  sections.push({ heading: t("report.history"), table: { headers: [t("report.month"), ...columns.slice(0, 5)], rows: history } });

  const country = CARBON.countries.find((item) => item.g === s.gCO2PerKWh);
  const number = (value) => value.toLocaleString(LOCALE, { maximumFractionDigits: 4 });
  const assumptions = [
    [`${t("settings.energy")} – ${t("settings.light")}`, number(s.tiers.leger.whOut)],
    [`${t("settings.energy")} – ${t("settings.standard")}`, number(s.tiers.standard.whOut)],
    [`${t("settings.energy")} – ${t("settings.large")}`, number(s.tiers.grand.whOut)],
    [`${t("settings.energy")} – ${t("settings.reasoning")}`, number(s.tiers.raisonnement.whOut)],
    [t("settings.inputRatio"), number(s.inputRatio)],
    [t("settings.cacheRatio"), number(s.cacheReadRatio)],
    [t("settings.low"), number(s.lowFactor)],
    [t("settings.high"), number(s.highFactor)],
    [t("settings.carbon"), country ? `${number(s.gCO2PerKWh)} (${country[LANG]}, ${CARBON.year})` : number(s.gCO2PerKWh)],
    [t("settings.water"), number(s.waterLPerKWh)],
    [t("settings.rate"), number(s.eurPerUsd)],
  ];
  sections.push({
    heading: t("report.method"),
    paragraphs: [t("report.methodIntro"), ...(team ? [t("report.methodTeam")] : []),
      t("report.methodCost", { checked: new Date(PRICE_SOURCE.checked).toLocaleDateString(LOCALE) }),
      t("report.methodCarbon", { source: CARBON.citation })],
    table: { headers: [t("report.assumption"), t("report.value")], rows: assumptions },
  });

  const subtitle = [
    team ? t("card.members", { count: members }) : t("report.personal"),
    state.source === "all" ? t("card.allServices") : SOURCES[state.source],
    ...(sample ? [t("card.sample")] : []),
    // The current month is not over: its figures are partial, and so is the comparison.
    ...(month === localDay(0).slice(0, 7) ? [t("report.inProgress")] : []),
  ].join(" · ");
  return {
    lang: LANG,
    title: t(team ? "report.teamTitle" : "report.title", { month: nameOf(month) }),
    subtitle,
    figures: [
      { name: t("metric.energy"), value: fmt("energy", total.wh), detail: `${range("energy", total.wh)} · ${change(total.wh, before.wh)}` },
      { name: t("metric.co2"), value: fmt("co2", total.co2g), detail: `${range("co2", total.co2g)} · ${change(total.co2g, before.co2g)}` },
      { name: t("metric.water"), value: fmt("water", total.waterL * 1000), detail: `${range("water", total.waterL * 1000)} · ${change(total.waterL, before.waterL)}` },
      { name: t("tile.costName"), value: fmt("cost", total.eur), detail: change(total.eur, before.eur) },
    ],
    sections,
    footer: t("report.footer", { date: new Date().toLocaleDateString(LOCALE), requests: nf(total.requests), tokens: nfBig(total.tokens) }),
  };
}

$("report").addEventListener("click", () => {
  const month = $("report-month").value;
  const report = month && monthlyReport(month);
  if (!report) return setStatus(t("export.empty"), true);
  return deliver(new Blob([reportHtml(report)], { type: "text/html" }), "html", `EnergIA-report-${month}`);
});
$("report").title = t("report.buttonTitle");
$("share-image").title = t("share.title");

$("file").addEventListener("change", (event) => {
  importFiles([...event.target.files]);
  event.target.value = "";
});
$("sample").addEventListener("click", loadSample);

// A file can be dropped anywhere in the window, not only on
// the dashed area. Without this, a drop beside the area would make the browser
// leave the page and open the file in its place.
const drop = $("drop");
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  drop.classList.add("over");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) drop.classList.remove("over"); // the pointer has left the window
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
$("carbon").addEventListener("change", (event) => {
  const country = CARBON.countries.find((item) => item.code === event.target.value);
  if (!country) return; // "Custom": the value entered in the assumptions stays
  state.settings.gCO2PerKWh = country.g;
  saveSettings();
  renderSettings();
  render();
});
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
  if (menubar) loadClaudeCode(); // picks up the rate fetched by the plugin
  pushSettings();
  renderSettings();
  render();
});

// ---------- Menu bar ----------
// Served by the plugin (menu bar or "server-only" mode), the page also receives
// the Claude Code usage measured on this computer. Opened any other way, /api
// does not exist and nothing changes.

let menubar = false;      // served by the plugin: live measurements
let pluginWindow = false; // displayed in the SwiftBar window, not in a browser

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { ...API_HEADERS, ...options.headers } });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function pushSettings() {
  if (!menubar) return;
  // The displayed language goes with the settings: the menu bar title uses it.
  api("/api/settings", { method: "POST", body: JSON.stringify({ ...state.settings, lang: LANG }) }).catch(() => {});
}

// ECB rate fetched each day by the plugin, unless the user has entered their own.
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
      // Claude Code stays displayed even when empty; Cowork only if it has been used.
      if (rows.length || source === "claudecode") state.data[source] = { rows, live: true, ready: payload.ready };
      else delete state.data[source];
    }
    applyRate(payload.rate);
    render();
  } catch { /* server momentarily unreachable: the display is kept */ }
}

async function startMenubar() {
  // The plugin serves the page only on 127.0.0.1: elsewhere (online version,
  // local server), there is no point querying an API that does not exist.
  if (location.hostname !== "127.0.0.1") return;
  let beat;
  try {
    beat = await api("/api/beat");
  } catch {
    return; // page opened outside the plugin
  }
  menubar = true;
  pluginWindow = beat.window !== false; // "server-only" mode answers window: false
  // The compact title belongs to the plugin: its value is used rather than overwritten.
  if (typeof beat.compactTitle === "number") state.settings.compactTitle = beat.compactTitle;
  if (pluginWindow) {
    // SwiftBar closes its window as soon as a file starts being dragged:
    // here, the import goes through the button.
    $("drop-title").textContent = t("menubar.dropTitle");
    $("drop-hint").textContent = t("menubar.dropHint");
    // The menu bar window does not open external links: the plugin
    // opens them in the default browser (only links known to it).
    for (const link of document.querySelectorAll("a[data-link]")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        api(`/api/open?link=${link.dataset.link}`).catch(() => {});
      });
    }
    renderSettings(); // adds the settings specific to the menu bar
  }
  // While the page is visible, the plugin holds back its title changes.
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
// The page has started: the fallback message in index.html is no longer needed
// (it may have been shown if loading was very slow).
window.EnergIAReady = true;
// The import buttons are disabled in index.html: before this point, a click would have done nothing.
for (const id of ["pick", "sample"]) $(id).disabled = false;
if ($("unsupported")) $("unsupported").hidden = true;
startMenubar();
