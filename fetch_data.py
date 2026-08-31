"""CLI entry point for the SME Digital & AI Readiness Index data pipeline.

The pipeline itself lives in the `sme_pipeline` package, one module per stage.
See DATA_PIPELINE_SPEC.md for the data contract.

    python fetch_data.py                          # dev scope (IT, DE, EU27_2020)
    python fetch_data.py --geo IT DE FR --refresh # wider scope, ignore cache
    python fetch_data.py --no-write               # dry run, no files written
"""

import argparse

from sme_pipeline import config, pipeline


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--geo", nargs="*", default=config.DEFAULT_GEO, help="Country codes to fetch (default: a small dev scope).")
    parser.add_argument("--time", nargs="*", default=None, help="Years to fetch (default: whatever the API returns).")
    parser.add_argument("--refresh", action="store_true", help="Ignore the cache and re-fetch from the API.")
    parser.add_argument("--no-write", dest="write", action="store_false", help="Run without writing output files.")
    args = parser.parse_args()

    pipeline.run(geo=args.geo, time=args.time, refresh=args.refresh, write=args.write)


if __name__ == "__main__":
    main()
