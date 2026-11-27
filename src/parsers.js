// Reads the data exports from ChatGPT, Claude, Gemini and Copilot.
// No conversation text is kept: only counters per day and per
// model come out of here, stored per conversation under an anonymous key. That key is used
// to avoid counting twice a conversation present in two imports.

// Rough estimate: about 4 characters per token.
export const estimateTokens = (text) => (text ? Math.ceil(text.length / 4) : 0);

const dayOf = (date) => (Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10));

// Two 32-bit fingerprints built differently (multiplier, mixing), so
// that two distinct identifiers practically never give the same key.
function hash32(text, seed, prime) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ (text.charCodeAt(i) + i), prime);
    h ^= h >>> 15;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Short key of a conversation: a fingerprint of its identifier, not the identifier.
export const shortKey = (text) => hash32(text, 0x811c9dc5, 0x01000193) + hash32(text, 0x9747b28c, 0x5bd1e995);

// Stores a conversation ({ u: update date in seconds or 0, rows }) in `items`.
// Already present: the most recent version wins, the new one in case of doubt.
// Returns "added", "updated", "same" (identical) or "kept" (the old one was more recent).
export function putConversation(items, key, item) {
  const existing = items[key];
  if (!existing) {
    items[key] = item;
    return "added";
  }
  if (existing.u && item.u && existing.u > item.u) return "kept";
  if (JSON.stringify(existing.rows) === JSON.stringify(item.rows)) {
    items[key] = item;
    return "same";
  }
  items[key] = item;
  return "updated";
}

// Adds the `incoming` conversations to `previous` (not modified) and counts what changes.
export function combine(previous, incoming) {
  const items = { ...previous };
  const counts = { added: 0, updated: 0, same: 0, kept: 0 };
  for (const [key, item] of Object.entries(incoming)) counts[putConversation(items, key, item)] += 1;
  return { items, ...counts };
}

// The rows per day and per model of a set of conversations.
export function rowsOf(source, items) {
  const rows = new Map();
  for (const item of Object.values(items)) {
    for (const part of item.rows) {
      const key = `${part.day}|${part.model}`;
      let row = rows.get(key);
      if (!row) {
        row = { day: part.day, source, model: part.model, requests: 0, responses: 0, inTok: 0, outTok: 0 };
        rows.set(key, row);
      }
      row.requests += part.requests;
      row.responses += part.responses;
      row.inTok += part.inTok;
      row.outTok += part.outTok;
    }
  }
  return [...rows.values()];
}

// The conversations of an export, each with its counters.
class Collector {
  constructor(source) {
    this.source = source;
    this.items = {};
  }

  // `id`: identifier of the conversation in the export; `created` and `updated`: dates.
  add(one, index, id, created, updated) {
    const rows = [...one.rows.values()].map(({ source, ...row }) => row);
    const name = id ? `id:${id}` : created ? `t:${created}` : `x:${index}:${JSON.stringify(rows)}`;
    const u = Number.isFinite(updated) && updated > 0 ? Math.round(updated) : 0;
    putConversation(this.items, shortKey(`${this.source}:${name}`), { u, rows });
  }

  result() {
    return { source: this.source, conversations: Object.keys(this.items).length,
      rows: rowsOf(this.source, this.items), items: this.items };
  }
}

class Aggregator {
  constructor(source) {
    this.source = source;
    this.rows = new Map();
  }

