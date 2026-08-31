# Data Pipeline Spec — SME Digital & AI Readiness Index

Source of truth for the data layer: which Eurostat datasets feed the portal, how they join together, and what the two output tables look like. Read this before touching the pipeline.

## Pipeline structure

One module per stage, in `sme_pipeline/`. Each stage has a single job and hands a plain DataFrame to the next, so any stage can be run and inspected in isolation.

| Module | Stage | Responsibility |
|---|---|---|
| `config.py` | — | Dataset registry, paths, canonical vocabularies, join keys. Declarative only. |
| `extract.py` | 1 | Eurostat API → cached raw JSON-stat in `data/raw/`. |
| `parse.py` | 2 | Raw JSON-stat → tidy DataFrame via `pyjstat`. |
| `normalize.py` | 3 | Raw Eurostat codes → canonical codes. Fails loudly on unknowns. |
| `transform.py` | 4 | Universe join, table assembly, join diagnostics. |
| `datamap.py` | 5 | Builds the data dictionary describing both output tables. |
| `load.py` | 6 | Final tables → Parquet, datamap → JSON, in `data/processed/`. |
| `pipeline.py` | — | Chains the stages; `run()` returns every intermediate for inspection. |

`fetch_data.py` is a thin CLI over `pipeline.run()`. `explore_data.ipynb` is a QA surface that imports the package rather than reimplementing any of it.

Adding a dataset is a one-line `DatasetSpec` in `config.py`; the rest of the pipeline picks it up from its `level`.

**Cache behaviour:** `data/raw/` stores the request alongside the response, so changing `--geo`/`--time` re-fetches rather than silently returning the previous scope's data. Use `--refresh` to force.

## Datasets

All datasets are from Eurostat's ICT usage survey family (`isoc_*`) plus one structural business statistics table used as the enterprise-count universe. Dataset codes below are verified against Eurostat's data browser / DBnomics catalog.

### Firm-level, size-class family

Join key: `geo`, `time`, `size_emp`.

| Code | Title | Browser URL | API URL |
|---|---|---|---|
| `sbs_sc_ovw` | Enterprise statistics by size class and NACE Rev. 2 activity (the **universe** table) | https://ec.europa.eu/eurostat/databrowser/view/sbs_sc_ovw/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/sbs_sc_ovw?format=JSON&lang=EN |
| `isoc_eb_ai` | Artificial intelligence by size class of enterprise | https://ec.europa.eu/eurostat/databrowser/view/isoc_eb_ai/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/isoc_eb_ai?format=JSON&lang=EN |
| `isoc_eb_das` | Data analytics by size class of enterprise | https://ec.europa.eu/eurostat/databrowser/view/isoc_eb_das/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/isoc_eb_das?format=JSON&lang=EN |
| `isoc_e_dii` | Digital Intensity Index by size class of enterprise | https://ec.europa.eu/eurostat/databrowser/view/isoc_e_dii/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/isoc_e_dii?format=JSON&lang=EN |

`isoc_eb_ai` also carries the AI-adoption **barrier/reason** indicators (e.g. "lack of relevant expertise," "unclear legal consequences," "data protection concerns") as additional `INDIC_IS` category values within the same table — no separate dataset needed for the barrier-analysis KPI.

### Firm-level, sector family

Join key: `geo`, `time`, `nace_r2`.

| Code | Title | Browser URL | API URL |
|---|---|---|---|
| `isoc_eb_ain2` | Artificial intelligence by NACE Rev. 2 activity | https://ec.europa.eu/eurostat/databrowser/view/isoc_eb_ain2/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/isoc_eb_ain2?format=JSON&lang=EN |

`sbs_sc_ovw` also has full NACE Rev. 2 detail, so it doubles as the universe for the sector cut too (aggregate its size-class rows to an "all sizes" total per `geo`/`time`/`nace_r2`).

### Individual-level (separate table, not joined to firm-level)

| Code | Title | Browser URL | API URL |
|---|---|---|---|
| `isoc_ai_iaiu` | Individuals' use of generative AI tools | https://ec.europa.eu/eurostat/databrowser/view/isoc_ai_iaiu/default/table | https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/isoc_ai_iaiu?format=JSON&lang=EN |

Standard ICT household-survey demographic dimensions apply: `sex`, `age` (age class), `isced11` (education level).

### Not sourced from Eurostat

**"Estimated productivity impact"** — no Eurostat table covers this. Reserved as a known `indicator` value in the firm-level schema, but no rows are emitted for it until an OECD/academic source is wired up. Do not fabricate placeholder rows with null values for every geo/time/size_emp combination — that would bloat the table with rows carrying no information. Document the gap here instead.

