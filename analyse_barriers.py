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
    direction_in_model, coefficient       the barrier's sign once the other six
                                          and the year are held constant - the
                                          model the share comes from
    direction_marginal, corr_with_adoption
                                          the sign one barrier at a time. These
                                          two can disagree, and in 9 of 21 rows
                                          they do: a barrier can correlate with
                                          adoption on its own and work against
                                          it once the others are controlled
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

from sme_pipeline import barrier_analysis, load
from sme_pipeline.config import PROCESSED_DIR, PROJECT_ROOT

DEFAULT_OUT = PROJECT_ROOT / "data" / "analysis" / "barrier_importance.csv"

FIELDS = [
    "tier", "tier_code", "rank", "barrier", "barrier_full", "barrier_code",
    "share_pct", "ci_low_pct", "ci_high_pct", "first_place_rate",
    "direction_in_model", "coefficient", "direction_marginal", "corr_with_adoption",
    "tier_mean_pct", "exposure_eu27_pct",
    "n_cells", "n_countries", "years",
    "r2_years_only", "r2_with_barriers", "r2_adjusted", "delta_r2",
    "lead_share", "stability_threshold", "bootstrap_draws", "tier_published",
    "outcome_code", "outcome_unit", "exposure_unit", "generated_utc",
]

# Prose for each FIELDS column, reused verbatim in the Parquet datamap below and
# kept beside FIELDS so the two can't drift apart from one another.
COLUMN_NOTES = {
    "tier": "Size tier label.",
    "tier_code": "Size tier code (SMALL_10_49, MEDIUM_50_249, LARGE_GE250) - the three disjoint bands the model is fit on.",
    "rank": "The barrier's rank within its tier, 1 = largest Shapley share.",
    "barrier": "Short barrier label.",
    "barrier_full": "Eurostat's own full wording for the barrier.",
    "barrier_code": "Eurostat indicator code for the barrier (unit PC_ENT_AI_EC).",
    "share_pct": "The barrier's share of the R2 the barrier block adds beyond year effects. Shares sum to 100 within a tier.",
    "ci_low_pct": "5th percentile of share_pct across bootstrap draws (whole countries resampled).",
    "ci_high_pct": "95th percentile of share_pct across bootstrap draws.",
    "first_place_rate": "Share of bootstrap draws in which this barrier ranked first in its tier.",
    "direction_in_model": "Sign of the barrier's coefficient with the other six barriers and the year held constant.",
    "coefficient": "The barrier's OLS coefficient in the fitted multivariate model - the one share_pct is decomposed from.",
    "direction_marginal": "Sign of the barrier's raw, one-at-a-time correlation with adoption. Can disagree with direction_in_model.",
    "corr_with_adoption": "Raw correlation between the barrier and the adoption rate, one barrier at a time.",
    "tier_mean_pct": "The barrier's mean citation rate across the tier's country-year panel - the reference point contributions are measured from.",
    "exposure_eu27_pct": "How widely the barrier is cited EU-wide (Eurostat's own EU27 aggregate), for context beside the share.",
    "n_cells": "Country-year cells the tier's model was fit on.",
    "n_countries": "Distinct countries in the tier's fitted panel.",
    "years": "Survey years in the tier's fitted panel, space-separated.",
    "r2_years_only": "R2 of a model with year effects only, no barriers.",
    "r2_with_barriers": "R2 of the full model (year effects + all seven barriers).",
    "r2_adjusted": "r2_with_barriers, adjusted for the number of parameters relative to n_cells.",
    "delta_r2": "r2_with_barriers minus r2_years_only - what the barrier block adds beyond year effects. What share_pct is a share of.",
    "lead_share": "Share of bootstrap draws in which this tier's actual top barrier led.",
    "stability_threshold": "lead_share must meet or exceed this for tier_published to be true.",
    "bootstrap_draws": "Number of country-resampled bootstrap draws the model was validated on.",
    "tier_published": "False where the tier's leading barrier is not reliably leading across bootstrap draws - the ranking should not be presented as settled.",
    "outcome_code": "Eurostat indicator code for the outcome (AI adoption).",
    "outcome_unit": "Unit the outcome is measured in (share of all enterprises).",
    "exposure_unit": "Unit the barriers are measured in (share of enterprises that considered AI).",
    "generated_utc": "When this row was generated.",
}

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
                "direction_in_model": ("against adoption" if b["sign_in_model"] == -1
                                       else "with adoption"),
                "coefficient": b["coefficient"],
                "direction_marginal": ("against adoption" if b["sign"] == -1
                                       else "with adoption"),
                "corr_with_adoption": b["corr"],
                "tier_mean_pct": model["tier_means"][code],
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


