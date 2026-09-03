# Code architecture

This project has two independent flows. Keep them separate when making a
change: the data pipeline creates canonical tables; the site export turns those
tables into a deliberately small browser bundle.

## Start here

| Need to change | First file to read | Follow-up |
| --- | --- | --- |
| Eurostat sources, paths, or canonical codes | `sme_pipeline/config.py` | `extract.py`, `normalize.py` |
| Pipeline order or a new output table | `sme_pipeline/pipeline.py` | `transform.py`, `load.py` |
| Parquet schema and data dictionary | `sme_pipeline/transform.py` | `datamap.py` |
| What the dashboard ships and charts | `sme_pipeline/export.py` | `docs/app.js` |
| Barrier-ranking methodology | `sme_pipeline/barrier_analysis.py` | `analyse_barriers.py` |

## Data path

```text
Eurostat API
  -> extract.py (cached JSON-stat)
  -> parse.py (tidy frames + labels)
  -> normalize.py (canonical codes)
  -> transform.py (firm/person tables)
  -> datamap.py + load.py (Parquet and metadata)
  -> export.py (curated JSON for the static site)
  -> docs/app.js (interactive dashboard)
```

## File-size rule

Keep modules focused on one responsibility. Configuration-heavy files are fine
when they are declarative, but new executable behaviour should not be added to
the large modules below. Prefer extracting a focused module first:

- `export.py`: chart specifications, chart-frame filtering, and JSON writing.
- `barrier_analysis.py`: panel assembly, regression/Shapley calculations, and
  country-contribution reporting.
- `datamap.py`: metadata declarations and metadata-building helpers.

Public entry points stay deliberately small: `pipeline.run()`, `export.export()`,
`barrier_analysis.analyse()`, and `barrier_analysis.by_country()`.
