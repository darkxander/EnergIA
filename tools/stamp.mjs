// Numérote les fichiers de la page d'après leur contenu.
//
// Le navigateur garde les fichiers en mémoire quelques minutes. Sans numéro, une
// mise à jour peut lui faire mélanger une nouvelle page avec un ancien script.
// index.html demande donc chaque fichier avec « ?v=<empreinte> » : l'empreinte
// change dès qu'un fichier change, et le navigateur recharge alors l'ensemble.
//
// Après toute modification de styles.css ou de src/ :   node tools/stamp.mjs
// Les tests échouent si l'empreinte inscrite dans index.html n'est plus à jour.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

export function assetFiles() {
  const sources = readdirSync(new URL("src/", root)).filter((name) => /\.(js|json)$/.test(name)).sort();
  return ["styles.css", ...sources.map((name) => `src/${name}`)];
}

export function assetVersion() {
  const hash = createHash("sha256");
  for (const path of assetFiles()) hash.update(`${path}\n${read(path)}\n`);
  return hash.digest("hex").slice(0, 8);
}

// index.html tel qu'il doit être pour la version donnée.
export function stamped(html, version) {
  const modules = assetFiles().filter((path) => path.endsWith(".js") && path !== "src/app.js");
  const imports = modules.map((path) => `      "./${path}": "./${path}?v=${version}"`).join(",\n");
  const replaceOnce = (text, pattern, replacement) => {
    if (!pattern.test(text)) throw new Error(`index.html : repère introuvable (${pattern})`);
    return text.replace(pattern, replacement);
  };
  html = replaceOnce(html, /href="styles\.css(\?v=[0-9a-f]*)?"/, `href="styles.css?v=${version}"`);
  html = replaceOnce(html, /src="src\/app\.js(\?v=[0-9a-f]*)?"/, `src="src/app.js?v=${version}"`);
  return replaceOnce(html, /<script type="importmap">[\s\S]*?<\/script>/,
    `<script type="importmap">\n  {\n    "imports": {\n${imports}\n    }\n  }\n  </script>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = assetVersion();
  const before = read("index.html");
  const after = stamped(before, version);
  if (after !== before) writeFileSync(new URL("index.html", root), after);
  console.log(`${after === before ? "déjà à jour" : "index.html mis à jour"} : version ${version}`);
}
