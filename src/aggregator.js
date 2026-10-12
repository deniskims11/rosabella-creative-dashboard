// Aggregates ad-level Meta rows into the shapes the dashboard tabs
// need. The raw data ships as one row per unique creative with parsed
// dimensions + metrics. Every view derives from aggregating across the ad
// array rather than storing pre-aggregated tables.

const THRESHOLDS = [
  { key: "$1K", min: 1000 },
  { key: "$5K", min: 5000 },
  { key: "$15K", min: 15000 },
  { key: "$25K", min: 25000 },
  { key: "$50K", min: 50000 },
  { key: "$100K", min: 100000 },
  { key: "$150K+", min: 150000 },
];

// Ads that never spent anything are launch artefacts — duplicates, drafts,
// creatives that never left review. IM8's dashboard counted them in win-rate
// denominators, which silently depressed every rate. Here they are excluded
// from rate denominators (and the excluded count is surfaced in the UI).
const hasSpend = (a) => (a.metrics.spend || 0) > 0;

// Parser format labels (scripts/parse_ad_name.py FORMATS) split by medium.
const VIDEO_FORMATS = ["Video", "VSL", "UGC", "AI Avatar", "AI Characters", "AI Authority",
  "Movie", "Song Ad", "B-Roll", "Hook/Lead", "TikTok Style", "Doctor", "Warehouse", "Organic", "Faceless", "Claymation", "AI UGC", "3D Animation", "Unboxing", "AI Other"];
const IMAGE_FORMATS = ["Static", "Long-Form Static"];

const ADDITIVE = ["spend", "impressions", "clicks", "link_clicks", "rev", "txns", "v3s", "thru"];

// Derived per-creative ratios, always computed from summed totals.
export function withRatios(m) {
  const out = { ...m };
  out.roas = m.rev != null && m.spend ? m.rev / m.spend : (m.rev != null ? 0 : null);
  out.cpm = m.impressions ? (m.spend / m.impressions) * 1000 : 0;
  out.cpc = m.link_clicks ? m.spend / m.link_clicks : null;
  out.ctr = m.impressions ? ((m.link_clicks || 0) / m.impressions) * 100 : null;
  out.cpa = m.txns ? m.spend / m.txns : null;
  out.aov = m.txns && m.rev != null ? m.rev / m.txns : null;
  out.hook_rate = m.v3s != null && m.impressions ? (m.v3s / m.impressions) * 100 : null;
  out.hold_rate = m.v3s ? ((m.thru || 0) / m.v3s) * 100 : null;
  return out;
}

// Keep the records of the selected periods and fold each (account, ad name)
// into one creative: metrics summed, launch date = earliest seen. A creative
// running in several windows therefore counts once, with its compounded spend.
// Manifests without periods pass straight through.
export function mergePeriods(ads, keys) {
  const keep = keys ? new Set(keys) : null;
  const by = new Map();
  for (const a of ads) {
    if (keep && a.p && !keep.has(a.p)) continue;
    const k = `${a.account || ""}\u0001${a.ad_name}`;
    const prev = by.get(k);
    if (!prev) {
      by.set(k, { ...a, metrics: { ...a.metrics } });
      continue;
    }
    for (const f of ADDITIVE) {
      if (a.metrics[f] == null) continue;
      prev.metrics[f] = (prev.metrics[f] || 0) + a.metrics[f];
    }
    if (a.date && (!prev.date || a.date < prev.date)) { prev.date = a.date; prev.launch_date = a.launch_date; }
  }
  return [...by.values()].map((r) => ({ ...r, media: mediaOf(r) ?? inferMedia(r.metrics), metrics: withRatios(r.metrics) }));
}

// Names that carry no format hint: Meta reports 3-second plays for any ad with
// a video asset, so a ≥2% play rate means video; near-zero or none means static.
function inferMedia(m) {
  if (!m.impressions) return null;
  return (m.v3s || 0) / m.impressions >= 0.02 ? "Video" : "Static";
}

// Video vs Static. The parser writes `media` (it also reads name hints like
// "StaticImage" or "15s"); fall back to the format lists for older manifests.
export function mediaOf(ad) {
  if (ad.media) return ad.media;
  if (VIDEO_FORMATS.includes(ad.format)) return "Video";
  if (IMAGE_FORMATS.includes(ad.format)) return "Static";
  return null;
}

// Translate YYMMDD launch dates into YYYY-MM buckets.
function yymmddToMonth(s) {
  if (!s || s.length !== 6 || !/^\d{6}$/.test(s)) return null;
  return `20${s.slice(0, 2)}-${s.slice(2, 4)}`;
}

