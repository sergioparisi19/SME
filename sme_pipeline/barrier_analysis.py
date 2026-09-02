"""Which barriers separate high-adoption countries from low-adoption ones.

The published barrier chart says what firms *complain about*. This says which of
those complaints actually moves with the adoption gap once the year is
controlled for - a different question, and one the raw percentages cannot answer.

Design decisions, all of them forced by what the data can carry:

*Per size tier, not per country.* The variation that identifies a barrier's
effect is the variation across countries. A country-level model would have four
observations (2021, 2023, 2024, 2025) for seven predictors and is not estimable.
Each tier gets ~80 country-year cells instead.

*No maturity controls.* Only ~41 of ~83 cells carry the digital-maturity
indicators, and fitting 13 predictors plus year dummies on 41 observations is
badly overfit - measured coefficient swings of +573% between specifications.
Maturity explains as much as the barriers do where both exist, which is
consistent with it mediating them, but this sample cannot separate the two.

*Shapley, not raw coefficients.* Barriers are mildly correlated (worst VIF ~5),
so a coefficient is not a contribution. The Shapley decomposition splits the R2
the block adds beyond year effects into non-negative parts that sum to it, which
is what makes "share of the explained gap" a meaningful axis.

*A stability flag, not a filter.* The output is a ranking, so the ranking has to
survive resampling countries. Every tier is reported, but one whose leading
barrier is not reliably leading is flagged `published=False` - a caller may want
to see an undetermined ranking, but nothing should present one as settled.

Nothing here is causal. The barrier percentages are measured on the firms that
considered AI and declined, a population defined partly by the outcome, so a
positive association can be pure composition: in high-adoption countries the
firms that declined are more sophisticated and cite more sophisticated reasons.
The exported `sign` exists so the page can say so rather than imply a driver.
"""

from __future__ import annotations

import itertools
import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import PROCESSED_DIR

# The three disjoint tiers. SME_10_249 and ALL_GE10 contain these, so including
# them would put the same countries in the model twice.
TIERS = ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250"]

OUTCOME = "E_AI_TANY"
OUTCOME_UNIT = "PC_ENT"
BARRIER_UNIT = "PC_ENT_AI_EC"
BARRIERS = [
    "E_AI_BCST", "E_AI_BLE", "E_AI_BDDT", "E_AI_BLEG",
    "E_AI_BCDP", "E_AI_BINC", "E_AI_BNU",
]

# Eurostat's own labels are full sentences ("Enterprises do not use AI
# technologies, because ..."), unusable as a column value or a chart label.
SHORT_LABELS = {
    "E_AI_BCST": "Cost too high",
    "E_AI_BLE": "Lack of expertise",
    "E_AI_BDDT": "Data availability or quality",
    "E_AI_BLEG": "Legal consequences unclear",
    "E_AI_BCDP": "Privacy and data protection",
    "E_AI_BINC": "Incompatible with existing systems",
    "E_AI_BNU": "AI not useful for us",
}

TIER_LABELS = {
    "SMALL_10_49": "Small (10-49)",
    "MEDIUM_50_249": "Medium (50-249)",
    "LARGE_GE250": "Large (250+)",
}

# A tier is published only if its leading barrier leads in at least this share
# of bootstrap draws. Measured: small 1.00, medium 0.93, large 0.47 - so large
# is withheld, its top place being a three-way tie.
STABILITY_THRESHOLD = 0.60
BOOTSTRAP_DRAWS = 400
SEED = 7

# Seven predictors need more than a handful of rows to mean anything. A single
# survey year leaves roughly one cell per reporting country, which is above this
# floor but close to it - hence the gate, not a promise.
MIN_CELLS = 20


# The composite row is a plain mean of the modelled countries, so it needs a
# name of its own - it is not a place.
ALL_MEAN = "ALL_MEAN"
ALL_MEAN_LABEL = "All countries (unweighted mean)"


def geo_labels() -> dict[str, str]:
    """Country names, read from the datamap that ships beside the Parquet."""
    path = PROCESSED_DIR / "firm_level.datamap.json"
    if not path.exists():
        return {}
    codes = json.loads(path.read_text(encoding="utf-8"))["columns"]["geo"]["codes"]
    return {**codes, ALL_MEAN: ALL_MEAN_LABEL}