## Key dimensions across datasets

Confirmed empirically against live API responses (see `explore_data.ipynb`). **Every** firm-level dataset carries the same dimension set — `size_emp` and `nace_r2` are both always present, and the "size-class family" vs "sector family" split is about which dimension is *detailed* vs *pinned to a single total*:

| Dataset | `size_emp` categories | `nace_r2` categories |
|---|---|---|
| `sbs_sc_ovw` | 8 | 343 (full NACE detail) |
| `isoc_eb_ai` | 8 | 1 (pinned to `C10-S951_X_K`) |
| `isoc_e_dii` | 11 | 1 |
| `isoc_eb_ain2` | 1 (pinned to `GE10`) | 50 |

Dimension names:
- `geo` — country code (`IT`, `DE`, `EU27_2020`)
- `time` — year
- `indic_is` — the information-society indicator (firm datasets); `indic_sbs` in `sbs_sc_ovw`
- `unit` — unit of measure; **part of the primary key**, see below
- `size_emp`, `nace_r2` — as above
- `ind_type` — `isoc_ai_iaiu` only; a *single combined* dimension (~105 categories) encoding sex, age, education, and labour status together (e.g. `F_Y25_54`, `IND_TOTAL`, `Y16_24HI`), **not** the separate `sex`/`age`/`isced11` dimensions originally assumed. It must be decoded into separate columns for the individual-level output table.
- `freq` — constant (`A` = annual); drop it.

### Primary key

**`(geo, time, size_emp, nace_r2, indic_is, unit)`** — verified to yield zero duplicate rows on every firm-level dataset. For `isoc_ai_iaiu`: `(geo, time, indic_is, unit, ind_type)`.

`unit` is essential, not decorative: `isoc_eb_ai` reports six distinct metrics (`PC_ENT`, `PC_ENT_AI_EC`, `PC_ENT_AI_PDI`, `PC_ENT_AI_TANY`, `PC_ENT_AI_TX`, `PC_ENT_IUSE`) that share the *same* `indic_is` code and differ only by `unit`. Omitting it produces 30,240 duplicate rows in a 36,288-row table and silently fans out any join.

### Parsing note

`pyjstat`'s `Dataset.write("dataframe")` defaults to `naming="label"`, which returns human-readable text ("From 0 to 1 person employed", "European Union - 27 countries (from 2020)") — unusable as join keys. Always pass **`naming="id"`** to get short codes (`0_1`, `EU27_2020`).

## Join logic

1. Fetch and tidy `sbs_sc_ovw` first — this is the universe/denominator table. Every enterprise count (`enterprise_count`) that a percentage-based indicator gets validated against comes from here.
2. Fetch and tidy each firm-level indicator dataset (`isoc_eb_ai`, `isoc_eb_das`, `isoc_e_dii`, `isoc_eb_ain2`) into the same long shape: `geo, time, size_emp (nullable), nace_r2 (nullable), indicator, value, dataset`.
3. Normalize `size_emp` labels before joining (see caveat below), then left-join each indicator dataset onto the `sbs_sc_ovw` universe:
   - Size-class datasets join on (`geo`, `time`, `size_emp`).
   - Sector datasets join on (`geo`, `time`, `nace_r2`), against `sbs_sc_ovw` aggregated to "all sizes" per sector.
4. Concatenate all joined indicator rows into one long firm-level table. `nace_r2` stays null for rows sourced from a size-class dataset; `size_emp` stays null (or `"ALL"`) for rows sourced from a sector dataset.
5. Keep the `dataset` column on every row for traceability back to its Eurostat source table.
6. Build the individual-level table separately from `isoc_ai_iaiu` — never merge it into the firm-level table, since it describes people, not businesses.

### Caveat 1: size-class bands don't match across datasets

Actual `size_emp` codes observed:

| Dataset | Codes |
|---|---|
| `sbs_sc_ovw` | `0_1`, `2-9`, `0-9`, `10-19`, `20-49`, `50-249`, `GE250`, `TOTAL` |
| `isoc_eb_ai` | `0_1`, `2-9`, `0-9`, `10-49`, `50-249`, `10-249`, `GE10`, `GE250` |
| `isoc_e_dii` | as `isoc_eb_ai`, plus `1-4`, `1-9`, `5-9` |
| `isoc_eb_ain2` | `GE10` only |

