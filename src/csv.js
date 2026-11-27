// Écriture d'un tableau en texte CSV, lisible par un tableur.
//
// En français : point-virgule entre les colonnes et virgule décimale, comme
// l'attend un tableur réglé en français. En anglais : virgule et point décimal.

const RISKY = /^[=+\-@\t\r]/; // un tableur exécuterait une cellule de texte qui commence ainsi

function cell(value, separator, decimal) {
  if (typeof value === "number") {
    // Six chiffres significatifs, sans notation scientifique ni zéros inutiles.
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

// `lines` : tableau de lignes, chaque ligne étant un tableau de textes et de nombres.
export function csvText(lines, lang) {
  const [separator, decimal] = lang === "fr" ? [";", ","] : [",", "."];
  // Le caractère invisible du début indique à Excel que le texte est en UTF-8.
  return `﻿${lines.map((line) => line.map((value) => cell(value, separator, decimal)).join(separator)).join("\r\n")}\r\n`;
}