def _panel(df: pd.DataFrame, tier: str, years: list[str] | None = None) -> pd.DataFrame:
    """One row per country-year: the seven barriers and the adoption rate.

    Restricting to a single year drops the panel from ~83 cells to roughly the
    number of reporting countries. That is estimable but thin, and the year
    dummies collapse to nothing, so the baseline becomes an intercept and the
    reported R2 is the whole of what the barriers explain rather than what they
    add. The stability gate is what decides whether the result survives it.
    """
    rows = df[df["nace_r2"].isna() & (df["geo"] != "EU27_2020") & (df["size_emp"] == tier)]
    if years:
        rows = rows[rows["time"].isin(years)]
    outcome = (rows[(rows["indicator"] == OUTCOME) & (rows["unit"] == OUTCOME_UNIT)]
               .set_index(["geo", "time"])["value"].rename("y"))
    barriers = (rows[(rows["indicator"].isin(BARRIERS)) & (rows["unit"] == BARRIER_UNIT)]
                .pivot_table(index=["geo", "time"], columns="indicator", values="value"))
    panel = barriers.join(outcome, how="inner").reset_index()
    return panel.dropna(subset=BARRIERS + ["y"])


def _eu_exposure(df: pd.DataFrame, tier: str) -> dict[str, float]:
    """How widely each barrier is cited EU-wide, as a reference for the shares."""
    rows = df[df["nace_r2"].isna() & (df["geo"] == "EU27_2020") & (df["size_emp"] == tier)
              & (df["unit"] == BARRIER_UNIT) & (df["indicator"].isin(BARRIERS))]
    if rows.empty:
        return {}
    latest = rows[rows["time"] == rows["time"].max()]
    return {r.indicator: round(float(r.value), 1) for r in latest.itertuples()}


def _prepare(panel: pd.DataFrame):
    """Absorb the year effects once, then work in NumPy.

    Frisch-Waugh-Lovell: residualising the outcome and every barrier on the year
    dummies once gives subset regressions numerically identical to refitting with
    the dummies each time, and turns 128 rebuilt pandas design matrices per
    sample into 128 small least-squares solves. It is the difference between a
    two-minute build and a two-second one.
    """
    y = panel["y"].to_numpy(dtype=float)
    dummies = pd.get_dummies(panel["time"], drop_first=True).astype(float).to_numpy()
    fixed = np.column_stack([np.ones(len(panel)), dummies])
    q, _ = np.linalg.qr(fixed)

    resid_y = y - q @ (q.T @ y)
    resid_x = panel[BARRIERS].to_numpy(dtype=float)
    resid_x = resid_x - q @ (q.T @ resid_x)
    return resid_y, resid_x, float(((y - y.mean()) ** 2).sum()), float(resid_y @ resid_y)


def _rss(resid_y, resid_x, columns) -> float:
    if not columns:
        return float(resid_y @ resid_y)
    block = resid_x[:, list(columns)]
    beta, *_ = np.linalg.lstsq(block, resid_y, rcond=None)
    resid = resid_y - block @ beta
    return float(resid @ resid)


def _shapley(resid_y, resid_x, total_ss, base_rss):
    """Split the R2 the barrier block adds into per-barrier contributions.

    Averages each barrier's marginal contribution over every ordering, which for
    seven predictors means 2**7 subset regressions - cheap, and unlike a single
    coefficient it is not distorted by the correlation between barriers.
    """
    k = len(BARRIERS)
    cache = {}

    def added(subset):
        key = tuple(sorted(subset))
        if key not in cache:
            cache[key] = (base_rss - _rss(resid_y, resid_x, key)) / total_ss
        return cache[key]

    contributions = {code: 0.0 for code in BARRIERS}
    for own, code in enumerate(BARRIERS):
        others = [i for i in range(k) if i != own]
        for size in range(k):
            weight = math.factorial(size) * math.factorial(k - size - 1) / math.factorial(k)
            for combo in itertools.combinations(others, size):
                contributions[code] += weight * (added(combo + (own,)) - added(combo))
    return contributions, added(tuple(range(k)))


