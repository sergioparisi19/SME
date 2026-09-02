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
import math

import numpy as np
import pandas as pd

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


def _panel(df: pd.DataFrame, tier: str) -> pd.DataFrame:
    """One row per country-year: the seven barriers and the adoption rate."""
    rows = df[df["nace_r2"].isna() & (df["geo"] != "EU27_2020") & (df["size_emp"] == tier)]
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


def _fit(panel: pd.DataFrame) -> tuple[dict[str, float], np.ndarray, np.ndarray]:
    """Full model in one go - coefficients, fitted values and year effects.

    The Shapley step works on residualised arrays because it refits 128 times;
    this is fitted once, directly, because the decomposition needs the
    coefficients themselves rather than a variance split.
    """
    dummies = pd.get_dummies(panel["time"], drop_first=True).astype(float).to_numpy()
    x = panel[BARRIERS].to_numpy(dtype=float)
    design = np.column_stack([np.ones(len(panel)), dummies, x])
    y = panel["y"].to_numpy(dtype=float)
    beta, *_ = np.linalg.lstsq(design, y, rcond=None)
    fitted = design @ beta
    # The non-barrier part: intercept plus this row's year effect.
    context = np.column_stack([np.ones(len(panel)), dummies]) @ beta[: 1 + dummies.shape[1]]
    return dict(zip(BARRIERS, beta[-len(BARRIERS):])), fitted, context


def by_country(df: pd.DataFrame) -> pd.DataFrame:
    """Split each country's adoption gap into per-barrier contributions.

    This is NOT a model per country. A country has four observations - 2021,
    2023, 2024, 2025 - against seven predictors, so a country-level model is not
    estimable and never will be with this data. What is estimable is the tier
    model applied to a country: the gap between a country's actual adoption and
    what the model expects of a country with average barrier levels that year,
    split into the part each barrier accounts for.

        expected_i    = intercept + year effect + (mean barriers) . beta
        contribution  = beta_j * (country's barrier_j - the tier mean)
        actual_i      = expected_i + sum(contributions) + residual_i

    The residual is what the barriers do not explain, and it is reported rather
    than hidden so the contributions cannot be mistaken for the whole story.
    """
    frames = []
    for tier in TIERS:
        panel = _panel(df, tier)
        if len(panel) < 40:
            continue
        beta, fitted, context = _fit(panel)
        means = panel[BARRIERS].mean()
        # What the model expects of an average-barrier country in that year.
        expected = context + float((means * pd.Series(beta)).sum())
        actual = panel["y"].to_numpy(dtype=float)
        residual = actual - fitted

        for j, code in enumerate(BARRIERS):
            deviation = panel[code].to_numpy(dtype=float) - means[code]
            frames.append(pd.DataFrame({
                "tier": TIER_LABELS.get(tier, tier),
                "tier_code": tier,
                "geo": panel["geo"].to_numpy(),
                "year": panel["time"].to_numpy(),
                "barrier": [SHORT_LABELS.get(code, code)] * len(panel),
                "barrier_code": code,
                "exposure_pct": panel[code].to_numpy(dtype=float).round(1),
                "tier_mean_pct": round(float(means[code]), 1),
                "deviation_pp": (deviation).round(1),
                "coefficient": round(float(beta[code]), 4),
                "contribution_pp": (beta[code] * deviation).round(2),
                "actual_adoption_pct": actual.round(1),
                "expected_adoption_pct": expected.round(1),
                "gap_pp": (actual - expected).round(1),
                "unexplained_pp": residual.round(2),
            }))
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    return out.sort_values(["tier_code", "geo", "year", "barrier_code"]).reset_index(drop=True)


def analyse(df: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS, seed: int = SEED) -> dict:
    """Run the decomposition for every tier, flagging which ones hold up."""
    tiers: dict[str, dict] = {}

    for tier in TIERS:
        panel = _panel(df, tier)
        if len(panel) < 40:
            continue

        resid_y, resid_x, total_ss, base_rss = _prepare(panel)
        contributions, added = _shapley(resid_y, resid_x, total_ss, base_rss)
        if not (added > 0):
            continue
        corr = panel[BARRIERS].corrwith(panel["y"])
        eu = _eu_exposure(df, tier)
        boot = _bootstrap(panel, draws, seed)

        tiers[tier] = {
            "published": boot["lead_share"] >= STABILITY_THRESHOLD,
            "n": int(len(panel)),
            "countries": int(panel["geo"].nunique()),
            "years": sorted(panel["time"].unique().tolist()),
            "r2_years_only": round(1 - base_rss / total_ss, 3),
            "r2_with_barriers": round(
                1 - _rss(resid_y, resid_x, tuple(range(len(BARRIERS)))) / total_ss, 3),
            "delta_r2": round(added, 3),
            "lead_share": round(boot["lead_share"], 3),
            "barriers": {
                code: {
                    "share": round(100.0 * value / added, 1),
                    "interval": boot["interval"].get(code),
                    "first_place": round(boot["first_place"].get(code, 0.0), 3),
                    # -1 where the barrier moves against adoption, as a barrier
                    # should. +1 marks the composition effect: more firms citing
                    # it where adoption is HIGHER, which is not a driver.
                    "sign": -1 if corr[code] < 0 else 1,
                    "corr": round(float(corr[code]), 2),
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
        "tiers": tiers,
    }