  add(day, model, requests, inTok, outTok) {
    if (!day) return;
    const key = `${day}|${model}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { day, source: this.source, model, requests: 0, responses: 0, inTok: 0, outTok: 0 };
      this.rows.set(key, row);
    }
    row.requests += requests;
    row.responses += 1;
    row.inTok += inTok;
    row.outTok += outTok;
  }
}

// ---------- ChatGPT ----------

function chatgptText(content) {
  if (!content) return "";
  let s = "";
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") s += part;
      else if (part && typeof part.text === "string") s += part.text;
    }
  }
  if (typeof content.text === "string") s += content.text;
  if (typeof content.result === "string") s += content.result;
  if (typeof content.content === "string") s += content.content;
  if (Array.isArray(content.thoughts)) {
    for (const thought of content.thoughts) {
      if (thought && typeof thought.content === "string") s += thought.content;
    }
  }
  return s;
}

function parseChatGPT(conversations) {
  const all = new Collector("chatgpt");
  for (const [index, conv] of conversations.entries()) {
    const mapping = conv && conv.mapping;
    if (!mapping) continue;
    const agg = new Aggregator("chatgpt");

    const tokens = new Map();
    for (const [id, node] of Object.entries(mapping)) {
      tokens.set(id, node.message ? estimateTokens(chatgptText(node.message.content)) : 0);
    }

    // Cumulative tokens from the root down to each node (the context re-read at each response).
    const cumulative = new Map();
    const cumulativeOf = (id) => {
      const chain = [];
      let cursor = id;
      while (cursor && mapping[cursor] && !cumulative.has(cursor)) {
        chain.push(cursor);
        cursor = mapping[cursor].parent;
      }
      let total = cursor && cumulative.has(cursor) ? cumulative.get(cursor) : 0;
      for (let i = chain.length - 1; i >= 0; i--) {
        total += tokens.get(chain[i]);
        cumulative.set(chain[i], total);
      }
      return cumulative.get(id) ?? 0;
    };

    const fallbackTime = conv.create_time || 0;
    const messages = Object.entries(mapping)
      .filter(([, node]) => node.message && node.message.author)
      .map(([id, node]) => ({ id, node, time: node.message.create_time || fallbackTime }))
      .sort((a, b) => a.time - b.time);

    // A response can be split into several consecutive messages
    // (thinking, thinking summary, text). They form a single turn: the
    // context is read only once, and the model is often given only
    // on the last message.
    const isAssistant = (id) => mapping[id]?.message?.author?.role === "assistant";
    const turnStart = (id) => {
      let cursor = id;
      while (isAssistant(mapping[cursor].parent)) cursor = mapping[cursor].parent;
      return cursor;
    };

    const turns = new Map();
    let pendingRequests = 0;
    for (const { id, node, time } of messages) {
      const message = node.message;
      const role = message.author.role;
      const meta = message.metadata || {};
      const count = tokens.get(id);
      if (role === "user") {
        if (count > 0 && !meta.is_visually_hidden_from_conversation) pendingRequests += 1;
      } else if (role === "assistant" && count > 0) {
        const start = turnStart(id);
        let turn = turns.get(start);
        if (!turn) {
          turn = { time, requests: pendingRequests, inTok: cumulativeOf(mapping[start].parent), outTok: 0, model: null };
          turns.set(start, turn);
          pendingRequests = 0;
        }
        turn.outTok += count;
        turn.model ??= meta.resolved_model_slug || meta.model_slug || null;
      }
    }
    for (const turn of turns.values()) {
      const model = turn.model || conv.default_model_slug || "inconnu";
      agg.add(dayOf(new Date(turn.time * 1000)), model, turn.requests, turn.inTok, turn.outTok);
    }
    all.add(agg, index, conv.conversation_id || conv.id, conv.create_time, Number(conv.update_time));
  }
  return all.result();
}

// ---------- Claude ----------

function claudeText(message) {
  let s = "";
  if (Array.isArray(message.content) && message.content.length) {
    for (const block of message.content) {
      if (!block) continue;
      if (typeof block.text === "string") s += block.text;
      if (typeof block.thinking === "string") s += block.thinking;
      if (block.input) s += JSON.stringify(block.input);
      if (block.type === "tool_result" && block.content) {
        s += typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
    }
  }
  if (!s && typeof message.text === "string") s = message.text;
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (attachment && typeof attachment.extracted_content === "string") s += attachment.extracted_content;
    }
  }
  return s;
}

function parseClaude(conversations) {
  const all = new Collector("claude");
  for (const [index, conv] of conversations.entries()) {
    if (!conv || !Array.isArray(conv.chat_messages)) continue;
    const agg = new Aggregator("claude");
    let context = 0;
    let pendingRequests = 0;
    for (const message of conv.chat_messages) {
      const count = estimateTokens(claudeText(message));
      if (message.sender === "human") {
        if (count > 0) pendingRequests += 1;
      } else if (message.sender === "assistant" && count > 0) {
        const day = dayOf(new Date(message.created_at || conv.created_at));
        // The Claude export does not say which model was used.
        agg.add(day, "claude", pendingRequests, context, count);
        pendingRequests = 0;
      }
      context += count;
    }
    all.add(agg, index, conv.uuid, conv.created_at, Date.parse(conv.updated_at) / 1000);
  }
  return all.result();
}

// ---------- Gemini ----------
// Google Takeout, "My Activity" for the Gemini apps, in JSON format: an array
// of events, one per exchange. Google does not document this format, and the public
// descriptions do not agree; the three forms described are accepted:
//   - details: [{ name: "Request" | "Response", value }];
//   - userInteractions: [{ userInteraction: { request, response } }] (JSON texts);
//   - title ("Prompted …") for the request and safeHtmlItem: [{ html }] for the response.
// The export does not say which model replied. Not verified on a real export.

const isGeminiEvent = (e) => e && typeof e.time === "string"
  && /gemini|bard/i.test(`${e.header || ""} ${(Array.isArray(e.products) ? e.products : []).join(" ")} ${e.titleUrl || ""}`);

// All the texts of a JSON value, end to end.
function deepText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(deepText).join("");
  if (value && typeof value === "object") return Object.values(value).map(deepText).join("");
  return "";
}

// A text that contains JSON: its texts only; otherwise the text as is.
function unwrap(text) {
  if (typeof text !== "string") return deepText(text);
  if (!/^\s*[[{"]/.test(text)) return text;
  try {
    return deepText(JSON.parse(text));
  } catch {
    return text;
  }
}

const stripHtml = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

function geminiExchange(event) {
  let prompt = "";
  let reply = "";
  if (Array.isArray(event.details)) {
    const named = (pattern) => event.details.filter((d) => d && pattern.test(String(d.name || ""))).map((d) => deepText(d.value)).join("");
    prompt = named(/request|prompt/i);
    reply = named(/response|answer/i);
  }
  if (Array.isArray(event.userInteractions)) {
    for (const entry of event.userInteractions) {
      const interaction = (entry && entry.userInteraction) || entry || {};
      prompt += unwrap(interaction.request);
      reply += unwrap(interaction.response);
    }
  }
  if (Array.isArray(event.safeHtmlItem)) {
    reply += event.safeHtmlItem.map((item) => stripHtml(item && item.html)).join(" ");
    if (!prompt && typeof event.title === "string") prompt = event.title; // "Prompted …", label included
  }
  return { prompt, reply };
}

function parseGemini(events) {
  // The exchanges of one conversation carry the same link; without a link, each stands alone.
  const groups = new Map();
  for (const event of events) {
    if (!isGeminiEvent(event)) continue;
    const time = Date.parse(event.time);
    if (Number.isNaN(time)) continue;
    const { prompt, reply } = geminiExchange(event);
    if (!prompt && !reply) continue;
    const link = /\/app\/(?:c\/)?([\w-]+)/.exec(event.titleUrl || "");
    const id = link ? link[1] : `t:${event.time}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ time, prompt: estimateTokens(prompt), reply: estimateTokens(reply) });
  }
  const all = new Collector("gemini");
  let index = 0;
  for (const [id, exchanges] of groups) {
    exchanges.sort((a, b) => a.time - b.time);
    const agg = new Aggregator("gemini");
    let context = 0;
    for (const exchange of exchanges) {
      agg.add(dayOf(new Date(exchange.time)), "gemini", 1, context + exchange.prompt, exchange.reply);
      context += exchange.prompt + exchange.reply;
    }
    all.add(agg, index++, id, exchanges[0].time, exchanges[exchanges.length - 1].time / 1000);
  }
  return all.result();
}