- The ICT surveys only *populate* enterprises with ≥10 employees. Sub-10 bands (`0_1`, `2-9`, `0-9`) appear in the dimension list but their values are `NaN` — **micro-enterprises are never sampled.** Any "% of SMEs" headline implicitly excludes the smallest businesses; call this out in the portal's methodology notes, since "SME" colloquially includes micro-enterprises.
- `sbs_sc_ovw` has no `10-49` band — it must be built by summing `10-19` + `20-49` to align with the ICT surveys.
- `fetch_data.py` must fail loudly — raise an exception naming the unmapped raw code — on any unrecognized `size_emp` or `nace_r2` category, rather than silently dropping or mis-joining rows.

### Caveat 2: time coverage limits what can be weighted to absolute numbers

`sbs_sc_ovw` covers **2021–2024 only**. Any indicator year outside that window has no enterprise-count denominator, so it can be charted as a percentage but never converted to an absolute number of SMEs.

| Dataset | Years available | Joinable to universe |
|---|---|---|
| `sbs_sc_ovw` | 2021–2024 | — (is the universe) |
| `isoc_eb_ai`, `isoc_eb_ain2` | 2021, 2023, 2024, 2025 | all but 2025 |
| `isoc_eb_das` | 2023–2025 | 2023, 2024 |
| `isoc_e_dii` | 2015–2025 | 2021–2024 |

Consequences:
- The most recent survey year (2025) always leads the SBS universe by roughly a year. Expect the newest percentages to arrive before their denominators.

### Caveat 3: the "all sectors" totals are different populations, not different labels

`sbs_sc_ovw`'s business-economy total is **`B-S_X_O_S94`** (NACE sections B–S excluding O and S94). The ICT surveys' surveyed-population total is **`C10-S951_X_K`** (C10–S95.1 excluding K). `C10-S951_X_K` does not exist anywhere in `sbs_sc_ovw`'s 343 NACE codes — these are genuinely different scopes (the ICT scope excludes mining/section B and financial services/section K).

**Decision: accept the approximation.** Use `B-S_X_O_S94` as the enterprise-count denominator for ICT-survey rows and document it. The scopes overlap heavily and the gap is a small share of the enterprise population — acceptable for a directional insight portal. Every joined row must therefore be understood as "% from the ICT survey population × count from the slightly broader SBS business economy," which makes derived absolute figures **estimates, not exact counts**. Label them as such in the portal.

### Caveat 4: the sector datasets use bespoke NACE aggregates (open item)

`isoc_eb_ain2` publishes ~23 sector groupings that do not exist among `sbs_sc_ovw`'s 343 NACE codes — e.g. `C10-C12`, `C26-C33`, `J62_J63`, `L_M`, `ICT`, `N77-N82_X_N79`. The ICT survey invents its own groupings rather than reusing standard NACE divisions.

Direct code matching therefore fails for these rows (current sector match rate: 31%, entirely from codes that happen to coincide). **Unresolved:** the sector cut needs an explicit aggregate → SBS-component mapping table before sector rows can be weighted to absolute enterprise counts. Sector *percentages* are unaffected and can be charted today.

### Current join health

Denominator match rates from a dev-scope run (IT, DE, EU27_2020), as a regression baseline:

| Source | Match rate | Limiting factor |
|---|---|---|
| `isoc_eb_ai` | 65.8% | 2025 has no universe year |
| `isoc_eb_das` | 50.0% | covers 2023–2025; universe ends 2024 |
| `isoc_e_dii` | 37.7% | covers 2015–2025; universe covers 2021–2024 |
| `isoc_eb_ain2` | 31.0% | Caveat 4 (NACE aggregates) |

These are data-availability boundaries, not pipeline defects. A rate *dropping* below its row here signals a regression.

## Output tables

`data/processed/` holds each table beside its own datamap:

| File | What it is |
|---|---|
| `firm_level.parquet` | The firm-level table — canonical, typed |
| `firm_level.datamap.json` | Data dictionary for that table (~96 KB) |
| `individual_level.parquet` | The individual-level table — canonical, typed |
| `individual_level.datamap.json` | Data dictionary for that table (~14 KB) |

### The datamap

The Parquet files store short codes (`IT`, `SMALL_10_49`, `E_AI_TTM|PC_ENT`) because that is what joins are built on — but a code alone tells a reader nothing. Each `{table}.datamap.json` is the companion document that restores the meaning, built by [datamap.py](sme_pipeline/datamap.py). One datamap per table, rather than one combined file, so each describes only its own data — its own source datasets, and only the caveats that actually apply to it.

