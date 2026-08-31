"""Stage 4 - assemble the two output tables and join firm rows to the universe."""

import pandas as pd

from . import config, normalize

FIRM_COLUMNS = [
    "geo",
    "time",
    "size_emp",
    "nace_r2",
    "indicator",
    "value",
    "enterprise_count",
    "dataset",
]

INDIVIDUAL_COLUMNS = [
    "geo",
    "time",
    "indicator",
    "value",
    "sex",
    "age",
    "education",
    "ind_type",
    "dataset",
]


# --- Universe ---------------------------------------------------------------

def _derive_size_bands(universe):
    """Add the canonical bands SBS does not publish, by summing finer ones.

    Enterprise counts are additive, so this reconstruction is valid. A band is
    only derived where *every* component is present - a partial sum would look
    authoritative while understating the total.
    """
    frames = [universe]

    for derived, components in config.SIZE_EMP_DERIVED.items():
        subset = universe[universe["size_emp"].isin(components)]
        if subset.empty:
            continue

        agg = (
            subset.groupby(["geo", "time", "nace_r2"], dropna=False)
            .agg(enterprise_count=("enterprise_count", "sum"), present=("size_emp", "nunique"))
            .reset_index()
        )
        agg = agg[agg["present"] == len(components)].drop(columns=["present"])
        agg["size_emp"] = derived
        frames.append(agg)

    return pd.concat(frames, ignore_index=True)


def build_universe(tidy_by_code):
    """Build the enterprise-count denominator table from sbs_sc_ovw."""
    df = tidy_by_code[config.DATASETS_BY_CODE["sbs_sc_ovw"].code]
    df = normalize.normalize_size_emp(df, source="sbs_sc_ovw")

    universe = df[["geo", "time", "size_emp", "nace_r2", "value"]].rename(
        columns={"value": "enterprise_count"}
    )
    return _derive_size_bands(universe)


# --- Firm-level table -------------------------------------------------------

def _prepare_firm_rows(df, spec):
    """Normalize one firm-level dataset into the shared firm-table shape."""
    out = normalize.normalize_size_emp(df, source=spec.code)
    out = normalize.build_indicator(out)
    out["dataset"] = spec.code

    # The ICT surveys' "all sectors" total is a different population from the
    # SBS one (see DATA_PIPELINE_SPEC.md, Caveat 2). We accept SBS's business
    # economy as an approximate denominator, so the join uses the SBS code
    # while the reported nace_r2 follows the output schema below.
    out["_universe_nace"] = out["nace_r2"].replace(
        {config.NACE_TOTAL_ICT: config.NACE_TOTAL_SBS}
    )

    if spec.level == config.LEVEL_FIRM_SIZE:
        # Size-class rows are all the same sector total, so per the output
        # schema nace_r2 is left null; the sector cut carries the detail.
        out["nace_r2"] = pd.NA

    return out


def build_firm_table(tidy_by_code, universe):
    """Join every firm-level dataset onto the universe and stack them."""
    specs = config.datasets_at_level(config.LEVEL_FIRM_SIZE, config.LEVEL_FIRM_SECTOR)

    frames = []
    for spec in specs:
        if spec.code not in tidy_by_code:
            continue

        prepared = _prepare_firm_rows(tidy_by_code[spec.code], spec)
        merged = prepared.merge(
            universe.rename(columns={"nace_r2": "_universe_nace"}),
            on=["geo", "time", "size_emp", "_universe_nace"],
            how="left",
        )
        frames.append(normalize.ensure_columns(merged, FIRM_COLUMNS)[FIRM_COLUMNS])

    if not frames:
        return pd.DataFrame(columns=FIRM_COLUMNS)

    return pd.concat(frames, ignore_index=True)


# --- Individual-level table -------------------------------------------------

def build_individual_table(tidy_by_code):
    """Build the person-level table, kept separate from the firm-level one."""
    specs = config.datasets_at_level(config.LEVEL_INDIVIDUAL)

    frames = []
    for spec in specs:
        if spec.code not in tidy_by_code:
            continue

        prepared = normalize.build_indicator(tidy_by_code[spec.code])
        prepared = normalize.expand_ind_type(prepared)
        prepared["dataset"] = spec.code
        frames.append(normalize.ensure_columns(prepared, INDIVIDUAL_COLUMNS)[INDIVIDUAL_COLUMNS])

    if not frames:
        return pd.DataFrame(columns=INDIVIDUAL_COLUMNS)

    return pd.concat(frames, ignore_index=True)


# --- Diagnostics ------------------------------------------------------------

def join_report(firm_table):
    """Per-dataset denominator match rate - the key health check for the join."""
    if firm_table.empty:
        return pd.DataFrame(columns=["dataset", "rows", "matched", "match_rate"])

    return (
        firm_table.assign(matched=firm_table["enterprise_count"].notna())
        .groupby("dataset")
        .agg(rows=("matched", "size"), matched=("matched", "sum"))
        .assign(match_rate=lambda d: d["matched"] / d["rows"])
        .reset_index()
    )
