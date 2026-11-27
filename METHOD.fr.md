# Méthode et sources

[English](METHOD.md) · **Français**

Ce document décrit comment EnergIA passe d'un usage de l'IA à des chiffres d'énergie, de
CO₂, d'eau et de coût, et sur quoi repose chaque hypothèse. Il distingue trois niveaux :

- **sourcé** : la valeur vient d'une source publique, citée ;
- **calé** : la valeur est un choix d'EnergIA, comparé à des sources publiques ;
- **hypothèse** : aucune source publique ne permet de la fixer.

Les sources ont été consultées le 27 novembre 2026. Toutes les valeurs par défaut sont dans
[src/defaults.json](src/defaults.json) et se modifient dans la page, sous « Hypothèses de
calcul ».

## En bref

| Étape | Valeur par défaut | Niveau |
|---|---|---|
| Tokens des exports de conversations | 4 caractères par token | sourcé pour OpenAI, biaisé pour Claude |
| Tokens de Claude Code, de Cowork et des relevés d'API | mesurés | sourcé |
| Énergie pour 1 000 tokens générés | 0,2 / 0,6 / 1,2 / 2,5 Wh selon la catégorie | calé |
| Poids d'un token lu | 10 % d'un token généré | calé |
| Poids d'un token relu du cache | 2 % d'un token lu | hypothèse |
| Fourchette | × 0,5 à × 2 | hypothèse |
| Intensité carbone | 458,3 g CO₂e/kWh (moyenne mondiale 2025) | sourcé |
| Eau | 1 L/kWh | calé |
| Coût | prix publics des API | sourcé |

Ce que les chiffres couvrent : l'électricité de l'inférence, centre de données compris. Ce
qu'ils ne couvrent pas : l'entraînement des modèles, la fabrication des serveurs, les
réseaux et votre appareil.

## 1. Compter les tokens

**Claude Code, Claude Cowork et relevés d'usage des API.** Les nombres de tokens sont ceux
enregistrés par le fournisseur : tokens lus, écrits dans le cache, relus du cache et
générés. Ils sont mesurés, pas estimés.

**Exports de conversations (ChatGPT, Claude, Gemini, Copilot).** Les exports ne donnent pas
les tokens. EnergIA les estime à partir de la longueur du texte, à raison de 4 caractères
par token, et compte le contexte relu à chaque réponse.

- OpenAI indique qu'un token représente environ 4 caractères de texte anglais, en précisant
  qu'il s'agit d'une estimation
  ([OpenAI, « What are tokens and how to count them? »](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them)).