// Aggregate a filtered list of ad records into summary metrics.
export function aggregate(ads) {
  const tot = ads.reduce(
    (a, r) => {
      const m = r.metrics || {};
      a.spend += m.spend || 0;
      a.rev += m.rev || 0;
      a.txns += m.txns || 0;
      a.impressions += m.impressions || 0;
      a.clicks += m.clicks || 0;
      a.link_clicks += m.link_clicks || 0;
      // Video metrics only from non-static ads: statics/carousels with a stray
      // few 3s plays would otherwise swamp the hook-rate denominator.
      if (m.v3s != null && r.media !== "Static") {
        a.v3s += m.v3s || 0;
        a.thru += m.thru || 0;
        a.vid_impr += m.impressions || 0;
      }
      a.pixel_rev += m.pixel_rev || 0;
      a.pixel_txns += m.pixel_txns || 0;
      a.nc_txns += m.nc_txns || 0;
      a.count += 1;
      return a;
    },
    { spend: 0, rev: 0, txns: 0, impressions: 0, clicks: 0, link_clicks: 0, v3s: 0, thru: 0, vid_impr: 0,
      pixel_rev: 0, pixel_txns: 0, nc_txns: 0, count: 0 }
  );
  // CSV exports without a purchase-value column ship rev: null. Keep that as
  // "unknown" rather than letting it read as $0 revenue / 0.00x ROAS.
  const hasRev = ads.some((r) => r.metrics && r.metrics.rev != null);
  if (!hasRev) tot.rev = null;
  return {
    ...tot,
    roas: hasRev ? (tot.spend ? tot.rev / tot.spend : 0) : null,
    pixel_roas: tot.spend ? tot.pixel_rev / tot.spend : 0,
    cpm: tot.impressions ? (tot.spend / tot.impressions) * 1000 : 0,
    cpc: tot.link_clicks ? tot.spend / tot.link_clicks : null,
    ctr: tot.impressions ? (tot.link_clicks / tot.impressions) * 100 : null,
    cpa: tot.txns ? tot.spend / tot.txns : null,
    aov: hasRev && tot.txns ? tot.rev / tot.txns : null,
    // Hook rate = 3-second plays / impressions; hold rate = ThruPlays / 3-second
    // plays. Only impressions from records that carry video data count.
    hook_rate: tot.vid_impr ? (tot.v3s / tot.vid_impr) * 100 : null,
    hold_rate: tot.v3s ? (tot.thru / tot.v3s) * 100 : null,
    // Share of pixel-attributed purchases that came from new customers.
    pct_new: tot.pixel_txns ? (tot.nc_txns / tot.pixel_txns) * 100 : null,
  };
}

// Group ads by a dimension and aggregate each bucket.
export function groupBy(ads, dim) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = ad[dim] ?? "(untagged)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ad);
  }
  return Array.from(buckets.entries())
    .map(([name, rows]) => ({ name, ads: rows, ...aggregate(rows) }))
    .sort((a, b) => b.spend - a.spend);
}