def _bootstrap(panel: pd.DataFrame, draws: int, seed: int) -> dict:
    """Resample whole countries and see whether the ranking holds.

    Countries, not rows: the four years of one country are not independent
    observations, so resampling rows would understate the uncertainty.
    """
    rng = np.random.default_rng(seed)
    geos = panel["geo"].unique()
    by_geo = {g: panel[panel["geo"] == g] for g in geos}
    first_place = {code: 0 for code in BARRIERS}
    shares: dict[str, list[float]] = {code: [] for code in BARRIERS}

    completed = 0
    for _ in range(draws):
        pick = rng.choice(geos, size=len(geos), replace=True)
        sample = pd.concat([by_geo[g] for g in pick], ignore_index=True)
        try:
            contributions, total = _shapley(*_prepare(sample))
        except np.linalg.LinAlgError:
            continue
        if not (total > 0):
            continue
        completed += 1
        for code, value in contributions.items():
            shares[code].append(100.0 * value / total)
        first_place[max(contributions, key=contributions.get)] += 1

    if not completed:
        return {"draws": 0, "lead_share": 0.0, "first_place": {}, "interval": {}}

    return {
        "draws": completed,
        "lead_share": max(first_place.values()) / completed,
        "first_place": {c: n / completed for c, n in first_place.items()},
        "interval": {
            c: [round(float(np.percentile(v, 5)), 1), round(float(np.percentile(v, 95)), 1)]
            for c, v in shares.items() if v
        },
    }


def _fit(panel: pd.DataFrame):
    """Full model in one go - coefficients, fitted values and per-year context.

    The Shapley step works on residualised arrays because it refits 128 times;
    this is fitted once, directly, because the decomposition needs the
    coefficients themselves rather than a variance split.

    The year effect is recovered as `fitted - X . beta` rather than by reading
    dummy coefficients, which keeps it independent of how get_dummies happens to
    order or drop its columns - and gives a value for any year, so a row that was
    not in the sample can still be scored.
    """
    dummies = pd.get_dummies(panel["time"], drop_first=True).astype(float).to_numpy()
    x = panel[BARRIERS].to_numpy(dtype=float)
    design = np.column_stack([np.ones(len(panel)), dummies, x])
    y = panel["y"].to_numpy(dtype=float)
    beta, *_ = np.linalg.lstsq(design, y, rcond=None)
    fitted = design @ beta

    context = fitted - x @ beta[-len(BARRIERS):]
    by_year = pd.Series(context, index=panel["time"].to_numpy()).groupby(level=0).mean()
    return dict(zip(BARRIERS, beta[-len(BARRIERS):])), fitted, context, by_year.to_dict()


def _aggregate_targets(df: pd.DataFrame, tier: str, panel: pd.DataFrame) -> pd.DataFrame:  # noqa: D401
    """Rows to score but never to fit: EU27, and an all-countries composite.

    Neither can be fitted - an aggregate is a single row per year, not a sample -
    but both can be read through the tier model, which is what makes the question
    "how does the EU27 gap decompose" answerable at all.

    EU27 is Eurostat's own published aggregate, weighted by how many enterprises
    each country has. The composite is a plain mean of the countries actually in
    the model. The two differ, and that difference is the weighting, not noise.
    """
    rows = df[df["nace_r2"].isna() & (df["size_emp"] == tier)]
    years = sorted(panel["time"].unique())

    eu = (rows[(rows["geo"] == "EU27_2020") & (rows["unit"] == BARRIER_UNIT)
               & (rows["indicator"].isin(BARRIERS))]
          .pivot_table(index="time", columns="indicator", values="value"))
    eu_y = (rows[(rows["geo"] == "EU27_2020") & (rows["unit"] == OUTCOME_UNIT)
                 & (rows["indicator"] == OUTCOME)]
            .set_index("time")["value"])

    frames = []
    for year in years:
        if year in eu.index and year in eu_y.index and eu.loc[year].notna().all():
            frames.append({"geo": "EU27_2020", "time": year, "y": float(eu_y[year]),
                           **{c: float(eu.loc[year, c]) for c in BARRIERS}})
        block = panel[panel["time"] == year]
        if len(block):
            frames.append({"geo": "ALL_MEAN", "time": year, "y": float(block["y"].mean()),
                           **{c: float(block[c].mean()) for c in BARRIERS}})
    return pd.DataFrame(frames)


