#!/usr/bin/env python3
"""Fetch Rosabella ad-level performance from the Meta Marketing API, parse
the naming conventions, and emit the JSON manifest the dashboard reads.

Two input modes:

  API  (default, used by the GitHub Action)
      Needs META_ACCESS_TOKEN — a System User token from the Ambrosia Brands
      business with ads_read on the three ad accounts below. Uses async
      insights report jobs because the main account is too large for a
      synchronous 180-day ad-level query.

  CSV  (--from-csv PATH [PATH ...])
      Builds the same manifest from Ads Manager exports (Ads level, columns:
      Ad name, Ad ID, Campaign name, Amount spent (USD), Impressions, Clicks
      (all), Link clicks, Purchases, Purchases conversion value).

Output: public/data/latest.json
"""
import argparse
import csv
import json
import os
import pathlib
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib import parse, request as urlreq
from urllib.error import HTTPError

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from parse_ad_name import parse_ad_name  # noqa: E402

GRAPH = "https://graph.facebook.com/v22.0"

# Ambrosia Brands business portfolio — all three accounts run Rosabella.
# "FS | EUR | #1" is the main account (~$7M/month); the other two are small.
AD_ACCOUNTS = {
    "act_1609555939791435": "FS | EUR | #1",
    "act_1709314040273728": "Rosabella - Shopify",
    "act_901180242723879": "Rosabella | New products",
}

LOOKBACK_DAYS = 180
PURCHASE_ACTION = "omni_purchase"   # matches Ads Manager's "Purchases" column
THUMB_MIN_SPEND = 250               # only fetch thumbnails for ads that matter
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "latest.json"

INSIGHT_FIELDS = ",".join([
    "account_id", "campaign_name", "ad_id", "ad_name", "spend", "impressions",
    "clicks", "inline_link_clicks", "actions", "action_values",
])
ALL_STATUSES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED",
                "ADSET_PAUSED", "DISAPPROVED", "WITH_ISSUES", "IN_PROCESS",
                "PENDING_REVIEW", "PREAPPROVED", "PENDING_BILLING_INFO"]


# --- HTTP ------------------------------------------------------------------
def _call(url: str, params: dict = None, method: str = "GET", tries: int = 5) -> dict:
    token = os.environ["META_ACCESS_TOKEN"]
    params = dict(params or {})
    params["access_token"] = token
    data = None
    if method == "GET":
        url = url + ("&" if "?" in url else "?") + parse.urlencode(params)
    else:
        data = parse.urlencode(params).encode()
    for attempt in range(tries):
        try:
            req = urlreq.Request(url, data=data, method=method)
            with urlreq.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except HTTPError as e:
            body = e.read().decode(errors="replace")
            # 17/613/80004 = rate limits; back off and retry.
            if attempt < tries - 1 and any(c in body for c in ('"code":17', '"code":613', '"code":80004', '"code":2,', '"code":1,')):
                time.sleep(30 * (attempt + 1))
                continue
            raise SystemExit(f"Meta API error {e.code}: {body[:500]}")
    raise SystemExit("Meta API: retries exhausted")


def _paged(url: str, params: dict = None) -> list:
    out = []
    page = _call(url, params)
    while True:
        out.extend(page.get("data", []))
        nxt = page.get("paging", {}).get("next")
        if not nxt:
            return out
        # `next` already carries the token and every param.
        with urlreq.urlopen(nxt, timeout=300) as r:
            page = json.loads(r.read())


def fetch_account(act: str, since: str, until: str) -> tuple[list, dict]:
    run = _call(f"{GRAPH}/{act}/insights", {
        "level": "ad",
        "time_range": json.dumps({"since": since, "until": until}),
        "time_increment": "all_days",
        "fields": INSIGHT_FIELDS,
        "filtering": json.dumps([{"field": "spend", "operator": "GREATER_THAN", "value": 0}]),
    }, method="POST")
    run_id = run["report_run_id"]
    while True:
        s = _call(f"{GRAPH}/{run_id}", {"fields": "async_status,async_percent_completion"})
        status = s.get("async_status")
        print(f"  {act}: {status} {s.get('async_percent_completion')}%", flush=True)
        if status == "Job Completed":
            break
        if status in ("Job Failed", "Job Skipped"):
            raise SystemExit(f"{act}: report job {status}")
        time.sleep(10)
    rows = _paged(f"{GRAPH}/{run_id}/insights", {"limit": 500})
    ads = _paged(f"{GRAPH}/{act}/ads", {
        "fields": "id,created_time", "limit": 1000,
        "filtering": json.dumps([{"field": "effective_status", "operator": "IN", "value": ALL_STATUSES}]),
    })
    created = {a["id"]: a["created_time"][:10] for a in ads}
    return rows, created


