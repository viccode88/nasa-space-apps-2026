"""Fetch the current year (2026) from the FIRMS area API.

Usage:  python pipeline/01b_download_current_year.py [region ...]

Needs a free FIRMS MAP_KEY in the environment variable FIRMS_MAP_KEY, or in a
`.env` file at the repository root (never committed).

Annual country files stop at 2025. For 2026 the area API returns every
detection inside a bounding box, so results are clipped to the country
polygons (Natural Earth 1:10m). Standard-processing (SP) data is used while it
exists, near-real-time (NRT) data after that.

Output: data/raw/<product>/<product>_2026_region-<region>.csv
        data/raw/api/current_year.json   (cut-off date and NRT start dates)
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pandas as pd
import shapely

from common import RAW, REGIONS, ROOT, region_polygon

API = "https://firms.modaps.eosdis.nasa.gov/api"
YEAR = 2026
SOURCES = {"modis": "MODIS", "viirs-snpp": "VIIRS_SNPP", "viirs-jpss1": "VIIRS_NOAA20"}
CHUNK_DAYS = 5  # API maximum per request


def map_key() -> str:
    key = os.environ.get("FIRMS_MAP_KEY", "")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        sys.exit("FIRMS_MAP_KEY is not set (environment variable or .env file)")
    return key


def get(url: str) -> str:
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=180) as resp:
                text = resp.read().decode()
            if text.lstrip().startswith("<") or "Exceeding allowed" in text[:200]:
                raise RuntimeError("API refused the request (limit or error page)")
            return text
        except Exception as err:  # never echo the URL: it contains the key
            last = type(err).__name__
            time.sleep(60 * (attempt + 1))
    raise RuntimeError(f"FIRMS request failed after retries ({last})")


def throttle(key: str, need: int = 1500) -> None:
    """Wait until the key has room for `need` more transactions (5000 per 10 minutes)."""
    while True:
        try:
            with urllib.request.urlopen(
                    f"https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={key}",
                    timeout=60) as resp:
                st = json.loads(resp.read().decode())
            if st["current_transactions"] + need <= st["transaction_limit"]:
                return
        except Exception:
            pass
        time.sleep(30)


def availability(key: str) -> dict[str, tuple[date, date]]:
    df = pd.read_csv(io.StringIO(get(f"{API}/data_availability/csv/{key}/all")))
    return {r.data_id: (date.fromisoformat(r.min_date), date.fromisoformat(r.max_date))
            for r in df.itertuples()}


def chunks(start: date, end: date):
    d = start
    while d <= end:
        n = min(CHUNK_DAYS, (end - d).days + 1)
        yield d, n
        d += timedelta(days=n)


def fetch_chunk(key, source, region, bbox, day, n) -> pd.DataFrame:
    cache = RAW / "api" / source / region / f"{day}_{n}.csv"
    if not cache.exists():
        area = ",".join(str(v) for v in bbox)
        text = get(f"{API}/area/csv/{key}/{source}/{area}/{n}/{day}")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text)
    try:
        return pd.read_csv(cache, dtype={"confidence": str, "satellite": str, "version": str})
    except pd.errors.EmptyDataError:
        return pd.DataFrame()


def clip(df: pd.DataFrame, poly) -> pd.DataFrame:
    if df.empty:
        return df
    inside = shapely.contains_xy(poly, df.longitude.to_numpy(), df.latitude.to_numpy())
    return df[inside]


def fetch_region(key, region, avail, through: date) -> dict:
    poly = region_polygon(region)
    bbox = REGIONS[region]["bbox"]
    counts = {}
    for product, src in SOURCES.items():
        sp_end = avail[f"{src}_SP"][1]
        nrt_end = min(avail[f"{src}_NRT"][1], through)
        jobs = [(f"{src}_SP", d, n) for d, n in chunks(date(YEAR, 1, 1), min(sp_end, through))
                if sp_end >= date(YEAR, 1, 1)]
        jobs += [(f"{src}_NRT", d, n)
                 for d, n in chunks(max(sp_end + timedelta(days=1), date(YEAR, 1, 1)), nrt_end)]
        throttle(key)
        with ThreadPoolExecutor(max_workers=4) as pool:
            frames = list(pool.map(
                lambda j: clip(fetch_chunk(key, j[0], region, bbox, j[1], j[2]), poly), jobs))
        frames = [f for f in frames if not f.empty]
        dest = RAW / product / f"{product}_{YEAR}_region-{region}.csv"
        dest.parent.mkdir(parents=True, exist_ok=True)
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        df.to_csv(dest, index=False)  # NRT rows have an empty `type`
        counts[product] = len(df)
        print(f"{region} {product}: {len(df):,} detections in {len(jobs)} requests", flush=True)
    return counts


def main():
    key = map_key()
    avail = availability(key)
    # The latest day is still filling in, so the cut-off is the day before.
    through = avail["VIIRS_NOAA20_NRT"][1] - timedelta(days=1)
    for region in sys.argv[1:] or list(REGIONS):
        fetch_region(key, region, avail, through)
    info = {"year": YEAR, "data_through": str(through),
            "nrt_start": {p: str(avail[f"{s}_SP"][1] + timedelta(days=1))
                          for p, s in SOURCES.items()},
            "sensor_end": {p: str(avail[f"{s}_NRT"][1]) for p, s in SOURCES.items()}}
    (RAW / "api").mkdir(parents=True, exist_ok=True)
    (RAW / "api" / "current_year.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info))


if __name__ == "__main__":
    main()