def by_country(df: pd.DataFrame, labels: dict[str, str] | None = None,
               years: list[str] | None = None, latest_only: bool = True) -> pd.DataFrame:
    """Split each country's adoption gap into per-barrier contributions.

    This is NOT a model per country. A country has four observations - 2021,
    2023, 2024, 2025 - against seven predictors, so a country-level model is not
    estimable and never will be with this data. What is estimable is the tier
    model applied to a country: the gap between a country's actual adoption and
    what the model expects of a country with average barrier levels that year,
    split into the part each barrier accounts for.

    Two aggregate rows are scored the same way and marked `in_model = False`:
    EU27_2020, Eurostat's published aggregate, and ALL_MEAN, a plain mean of the
    countries in the model. Neither is fitted - an aggregate is one row per year,
    not a sample - and EU27 in particular must stay out of the fit, being a
    weighted combination of the very rows it would sit beside.

        expected_i    = intercept + year effect + (mean barriers) . beta
        contribution  = beta_j * (country's barrier_j - the tier mean)
        actual_i      = expected_i + sum(contributions) + residual_i

    The residual is what the barriers do not explain, and it is reported rather
    than hidden so the contributions cannot be mistaken for the whole story.

    Fitting and reporting are separated on purpose. The model uses every year it
    is given, because that is where the coefficients come from and the barrier
    slopes need all the variation there is. The output defaults to the latest
    year alone: a country's position three years ago is history, and carrying
    four years of it quadruples the file for rows nobody reads. Pass
    `latest_only=False` for the lot.
    """
    names = geo_labels() if labels is None else labels
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    frames = []
    for tier in TIERS:
        panel = _panel(df, tier, years)
        if len(panel) < MIN_CELLS:
            continue
        beta, fitted, context, context_by_year = _fit(panel)
        resid_y, resid_x, total_ss, base_rss = _prepare(panel)
        delta_r2 = round(
            (base_rss - _rss(resid_y, resid_x, tuple(range(len(BARRIERS))))) / total_ss, 3)
        means = panel[BARRIERS].mean()
        offset = float((means * pd.Series(beta)).sum())

        extra = _aggregate_targets(df, tier, panel)
        targets = [(panel, True)] + ([(extra, False)] if len(extra) else [])

        # Fitted on every year above; reported on the most recent one here. The
        # newest year is taken per tier rather than globally - nothing guarantees
        # every tier ends on the same survey wave.
        if latest_only:
            newest = panel["time"].max()
            targets = [(block[block["time"] == newest], flag) for block, flag in targets]
            targets = [(block, flag) for block, flag in targets if len(block)]

        for block, in_model in targets:
            x = block[BARRIERS].to_numpy(dtype=float)
            # Always mapped by year rather than reused from the fit: the block
            # may have been filtered to one year, and the context is constant
            # within a year anyway, so the two agree by construction.
            ctx = block["time"].map(context_by_year).to_numpy(dtype=float)
            actual = block["y"].to_numpy(dtype=float)
            # What the model expects of an average-barrier unit in that year.
            expected = ctx + offset
            predicted = ctx + x @ np.array([beta[c] for c in BARRIERS])
            residual = actual - predicted

            for code in BARRIERS:
                deviation = block[code].to_numpy(dtype=float) - means[code]
                geos = block["geo"].to_numpy()
                frames.append(pd.DataFrame({
                    "country": [names.get(g, g) for g in geos],
                    "geo": geos,
                    "tier": TIER_LABELS.get(tier, tier),
                    "tier_code": tier,
                    "year": block["time"].to_numpy(),
                    "in_model": in_model,
                    "barrier": [SHORT_LABELS.get(code, code)] * len(block),
                    "barrier_code": code,
                    "exposure_pct": block[code].to_numpy(dtype=float).round(1),
                    "tier_mean_pct": round(float(means[code]), 1),
                    "deviation_pp": deviation.round(1),
                    "coefficient": round(float(beta[code]), 4),
                    "contribution_pp": (beta[code] * deviation).round(2),
                    "actual_adoption_pct": actual.round(1),
                    "expected_adoption_pct": expected.round(1),
                    "gap_pp": (actual - expected).round(1),
                    "unexplained_pp": residual.round(2),
                    # Model context, repeated on every row so a filtered export
                    # still says what it was fitted on.
                    "tier_n_cells": len(panel),
                    "tier_n_countries": int(panel["geo"].nunique()),
                    "tier_delta_r2": delta_r2,
                    "outcome_code": OUTCOME,
                    "outcome_unit": OUTCOME_UNIT,
                    "exposure_unit": BARRIER_UNIT,
                    "generated_utc": stamp,
                }))
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)

    # Which barrier moves this country's gap most, regardless of direction.
    out["rank_in_unit"] = (out.groupby(["tier_code", "geo", "year"])["contribution_pp"]
                           .transform(lambda v: v.abs().rank(ascending=False, method="first"))
                           .astype(int))
    return out.sort_values(["tier_code", "country", "year", "rank_in_unit"]).reset_index(drop=True)


