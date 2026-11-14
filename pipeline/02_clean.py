"""Filter raw FIRMS CSVs (spec 4.3) and build the static heat source mask.

Usage:  python pipeline/02_clean.py [region ...]

Output: data/work/clean/<region>_<sensor>_<year>.parquet
        data/work/mask_<region>.parquet   (0.01 degree cells treated as fixed heat sources)
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from common import PRODUCTS, RAW, REGIONS, WORK

COLS = ["latitude", "longitude", "acq_date", "acq_time", "satellite",
        "confidence", "frp", "daynight", "type"]
NEIGHBOURS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
MASK_MIN_DAYS = 3      # static detections on at least this many days
MASK_MIN_SHARE = 0.5   # and on at least this share of the cell's detection days


def cell100(deg) -> np.ndarray:
    """0.01 degree cell index, integer arithmetic."""
    v = np.round(np.asarray(deg, dtype="float64") * 100000.0).astype("int64")
    return np.floor_divide(v, 1000).astype("int32")


def read_raw(path, bbox) -> pd.DataFrame:
    df = pd.read_csv(path, usecols=lambda c: c in COLS,
                     dtype={"confidence": str, "satellite": str, "daynight": str})
    w, s, e, n = bbox
    return df[df.longitude.between(w, e) & df.latitude.between(s, n)]


def keep_confident(df: pd.DataFrame, product: str) -> pd.DataFrame:
    if product == "modis":
        df = df[df.satellite.str[0] == "A"]  # Aqua only ("Aqua" in SP, "A" in NRT)
        return df[pd.to_numeric(df.confidence, errors="coerce") >= 30]
    return df[df.confidence.str[0].isin(["n", "h"])]


def cell_days(df: pd.DataFrame) -> pd.DataFrame:
    """Distinct (0.01 degree cell, day) pairs of a set of detections."""
    return pd.DataFrame({
        "x": cell100(df.longitude), "y": cell100(df.latitude),
        "day": pd.to_datetime(df.acq_date).to_numpy().astype("datetime64[D]").astype("int32"),
    }).drop_duplicates()


def build_mask(static_parts, fire_parts) -> set[tuple[int, int]]:
    """Fixed heat source mask for data without a `type` field.

    A cell is a fixed source when static detections occurred on at least
    MASK_MIN_DAYS days and on at least MASK_MIN_SHARE of all its detection
    days. The mask is those cells plus their 8 neighbours. Masking every cell
    that ever had a static detection removed too many real fires burning next
    to industrial sites; see docs/METHODS.md.
    """
    static = pd.concat(static_parts).drop_duplicates() if static_parts else pd.DataFrame()
    if static.empty:
        return set()
    s = static.groupby(["x", "y"]).size()
    f = pd.concat(fire_parts).drop_duplicates().groupby(["x", "y"]).size()
    f = f.reindex(s.index, fill_value=0)
    core = s.index[(s >= MASK_MIN_DAYS) & (s / (s + f) >= MASK_MIN_SHARE)]
    return {(x + dx, y + dy) for x, y in core for dx, dy in NEIGHBOURS}


def clean_region(region: str) -> None:
    cfg = REGIONS[region]
    out_dir = WORK / "clean"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Pass 1: standard-processing rows. Record, per 0.01 degree cell, the days
    # with a static source (type 1, 2, 3) and the days with a vegetation fire.
    static_days = {"modis": [], "viirs": []}
    fire_days = {"modis": [], "viirs": []}
    nrt_frames = []  # near-real-time rows have no `type` value
    for product, (sensor, _, first, last) in PRODUCTS.items():
        family = "modis" if product == "modis" else "viirs"
        for year in range(first, last + 2):
            names = cfg["countries"] + [f"region-{region}"]  # region file: area API
            frames = []
            for name in names:
                path = RAW / product / f"{product}_{year}_{name}.csv"
                if not path.exists() or path.stat().st_size < 10:
                    continue
                df = read_raw(path, cfg["bbox"])
                if "type" not in df.columns:
                    df["type"] = np.nan
                nrt = df[df["type"].isna()]
                if len(nrt):
                    nrt_frames.append((family, sensor, year, keep_confident(nrt, product)))
                static_days[family].append(cell_days(df[df["type"].isin([1, 2, 3])]))
                fire_days[family].append(cell_days(df[df["type"] == 0]))
                frames.append(keep_confident(df[df["type"] == 0], product).assign(nrt=False))
            dest = out_dir / f"{region}_{sensor}_{year}.parquet"
            dest.unlink(missing_ok=True)
            if frames and sum(map(len, frames)):
                write(pd.concat(frames), dest)

    masks, rows = {}, []
    for family in static_days:
        masks[family] = build_mask(static_days[family], fire_days[family])
        rows += [(family, x, y) for x, y in sorted(masks[family])]
    mask = pd.DataFrame(rows, columns=["family", "x100", "y100"])
    mask.to_parquet(WORK / f"mask_{region}.parquet", index=False)

    # Pass 2: drop near-real-time detections that fall inside the mask.
    for family, sensor, year, df in nrt_frames:
        grown = masks[family]
        key = list(zip(cell100(df.longitude).tolist(), cell100(df.latitude).tolist()))
        df = tidy(df[[k not in grown for k in key]].assign(nrt=True))
        dest = out_dir / f"{region}_{sensor}_{year}.parquet"
        if dest.exists():
            df = pd.concat([pd.read_parquet(dest), df])
        write(df, dest)

    n = sum(len(pd.read_parquet(p, columns=["nrt"])) for p in out_dir.glob(f"{region}_*.parquet"))
    print(f"{region}: {n:,} hotspots kept, mask {len(mask):,} cells")


def tidy(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "latitude": df.latitude.astype("float64"),
        "longitude": df.longitude.astype("float64"),
        "acq_date": pd.to_datetime(df.acq_date).dt.date,
        "acq_time": pd.to_numeric(df.acq_time).astype("int16"),
        "confidence": df.confidence.astype(str),
        "frp": df.frp.astype("float32"),
        "daynight": df.daynight.astype(str),
        "nrt": df.nrt.astype(bool),
    })


def write(df: pd.DataFrame, dest) -> None:
    out = df if "satellite" not in df.columns else tidy(df)
    out.sort_values(["acq_date", "acq_time"]).to_parquet(dest, index=False)


if __name__ == "__main__":
    for r in sys.argv[1:] or list(REGIONS):
        clean_region(r)
