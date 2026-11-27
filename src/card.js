// Image de résumé à partager : les quatre chiffres de la période affichée, dessinés
// dans un canevas de 1200 × 630 points (format habituel des aperçus de liens).
// Couleurs fixes, celles du thème sombre de la page, pour que l'image soit la même partout.

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const COLORS = {
  page: "#0d0d0d", surface: "#1a1a19", border: "#2c2c2a",
  primary: "#f0efec", secondary: "#c3c2b7", muted: "#898781",
  accents: ["#eda100", "#d95926", "#3987e5", "#199e70"], // énergie, CO₂, eau, coût
};

// Coupe un texte en lignes qui tiennent dans `width`. `measure(texte)` donne une largeur.
// Au-delà de `maxLines`, la dernière ligne se termine par « … ».
export function wrapLines(measure, text, width, maxLines = 2) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const longer = line ? `${line} ${word}` : word;
    if (!line || measure(longer) <= width) line = longer;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  let last = lines.slice(maxLines - 1).join(" ");
  while (last.length > 1 && measure(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
  return [...lines.slice(0, maxLines - 1), `${last}…`];
}

// `card` : { title, subtitle, tiles: [{ name, value, equiv }] (quatre), note, credit }.
export function drawCard(canvas, card) {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  const font = (size, weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}`; };
  const measure = (text) => ctx.measureText(text).width;
  // Écrit un texte en réduisant la taille jusqu'à ce qu'il tienne dans la largeur.
  const fit = (text, x, y, width, size, weight, least = 16) => {
    do font(size, weight); while (measure(text) > width && --size >= least);
    ctx.fillText(text, x, y);
  };
  const margin = 56;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  ctx.fillStyle = COLORS.primary;
  fit(card.title, margin, 92, CARD_WIDTH - 2 * margin, 46, 700, 28);
  ctx.fillStyle = COLORS.secondary;
  fit(card.subtitle, margin, 134, CARD_WIDTH - 2 * margin, 24, 400);

  const gap = 24;
  const top = 168;
  const tileWidth = (CARD_WIDTH - 2 * margin - gap) / 2;
  const tileHeight = 176;
  card.tiles.forEach((tile, index) => {
    const x = margin + (index % 2) * (tileWidth + gap);
    const y = top + Math.floor(index / 2) * (tileHeight + gap);
    ctx.fillStyle = COLORS.surface;
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, tileWidth, tileHeight, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.accents[index];
    ctx.beginPath();
    ctx.roundRect(x + 24, y + 26, 6, 124, 3);
    ctx.fill();
    const left = x + 48;
    const inner = tileWidth - 48 - 24;
    ctx.fillStyle = COLORS.secondary;
    fit(tile.name, left, y + 46, inner, 21, 400);
    ctx.fillStyle = COLORS.primary;
    fit(tile.value, left, y + 100, inner, 50, 700, 26);
    ctx.fillStyle = COLORS.muted;
    font(19);
    wrapLines(measure, tile.equiv || "", inner).forEach((line, n) => ctx.fillText(line, left, y + 131 + n * 24));
  });

  ctx.fillStyle = COLORS.muted;
  const bottom = CARD_HEIGHT - 36;
  font(19, 600);
  const creditWidth = measure(card.credit);
  ctx.fillText(card.credit, CARD_WIDTH - margin - creditWidth, bottom);
  fit(card.note, margin, bottom, CARD_WIDTH - 2 * margin - creditWidth - 32, 19, 400);
}