def fetch_thumbnails(ad_ids: list) -> dict:
    thumbs = {}
    for i in range(0, len(ad_ids), 50):
        chunk = ad_ids[i:i + 50]
        res = _call(f"{GRAPH}/", {"ids": ",".join(chunk), "fields": "creative{thumbnail_url,image_url}"})
        for ad_id, v in res.items():
            c = v.get("creative") or {}
            url = c.get("thumbnail_url") or c.get("image_url")
            if url:
                thumbs[ad_id] = url
    return thumbs


# --- Normalise -------------------------------------------------------------
def _f(v) -> float:
    try:
        return float(str(v).replace(",", "").replace("$", "")) if v not in (None, "") else 0.0
    except ValueError:
        return 0.0


def _action(arr, kind=PURCHASE_ACTION) -> float:
    for a in arr or []:
        if a.get("action_type") == kind:
            return _f(a.get("value"))
    return 0.0


def normalise(rows: list, created: dict, thumbs: dict = None) -> list:
    """One record per unique ad name (duplicated ads across ad sets roll up)."""
    thumbs = thumbs or {}
    by = {}
    for r in rows:
        name = (r.get("ad_name") or "").strip()
        if not name:
            continue
        spend = _f(r.get("spend"))
        m = {
            "spend": spend,
            "impressions": _f(r.get("impressions")),
            "clicks": _f(r.get("clicks")),
            "link_clicks": _f(r.get("inline_link_clicks")),
            "rev": None if r.get("action_values") is None else _action(r.get("action_values")),
            "txns": _action(r.get("actions")),
        }
        rec = by.get(name)
        if rec is None:
            rec = by[name] = {"m": {k: (None if v is None else 0.0) for k, v in m.items()}, "ids": {}, "camps": {},
                              "accts": {}, "first": None}
        for k, v in m.items():
            if v is None or rec["m"][k] is None:
                rec["m"][k] = None
            else:
                rec["m"][k] += v
        ad_id = str(r.get("ad_id") or "")
        rec["ids"][ad_id] = rec["ids"].get(ad_id, 0) + spend
        c = r.get("campaign_name") or ""
        rec["camps"][c] = rec["camps"].get(c, 0) + spend
        a = f"act_{r.get('account_id')}"
        rec["accts"][a] = rec["accts"].get(a, 0) + spend
        d = created.get(ad_id) or r.get("created")
        if d and (rec["first"] is None or d < rec["first"]):
            rec["first"] = d

    out = []
    for name, rec in by.items():
        camps = sorted(rec["camps"], key=lambda c: -rec["camps"][c])
        parsed = parse_ad_name(name, camps[0] if camps else None)
        m = rec["m"]
        m["roas"] = (round(m["rev"] / m["spend"], 4) if m["spend"] else 0) if m["rev"] is not None else None
        m["cpm"] = round(m["spend"] / m["impressions"] * 1000, 4) if m["impressions"] else 0
        m["cpc"] = round(m["spend"] / m["link_clicks"], 4) if m["link_clicks"] else None
        m["ctr"] = round(m["link_clicks"] / m["impressions"] * 100, 4) if m["impressions"] else None
        m["cpa"] = round(m["spend"] / m["txns"], 4) if m["txns"] else None
        m["aov"] = round(m["rev"] / m["txns"], 2) if m["txns"] and m["rev"] is not None else None
        for k in ("spend", "rev"):
            if m[k] is not None:
                m[k] = round(m[k], 2)
        ids = sorted(rec["ids"], key=lambda i: -rec["ids"][i])
        acct = max(rec["accts"], key=rec["accts"].get)
        iso = rec["first"]
        parsed.update({
            "launch_date": iso,
            "date": (iso[2:4] + iso[5:7] + iso[8:10]) if iso else None,
            "account": AD_ACCOUNTS.get(acct, acct),
            "campaigns": camps[:5],
            "meta_ad_ids": ids[:10],
            "ad_count": len(ids),
            "metrics": m,
            "thumbnail_url": next((thumbs[i] for i in ids if i in thumbs), None),
            "preview_link": None if not ids or not ids[0] else (f"https://adsmanager.facebook.com/adsmanager/manage/ads?act={acct[4:]}"
                             f"&selected_ad_ids={ids[0]}") if ids else None,
        })
        out.append(parsed)
    out.sort(key=lambda a: -a["metrics"]["spend"])
    return out


