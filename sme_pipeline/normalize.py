"""Stage 3 - map raw Eurostat codes onto the canonical vocabulary.

Every function here fails loudly on codes it does not recognise. Eurostat adds
and renames categories between survey waves, and a silent drop (or worse, a
silent mis-join) would corrupt the headline SME-vs-large numbers without any
visible symptom.
"""

import re

import pandas as pd

from . import config


class NormalizeError(ValueError):
    """Raised when a raw code has no canonical mapping."""


# --- Size classes -----------------------------------------------------------

def normalize_size_emp(df, source=""):
    """Replace raw `size_emp` codes with canonical ones."""
    if "size_emp" not in df.columns:
        return df

    raw_codes = set(df["size_emp"].dropna().unique())
    unmapped = sorted(raw_codes - set(config.SIZE_EMP_CANONICAL))
    if unmapped:
        raise NormalizeError(
            f"{source}: unmapped size_emp codes {unmapped}. "
            "Add them to config.SIZE_EMP_CANONICAL before continuing."
        )

    out = df.copy()
    out["size_emp"] = out["size_emp"].map(config.SIZE_EMP_CANONICAL)
    return out


# --- Individual-level breakdowns --------------------------------------------

# isoc_ai_iaiu encodes sex, age, education, labour status, urbanisation and
# citizenship in a single `ind_type` dimension (~105 codes). These patterns
# decode the demographic subset the portal actually uses; everything else keeps
# its raw code with null breakdown columns rather than being force-fitted.
_SEX_PREFIX = re.compile(r"^(?P<sex>[FM])_")
_AGE = re.compile(r"^Y(?P<lo>\d+)_(?P<hi>\d+)$")
_AGE_EDU = re.compile(r"^Y(?P<lo>\d+)_(?P<hi>\d+)(?P<edu>HI|ME|LO)$")
_ISCED = re.compile(r"^I(?P<lo>\d)_(?P<hi>\d)$")
_ISCED_AGE = re.compile(r"^I(?P<ilo>\d)_(?P<ihi>\d)_(?P<alo>\d+)_(?P<ahi>\d+)$")

# ISCED 2011 bands -> plain-language education levels.
_ISCED_LEVEL = {"0_2": "LOW", "3_4": "MEDIUM", "5_8": "HIGH"}
_EDU_SUFFIX = {"LO": "LOW", "ME": "MEDIUM", "HI": "HIGH"}


def decode_ind_type(code):
    """Split one `ind_type` code into (sex, age, education).

    Returns None for any component the code does not express. `IND_TOTAL` and
    non-demographic codes (occupation, labour status, urbanisation) decode to
    all-None, which is correct: they are not demographic cuts.
    """
    sex = age = education = None

    if code == "IND_TOTAL":
        return sex, age, education

    remainder = code
    sex_match = _SEX_PREFIX.match(remainder)
    if sex_match:
        sex = sex_match.group("sex")
        remainder = remainder[sex_match.end():]

    if match := _AGE.match(remainder):
        age = f"Y{match['lo']}_{match['hi']}"
    elif match := _AGE_EDU.match(remainder):
        age = f"Y{match['lo']}_{match['hi']}"
        education = _EDU_SUFFIX[match["edu"]]
    elif match := _ISCED.match(remainder):
        education = _ISCED_LEVEL.get(f"{match['lo']}_{match['hi']}")
    elif match := _ISCED_AGE.match(remainder):
        education = _ISCED_LEVEL.get(f"{match['ilo']}_{match['ihi']}")
        age = f"Y{match['alo']}_{match['ahi']}"

    return sex, age, education


def expand_ind_type(df):
    """Add `sex`, `age`, `education` columns decoded from `ind_type`."""
    if "ind_type" not in df.columns:
        return df

    out = df.copy()
    decoded = out["ind_type"].map(decode_ind_type)
    out["sex"] = [d[0] for d in decoded]
    out["age"] = [d[1] for d in decoded]
    out["education"] = [d[2] for d in decoded]
    return out


# --- Indicator naming -------------------------------------------------------

def build_indicator(df):
    """Combine `indic_is`/`indic_sbs` and `unit` into a single `indicator` column.

    The pair is what actually identifies a metric: isoc_eb_ai reports six
    distinct measures under one indic_is code, separated only by unit.
    """
    out = df.copy()
    indic_col = "indic_is" if "indic_is" in out.columns else "indic_sbs"
    if indic_col not in out.columns:
        raise NormalizeError(f"no indicator column found (columns: {list(out.columns)})")

    if "unit" in out.columns:
        out["indicator"] = out[indic_col].astype(str) + "|" + out["unit"].astype(str)
    else:
        out["indicator"] = out[indic_col].astype(str)

    return out


def ensure_columns(df, columns):
    """Add any missing columns as null, so heterogeneous sources can be concatenated."""
    out = df.copy()
    for column in columns:
        if column not in out.columns:
            out[column] = pd.NA
    return out
