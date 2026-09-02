"""Build the datamap - a data dictionary describing the Parquet outputs.

The Parquet files hold short codes (`IT`, `SMALL_10_49`, `E_AI_TTM`, `PC_ENT`)
because those are what joins are built on. This module produces the companion
document that says what each column is, what type it holds, and what every code
in it means - so the tables can be read without going back to Eurostat.

Build only, no I/O: `load.write_datamap()` writes the result.
"""

from datetime import datetime, timezone

import pandas as pd

from . import config

DATAMAP_VERSION = "1.0"

# Columns that carry a measurement rather than identifying an observation.
MEASURE_COLUMNS = {"value", "enterprise_count"}

# Human-readable names for our own column vocabulary. Eurostat labels the
# category values; these label the columns themselves.
COLUMN_LABELS = {
    "geo": "Country or aggregate",
    "time": "Reference year",
    "size_emp": "Enterprise size class",
    "nace_r2": "Economic activity (NACE Rev. 2)",
    "indicator": "Measured indicator",
    "unit": "Unit, i.e. the base population the percentage is a share of",
    "value": "Observed value",
    "enterprise_count": "Enterprises in this population",
    "dataset": "Eurostat source table",
    "sex": "Sex",
    "age": "Age band",
    "education": "Education level",
    "ind_type": "Individual type (raw Eurostat breakdown code)",
}

# Which Eurostat dimension supplies the labels for each of our columns. Columns
# we derive ourselves (sex, education, ...) have no Eurostat vocabulary.
LABEL_SOURCE = {
    "geo": "geo",
    "time": "time",
    "size_emp": "size_emp",
    "nace_r2": "nace_r2",
    "ind_type": "ind_type",
}

COLUMN_NOTES = {
    "size_emp": (
        "Canonical band, normalized from the source codes. SBS publishes 10-19 and "
        "20-49 separately; SMALL_10_49, SME_10_249 and ALL_GE10 are derived by summing "
        "component bands (enterprise counts are additive)."
    ),
    "nace_r2": (
        "Null for rows from size-class datasets, which cover all sectors combined. "
        "Populated only for sector-level sources."
    ),
    "indicator": (
        "The Eurostat indicator code (indic_is, or indic_sbs for the universe table). It "
        "does not identify a metric on its own: several metrics share one code and differ "
        "only by unit, so filter on `indicator` and `unit` together."
    ),
    "unit": (
        "The other half of the metric's identity. Every unit here is a percentage; what "
        "differs is the population it is a percentage of - see codes[...].base, and "
        "codes[...].weightable for whether enterprise_count is its denominator."
    ),
    "value": (
        "Always a percentage (0-100), but of a base population that varies by unit. "
        "Read unit.codes[...].base before comparing two values, and see the "
        "mixed_denominators caveat: identical-looking numbers can have different meanings."
    ),
    "enterprise_count": (
        "Denominator from sbs_sc_ovw. Null wherever no universe row matches, chiefly "
        "for years outside 2021-2024. See caveats."
    ),
    "ind_type": (
        "Eurostat packs sex, age, education, labour status and citizenship into this one "
        "dimension. The sex/age/education columns decode the demographic subset; codes "
        "expressing something else decode to null."
    ),
}

# --- Unit base populations --------------------------------------------------

# Every unit in this data is a percentage - but of 18 different base populations.
# Two rows can both read "45.7" and mean entirely different things, and nothing
# about the number reveals which. Classifying the base makes the only safe rule
# explicit: compare or chart values only within the same base.
UNIT_BASE = {
    # enterprises
    "PC_ENT": "all_enterprises",
    "PC_ENT_IUSE": "enterprises_with_internet_for_staff",
    "PC_ENT_IACC": "enterprises_with_internet_access",
    "PC_ENT_CUSE": "enterprises_using_a_computer",
    "PC_ENT_FIXBB": "enterprises_with_fixed_broadband",
    "PC_ENT_AI_TANY": "enterprises_using_ai",
    "PC_ENT_AI_TX": "enterprises_not_using_ai",
    "PC_ENT_AI_EC": "enterprises_that_considered_ai",
    "PC_ENT_AI_PDI": "enterprises_processing_personal_data_with_ai",
    "PC_ENT_AWSELL": "enterprises_with_web_sales",
    "PC_ENT_AESELL": "enterprises_with_ecommerce_orders",
    "PC_ENT_CC": "enterprises_buying_cloud_services",
    "PC_ENT_WEB": "enterprises_with_a_website",
    "PC_ENT_ADS": "enterprises_using_internet_advertising",
    "PC_ENT_ITSPRCR2": "enterprises_that_recruited_ict_staff",
    "PC_ENT_DAOWN": "enterprises_doing_own_data_analytics",
    "PC_ENT_SECPOL1": "enterprises_with_an_ict_security_policy",
    "PC_ENT_SECPOL2": "enterprises_with_documented_security_measures",
    # individuals
    "PC_IND": "all_individuals",
    "PC_IND_IU3": "individuals_who_used_internet_recently",
    "PC_IND_IUAI": "individuals_who_used_generative_ai",
}

