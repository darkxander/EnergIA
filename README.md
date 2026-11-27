# EnergIA

**English** · [Français](README.fr.md)

What your AI usage amounts to, in energy, CO₂, water and euros.

EnergIA estimates the footprint of your conversations with ChatGPT, Claude, Claude Code and
Claude Cowork. It comes in two forms that share the same page:

- a **web page** where you import your ChatGPT or Claude export, which you can
  [try online](https://darkxander.github.io/EnergIA/) without installing anything;
- a **macOS menu bar item** ([SwiftBar](https://github.com/swiftbar/SwiftBar) plugin) that
  shows today's estimated energy for Claude Code and opens the dashboard on click.

The app is in English and French. It follows your browser's language (French for a French
browser, English otherwise), and the link at the top right of the page switches language.

![EnergIA dashboard with the sample data: energy, CO₂, water and cost tiles, then the monthly chart for ChatGPT and Claude](docs/capture.jpg)

*The dashboard, here with the built-in sample data.*

![The four summary tiles in dark theme: 188 kWh, 75.3 kg CO₂e, 188 L and €17,160 at API prices](docs/tuiles.png)

*The summary tiles, here for eight months of real Claude Code usage.*

All figures are **order-of-magnitude estimates**: providers do not publish the actual
consumption of their models. See [Limitations](#limitations).

## What it shows

- Four tiles: energy, CO₂, water and cost, each with a low and high range and equivalents
  (smartphone charges, kilometres by car, glasses of water).
- A chart by day or by month, by service, with a table view.
- A table by model.
- A period filter (from "Today" to the whole history) and a service filter.
- Calculation assumptions that can all be changed.

## Using the web page

The simplest way is the online version: <https://darkxander.github.io/EnergIA/>. It is the same page, hosted by
GitHub Pages; your files are still analysed in your browser and are not sent anywhere. A
recent browser is required.

To run it yourself, the page loads JavaScript modules, so it needs a local server:

```sh
python3 -m http.server 8791 --bind 127.0.0.1
```

Then open <http://localhost:8791> and import your export (`.zip` or `conversations.json`):
drop it anywhere on the page, or click "Choose a file". "See an example" shows made-up
data.

To get an export:

- **ChatGPT**: Settings → Data controls → Export data.
- **Claude**: Settings → Privacy → Export data, on the web or in the desktop app (not on
  mobile). The link sent by email expires after 24 hours.

Files are analysed in the browser. Nothing is sent over the Internet, and the text of your
conversations is not kept: only counters per day and per model are stored in the browser's
local storage.

## Installing in the menu bar (macOS)

Requirements: macOS, Python 3.9 or later, and SwiftBar.

```sh
brew install --cask swiftbar
chmod +x EnergIA.py
ln -s "$PWD/EnergIA.py" ~/.config/swiftbar/EnergIA.py
```

Replace `~/.config/swiftbar` with your SwiftBar plugin folder if it is different. The title
shows, for example, `⚡ 1.02 kWh` (`⚡ 1,02 kWh` in French); a click opens the dashboard. The
plugin uses the language shown in the page, and the language of macOS until the page has
been opened.

![Screenshot of the right-hand side of the menu bar: the EnergIA item, a lightning bolt followed by 137 Wh, among the other icons](docs/barre-de-menus.png)

*The item in the menu bar, here with an estimated 137 Wh for the current day.*

The plugin:

- reads Claude Code's local logs (`~/.claude/projects`), where each reply is recorded with
  its model and its real token counts, and re-reads them every minute;
- reads the Claude app's Cowork sessions the same way
  (`~/Library/Application Support/Claude/local-agent-mode-sessions`), shown as a separate
  service;
- keeps only counters per day and per model, in `~/Library/Caches/EnergIA`; these counters
  outlive Claude Code's clean-up of old logs;
- serves the page on `127.0.0.1:18791`, reachable only from your Mac;
- fetches the ECB's euro/dollar reference rate once a day. This is its only Internet
  connection; it sends no data.

To import an export from the menu bar window, use the "Choose a file" button: the
plugin opens the macOS file picker and passes the chosen file to the page. Drag and drop is
not possible there, because SwiftBar closes its window as soon as you start dragging a
file. The footer links (donation, source code) open in your default browser.

To uninstall, delete the `~/.config/swiftbar/EnergIA.py` link, then quit and relaunch
SwiftBar.

## How the estimates are made

1. **Tokens.** For ChatGPT and Claude exports, the number of tokens is estimated from the
   length of the text (about 4 characters per token), and the context re-read at each reply
   is counted. For Claude Code, tokens are measured, not estimated.
2. **Energy.** Each model is placed in a category (light, standard, large, reasoning) that
   sets an energy per thousand generated tokens. A token read weighs a fraction of a token
   generated, and a token re-read from the cache a smaller fraction still.
3. **CO₂ and water.** Energy is multiplied by a carbon intensity (g CO₂e/kWh) and by a
   water consumption (L/kWh).
4. **Cost.** What these tokens would cost if paid by usage, at the public prices of the
   Anthropic and OpenAI APIs ([src/prices.json](src/prices.json)), converted to euros.

The default values are in [src/defaults.json](src/defaults.json) and can be changed under
"Calculation assumptions".

## Limitations

- **Energy per token is not published.** The default factors are order-of-magnitude
  choices, anchored on the few public figures (about 0.3 Wh for a typical chat request).
- **The weight of tokens re-read from the cache is the most uncertain assumption.** They
  make up most of Claude Code's volume, and their weight (2% of a token read by default)
  changes the total a great deal.
- **The cost is not your bill.** With a subscription, you pay the plan, not the tokens.
  Current prices are applied to the whole history.
- **Prices need maintaining.** The prices in [src/prices.json](src/prices.json) were
  collected on 25 November 2026 and do not update themselves. For older models withdrawn
  from the API (GPT-3.5 Turbo, GPT-4, GPT-4 Turbo, GPT-4.5, o3-mini, o4-mini, deep
  research), it is the last price published by OpenAI, collected on 26 November 2026.
  Models missing from the list keep an indicative price per category, marked with an
  asterisk.
- **ChatGPT's model names are not the API's.** The ChatGPT export refers to models by
  internal names. When the correspondence is known (for example
  `text-davinci-002-render-sha` for GPT-3.5, or `o3-mini-high` for o3-mini), the real price
  is applied. OpenAI publishes no correspondence for recent names (`gpt-6`, `gpt-5-6`,
  `gpt-5-3`, their mini variants, `research`, `auto`): they keep the indicative price.
- **claude.ai and ChatGPT conversations are not read automatically.** They are not stored
  on the Mac in a usable form: you have to import an export, and import a new one to
  update the figures.
- **The Claude export is not always available.** With an organisation account (Team or
  Enterprise), the export button only appears if an owner of the organisation has allowed
  members to export their data. Without that, claude.ai conversations cannot be counted.
- **Exports.** The Claude export does not say which model was used. The hidden reasoning of
  reasoning models does not appear in exports, and images are not counted. Parsing has
  been checked on a real ChatGPT export; for the Claude export, only on test files.

## Code layout

| Path | Role |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | The page and its interface |
| `src/parsers.js`, `src/zip.js` | Reading ChatGPT and Claude exports |
| `src/i18n.js` | Interface texts in French and English |
| `src/model.js` | Computing energy, CO₂, water and cost |
| `src/defaults.json`, `src/prices.json` | Default assumptions and model prices |
| `EnergIA.py`, `menubar/` | SwiftBar plugin: Claude Code logs, local server, exchange rate |
| `test/` | Tests |

No dependencies: JavaScript with no build step, Python with the standard library only.

## Tests

```sh
node --test test/
python3 test/test_menubar.py
```

## Roadmap

These are intentions, with no dates and no commitment. In the planned order:

1. **Other operating systems.** First a "server only" mode, to open the dashboard with live
   Claude Code data on Windows and Linux; then an icon in the notification area.
2. **English everywhere.** The page, the menu bar plugin, the README and the repository
   description are translated. Still in French: the code comments and the commit
   messages.
3. **Making EnergIA known.** The aim is to raise awareness of what AI usage amounts to;
   donations from people who find the app useful fund its development. This means
   presenting the app where AI and the environment are discussed.

Then, in no set order:

- **Choice of country for CO₂**, from a list, instead of a figure to type in.
- **Other services**: Gemini, Mistral, Copilot and other coding tools, depending on what
  their exports allow.
- **Threshold and alert**: a budget in kWh or euros, flagged in the menu bar when it is
  exceeded, and a comparison with the previous period.
- **Exporting results**: a CSV file and a summary image to share.
- **Imports that add up**, instead of replacing the previous one.
- **One-command installation.**

To consolidate alongside: reading a real Claude export, and updating prices, which is
manual today.

## Supporting the project

EnergIA is free and open. If you find it useful, you can support its development with a
donation on [GitHub Sponsors](https://github.com/sponsors/darkxander).

## Licence

EnergIA is distributed under the GNU General Public License, version 3 (GPL-3.0). See
[LICENSE](LICENSE).

Copyright © 2026 Alexandre MATHIEU
