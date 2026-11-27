// Numbers the page's files according to their content.
//
// The browser keeps files in memory for a few minutes. Without a number, an
// update can make it mix a new page with an old script.
// index.html therefore requests each file with "?v=<fingerprint>": the fingerprint
// changes as soon as a file changes, and the browser then reloads the whole set.
//
// After any change to styles.css or src/:   node tools/stamp.mjs
// The tests fail if the fingerprint written in index.html is no longer up to date.

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

// index.html as it must be for the given version.
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