// ---------- Copilot ----------
// CSV export from Microsoft's privacy dashboard. Two layouts,
// recognised by their header row:
//   - Conversation, Time, Author, Message (history of the Copilot apps);
//   - CreatedAt, MessageContent, Author, ChatName (Copilot Chat, Microsoft 365).
// A third file (Timestamp, ClientApp, Prompt) contains only requests, without
// responses: it is recognised but nothing from it is counted. The export gives neither model nor
// conversation identifier. Not verified on a real export.

// CSV text -> array of rows; doubled quotes and line breaks inside cells.
export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, "");
  const firstLine = source.slice(0, source.search(/\r|\n|$/));
  const separator = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const lines = [];
  let line = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === separator) { line.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      line.push(cell);
      cell = "";
      if (line.length > 1 || line[0] !== "") lines.push(line);
      line = [];
    } else cell += char;
  }
  line.push(cell);
  if (line.length > 1 || line[0] !== "") lines.push(line);
  return lines;
}

// "2026-02-17T14:36:11" or "2/17/2026 2:36:11 PM +01:00" -> milliseconds, or NaN.
function copilotTime(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s*(?:([+-])(\d{2}):?(\d{2}))?$/i.exec(String(text).trim());
  if (!m) return Date.parse(String(text).trim());
  let hour = Number(m[4]) % (m[7] ? 12 : 24);
  if (m[7] && m[7].toUpperCase() === "PM") hour += 12;
  const utc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0));
  return m[8] ? utc - (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60000 : utc;
}