- **Per table** — source file, unit of observation, grain, row count, verified primary key.
- **Per column** — label, role (`dimension` / `measure`), dtype, nullability, null count, distinct count, and for measures the min / max / mean.
- **Per value** — the full code → label vocabulary, taken from Eurostat's own `dimension.category.label` and limited to codes actually present in the data. The composite `indicator` code is decomposed back into its `indic_is` and `unit` parts, each with its label.
- **Caveats** — the constraints below, carried inside the data product itself rather than living only in this file.

Two facts drove this design:

1. **Integer-encoding the columns would save nothing.** Parquet already dictionary-encodes strings internally — measured at 184,323 bytes with string codes versus 184,950 with integer categories. So the codes stay readable, and the datamap adds meaning rather than compression.
2. **Labels merge without conflict.** All seven raw files carry category labels, and no code has a conflicting label between tables, so a plain merge is safe.

This replaced two row-for-row JSON dumps that reached **9.8 MB** at dev scope while adding nothing the Parquet did not already hold.

> **Still open — the page-ready export.** The datamap describes the data; it is not the data the portal will fetch. A curated per-chart export (only the indicators, years and geographies each published chart uses) is deferred until the chart designs exist.

### Firm-level vs individual-level — why they are separate files

They count **different things**, so they can never be rows of the same table.

| | `firm_level` | `individual_level` |
|---|---|---|
| Unit of observation | An enterprise (10+ employees) | A person aged 16–74 |
| Rows | 61,438 | 3,174 |
| Source datasets | 6 ICT enterprise surveys + `sbs_sc_ovw` universe | `isoc_ai_iaiu` only |
| Years | 2015–2025 | 2025 only (first year genAI was surveyed) |
| Breakdowns | size class, sector | sex, age, education |
| Denominator | `enterprise_count`, so percentages convert to absolute counts | none — percentages only |
| Answers | "What share of businesses of this size do X?" | "What share of people did X?" |

Merging them would be a category error: a percentage of *businesses* and a percentage of *people* are not comparable quantities, and the individual table has no enterprise universe to weight against.

Keeping them apart is what makes the **readiness-gap** narrative possible — contrasting how fast ordinary people adopted generative AI against how slowly their employers adopted AI. At EU-27 level in 2025: **32.7% of people** had used generative AI, against **11.1% of SMEs** using text-mining AI.

### Firm-level table

One row per (`geo`, `time`, `size_emp`, `nace_r2`, `indicator`) observation.

| Column | Description |
|---|---|
| `geo` | Country code (e.g. `IT`, `DE`, `EU27_2020`) |
| `time` | Year |
| `size_emp` | Normalized enterprise size class (e.g. `SME_10_49`, `SME_50_249`, `LARGE_250PLUS`, `ALL`); null for sector-sourced rows |
| `nace_r2` | Sector code; null unless the row comes from a sector-level dataset |
| `indicator` | What's measured (e.g. `uses_ai`, `digital_intensity_level`, `uses_big_data_analytics`, `reason_no_ai_lack_expertise`, `enterprise_count`) |
| `value` | The number itself (percentage in most cases) |
| `enterprise_count` | Total enterprises in this geo/time/size_emp(/nace_r2) universe, from `sbs_sc_ovw` — the denominator the percentage was calculated against |
| `dataset` | Eurostat source table code, for traceability |

### Individual-level table

One row per (`geo`, `time`, `indicator`, demographic breakdown) observation. Kept separate from the firm-level table.

| Column | Description |
|---|---|
| `geo` | Country code |
| `time` | Year |
| `indicator` | What's measured (e.g. `used_generative_ai`) |
| `value` | The number itself |
| `sex` | Demographic breakdown, where relevant |
| `age` | Age class, where relevant |
| `isced11` | Education level, where relevant |
| `dataset` | Eurostat source table code (`isoc_ai_iaiu`) |

## Analyses this enables

- **SME vs. large enterprise gap** — compare `size_emp` categories within a `geo`/`time`/`indicator`.
- **Country ranking** — fix `time` and `size_emp`, rank `geo` by `indicator`, benchmark against `EU27_2020`.
- **Trend over time** — fix `geo`/`size_emp`/`indicator`, plot across `time`.
- **Sector breakdown** — fix `geo`/`time`, compare `indicator` across `nace_r2`.
- **Weighted/absolute figures** — multiply a percentage `indicator` by `enterprise_count` to get estimated absolute enterprise counts.
- **Barrier analysis** — filter `indicator` to the `reason_no_ai_*` family.
- **Individual vs. enterprise contrast** — compare `isoc_ai_iaiu`'s `used_generative_ai` (individual table) against `isoc_eb_ai`'s `uses_ai` (firm-level table) for the same `geo`/`time`.
