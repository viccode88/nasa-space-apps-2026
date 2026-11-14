"""Conversion coefficients, leave-one-year-out validation and drift check (spec 5).

Usage:  python pipeline/04_harmonize.py

Uses every region that has gridded data in data/work/grid/.

Output: data/work/coefficients.parquet
        web/public/data/validation_<region>.json
        docs/figures/<region>_{before,after,scatter,drift}.png

Method: ratio coefficients. For each stratum (subregion x calendar month) and
each metric,  k = sum(S-NPP) / sum(source sensor)  over the training period.
"""
from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from common import (DOCS, MIN_TRAIN_CD, N20_START, OUT, REGIONS, SENSOR_LABEL, SENSORS,
                    SERIES_START, SNPP_START, TRAIN, WORK, stratum_id, subregion_of, ym)

METRICS = ["cd", "hs"]
METRIC_LABEL = {"cd": "active cell-days", "hs": "hotspots"}
# First full month of each sensor's record.
SENSOR_START = {"aqua": ym(2002, 8), "snpp": ym(2012, 2), "n20": ym(2018, 4)}
COLORS = {"aqua": "#d55e00", "snpp": "#0072b2", "n20": "#009e73", "harm": "#222222"}


def label(ymi: int) -> str:
    return f"{ymi // 12}-{ymi % 12 + 1:02d}"


def monthly_table(region: str) -> pd.DataFrame | None:
    """Rows: (subregion, ymi). Columns: <sensor>_<metric>. NaN = sensor not operating."""
    frames = {}
    for sensor in SENSORS:
        path = WORK / "grid" / f"{region}_{sensor}.parquet"
        if not path.exists():
            continue
        g = pd.read_parquet(path, columns=["gx", "date", "hs"])
        g["subregion"] = subregion_of(region, g.gx.to_numpy())
        g["ymi"] = g.date.dt.year * 12 + g.date.dt.month - 1
        agg = g.groupby(["subregion", "ymi"]).agg(cd=("hs", "size"), hs=("hs", "sum"))
        last = int(g.ymi.max())
        idx = pd.MultiIndex.from_product(
            [REGIONS[region]["subregions"], range(SENSOR_START[sensor], last + 1)],
            names=["subregion", "ymi"])
        agg = agg.reindex(idx, fill_value=0)  # months with no fire are 0, not missing
        frames[sensor] = agg.add_prefix(f"{sensor}_")
    if "aqua" not in frames or "snpp" not in frames:
        return None
    m = pd.concat(frames.values(), axis=1).sort_index().reset_index()
    m["year"] = m.ymi // 12
    m["month"] = m.ymi % 12 + 1
    return m


def fit(train: pd.DataFrame, src: str, metric: str) -> pd.DataFrame:
    """Ratio coefficient per calendar month, with the small-sample fallback (spec 5.2)."""
    months = range(1, 13)
    g = train.groupby("month")
    ref = g[f"snpp_{metric}"].sum().reindex(months, fill_value=0)
    source = g[f"{src}_{metric}"].sum().reindex(months, fill_value=0)
    n = g[f"{src}_cd"].sum().reindex(months, fill_value=0)
    ref_all, src_all = train[f"snpp_{metric}"].sum(), train[f"{src}_{metric}"].sum()
    k_all = ref_all / src_all if src_all > 0 else 1.0
    fallback = (n < MIN_TRAIN_CD) | (source <= 0)
    k = (ref / source.where(~fallback)).fillna(k_all)
    return pd.DataFrame({"k": k, "n_train": n.astype(int), "fallback": fallback})


def cross_validate(tr: pd.DataFrame, src: str, metric: str) -> pd.DataFrame:
    """Leave one year out: predict each held-out year from the others."""
    rows = []
    for year in sorted(tr.year.unique()):
        k = fit(tr[tr.year != year], src, metric)["k"]
        test = tr[tr.year == year]
        rows.append(pd.DataFrame({
            "year": year, "month": test.month.to_numpy(),
            "src": test[f"{src}_{metric}"].to_numpy(),
            "pred": test[f"{src}_{metric}"].to_numpy() * k.reindex(test.month).to_numpy(),
            "actual": test[f"snpp_{metric}"].to_numpy(),
        }))
    return pd.concat(rows, ignore_index=True)


