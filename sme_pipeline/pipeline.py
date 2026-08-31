"""Orchestration - chain the stages into one runnable pipeline."""

from dataclasses import dataclass

import pandas as pd

from . import config, datamap as datamap_module, extract, load, parse, transform


@dataclass
class PipelineResult:
    firm_table: pd.DataFrame
    individual_table: pd.DataFrame
    universe: pd.DataFrame
    tidy: dict
    vocabulary: dict
    datamaps: dict
    written: dict


def run(geo=None, time=None, refresh=False, write=True, verbose=True):
    """Run the full pipeline: extract -> parse -> normalize -> transform -> load."""
    geo = geo or config.DEFAULT_GEO

    def log(message):
        if verbose:
            print(message)

    log("== extract ==")
    raw = extract.fetch_all(config.DATASETS, geo=geo, time=time, refresh=refresh, verbose=verbose)

    log("\n== parse ==")
    tidy = parse.to_tidy_all(raw)
    vocabulary = parse.merge_labels(raw)
    log(f"  vocabulary: {sum(len(v) for v in vocabulary.values()):,} labelled codes "
        f"across {len(vocabulary)} dimensions")
    for code, df in tidy.items():
        key = config.INDIVIDUAL_KEY if code == "isoc_ai_iaiu" else config.FIRM_KEY
        key = [c for c in key if c in df.columns]
        dupes = parse.check_key_unique(df, key, label=code)
        log(f"  {code}: {len(df):,} observations, {dupes} duplicates on key")

    log("\n== transform ==")
    universe = transform.build_universe(tidy)
    log(f"  universe: {len(universe):,} rows")

    firm_table = transform.build_firm_table(tidy, universe)
    individual_table = transform.build_individual_table(tidy)
    log(f"  firm-level: {len(firm_table):,} rows")
    log(f"  individual-level: {len(individual_table):,} rows")

    log("\n  denominator match rate by source:")
    for row in transform.join_report(firm_table).itertuples():
        log(f"    {row.dataset:<14} {row.matched:>7,}/{row.rows:<7,} ({row.match_rate:.1%})")

    log("\n== datamap ==")
    datamaps = datamap_module.build_all(
        firm_table, individual_table, vocabulary, scope={"geo": geo, "time": time}
    )
    for name, dm in datamaps.items():
        described = sum(1 for c in dm["columns"].values() if "codes" in c)
        log(f"  {name}: {len(dm['columns'])} columns, {described} with a code vocabulary, "
            f"{len(dm['caveats'])} caveats")

    written = {}
    if write:
        log("\n== load ==")
        written = load.write_outputs(firm_table, individual_table, datamaps)
        for name, path in written.items():
            log(f"  {path.name} ({path.stat().st_size / 1024:,.0f} KB)")

    return PipelineResult(
        firm_table=firm_table,
        individual_table=individual_table,
        universe=universe,
        tidy=tidy,
        vocabulary=vocabulary,
        datamaps=datamaps,
        written=written,
    )
