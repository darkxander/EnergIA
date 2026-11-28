# Method and sources

**English** · [Français](METHOD.fr.md)

This document describes how EnergIA goes from AI usage to figures for energy, CO₂, water
and cost, and what each assumption rests on. It distinguishes three levels:

- **sourced**: the value comes from a public source, cited;
- **anchored**: the value is EnergIA's choice, compared with public sources;
- **assumption**: no public source makes it possible to set it.

The sources were consulted on 27 November 2026. All default values are in
[src/defaults.json](src/defaults.json) and can be changed in the page, under "Calculation
assumptions".

## In short

| Step | Default value | Level |
|---|---|---|
| Tokens of conversation exports | 4 characters per token; 3.5 for Claude | sourced |
| Tokens of Claude Code, Cowork and API usage reports | measured | sourced |
| Energy per 1,000 generated tokens | 0.2 / 0.6 / 1.2 / 2.5 Wh depending on the category | anchored |
| Weight of a token read | 10% of a token generated | anchored |
| Weight of a token re-read from the cache | 2% of a token read | assumption |
| Range | × 0.5 to × 2 | assumption |
| Carbon intensity | 458.3 g CO₂e/kWh (2025 world average) | sourced |
| Water | 4.5 L/kWh | sourced (United States) |
| Cost | public API prices | sourced |

What the figures cover: the electricity of inference, data centre included. What they do
not cover: training the models, manufacturing the servers, networks and your own device.

## 1. Counting tokens

**Claude Code, Claude Cowork and API usage reports.** The token counts are those recorded
by the provider: tokens read, written to the cache, re-read from the cache and generated.
They are measured, not estimated.

**Conversation exports (ChatGPT, Claude, Gemini, Copilot).** Exports do not give tokens.
EnergIA estimates them from the length of the text, at 4 characters per token (3.5
characters per token for a Claude export), and counts the context re-read at each reply.

- OpenAI states that a token is about 4 characters of English text, adding that this is an
  estimate
  ([OpenAI, "What are tokens and how to count them?"](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them)).
