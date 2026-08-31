"""Stage 5 - write the finished tables and their datamap to disk.

Parquet is the canonical artifact: typed, compact, and already dictionary-encoded
internally, so the short string codes cost nothing to store. `datamap.json` is
the companion data dictionary that explains those codes - it is written to be
read, so it is indented and keeps non-ASCII characters intact.

The row-level JSON dumps this stage used to emit were removed: at dev scope they
reached 9.8 MB, too heavy to fetch in a page or commit monthly, and they carried
nothing the Parquet did not already hold. A curated per-chart export will replace
them when the portal's charts are designed.
"""

import json

from . import config


def write_table(df, name, processed_dir=None):
    """Write one table as Parquet. Returns the path written."""
    processed_dir = processed_dir or config.PROCESSED_DIR
    processed_dir.mkdir(parents=True, exist_ok=True)

    path = processed_dir / f"{name}.parquet"
    df.to_parquet(path, index=False)
    return path


def write_datamap(datamap, name, processed_dir=None):
    """Write one table's datamap as indented, human-readable JSON.

    Named `{table}.datamap.json` so it sorts directly beside the Parquet file it
    describes.
    """
    processed_dir = processed_dir or config.PROCESSED_DIR
    processed_dir.mkdir(parents=True, exist_ok=True)

    path = processed_dir / f"{name}.datamap.json"
    path.write_text(
        json.dumps(datamap, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def write_outputs(firm_table, individual_table, datamaps, processed_dir=None):
    """Write each table with its own datamap, returning {name: path}."""
    tables = {"firm_level": firm_table, "individual_level": individual_table}

    written = {}
    for name, df in tables.items():
        written[name] = write_table(df, name, processed_dir)
        written[f"{name}.datamap"] = write_datamap(datamaps[name], name, processed_dir)
    return written
