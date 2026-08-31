"""Dataset registry, filesystem paths, and canonical vocabularies.

Everything here is declarative - no I/O, no transformation logic - so the rest
of the pipeline has a single place to look up "what are we pulling, and what do
the codes mean".
"""

from dataclasses import dataclass, field
from pathlib import Path

# Paths are anchored to the repo root, not the current working directory, so the
# pipeline behaves the same whether it is run from the repo, a notebook, or a
# scheduled job elsewhere on disk.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = PROJECT_ROOT / "data" / "raw"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"

API_BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"

# Every country carried by BOTH the indicator datasets and the enterprise-count
# universe, verified against the live API. Anything outside this set would yield
# percentages with no denominator. EA and TR appear in the surveys but not in the
# universe; CH and IS are the reverse - all four are excluded to keep the scope
# coherent country by country.
EU27 = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR",
    "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]
# Non-EU reporters that are nonetheless complete on both sides, kept as comparators.
NON_EU_REPORTERS = ["NO", "AL", "BA", "ME", "MK", "RS"]

DEFAULT_GEO = ["EU27_2020"] + EU27 + NON_EU_REPORTERS

# A quick scope for development runs: pass --geo with these to iterate faster.
DEV_GEO = ["IT", "DE", "EU27_2020"]

# Dimension present in every dataset but constant ("A" = annual), so it carries
# no information and is dropped during parsing.
CONSTANT_DIMS = ["freq"]


# --- Dataset registry -------------------------------------------------------

# How a dataset contributes to the final tables.
LEVEL_UNIVERSE = "universe"      # enterprise counts (the denominator table)
LEVEL_FIRM_SIZE = "firm_size"    # firm indicators broken down by size class
LEVEL_FIRM_SECTOR = "firm_sector"  # firm indicators broken down by NACE sector
LEVEL_INDIVIDUAL = "individual"  # person-level indicators (separate table)


@dataclass(frozen=True)
class DatasetSpec:
    """One Eurostat table and how the pipeline should treat it."""

    code: str
    level: str
    description: str
    # Extra API query params, e.g. pinning a dimension to cut response size.
    extra_params: dict = field(default_factory=dict)

    @property
    def browser_url(self):
        return f"https://ec.europa.eu/eurostat/databrowser/view/{self.code}/default/table?lang=en"


DATASETS = [
    DatasetSpec(
        code="sbs_sc_ovw",
        level=LEVEL_UNIVERSE,
        description="Enterprise counts by size class and NACE Rev. 2 (universe/denominator table)",
        # sbs_sc_ovw carries 34 SBS indicators (turnover, wages, ...) but this
        # project only needs enterprise counts. Requesting all of them exceeds
        # the API's response size limit (HTTP 413) for more than one geo/time.
        extra_params={"indic_sbs": "ENT_NR"},
    ),
    DatasetSpec(
        code="isoc_eb_ai",
        level=LEVEL_FIRM_SIZE,
        description="AI use by size class of enterprise (also carries AI-adoption barrier indicators)",
    ),
    DatasetSpec(
        code="isoc_eb_das",
        level=LEVEL_FIRM_SIZE,
        description="Data analytics by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_e_dii",
        level=LEVEL_FIRM_SIZE,
        description="Digital Intensity Index by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_ske_itrcrs",
        level=LEVEL_FIRM_SIZE,
        description="Recruitment of ICT specialists and hard-to-fill vacancies by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_cisce_ra",
        level=LEVEL_FIRM_SIZE,
        description="ICT security policy, measures, risks and staff awareness by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_cicce_use",
        level=LEVEL_FIRM_SIZE,
        description="Cloud computing services by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_ciweb",
        level=LEVEL_FIRM_SIZE,
        description="Websites and their functionalities by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_cismt",
        level=LEVEL_FIRM_SIZE,
        description="Social media use and internet advertising by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_eb_ics",
        level=LEVEL_FIRM_SIZE,
        description="Integration with customers/suppliers and supply chain management by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_ec_esels",
        level=LEVEL_FIRM_SIZE,
        description="E-commerce sales of enterprises by size class of enterprise",
    ),
    DatasetSpec(
        code="isoc_eb_ain2",
        level=LEVEL_FIRM_SECTOR,
        description="AI use by NACE Rev. 2 activity",
    ),
    DatasetSpec(
        code="isoc_ske_ittn2",
        level=LEVEL_FIRM_SECTOR,
        description="Enterprises providing ICT skills training by NACE Rev. 2 activity (10+ employees only)",
    ),
    DatasetSpec(
        code="isoc_ci_it_en2",
        level=LEVEL_FIRM_SECTOR,
        description="Type of internet connection by NACE Rev. 2 activity",
    ),
    DatasetSpec(
        code="isoc_ske_itspen2",
        level=LEVEL_FIRM_SECTOR,
        description="Enterprises that employ ICT specialists by NACE Rev. 2 activity",
    ),
    DatasetSpec(
        code="isoc_ai_iaiu",
        level=LEVEL_INDIVIDUAL,
        description="Individuals' use of generative AI tools",
    ),
    DatasetSpec(
        code="isoc_sk_dskl_i21",
        level=LEVEL_INDIVIDUAL,
        description="Individuals' level of digital skills (2021 onwards)",
    ),
]