def analyse(df: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS, seed: int = SEED,
            years: list[str] | None = None) -> dict:
    """Run the decomposition for every tier, flagging which ones hold up."""
    tiers: dict[str, dict] = {}

    for tier in TIERS:
        panel = _panel(df, tier, years)
        if len(panel) < MIN_CELLS:
            continue

        resid_y, resid_x, total_ss, base_rss = _prepare(panel)
        contributions, added = _shapley(resid_y, resid_x, total_ss, base_rss)
        if not (added > 0):
            continue
        corr = panel[BARRIERS].corrwith(panel["y"])
        eu = _eu_exposure(df, tier)
        beta, *_ = _fit(panel)
        boot = _bootstrap(panel, draws, seed)

        # Adjusted R2 is the honest statistic when the panel is short: seven
        # predictors on ~22 rows inflate the raw figure considerably, and a
        # single-year run is exactly that case.
        n_obs = len(panel)
        n_params = len(BARRIERS) + panel["time"].nunique()   # barriers + year effects
        raw = 1 - _rss(resid_y, resid_x, tuple(range(len(BARRIERS)))) / total_ss
        adjusted = (1 - (1 - raw) * (n_obs - 1) / (n_obs - n_params - 1)
                    if n_obs > n_params + 1 else float("nan"))

        tiers[tier] = {
            "published": boot["lead_share"] >= STABILITY_THRESHOLD,
            "n": int(n_obs),
            "countries": int(panel["geo"].nunique()),
            "years": sorted(panel["time"].unique().tolist()),
            "r2_years_only": round(1 - base_rss / total_ss, 3),
            "r2_with_barriers": round(raw, 3),
            "r2_adjusted": round(adjusted, 3),
            "delta_r2": round(added, 3),
            "lead_share": round(boot["lead_share"], 3),
            "barriers": {
                code: {
                    "share": round(100.0 * value / added, 1),
                    "interval": boot["interval"].get(code),
                    "first_place": round(boot["first_place"].get(code, 0.0), 3),
                    # Two directions, because they can disagree and one
                    # column would hide it. `corr` is the raw one-at-a-time
                    # correlation; `coefficient` holds the other six barriers
                    # and the year fixed. Where predictors are correlated the
                    # marginal and partial signs can genuinely differ - legal
                    # uncertainty correlates positively with adoption on its own
                    # (richer countries have both), but negatively once the rest
                    # is held constant. The Shapley share beside these comes
                    # from the multivariate model, so `coefficient` is the one
                    # that belongs with it.
                    "sign": -1 if corr[code] < 0 else 1,
                    "corr": round(float(corr[code]), 2),
                    "coefficient": round(float(beta[code]), 4),
                    "sign_in_model": -1 if beta[code] < 0 else 1,
                    "exposure_eu27": eu.get(code),
                }
                for code, value in contributions.items()
            },
        }

    return {
        "kind": "importance",
        "outcome": OUTCOME,
        "outcome_unit": OUTCOME_UNIT,
        "exposure_unit": BARRIER_UNIT,
        "indicators": BARRIERS,
        "stability_threshold": STABILITY_THRESHOLD,
        "years": sorted(years) if years else "all",
        "tiers": tiers,
    }
