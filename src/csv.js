// Writes a table as CSV text, readable by a spreadsheet.
//
// In French: semicolon between columns and decimal comma, as expected by
// a spreadsheet set to French. In English: comma and decimal point.

const RISKY = /^[=+\-@\t\r]/; // a spreadsheet would execute a text cell that starts like this

function cell(value, separator, decimal) {
  if (typeof value === "number") {
    // Six significant figures, without scientific notation or needless zeros.
    if (!Number.isFinite(value)) return "";
    if (value === 0) return "0";
    const decimals = Math.min(12, Math.max(0, 5 - Math.floor(Math.log10(Math.abs(value)))));
    const text = value.toFixed(decimals);
    return (decimals ? text.replace(/\.?0+$/, "") : text).replace(".", decimal);
  }
  let text = String(value ?? "");
  if (RISKY.test(text)) text = `'${text}`;
  return text.includes(separator) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// `lines`: array of rows, each row being an array of texts and numbers.
export function csvText(lines, lang) {
  const [separator, decimal] = lang === "fr" ? [";", ","] : [",", "."];
  // The invisible character at the start tells Excel that the text is in UTF-8.
  return `﻿${lines.map((line) => line.map((value) => cell(value, separator, decimal)).join(separator)).join("\r\n")}\r\n`;
}
