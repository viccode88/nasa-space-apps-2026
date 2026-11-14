"""Download FIRMS per-country annual CSV files (standard processing, 2002-2025).

Usage:  python pipeline/01_download.py [region ...]

Files already on disk are skipped. No MAP_KEY is needed for these files.
Data for the current year is not published as annual files; see README.
"""
from __future__ import annotations

import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from common import FIRMS_COUNTRY_URL, PRODUCTS, RAW, REGIONS


def jobs(regions):
    for region in regions:
        for country in REGIONS[region]["countries"]:
            for product, (_, _, first, last) in PRODUCTS.items():
                for year in range(first, last + 1):
                    url = FIRMS_COUNTRY_URL.format(product=product, year=year, country=country)
                    yield url, RAW / product / f"{product}_{year}_{country}.csv"


def fetch(job):
    url, dest = job
    if dest.exists() and dest.stat().st_size > 0:
        return "skip", dest, 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            tmp.rename(dest)
            return "ok", dest, dest.stat().st_size
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return "missing", dest, 0
            last = err
        except Exception as err:  # network hiccup: retry
            last = err
    tmp.unlink(missing_ok=True)
    return f"failed ({last})", dest, 0


def main():
    regions = sys.argv[1:] or list(REGIONS)
    todo = list(jobs(regions))
    total = 0
    bad = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for status, dest, size in pool.map(fetch, todo):
            total += size
            if status not in ("ok", "skip"):
                bad.append((status, dest.name))
            if status != "skip":
                print(f"{status:8s} {dest.name}  {size / 1e6:.1f} MB", flush=True)
    print(f"{len(todo)} files checked, {total / 1e6:.0f} MB downloaded, {len(bad)} problems")
    for status, name in bad:
        print("  ", status, name)
    if any(s.startswith("failed") for s, _ in bad):
        sys.exit(1)


if __name__ == "__main__":
    main()
