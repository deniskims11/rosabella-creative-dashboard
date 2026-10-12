import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell, ComposedChart,
} from "recharts";
import {
  aggregate, groupBy, monthly, winRate, toBreakdownRows, mergePeriods, toScripts,
  DIMENSIONS, dimensionValues,
} from "./aggregator.js";

const fmt = (n) => n == null ? "—" : n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n.toFixed(0)}`;
const fmtFull = (n) => `$${Math.round(n).toLocaleString()}`;
const fmtNum = (n) => n == null ? "—" : Number(n).toLocaleString();
const fmtPct = (n) => n == null ? "—" : `${Number(n).toFixed(1)}%`;

const TABS = ["Overview", "Momentum", "Win Rate", "Angles", "Concepts", "Agencies", "Creators", "Breakdowns", "Analysis", "Data Clean Up"];
const THRESHOLDS = ["$1K", "$5K", "$15K", "$25K", "$50K", "$100K", "$150K+"];

const RoasBadge = ({ roas }) => {
  if (roas == null) return <span style={{ color: "#b0978f" }}>—</span>;
  const r = roas ?? 0;
  const bg = r >= 1.2 ? "#dcfce7" : r >= 1.0 ? "#f0fdf4" : r >= 0.8 ? "#fef9c3" : "#fee2e2";
  const color = r >= 1.2 ? "#166534" : r >= 1.0 ? "#15803d" : r >= 0.8 ? "#854d0e" : "#991b1b";
  return <span style={{ background: bg, color, padding: "2px 8px", borderRadius: 4, fontWeight: 600, fontSize: 13 }}>{r.toFixed(2)}x</span>;
};

const th = { padding: "8px 10px", color: "#8a6f68", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "8px 10px", color: "#3a2429", fontSize: 12 };

// Convert YYMMDD ↔ YYYY-MM-DD for <input type="date"> round-trips.
const yymmddToIso = (s) => s && /^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : "";
const isoToYymmdd = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10) : null;

// Creation-date range picker shown above the tabs.
function DateRangePicker({ bounds, start, end, setStart, setEnd }) {
  if (!bounds) return null;
  const minIso = yymmddToIso(bounds.min);
  const maxIso = yymmddToIso(bounds.max);
  const isFiltered = start || end;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 14px", background: "#fff", border: "1px solid #E8DCD0", borderRadius: 8, flexWrap: "wrap" }}>
      <div style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Launch date</div>
      <input type="date" value={yymmddToIso(start) || minIso} min={minIso} max={maxIso}
        onChange={e => setStart(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, color: "#3a2429" }} />
      <span style={{ color: "#b0978f", fontSize: 12 }}>→</span>
      <input type="date" value={yymmddToIso(end) || maxIso} min={minIso} max={maxIso}
        onChange={e => setEnd(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, color: "#3a2429" }} />
      {isFiltered && (
        <button onClick={() => { setStart(null); setEnd(null); }}
          style={{ padding: "4px 10px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Reset</button>
      )}
      <span title="Filters creatives by launch date — the first day the creative recorded spend. Spend and revenue shown are lifetime totals for creatives launched in this range."
        style={{ marginLeft: "auto", fontSize: 10, color: "#b0978f", cursor: "help", fontStyle: "italic" }}>
        ⓘ Filters by launch date (first day with spend) — figures are lifetime for creatives launched in range
      </span>
    </div>
  );
}

// Sortable header that cycles through desc → asc → none on click.
function SortHeader({ label, col, sort, setSort, align = "right" }) {
  const active = sort.col === col;
  const arrow = active ? (sort.dir === "desc" ? "↓" : "↑") : "";
  const onClick = () => {
    if (!active) return setSort({ col, dir: "desc" });
    if (sort.dir === "desc") return setSort({ col, dir: "asc" });
    return setSort({ col: "_spend", dir: "desc" }); // reset to default
  };
  return (
    <th
      onClick={onClick}
      style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#50000B" : "#8a6f68" }}
      title="Click to sort"
    >
      {label} {arrow}
    </th>
  );
}

// Sort helper: respects string / number / nulls.
function sortRows(rows, col, dir) {
  const mul = dir === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
    return mul * (va - vb);
  });
}

// --------- Ad list modal (shown when a bucket row is clicked) ---------
function AdListModal({ open, title, subtitle, ads, onClose }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const sortedAds = useMemo(() => {
    if (!ads) return [];
    return ads.slice().sort((a, b) => {
      const mul = sort.dir === "desc" ? -1 : 1;
      let va = sort.col === "spend" ? a.metrics.spend
             : sort.col === "rev" ? a.metrics.rev
             : sort.col === "roas" ? a.metrics.roas
                          : sort.col === "clicks" ? a.metrics.clicks
             : sort.col === "ad_name" ? a.ad_name
             : a.metrics[sort.col];
      let vb = sort.col === "spend" ? b.metrics.spend
             : sort.col === "rev" ? b.metrics.rev
             : sort.col === "roas" ? b.metrics.roas
                          : sort.col === "clicks" ? b.metrics.clicks
             : sort.col === "ad_name" ? b.ad_name
             : b.metrics[sort.col];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [ads, sort]);

  if (!open) return null;

  const downloadCsv = () => {
    const headers = ["ad_name", "account", "aid", "product", "angle", "angle_detail", "stage", "awareness", "format", "media", "concept", "creative_id", "agency", "creator", "version", "offer", "funnel", "geo", "date", "spend", "rev", "txns", "roas", "cpa", "cpm", "ctr", "hook_rate", "hold_rate", "link_clicks", "impressions"];
    const escape = (v) => v == null ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
    const lines = [headers.join(",")];
    for (const a of sortedAds) {
      lines.push(headers.map(h => escape(h in a.metrics ? a.metrics[h] : a[h])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^a-z0-9]+/gi, "_")}_ads.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 20, width: "min(1100px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#50000B" }}>{title}</h3>
            {subtitle && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#8a6f68" }}>{subtitle}</p>}
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#b0978f" }}>{sortedAds.length.toLocaleString()} ads</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={downloadCsv} style={{ padding: "6px 12px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>Download CSV ({sortedAds.length})</button>
            <button onClick={onClose} style={{ padding: "6px 12px", border: "none", background: "#50000B", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
              <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
                <SortHeader label="Ad Name" col="ad_name" sort={sort} setSort={setSort} align="left" />
                <th style={{ ...th, textAlign: "center" }}>Ad</th>
                <SortHeader label="Spend" col="spend" sort={sort} setSort={setSort} />
                <SortHeader label="Revenue" col="rev" sort={sort} setSort={setSort} />
                <SortHeader label="ROAS" col="roas" sort={sort} setSort={setSort} />
                <SortHeader label="CPA" col="cpa" sort={sort} setSort={setSort} />
                <SortHeader label="Hook" col="hook_rate" sort={sort} setSort={setSort} />
                <SortHeader label="Hold" col="hold_rate" sort={sort} setSort={setSort} />
                <SortHeader label="Txns" col="txns" sort={sort} setSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {sortedAds.slice(0, 500).map((a, i) => {
                const managerUrl = a.aid
                  ? `https://adsmanager.facebook.com/adsmanager/manage/ads?${a.act ? `act=${a.act}&` : ""}selected_ad_ids=${a.aid}`
                  : null;
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #F5EDE5" }}>
                    <td style={{ ...td, fontSize: 10, fontFamily: "ui-monospace, monospace", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.ad_name}>{a.ad_name}</td>
                    <td style={{ ...td, textAlign: "center", width: 72 }}>
                      {managerUrl ? (
                        <a href={managerUrl} target="_blank" rel="noopener noreferrer"
                          title={`Open this ad in Ads Manager (Meta login required). Ad ID ${a.aid}`}
                          style={{ color: "#6B0010", textDecoration: "none", fontSize: 10, fontWeight: 600 }}>
                          Open ↗
                        </a>
                      ) : <span style={{ color: "#D8C8BC", fontSize: 10 }} title="No Ad ID in this period's export">—</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.spend)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.rev)}</td>
                    <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={a.metrics.roas} /></td>
                    <td style={{ ...td, textAlign: "right" }}>{a.metrics.cpa ? `$${a.metrics.cpa.toFixed(0)}` : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtPct(a.metrics.hook_rate)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtPct(a.metrics.hold_rate)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(a.metrics.txns)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortedAds.length > 500 && <p style={{ fontSize: 11, color: "#b0978f", marginTop: 12, textAlign: "center" }}>Showing top 500 — CSV export includes all {sortedAds.length.toLocaleString()}.</p>}
        </div>
      </div>
    </div>
  );
}

