"""Page-ready export.

The Parquet tables are canonical but far too broad to ship to a browser: 291
indicators across 18 unit bases, most of which must never be charted next to
each other. This module resolves the open item in DATA_PIPELINE_SPEC.md - a
curated per-chart export carrying only the indicators, years and geographies
the published charts actually use.

Two rules are enforced here rather than left to the page:

1. Every firm-level chart is pinned to a single ``unit``. Mixing bases is the
   one error that produces charts which look right and are wrong.
2. Unknown indicator codes raise, naming the code. A silently dropped series
   becomes an empty chart nobody notices.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .config import PROCESSED_DIR

# "docs" rather than "site": GitHub Pages' branch deployment only offers the
# repository root or /docs as a source, never an arbitrary folder.
SITE_DATA_DIR = Path(__file__).resolve().parents[1] / "docs" / "data"

# Size bands the page offers. SMALL/MEDIUM/LARGE are disjoint and partition
# ALL_GE10; SME_10_249 overlaps the first two and exists for headline figures
# only. The page must never place an overlapping band beside its components.
SIZE_BANDS = ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250", "SME_10_249", "ALL_GE10"]

DISJOINT_BANDS = ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250"]

# Chart specs. `unit` is deliberately mandatory - see module docstring.
FIRM_CHARTS = {
    "ai_adoption": {
        "section": "gap",
        "title": "Enterprises using at least one AI technology",
        "unit": "PC_ENT",
        "indicators": ["E_AI_TANY"],
    },
    "ai_purposes": {
        "section": "purposes",
        "title": "What AI is used for",
        "unit": "PC_ENT",
        "indicators": [
            "E_AI_PMS",
            "E_AI_PPP",
            "E_AI_PBAM",
            "E_AI_PLOG",
            "E_AI_PITS",
            "E_AI_PFIN",
            "E_AI_PRDI",
        ],
    },
    "ai_barriers": {
        "section": "barriers",
        "title": "Why enterprises do not use AI",
        # Deliberately NOT PC_ENT. As a share of all enterprises a barrier reads
        # as 4-5% and the size bands invert, because most firms never considered
        # AI at all and so answered nothing. PC_ENT_AI_EC - a share of those that
        # did consider it - is the population the question was actually put to.
        # It is not weightable, which the export enforces below.
        "unit": "PC_ENT_AI_EC",
        "indicators": [
            "E_AI_BCST",
            "E_AI_BLE",
            "E_AI_BDDT",
            "E_AI_BLEG",
            "E_AI_BCDP",
            "E_AI_BINC",
            "E_AI_BNU",
        ],
    },
    "foundations": {
        "section": "foundations",
        "title": "Digital foundations underneath AI",
        "unit": "PC_ENT",
        "indicators": [
            "E_DI3_GELO",
            "E_DI3_HI",
            "E_CC1_SI",
            "E_DA",
            "E_DASANY",
            "E_AWSELL",
        ],
    },
    "skills": {
        "section": "skills",
        "title": "ICT skills inside the firm",
        "unit": "PC_ENT",
        "indicators": ["E_ITSPRCR2", "E_ITSPVAC2", "E_ITT2"],
    },
}

# NACE sections the sector view uses. Deliberately only the single-letter
# sections: the source also carries aggregates (C19-C23), divisions (J61) and
# bespoke groupings (ICT, G45-S951_X_K) that overlap each other, so charting
# the full code list together would double-count. These eleven sit at one level.
SECTIONS = ["C", "D", "E", "F", "G", "H", "I", "J", "L", "M", "N"]

# Sector rows exist only for all enterprises with 10+ employees - Eurostat does
# not cross sector with size class - so this view can never carry an SME cut.
SECTOR_SIZE = "ALL_GE10"

SECTOR_CHARTS = {
    "sector_adoption": {
        "section": "gap",
        "title": "Enterprises using at least one AI technology, by sector",
        "unit": "PC_ENT",
        "indicators": ["E_AI_TANY"],
    },
    "sector_purposes": {
        "section": "purposes",
        "title": "What AI is used for, by sector",
        "unit": "PC_ENT",
        "indicators": [
            "E_AI_PMS", "E_AI_PPP", "E_AI_PBAM", "E_AI_PLOG",
            "E_AI_PITS", "E_AI_PFIN", "E_AI_PRDI",
        ],
    },
    "sector_tech": {
        "section": "tech",
        "title": "Which AI technologies, by sector",
        "unit": "PC_ENT",
        "indicators": [
            "E_AI_TML", "E_AI_TTM", "E_AI_TNLG", "E_AI_TPA",
            "E_AI_TIR", "E_AI_TSR", "E_AI_TAR", "E_AI_TPVSG",
        ],
    },
    "sector_barriers": {
        "section": "barriers",
        "title": "Why enterprises do not use AI, by sector",
        # Same reasoning as the size-class barriers chart: as a share of all
        # enterprises a barrier reads as a handful of percent, because most
        # firms never considered AI and so answered nothing.
        "unit": "PC_ENT_AI_EC",
        "indicators": [
            "E_AI_BCST", "E_AI_BLE", "E_AI_BDDT", "E_AI_BLEG",
            "E_AI_BCDP", "E_AI_BINC", "E_AI_BNU",
        ],
    },
    "sector_skills": {
        "section": "skills",
        "title": "ICT skills inside the firm, by sector",
        "unit": "PC_ENT",
        "indicators": ["E_ITSP2", "E_ITT2", "E_ITSPT2"],
    },
}

INDIVIDUAL_CHARTS = {
    "workforce": {
        "section": "skills",
        "title": "Generative AI and digital skills in the workforce",
        "unit": "PC_IND",
        "indicators": ["I_IUAI", "I_IUAIWP", "I_DSK2_BAB", "I_DSK2_AB"],
    },
}

# The individual-level breakdowns the page uses, named by their raw ind_type
# code. Eurostat packs sex, age, education, labour status and citizenship into
# this one dimension, so ind_type - not the decoded age/education columns - is
# what makes a row unique: 25 distinct ind_type codes (citizenship, labour
# status, occupation) all decode to null age AND null education, and would be
# indistinguishable if the export dropped the raw code.
INDIVIDUAL_CUTS = {
    "IND_TOTAL": {"kind": "total", "label": "All individuals aged 16-74"},
    # Disjoint age bands covering the working-age population and just beyond.
    "Y16_24": {"kind": "age", "label": "16-24"},
    "Y25_34": {"kind": "age", "label": "25-34"},
    "Y35_44": {"kind": "age", "label": "35-44"},
    "Y45_54": {"kind": "age", "label": "45-54"},
    "Y55_64": {"kind": "age", "label": "55-64"},
    "Y65_74": {"kind": "age", "label": "65-74"},
    # Education, all ages. The Y*HI/ME/LO codes crossed with an age band exist
    # too, but a single education cut keeps the chart readable.
    "I0_2": {"kind": "education", "label": "Low (ISCED 0-2)"},
    "I3_4": {"kind": "education", "label": "Medium (ISCED 3-4)"},
    "I5_8": {"kind": "education", "label": "High (ISCED 5-8)"},
}

FIRM_COLUMNS = ["geo", "time", "size_emp", "indicator", "value", "enterprise_count"]
SECTOR_COLUMNS = ["geo", "time", "nace_r2", "indicator", "value", "enterprise_count"]
INDIVIDUAL_COLUMNS = ["geo", "time", "indicator", "ind_type", "value"]


def _check_codes(df: pd.DataFrame, column: str, wanted: list[str], chart_id: str) -> None:
    """Raise naming any code the table does not contain.

    Mirrors the pipeline's fail-loudly stance: an unrecognised code is a spec
    drift, not a row to drop.
    """
    missing = sorted(set(wanted) - set(df[column].unique()))
    if missing:
        raise ValueError(
            f"chart {chart_id!r}: {column} codes not present in the table: {missing}"
        )


def _rows(df: pd.DataFrame, columns: list[str]) -> list[list]:
    """Emit rows as positional arrays - roughly half the bytes of dicts.

    The astype(object) is load-bearing: on a float column, `where` writes NaN
    back rather than None, and json.dumps would emit a bare `NaN`, which is not
    valid JSON and which JSON.parse rejects outright.
    """
    subset = df[columns].astype(object)
    return subset.where(pd.notnull(subset), None).to_numpy().tolist()


def build_firm_charts(df: pd.DataFrame, unit_codes: dict) -> tuple[dict, set[str]]:
    charts: dict[str, dict] = {}
    used_indicators: set[str] = set()

    for chart_id, spec in FIRM_CHARTS.items():
        _check_codes(df, "indicator", spec["indicators"], chart_id)
        _check_codes(df, "unit", [spec["unit"]], chart_id)

        subset = df[
            (df["indicator"].isin(spec["indicators"]))
            & (df["unit"] == spec["unit"])
            & (df["size_emp"].isin(SIZE_BANDS))
            # Sector rows carry a nace_r2; the page charts the all-sectors cut,
            # which is exactly the rows where nace_r2 is null.
            & (df["nace_r2"].isna())
        ]

        if subset.empty:
            raise ValueError(
                f"chart {chart_id!r}: no rows survived filtering "
                f"(unit={spec['unit']}, indicators={spec['indicators']})"
            )

        subset = subset.sort_values(["indicator", "geo", "time", "size_emp"])

        # enterprise_count is the denominator for PC_ENT and nothing else.
        # Shipping it beside a differently-based unit invites the page to
        # compute a weighted average that has no meaning, so it is dropped
        # rather than merely left unused.
        weightable = bool(unit_codes[spec["unit"]]["weightable"])
        if not weightable:
            subset = subset.assign(enterprise_count=None)

        charts[chart_id] = {
            "title": spec["title"],
            "section": spec["section"],
            "unit": spec["unit"],
            "base": unit_codes[spec["unit"]]["base"],
            "weightable": weightable,
            "table": "firm_level",
            "indicators": spec["indicators"],
            "columns": FIRM_COLUMNS,
            "rows": _rows(subset, FIRM_COLUMNS),
        }
        used_indicators.update(spec["indicators"])

    return charts, used_indicators


def build_sector_charts(df: pd.DataFrame, unit_codes: dict) -> tuple[dict, set[str]]:
    charts: dict[str, dict] = {}
    used_indicators: set[str] = set()

    for chart_id, spec in SECTOR_CHARTS.items():
        _check_codes(df, "indicator", spec["indicators"], chart_id)
        _check_codes(df, "unit", [spec["unit"]], chart_id)
        _check_codes(df, "nace_r2", SECTIONS, chart_id)

        subset = df[
            (df["indicator"].isin(spec["indicators"]))
            & (df["unit"] == spec["unit"])
            & (df["nace_r2"].isin(SECTIONS))
            & (df["size_emp"] == SECTOR_SIZE)
        ]

        if subset.empty:
            raise ValueError(
                f"chart {chart_id!r}: no rows survived filtering "
                f"(unit={spec['unit']}, indicators={spec['indicators']})"
            )

        subset = subset.sort_values(["indicator", "geo", "time", "nace_r2"])

        weightable = bool(unit_codes[spec["unit"]]["weightable"])
        if not weightable:
            subset = subset.assign(enterprise_count=None)

        charts[chart_id] = {
            "title": spec["title"],
            "section": spec["section"],
            "unit": spec["unit"],
            "base": unit_codes[spec["unit"]]["base"],
            "weightable": weightable,
            "table": "firm_level",
            "indicators": spec["indicators"],
            "columns": SECTOR_COLUMNS,
            "rows": _rows(subset, SECTOR_COLUMNS),
        }
        used_indicators.update(spec["indicators"])

    return charts, used_indicators


def build_individual_charts(df: pd.DataFrame) -> tuple[dict, set[str]]:
    charts: dict[str, dict] = {}
    used_indicators: set[str] = set()

    for chart_id, spec in INDIVIDUAL_CHARTS.items():
        _check_codes(df, "indicator", spec["indicators"], chart_id)
        _check_codes(df, "unit", [spec["unit"]], chart_id)
        _check_codes(df, "ind_type", list(INDIVIDUAL_CUTS), chart_id)

        subset = df[
            (df["indicator"].isin(spec["indicators"]))
            & (df["unit"] == spec["unit"])
            # Keep the national total plus the age and education cuts; drop the
            # 130-odd other ind_type breakdowns the page does not use.
            & (df["ind_type"].isin(INDIVIDUAL_CUTS))
        ]

        if subset.empty:
            raise ValueError(f"chart {chart_id!r}: no rows survived filtering")

        subset = subset.sort_values(["indicator", "geo", "time"])
        charts[chart_id] = {
            "title": spec["title"],
            "section": spec["section"],
            "unit": spec["unit"],
            # Individual-level percentages have no population count to weight
            # by at all, so every multi-country figure here is unweighted.
            "weightable": False,
            "table": "individual_level",
            "indicators": spec["indicators"],
            "columns": INDIVIDUAL_COLUMNS,
            "rows": _rows(subset, INDIVIDUAL_COLUMNS),
        }
        used_indicators.update(spec["indicators"])

    return charts, used_indicators


def build_labels(datamaps: dict[str, dict], used: dict[str, set[str]]) -> dict:
    """Slice each datamap's vocabulary down to the codes the page references."""
    firm = datamaps["firm_level"]["columns"]
    individual = datamaps["individual_level"]["columns"]

    return {
        "geo": firm["geo"]["codes"],
        "size_emp": {k: v for k, v in firm["size_emp"]["codes"].items() if k in SIZE_BANDS},
        "indicator": {
            **{k: v for k, v in firm["indicator"]["codes"].items() if k in used["firm"]},
            **{
                k: v
                for k, v in individual["indicator"]["codes"].items()
                if k in used["individual"]
            },
        },
        # Every unit a chart references, so the page can always name the base
        # population a percentage is a share of.
        "unit": {
            **{
                k: v for k, v in firm["unit"]["codes"].items()
                if k in {s["unit"] for s in (*FIRM_CHARTS.values(), *SECTOR_CHARTS.values())}
            },
            **{
                k: v for k, v in individual["unit"]["codes"].items()
                if k in {s["unit"] for s in INDIVIDUAL_CHARTS.values()}
            },
        },
        "ind_type": INDIVIDUAL_CUTS,
        "nace_r2": {k: v for k, v in firm["nace_r2"]["codes"].items() if k in SECTIONS},
    }