def write_parquet_artifact(result: dict, rows: list[dict], draws: int, seed: int,
                            out_dir: Path) -> None:
    """Write the self-describing Parquet counterpart to barrier_importance.csv.

    This is the artifact the site export reads to build the dashboard's
    barrier-importance section - it deliberately does not reuse
    sme_pipeline.datamap.build_one(), which is wired to the ICT-survey tables'
    own column vocabulary (geo, size_emp, indicator, unit...) and would need
    that vocabulary stretched to cover an unrelated table shape. This builds a
    small datamap of its own instead, in the same spirit: self-describing,
    with the caveats carried on the artifact rather than left in the repo.

    Only called for the full, unrestricted panel (`--years` omitted) - the site
    always scores against the all-years-pooled model, never a year-restricted
    diagnostic run (see the module docstring for why pooling is the more
    stable choice here).
    """
    df = pd.DataFrame(rows)[FIELDS]
    datamap = {
        "datamap_version": "1.0",
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "table": {
            "name": "barrier_importance",
            "file": "barrier_importance.parquet",
            "unit_of_observation": "one size tier crossed with one AI-adoption barrier",
            "grain": "tier_code x barrier_code",
            "rows": int(len(df)),
            "primary_key": ["tier_code", "barrier_code"],
        },
        "source": {
            "provider": "Eurostat (derived)",
            "method": (
                "Shapley decomposition of the R2 a 7-barrier OLS block adds to E_AI_TANY "
                "beyond year effects, fit per size tier on the country-year panel, "
                "validated by resampling whole countries."
            ),
            "script": "analyse_barriers.py, sme_pipeline/barrier_analysis.py",
            "bootstrap_draws": draws,
            "seed": seed,
            "stability_threshold": barrier_analysis.STABILITY_THRESHOLD,
        },
        "columns": {name: {"note": note} for name, note in COLUMN_NOTES.items()},
        # Per-tier year effect, keyed by tier then year - doesn't fit the flat
        # tier x barrier grain above, so it lives here rather than as a
        # repeated JSON-in-cell column on every row of the Parquet table.
        "model_context_by_year": {
            tier: model["context_by_year"] for tier, model in result["tiers"].items()
        },
        "caveats": [
            "Association, not causation: the barrier percentages are measured only on "
            "firms that considered AI and declined, a population partly defined by the "
            "outcome itself. A positive association can be pure composition rather than "
            "a driver.",
            "tier_published is false where the tier's leading barrier is not reliably "
            "leading across bootstrap draws - do not present that tier's ranking as "
            "settled.",
        ],
    }
    load.write_table(df, "barrier_importance", processed_dir=out_dir)
    load.write_datamap(datamap, "barrier_importance", processed_dir=out_dir)


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

    # The Parquet artifact is what the site export reads; only the full,
    # unrestricted panel is a fit the site should ever show.
    if args.years is None:
        write_parquet_artifact(result, rows, args.draws, args.seed, args.out_dir)
        print(f"Wrote {args.out_dir / 'barrier_importance.parquet'} "
              f"(+ .datamap.json) for the site export\n")
    for tier, model in result["tiers"].items():
        flag = "" if model["published"] else "   <- ranking NOT stable across draws"
        lead = max(model["barriers"].items(), key=lambda kv: kv[1]["share"])
        print(f"  {TIER_NAMES.get(tier, tier):18s} n={model['n']:3d}  "
              f"dR2={model['delta_r2']:.3f}  leads {model['lead_share']:.0%} of draws: "
              f"{names.get(lead[0], lead[0])[:44]}{flag}")


if __name__ == "__main__":
    main()
