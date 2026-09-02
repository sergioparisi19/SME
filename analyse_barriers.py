"""Offline analysis: which barriers separate high-adoption countries from low ones.

Deliberately not part of the site build. The result is a ranked association, and
one of its findings - that the most-cited barrier is not the one that
distinguishes countries, because a barrier can be cited MORE where adoption is
higher - is easy to misread as a recommendation. It lives here, as a CSV to read
and argue with, rather than on a page where a quadrant chart would settle the
argument for the reader.

    python analyse_barriers.py                    # writes data/analysis/barrier_importance.csv
    python analyse_barriers.py --draws 1000       # tighter bootstrap intervals, slower
    python analyse_barriers.py --out results.csv

Columns, one row per size tier and barrier, ranked within tier:

    tier, rank, barrier, share_pct        the barrier's share of the R2 the block
                                          adds beyond year effects - shares sum
                                          to 100 within a tier
    ci_low_pct, ci_high_pct               90% bootstrap interval, resampling
                                          whole countries
    first_place_rate                      how often it ranked first across draws
    direction                             "against adoption" is a barrier acting
                                          like one; "with adoption" is a
                                          composition effect and not a driver
    corr_with_adoption                    the raw correlation behind that
    exposure_eu27_pct                     how widely it is cited EU-wide
    n_cells, n_countries, delta_r2        what the model was fitted on, and how
                                          much it explains beyond year effects
    tier_published                        False where the leading barrier is not
                                          reliably leading across draws
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import pandas as pd

from sme_pipeline import barrier_analysis
from sme_pipeline.config import PROCESSED_DIR, PROJECT_ROOT

DEFAULT_OUT = PROJECT_ROOT / "data" / "analysis" / "barrier_importance.csv"

FIELDS = [
    "tier", "rank", "barrier", "barrier_code", "share_pct",
    "ci_low_pct", "ci_high_pct", "first_place_rate",
    "direction", "corr_with_adoption", "exposure_eu27_pct",
    "n_cells", "n_countries", "years", "delta_r2", "lead_share", "tier_published",
]

TIER_NAMES = {
    "SMALL_10_49": "Small (10-49)",
    "MEDIUM_50_249": "Medium (50-249)",
    "LARGE_GE250": "Large (250+)",
}


def rows_from(result: dict, labels: dict[str, str]) -> list[dict]:
    out: list[dict] = []
    for tier, model in result["tiers"].items():
        ranked = sorted(model["barriers"].items(), key=lambda kv: -kv[1]["share"])
        for rank, (code, b) in enumerate(ranked, start=1):
            interval = b.get("interval") or [None, None]
            out.append({
                "tier": TIER_NAMES.get(tier, tier),
                "rank": rank,
                "barrier": labels.get(code, code),
                "barrier_code": code,
                "share_pct": b["share"],
                "ci_low_pct": interval[0],
                "ci_high_pct": interval[1],
                "first_place_rate": b["first_place"],
                "direction": "against adoption" if b["sign"] == -1 else "with adoption",
                "corr_with_adoption": b["corr"],
                "exposure_eu27_pct": b.get("exposure_eu27"),
                "n_cells": model["n"],
                "n_countries": model["countries"],
                "years": " ".join(model["years"]),
                "delta_r2": model["delta_r2"],
                "lead_share": model["lead_share"],
                "tier_published": model["published"],
            })
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--draws", type=int, default=barrier_analysis.BOOTSTRAP_DRAWS)
    parser.add_argument("--seed", type=int, default=barrier_analysis.SEED)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    firm = pd.read_parquet(PROCESSED_DIR / "firm_level.parquet")
    import json
    labels = json.loads((PROCESSED_DIR / "firm_level.datamap.json").read_text(encoding="utf-8"))
    names = labels["columns"]["indicator"]["codes"]

    print(f"Fitting {len(barrier_analysis.TIERS)} tier models, {args.draws} bootstrap draws each...")
    result = barrier_analysis.analyse(firm, draws=args.draws, seed=args.seed)
    rows = rows_from(result, names)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nWrote {len(rows)} rows to {args.out}\n")
    for tier, model in result["tiers"].items():
        flag = "" if model["published"] else "   <- ranking NOT stable across draws"
        lead = max(model["barriers"].items(), key=lambda kv: kv[1]["share"])
        print(f"  {TIER_NAMES.get(tier, tier):18s} n={model['n']:3d}  "
              f"dR2={model['delta_r2']:.3f}  leads {model['lead_share']:.0%} of draws: "
              f"{names.get(lead[0], lead[0])[:44]}{flag}")


if __name__ == "__main__":
    main()