def build_meta(datamaps: dict[str, dict]) -> dict:
    """Carry provenance and caveats onto the page rather than leaving them in the repo."""
    return {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "disjoint_bands": DISJOINT_BANDS,
        "reference_geo": "EU27_2020",
        "tables": {
            name: {
                "rows": dm["table"]["rows"],
                "grain": dm["table"]["grain"],
                "unit_of_observation": dm["table"]["unit_of_observation"],
            }
            for name, dm in datamaps.items()
        },
        "sources": {
            name: dm["source"]["datasets"] for name, dm in datamaps.items()
        },
        "caveats": sorted(
            {c for dm in datamaps.values() for c in dm["caveats"]}
        ),
    }


def export(out_dir: Path = SITE_DATA_DIR) -> dict[str, int]:
    """Build the page-ready JSON bundle. Returns bytes written per file."""
    datamaps = {
        name: json.loads((PROCESSED_DIR / f"{name}.datamap.json").read_text(encoding="utf-8"))
        for name in ("firm_level", "individual_level")
    }
    firm = pd.read_parquet(PROCESSED_DIR / "firm_level.parquet")
    individual = pd.read_parquet(PROCESSED_DIR / "individual_level.parquet")

    unit_codes = datamaps["firm_level"]["columns"]["unit"]["codes"]
    firm_charts, firm_used = build_firm_charts(firm, unit_codes)
    sector_charts, sector_used = build_sector_charts(firm, unit_codes)
    individual_charts, individual_used = build_individual_charts(individual)

    payloads = {
        "series.json": {**firm_charts, **sector_charts, **individual_charts},
        "labels.json": build_labels(
            datamaps, {"firm": firm_used | sector_used, "individual": individual_used}
        ),
        "meta.json": build_meta(datamaps),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, int] = {}
    for filename, payload in payloads.items():
        path = out_dir / filename
        # allow_nan=False turns a stray NaN into an exception here rather than
        # a bare `NaN` token that only fails later, in the browser.
        text = json.dumps(
            payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
        path.write_text(text, encoding="utf-8")
        written[filename] = len(text.encode("utf-8"))

    return written


if __name__ == "__main__":
    for filename, size in export().items():
        print(f"{filename:14s} {size / 1024:8.1f} KB")