DATASETS_BY_CODE = {spec.code: spec for spec in DATASETS}


def datasets_at_level(*levels):
    return [spec for spec in DATASETS if spec.level in levels]


# --- Keys -------------------------------------------------------------------

# Verified empirically (explore_data.ipynb): these yield zero duplicate rows.
# `unit` is load-bearing - isoc_eb_ai reports six distinct metrics that share an
# indic_is code and differ only by unit. Dropping it fans out every join.
FIRM_KEY = ["geo", "time", "size_emp", "nace_r2", "indic_is", "unit"]
INDIVIDUAL_KEY = ["geo", "time", "indic_is", "unit", "ind_type"]
UNIVERSE_KEY = ["geo", "time", "size_emp", "nace_r2"]

# Keys of the *output* tables. These differ from the source keys above because
# indic_is and unit are combined into a single `indicator` column, and rows from
# several source tables are stacked together (hence `dataset`).
FIRM_TABLE_KEY = ["geo", "time", "size_emp", "nace_r2", "indicator", "dataset"]
INDIVIDUAL_TABLE_KEY = ["geo", "time", "indicator", "ind_type", "dataset"]


# --- NACE totals ------------------------------------------------------------

# These two "all sectors" codes are different populations, not different labels
# for the same thing (see DATA_PIPELINE_SPEC.md, Caveat 2).
NACE_TOTAL_SBS = "B-S_X_O_S94"        # SBS business economy: sections B-S excl. O, S94
NACE_TOTAL_ICT = "C10-S951_X_K"       # ICT survey population: C10-S95.1 excl. K


# --- Canonical size classes -------------------------------------------------

# Maps raw Eurostat size_emp codes -> canonical names used across output tables.
# Both source families are covered; unknown codes are a hard error at normalize
# time rather than a silent drop.
SIZE_EMP_CANONICAL = {
    "0_1": "MICRO_0_1",
    "1-4": "MICRO_1_4",
    "2-9": "MICRO_2_9",
    "5-9": "MICRO_5_9",
    "1-9": "MICRO_1_9",
    "0-9": "MICRO_0_9",
    "10-19": "SMALL_10_19",
    "20-49": "SMALL_20_49",
    "10-49": "SMALL_10_49",
    "50-249": "MEDIUM_50_249",
    "10-249": "SME_10_249",
    "GE10": "ALL_GE10",
    "GE250": "LARGE_GE250",
    "TOTAL": "TOTAL",
}

# Canonical bands the SBS universe does not publish directly, derived by summing
# the finer bands it does publish. Enterprise counts are additive, so this is a
# valid reconstruction (unlike averaging percentages).
SIZE_EMP_DERIVED = {
    "SMALL_10_49": ["SMALL_10_19", "SMALL_20_49"],
    "SME_10_249": ["SMALL_10_19", "SMALL_20_49", "MEDIUM_50_249"],
    "ALL_GE10": ["SMALL_10_19", "SMALL_20_49", "MEDIUM_50_249", "LARGE_GE250"],
}

# The size classes that make up the headline SME-vs-large comparison.
SME_CLASSES = ["SMALL_10_49", "MEDIUM_50_249", "SME_10_249"]
LARGE_CLASS = "LARGE_GE250"