def summarise(cv: pd.DataFrame) -> dict:
    total_actual = cv.actual.sum()
    big = cv[(cv.src >= 50) & (cv.actual > 0)]
    annual = cv.groupby("year")[["pred", "actual"]].sum()
    rho = spearmanr(annual.pred, annual.actual).statistic if len(annual) > 2 else np.nan
    return {
        "bias": float((cv.pred.sum() - total_actual) / total_actual) if total_actual else None,
        "mape": float(((big.pred - big.actual).abs() / big.actual).mean()) if len(big) else None,
        "n_months_mape": int(len(big)),
        "spearman_annual": None if np.isnan(rho) else float(rho),
        "n_years": int(len(annual)),
    }


def error_quantiles(cv: pd.DataFrame) -> pd.DataFrame:
    """q10/q90 of (actual - predicted) / predicted per calendar month.

    Defined relative to the predicted value so that the displayed range is
    value * (1 + q10) .. value * (1 + q90)  (spec 5.4).
    Months with fewer than 5 usable years use the pooled subregion quantiles.
    """
    ok = cv[cv.pred > 0].assign(err=lambda d: (d.actual - d.pred) / d.pred)
    pooled = (ok.err.quantile(0.1), ok.err.quantile(0.9)) if len(ok) else (0.0, 0.0)
    out = pd.DataFrame(index=range(1, 13), columns=["q10", "q90"], dtype=float)
    for month in out.index:
        e = ok.err[ok.month == month]
        out.loc[month] = (e.quantile(0.1), e.quantile(0.9)) if len(e) >= 5 else pooled
    return out


def harmonize_region(region: str, m: pd.DataFrame):
    coef_rows, cv_rows, drift_rows, scatter = [], [], [], []
    for sub in REGIONS[region]["subregions"]:
        ms = m[m.subregion == sub]
        for conversion, (src, start, end) in TRAIN.items():
            if f"{src}_cd" not in ms.columns:
                continue
            tr = ms[ms.ymi.between(start, end)].dropna(subset=[f"{src}_cd", "snpp_cd"])
            if tr.empty:
                continue
            for metric in METRICS:
                k = fit(tr, src, metric)
                cv = cross_validate(tr, src, metric)
                q = error_quantiles(cv)
                # Fallback strata share one coefficient, so they share pooled quantiles too.
                pooled = error_quantiles(cv.assign(month=0)).iloc[0]
                for month in range(1, 13):
                    fb = bool(k.fallback[month])
                    coef_rows.append({
                        "stratum": stratum_id(sub, month), "region": region, "subregion": sub,
                        "month": month, "conversion": conversion, "metric": metric,
                        "k": float(k.k[month]),
                        "q10": float(pooled.q10 if fb else q.q10[month]),
                        "q90": float(pooled.q90 if fb else q.q90[month]),
                        "n_train": int(k.n_train[month]), "fallback": fb,
                    })
                cv_rows.append({"subregion": sub, "conversion": conversion, "metric": metric,
                                "train_from": label(start), "train_to": label(int(tr.ymi.max())),
                                **summarise(cv)})
        # Drift check (spec 5.5): one all-months Aqua -> S-NPP ratio per year.
        both = ms.dropna(subset=["aqua_cd", "snpp_cd"])
        for year, g in both.groupby("year"):
            drift_rows.append({"subregion": sub, "year": int(year), **{
                f"k_{mt}": (float(g[f"snpp_{mt}"].sum() / g[f"aqua_{mt}"].sum())
                            if g[f"aqua_{mt}"].sum() > 0 else None) for mt in METRICS}})
        start, end = TRAIN["aqua_to_snpp"][1:]
        for r in ms[ms.ymi.between(start, end)].itertuples():
            scatter.append({"subregion": sub, "ym": label(r.ymi), "month": int(r.month),
                            "aqua_cd": int(r.aqua_cd), "snpp_cd": int(r.snpp_cd),
                            "aqua_hs": int(r.aqua_hs), "snpp_hs": int(r.snpp_hs)})
    return pd.DataFrame(coef_rows), cv_rows, drift_rows, scatter


