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

*A stability gate.* The output is a ranking, so the ranking has to survive
resampling countries. Tiers whose leading barrier is not reliably leading are
withheld rather than published with a caveat - a quadrant chart makes an
undetermined ranking look authoritative, which is the failure mode to avoid.

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


def analyse(df: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS, seed: int = SEED) -> dict:
    """Run the decomposition for every tier and keep the ones that hold up."""
    tiers: dict[str, dict] = {}
    withheld: dict[str, float] = {}

    for tier in TIERS:
        panel = _panel(df, tier)
        if len(panel) < 40:
            continue

        resid_y, resid_x, total_ss, base_rss = _prepare(panel)
        contributions, added = _shapley(resid_y, resid_x, total_ss, base_rss)
        if not (added > 0):
            continue
        corr = panel[BARRIERS].corrwith(panel["y"])
        boot = _bootstrap(panel, draws, seed)

        if boot["lead_share"] < STABILITY_THRESHOLD:
            withheld[tier] = round(boot["lead_share"], 3)
            continue

        tiers[tier] = {
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
        "withheld": withheld,
    }
