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
  "Movie", "Song Ad", "B-Roll", "Hook/Lead", "TikTok Style", "Doctor", "Warehouse", "Organic", "Faceless", "Claymation", "AI UGC"];
const IMAGE_FORMATS = ["Static", "Long-Form Static"];

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
      a.pixel_rev += m.pixel_rev || 0;
      a.pixel_txns += m.pixel_txns || 0;
      a.nc_txns += m.nc_txns || 0;
      a.count += 1;
      return a;
    },
    { spend: 0, rev: 0, txns: 0, impressions: 0, clicks: 0, link_clicks: 0,
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
    if (VIDEO_FORMATS.includes(ad.format)) b.video += 1;
    else if (IMAGE_FORMATS.includes(ad.format)) b.image += 1;
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
export function winRate(ads, formatFilter = "blended") {
  let filtered = ads.filter(hasSpend);
  if (formatFilter === "video") {
    filtered = filtered.filter((a) =>
      VIDEO_FORMATS.includes(a.format));
  } else if (formatFilter === "image") {
    filtered = filtered.filter((a) =>
      IMAGE_FORMATS.includes(a.format));
  }

  const byMonth = new Map();
  for (const ad of filtered) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(ad);
  }

  const rows = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, monthAds]) => {
      const thresholds = {};
      for (const t of THRESHOLDS) {
        const n = monthAds.filter((a) => (a.metrics.spend || 0) >= t.min).length;
        thresholds[t.key] = {
          n,
          rate: monthAds.length ? (n / monthAds.length) * 100 : 0,
        };
      }
      return { month, total: monthAds.length, thresholds };
    });

  const totalThresholds = {};
  for (const t of THRESHOLDS) {
    const n = filtered.filter((a) => (a.metrics.spend || 0) >= t.min).length;
    totalThresholds[t.key] = {
      n,
      rate: filtered.length ? (n / filtered.length) * 100 : 0,
    };
  }
  rows.push({ month: "TOTAL", total: filtered.length, thresholds: totalThresholds });
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
  "angle", "product", "format", "awareness", "concept", "agency", "creator",
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
