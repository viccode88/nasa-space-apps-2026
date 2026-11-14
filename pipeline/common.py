"""Shared configuration for the Burn Calendar data pipeline.

All dates are UTC (FIRMS ``acq_date``). The reference scale is VIIRS S-NPP.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"            # downloaded FIRMS CSVs (not in git)
WORK = ROOT / "data" / "work"          # intermediate parquet (not in git)
OUT = ROOT / "web" / "public" / "data" # files served by the website
DOCS = ROOT / "docs"                   # validation figures

FIRMS_COUNTRY_URL = (
    "https://firms.modaps.eosdis.nasa.gov/data/country/{product}/{year}/"
    "{product}_{year}_{country}.csv"
)

# FIRMS product code -> (sensor key, src id, first year, last year of annual files)
PRODUCTS = {
    "modis": ("aqua", 0, 2002, 2025),
    "viirs-snpp": ("snpp", 1, 2012, 2025),
    "viirs-jpss1": ("n20", 2, 2018, 2025),
}
SENSORS = ["aqua", "snpp", "n20"]
SRC_ID = {"aqua": 0, "snpp": 1, "n20": 2}
SENSOR_LABEL = {"aqua": "MODIS Aqua", "snpp": "VIIRS S-NPP", "n20": "VIIRS NOAA-20"}

# Display regions (spec 4.2). bbox = west, south, east, north in degrees.
REGIONS = {
    "usa": {
        "name": "Contiguous United States",
        "countries": ["United_States"],
        "bbox": [-125.0, 24.0, -66.5, 49.5],
        "subregions": ["usa_w", "usa_e"],
    },
    "twn": {
        "name": "Taiwan",
        "countries": ["Taiwan"],
        "bbox": [118.0, 21.5, 122.5, 26.5],  # includes Kinmen and Matsu
        "subregions": ["twn"],
    },
    "sea": {
        "name": "Myanmar, Thailand and Laos",
        "countries": ["Myanmar", "Thailand", "Lao_PDR"],
        "bbox": [92.0, 5.5, 108.0, 28.6],
        "subregions": ["sea"],
    },
    "arg": {
        "name": "Argentina",
        "countries": ["Argentina"],
        "bbox": [-73.6, -55.2, -53.6, -21.7],
        "subregions": ["arg"],
    },
}
SUBREGIONS = [s for r in REGIONS.values() for s in r["subregions"]]
USA_SPLIT_GX = -1000  # cells with gx < -1000 (west of 100 W) belong to usa_w

# Series composition (spec 5.3): whole-month switches, as year*12 + (month-1).
def ym(year: int, month: int) -> int:
    return year * 12 + (month - 1)

SERIES_START = ym(2003, 1)
SNPP_START = ym(2012, 2)     # S-NPP is the primary sensor from 2012-02 ...
N20_START = ym(2026, 11)     # ... until NOAA-20 takes over in 2026-11

# Training periods for the conversion coefficients (spec 5.2), inclusive.
TRAIN = {
    "aqua_to_snpp": ("aqua", ym(2012, 2), ym(2021, 12)),
    "n20_to_snpp": ("n20", ym(2018, 4), ym(2025, 12)),
}
MIN_TRAIN_CD = 200  # below this, fall back to the subregion all-months coefficient


def grid_index(deg) -> np.ndarray:
    """0.1 degree cell index using integer arithmetic (spec 4.4).

    Must match the JavaScript implementation exactly:
        g = floor(round(deg * 100000) / 10000)
    """
    v = np.round(np.asarray(deg, dtype="float64") * 100000.0).astype("int64")
    return np.floor_divide(v, 10000).astype("int16")


def stratum_id(subregion: str, month: int) -> int:
    """Stratum = subregion x calendar month, encoded as a small integer."""
    return SUBREGIONS.index(subregion) * 12 + (month - 1)


def subregion_of(region: str, gx) -> np.ndarray:
    gx = np.asarray(gx)
    if region == "usa":
        return np.where(gx < USA_SPLIT_GX, "usa_w", "usa_e")
    return np.full(gx.shape, region)


# Country polygons (Natural Earth 1:10m, public domain). Used to clip area API
# results and to describe which cells are covered.
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
          "geojson/ne_10m_admin_0_countries.geojson")
NE_NAME = {"United_States": "United States of America", "Taiwan": "Taiwan",
           "Myanmar": "Myanmar", "Thailand": "Thailand", "Lao_PDR": "Laos",
           "Argentina": "Argentina"}


def region_polygon(region: str):
    """Union of the region's country polygons, prepared for fast point tests."""
    import json
    import urllib.request

    import shapely
    from shapely.geometry import shape
    from shapely.ops import unary_union

    path = RAW / "boundaries" / "ne_10m_admin_0_countries.geojson"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(NE_URL, path)
    wanted = {NE_NAME[c] for c in REGIONS[region]["countries"]}
    feats = json.loads(path.read_text())["features"]
    geoms = [shape(f["geometry"]) for f in feats if f["properties"]["ADMIN"] in wanted]
    assert len(geoms) == len(wanted), f"boundary missing for {region}"
    poly = unary_union(geoms)
    shapely.prepare(poly)
    return poly