def compose(m: pd.DataFrame, coef: pd.DataFrame, metric: str) -> pd.DataFrame:
    """Harmonized monthly series per subregion (spec 5.3) with its error range."""
    c = coef[coef.metric == metric].set_index(["subregion", "month", "conversion"])
    d = m[m.ymi >= SERIES_START].copy()
    src = np.where(d.ymi < SNPP_START, "aqua", np.where(d.ymi < N20_START, "snpp", "n20"))
    value, lo, hi = [], [], []
    for (sub, month, ymi), s in zip(zip(d.subregion, d.month, d.ymi), src):
        raw = d.loc[(d.subregion == sub) & (d.ymi == ymi), f"{s}_{metric}"].iloc[0] \
            if f"{s}_{metric}" in d.columns else np.nan
        if s == "snpp" or np.isnan(raw):
            value.append(raw); lo.append(raw); hi.append(raw)
            continue
        row = c.loc[(sub, month, f"{s}_to_snpp")]
        v = raw * row.k
        value.append(v); lo.append(v * (1 + row.q10)); hi.append(v * (1 + row.q90))
    d["src"], d["value"], d["lo"], d["hi"] = src, value, lo, hi
    return d[["subregion", "ymi", "src", "value", "lo", "hi"]]


def nan_list(s: pd.Series, digits: int = 1) -> list:
    return [None if pd.isna(v) else round(float(v), digits) for v in s]


def region_series(m: pd.DataFrame, coef: pd.DataFrame) -> dict:
    ymis = sorted(m.ymi.unique())
    out = {"months": [label(y) for y in ymis]}
    for metric in METRICS:
        for sensor in SENSORS:
            col = f"{sensor}_{metric}"
            if col in m.columns:
                tot = m.groupby("ymi")[col].sum(min_count=1).reindex(ymis)
                out[f"{sensor}_raw_{metric}"] = nan_list(tot, 0)
        h = compose(m, coef, metric).groupby("ymi")[["value", "lo", "hi"]].sum(min_count=1)
        h = h.reindex(ymis)
        out[f"harmonized_{metric}"] = nan_list(h.value)
        out[f"harmonized_lo_{metric}"] = nan_list(h.lo)
        out[f"harmonized_hi_{metric}"] = nan_list(h.hi)
    return out