# `enterprise_count` counts ALL enterprises, so it is the correct denominator for
# exactly one unit. Multiplying any other unit by it silently invents a number:
# e.g. PC_ENT_AI_TANY is a share of AI *users*, a population we do not count.
WEIGHTABLE_UNITS = {"PC_ENT"}


CAVEATS = {
    "universe_years": (
        "The enterprise-count universe (sbs_sc_ovw) covers 2021-2024 only. Indicator values "
        "outside that window have no denominator and cannot be converted to absolute numbers."
    ),
    "nace_scope": (
        "The ICT surveys' sector total (C10-S951_X_K) and the SBS business-economy total "
        "(B-S_X_O_S94) are different populations, not different labels. Absolute figures "
        "derived from this join are estimates, not exact counts."
    ),
    "micro_excluded": (
        "The ICT surveys only sample enterprises with 10 or more employees. Micro-enterprises "
        "exist in the universe but are never measured, so any 'SME' figure here excludes them."
    ),
    "sector_unweighted": (
        "isoc_eb_ain2 uses bespoke NACE groupings that do not exist in the SBS universe, so "
        "sector rows are largely unweighted. Sector percentages are unaffected."
    ),
    "overlapping_size_bands": (
        "Size classes overlap; they are not a partition. SME_10_249 already contains "
        "SMALL_10_49 and MEDIUM_50_249, and ALL_GE10 contains those plus LARGE_GE250. "
        "Summing across size_emp double-counts. The same applies to indicators: a firm "
        "using three AI technologies is counted once in E_AI_TANY and three times across "
        "the individual technology indicators."
    ),
    "mixed_denominators": (
        "Every value is a percentage, but of 18 different base populations (see each "
        "unit's `base`). PC_ENT is a share of all enterprises; PC_ENT_AI_EC is a "
        "share only of those that considered AI. Both render as 0-100 and look "
        "comparable. Only compare or chart values that share the same base."
    ),
    "weighting_only_pc_ent": (
        "enterprise_count counts all enterprises, so only unit PC_ENT (`weightable: "
        "true`) may be multiplied by it to obtain absolute figures. Weighting any other "
        "unit produces a number with no meaning, because its base population is not the "
        "one being counted."
    ),
    "overlapping_breakdowns": (
        "Rows are overlapping subsets, not a partition: the same person is counted under "
        "IND_TOTAL, an age band, a sex band and an education band. Filter these rows, never "
        "sum them."
    ),
    "no_denominator": (
        "There is no population-count column. Unlike the firm-level table, these percentages "
        "cannot be converted into absolute numbers of people - no equivalent of the sbs_sc_ovw "
        "universe is wired up."
    ),
    "not_comparable_to_firms": (
        "The unit of observation is a person, not a business. Never join or concatenate these "
        "rows with firm_level: comparing them is the point, merging them is a category error."
    ),
}


# Everything that distinguishes one output table from the other, so `build_one`
# stays generic and each datamap carries only what is true of its own file.
TABLE_SPECS = {
    "firm_level": {
        "file": "firm_level.parquet",
        "unit_of_observation": "An enterprise (business with 10+ employees).",
        "grain": "One row per country x year x size class x sector x indicator x unit.",
        "key": config.FIRM_TABLE_KEY,
        "source_levels": (
            config.LEVEL_UNIVERSE,
            config.LEVEL_FIRM_SIZE,
            config.LEVEL_FIRM_SECTOR,
        ),
        "caveats": [
            "universe_years",
            "nace_scope",
            "micro_excluded",
            "sector_unweighted",
            "overlapping_size_bands",
            "mixed_denominators",
            "weighting_only_pc_ent",
        ],
    },
    "individual_level": {
        "file": "individual_level.parquet",
        "unit_of_observation": "A person aged 16-74.",
        "grain": (
            "One row per country x year x indicator x unit x individual-type breakdown. "
            "Breakdowns overlap; filter, never sum."
        ),
        "key": config.INDIVIDUAL_TABLE_KEY,
        "source_levels": (config.LEVEL_INDIVIDUAL,),
        "caveats": [
            "overlapping_breakdowns",
            "mixed_denominators",
            "no_denominator",
            "not_comparable_to_firms",
        ],
    },
}


def _profile_column(series):
    """Type, nullability and distribution facts for one column."""
    profile = {
        "dtype": str(series.dtype),
        "nullable": bool(series.isna().any()),
        "null_count": int(series.isna().sum()),
        "distinct": int(series.nunique(dropna=True)),
    }

    if pd.api.types.is_numeric_dtype(series) and series.notna().any():
        profile["min"] = round(float(series.min()), 4)
        profile["max"] = round(float(series.max()), 4)
        profile["mean"] = round(float(series.mean()), 4)

    return profile


