// Monthly report: a standalone HTML document, readable in any browser and printable
// to PDF. Everything is inline (no script, no external file), and every text is escaped:
// member and model names come from files written by other people.

export const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const STYLE = `
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b; background: #fff;
    max-width: 820px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  p { margin: 6px 0; }
  .muted { color: #52514e; }
  .figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0 4px; }
  .figure { border: 1px solid #e1e0d9; border-radius: 10px; padding: 12px; }
  .figure .name { color: #52514e; font-size: 12px; }
  .figure .value { font-size: 20px; font-weight: 700; margin: 2px 0; }
  .figure .detail { color: #52514e; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid #e1e0d9; }
  th { color: #52514e; font-weight: 600; }
  th, td { white-space: nowrap; }
  th.text, td.text { text-align: left; white-space: normal; }
  footer { margin-top: 32px; color: #52514e; font-size: 12px; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

function tableHtml({ headers, textColumns = 1, rows }) {
  const cell = (tag, value, index) => `<${tag}${index < textColumns ? ' class="text"' : ""}>${escapeHtml(value)}</${tag}>`;
  const head = `<tr>${headers.map((value, index) => cell("th", value, index)).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`).join("\n");
  return `<table>\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

// `report`: { lang, title, subtitle, figures: [{ name, value, detail }],
//   sections: [{ heading, paragraphs?: [text], table?: { headers, textColumns, rows }, note? }], footer }.
export function reportHtml(report) {
  const figures = report.figures.map((figure) =>
    `<div class="figure"><div class="name">${escapeHtml(figure.name)}</div>`
    + `<div class="value">${escapeHtml(figure.value)}</div><div class="detail">${escapeHtml(figure.detail)}</div></div>`).join("\n");
  const sections = report.sections.map((section) => [
    `<h2>${escapeHtml(section.heading)}</h2>`,
    ...(section.paragraphs || []).map((text) => `<p>${escapeHtml(text)}</p>`),
    section.table ? tableHtml(section.table) : "",
    section.note ? `<p class="muted">${escapeHtml(section.note)}</p>` : "",
  ].filter(Boolean).join("\n")).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(report.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(report.title)}</h1>
<p class="muted">${escapeHtml(report.subtitle)}</p>
<div class="figures">
${figures}
</div>
${sections}
<footer>${escapeHtml(report.footer)}</footer>
</body>
</html>
`;
}

// "2026-11" moved by `count` months (negative to go back).
export function shiftMonth(month, count) {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + count, 1));
  return date.toISOString().slice(0, 7);
}
