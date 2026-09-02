"""Offline analysis: which barriers separate high-adoption countries from low ones.

Deliberately not part of the site build. The result is a ranked association, and
one of its findings - that the most-cited barrier is not the one that
distinguishes countries, because a barrier can be cited MORE where adoption is
higher - is easy to misread as a recommendation. It lives here, as a CSV to read
and argue with, rather than on a page where a quadrant chart would settle the
argument for the reader.

    python analyse_barriers.py               # writes both CSVs to data/analysis/
    python analyse_barriers.py --years 2025  # fit on one survey year only
    python analyse_barriers.py --every-year  # by-country file keeps all years
    python analyse_barriers.py --draws 1000  # tighter bootstrap intervals, slower
    python analyse_barriers.py --out-dir somewhere/

Two files come out.

`barrier_importance.csv` - one row per size tier and barrier: which barriers
separate high-adoption countries from low-adoption ones, and how firmly.

Country names are carried on both files, and every row repeats the model context
it came from, so a filtered export still says what it was fitted on.

`barrier_contributions_by_country.csv` - the same model read country by country:
each country's actual adoption, what the model expects of a country with average
barrier levels that year, and how much of the difference each barrier accounts
for. This is not a model per country - four observations against seven
predictors is not estimable - and the unexplained remainder is reported so the
contributions cannot be mistaken for the whole gap.

Fitting and reporting are separate. The model always uses every year it is given,
because that is where the coefficients come from; the file reports the latest
year only, since a country's position three years ago is history. `--every-year`
emits the lot.

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
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from sme_pipeline import barrier_analysis
from sme_pipeline.config import PROCESSED_DIR, PROJECT_ROOT

DEFAULT_OUT = PROJECT_ROOT / "data" / "analysis" / "barrier_importance.csv"

FIELDS = [
    "tier", "tier_code", "rank", "barrier", "barrier_full", "barrier_code",
    "share_pct", "ci_low_pct", "ci_high_pct", "first_place_rate",
    "direction", "corr_with_adoption", "exposure_eu27_pct",
    "n_cells", "n_countries", "years",
    "r2_years_only", "r2_with_barriers", "r2_adjusted", "delta_r2",
    "lead_share", "stability_threshold", "bootstrap_draws", "tier_published",
    "outcome_code", "outcome_unit", "exposure_unit", "generated_utc",
]

TIER_NAMES = barrier_analysis.TIER_LABELS


def rows_from(result: dict, labels: dict[str, str], draws: int | None = None) -> list[dict]:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out: list[dict] = []
    for tier, model in result["tiers"].items():
        ranked = sorted(model["barriers"].items(), key=lambda kv: -kv[1]["share"])
        for rank, (code, b) in enumerate(ranked, start=1):
            interval = b.get("interval") or [None, None]
            out.append({
                "tier": TIER_NAMES.get(tier, tier),
                "tier_code": tier,
                "rank": rank,
                "barrier": barrier_analysis.SHORT_LABELS.get(code, code),
                "barrier_full": labels.get(code, code),
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
                "r2_years_only": model["r2_years_only"],
                "r2_with_barriers": model["r2_with_barriers"],
                "r2_adjusted": model["r2_adjusted"],
                "delta_r2": model["delta_r2"],
                "lead_share": model["lead_share"],
                "stability_threshold": result["stability_threshold"],
                "bootstrap_draws": draws,
                "tier_published": model["published"],
                "outcome_code": result["outcome"],
                "outcome_unit": result["outcome_unit"],
                "exposure_unit": result["exposure_unit"],
                "generated_utc": stamp,
            })
    return out


def enrich_country(country: pd.DataFrame, result: dict) -> pd.DataFrame:
    """Carry the stability verdict onto the per-country rows.

    `by_country` deliberately does not bootstrap - it reads coefficients, not a
    ranking, and re-running 400 draws to label a row would triple its cost. But
    someone reading contributions for a tier whose ranking did not survive
    resampling should be told, so the runner joins the verdict on here, where it
    is already known.
    """
    stable = {tier: model["published"] for tier, model in result["tiers"].items()}
    out = country.copy()
    out["tier_ranking_stable"] = out["tier_code"].map(stable)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--draws", type=int, default=barrier_analysis.BOOTSTRAP_DRAWS)
    parser.add_argument("--seed", type=int, default=barrier_analysis.SEED)
    parser.add_argument("--years", nargs="+", default=None,
                        help="restrict the MODEL to these survey years, e.g. --years 2025")
    parser.add_argument("--every-year", action="store_true",
                        help="emit every year in the by-country file, not just the latest")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT.parent)
    args = parser.parse_args()

    firm = pd.read_parquet(PROCESSED_DIR / "firm_level.parquet")
    import json
    labels = json.loads((PROCESSED_DIR / "firm_level.datamap.json").read_text(encoding="utf-8"))
    names = labels["columns"]["indicator"]["codes"]

    scope = " ".join(args.years) if args.years else "all years"
    print(f"Fitting {len(barrier_analysis.TIERS)} tier models on {scope}, "
          f"{args.draws} bootstrap draws each...")
    result = barrier_analysis.analyse(firm, draws=args.draws, seed=args.seed,
                                      years=args.years)
    rows = rows_from(result, names, draws=args.draws)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    # A year-restricted run writes its own files rather than overwriting the
    # full-panel result - the two answer different questions and both are worth
    # keeping side by side.
    suffix = f"_{'_'.join(args.years)}" if args.years else ""
    summary_path = args.out_dir / f"barrier_importance{suffix}.csv"
    country_path = args.out_dir / f"barrier_contributions_by_country{suffix}.csv"

    # Windows locks a CSV that is open in Excel or an editor, and losing a
    # 9-second run to a file handle is a poor trade - say which file, and why.
    for path in (summary_path, country_path):
        try:
            path.open("a").close()
        except PermissionError:
            raise SystemExit(
                f"Cannot write {path.name} - it is open in another program. "
                "Close it and run again."
            )

    with summary_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    country = enrich_country(
        barrier_analysis.by_country(firm, years=args.years,
                                    latest_only=not args.every_year),
        result)
    country.to_csv(country_path, index=False, encoding="utf-8")

    print(f"\nWrote {len(rows)} rows to {summary_path}")
    print(f"Wrote {len(country)} rows to {country_path} "
          f"({country.geo.nunique()} countries)\n")
    for tier, model in result["tiers"].items():
        flag = "" if model["published"] else "   <- ranking NOT stable across draws"
        lead = max(model["barriers"].items(), key=lambda kv: kv[1]["share"])
        print(f"  {TIER_NAMES.get(tier, tier):18s} n={model['n']:3d}  "
              f"dR2={model['delta_r2']:.3f}  leads {model['lead_share']:.0%} of draws: "
              f"{names.get(lead[0], lead[0])[:44]}{flag}")


if __name__ == "__main__":
    main()