// --------- Sortable breakdown table (used across Concepts / Agencies / Creators / ICP) ---------
function BreakdownTable({ rows, nameLabel = "Name", onRowClick }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const cols = [
    { key: "name", label: nameLabel, align: "left" },
    { key: "creatives", label: "Ads" },
    { key: "spend", label: "Spend" },
    { key: "revenue", label: "Revenue" },
    { key: "roas", label: "ROAS" },
    { key: "cpa", label: "CPA" },
    { key: "purchases", label: "Purchases" },
    { key: "aov", label: "AOV" },
    { key: "hook_rate", label: "Hook" },
    { key: "hold_rate", label: "Hold" },
    { key: "cpm", label: "CPM" },
    { key: "winRate1k", label: "WR $1K" },
    { key: "winRate15k", label: "WR $15K" },
    { key: "winRate50k", label: "WR $50K" },
  ];
  const [limit, setLimit] = useState(300);
  const sorted = useMemo(() => sortRows(rows, sort.col, sort.dir), [rows, sort]);
  return (
    <>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
          {cols.map(c => <SortHeader key={c.key} label={c.label} col={c.key} sort={sort} setSort={setSort} align={c.align || "right"} />)}
        </tr>
      </thead>
      <tbody>
        {sorted.slice(0, limit).map((r, i) => (
          <tr key={i} onClick={() => onRowClick?.(r)} style={{ borderBottom: "1px solid #F5EDE5", cursor: onRowClick ? "pointer" : "default" }}
              onMouseEnter={e => onRowClick && (e.currentTarget.style.background = "#FBF7F4")}
              onMouseLeave={e => onRowClick && (e.currentTarget.style.background = "transparent")}>
            <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.creatives)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.revenue)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.roas} /></td>
            <td style={{ ...td, textAlign: "right" }}>{r.cpa ? `$${r.cpa.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.purchases)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.aov ? `$${r.aov.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }} title="3-second plays / impressions">{fmtPct(r.hook_rate)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }} title="ThruPlays / 3-second plays">{fmtPct(r.hold_rate)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.cpm ? `$${r.cpm.toFixed(1)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate1k)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate15k)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate50k)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {sorted.length > limit && (
      <div style={{ textAlign: "center", padding: 10, fontSize: 12, color: "#8a6f68" }}>
        Showing {limit.toLocaleString()} of {sorted.length.toLocaleString()} ·{" "}
        <button onClick={() => setLimit(limit + 500)} style={{ border: "1px solid #E8DCD0", background: "#fff", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}>Show 500 more</button>
      </div>
    )}
    </>
  );
}

// --------- Win Rate table with sortable columns ---------
function WinRateTable({ wrData }) {
  const [sort, setSort] = useState({ col: "month", dir: "desc" });
  const { total, rows } = useMemo(() => {
    const total = wrData.find(r => r.month === "TOTAL");
    const rest = wrData.filter(r => r.month !== "TOTAL");
    const mul = sort.dir === "desc" ? -1 : 1;
    const sorted = rest.slice().sort((a, b) => {
      if (sort.col === "month") return mul * a.month.localeCompare(b.month);
      if (sort.col === "total") return mul * (a.total - b.total);
      // threshold key — sort by rate
      const ra = a.thresholds[sort.col]?.rate ?? 0;
      const rb = b.thresholds[sort.col]?.rate ?? 0;
      return mul * (ra - rb);
    });
    return { total, rows: sorted };
  }, [wrData, sort]);
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <SortHeader label="Month" col="month" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Launched" col="total" sort={sort} setSort={setSort} />
            {THRESHOLDS.map(t => <SortHeader key={t} label={t} col={t} sort={sort} setSort={setSort} align="center" />)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #F5EDE5", opacity: row.flags?.length ? 0.45 : 1 }}
                title={row.flags?.length ? "Excluded from TOTAL and the trend line" : undefined}>
              <td style={td}>
                {row.month}
                {(row.flags || []).map(f => (
                  <span key={f} style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#F5EDE5", color: "#8a6f68", fontWeight: 600 }}>
                    {f === "pre" ? "survivors only" : f === "immature" ? "still ramping" : "small sample"}
                  </span>
                ))}
              </td>
              <td style={{ ...td, textAlign: "right" }}>{row.total.toLocaleString()}</td>
              {THRESHOLDS.map(t => {
                const d = row.thresholds[t];
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#50000B" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#8a6f68" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          ))}
          {total && (
            <tr style={{ borderBottom: "1px solid #F5EDE5", background: "#FBF7F4", fontWeight: 700 }}>
              <td style={td}>TOTAL <span style={{ fontWeight: 400, fontSize: 10, color: "#b0978f" }}>(clean months only)</span></td>
              <td style={{ ...td, textAlign: "right" }}>{total.total.toLocaleString()}</td>
              {THRESHOLDS.map(t => {
                const d = total.thresholds[t];
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#50000B" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#8a6f68" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// --------- Multi-dim grouping used by Analysis + Creator × Concept ---------
function multiGroupBy(ads, dims) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = dims.map(d => ad[d] ?? "(untagged)").join(" × ");
    if (!buckets.has(key)) buckets.set(key, { key, ads: [], values: dims.map(d => ad[d] ?? "(untagged)") });
    buckets.get(key).ads.push(ad);
  }
  return Array.from(buckets.values()).map(b => ({ name: b.key, values: b.values, ads: b.ads, ...aggregate(b.ads) }));
}


// ====================== Momentum ======================
// Latest window vs the window before it, per concept/script/agency/angle.
// Spend is compared per day because windows differ in length.
const MOMENTUM_DIMS = [["concept", "Concept"], ["creative_id", "Script"], ["agency", "Agency"], ["angle", "Angle"], ["format", "Format"], ["ad_name", "Ad"]];
const STATUS_STYLE = {
  New: { bg: "#dbeafe", fg: "#1e40af" }, Scaling: { bg: "#dcfce7", fg: "#166534" },
  Steady: { bg: "#F5EDE5", fg: "#8a6f68" }, Fading: { bg: "#fef9c3", fg: "#854d0e" },
  Stopped: { bg: "#fee2e2", fg: "#991b1b" },
};
function MomentumTab({ manifest, account, mappings, openModal }) {
  const cfg = manifest?.momentum;
  const [dim, setDim] = useState("concept");
  const [minSpend, setMinSpend] = useState(5000);
  const [status, setStatus] = useState("All");
  const [sort, setSort] = useState({ col: "lat_day", dir: "desc" });
  const days = (key) => {
    const p = (manifest?.periods || []).find(x => x.key === key);
    return p ? Math.round((new Date(p.end) - new Date(p.start)) / 864e5) + 1 : 1;
  };
  const rows = useMemo(() => {
    if (!cfg) return [];
    const dl = days(cfg.latest), dp = days(cfg.previous);
    const groups = new Map();
    for (const a0 of manifest.ads) {
      if (a0.p !== cfg.latest && a0.p !== cfg.previous) continue;
      if (account !== "__all" && a0.account !== account) continue;
      const a = { ...a0 };
      for (const [d, map] of Object.entries(mappings || {})) if (a[d] != null && map[a[d]]) a[d] = map[a[d]];
      const k = a[dim] ?? "(untagged)";
      if (!groups.has(k)) groups.set(k, { name: k, lat: [], prev: [] });
      groups.get(k)[a.p === cfg.latest ? "lat" : "prev"].push(a);
    }
    return [...groups.values()].map(g => {
      const L = aggregate(g.lat), P = aggregate(g.prev);
      const lat_day = L.spend / dl, prev_day = P.spend / dp;
      const change = prev_day ? (lat_day / prev_day - 1) * 100 : null;
      const st = !P.spend ? "New" : !L.spend ? "Stopped" : change >= 50 ? "Scaling" : change <= -50 ? "Fading" : "Steady";
      return { name: g.name, ads: [...g.lat, ...g.prev], status: st, lat_day, prev_day, change,
        lat_roas: L.spend ? L.roas : null, prev_roas: P.spend ? P.roas : null,
        roas_delta: L.spend && P.spend && L.roas != null && P.roas != null ? L.roas - P.roas : null,
        lat_cpa: L.cpa, total: L.spend + P.spend };
    }).filter(r => r.total >= minSpend);
  }, [manifest, cfg, dim, account, mappings, minSpend]);
  const counts = useMemo(() => rows.reduce((c, r) => (c[r.status] = (c[r.status] || 0) + 1, c), {}), [rows]);
  const shown = useMemo(() => {
    const list = status === "All" ? rows : rows.filter(r => r.status === status);
    return sortRows(list, sort.col, sort.dir);
  }, [rows, status, sort]);
  if (!cfg) return <div style={{ padding: 20, color: "#8a6f68" }}>Momentum needs two windows in the data.</div>;
  const lp = (manifest.periods || []).find(x => x.key === cfg.latest), pp = (manifest.periods || []).find(x => x.key === cfg.previous);
  const cols = [["name", MOMENTUM_DIMS.find(d => d[0] === dim)[1], "left"], ["status", "Status", "left"], ["prev_day", "Spend/day before"], ["lat_day", "Spend/day now"], ["change", "Δ spend/day"], ["prev_roas", "ROAS before"], ["lat_roas", "ROAS now"], ["roas_delta", "Δ ROAS"], ["lat_cpa", "CPA now"]];
  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "#3a2429", marginBottom: 10 }}>
          <b>Now</b> = {lp?.start} → {lp?.end} ({days(cfg.latest)} days) vs <b>before</b> = {pp?.start} → {pp?.end} ({days(cfg.previous)} days). Spend compared per day. Ignores the Period selector; follows the Ad account selector.
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={dim} onChange={e => setDim(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600 }}>
            {MOMENTUM_DIMS.map(([k, l]) => <option key={k} value={k}>Group by: {l}</option>)}
          </select>
          <select value={minSpend} onChange={e => setMinSpend(+e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600 }}>
            {[1000, 5000, 20000, 50000].map(v => <option key={v} value={v}>Min combined spend {fmt(v)}</option>)}
          </select>
          {["All", "New", "Scaling", "Steady", "Fading", "Stopped"].map(sv => (
            <button key={sv} onClick={() => setStatus(sv)} style={{ padding: "5px 10px", borderRadius: 14, border: "1px solid #D8C8BC", cursor: "pointer", fontSize: 11, fontWeight: 600,
              background: status === sv ? "#50000B" : (STATUS_STYLE[sv]?.bg || "#fff"), color: status === sv ? "#fff" : (STATUS_STYLE[sv]?.fg || "#8a6f68") }}>
              {sv} {sv === "All" ? rows.length : (counts[sv] || 0)}
            </button>
          ))}
        </div>
      </div>
      <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            {cols.map(([k, l, al]) => <SortHeader key={k} label={l} col={k} sort={sort} setSort={setSort} align={al || "right"} />)}
          </tr></thead>
          <tbody>
            {shown.slice(0, 300).map((r, i) => (
              <tr key={i} onClick={() => openModal(`${r.status}: ${r.name}`, `Spend/day ${fmt(r.prev_day)} → ${fmt(r.lat_day)}`, r.ads)}
                  style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer" }}>
                <td style={{ ...td, fontWeight: 600, maxWidth: 420 }}>{r.name}</td>
                <td style={td}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: STATUS_STYLE[r.status].bg, color: STATUS_STYLE[r.status].fg }}>{r.status}</span></td>
                <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmt(r.prev_day)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmt(r.lat_day)}</td>
                <td style={{ ...td, textAlign: "right", color: r.change == null ? "#b0978f" : r.change >= 0 ? "#166534" : "#991b1b" }}>{r.change == null ? "new" : `${r.change >= 0 ? "+" : ""}${r.change.toFixed(0)}%`}</td>
                <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.prev_roas} /></td>
                <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.lat_roas} /></td>
                <td style={{ ...td, textAlign: "right", color: r.roas_delta == null ? "#b0978f" : r.roas_delta >= 0 ? "#166534" : "#991b1b" }}>{r.roas_delta == null ? "—" : `${r.roas_delta >= 0 ? "+" : ""}${r.roas_delta.toFixed(2)}`}</td>
                <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.lat_cpa ? `$${r.lat_cpa.toFixed(0)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 300 && <p style={{ fontSize: 11, color: "#b0978f", textAlign: "center" }}>Showing top 300 of {shown.length}.</p>}
      </div>
    </div>
  );
}

