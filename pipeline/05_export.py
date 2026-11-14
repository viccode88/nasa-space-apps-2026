"""Write the data files the website reads (spec section 6).

Usage:  python pipeline/05_export.py

Output in web/public/data/:
    cells_daily_<region>.parquet   one row per cell-day of the primary sensor
    points_<region>_<year>.parquet filtered hotspots of the primary sensor
    coefficients.parquet / .json   conversion coefficients and error quantiles
    presets.json                   whole-region calendars (fallback without DuckDB)
    coverage.json                  which cells are covered (no fire vs no data)
    meta.json, missing_days.json
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from common import (N20_START, OUT, PRODUCTS, RAW, REGIONS, SENSOR_LABEL, SENSORS,
                    SERIES_START, SNPP_START, SRC_ID, SUBREGIONS, WORK, region_polygon,
                    subregion_of)

SI_USE = ("The data pipeline code was written with the assistance of Claude (Anthropic), "
          "following the team's own specification. Figures are plotted from data, not generated.")


def primary_window(sensor: str) -> tuple[int, int]:
    """Half-open [start, end) month index range in which a sensor is the primary one."""
    return {"aqua": (SERIES_START, SNPP_START),
            "snpp": (SNPP_START, N20_START),
            "n20": (N20_START, 10 ** 6)}[sensor]


def cells_daily(region: str, coef: pd.DataFrame) -> pd.DataFrame | None:
    parts = []
    for sensor in SENSORS:
        path = WORK / "grid" / f"{region}_{sensor}.parquet"
        if not path.exists():
            continue
        g = pd.read_parquet(path)
        ymi = g.date.dt.year * 12 + g.date.dt.month - 1
        lo, hi = primary_window(sensor)
        g = g[(ymi >= lo) & (ymi < hi)].copy()
        if g.empty:
            continue
        g["subregion"] = subregion_of(region, g.gx.to_numpy())
        g["month"] = g.date.dt.month
        g["src"] = SRC_ID[sensor]
        if sensor == "snpp":
            g["k_cd"], g["k_hs"] = 1.0, 1.0
        else:
            c = coef[coef.conversion == f"{sensor}_to_snpp"].pivot(
                index=["subregion", "month"], columns="metric", values="k")
            g = g.join(c.add_prefix("k_"), on=["subregion", "month"])
        parts.append(g)
    if not parts:
        return None
    g = pd.concat(parts, ignore_index=True)
    out = pd.DataFrame({
        "gx": g.gx.astype("int16"),
        "gy": g.gy.astype("int16"),
        "date": g.date.dt.date,
        "src": g.src.astype("uint8"),
        "stratum": (g.subregion.map(SUBREGIONS.index) * 12 + g.month - 1).astype("uint8"),
        "hs_raw": g.hs.astype("uint16"),
        "hs": (g.hs * g.k_hs).astype("float32"),
        "cd": g.k_cd.astype("float32"),
        "nrt": g.nrt.astype(bool),
    })
    # Sorted by latitude band first so a small bounding box touches few row groups.
    return out.sort_values(["gy", "gx", "date"], ignore_index=True)


def export_points(region: str) -> int:
    """Hotspots of the primary sensor only, one file per year, sorted by date."""
    n = 0
    years = sorted({int(p.stem.split("_")[-1]) for p in (WORK / "clean").glob(f"{region}_*.parquet")})
    for year in years:
        frames = []
        for sensor in SENSORS:
            path = WORK / "clean" / f"{region}_{sensor}_{year}.parquet"
            if not path.exists():
                continue
            df = pd.read_parquet(path)
            d = pd.to_datetime(df.acq_date)
            ymi = d.dt.year * 12 + d.dt.month - 1
            lo, hi = primary_window(sensor)
            df = df[(ymi >= lo) & (ymi < hi)]
            if len(df):
                frames.append(df.assign(sensor=SENSOR_LABEL[sensor]))
        if not frames:
            continue
        pts = pd.concat(frames).sort_values(["acq_date", "acq_time"], ignore_index=True)
        pts = pts[["latitude", "longitude", "acq_date", "acq_time", "sensor",
                   "confidence", "frp", "daynight", "nrt"]]
        pts.to_parquet(OUT / f"points_{region}_{year}.parquet", index=False,
                       compression="zstd", row_group_size=100_000)
        n += len(pts)
    return n


def preset_calendar(cells: pd.DataFrame, coef: pd.DataFrame) -> list[dict]:
    """Year x month totals for the whole region, with the error range (spec 5.4)."""
    d = pd.to_datetime(cells.date)
    g = (cells.assign(year=d.dt.year, month=d.dt.month, cd_raw=1)
              .groupby(["year", "month", "src", "stratum"])
              .agg(cd=("cd", "sum"), hs=("hs", "sum"), cd_raw=("cd_raw", "sum"),
                   hs_raw=("hs_raw", "sum"), nrt=("nrt", "max")).reset_index())
    conv = {0: "aqua_to_snpp", 2: "n20_to_snpp"}
    q = coef.pivot(index=["stratum", "conversion"], columns="metric", values=["q10", "q90"])
    for metric in ("cd", "hs"):
        lo, hi = [], []
        for r in g.itertuples():
            if r.src == 1:
                lo.append(getattr(r, metric)); hi.append(getattr(r, metric))
            else:
                row = q.loc[(r.stratum, conv[r.src])]
                lo.append(getattr(r, metric) * (1 + row[("q10", metric)]))
                hi.append(getattr(r, metric) * (1 + row[("q90", metric)]))
        g[f"{metric}_lo"], g[f"{metric}_hi"] = lo, hi
    cal = g.groupby(["year", "month"]).agg(
        src=("src", "first"), cd=("cd", "sum"), cd_lo=("cd_lo", "sum"), cd_hi=("cd_hi", "sum"),
        hs=("hs", "sum"), hs_lo=("hs_lo", "sum"), hs_hi=("hs_hi", "sum"),
        cd_raw=("cd_raw", "sum"), hs_raw=("hs_raw", "sum"), nrt=("nrt", "max")).reset_index()
    for col in ("cd", "cd_lo", "cd_hi", "hs", "hs_lo", "hs_hi"):
        cal[col] = cal[col].astype("float64").round(1)
    return json.loads(cal.to_json(orient="records"))


def coverage(region: str, cells: pd.DataFrame) -> dict:
    """Which 0.1 degree cells the data set covers (spec 4.2).

    A cell is covered when it touches the region's country polygons inside the
    region bounding box. A covered cell with no rows had no fire; a cell that
    is not covered has no data at all (another country, or open sea). Cells
    that hold data are always covered, so the two files cannot disagree.
    Encoded per latitude row as inclusive [gx_start, gx_end] runs.
    """
    import shapely

    w, s, e, n = REGIONS[region]["bbox"]
    gx = np.arange(int(np.floor(w * 10)), int(np.ceil(e * 10)))
    gy = np.arange(int(np.floor(s * 10)), int(np.ceil(n * 10)))
    X, Y = np.meshgrid(gx, gy)
    hit = shapely.intersects(region_polygon(region),
                             shapely.box(X / 10, Y / 10, (X + 1) / 10, (Y + 1) / 10))
    covered = set(zip(X[hit].tolist(), Y[hit].tolist()))
    covered |= set(map(tuple, cells[["gx", "gy"]].drop_duplicates().to_numpy().tolist()))
    rows: dict[str, list[list[int]]] = {}
    for y in sorted({c[1] for c in covered}):
        xs = sorted(c[0] for c in covered if c[1] == y)
        runs = [[xs[0], xs[0]]]
        for x in xs[1:]:
            if x == runs[-1][1] + 1:
                runs[-1][1] = x
            else:
                runs.append([x, x])
        rows[str(y)] = runs
    return {"cells": len(covered), "bbox_cells": int(hit.size), "rows": rows}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    coef = pd.read_parquet(WORK / "coefficients.parquet")
    coef.astype({"stratum": "uint8", "month": "uint8"}).to_parquet(
        OUT / "coefficients.parquet", index=False)
    (OUT / "coefficients.json").write_text(
        json.dumps(json.loads(coef.round(4).to_json(orient="records")), allow_nan=False))

    presets, regions_meta, through, cover = {}, {}, [], {}
    for region, cfg in REGIONS.items():
        cells = cells_daily(region, coef[coef.region == region])
        if cells is None:
            print(f"{region}: no gridded data, skipped")
            continue
        dest = OUT / f"cells_daily_{region}.parquet"
        cells.to_parquet(dest, index=False, compression="zstd", row_group_size=50_000)
        n_points = export_points(region)
        cover[region] = coverage(region, cells)
        last = max(cells.date)
        through.append(last)
        gx0, gx1, gy0, gy1 = cells.gx.min(), cells.gx.max(), cells.gy.min(), cells.gy.max()
        regions_meta[region] = {
            "name": cfg["name"], "bbox": cfg["bbox"], "subregions": cfg["subregions"],
            "data_bbox": [gx0 / 10, gy0 / 10, (gx1 + 1) / 10, (gy1 + 1) / 10],
            "data_through": str(last), "cell_days": int(len(cells)), "points": int(n_points),
            "covered_cells": cover[region]["cells"],
        }
        presets[region] = {"name": cfg["name"], "bbox": cfg["bbox"],
                           "calendar": preset_calendar(cells, coef)}
        print(f"{region}: {len(cells):,} cell-days ({dest.stat().st_size / 1e6:.1f} MB), "
              f"{n_points:,} points, through {last}")

    current = RAW / "api" / "current_year.json"
    cur = json.loads(current.read_text()) if current.exists() else {}
    (OUT / "presets.json").write_text(json.dumps(presets, allow_nan=False))
    (OUT / "coverage.json").write_text(json.dumps({
        "grid_degrees": 0.1,
        "boundaries": "Natural Earth 1:10m Admin 0 Countries",
        "rows": "rows[gy] = inclusive [gx_start, gx_end] runs of covered cells",
        "regions": cover}, separators=(",", ":")))
    raw_files = sorted(p.name for product in PRODUCTS for p in (RAW / product).glob("*.csv"))
    meta = {
        # "Now" for the website is this date, never the browser clock (spec 8).
        "data_through": cur.get("data_through") or (str(max(through)) if through else None),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timezone": "UTC",
        "grid_degrees": 0.1,
        "grid_formula": "g = floor(round(deg * 100000) / 10000)",
        "reference_sensor": SENSOR_LABEL["snpp"],
        "src": {str(v): SENSOR_LABEL[k] for k, v in SRC_ID.items()},
        "primary_sensor": [
            {"from": "2003-01", "to": "2012-01", "src": 0, "conversion": "aqua_to_snpp"},
            {"from": "2012-02", "to": "2026-10", "src": 1, "conversion": None},
            {"from": "2026-11", "to": None, "src": 2, "conversion": "n20_to_snpp"},
        ],
        "strata": [{"stratum": i * 12 + m, "subregion": s, "month": m + 1}
                   for i, s in enumerate(SUBREGIONS) for m in range(12)],
        "regions": regions_meta,
        "nrt_start": cur.get("nrt_start"),
        "sources": {"provider": "NASA FIRMS", "url": "https://firms.modaps.eosdis.nasa.gov/",
                    "files": raw_files},
        "si_use": SI_USE,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    missing = OUT / "missing_days.json"
    if not missing.exists():
        # Filled by a later step that needs a FIRMS MAP_KEY (spec 4.5).
        missing.write_text(json.dumps({"available": False, "sensors": {}}))
    total = sum(p.stat().st_size for p in OUT.iterdir())
    print(f"site data: {total / 1e6:.1f} MB in {len(list(OUT.iterdir()))} files")


if __name__ == "__main__":
    main()