- For Claude, Anthropic gives about 3.5 characters per token for models before Claude 4.7,
  and about 30% more tokens for the same text from Claude 4.7 onwards
  ([Anthropic, glossary](https://platform.claude.com/docs/en/about-claude/glossary)).
  EnergIA uses 3.5 for a Claude export. The export does not say which model answered: for
  a conversation with a recent model, tokens are still underestimated by about 30%. This
  does not affect Claude Code, whose tokens are measured.
- The rule holds for English; other languages give other ratios.
- What does not appear in an export is not counted: the hidden reasoning of reasoning
  models, images, and the replies the Gemini export sometimes omits.

## 2. From tokens to energy

### The calculation

Each model is placed in a category from its name, and each category has an energy per
thousand generated tokens:

| Category | Wh per 1,000 generated tokens | Examples of names |
|---|---|---|
| Light | 0.2 | mini, nano, haiku, flash |
| Standard | 0.6 | the other models |
| Large | 1.2 | opus, fable |
| Reasoning | 2.5 | o3, "thinking", "pro" |

Energy of a row = (tokens generated + tokens read × 0.1 + tokens re-read from the cache ×
0.1 × 0.02) ÷ 1,000 × the category's energy. Tokens written to the cache count as tokens
read.

No provider publishes the energy per token of its models: these factors are
order-of-magnitude choices. They include the data centre (servers, cooling), like the
reference points below.

### What the factors are anchored on

| Source | Figure | Scope |
|---|---|---|
| [Epoch AI](https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use) (7 February 2025) | about 0.3 Wh for a typical GPT-4o request of 500 generated tokens | estimate; cluster power, overheads included |
| [OpenAI, Sam Altman](https://blog.samaltman.com/the-gentle-singularity) (June 2025) | about 0.34 Wh for an average ChatGPT request | statement, with no method or scope |
| [Google](https://arxiv.org/abs/2508.15734) (21 August 2025) | 0.24 Wh for a median Gemini text request, May 2025 | measured; accelerators, processors, idle machines and data-centre overhead |

The "standard" factor of 0.6 Wh per 1,000 generated tokens gives 0.3 Wh for 500 generated
tokens: that is Epoch AI's estimate. The figures from OpenAI and Google, obtained
differently, are of the same order.

Google's study also shows what a narrow scope leaves out: counting only the active
accelerators, it gets 0.10 Wh, against 0.24 Wh with the rest of the system. Active
accelerators account for only 58% of the total.

### A higher estimate exists

[Jegham et al., "How Hungry is AI?"](https://arxiv.org/abs/2505.09598) (version 6, 24
November 2025) estimate the energy per request from the response times of the APIs. Their
figures are higher than EnergIA's:

| Model, request | Jegham et al. | EnergIA, default values |
|---|---|---|
| GPT-4o, short (100 tokens read, 300 generated) | 0.42 Wh | 0.19 Wh |
| GPT-4o, long (10,000 read, 1,500 generated) | 2.9 Wh | 1.5 Wh |
| GPT-4.1 nano, short | 0.21 Wh | 0.06 Wh |
| o3, short | 1.2 Wh | 0.78 Wh |

The gap ranges from 1.5 to 3.5 times. For standard and reasoning models it roughly fits
within EnergIA's high range (× 2); for light models it exceeds it. EnergIA therefore sits
on the low side of public estimates, close to the figures stated by providers. If you
prefer the high estimate, double the factors in the assumptions.

Figures measured on small open models, such as those of
[Luccioni et al.](https://arxiv.org/abs/2311.16863) (about 0.047 Wh per generation of 10
tokens), are not comparable with a conversation request on a large model.

### The weight of a token read: 10%

Reading the context costs less than generating. Two measured studies, on open models and
counting only the graphics processor, point the same way:

- [Caravaca et al.](https://arxiv.org/abs/2511.05597) (5 November 2025): adding 800 tokens
  read multiplies the energy by 2.19, adding 800 generated tokens multiplies it by 11. The
  marginal cost of a token read is therefore about 12% of that of a generated token, which
  is close to the 10% used.
- [Wang et al.](https://arxiv.org/abs/2512.01644) (1 December 2025): up to 2,000 tokens
  read, energy hardly varies with the length of the context; it is dominated by
  generation.

Conversely, Epoch AI calculates that the cost of reading grows faster than the length for
very long contexts: about 2.5 Wh for 10,000 tokens read and almost 40 Wh for 100,000. With
its default values, EnergIA gives about 0.9 Wh and 6 Wh for these same requests: it
probably underestimates very long contexts. No source gives a general, measured ratio for
large models.

### The weight of a token re-read from the cache: 2%, with no source

This is the most fragile assumption, and the one that weighs most for Claude Code, most of
whose volume is made of tokens re-read from the cache.

No source consulted measures the energy of a token re-read from the cache against a token
read normally. The value of 2% is EnergIA's choice. The only available reference point is
indirect: providers bill a cache read at between 2.5% and 10% of the price of a token read,
depending on the model ([src/prices.json](src/prices.json)). A price is not an energy, but
it suggests that 2% is rather low. Going from 2% to 10% noticeably multiplies Claude Code's
total: try both values to see the sensitivity.

### The range: × 0.5 to × 2

Each tile shows a range, obtained by multiplying the central value by 0.5 and by 2. It is
not a statistical interval: it is a way of recalling that the uncertainty is at least a
factor of 2. The comparisons above show that it does not cover every public estimate.

## 3. From energy to CO₂

CO₂ = energy × carbon intensity of the electricity of the chosen country.

- **Source**: Ember, processed by Our World in Data, "Lifecycle carbon intensity of
  electricity" ([chart](https://ourworldindata.org/grapher/carbon-intensity-electricity),
  Ember data published on 21 April 2026, CC BY 4.0 licence). Emissions are estimated over
  the lifecycle of the means of generation, all greenhouse gases included, in grams of CO₂
  equivalent per kilowatt-hour generated. Year used: 2025.
- **Default value**: the world average, 458.3 g CO₂e/kWh. The 27 values offered are in
  [src/carbon.json](src/carbon.json).
- **Which country to choose**: where the models run, not necessarily yours. Providers do
  not say in which data centre a request is handled; the world average is a default choice,
  not a measurement.
- **Grid average, not electricity contracts**: EnergIA applies the average intensity of
  the grid. Providers often publish lower figures, which take their purchases of low-carbon
  electricity into account: Google uses 94 g CO₂e/kWh on that basis, against 345 for the
  average of the grids where it operates (study cited above). That is why Google reports
  0.03 g CO₂e per request, where EnergIA would count about 0.1 for the same energy.

## 4. From energy to water

Water = energy × 4.5 L/kWh. This is the wide scope: the water evaporated to cool the data
centre and the water consumed to generate its electricity. CO₂ is counted the same way,
electricity generation included.

| Scope | Value | Source |
|---|---|---|
| On-site cooling, average of US data centres | just over 0.36 L/kWh | [LBNL, 2024 report](https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf) |
| On-site cooling, Microsoft | 0.30 L/kWh (fiscal year 2024), 0.27 (2025) | [Microsoft](https://datacenters.microsoft.com/sustainability/efficiency/) |
| On-site cooling, Google | 1.15 L/kWh | [Google](https://arxiv.org/abs/2508.15734) |
| Generating the electricity, United States | 4.35 to 4.52 L/kWh | LBNL, same report |
| On-site range depending on place and season | 1 to 9 L/kWh | [Li et al., "Making AI Less Thirsty"](https://arxiv.org/abs/2304.03271) |

The value used rounds the sum of the two figures of the LBNL report for the United States
in 2023: 0.36 L/kWh on site and 4.52 L/kWh for the electricity of data centres, that is
4.9 L/kWh; with the average of the US grid (4.35), it comes to 4.7. EnergIA uses 4.5, a
little below, so as not to overestimate.

Two limits:

- **These are US figures**, applied everywhere. The water consumed to generate electricity
  depends a great deal on the country and its power plants; EnergIA does not vary water
  with the country chosen for CO₂.
- **Providers publish the narrow scope**, cooling alone. Google thus reports 0.26 mL per
  request, where EnergIA would count about 1 mL for the same energy. To get back to that
  scope, enter 0.4 in the assumptions.

## 5. The cost

Cost = tokens × public prices of the Anthropic and OpenAI APIs, per model, converted to
euros.

- **Prices**: collected from the providers' pricing pages, then compared every week with
  the [list kept by the LiteLLM project](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), which is not an official source. The date
  of the last check is recorded in [src/prices.json](src/prices.json). Current prices are applied to the whole
  history. A model missing from the list, or an export that does not say which model
  answered, gets an indicative price per category, marked with an asterisk.
- **Exchange rate**: the euro/dollar reference rate of the
  [European Central Bank](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml),
  fetched once a day by the plugin.
- **It is not a bill**: with a subscription, you pay the plan, not the tokens.

## 6. The equivalents

The tiles translate the figures into everyday reference points. These are round values;
here is what the sources say.

| Equivalent | EnergIA's value | What the sources say |
|---|---|---|
| One smartphone charge | 15 Wh | Battery capacity of a recent phone: 4,000 mAh for a [Galaxy S25](https://www.samsung.com/nz/smartphones/galaxy-s25/specs/), about 15 Wh at 3.85 V (EnergIA's conversion). The [US EPA](https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references) counts 19 Wh at the socket, charger losses included. |
| One kilometre by electric car | 170 Wh | US label of a [2026 Tesla Model Y Long Range](https://www.fueleconomy.gov/feg/PowerSearch.do?action=noform&path=1&year1=2025&year2=2026&make=Tesla&baseModel=Model%20Y&srchtyp=ymm): 27 kWh per 100 miles, about 168 Wh/km. The [IEA](https://www.iea.org/reports/global-ev-outlook-2025/electric-vehicle-charging) uses 200 Wh/km in real use. |
| One kilometre by petrol car | 170 g CO₂e | [ADEME](https://impactco2.fr/outils/transport/voiturethermique)'s value for an average petrol car, manufacturing included; 189 g for a saloon and 246 g for an SUV. |
| One shower | 60 L | [Eaufrance](https://www.services.eaufrance.fr/economie-d-eau): 35 to 60 L for a quick shower. [French Ministry of Ecology](https://archive-2017-2022.ecologie.gouv.fr/actualites/22-mars-cest-journee-mondiale-leau-0) (2018): 60 to 80 L. |
| One glass of water | 0.25 L | A convention: 250 mL is the metric cup. |

## What remains fragile

In order of importance for the results:

1. **The weight of tokens re-read from the cache** (2%): no source, and a major effect on
   Claude Code.
2. **Energy per token**: EnergIA is on the low side of public estimates; one study gives
   1.5 to 3.5 times more.
3. **Very long contexts**: probably underestimated.
4. **Water**: a US figure, applied whatever the country.
5. **The tokens of Claude exports**: still underestimated by about 30% for recent models.
6. **The country**: unknown, hence the world average by default.

None of these values is hidden: all can be changed in the page, and the monthly report
lists those that were used for the calculation.