def _adset_date(adset: str):
    """Ad set names carry a DD/MM/YY launch token: 'Beetroot testing | 31/08/26 | …'."""
    import re
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{2})\b", adset or "")
    if not m:
        return None
    d, mo, y = (int(x) for x in m.groups())
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"20{y:02d}-{mo:02d}-{d:02d}"


def rows_from_csv(paths: list, account: str = None) -> tuple[list, dict]:
    rows, created = [], {}
    for p in paths:
        with open(p, newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                g = lambda *ks: next((r[k] for k in ks if k in r and r[k] not in (None, "")), None)
                ad_id = g("Ad ID", "Ad Id") or ""
                link = g("Link clicks", "Link Clicks")
                purchases = g("Purchases", "Website purchases")
                if purchases is None and g("CVR Purchases") is not None:
                    # Custom metric = purchases / link clicks; the product is an
                    # exact integer in every export checked, so recover the count.
                    purchases = round(_f(g("CVR Purchases")) * _f(link))
                value = g("Purchases conversion value", "Website purchases conversion value")
                adset = g("Ad set name", "Ad Set Name") or ""
                rows.append({
                    "ad_name": g("Ad name", "Ad Name"), "ad_id": ad_id,
                    "campaign_name": g("Campaign name", "Campaign Name"),
                    "account_id": (g("Account ID") or account or "").replace("act_", ""),
                    "spend": g("Amount spent (USD)", "Amount spent", "Amount Spent"),
                    "impressions": g("Impressions"),
                    "clicks": g("Clicks (all)", "Clicks"),
                    "inline_link_clicks": link,
                    "actions": [{"action_type": PURCHASE_ACTION, "value": purchases or 0}],
                    "action_values": ([{"action_type": PURCHASE_ACTION, "value": value}]
                                      if value is not None else None),
                    "created": (g("Ad creation date") or _adset_date(adset)
                                or (g("Reporting starts") or "")[:10] or None),
                })
    return rows, created


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-csv", nargs="+")
    ap.add_argument("--days", type=int, default=LOOKBACK_DAYS)
    ap.add_argument("--account", help="ad account id for CSV exports that lack an Account ID column")
    ap.add_argument("--label", help="source label shown in the header, e.g. which accounts the export covers")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    until = (now - timedelta(days=1)).date().isoformat()
    since = (now - timedelta(days=args.days)).date().isoformat()

    if args.from_csv:
        rows, created = rows_from_csv(args.from_csv, args.account)
        starts = sorted(r["created"] for r in rows if r.get("created"))
        thumbs, source = {}, "ads-manager-csv"
    else:
        if not os.environ.get("META_ACCESS_TOKEN"):
            raise SystemExit("META_ACCESS_TOKEN is not set")
        rows, created = [], {}
        for act in AD_ACCOUNTS:
            print(f"Fetching {act} ({AD_ACCOUNTS[act]}) {since}..{until}", flush=True)
            r, c = fetch_account(act, since, until)
            print(f"  {len(r)} ad rows", flush=True)
            rows += r
            created.update(c)
        thumbs, source = {}, "meta-marketing-api"

    ads = normalise(rows, created)
    if not args.from_csv:
        want = [a["meta_ad_ids"][0] for a in ads if a["metrics"]["spend"] >= THUMB_MIN_SPEND and a["meta_ad_ids"]]
        thumbs = fetch_thumbnails(want)
        by_id = {a["meta_ad_ids"][0]: a for a in ads if a["meta_ad_ids"]}
        for i, url in thumbs.items():
            if i in by_id:
                by_id[i]["thumbnail_url"] = url

    spend = sum(a["metrics"]["spend"] for a in ads)
    has_rev = any(a["metrics"]["rev"] is not None for a in ads)
    if args.from_csv:
        import csv as _c
        with open(args.from_csv[0], encoding="utf-8-sig") as fh:
            first = next(_c.DictReader(fh), {})
        since = first.get("Reporting starts", since)[:10]
        until = first.get("Reporting ends", until)[:10]
    manifest = {
        "generated_at": now.isoformat(),
        "period": {"start": since, "end": until},
        "source": source,
        "brand": "Rosabella",
        "attribution": {
            "primary": "Meta-reported (account default attribution)",
            "purchase_action": PURCHASE_ACTION,
        },
        "ad_accounts": AD_ACCOUNTS,
        "ad_count": len(ads),
        "has_revenue": has_rev,
        "source_label": args.label,
        "total_spend": round(spend, 2),
        "ads": ads,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"Wrote {len(ads)} creatives, ${spend:,.0f} spend → {OUT}")


if __name__ == "__main__":
    main()
