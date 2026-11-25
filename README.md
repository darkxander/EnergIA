# EnergIA

Ce que représente votre usage de l'IA, en énergie, CO₂, eau et euros.

EnergIA estime l'empreinte de vos conversations avec ChatGPT, Claude, Claude Code et Claude Cowork. Elle
existe sous deux formes, qui partagent la même page :

- une **page web** où l'on importe son export ChatGPT ou Claude ;
- un **élément de barre de menus macOS** (plugin [SwiftBar](https://github.com/swiftbar/SwiftBar))
  qui affiche l'énergie estimée du jour pour Claude Code, et ouvre le tableau de bord au clic.

![Tableau de bord EnergIA avec les données d'exemple : tuiles énergie, CO₂, eau et coût, puis le graphique d'évolution par mois pour ChatGPT et Claude](docs/capture.jpg)

*Le tableau de bord, ici avec les données d'exemple intégrées.*

Tous les chiffres sont des **estimations d'ordre de grandeur** : les fournisseurs ne
publient pas la consommation réelle de leurs modèles. Voir [Limites](#limites).

## Ce qu'elle affiche

- Quatre tuiles : énergie, CO₂, eau et coût, avec une fourchette basse et haute et des
  équivalents (charges de smartphone, kilomètres en voiture, verres d'eau).
- Un graphique par jour ou par mois, par service, avec une vue tableau.
- Un tableau par modèle.
- Un filtre de période (de « Aujourd'hui » à tout l'historique) et de service.
- Des hypothèses de calcul toutes modifiables.

## Utiliser la page web

Il faut un serveur local, la page chargeant des modules JavaScript :

```sh
python3 -m http.server 8791 --bind 127.0.0.1
```

Ouvrez ensuite <http://localhost:8791>, puis déposez votre export (`.zip` ou
`conversations.json`), ou cliquez sur « Voir un exemple ».

Pour obtenir un export :

- **ChatGPT** : Paramètres → Gestion des données → Exporter les données.
- **Claude** : Paramètres → Confidentialité → Exporter les données.

Les fichiers sont analysés dans le navigateur. Rien n'est envoyé sur Internet, et le
texte des conversations n'est pas conservé : seuls des compteurs par jour et par modèle
sont gardés dans le stockage local du navigateur.

## Installer dans la barre de menus (macOS)

Prérequis : macOS, Python 3.9 ou plus récent, et SwiftBar.

```sh
brew install --cask swiftbar
chmod +x EnergIA.py
ln -s "$PWD/EnergIA.py" ~/.config/swiftbar/EnergIA.py
```

Remplacez `~/.config/swiftbar` par votre dossier de plugins SwiftBar s'il est différent.
Le titre affiche par exemple `⚡ 1,02 kWh` ; un clic ouvre le tableau de bord.

Le plugin :

- lit les journaux locaux de Claude Code (`~/.claude/projects`), où chaque réponse est
  enregistrée avec son modèle et ses nombres de tokens réels, et les relit chaque minute ;
- lit de la même façon les sessions Cowork de l'appli Claude
  (`~/Library/Application Support/Claude/local-agent-mode-sessions`), affichées comme un
  service à part ;
- n'en garde que des compteurs par jour et par modèle, dans `~/Library/Caches/EnergIA` ;
  ces compteurs survivent au nettoyage des anciens journaux par Claude Code ;
- sert la page sur `127.0.0.1:18791`, accessible uniquement depuis votre Mac ;
- relève une fois par jour le taux de change euro/dollar de référence de la BCE. C'est sa
  seule connexion à Internet ; elle n'envoie aucune donnée.

Pour désinstaller, supprimez le lien `~/.config/swiftbar/EnergIA.py`, puis quittez et
relancez SwiftBar.

## Comment sont faites les estimations

1. **Tokens.** Pour les exports ChatGPT et Claude, le nombre de tokens est estimé à partir
   de la longueur du texte (environ 4 caractères par token), et le contexte relu à chaque
   réponse est compté. Pour Claude Code, les tokens sont mesurés, pas estimés.
2. **Énergie.** Chaque modèle est rangé dans une catégorie (léger, standard, grand,
   raisonnement) qui fixe une énergie par millier de tokens générés. Un token lu pèse une
   fraction d'un token généré, et un token relu depuis le cache une fraction plus petite
   encore.
3. **CO₂ et eau.** L'énergie est multipliée par une intensité carbone (g CO₂e/kWh) et par
   une consommation d'eau (L/kWh).
4. **Coût.** Ce que coûteraient ces tokens payés à l'usage, aux prix publics des API
   Anthropic et OpenAI ([src/prices.json](src/prices.json)), convertis en euros.

Les valeurs par défaut sont dans [src/defaults.json](src/defaults.json) et se modifient
dans « Hypothèses de calcul ».

## Limites

- **L'énergie par token n'est pas publiée.** Les facteurs par défaut sont des choix
  d'ordre de grandeur, calés sur les rares chiffres publics (environ 0,3 Wh pour une
  requête de chat typique).
- **Le poids des tokens relus du cache est l'hypothèse la plus incertaine.** Ils
  représentent l'essentiel du volume de Claude Code, et leur poids (2 % d'un token lu par
  défaut) change fortement le total.
- **Le coût n'est pas votre facture.** Avec un abonnement, vous payez le forfait, pas les
  tokens. Les prix actuels sont appliqués à tout l'historique.
- **Prix à maintenir.** Les prix de [src/prices.json](src/prices.json) ont été relevés le
  25 novembre 2026 et ne se mettent pas à jour seuls. Les modèles absents de la liste
  gardent un tarif indicatif par catégorie, signalé par un astérisque.
- **Les conversations de claude.ai et de ChatGPT ne sont pas lues automatiquement.** Elles
  ne sont pas enregistrées sur le Mac sous une forme exploitable : il faut importer un
  export, à refaire pour mettre les chiffres à jour.
- **Exports.** L'export Claude n'indique pas le modèle utilisé, et la réflexion cachée des
  modèles à raisonnement n'apparaît pas dans les exports. La lecture des exports n'a été
  testée que sur des fichiers de test, pas encore sur de vrais exports.

## Organisation du code

| Chemin | Rôle |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | La page et son interface |
| `src/parsers.js`, `src/zip.js` | Lecture des exports ChatGPT et Claude |
| `src/model.js` | Calcul de l'énergie, du CO₂, de l'eau et du coût |
| `src/defaults.json`, `src/prices.json` | Hypothèses par défaut et prix des modèles |
| `EnergIA.py`, `menubar/` | Plugin SwiftBar : journaux Claude Code, serveur local, taux de change |
| `test/` | Tests |

Aucune dépendance : JavaScript sans étape de construction, Python avec la bibliothèque
standard seule.

## Tests

```sh
node --test test/
python3 test/test_menubar.py
```

## Soutenir le projet

EnergIA est gratuite et ouverte. Si elle vous est utile, vous pouvez soutenir son
développement par un don sur [GitHub Sponsors](https://github.com/sponsors/darkxander).

## Licence

EnergIA est distribuée sous la licence publique générale GNU, version 3 (GPL-3.0). Voir
[LICENSE](LICENSE).

Copyright © 2026 Alexandre MATHIEU
