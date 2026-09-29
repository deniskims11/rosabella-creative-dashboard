# Rosabella — Meta Creative Performance Dashboard

Ad-level creative performance for Rosabella across the three Meta ad accounts
in the Ambrosia Brands business portfolio. Same design and tabs as the IM8
creative dashboard, rebuilt around the Meta Marketing API and Rosabella's
ad-naming conventions.

**Live:** https://deniskims11.github.io/rosabella-creative-dashboard/

## How it works

```
Meta Marketing API ──► scripts/fetch_meta.py ──► public/data/latest.json ──► React SPA
   (every 4h)            parse_ad_name.py
```

No backend. A GitHub Action refreshes the data every four hours and commits it;
GitHub Pages serves a static build that derives every view client-side.

Accounts: `act_1609555939791435` (FS | EUR | #1 — main account),
`act_901180242723879` (Rosabella | New products),
`act_1709314040273728` (Rosabella - Shopify).

- Window: trailing 180 days, ad level, one record per unique ad name.
- Revenue / purchases: Meta `omni_purchase` (Ads Manager "Purchases"),
  account default attribution.
- Launch date: the ad's `created_time`.

## Naming conventions

`scripts/parse_ad_name.py` recognises fields by shape rather than position:
creative ID, agency (creative-ID prefix), angle, awareness, format, product,
concept (hook line), creator (Trybe ads), version, new/var — plus offer,
funnel, geo and buying type from the campaign name.

```bash
python3 scripts/parse_ad_name.py   # fixture self-test (runs before each refresh)
```

## Setup

The refresh job reads the repo secret `META_ACCESS_TOKEN` (a Meta System User
token with `ads_read` on the three accounts). Until it is set the job no-ops
with a notice. After adding it: Actions → *Refresh Meta data* → Run workflow.

Without a token, build the manifest from Ads Manager ad-level CSV exports:

```bash
python3 scripts/fetch_meta.py --from-csv export1.csv export2.csv
```
