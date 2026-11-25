// Lecture des exports de données ChatGPT et Claude.
// Aucun texte de conversation n'est conservé : seuls des compteurs agrégés
// par jour, source et modèle sortent d'ici.

// Estimation grossière : environ 4 caractères par token.
export const estimateTokens = (text) => (text ? Math.ceil(text.length / 4) : 0);

const dayOf = (date) => (Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10));

class Aggregator {
  constructor(source) {
    this.source = source;
    this.rows = new Map();
    this.conversations = 0;
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

  result() {
    return { source: this.source, conversations: this.conversations, rows: [...this.rows.values()] };
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
  const agg = new Aggregator("chatgpt");
  for (const conv of conversations) {
    const mapping = conv && conv.mapping;
    if (!mapping) continue;
    agg.conversations += 1;

    const tokens = new Map();
    for (const [id, node] of Object.entries(mapping)) {
      tokens.set(id, node.message ? estimateTokens(chatgptText(node.message.content)) : 0);
    }

    // Tokens cumulés de la racine jusqu'à chaque nœud (le contexte relu à chaque réponse).
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

    let pendingRequests = 0;
    for (const { id, node, time } of messages) {
      const message = node.message;
      const role = message.author.role;
      const meta = message.metadata || {};
      const count = tokens.get(id);
      if (role === "user") {
        if (count > 0 && !meta.is_visually_hidden_from_conversation) pendingRequests += 1;
      } else if (role === "assistant" && count > 0) {
        const inTok = cumulativeOf(node.parent);
        const model = meta.model_slug || conv.default_model_slug || "inconnu";
        agg.add(dayOf(new Date(time * 1000)), model, pendingRequests, inTok, count);
        pendingRequests = 0;
      }
    }
  }
  return agg.result();
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
  const agg = new Aggregator("claude");
  for (const conv of conversations) {
    if (!conv || !Array.isArray(conv.chat_messages)) continue;
    agg.conversations += 1;
    let context = 0;
    let pendingRequests = 0;
    for (const message of conv.chat_messages) {
      const count = estimateTokens(claudeText(message));
      if (message.sender === "human") {
        if (count > 0) pendingRequests += 1;
      } else if (message.sender === "assistant" && count > 0) {
        const day = dayOf(new Date(message.created_at || conv.created_at));
        // L'export Claude n'indique pas le modèle utilisé.
        agg.add(day, "claude", pendingRequests, context, count);
        pendingRequests = 0;
      }
      context += count;
    }
  }
  return agg.result();
}

// ---------- Détection ----------

export function parseExport(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.conversations) ? json.conversations : null;
  if (!list) return null;
  if (list.some((c) => c && c.mapping)) return parseChatGPT(list);
  if (list.some((c) => c && Array.isArray(c.chat_messages))) return parseClaude(list);
  return null;
}
