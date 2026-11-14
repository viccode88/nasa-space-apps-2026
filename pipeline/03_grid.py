"""Aggregate cleaned hotspots to 0.1 degree cells per UTC day (spec 4.4).

Usage:  python pipeline/03_grid.py [region ...]

Output: data/work/grid/<region>_<sensor>.parquet with one row per cell-day:
        gx, gy, date, hs (hotspot count), nrt
"""
from __future__ import annotations

import sys

import pandas as pd

from common import REGIONS, SENSORS, WORK, grid_index


def grid_region(region: str) -> None:
    out_dir = WORK / "grid"
    out_dir.mkdir(parents=True, exist_ok=True)
    for sensor in SENSORS:
        parts = []
        for path in sorted((WORK / "clean").glob(f"{region}_{sensor}_*.parquet")):
            df = pd.read_parquet(path, columns=["latitude", "longitude", "acq_date", "nrt"])
            df["gx"] = grid_index(df.longitude)
            df["gy"] = grid_index(df.latitude)
            parts.append(df.groupby(["gx", "gy", "acq_date"], sort=False)
                           .agg(hs=("nrt", "size"), nrt=("nrt", "max")).reset_index())
        if not parts:
            continue
        daily = (pd.concat(parts).groupby(["gx", "gy", "acq_date"], sort=False)
                   .agg(hs=("hs", "sum"), nrt=("nrt", "max")).reset_index()
                   .rename(columns={"acq_date": "date"}))
        daily["date"] = pd.to_datetime(daily["date"])
        daily.to_parquet(out_dir / f"{region}_{sensor}.parquet", index=False)
        print(f"{region} {sensor}: {len(daily):,} cell-days, {int(daily.hs.sum()):,} hotspots, "
              f"{daily.date.min():%Y-%m-%d} to {daily.date.max():%Y-%m-%d}")


if __name__ == "__main__":
    for r in sys.argv[1:] or list(REGIONS):
        grid_region(r)