// Monthly breakdown indexed by the creative's launch month (first day it
// recorded spend, falling back to a date parsed out of the campaign name).
export function monthly(ads) {
  const buckets = new Map();
  for (const ad of ads) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!buckets.has(m)) buckets.set(m, { month: m, video: 0, image: 0, ads: [] });
    const b = buckets.get(m);
    b.ads.push(ad);
    const media = mediaOf(ad);
    if (media === "Video") b.video += 1;
    else if (media === "Static") b.image += 1;
  }
  return Array.from(buckets.values())
    .map((b) => {
      const agg = aggregate(b.ads);
      return {
        month: b.month,
        total: b.ads.length,
        video: b.video,
        image: b.image,
        other: b.ads.length - b.video - b.image,
        spend: agg.spend,
        revenue: agg.rev,
        purchases: agg.txns,
        roas: agg.roas,
        cpm: agg.cpm,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

// Win rate: for each launch month, count creatives by spend threshold.
// Denominators exclude never-spent creatives.
// Roll ad-name records up to scripts (creative id) for win-rate purposes:
// variants and re-uploads of one script count once, with summed spend.
export function toScripts(ads) {
  const by = new Map();
  for (const a of ads) {
    const k = `${a.account || ""}\u0001${a.creative_id || a.concept || a.ad_name}`;
    const p = by.get(k);
    if (!p) { by.set(k, { ...a, metrics: { ...a.metrics } }); continue; }
    p.metrics.spend = (p.metrics.spend || 0) + (a.metrics.spend || 0);
    p.metrics.rev = (p.metrics.rev || 0) + (a.metrics.rev || 0);
    if (a.date && (!p.date || a.date < p.date)) p.date = a.date;
  }
  return [...by.values()];
}

// Win rate by launch month.
//   unit      "ad" (one row per ad name) or "script" (per creative id)
//   floor     only units that spent at least this much count as launched;
//             removes copies and drafts that never really ran
//   dataStart / dataEnd (YYYY-MM-DD) let each month be flagged:
//     pre      launched before the data window: only survivors are visible
//     immature launched within 14 days of the data end: not done spending
//     thin     fewer than minN launches: the rate is noise
export function winRate(ads, formatFilter = "blended", opts = {}) {
  const { unit = "ad", floor = 0, dataStart = null, dataEnd = null, minN = 20 } = opts;
  let pool = ads;
  if (formatFilter === "video") pool = pool.filter((a) => mediaOf(a) === "Video");
  else if (formatFilter === "image") pool = pool.filter((a) => mediaOf(a) === "Static");
  if (unit === "script") pool = toScripts(pool);
  const filtered = pool.filter((a) => (a.metrics.spend || 0) > 0 && (a.metrics.spend || 0) >= floor);

  const startMonth = dataStart ? dataStart.slice(0, 7) : null;
  const matureCut = dataEnd ? new Date(new Date(dataEnd + "T00:00:00Z").getTime() - 14 * 864e5) : null;

  const byMonth = new Map();
  for (const ad of filtered) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(ad);
  }
  const rate = (list, min) => {
    const n = list.filter((a) => (a.metrics.spend || 0) >= min).length;
    return { n, rate: list.length ? (n / list.length) * 100 : 0 };
  };
  const rows = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, monthAds]) => {
      const thresholds = {};
      for (const t of THRESHOLDS) thresholds[t.key] = rate(monthAds, t.min);
      const monthEnd = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0));
      const flags = [];
      if (startMonth && month < startMonth) flags.push("pre");
      if (matureCut && monthEnd > matureCut) flags.push("immature");
      if (monthAds.length < minN) flags.push("thin");
      return { month, total: monthAds.length, thresholds, flags };
    });
  // TOTAL only counts clean months, so survivors and unfinished cohorts
  // don't skew the headline rate.
  const clean = rows.filter((r) => !r.flags.length).flatMap((r) => byMonth.get(r.month));
  const totalThresholds = {};
  for (const t of THRESHOLDS) totalThresholds[t.key] = rate(clean, t.min);
  rows.push({ month: "TOTAL", total: clean.length, thresholds: totalThresholds, flags: [] });
  return rows;
}

// Convert a groupBy result into the breakdown-table row shape.
export function toBreakdownRows(groups) {
  return groups.map((g) => {
    const spenders = g.ads.filter(hasSpend);
    const wr = (min) =>
      spenders.length
        ? (spenders.filter((a) => (a.metrics.spend || 0) >= min).length /
           spenders.length) * 100
        : 0;
    return {
      name: g.name,
      creatives: g.count,
      launched: spenders.length,
      ads: g.ads,
      spend: g.spend,
      revenue: g.rev,
      roas: g.roas,
      pct_new: g.pct_new,
      cpa: g.cpa,
      hook_rate: g.hook_rate,
      hold_rate: g.hold_rate,
      purchases: g.txns,
      aov: g.aov,
      ctr: g.ctr,
      cpm: g.cpm,
      cpc: g.cpc,
      winRate1k: wr(1000),
      winRate15k: wr(15000),
      winRate50k: wr(50000),
    };
  });
}

// Dimensions available for pivoting and for the Data Clean Up tab.
export const DIMENSIONS = [
  "media", "angle", "angle_detail", "stage", "product", "format", "awareness", "concept", "agency", "creator",
  "creative_id", "version", "build", "offer", "funnel", "buying_type", "geo",
  "account", "convention",
];

export function dimensionValues(ads, dim) {
  const counts = new Map();
  const spendByValue = new Map();
  for (const ad of ads) {
    const v = ad[dim] ?? "(untagged)";
    counts.set(v, (counts.get(v) || 0) + 1);
    spendByValue.set(v, (spendByValue.get(v) || 0) + (ad.metrics.spend || 0));
  }
  return Array.from(counts.entries())
    .map(([value, n]) => ({ value, n, spend: spendByValue.get(value) || 0 }))
    .sort((a, b) => b.spend - a.spend);
}