const COPILOT_GAP = 24 * 3600 * 1000; // beyond this, the same title is counted as another conversation

export function parseCopilotCsv(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) return null;
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (...wanted) => names.findIndex((name) => wanted.includes(name));
  const author = column("author");
  const message = column("message", "messagecontent");
  const time = column("time", "createdat");
  const title = column("conversation", "chatname");
  const all = new Collector("copilot");
  if (author < 0 || message < 0 || time < 0 || title < 0) {
    // The Windows apps file: requests only, nothing to count.
    return column("prompt") >= 0 && column("timestamp") >= 0 ? { ...all.result(), promptsOnly: true } : null;
  }
  const byTitle = new Map();
  for (const line of lines) {
    const at = copilotTime(line[time] || "");
    if (Number.isNaN(at)) continue;
    const key = line[title] || "";
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push({ at, human: /^(user|human)$/i.test((line[author] || "").trim()), tokens: estimateTokens(line[message] || "") });
  }
  let index = 0;
  for (const [key, messages] of byTitle) {
    messages.sort((a, b) => a.at - b.at);
    let start = 0;
    for (let i = 1; i <= messages.length; i++) {
      if (i < messages.length && messages[i].at - messages[i - 1].at <= COPILOT_GAP) continue;
      const session = messages.slice(start, i);
      start = i;
      const agg = new Aggregator("copilot");
      let context = 0;
      let pendingRequests = 0;
      for (const item of session) {
        if (item.human) {
          if (item.tokens > 0) pendingRequests += 1;
        } else if (item.tokens > 0) {
          agg.add(dayOf(new Date(item.at)), "copilot", pendingRequests, context, item.tokens);
          pendingRequests = 0;
        }
        context += item.tokens;
      }
      all.add(agg, index++, `${key}|${session[0].at}`, session[0].at, session[session.length - 1].at / 1000);
    }
  }
  return all.result();
}

// ---------- Detection ----------

export function parseExport(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.conversations) ? json.conversations : null;
  if (!list) return null;
  if (list.some((c) => c && c.mapping)) return parseChatGPT(list);
  if (list.some((c) => c && Array.isArray(c.chat_messages))) return parseClaude(list);
  if (list.some(isGeminiEvent)) return parseGemini(list);
  return null;
}

// The text of a file: JSON (ChatGPT, Claude, Gemini) or CSV (Copilot).
// Returns null if the format is not recognised; throws an error if the JSON is invalid.
export function parseFileText(text) {
  const clean = String(text).replace(/^\uFEFF/, "");
  return /^\s*[[{]/.test(clean) ? parseExport(JSON.parse(clean)) : parseCopilotCsv(clean);
}
