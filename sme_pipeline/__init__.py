"""Data pipeline for the SME Digital & AI Readiness Index.

Stages run in order (see DATA_PIPELINE_SPEC.md):

    config     dataset registry, paths, canonical vocabularies
    extract    Eurostat API -> cached raw JSON-stat          (data/raw/)
    parse      raw JSON-stat -> tidy DataFrame               (pyjstat, naming="id")
    normalize  raw Eurostat codes -> canonical codes         (fail-loud on unknowns)
    transform  tidy tables -> firm-level / individual-level  (universe join)
    load       final tables -> Parquet + JSON                (data/processed/)

`pipeline.run()` chains them; `fetch_data.py` is the CLI entry point.
"""
