"""Stage 2 - turn raw JSON-stat into a tidy DataFrame (one row per observation)."""

import json

import pandas as pd
from pyjstat import pyjstat

from . import config


class ParseError(RuntimeError):
    """Raised when a response cannot be parsed into the expected shape."""


def to_tidy(raw, drop_empty=True):
    """Parse one raw JSON-stat response into a long/tidy DataFrame.

    `naming="id"` is essential. pyjstat defaults to naming="label", which
    returns human-readable text ("From 0 to 1 person employed", "European Union
    - 27 countries (from 2020)") in place of the short codes (0_1, EU27_2020)
    that every join in this pipeline depends on.
    """
    try:
        dataset = pyjstat.Dataset.read(json.dumps(raw))
        df = dataset.write("dataframe", naming="id")
    except Exception as exc:  # pyjstat raises a variety of types on bad input
        raise ParseError(f"could not parse JSON-stat response: {exc}") from exc

    if "value" not in df.columns:
        raise ParseError(f"parsed frame has no 'value' column (columns: {list(df.columns)})")

    df = df.drop(columns=[c for c in config.CONSTANT_DIMS if c in df.columns])

    if drop_empty:
        # JSON-stat materialises the full dimension cross-product, so most rows
        # are empty - e.g. the ICT surveys list sub-10-employee size bands but
        # never sample them. Dropping them here keeps the outputs to real
        # observations only.
        df = df[df["value"].notna()].reset_index(drop=True)

    return df


def to_tidy_chunks(chunks, drop_empty=True):
    """Parse a dataset's chunks into one tidy DataFrame.

    Large scopes are fetched as several geo slices (see extract.py). Each slice
    is a self-contained JSON-stat document, so they are parsed independently and
    stacked - far simpler and safer than trying to merge JSON-stat's flat value
    index across documents.
    """
    frames = [to_tidy(chunk, drop_empty=drop_empty) for chunk in chunks]
    if not frames:
        raise ParseError("no chunks to parse")
    if len(frames) == 1:
        return frames[0]
    return pd.concat(frames, ignore_index=True)


def to_tidy_all(raw_by_code, drop_empty=True):
    """Parse every fetched dataset, returning {code: tidy DataFrame}."""
    return {
        code: to_tidy_chunks(chunks, drop_empty=drop_empty)
        for code, chunks in raw_by_code.items()
    }


def extract_labels(raw):
    """Pull the code -> human-readable label dictionaries out of one response.

    Returns {dimension: {code: label}}. Parsing with naming="id" gives short
    codes that can be joined but say nothing to a reader; these are the labels
    that make them meaningful again, and they are the raw material for the
    datamap.
    """
    labels = {}
    for dimension, meta in raw.get("dimension", {}).items():
        category_labels = meta.get("category", {}).get("label")
        if category_labels:
            labels[dimension] = dict(category_labels)
    return labels


def merge_labels(raw_by_code):
    """Merge the label dictionaries of every response into one vocabulary.

    Verified across all seven source datasets: no code carries conflicting
    labels between tables, so a plain merge is safe and needs no tie-breaking.
    """
    vocabulary = {}
    for chunks in raw_by_code.values():
        for chunk in chunks:
            for dimension, labels in extract_labels(chunk).items():
                vocabulary.setdefault(dimension, {}).update(labels)
    return vocabulary


def check_key_unique(df, key, label=""):
    """Return the number of duplicate rows on `key`, for pipeline assertions."""
    present = [c for c in key if c in df.columns]
    missing = [c for c in key if c not in df.columns]
    if missing:
        raise ParseError(f"{label}: expected key columns missing from frame: {missing}")
    return int(df.duplicated(subset=present).sum())