def figures(region: str, v: dict) -> None:
    fig_dir = DOCS / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    name = REGIONS[region]["name"]
    months = pd.to_datetime(v["series"]["months"])
    s = {k: pd.Series(val, index=months, dtype=float) for k, val in v["series"].items()
         if k != "months"}
    if months[-1].month != 12:  # annual totals: leave out the incomplete last year
        s = {k: val[:str(months[-1].year - 1)] for k, val in s.items()}
    switch = pd.Timestamp("2012-02-01")

    for kind in ("before", "after"):
        fig, axes = plt.subplots(2, 1, figsize=(11, 6.5), sharex=True)
        for ax, metric in zip(axes, METRICS):
            if kind == "before":
                # What a user gets by stitching the raw records together.
                stitched = pd.concat([
                    s[f"aqua_raw_{metric}"]["2003-01-01":switch - pd.Timedelta(days=1)],
                    s[f"snpp_raw_{metric}"][switch:]]).resample("YS").sum()
                ax.plot(stitched, color="#999999", lw=1, zorder=1)
                ax.plot(stitched[:"2011"], color=COLORS["aqua"], marker="o",
                        label="MODIS Aqua (raw)")
                ax.plot(stitched["2012":], color=COLORS["snpp"], marker="o",
                        label="VIIRS S-NPP (raw)")
            else:
                h = s[f"harmonized_{metric}"]["2003-01-01":]
                lo = s[f"harmonized_lo_{metric}"]["2003-01-01":].resample("YS").sum()
                hi = s[f"harmonized_hi_{metric}"]["2003-01-01":].resample("YS").sum()
                ax.fill_between(lo.index, lo, hi, color="#999999", alpha=0.35, lw=0,
                                label="10-90% range from cross-validation")
                ax.plot(h.resample("YS").sum(), color=COLORS["harm"], marker="o",
                        label="Harmonized (S-NPP equivalent)")
            ax.axvline(switch, color="#666666", ls="--", lw=1)
            ax.set_ylabel(f"{METRIC_LABEL[metric]} per year")
            ax.set_ylim(bottom=0)
            ax.grid(alpha=0.3)
            ax.legend(loc="upper left", frameon=False)
        axes[0].set_title(f"{name}: annual fire activity {kind} harmonization "
                          f"(dashed line: sensor switch, Feb 2012)")
        fig.tight_layout()
        fig.savefig(fig_dir / f"{region}_{kind}.png", dpi=130)
        plt.close(fig)

    sc = pd.DataFrame(v["scatter"])
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    for ax, metric in zip(axes, METRICS):
        x, y = sc[f"aqua_{metric}"], sc[f"snpp_{metric}"]
        ax.scatter(x, y, s=12, alpha=0.6, color=COLORS["snpp"])
        k = y.sum() / x.sum() if x.sum() else np.nan
        top = max(x.max(), 1)
        ax.plot([0, top], [0, top * k], color=COLORS["aqua"], label=f"overall ratio k = {k:.2f}")
        ax.plot([0, top], [0, top], color="#999999", ls=":", label="1 : 1")
        ax.set_xlabel(f"MODIS Aqua monthly {METRIC_LABEL[metric]}")
        ax.set_ylabel(f"VIIRS S-NPP monthly {METRIC_LABEL[metric]}")
        ax.legend(frameon=False)
        ax.grid(alpha=0.3)
    fig.suptitle(f"{name}: overlap period, one point per subregion-month (training period)")
    fig.tight_layout()
    fig.savefig(fig_dir / f"{region}_scatter.png", dpi=130)
    plt.close(fig)

    dr = pd.DataFrame(v["drift"])
    fig, ax = plt.subplots(figsize=(9, 4.5))
    for i, (sub, g) in enumerate(dr.groupby("subregion")):
        ax.plot(g.year, g.k_cd, marker="o", ls="-", color=f"C{i}", label=f"{sub} cell-days")
        ax.plot(g.year, g.k_hs, marker="s", ls="--", color=f"C{i}", label=f"{sub} hotspots")
    ax.axvspan(2021.5, dr.year.max() + 0.5, color="#dddddd", alpha=0.6, lw=0,
               label="excluded from training (Aqua orbit drift)")
    ax.set_xlabel("year")
    ax.set_ylabel("annual ratio  S-NPP / Aqua")
    ax.set_title(f"{name}: Aqua to S-NPP ratio by year")
    ax.grid(alpha=0.3)
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(fig_dir / f"{region}_drift.png", dpi=130)
    plt.close(fig)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    all_coef = []
    for region in REGIONS:
        m = monthly_table(region)
        if m is None:
            print(f"{region}: no gridded data, skipped")
            continue
        coef, cv_rows, drift, scatter = harmonize_region(region, m)
        all_coef.append(coef)
        v = {"region": region, "name": REGIONS[region]["name"],
             "targets": {"abs_bias_max": 0.10, "mape_max": 0.30, "spearman_min": 0.80,
                         "n20_k_range": [0.9, 1.1]},
             "cv": cv_rows, "drift": drift, "scatter": scatter,
             "series": region_series(m, coef)}
        (OUT / f"validation_{region}.json").write_text(json.dumps(v, allow_nan=False))
        figures(region, v)
        for r in cv_rows:
            fmt = lambda x: "n/a" if x is None else f"{x:+.3f}"
            print(f"{r['subregion']:6s} {r['conversion']:13s} {r['metric']}  "
                  f"bias {fmt(r['bias'])}  mape {fmt(r['mape'])} (n={r['n_months_mape']})  "
                  f"spearman {fmt(r['spearman_annual'])}")
        fb = coef.fallback.mean()
        print(f"{region}: {len(coef)} coefficients, {fb:.0%} use the fallback")
    pd.concat(all_coef, ignore_index=True).to_parquet(WORK / "coefficients.parquet", index=False)


if __name__ == "__main__":
    main()