def _indicator_codes(series, vocabulary):
    """Eurostat's label for each indicator code.

    indic_is (the ICT surveys) and indic_sbs (the universe table) are disjoint
    namespaces, so one merged lookup serves both.
    """
    labels = {**vocabulary.get("indic_is", {}), **vocabulary.get("indic_sbs", {})}
    return {code: labels.get(code) for code in sorted(series.dropna().unique())}


def _unit_codes(series, vocabulary):
    """Each unit with its label, its base population, and whether it is weightable."""
    labels = vocabulary.get("unit", {})

    codes = {}
    for code in sorted(series.dropna().unique()):
        codes[code] = {
            "label": labels.get(code),
            # Unknown units are reported as such rather than guessed, and are never
            # marked weightable - a new Eurostat unit must be classified explicitly.
            "base": UNIT_BASE.get(code, f"UNCLASSIFIED:{code}"),
            "weightable": code in WEIGHTABLE_UNITS,
        }
    return codes


def _column_codes(name, series, vocabulary):
    """The value vocabulary for one column, or None if it has no code list."""
    if name in MEASURE_COLUMNS:
        return None

    if name == "indicator":
        return _indicator_codes(series, vocabulary)

    if name == "unit":
        return _unit_codes(series, vocabulary)

    if name == "dataset":
        return {
            spec.code: spec.description
            for spec in config.DATASETS
            if spec.code in set(series.dropna().unique())
        }

    present = sorted(series.dropna().unique())

    if name == "size_emp":
        # Canonical codes are ours, so map back through the raw code to reach
        # the Eurostat label, and fall back to the canonical name.
        raw_for_canonical = {v: k for k, v in config.SIZE_EMP_CANONICAL.items()}
        source_labels = vocabulary.get("size_emp", {})
        return {
            code: source_labels.get(raw_for_canonical.get(code), code)
            for code in present
        }

    source = LABEL_SOURCE.get(name)
    if source:
        labels = vocabulary.get(source, {})
        return {code: labels.get(code, code) for code in present}

    # Derived columns (sex, age, education) - the codes are self-explanatory.
    return {code: code for code in present}


def _describe_columns(df, vocabulary):
    columns = {}
    for name in df.columns:
        entry = {
            "label": COLUMN_LABELS.get(name, name),
            "role": "measure" if name in MEASURE_COLUMNS else "dimension",
        }
        entry.update(_profile_column(df[name]))

        if note := COLUMN_NOTES.get(name):
            entry["note"] = note

        codes = _column_codes(name, df[name], vocabulary)
        if codes is not None:
            entry["codes"] = codes

        columns[name] = entry

    return columns


def _describe_sources(df, table_spec):
    """The Eurostat tables feeding this output table, with the years each supplied."""
    years_by_dataset = {}
    if not df.empty and "dataset" in df.columns:
        for code, group in df.groupby("dataset"):
            years_by_dataset[code] = sorted(group["time"].dropna().unique().tolist())

    datasets = []
    for spec in config.datasets_at_level(*table_spec["source_levels"]):
        entry = {
            "code": spec.code,
            "label": spec.description,
            "level": spec.level,
            "browser_url": spec.browser_url,
            "years": years_by_dataset.get(spec.code, []),
        }
        if spec.level == config.LEVEL_UNIVERSE:
            # It contributes no rows of its own, only the enterprise_count column.
            entry["role"] = "denominator only - supplies enterprise_count, not rows"
        datasets.append(entry)
    return datasets


def build_one(name, df, vocabulary, scope=None):
    """Build the datamap for a single output table."""
    table_spec = TABLE_SPECS[name]
    scope = scope or {}

    return {
        "datamap_version": DATAMAP_VERSION,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "table": {
            "name": name,
            "file": table_spec["file"],
            "unit_of_observation": table_spec["unit_of_observation"],
            "grain": table_spec["grain"],
            "rows": int(len(df)),
            "primary_key": table_spec["key"],
        },
        "source": {
            "provider": "Eurostat",
            "api_base": config.API_BASE,
            "datasets": _describe_sources(df, table_spec),
        },
        "scope": {
            "geo": list(scope.get("geo") or []),
            "time": list(scope.get("time") or []) or None,
        },
        "columns": _describe_columns(df, vocabulary),
        "caveats": [CAVEATS[key] for key in table_spec["caveats"]],
    }


def build_all(firm_table, individual_table, vocabulary, scope=None):
    """Build one datamap per output table, keyed by table name."""
    tables = {"firm_level": firm_table, "individual_level": individual_table}
    return {
        name: build_one(name, df, vocabulary, scope=scope)
        for name, df in tables.items()
    }
