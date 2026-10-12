#!/bin/bash
# Rebuild public/data/ from the Ads Manager exports in data/exports/.
# Windows are non-overlapping; views combine them. To add a new window pN:
# export it into data/exports/v2/pN/, add a --period + --csv-account lines, add pN to views.
set -e
cd "$(dirname "$0")/.."
E=data/exports V=data/exports/v2 FS=act_1609555939791435 SH=act_1709314040273728 NP=act_901180242723879
python3 scripts/parse_ad_name.py | tail -1
python3 scripts/fetch_meta.py \
 --period "pY=2026-01-01..2026-08-30" --period "p0a=2026-08-31..2026-09-10" \
 --period "pB=2026-09-11..2026-09-28" --period "pA=2026-09-29..2026-10-10" \
 --csv-account pY:$FS=$E/pY_0101_0830/fs_top8.csv --csv-account pY:$FS=$E/pY_0101_0830/fs_rest50.csv \
 --csv-account pY:$FS=$E/pY_0101_0830/fs_deleted_new.csv \
 --csv-account pY:$SH=$E/pY_0101_0830/shopify.csv --csv-account pY:$NP=$E/pY_0101_0830/newproducts.csv \
 --csv-account p0a:$FS=$V/p0a/fs_a.csv --csv-account p0a:$FS=$V/p0a/fs_b.csv \
 --csv-account p0a:$SH=$V/p0a/shopify.csv --csv-account p0a:$NP=$V/p0a/newproducts.csv \
 --csv-account pB:$FS=$V/pB/fs_top8.csv --csv-account pB:$FS=$V/pB/fs_rest50.csv \
 --csv-account pB:$SH=$V/pB/shopify.csv --csv-account pB:$NP=$V/pB/newproducts.csv \
 --csv-account pA:$FS=$V/pA/fs_top8.csv --csv-account pA:$FS=$V/pA/fs_rest50.csv \
 --csv-account pA:$SH=$V/pA/shopify.csv --csv-account pA:$NP=$V/pA/newproducts.csv \
 --view "ytd|Year to date|pY,p0a,pB,pA" --view "l30|Last 30 days|pB,pA" \
 --view "pA|Latest window (Sep 29–Oct 10)|pA" --view "prev|Previous window (Aug 31–Sep 28)|p0a,pB" \
 --daily-csv $FS=$E/daily/fs_daily.csv --daily-csv $SH=$E/daily/shopify_daily.csv --daily-csv $NP=$E/daily/newproducts_daily.csv \
 --momentum pA,pB --label "Ads Manager exports · all 3 Rosabella ad accounts" "$@"
ls -la public/data/