// ====================== Agency scorecard ======================
// Per agency on the selected period: scripts launched (>= $100), how many
// reached each spend tier, spend share, and ROAS / CPA against the account.
function AgencyScorecard({ ads, openModal }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const rows = useMemo(() => {
    const acct = aggregate(ads);
    const by = new Map();
    for (const a of ads) {
      const k = a.agency ?? "(untagged)";
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(a);
    }
    return [...by.entries()].map(([name, list]) => {
      const g = aggregate(list);
      const scripts = toScripts(list).filter(s => (s.metrics.spend || 0) >= 100);
      const tier = (min) => scripts.filter(s => s.metrics.spend >= min).length;
      return {
        name, ads: list, scripts: scripts.length, w1k: tier(1000), w15k: tier(15000), w50k: tier(50000),
        hit1k: scripts.length ? tier(1000) / scripts.length * 100 : null,
        hit15k: scripts.length ? tier(15000) / scripts.length * 100 : null,
        spend: g.spend, share: acct.spend ? g.spend / acct.spend * 100 : 0,
        roas: g.roas, roas_idx: acct.roas ? (g.roas / acct.roas) * 100 : null,
        cpa: g.cpa, cpa_idx: acct.cpa && g.cpa ? (g.cpa / acct.cpa) * 100 : null,
        hook_rate: g.hook_rate, hold_rate: g.hold_rate,
      };
    }).filter(r => r.spend > 0);
  }, [ads]);
  const sorted = useMemo(() => sortRows(rows, sort.col, sort.dir), [rows, sort]);
  const idx = (v, goodHigh) => v == null ? "—" : (
    <span style={{ color: (goodHigh ? v >= 105 : v <= 95) ? "#166534" : (goodHigh ? v <= 95 : v >= 105) ? "#991b1b" : "#8a6f68", fontWeight: 600 }}>{v.toFixed(0)}</span>);
  const cols = [["name", "Agency", "left"], ["scripts", "Scripts ≥$100"], ["w1k", "≥$1K"], ["hit1k", "Hit $1K"], ["w15k", "≥$15K"], ["hit15k", "Hit $15K"], ["w50k", "≥$50K"], ["spend", "Spend"], ["share", "Share"], ["roas", "ROAS"], ["roas_idx", "ROAS idx"], ["cpa", "CPA"], ["cpa_idx", "CPA idx"], ["hook_rate", "Hook"], ["hold_rate", "Hold"]];
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto", marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Agency scorecard</h3>
      <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Scripts = unique creative IDs that spent ≥ $100 in the selected period. Index = agency vs account average (100 = average; ROAS higher is better, CPA lower is better).</p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ borderBottom: "2px solid #E8DCD0" }}>
          {cols.map(([k, l, al]) => <SortHeader key={k} label={l} col={k} sort={sort} setSort={setSort} align={al || "right"} />)}
        </tr></thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} onClick={() => openModal(`Agency: ${r.name}`, `${r.scripts} scripts · Spend ${fmt(r.spend)}`, r.ads)} style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer" }}>
              <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(r.scripts)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(r.w1k)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.hit1k)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(r.w15k)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.hit15k)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(r.w50k)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmt(r.spend)}</td>
              <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtPct(r.share)}</td>
              <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.roas} /></td>
              <td style={{ ...td, textAlign: "right" }}>{idx(r.roas_idx, true)}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.cpa ? `$${r.cpa.toFixed(0)}` : "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{idx(r.cpa_idx, false)}</td>
              <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtPct(r.hook_rate)}</td>
              <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtPct(r.hold_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
// ====================== Main component ======================
export default function Dashboard() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");

  // Win Rate state
  const [wrFormat, setWrFormat] = useState("blended");
  const [wrAgency, setWrAgency] = useState("__all");
  const [wrUnit, setWrUnit] = useState("script");
  const [wrFloor, setWrFloor] = useState(100);
  // Ad account filter. "__all" = blended Rosabella across every account.
  const [account, setAccount] = useState("__all");
  const [periodView, setPeriodView] = useState("all");
  const [wrThreshold, setWrThreshold] = useState("$1K");

  // Breakdowns state
  const [bdView, setBdView] = useState("Format");
  const [ccSearch, setCcSearch] = useState("");
  const [ccMinSpend, setCcMinSpend] = useState(5000);

  // Analysis state. Each "rule" is {dim, values:Set} — empty set = "all values for this dim".
  const [anRules, setAnRules] = useState([{ dim: "angle", values: new Set() }]);
  const [anMetric, setAnMetric] = useState("spend");
  const [anMinSpend, setAnMinSpend] = useState(0);
  const [anTopN, setAnTopN] = useState(20);
  const [anExclusions, setAnExclusions] = useState({}); // {dim: Set of excluded values} — secondary exclude-list filter

  // Data Clean Up state
  const [cleanDim, setCleanDim] = useState("angle");
  const [mappings, setMappings] = useState({}); // {dim: {oldVal: newVal}}
  const [cleanSelectedValue, setCleanSelectedValue] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Creation-date filter. Null = "full range"; otherwise YYMMDD strings.
  const [dateStart, setDateStart] = useState(null);
  const [dateEnd, setDateEnd] = useState(null);

  // Global modal state (shared across tabs)
  const [modalState, setModalState] = useState({ open: false, title: "", subtitle: "", ads: [] });
  const openModal = (title, subtitle, ads) => setModalState({ open: true, title, subtitle, ads });
  const closeModal = () => setModalState(s => ({ ...s, open: false }));

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/latest.json`, { cache: "no-cache" })
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(async m => {
        // Per-period ad files (see scripts/fetch_meta.py); concatenated here.
        if (m.ad_files?.length) {
          const parts = await Promise.all(m.ad_files.map(f =>
            fetch(`${import.meta.env.BASE_URL}data/${f}?v=${encodeURIComponent(m.generated_at || "")}`).then(r => {
              if (!r.ok) throw new Error(`${f}: ${r.status}`);
              return r.json();
            })));
          m = { ...m, ads: parts.flat() };
        }
        if (m.daily_file) {
          m.daily = await fetch(`${import.meta.env.BASE_URL}data/${m.daily_file}?v=${encodeURIComponent(m.generated_at || "")}`).then(r => r.ok ? r.json() : []).catch(() => []);
        }
        setManifest(m);
      })
      .catch(e => setError(String(e)));
    // Mappings are owned by GitHub (data/mappings.json) — fetch fresh every
    // load. The cache-buster prevents raw.githubusercontent.com's ~5 min CDN
    // cache from serving stale data right after a Save.
    fetch(`https://raw.githubusercontent.com/deniskims11/rosabella-creative-dashboard/main/data/mappings.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : {})
      .then(m => setMappings(m || {}))
      .catch(() => setMappings({}));
  }, []);

  // Period views. Each manifest period is a non-overlapping window; a view is
  // a set of windows that the merge folds into one record per creative.
  const periodViews = useMemo(() => {
    const ps = manifest?.periods ?? [];
    const fmtD = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return (manifest?.views ?? []).map(v => {
      const sel = ps.filter(p => v.keys.includes(p.key));
      const start = sel.map(p => p.start).sort()[0];
      const end = sel.map(p => p.end).sort().slice(-1)[0];
      return { ...v, start, end, label: `${v.label} · ${fmtD(start)} – ${fmtD(end)}` };
    });
  }, [manifest]);
  const activeView = periodViews.find(v => v.id === periodView) || periodViews[0];
  const periodAds = useMemo(() => mergePeriods(manifest?.ads ?? [], activeView ? activeView.keys : null), [manifest, activeView]);

  // Bounds of ad creation dates in the raw data (YYMMDD strings).
  const dateBounds = useMemo(() => {
    const dates = periodAds.map(a => a.date).filter(d => d && /^\d{6}$/.test(d));
    if (!dates.length) return null;
    return { min: dates.reduce((a, b) => a < b ? a : b), max: dates.reduce((a, b) => a > b ? a : b) };
  }, [periodAds]);

  // Apply mappings + creation-date filter to ads.
  const ads = useMemo(() => {
    let raw = periodAds;
    if (account !== "__all") raw = raw.filter(a => a.account === account);
    if (dateStart || dateEnd) {
      raw = raw.filter(a => {
        if (!a.date || !/^\d{6}$/.test(a.date)) return false;
        if (dateStart && a.date < dateStart) return false;
        if (dateEnd && a.date > dateEnd) return false;
        return true;
      });
    }
    if (!Object.keys(mappings).length) return raw;
    return raw.map(a => {
      const copy = { ...a };
      for (const [dim, map] of Object.entries(mappings)) {
        if (copy[dim] != null && map[copy[dim]]) copy[dim] = map[copy[dim]];
      }
      return copy;
    });
  }, [periodAds, mappings, dateStart, dateEnd, account]);

  // Accounts present in the data, biggest spender first, for the selector.
  const accountOptions = useMemo(() => {
    const m = new Map();
    for (const a of periodAds) {
      const k = a.account || "(unknown account)";
      const v = m.get(k) || { spend: 0, n: 0 };
      v.spend += a.metrics?.spend || 0; v.n += 1; m.set(k, v);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((x, y) => y.spend - x.spend);
  }, [manifest]);

  const totals = useMemo(() => aggregate(ads), [ads]);
  // Daily trend (whole data range, follows the account selector, not the
  // period selector). ROAS is a 7-day rolling ratio of sums.
  const dailyData = useMemo(() => {
    const rows = (manifest?.daily ?? []).filter(r => account === "__all" || r.account === account);
    const by = new Map();
    for (const r of rows) {
      const v = by.get(r.d) || { d: r.d, spend: 0, rev: 0 };
      v.spend += r.spend; v.rev += r.rev; by.set(r.d, v);
    }
    const days = [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
    return days.map((x, i) => {
      const win = days.slice(Math.max(0, i - 6), i + 1);
      const s = win.reduce((t, w) => t + w.spend, 0), rv = win.reduce((t, w) => t + w.rev, 0);
      return { ...x, roas7: s ? rv / s : null };
    });
  }, [manifest, account]);
  const [trendGrain, setTrendGrain] = useState("day");
  // Weekly view: Monday-start weeks, plain weekly ROAS.
  const trendData = useMemo(() => {
    if (trendGrain === "day") return dailyData;
    const by = new Map();
    for (const x of dailyData) {
      const dt = new Date(x.d + "T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const k = dt.toISOString().slice(0, 10);
      const v = by.get(k) || { d: k, spend: 0, rev: 0 };
      v.spend += x.spend; v.rev += x.rev; by.set(k, v);
    }
    return [...by.values()].sort((a, b) => a.d.localeCompare(b.d)).map(w => ({ ...w, roas7: w.spend ? w.rev / w.spend : null }));
  }, [dailyData, trendGrain]);

  // ROAS for a month that barely spent is noise; hide it below 2% of the
  // busiest month (and below $10K).
  const monthlyData = useMemo(() => {
    const rows = monthly(ads);
    const max = Math.max(0, ...rows.map(r => r.spend));
    return rows.map(r => (r.spend < Math.max(10000, max * 0.02) ? { ...r, roas: null } : r));
  }, [ads]);
  const wrAgencies = useMemo(() => dimensionValues(ads, "agency").filter(v => v.value !== "(untagged)"), [ads]);
  const wrData = useMemo(() => winRate(
    wrAgency === "__all" ? ads : ads.filter(a => (a.agency ?? "(untagged)") === wrAgency),
    wrFormat,
    { unit: wrUnit, floor: wrFloor, dataStart: activeView?.start, dataEnd: activeView?.end },
  ), [ads, wrFormat, wrAgency, wrUnit, wrFloor, activeView]);
  const concepts = useMemo(() => toBreakdownRows(groupBy(ads, "concept")), [ads]);
  const angles = useMemo(() => toBreakdownRows(groupBy(ads, "angle")), [ads]);
  const agencies = useMemo(() => toBreakdownRows(groupBy(ads, "agency")), [ads]);
  const creators = useMemo(() => toBreakdownRows(groupBy(ads.filter(a => a.creator), "creator")), [ads]);
  const products = useMemo(() => toBreakdownRows(groupBy(ads, "product")), [ads]);
  const awareness = useMemo(() => toBreakdownRows(groupBy(ads, "awareness")), [ads]);
  const accounts = useMemo(() => toBreakdownRows(groupBy(ads, "account")), [ads]);
  const medias = useMemo(() => toBreakdownRows(groupBy(ads, "media")), [ads]);
  const formats = useMemo(() => toBreakdownRows(groupBy(ads, "format")), [ads]);

  // Creator × Concept with filter
  const creatorConceptGroups = useMemo(() => {
    const filtered = ads.filter(a =>
      (a.metrics.spend || 0) >= ccMinSpend &&
      (!ccSearch || [a.angle, a.concept].some(v => (v || "").toLowerCase().includes(ccSearch.toLowerCase())))
    );
    return multiGroupBy(filtered, ["angle", "concept"])
      .map(g => ({ ...g, name: g.values.join(" × ") }))
      .sort((a, b) => b.spend - a.spend);
  }, [ads, ccMinSpend, ccSearch]);

  // ---- Analysis: apply inclusion rules, exclusions, then build tree ----
  const analysisAds = useMemo(() => {
    return ads.filter(a => {
      // Inclusion: for each rule with selected values, ad must match
      for (const rule of anRules) {
        if (!rule.dim || rule.values.size === 0) continue;
        const v = a[rule.dim] ?? "(untagged)";
        if (!rule.values.has(v)) return false;
      }
      // Exclusions
      for (const [dim, excluded] of Object.entries(anExclusions)) {
        if (excluded.size === 0) continue;
        const v = a[dim] ?? "(untagged)";
        if (excluded.has(v)) return false;
      }
      return true;
    });
  }, [ads, anRules, anExclusions]);

  // Build tree: dims = anRules ordered
  const analysisTree = useMemo(() => {
    const dims = anRules.map(r => r.dim).filter(Boolean);
    if (dims.length === 0) return [];
    const build = (ads, dimsLeft) => {
      const [d, ...rest] = dimsLeft;
      const groups = new Map();
      for (const ad of ads) {
        const v = ad[d] ?? "(untagged)";
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(ad);
      }
      return Array.from(groups.entries())
        .map(([v, rows]) => ({
          value: v,
          dim: d,
          ads: rows,
          agg: aggregate(rows),
          children: rest.length ? build(rows, rest) : null,
        }))
        .filter(n => n.agg.spend >= anMinSpend || dimsLeft.length < dims.length)
        .sort((a, b) => (b.agg[anMetric] ?? 0) - (a.agg[anMetric] ?? 0));
    };
    const root = build(analysisAds, dims);
    // Top-level: respect topN + min spend
    return root.filter(n => n.agg.spend >= anMinSpend).slice(0, anTopN);
  }, [analysisAds, anRules, anMetric, anMinSpend, anTopN]);

  // Flat list for the chart (top-level nodes only)
  const analysisChartData = useMemo(() =>
    analysisTree.map(n => ({ name: n.value, ...n.agg })),
    [analysisTree]
  );

  // Dimension values per dim (for exclude filter + Data Clean Up).
  const cleanValuesForDim = useMemo(() => dimensionValues(ads, cleanDim), [ads, cleanDim]);

  // Data Clean Up: sample ads for the selected value
  const cleanSampleAds = useMemo(() => {
    if (!cleanSelectedValue) return [];
    const target = cleanSelectedValue === "(untagged)" ? null : cleanSelectedValue;
    return ads.filter(a => a[cleanDim] === target || (a[cleanDim] == null && cleanSelectedValue === "(untagged)"));
  }, [ads, cleanDim, cleanSelectedValue]);

  // Mapping editor helpers
  const setMapping = (dim, oldVal, newVal) => {
    setMappings(m => {
      const nextDim = { ...(m[dim] || {}) };
      if (!newVal || newVal === oldVal) delete nextDim[oldVal];
      else nextDim[oldVal] = newVal;
      const next = { ...m, [dim]: nextDim };
      if (!Object.keys(nextDim).length) delete next[dim];
      return next;
    });
  };

  const [saveState, setSaveState] = useState({ status: "idle", msg: "" }); // idle | saving | ok | err
  const [patModalOpen, setPatModalOpen] = useState(false);
  const [categoryInspector, setCategoryInspector] = useState(null); // {dim, target} | null

  const pushToGithub = async (pat) => {
    setSaveState({ status: "saving", msg: "Pushing to GitHub…" });
    const repo = "deniskims11/creative-dashboard";
    const path = "data/mappings.json";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = { Authorization: `token ${pat.trim()}`, Accept: "application/vnd.github+json" };
    // Every fetch gets a 30s AbortController so nothing hangs silently.
    const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };
    try {
      let sha;
      const t1 = withTimeout(30000);
      const head = await fetch(api, { headers, signal: t1.signal }); t1.done();
      if (head.ok) sha = (await head.json()).sha;
      else if (head.status !== 404) throw new Error(`GET ${path}: ${head.status}`);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(mappings, null, 2))));
      const t2 = withTimeout(30000);
      const put = await fetch(api, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: t2.signal,
        body: JSON.stringify({
          message: `chore(mappings): update via dashboard @ ${new Date().toISOString()}`,
          content,
          ...(sha ? { sha } : {}),
        }),
      }); t2.done();
      if (!put.ok) {
        const body = await put.text();
        if (put.status === 401 || put.status === 403) {
          try { localStorage.removeItem("rb_creative_dashboard_gh_pat"); } catch {}
          setSaveState({ status: "err", msg: "Saved token rejected. Re-enter PAT." });
          setPatModalOpen(true);
          return;
        }
        throw new Error(`${put.status}: ${body.slice(0, 200)}`);
      }
      const res = await put.json();
      const sha7 = res.commit?.sha?.slice(0, 7) || "ok";
      setSaveState({ status: "ok", msg: `Committed — ${sha7}` });
      window.alert(`✓ Mappings pushed to GitHub (commit ${sha7}). Next data refresh will re-apply them to latest.json.`);
    } catch (err) {
      console.error("[saveMappings]", err);
      const msg = err.name === "AbortError" ? "Timed out after 30s — check network / PAT and retry." : String(err).slice(0, 300);
      setSaveState({ status: "err", msg });
      window.alert(`Save failed: ${msg}`);
    }
  };

  // Safe localStorage helpers — the github.io origin is shared across every
  // Pages site on this account, so the quota can be exhausted by a sibling.
  const safeLocalSet = (key, value) => {
    try { localStorage.setItem(key, value); return true; }
    catch (err) { console.warn(`[localStorage full] failed to set ${key}:`, err.message); return false; }
  };
  const safeLocalGet = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };

  const saveMappings = () => {
    // Immediate visible state so the user always sees the click register, even
    // if the button handler hands off to a modal or a slow API call.
    setSaveState({ status: "saving", msg: "Saving…" });
    setSavedAt(new Date());
    const pat = safeLocalGet("rb_creative_dashboard_gh_pat");
    if (pat) pushToGithub(pat);
    else { setPatModalOpen(true); setSaveState({ status: "idle", msg: "" }); }
  };

  const handlePatSaved = (pat) => {
    safeLocalSet("rb_creative_dashboard_gh_pat", pat.trim());
    setPatModalOpen(false);
    pushToGithub(pat);
  };

  const handlePatSkipped = () => {
    setPatModalOpen(false);
    const blob = new Blob([JSON.stringify(mappings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mappings.json"; a.click();
    URL.revokeObjectURL(url);
    setSaveState({ status: "ok", msg: "Downloaded mappings.json (skipped GitHub sync)" });
  };

  const clearGithubPat = () => {
    try { localStorage.removeItem("rb_creative_dashboard_gh_pat"); } catch {}
    setSaveState({ status: "ok", msg: "GitHub token cleared — you'll be prompted on next save." });
  };

  if (error) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#991b1b" }}>Error loading data: {error}</div>;
  if (!manifest) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#8a6f68" }}>Loading Meta data…</div>;

  const ALL_DIMS_LABELS = {
    media: "Video vs Static", angle: "Angle", angle_detail: "Angle (detail)", stage: "Testing phase (TP)", format: "Format", concept: "Concept", product: "Product",
    awareness: "Awareness", agency: "Agency", creator: "Creator",
    creative_id: "Creative ID", version: "Version", build: "New / Var",
    offer: "Offer", funnel: "Funnel", buying_type: "Buying Type", geo: "Geo",
    account: "Ad Account", convention: "Naming Convention",
  };

  const METRIC_MAP = {
    spend: { label: "Spend", fmt },
    rev: { label: "Revenue", fmt },
    roas: { label: "ROAS", fmt: v => v == null ? "—" : `${v.toFixed(2)}x` },
    cpa: { label: "CPA", fmt: v => v == null ? "—" : `$${v.toFixed(0)}` },
    count: { label: "# Creatives", fmt: fmtNum },
    txns: { label: "Purchases", fmt: fmtNum },
    cpm: { label: "CPM", fmt: v => v == null ? "—" : `$${v.toFixed(2)}` },
    aov: { label: "AOV", fmt: v => v == null ? "—" : `$${v.toFixed(0)}` },
  };

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#FAF6F2", minHeight: "100vh", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ borderBottom: "1px solid #E8DCD0", paddingBottom: 18, marginBottom: 22 }}>
          <h1 style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 32, fontWeight: 500, color: "#1A0205", margin: 0, letterSpacing: -0.5, lineHeight: 1.15 }}>
            Rosabella Meta Creative Performance
          </h1>
          <p style={{ color: "#8a6f68", fontSize: 12, margin: "6px 0 4px", letterSpacing: 0.2 }}>
            {(activeView?.start ?? manifest.period.start).slice(0, 10)} → {(activeView?.end ?? manifest.period.end).slice(0, 10)} · {ads.length.toLocaleString()} creatives · Attribution: {manifest.attribution?.primary ?? '—'}
            {manifest.source_label && <> · Source: {manifest.source_label}</>}
          </p>
          {(accountOptions.length > 1 || periodViews.length > 1) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px", flexWrap: "wrap" }}>
              {periodViews.length > 1 && <>
                <span style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Period</span>
                <select value={activeView?.id} onChange={e => setPeriodView(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 13, fontWeight: 600, color: "#50000B", background: "#fff", marginRight: 12 }}>
                  {periodViews.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              </>}
              <span style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Ad account</span>
              <select value={account} onChange={e => setAccount(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 13, fontWeight: 600, color: "#50000B", background: "#fff" }}>
                <option value="__all">All Rosabella (blended) · {fmt(accountOptions.reduce((t, o) => t + o.spend, 0))}</option>
                {accountOptions.map(o => <option key={o.name} value={o.name}>{o.name} · {fmt(o.spend)}</option>)}
              </select>
            </div>
          )}
          <p style={{ color: "#a89089", fontSize: 11, margin: 0 }}>
            Last refreshed: {new Date(manifest.generated_at).toLocaleString()} · {Object.keys(mappings).length} dims mapped
          </p>
        </div>

        <DateRangePicker
          bounds={dateBounds}
          start={dateStart}
          end={dateEnd}
          setStart={setDateStart}
          setEnd={setDateEnd}
        />

        <div style={{ display: "flex", gap: 0, marginBottom: 22, borderBottom: "1px solid #E8DCD0", overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "12px 18px", border: "none", borderRadius: 0, cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
              letterSpacing: 0.6, textTransform: "uppercase",
              background: "transparent",
              color: tab === t ? "#50000B" : "#8a6f68",
              borderBottom: tab === t ? "2px solid #50000B" : "2px solid transparent",
              marginBottom: -1, transition: "color 0.15s, border-color 0.15s",
            }}>{t}</button>
          ))}
        </div>

        {tab === "Overview" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Spend", value: fmt(totals.spend), sub: "Meta-reported" },
                { label: "Total Revenue", value: fmt(totals.rev), sub: totals.rev == null ? "Not in this export" : "Meta-reported purchases value" },
                totals.roas == null
                  ? { label: "Blended CPA", value: totals.cpa ? `$${totals.cpa.toFixed(2)}` : "—", sub: "spend / purchases" }
                  : { label: "Blended ROAS", value: `${totals.roas.toFixed(2)}x`, sub: "rev / spend" },
                totals.roas == null
                  ? { label: "CPM", value: `$${totals.cpm.toFixed(2)}`, sub: `Link CTR ${fmtPct(totals.ctr)}` }
                  : { label: "CPA", value: totals.cpa ? `$${totals.cpa.toFixed(2)}` : "—", sub: `CPM $${totals.cpm.toFixed(2)}` },
                { label: "Total Purchases", value: fmtNum(totals.txns), sub: `${ads.length.toLocaleString()} creatives` },
              ].map((kpi, i) => (
                <div key={i} style={{ background: "#fff", borderRadius: 10, padding: "16px 14px", border: "1px solid #E8DCD0" }}>
                  <div style={{ fontSize: 10, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{kpi.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#50000B", marginTop: 4 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: "#b0978f", marginTop: 2 }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            {dailyData.length > 0 && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>{trendGrain === "day" ? "Daily spend & 7-day ROAS" : "Weekly spend & ROAS"}</h3>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[["day", "Daily"], ["week", "Weekly"]].map(([k, l]) => (
                      <button key={k} onClick={() => setTrendGrain(k)} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid #E8DCD0", background: trendGrain === k ? "#3a2429" : "#fff", color: trendGrain === k ? "#fff" : "#3a2429" }}>{l}</button>
                    ))}
                  </div>
                </div>
                <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Calendar {trendGrain === "day" ? "days" : "weeks (Mon start)"} ({dailyData[0].d} → {dailyData[dailyData.length - 1].d}), all spend incl. deleted campaigns. Follows the Ad account selector, not the Period selector.</p>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                    <XAxis dataKey="d" tick={{ fontSize: 10, fill: "#b0978f" }} minTickGap={30} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => fmt(v)} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} domain={[0, "auto"]} tickFormatter={v => `${Number(v).toFixed(1)}x`} />
                    <Tooltip formatter={(v, n) => v == null ? "—" : (n === "7-day ROAS" || n === "ROAS") ? `${v.toFixed(2)}x` : fmtFull(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="spend" fill="#93c5fd" name="Spend" />
                    <Line yAxisId="right" dataKey="roas7" stroke="#f97316" strokeWidth={2} dot={false} name={trendGrain === "day" ? "7-day ROAS" : "ROAS"} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#3a2429" }}>Monthly Spend vs Revenue & ROAS (by ad creation month)</h3>
              <p style={{ fontSize: 11, color: "#b0978f", margin: "-10px 0 10px" }}>Grouped by the month each ad was launched; ROAS is hidden for months that barely spent.</p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => fmt(v)} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} domain={[0, "auto"]} allowDataOverflow={false} tickFormatter={v => `${Number(v).toFixed(1)}x`} />
                  <Tooltip formatter={(v, n) => v == null ? "—" : n === "ROAS" ? `${v.toFixed(2)}x` : fmtFull(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="spend" fill="#93c5fd" name="Spend" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey="revenue" fill="#86efac" name="Revenue" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" dataKey="roas" stroke="#f97316" strokeWidth={2.5} dot={{ r: 4 }} name="ROAS" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0" }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#3a2429" }}>Monthly Creative Volume (Video vs Static)</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="video" fill="#818cf8" name="Video" stackId="a" />
                  <Bar dataKey="image" fill="#fbbf24" name="Static" stackId="a" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {tab === "Win Rate" && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 3, background: "#E8DCD0", borderRadius: 6, padding: 2 }}>
                {["blended", "video", "image"].map(f => (
                  <button key={f} onClick={() => setWrFormat(f)} style={{
                    padding: "6px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
                    background: wrFormat === f ? "#fff" : "transparent", color: wrFormat === f ? "#50000B" : "#8a6f68",
                  }}>{f === "blended" ? "All" : f === "video" ? "Video" : "Static"}</button>
                ))}
              </div>
              <select value={wrThreshold} onChange={e => setWrThreshold(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                {THRESHOLDS.map(t => <option key={t} value={t}>Threshold: {t}</option>)}
              </select>
              <select value={wrUnit} onChange={e => setWrUnit(e.target.value)} title="Count each script (creative ID) once, or every ad name separately"
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                <option value="script">Count: per script</option>
                <option value="ad">Count: per ad name</option>
              </select>
              <select value={wrFloor} onChange={e => setWrFloor(+e.target.value)} title="Only count launches that spent at least this much"
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                <option value={0}>Launched = any spend</option>
                <option value={100}>Launched = $100+ spend</option>
                <option value={500}>Launched = $500+ spend</option>
              </select>
              <select value={wrAgency} onChange={e => setWrAgency(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontWeight: 600, color: "#3a2429" }}>
                <option value="__all">Agency: All</option>
                {wrAgencies.map(v => <option key={v.value} value={v.value}>Agency: {v.value} ({v.n})</option>)}
              </select>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #E8DCD0", marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>
                Win Rate Trend — {wrThreshold} ({wrFormat === "blended" ? "All" : wrFormat === "video" ? "Video Only" : "Static Only"}){wrAgency !== "__all" && ` · Agency ${wrAgency}`}
              </h3>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={wrData.filter(d => d.month !== "TOTAL")}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F5EDE5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#b0978f" }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#b0978f" }} tickFormatter={v => `${v}%`} />
                  <Tooltip formatter={(v, n) => n === "Win Rate" ? `${v.toFixed(1)}%` : v} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="total" fill="#D8C8BC" name="Total Launched" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" stroke="#ef4444" strokeWidth={2.5} dot={{ r: 4 }} name="Win Rate"
                    connectNulls dataKey={(d) => (d.flags && d.flags.length) ? null : (d.thresholds[wrThreshold]?.rate || 0)} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 8px" }}>
              Greyed months are excluded from the trend line and the TOTAL: <b>survivors only</b> (launched before the data window, so only ads that kept spending are visible), <b>still ramping</b> (launched in the last 14 days), or <b>small sample</b> (fewer than 20 launches).
            </p>
            <WinRateTable wrData={wrData} />
          </div>
        )}

        {tab === "Angles" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Angle Performance ({angles.length} angles) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <BreakdownTable rows={angles} nameLabel="Angle" onRowClick={r => openModal(`Angle: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Concepts" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Concept Performance ({concepts.length} concepts) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <BreakdownTable rows={concepts} nameLabel="Concept" onRowClick={r => openModal(`Concept: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Momentum" && <MomentumTab manifest={manifest} account={account} mappings={mappings} openModal={openModal} />}

        {tab === "Agencies" && <AgencyScorecard ads={ads} openModal={openModal} />}
        {tab === "Agencies" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Agency Performance ({agencies.length}) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Agency = letter prefix of the creative ID in the ad name (PRME609 → PR, CA683 → CA, JK178 → JK). Trybe creator ads roll up under "Trybe".</p>
            <BreakdownTable rows={agencies} nameLabel="Agency" onRowClick={r => openModal(`Agency: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Creators" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Creator Performance ({creators.length} creators) · <span style={{ fontWeight: 400, color: "#b0978f" }}>click a row to drill into creatives</span></h3>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Trybe creator ads (named Creator_Product_Angle trybe=…).</p>
            <BreakdownTable rows={creators} nameLabel="Creator" onRowClick={r => openModal(`Creator: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Breakdowns" && (
          <div>
            <div style={{ display: "flex", gap: 3, background: "#E8DCD0", borderRadius: 6, padding: 2, marginBottom: 16, width: "fit-content" }}>
              {["Video vs Static", "Format", "Product", "Awareness", "Ad Account", "Angle × Concept"].map(v => (
                <button key={v} onClick={() => setBdView(v)} style={{
                  padding: "6px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: bdView === v ? "#fff" : "transparent", color: bdView === v ? "#50000B" : "#8a6f68",
                }}>{v}</button>
              ))}
            </div>

            {bdView === "Format" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Format ({formats.length} formats)</h3>
                <BreakdownTable rows={formats} nameLabel="Format" onRowClick={r => openModal(`Format: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Video vs Static" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Video vs Static · <span style={{ fontWeight: 400, color: "#b0978f" }}>drill further in the Analysis tab (e.g. Video vs Static → Format → Angle)</span></h3>
                <BreakdownTable rows={medias} nameLabel="Media" onRowClick={r => openModal(`Media: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Product" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Product ({products.length})</h3>
                <BreakdownTable rows={products} nameLabel="Product" onRowClick={r => openModal(`Product: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Awareness" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Awareness ({awareness.length})</h3>
                <BreakdownTable rows={awareness} nameLabel="Awareness" onRowClick={r => openModal(`Awareness: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Ad Account" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>Performance by Ad Account ({accounts.length})</h3>
                <BreakdownTable rows={accounts} nameLabel="Ad Account" onRowClick={r => openModal(`Ad Account: ${r.name}`, `${r.creatives} creatives · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Angle × Concept" && (
              <div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <input type="text" placeholder="Search angle or concept..." value={ccSearch} onChange={e => setCcSearch(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, width: 240 }} />
                  <label style={{ fontSize: 12, color: "#8a6f68" }}>Min spend: <strong style={{ color: "#50000B" }}>{fmt(ccMinSpend)}</strong></label>
                  <input type="range" min={0} max={500000} step={1000} value={ccMinSpend} onChange={e => setCcMinSpend(+e.target.value)} style={{ width: 200 }} />
                  <span style={{ fontSize: 12, color: "#b0978f" }}>{creatorConceptGroups.length} rows · click to drill in</span>
                </div>
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
                  <BreakdownTable rows={creatorConceptGroups.map(g => ({
                    name: g.name, creatives: g.count, ads: g.ads, spend: g.spend, revenue: g.rev, roas: g.roas,
                    cpa: g.cpa, purchases: g.txns, aov: g.aov, cpm: g.cpm,
                    winRate1k: (g.ads.filter(a => (a.metrics.spend||0) >= 1000).length / (g.ads.length||1)) * 100,
                    winRate15k: (g.ads.filter(a => (a.metrics.spend||0) >= 15000).length / (g.ads.length||1)) * 100,
                    winRate50k: (g.ads.filter(a => (a.metrics.spend||0) >= 50000).length / (g.ads.length||1)) * 100,
                  }))} nameLabel="Angle × Concept" onRowClick={r => openModal(r.name, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "Analysis" && (
          <AnalysisTab
            ads={ads}
            ALL_DIMS_LABELS={ALL_DIMS_LABELS}
            METRIC_MAP={METRIC_MAP}
            anRules={anRules} setAnRules={setAnRules}
            anMetric={anMetric} setAnMetric={setAnMetric}
            anMinSpend={anMinSpend} setAnMinSpend={setAnMinSpend}
            anTopN={anTopN} setAnTopN={setAnTopN}
            anExclusions={anExclusions} setAnExclusions={setAnExclusions}
            analysisTree={analysisTree}
            analysisChartData={analysisChartData}
            openModal={openModal}
          />
        )}

        {tab === "Data Clean Up" && (
          <div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 12, gap: 12 }}>
                <p style={{ fontSize: 12, color: "#8a6f68", margin: 0, maxWidth: 720 }}>
                  Review unique values parsed from ad names. Click any value to preview 10 sample ads + download full CSV.
                  Use <strong>Edit</strong> to reclassify a value into an existing category or create a new one (e.g. <code>MULTIPLESUPP</code> → <code>MULTISUPP</code>).
                  Save pushes <code>data/mappings.json</code> to GitHub so the next data refresh picks it up.
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {saveState.status === "ok" && <span style={{ fontSize: 11, color: "#16a34a", maxWidth: 240 }} title={saveState.msg}>✓ {saveState.msg}</span>}
                  {saveState.status === "err" && <span style={{ fontSize: 11, color: "#dc2626", maxWidth: 240 }} title={saveState.msg}>✕ {saveState.msg}</span>}
                  {saveState.status === "saving" && <span style={{ fontSize: 11, color: "#8a6f68" }}>Saving…</span>}
                  {savedAt && saveState.status === "idle" && <span style={{ fontSize: 11, color: "#16a34a" }}>Saved {savedAt.toLocaleTimeString()}</span>}
                  <button onClick={saveMappings} disabled={saveState.status === "saving"}
                    style={{ padding: "6px 14px", border: "none", background: saveState.status === "saving" ? "#b0978f" : "#50000B", color: "#fff", borderRadius: 6, cursor: saveState.status === "saving" ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>
                    Save mappings
                  </button>
                  <button onClick={clearGithubPat} title="Clear saved GitHub token"
                    style={{ padding: "6px 8px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>
                    ⚙
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {DIMENSIONS.map(d => {
                  const mapped = Object.keys(mappings[d] || {}).length;
                  return (
                    <button key={d} onClick={() => { setCleanDim(d); setCleanSelectedValue(null); }} style={{
                      padding: "4px 10px", border: "1px solid #D8C8BC", borderRadius: 5, cursor: "pointer",
                      fontSize: 12, fontWeight: 600,
                      background: cleanDim === d ? "#50000B" : "#fff",
                      color: cleanDim === d ? "#fff" : "#8a6f68",
                    }}>{d}{mapped > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: cleanDim === d ? "#86efac" : "#16a34a" }}>· {mapped}</span>}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: cleanSelectedValue ? "1fr 380px" : "1fr", gap: 16 }}>
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#3a2429" }}>
                  {cleanDim} — {cleanValuesForDim.length} unique values
                </h3>
                <CleanupTable values={cleanValuesForDim} mappings={mappings[cleanDim] || {}} setMapping={(o, n) => setMapping(cleanDim, o, n)} selected={cleanSelectedValue} onSelect={setCleanSelectedValue}
                  onInspectCategory={(target) => setCategoryInspector({ dim: cleanDim, target })} />
              </div>

              {cleanSelectedValue && (
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#3a2429" }}>Sample ads: <code>{cleanSelectedValue}</code></h3>
                    <button onClick={() => setCleanSelectedValue(null)} style={{ border: "none", background: "transparent", color: "#b0978f", cursor: "pointer", fontSize: 14 }}>×</button>
                  </div>
                  <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>
                    {cleanSampleAds.length} ads · showing 10 ·
                    <button onClick={() => openModal(`${cleanDim}=${cleanSelectedValue}`, `${cleanSampleAds.length} ads`, cleanSampleAds)}
                      style={{ marginLeft: 6, border: "none", background: "transparent", color: "#6B0010", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>see all / download CSV</button>
                  </p>
                  <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#3a2429", maxHeight: 400, overflowY: "auto" }}>
                    {cleanSampleAds.slice(0, 10).map((a, i) => (
                      <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #F5EDE5", wordBreak: "break-all" }}>
                        <div style={{ fontSize: 10, color: "#b0978f" }}>{fmt(a.metrics.spend)} spend · {fmtNum(a.metrics.txns)} txns</div>
                        {a.ad_name}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AdListModal open={modalState.open} title={modalState.title} subtitle={modalState.subtitle} ads={modalState.ads} onClose={closeModal} />
      <PatModal open={patModalOpen} onSave={handlePatSaved} onSkip={handlePatSkipped} onClose={() => setPatModalOpen(false)} />
      {categoryInspector && (
        <CategoryMembersModal
          dim={categoryInspector.dim}
          target={categoryInspector.target}
          mappings={mappings}
          values={dimensionValues(periodAds, categoryInspector.dim)}
          onRemove={(raw) => setMapping(categoryInspector.dim, raw, "")}
          onClose={() => setCategoryInspector(null)}
        />
      )}
    </div>
  );
}

// -------- Cleanup table subcomponent (sortable, clickable, Edit-popover) --------
function CleanupTable({ values, mappings, setMapping, selected, onSelect, onInspectCategory }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const [editingValue, setEditingValue] = useState(null);

  const sorted = useMemo(() => {
    const mul = sort.dir === "desc" ? -1 : 1;
    return values.slice().sort((a, b) => {
      const va = a[sort.col], vb = b[sort.col];
      if (typeof va === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [values, sort]);

  // Union of raw values + existing mapping targets — these are the "categories" available.
  const categories = useMemo(() => {
    const set = new Set(values.map(v => v.value));
    for (const target of Object.values(mappings)) if (target) set.add(target);
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
  }, [values, mappings]);

  // Reverse index: for each target, list of raw values that merge into it.
  const mergedInto = useMemo(() => {
    const m = {};
    for (const [raw, target] of Object.entries(mappings)) {
      if (!target) continue;
      (m[target] ||= []).push(raw);
    }
    return m;
  }, [mappings]);

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
            <SortHeader label="Value" col="value" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Ads" col="n" sort={sort} setSort={setSort} />
            <SortHeader label="Total Spend" col="spend" sort={sort} setSort={setSort} />
            <th style={{ ...th, textAlign: "left" }}>Mapped to</th>
            <th style={{ ...th, textAlign: "right" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 300).map((v) => {
            const mapped = mappings[v.value];
            return (
              <tr key={v.value} onClick={() => onSelect(v.value)}
                  style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer", background: selected === v.value ? "#FDE9BF" : "transparent" }}>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{v.value}</td>
                <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(v.n)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmt(v.spend)}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }} onClick={e => e.stopPropagation()}>
                  {mapped ? (
                    <button onClick={() => onInspectCategory?.(mapped)}
                      title="Click to see everything merged into this master category"
                      style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                      {mapped} ↗
                    </button>
                  ) : mergedInto[v.value]?.length ? (
                    <button onClick={() => onInspectCategory?.(v.value)}
                      title={`${mergedInto[v.value].length} value(s) merged into this master category — click to see`}
                      style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                      +{mergedInto[v.value].length} merged ↗
                    </button>
                  ) : <span style={{ color: "#D8C8BC" }}>—</span>}
                </td>
                <td style={{ ...td, textAlign: "right" }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => setEditingValue(v.value)}
                    style={{ padding: "3px 10px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#3a2429" }}>
                    Edit
                  </button>
                  {mapped && (
                    <button onClick={() => setMapping(v.value, "")} title="Clear mapping"
                      style={{ marginLeft: 4, padding: "3px 6px", border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editingValue != null && (
        <EditCategoryModal
          value={editingValue}
          current={mappings[editingValue] || ""}
          categories={categories.filter(c => c !== editingValue)}
          onSave={(newVal) => { setMapping(editingValue, newVal); setEditingValue(null); }}
          onClose={() => setEditingValue(null)}
        />
      )}
    </>
  );
}

// -------- GitHub PAT entry modal (replaces window.prompt which Pages can block) --------
function PatModal({ open, onSave, onSkip, onClose }) {
  const [pat, setPat] = useState("");
  if (!open) return null;
  const submit = () => { if (pat.trim()) onSave(pat); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 480, boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#50000B" }}>Sync mappings to GitHub</div>
          <div style={{ fontSize: 12, color: "#8a6f68", marginTop: 4 }}>Paste a GitHub Personal Access Token to push <code>data/mappings.json</code> to the repo. Stored in this browser only.</div>
        </div>
        <div style={{ padding: "14px 18px" }}>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: "#6B0010", textDecoration: "none", fontWeight: 600 }}>Create a fine-grained PAT (repo contents: R&W) →</a>
          <input
            type="password"
            autoFocus
            value={pat}
            onChange={e => setPat(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
            placeholder="github_pat_... or ghp_..."
            style={{ width: "100%", marginTop: 10, padding: "8px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontFamily: "ui-monospace, monospace" }}
          />
          <div style={{ fontSize: 10, color: "#b0978f", marginTop: 6 }}>Token stays in localStorage. Clear it anytime via the ⚙ button on the Data Clean Up tab.</div>
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #E8DCD0", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onSkip}
            style={{ padding: "6px 12px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            Skip (download JSON)
          </button>
          <button onClick={submit} disabled={!pat.trim()}
            style={{ padding: "6px 14px", border: "none", background: pat.trim() ? "#50000B" : "#D8C8BC", color: "#fff", borderRadius: 6, cursor: pat.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600 }}>
            Save & push to GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

// -------- Category members modal — shows all raw values currently resolving to a target --------
function CategoryMembersModal({ dim, target, mappings, values, onRemove, onClose }) {
  const dimMappings = mappings[dim] || {};
  // Members = raw values explicitly mapped to this target, plus the target itself if it's a native raw value.
  const members = useMemo(() => {
    const mapped = Object.entries(dimMappings).filter(([, t]) => t === target).map(([raw]) => raw);
    const self = values.find(v => v.value === target) && !dimMappings[target] ? [target] : [];
    const all = [...new Set([...self, ...mapped])];
    return all.map(raw => {
      const stat = values.find(v => v.value === raw);
      return { raw, n: stat?.n ?? 0, spend: stat?.spend ?? 0, isSelf: raw === target && !dimMappings[raw] };
    }).sort((a, b) => b.spend - a.spend);
  }, [dim, target, mappings, values, dimMappings]);
  const totals = members.reduce((a, m) => ({ n: a.n + m.n, spend: a.spend + m.spend }), { n: 0, spend: 0 });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2050, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 11, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Master category · {dim}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#50000B", fontFamily: "ui-monospace, monospace" }}>{target}</div>
          <div style={{ fontSize: 11, color: "#8a6f68", marginTop: 2 }}>{members.length} member{members.length !== 1 ? "s" : ""} · {fmtNum(totals.n)} ads · {fmt(totals.spend)}</div>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {members.map(m => (
            <div key={m.raw} style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid #F5EDE5", gap: 10 }}>
              <div style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {m.raw}
                {m.isSelf && <span style={{ marginLeft: 6, fontSize: 9, color: "#8a6f68", background: "#F5EDE5", padding: "1px 5px", borderRadius: 3 }}>CANONICAL</span>}
              </div>
              <div style={{ fontSize: 11, color: "#8a6f68", minWidth: 60, textAlign: "right" }}>{fmtNum(m.n)}</div>
              <div style={{ fontSize: 11, color: "#3a2429", minWidth: 70, textAlign: "right", fontWeight: 500 }}>{fmt(m.spend)}</div>
              {!m.isSelf && (
                <button onClick={() => onRemove(m.raw)} title="Remove this mapping"
                  style={{ border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 4, cursor: "pointer", fontSize: 10, padding: "2px 6px", fontWeight: 600 }}>
                  Unmap
                </button>
              )}
            </div>
          ))}
          {members.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#b0978f" }}>No members yet</div>}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid #E8DCD0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "6px 14px", border: "none", background: "#50000B", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// -------- Edit category modal (pick existing or create new) --------
function EditCategoryModal({ value, current, categories, onSave, onClose }) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const filtered = useMemo(
    () => categories.filter(c => !search || String(c).toLowerCase().includes(search.toLowerCase())),
    [categories, search]
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 420, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #E8DCD0" }}>
          <div style={{ fontSize: 11, color: "#b0978f", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Reclassify</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#50000B", fontFamily: "ui-monospace, monospace", marginTop: 2, wordBreak: "break-all" }}>{value}</div>
          {current && <div style={{ fontSize: 11, color: "#8a6f68", marginTop: 4 }}>Currently mapped to <strong style={{ color: "#166534" }}>{current}</strong></div>}
        </div>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #E8DCD0" }}>
          <input autoFocus placeholder="Search existing categories…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }} />
        </div>
        <div style={{ overflowY: "auto", flex: 1, maxHeight: 320 }}>
          {filtered.map(c => (
            <div key={c} onClick={() => onSave(c)}
              style={{ padding: "8px 14px", fontSize: 12, fontFamily: "ui-monospace, monospace", cursor: "pointer", borderBottom: "1px solid #F5EDE5", background: c === current ? "#FDE9BF" : "transparent", display: "flex", alignItems: "center", gap: 6 }}
              onMouseEnter={e => e.currentTarget.style.background = "#FBF7F4"}
              onMouseLeave={e => e.currentTarget.style.background = c === current ? "#FDE9BF" : "transparent"}>
              {c === current && <span style={{ color: "#16a34a", fontSize: 11 }}>✓</span>}
              <span>{c}</span>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#b0978f" }}>No matches</div>}
        </div>
        <div style={{ padding: "10px 12px", borderTop: "1px solid #E8DCD0", display: "flex", gap: 8, alignItems: "center" }}>
          {creating ? (
            <>
              <input autoFocus placeholder="New category name" value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newName.trim()) onSave(newName.trim()); }}
                style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, fontFamily: "ui-monospace, monospace" }} />
              <button onClick={() => newName.trim() && onSave(newName.trim())}
                style={{ padding: "6px 12px", border: "none", background: "#50000B", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
              <button onClick={() => { setCreating(false); setNewName(""); }}
                style={{ padding: "6px 10px", border: "1px solid #D8C8BC", background: "#fff", color: "#8a6f68", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setCreating(true)}
                style={{ padding: "6px 12px", border: "1px dashed #b0978f", background: "#fff", color: "#3a2429", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Create new category</button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#b0978f" }}>Click a category to apply</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -------- Chip multiselect for a dimension's values --------
function ValuePicker({ ads, dim, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const values = useMemo(() => dim ? dimensionValues(ads, dim) : [], [ads, dim]);
  const filtered = useMemo(
    () => values.filter(v => !search || String(v.value).toLowerCase().includes(search.toLowerCase())),
    [values, search]
  );
  const selArr = Array.from(selected);

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 280 }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", padding: "6px 10px", background: "#fff", border: "1px solid #D8C8BC", borderRadius: 6, cursor: "pointer", minHeight: 32 }}>
        {selArr.length === 0 ? (
          <span style={{ color: "#b0978f", fontSize: 12 }}>{dim ? `All ${values.length} values` : "Pick a dimension first"}</span>
        ) : (
          <>
            {selArr.slice(0, 4).map(v => (
              <span key={v} style={{ fontSize: 11, background: "#FDE9BF", color: "#50000B", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 4 }}>
                {v}
                <button onClick={e => { e.stopPropagation(); onToggle(v); }} style={{ border: "none", background: "transparent", color: "#50000B", cursor: "pointer", padding: 0, fontSize: 12 }}>×</button>
              </span>
            ))}
            {selArr.length > 4 && <span style={{ fontSize: 11, color: "#8a6f68" }}>+{selArr.length - 4} more</span>}
          </>
        )}
        <span style={{ marginLeft: "auto", color: "#b0978f", fontSize: 11 }}>▾</span>
      </div>
      {open && dim && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: "1px solid #D8C8BC", borderRadius: 6, boxShadow: "0 6px 16px rgba(0,0,0,0.1)", zIndex: 20, maxHeight: 360, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 8, borderBottom: "1px solid #E8DCD0", background: "#fff", display: "flex", gap: 8, alignItems: "center" }}>
            <input autoFocus placeholder="Search values…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid #E8DCD0", fontSize: 11 }} />
            {selArr.length > 0 && <button onClick={onClear} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Clear</button>}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.slice(0, 200).map(v => (
              <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>
                <input type="checkbox" checked={selected.has(v.value)} onChange={() => onToggle(v.value)} />
                <span style={{ fontFamily: "ui-monospace, monospace", flex: 1 }}>{v.value}</span>
                <span style={{ color: "#b0978f" }}>{v.n}</span>
              </label>
            ))}
            {filtered.length > 200 && <div style={{ padding: 8, fontSize: 10, color: "#b0978f", textAlign: "center" }}>Showing 200 of {filtered.length} — refine search.</div>}
          </div>
          <div style={{ padding: 8, borderTop: "1px solid #E8DCD0", background: "#fff", display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button onClick={() => setOpen(false)}
              style={{ padding: "6px 16px", border: "none", background: "#50000B", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              Select{selArr.length > 0 ? ` (${selArr.length})` : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------- Tree table with expand/collapse + leaf drilldown --------
function TreeTable({ nodes, dimLabels, onLeafClick }) {
  const [expanded, setExpanded] = useState(new Set());
  const [sortCol, setSortCol] = useState("spend");
  const [sortDir, setSortDir] = useState("desc");
  const toggle = (path) => setExpanded(s => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const sortHeader = (label, col, align = "right") => {
    const active = sortCol === col;
    return (
      <th key={col} onClick={() => { if (active) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortCol(col); setSortDir("desc"); } }}
        style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#50000B" : "#8a6f68" }}>
        {label} {active && (sortDir === "desc" ? "↓" : "↑")}
      </th>
    );
  };
  const sortNodes = (nodes) => {
    const mul = sortDir === "desc" ? -1 : 1;
    return nodes.slice().sort((a, b) => {
      if (sortCol === "value") return mul * String(a.value).localeCompare(String(b.value));
      const va = a.agg[sortCol], vb = b.agg[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      return mul * (va - vb);
    });
  };
  const rows = [];
  const walk = (nodes, depth, parentPath) => {
    for (const n of sortNodes(nodes)) {
      const path = parentPath ? `${parentPath}\u241F${n.value}` : n.value;
      const isLeaf = !n.children;
      const isOpen = expanded.has(path);
      rows.push({ n, depth, path, isLeaf, isOpen });
      if (!isLeaf && isOpen) walk(n.children, depth + 1, path);
    }
  };
  walk(nodes, 0, "");

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #E8DCD0" }}>
          {sortHeader(dimLabels.join(" / "), "value", "left")}
          {sortHeader("Ads", "count")}
          {sortHeader("Spend", "spend")}
          {sortHeader("Revenue", "rev")}
          {sortHeader("ROAS", "roas")}
          {sortHeader("CPA", "cpa")}
          {sortHeader("Purchases", "txns")}
          {sortHeader("AOV", "aov")}
          {sortHeader("CPM", "cpm")}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.path}
            onClick={() => r.isLeaf ? onLeafClick(r.n, r.path) : toggle(r.path)}
            style={{ borderBottom: "1px solid #F5EDE5", cursor: "pointer", background: r.depth === 0 ? "transparent" : r.depth === 1 ? "#FBF7F4" : "#F5EDE5" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#FDE9BF")}
            onMouseLeave={e => (e.currentTarget.style.background = r.depth === 0 ? "transparent" : r.depth === 1 ? "#FBF7F4" : "#F5EDE5")}>
            <td style={{ ...td, paddingLeft: 10 + r.depth * 20, fontWeight: r.depth === 0 ? 600 : 500 }}>
              <span style={{ display: "inline-block", width: 14, color: "#b0978f" }}>{!r.isLeaf ? (r.isOpen ? "▼" : "▶") : "•"}</span>
              {r.n.value}
              <span style={{ fontSize: 10, color: "#b0978f", marginLeft: 6 }}>({r.n.agg.count})</span>
            </td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.n.agg.count)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.n.agg.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.n.agg.rev)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.n.agg.roas} /></td>
            <td style={{ ...td, textAlign: "right" }}>{r.n.agg.cpa ? `$${r.n.agg.cpa.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{fmtNum(r.n.agg.txns)}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.n.agg.aov ? `$${r.n.agg.aov.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#8a6f68" }}>{r.n.agg.cpm ? `$${r.n.agg.cpm.toFixed(1)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------- Analysis tab with row-based rule picker + tree table --------
function AnalysisTab({ ads, ALL_DIMS_LABELS, METRIC_MAP, anRules, setAnRules, anMetric, setAnMetric, anMinSpend, setAnMinSpend, anTopN, setAnTopN, anExclusions, setAnExclusions, analysisTree, analysisChartData, openModal }) {
  const [expandedExcludeDim, setExpandedExcludeDim] = useState(null);

  const setRuleDim = (i, dim) => setAnRules(rs => rs.map((r, idx) => idx === i ? { dim, values: new Set() } : r));
  const toggleRuleValue = (i, v) => setAnRules(rs => rs.map((r, idx) => {
    if (idx !== i) return r;
    const next = new Set(r.values);
    if (next.has(v)) next.delete(v); else next.add(v);
    return { ...r, values: next };
  }));
  const clearRuleValues = (i) => setAnRules(rs => rs.map((r, idx) => idx === i ? { ...r, values: new Set() } : r));
  const removeRule = (i) => setAnRules(rs => rs.filter((_, idx) => idx !== i));
  const addRule = () => setAnRules(rs => rs.length < 3 ? [...rs, { dim: "", values: new Set() }] : rs);

  const toggleExclude = (dim, value) => {
    setAnExclusions(ex => {
      const set = new Set(ex[dim] || []);
      if (set.has(value)) set.delete(value); else set.add(value);
      return { ...ex, [dim]: set };
    });
  };

  const setExcludeAll = (dim, values) => {
    setAnExclusions(ex => ({ ...ex, [dim]: new Set(values.map(v => v.value)) }));
  };

  const clearExcludeForDim = (dim) => {
    setAnExclusions(ex => {
      const next = { ...ex };
      delete next[dim];
      return next;
    });
  };

  const allExcludeValues = useMemo(() => expandedExcludeDim ? dimensionValues(ads, expandedExcludeDim).slice().sort((a, b) => String(a.value).localeCompare(String(b.value))) : [], [ads, expandedExcludeDim]);
  const excludeDimValues = useMemo(() => allExcludeValues.slice(0, 100), [allExcludeValues]);

  // Dims actually used (non-empty)
  const activeDims = anRules.map(r => r.dim).filter(Boolean);
  const usedDims = new Set(activeDims);

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: "#3a2429", margin: "0 0 10px" }}>Concept Analysis</h3>

        {/* Rule rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {anRules.map((rule, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 20, color: "#b0978f", fontSize: 12, textAlign: "center" }}>{i + 1}</span>
              <select value={rule.dim} onChange={e => setRuleDim(i, e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12, minWidth: 160, background: "#fff" }}>
                <option value="">Pick dimension…</option>
                {Object.entries(ALL_DIMS_LABELS).map(([k, lbl]) => {
                  const disabled = usedDims.has(k) && k !== rule.dim;
                  return <option key={k} value={k} disabled={disabled}>{lbl}{disabled ? " (used)" : ""}</option>;
                })}
              </select>
              <span style={{ color: "#b0978f" }}>›</span>
              <ValuePicker
                ads={ads}
                dim={rule.dim}
                selected={rule.values}
                onToggle={v => toggleRuleValue(i, v)}
                onClear={() => clearRuleValues(i)}
              />
              <button onClick={() => removeRule(i)} title="Remove row"
                style={{ border: "none", background: "transparent", color: "#b0978f", cursor: "pointer", fontSize: 16, padding: 4 }}>🗑</button>
            </div>
          ))}
        </div>

        {anRules.length < 3 && (
          <button onClick={addRule} style={{ marginTop: 10, padding: "6px 12px", border: "1px dashed #D8C8BC", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#6B0010" }}>+ Add dimension</button>
        )}

        {/* Controls row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, alignItems: "end", marginTop: 12, paddingTop: 12, borderTop: "1px solid #E8DCD0" }}>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>CHART METRIC</label>
            <select value={anMetric} onChange={e => setAnMetric(e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              {Object.entries(METRIC_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>MIN SPEND</label>
            <select value={anMinSpend} onChange={e => setAnMinSpend(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              <option value={0}>None</option>
              <option value={1000}>$1K+</option>
              <option value={10000}>$10K+</option>
              <option value={50000}>$50K+</option>
              <option value={100000}>$100K+</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 4 }}>TOP N (top level)</label>
            <select value={anTopN} onChange={e => setAnTopN(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D8C8BC", fontSize: 12 }}>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
              <option value={200}>Top 200</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "#8a6f68" }}>
            <strong style={{ color: "#50000B" }}>{analysisTree.length}</strong> top-level groups
          </div>
        </div>

        {/* Exclude values section (kept as secondary tool) */}
        <div style={{ marginTop: 12, borderTop: "1px solid #E8DCD0", paddingTop: 12 }}>
          <label style={{ fontSize: 11, color: "#8a6f68", fontWeight: 600, display: "block", marginBottom: 6 }}>EXCLUDE VALUES (secondary filter)</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {Object.keys(ALL_DIMS_LABELS).map(k => {
              const excluded = anExclusions[k]?.size || 0;
              return (
                <button key={k} onClick={() => setExpandedExcludeDim(expandedExcludeDim === k ? null : k)} style={{
                  padding: "4px 10px", border: "1px solid #D8C8BC", borderRadius: 5, cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: expandedExcludeDim === k ? "#fef3c7" : "#fff",
                  color: excluded > 0 ? "#c2410c" : "#8a6f68",
                }}>{ALL_DIMS_LABELS[k]}{excluded > 0 && ` (−${excluded})`}</button>
              );
            })}
            {Object.values(anExclusions).some(s => s.size > 0) &&
              <button onClick={() => setAnExclusions({})} style={{ fontSize: 11, border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>Clear all exclusions</button>
            }
          </div>
          {expandedExcludeDim && (() => {
            const excludedCount = anExclusions[expandedExcludeDim]?.size || 0;
            const allSelected = excludedCount >= allExcludeValues.length && allExcludeValues.length > 0;
            return (
              <div style={{ marginTop: 10, padding: 10, background: "#FBF7F4", borderRadius: 6, maxHeight: 280, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 11, color: "#8a6f68" }}>Check values to exclude from <strong>{ALL_DIMS_LABELS[expandedExcludeDim]}</strong>:</div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      onClick={() => allSelected ? clearExcludeForDim(expandedExcludeDim) : setExcludeAll(expandedExcludeDim, allExcludeValues)}
                      style={{ padding: "3px 10px", border: "1px solid #D8C8BC", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#3a2429" }}>
                      {allSelected ? "Deselect all" : `Select all (${allExcludeValues.length})`}
                    </button>
                    {excludedCount > 0 && !allSelected && (
                      <button onClick={() => clearExcludeForDim(expandedExcludeDim)}
                        style={{ padding: "3px 10px", border: "1px solid #fecaca", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#dc2626" }}>
                        Clear ({excludedCount})
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4 }}>
                  {excludeDimValues.map(v => (
                    <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
                      <input type="checkbox" checked={anExclusions[expandedExcludeDim]?.has(v.value) || false} onChange={() => toggleExclude(expandedExcludeDim, v.value)} />
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{v.value}</span>
                      <span style={{ color: "#b0978f", fontSize: 10 }}>({v.n})</span>
                    </label>
                  ))}
                </div>
                {allExcludeValues.length > excludeDimValues.length && (
                  <div style={{ marginTop: 8, fontSize: 10, color: "#b0978f", textAlign: "center" }}>
                    Showing {excludeDimValues.length} of {allExcludeValues.length} values — "Select all" applies to every value.
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {activeDims.length > 0 && (
        <>
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #E8DCD0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "#3a2429" }}>Breakdown</h3>
            <p style={{ fontSize: 11, color: "#b0978f", margin: "0 0 10px" }}>Click a row to expand to the next dimension. Click a leaf row to see ad-level data.</p>
            <TreeTable
              nodes={analysisTree}
              dimLabels={activeDims.map(d => ALL_DIMS_LABELS[d])}
              onLeafClick={(node, path) => openModal(path.replaceAll("\u241F", " › "), `${node.agg.count} ads · Spend ${fmt(node.agg.spend)}`, node.ads)}
            />
          </div>
        </>
      )}
    </div>
  );
}