- Pour Claude, la règle sous-estime : Anthropic indique environ 3,5 caractères par token
  pour les modèles antérieurs à Claude 4.7, et environ 30 % de tokens en plus pour le même
  texte à partir de Claude 4.7
  ([Anthropic, glossaire](https://platform.claude.com/docs/en/about-claude/glossary)). Les
  tokens d'un export Claude sont donc sous-estimés d'environ 12 % pour les anciens modèles,
  et davantage pour les récents. Ce biais ne touche pas Claude Code, dont les tokens sont
  mesurés.
- La règle vaut pour l'anglais ; d'autres langues donnent d'autres rapports.
- Ce qui n'apparaît pas dans un export n'est pas compté : la réflexion cachée des modèles à
  raisonnement, les images, et les réponses que l'export Gemini omet parfois.

## 2. Des tokens à l'énergie

### Le calcul

Chaque modèle est rangé dans une catégorie d'après son nom, et chaque catégorie a une
énergie par millier de tokens générés :

| Catégorie | Wh pour 1 000 tokens générés | Exemples de noms |
|---|---|---|
| Léger | 0,2 | mini, nano, haiku, flash |
| Standard | 0,6 | les autres modèles |
| Grand | 1,2 | opus, fable |
| Raisonnement | 2,5 | o3, « thinking », « pro » |

Énergie d'une ligne = (tokens générés + tokens lus × 0,1 + tokens relus du cache × 0,1 ×
0,02) ÷ 1 000 × l'énergie de la catégorie. Les tokens écrits dans le cache comptent comme
des tokens lus.

Aucun fournisseur ne publie l'énergie par token de ses modèles : ces facteurs sont des
choix d'ordre de grandeur. Ils incluent le centre de données (serveurs, refroidissement),
comme les repères ci-dessous.

### Sur quoi les facteurs sont calés

| Source | Chiffre | Périmètre |
|---|---|---|
| [Epoch AI](https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use) (7 février 2025) | environ 0,3 Wh pour une requête GPT-4o type de 500 tokens générés | estimation ; puissance de la grappe, surcoûts compris |
| [OpenAI, Sam Altman](https://blog.samaltman.com/the-gentle-singularity) (juin 2025) | environ 0,34 Wh pour une requête ChatGPT moyenne | déclaration, sans méthode ni périmètre |
| [Google](https://arxiv.org/abs/2508.15734) (21 août 2025) | 0,24 Wh pour une requête texte Gemini médiane, mai 2025 | mesuré ; accélérateurs, processeurs, machines en attente et surcoût du centre de données |

Le facteur « standard » de 0,6 Wh pour 1 000 tokens générés donne 0,3 Wh pour 500 tokens
générés : c'est l'estimation d'Epoch AI. Les chiffres d'OpenAI et de Google, obtenus
autrement, sont du même ordre.

L'étude de Google montre aussi ce qu'un périmètre étroit laisse de côté : en ne comptant
que les accélérateurs actifs, elle obtient 0,10 Wh, contre 0,24 Wh avec le reste du
système. Les accélérateurs actifs ne représentent que 58 % du total.

### Une estimation plus haute existe

[Jegham et al., « How Hungry is AI? »](https://arxiv.org/abs/2505.09598) (version 6, 24
novembre 2025) estiment l'énergie par requête d'après les temps de réponse des API. Leurs
chiffres sont plus élevés que ceux d'EnergIA :

| Modèle, requête | Jegham et al. | EnergIA, valeurs par défaut |
|---|---|---|
| GPT-4o, courte (100 tokens lus, 300 générés) | 0,42 Wh | 0,19 Wh |
| GPT-4o, longue (10 000 lus, 1 500 générés) | 2,9 Wh | 1,5 Wh |
| GPT-4.1 nano, courte | 0,21 Wh | 0,06 Wh |
| o3, courte | 1,2 Wh | 0,78 Wh |

L'écart va de 1,5 à 3,5 fois. Pour les modèles standard et à raisonnement, il tient à peu
près dans la fourchette haute d'EnergIA (× 2) ; pour les modèles légers, il la dépasse.
EnergIA se situe donc du côté bas des estimations publiques, proche des chiffres déclarés
par les fournisseurs. Si vous préférez l'estimation haute, doublez les facteurs dans les
hypothèses.

Les chiffres mesurés sur de petits modèles ouverts, comme ceux de
[Luccioni et al.](https://arxiv.org/abs/2311.16863) (environ 0,047 Wh par génération de
10 tokens), ne sont pas comparables à une requête de conversation sur un grand modèle.

### Le poids d'un token lu : 10 %

Lire le contexte coûte moins que générer. Deux études mesurées, sur des modèles ouverts et
en ne comptant que le processeur graphique, vont dans ce sens :

- [Caravaca et al.](https://arxiv.org/abs/2511.05597) (5 novembre 2025) : ajouter
  800 tokens lus multiplie l'énergie par 2,19, ajouter 800 tokens générés la multiplie
  par 11. Le coût marginal d'un token lu est donc d'environ 12 % de celui d'un token
  généré, ce qui est proche des 10 % retenus.
- [Wang et al.](https://arxiv.org/abs/2512.01644) (1ᵉʳ décembre 2025) : jusqu'à
  2 000 tokens lus, l'énergie ne varie presque pas avec la longueur du contexte ; elle est
  dominée par la génération.

À l'inverse, Epoch AI calcule que le coût de lecture croît plus vite que la longueur pour
de très longs contextes : environ 2,5 Wh pour 10 000 tokens lus et près de 40 Wh pour
100 000. Avec ses valeurs par défaut, EnergIA donne environ 0,9 Wh et 6 Wh pour ces mêmes
requêtes : elle sous-estime probablement les très longs contextes. Aucune source ne donne
un rapport général et mesuré pour les grands modèles.

### Le poids d'un token relu du cache : 2 %, sans source

C'est l'hypothèse la plus fragile, et celle qui pèse le plus pour Claude Code, dont
l'essentiel du volume est fait de tokens relus du cache.

Aucune source consultée ne mesure l'énergie d'un token relu du cache par rapport à un token
lu normalement. La valeur de 2 % est un choix d'EnergIA. Le seul repère disponible est
indirect : les fournisseurs facturent une relecture du cache entre 2,5 % et 10 % du prix
d'un token lu, selon le modèle ([src/prices.json](src/prices.json)). Un prix n'est pas une
énergie, mais il suggère que 2 % est plutôt bas. Passer de 2 % à 10 % multiplie
sensiblement le total de Claude Code : essayez les deux valeurs pour voir la sensibilité.

### La fourchette : × 0,5 à × 2

Chaque tuile affiche une fourchette, obtenue en multipliant la valeur centrale par 0,5 et
par 2. Ce n'est pas un intervalle statistique : c'est une façon de rappeler que
l'incertitude est d'un facteur 2 au moins. Les comparaisons ci-dessus montrent qu'elle ne
couvre pas toutes les estimations publiques.

## 3. De l'énergie au CO₂

CO₂ = énergie × intensité carbone de l'électricité du pays choisi.

- **Source** : Ember, traité par Our World in Data, « Lifecycle carbon intensity of
  electricity » ([graphique](https://ourworldindata.org/grapher/carbon-intensity-electricity),
  données Ember publiées le 21 avril 2026, licence CC BY 4.0). Les émissions sont estimées
  sur le cycle de vie des moyens de production, tous gaz à effet de serre compris, en
  grammes de CO₂ équivalent par kilowattheure produit. Année retenue : 2025.
- **Valeur par défaut** : la moyenne mondiale, 458,3 g CO₂e/kWh. Les 27 valeurs proposées
  sont dans [src/carbon.json](src/carbon.json).
- **Quel pays choisir** : celui où tournent les modèles, pas forcément le vôtre. Les
  fournisseurs ne disent pas dans quel centre de données une requête est traitée ; la
  moyenne mondiale est un choix par défaut, pas une mesure.
- **Moyenne du réseau, pas contrats d'électricité** : EnergIA applique l'intensité moyenne
  du réseau. Les fournisseurs publient souvent des chiffres plus bas, qui tiennent compte
  de leurs achats d'électricité bas carbone : Google retient 94 g CO₂e/kWh de cette façon,
  contre 345 pour la moyenne des réseaux où il opère (étude citée plus haut). C'est
  pourquoi Google annonce 0,03 g CO₂e par requête, là où EnergIA en compterait environ 0,1
  pour la même énergie.

## 4. De l'énergie à l'eau

Eau = énergie × 1 L/kWh. Cette valeur ronde se situe entre deux périmètres :

| Périmètre | Valeur | Source |
|---|---|---|
| Refroidissement sur site, moyenne des centres de données américains | un peu plus de 0,36 L/kWh | [LBNL, rapport 2024](https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf) |
| Refroidissement sur site, Microsoft | 0,30 L/kWh (exercice 2024), 0,27 (2025) | [Microsoft](https://datacenters.microsoft.com/sustainability/efficiency/) |
| Refroidissement sur site, Google | 1,15 L/kWh | [Google](https://arxiv.org/abs/2508.15734) |
| Production de l'électricité, États-Unis | 4,35 à 4,52 L/kWh | LBNL, même rapport |
| Fourchette sur site selon le lieu et la saison | 1 à 9 L/kWh | [Li et al., « Making AI Less Thirsty »](https://arxiv.org/abs/2304.03271) |

Avec 1 L/kWh, EnergIA compte à peu près l'eau évaporée pour le refroidissement, plutôt du
côté haut. Elle ne compte pas l'eau consommée pour produire l'électricité : en l'ajoutant,
on arriverait à 4 ou 5 L/kWh aux États-Unis. Si vous voulez ce périmètre large, mettez
4,5 dans les hypothèses.

## 5. Le coût

Coût = tokens × prix publics des API d'Anthropic et d'OpenAI, par modèle, convertis en
euros.

- **Prix** : relevés sur les pages de tarifs des fournisseurs, avec la date de relevé
  inscrite dans [src/prices.json](src/prices.json). Les prix actuels sont appliqués à tout
  l'historique. Un modèle absent de la liste, ou un export qui ne dit pas quel modèle a
  répondu, reçoit un prix indicatif par catégorie, signalé par un astérisque.
- **Taux de change** : taux de référence euro/dollar de la
  [Banque centrale européenne](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml),
  relevé une fois par jour par le plugin.
- **Ce n'est pas une facture** : avec un abonnement, on paie le forfait, pas les tokens.

## 6. Les équivalents

Les tuiles traduisent les chiffres en repères du quotidien. Ce sont des valeurs rondes ;
voici ce que disent les sources.

| Équivalent | Valeur d'EnergIA | Ce que disent les sources |
|---|---|---|
| Une charge de smartphone | 15 Wh | Capacité de batterie d'un téléphone récent : 4 000 mAh pour un [Galaxy S25](https://www.samsung.com/nz/smartphones/galaxy-s25/specs/), soit environ 15 Wh à 3,85 V (conversion d'EnergIA). L'[EPA américaine](https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references) compte 19 Wh à la prise, pertes du chargeur comprises. |
| Un kilomètre en voiture électrique | 170 Wh | Étiquette américaine d'une [Tesla Model Y Long Range 2026](https://www.fueleconomy.gov/feg/PowerSearch.do?action=noform&path=1&year1=2025&year2=2026&make=Tesla&baseModel=Model%20Y&srchtyp=ymm) : 27 kWh pour 100 miles, soit environ 168 Wh/km. L'[AIE](https://www.iea.org/reports/global-ev-outlook-2025/electric-vehicle-charging) retient 200 Wh/km en usage réel. |
| Un kilomètre en voiture thermique | 200 g CO₂e | **Plutôt haut.** L'[ADEME](https://impactco2.fr/outils/transport/voiturethermique) donne 170 g CO₂e/km pour une voiture essence moyenne, fabrication comprise, 189 g pour une berline et 246 g pour un SUV. |
| Une douche | 60 L | [Eaufrance](https://www.services.eaufrance.fr/economie-d-eau) : 35 à 60 L pour une douche rapide. [Ministère de l'Écologie](https://archive-2017-2022.ecologie.gouv.fr/actualites/22-mars-cest-journee-mondiale-leau-0) (2018) : 60 à 80 L. |
| Un verre d'eau | 0,25 L | Une convention : 250 mL est la tasse métrique. |

## Ce qui reste fragile

Dans l'ordre d'importance pour les résultats :

1. **Le poids des tokens relus du cache** (2 %) : aucune source, et un effet majeur sur
   Claude Code.
2. **L'énergie par token** : EnergIA est du côté bas des estimations publiques ; une étude
   donne 1,5 à 3,5 fois plus.
3. **Les très longs contextes** : probablement sous-estimés.
4. **Les tokens des exports Claude** : sous-estimés par la règle des 4 caractères.
5. **Le périmètre de l'eau** : le refroidissement seulement, pas la production
   d'électricité.
6. **Le pays** : inconnu, donc moyenne mondiale par défaut.
7. **L'équivalent « voiture thermique »** : plus haut que la moyenne de l'ADEME.

Aucune de ces valeurs n'est cachée : toutes se modifient dans la page, et le rapport
mensuel liste celles qui ont servi au calcul.
