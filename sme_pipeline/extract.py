"""Stage 1 - fetch raw JSON-stat from the Eurostat API and cache it to disk.

Two behaviours worth knowing about:

*Cache keying* - the cache stores the request alongside the response, so a cached
file is only reused when it was fetched with the same query. Changing --geo or
--time re-fetches instead of silently returning the previous scope's data.

*Chunking* - Eurostat caps response size and answers HTTP 413 when a query is too
broad. At full country scope some datasets (isoc_eb_ain2, isoc_ec_esels) exceed
it. Rather than hard-coding a safe batch size per dataset, a 413 makes the fetch
split its geo list in half and retry each part, recursively. Small datasets stay
a single request; only the ones that actually need splitting pay for it.
"""

import json
import time as time_module

import requests

from . import config


class ExtractError(RuntimeError):
    """Raised when a dataset cannot be fetched."""


class ResponseTooLarge(ExtractError):
    """The API refused the query as too broad (HTTP 413)."""


def _cache_path(code):
    return config.RAW_DIR / f"{code}.json"


def _build_params(spec, geo=None, time=None):
    params = {"format": "JSON", "lang": "EN"}
    if geo:
        params["geo"] = list(geo)
    if time:
        params["time"] = list(time)
    params.update(spec.extra_params)
    return params


def _read_cache(code, params):
    """Return the cached chunks, or None on a miss or a stale/legacy entry."""
    path = _cache_path(code)
    if not path.exists():
        return None

    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None

    # Entries written before the cache stored its request (or its chunks) are
    # unusable: we cannot tell what scope they cover, so treat them as a miss.
    if not isinstance(cached, dict) or "request" not in cached or "chunks" not in cached:
        return None
    if cached["request"] != params:
        return None
    return cached["chunks"]


def _write_cache(code, params, chunks):
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"request": params, "chunks": chunks}
    _cache_path(code).write_text(json.dumps(payload), encoding="utf-8")


def _request(spec, params):
    """One API call. Raises ResponseTooLarge on 413 so the caller can split."""
    try:
        response = requests.get(f"{config.API_BASE}/{spec.code}", params=params, timeout=180)
    except requests.RequestException as exc:
        raise ExtractError(f"{spec.code}: {exc}") from exc

    if response.status_code == 413:
        raise ResponseTooLarge(f"{spec.code}: response too large for this scope")
    if not response.ok:
        raise ExtractError(f"{spec.code}: HTTP {response.status_code}")

    return response.json()


def _fetch_chunked(spec, geos, time, verbose=True):
    """Fetch `geos`, halving the list and retrying whenever the API says 413."""
    params = _build_params(spec, geo=geos, time=time)
    try:
        return [_request(spec, params)]
    except ResponseTooLarge:
        if not geos or len(geos) == 1:
            raise  # cannot split further - the single geo is genuinely too big
        middle = len(geos) // 2
        if verbose:
            print(f"    too large for {len(geos)} geos, splitting into {middle} + {len(geos) - middle}")
        time_module.sleep(0.5)
        left = _fetch_chunked(spec, geos[:middle], time, verbose)
        time_module.sleep(0.5)
        right = _fetch_chunked(spec, geos[middle:], time, verbose)
        return left + right


def fetch_dataset(spec, geo=None, time=None, refresh=False, verbose=True):
    """Fetch one dataset, returning (chunks, was_cached).

    `chunks` is a list of raw JSON-stat responses - one element for most
    datasets, several for those that had to be split.
    """
    params = _build_params(spec, geo=geo, time=time)

    if not refresh:
        cached = _read_cache(spec.code, params)
        if cached is not None:
            return cached, True

    chunks = _fetch_chunked(spec, list(geo) if geo else [], time, verbose)
    _write_cache(spec.code, params, chunks)
    return chunks, False


def fetch_all(specs, geo=None, time=None, refresh=False, verbose=True):
    """Fetch every dataset in `specs`, returning {code: [raw JSON-stat, ...]}.

    A failure on the universe table is fatal - every firm-level percentage is
    joined against it, so continuing would silently produce a table with no
    denominators.
    """
    raw = {}
    for spec in specs:
        if verbose:
            print(f"Fetching {spec.code} ({spec.description})...")
        try:
            chunks, was_cached = fetch_dataset(
                spec, geo=geo, time=time, refresh=refresh, verbose=verbose
            )
        except ExtractError as exc:
            if spec.level == config.LEVEL_UNIVERSE:
                raise
            print(f"  FAILED (skipping): {exc}")
            continue

        raw[spec.code] = chunks
        if verbose:
            source = "cached" if was_cached else "fetched"
            cells = sum(len(c.get("value", {})) for c in chunks)
            part = f", {len(chunks)} chunks" if len(chunks) > 1 else ""
            print(f"  OK ({source}) - {cells:,} value cells{part}")
        if not was_cached:
            time_module.sleep(0.5)  # be polite to Eurostat's API

    return raw
