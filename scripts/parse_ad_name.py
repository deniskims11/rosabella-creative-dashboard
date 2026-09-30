"""Rosabella Meta ad-name parser.

Rosabella's accounts carry several naming conventions at once, written by
different agencies. A positional parser would mark most of the account
unknown, so this one scans tokens and recognises each field by its shape:

  ID-first     MX146_NEW_NONE_V1_HighCholesterol_NN_MOVIE_Rosabella_<HOOK>
               CA683_VAR_NONE_V4_HighCholesterol_TP3_AICharacters_RB_<Hook>
  Product-first BR_HighCholesterol_PDA_LongFormStaticScript_No_NO_PR_NEW_PRME609_V1_<HOOK>
               MRG_WeightLoss_UA_Video___MOVIE_MX002_V1_<HOOK>
               Rosabella_WeightLoss_SA_Static_NONE_MRG_TA_NEW_TA004_V1_<HOOK>
  Creator      HannaGlenn_Glutathione_DullSkintrybe=f6cb19e9
  Legacy       Beetroot_260402_betterbybill_019_Flash_Sale_Faceless_15s
               20251205_AK030_001_BT_Symptom Stack_Static_..._W49

Fields:
  creative_id   script id like PRME609, CA683, JK178, CH018v38a1
  agency        letter prefix of creative_id (PR, CA, JK, XV, MX …)
  angle         health angle (High Cholesterol, Blood Sugar, Weight Loss …)
  awareness     SA / UA / PDA / PR / UN / MA / TP1-3 / NN
  format        LongFormStaticScript, Static, VSL, UGC, AI Avatar, Movie …
  product       Beetroot / Lymphoria / Glutathione / Moringa / Magnesium …
  concept       the hook line, with copy numbers stripped — the same script
                across variants rolls up to one concept
  creator       Trybe creator ads only (first token)

Every key is always present (None when not applicable).
"""
import re
import sys
from typing import Optional

_SCHEMA_KEYS = (
    "ad_name", "convention", "creative_id", "agency", "angle", "awareness",
    "format", "media", "product", "concept", "creator", "version", "build",
    "copy_no", "geo", "buying_type", "funnel", "offer", "launch_date",
    "date", "dedup_key",
)

# --- Vocabularies ----------------------------------------------------------
# Angle tokens are matched case-insensitively after removing spaces, slashes
# and underscores, so "Dad_Bod_/_Fatty_liver", "DadBod", "Aging Skin" all hit.
ANGLES = {
    "highcholesterol": "High Cholesterol", "cholesterol": "High Cholesterol",
    "highbloodpressure": "High Blood Pressure", "bloodpressure": "High Blood Pressure",
    "hbp": "High Blood Pressure",
    "bloodsugar": "Blood Sugar", "type2diabetes": "Blood Sugar", "diabetes": "Blood Sugar",
    "kidneyhealth": "Kidney Health", "kidney": "Kidney Health",
    "fattyliver": "Fatty Liver", "dadbod": "Dad Bod / Fatty Liver",
    "dadbodfattyliver": "Dad Bod / Fatty Liver",
    "erectiledysfunction": "Erectile Dysfunction", "ed": "Erectile Dysfunction",
    "poorcirculation": "Circulation", "circulation": "Circulation",
    "lownitricoxide": "Nitric Oxide", "nitratepreservation": "Nitric Oxide",
    "nitricoxide": "Nitric Oxide",
    "agingskin": "Aging Skin", "skinaging": "Aging Skin", "facialaging": "Aging Skin",
    "dullskin": "Dull Skin", "skindullness": "Dull Skin",
    "weightloss": "Weight Loss", "waterretention": "Water Retention",
    "parasites": "Parasites", "energy": "Energy", "afternoonenergy": "Energy",
    "afternooncrashes": "Energy", "oxidativestress": "Oxidative Stress",
    "agingconcerns": "Aging Skin", "poorabsorption": "Absorption",
    "highcortisol": "High Cortisol", "cortisol": "High Cortisol",
    "sleep": "Sleep", "bloating": "Bloating", "gut": "Gut Health",
    "joint": "Joint", "heart": "Heart Health", "hearthealth": "Heart Health",
    "sale": "Sale", "glutabenefits": "Glutathione Benefits",
    "symptomstack": "Symptom Stack",
    "neuropathy": "Neuropathy", "liverhealth": "Liver Health",
    "ldl": "High Cholesterol", "prostatehealth": "Prostate Health", "prostate": "Prostate Health",
    "productquality": "Product Quality", "inflammation": "Inflammation",
    "flash-sale": "Sale", "flashsale": "Sale",
}

AWARENESS = {"SA", "UA", "PDA", "PA", "PR", "UN", "MA", "TP1", "TP2", "TP3", "NN"}

FORMATS = {
    "longformstaticscript": "Long-Form Static", "lfs": "Long-Form Static",
    "netnewlfs": "Long-Form Static",
    "static": "Static", "image": "Static",
    "vsl": "VSL", "ugc": "UGC", "video": "Video",
    "aiavatardeepfake": "AI Avatar", "aiavatar": "AI Avatar",
    "aicharacters": "AI Characters", "aiauthority": "AI Authority",
    "a.iauthority": "AI Authority",
    "movie": "Movie", "songad": "Song Ad",
    "broll": "B-Roll", "b-roll": "B-Roll", "voiceoverbroll": "B-Roll",
    "hook/lead": "Hook/Lead", "tiktokstyle": "TikTok Style",
    "doctor": "Doctor", "warehouse": "Warehouse", "organic": "Organic",
    "faceless": "Faceless", "claymation": "Claymation",
    "hooklead": "Hook/Lead", "3danimation": "3D Animation", "animation": "3D Animation",
    "unboxing": "Unboxing", "skeleton": "3D Animation", "ph": "Static", "photo": "Static",
    "staticimage": "Static",
    "a.i-ugc": "AI UGC", "ai-ugc": "AI UGC", "aiugc": "AI UGC",
}

# Product: explicit prefixes first, then words anywhere in ad/campaign name.
PRODUCT_PREFIX = {
    "BR": "Beetroot", "RB": "Beetroot", "BEETROOT": "Beetroot", "BT": "Beetroot",
    "LYMPHORIA": "Lymphoria", "PRIMECELL": "Primecell",
    "MRG": None, "MR": None,  # agency prefixes, not products
}
PRODUCT_WORDS = [
    ("glutathione", "Glutathione"), ("moringa", "Moringa"),
    ("magnesium", "Magnesium"), ("lymphoria", "Lymphoria"),
    ("primecell", "Primecell"), ("beetroot", "Beetroot"), ("beets", "Beetroot"),
    ("beet", "Beetroot"),
]

BUILD = {"NEW", "VAR", "N"}

# Media type, derived from format. Kept in sync with src/aggregator.js.
STATIC_FORMATS = {"Static", "Long-Form Static"}
VIDEO_FORMATS = {"Video", "VSL", "UGC", "AI Avatar", "AI Characters", "AI Authority",
                 "Movie", "Song Ad", "B-Roll", "Hook/Lead", "TikTok Style", "Doctor",
                 "Warehouse", "Organic", "Faceless", "Claymation", "AI UGC",
                 "3D Animation", "Unboxing"}


def media_type(fmt, name: str) -> Optional[str]:
    """'Video' or 'Static'. Uses the parsed format first, then name hints
    ('StaticImage', '15s', 'VSL') for ads whose format token is unknown."""
    if fmt in STATIC_FORMATS:
        return "Static"
    if fmt in VIDEO_FORMATS:
        return "Video"
    low = (name or "").lower()
    if re.search(r"static|image|\bimg\b|lfs", low):
        return "Static"
    if re.search(r"video|vsl|ugc|movie|broll|b-roll|\d{1,3}s\b|reel", low):
        return "Video"
    return None
CREATIVE_ID = re.compile(r"^([A-Z]{2,5})(\d{2,4})([A-Za-z0-9.\-]*)$")
VERSION = re.compile(r"^V(\d{1,2})$", re.I)
NOT_AGENCY = {"TP", "V", "W", "NN"}


def _blank() -> dict:
    return {k: None for k in _SCHEMA_KEYS}


def _key(tok: str) -> str:
    return re.sub(r"[\s/_]+", "", tok).lower()


def parse_campaign(campaign: Optional[str]) -> dict:
    out = {"product": None, "geo": None, "buying_type": None,
           "funnel": None, "offer": None}
    if not campaign:
        return out
    parts = [p.strip() for p in campaign.split("|") if p.strip()]
    low = campaign.lower()
    for w, prod in PRODUCT_WORDS:
        if w in low:
            out["product"] = prod
            break
    for p in parts:
        up = p.upper()
        if re.fullmatch(r"(US|CA|UK|AU|NZ|AUS/NZ|US/CA|T4|CANADA|EU|DE|FR)", up):
            out["geo"] = {"CANADA": "CA"}.get(up, up)
        if re.search(r"\bCBO\b", up):
            out["buying_type"] = "CBO"
        elif re.search(r"\bABO\b", up):
            out["buying_type"] = "ABO"
        elif re.search(r"\bASC\b|ADVANTAGE", up):
            out["buying_type"] = "ASC"
    for f in ("TOFU", "MOFU", "BOFU", "BOF", "TOF"):
        if re.search(rf"\b{f}\b", campaign.upper()):
            out["funnel"] = {"TOF": "TOFU", "BOF": "BOFU"}.get(f, f)
            break
    if "non bogo" in low or "non-bogo" in low:
        out["offer"] = "Non-BOGO"
    elif "bogo" in low:
        out["offer"] = "BOGO"
    return out


def _hook_text(tokens: list) -> Optional[str]:
    """Trailing run of caps/words after the structured part = hook line."""
    words = []
    for t in tokens:
        words.append(t)
    text = " ".join(words).strip()
    # Strip trailing copy counters: ".1", " 2", "_3", " – Copy"
    text = re.sub(r"\s*[–-]\s*Copy.*$", "", text, flags=re.I)
    text = re.sub(r"[\s.]+\d{1,2}$", "", text)
    text = re.sub(r"\s+", " ", text).strip(" .,_")
    return text.upper() or None


def parse_ad_name(name: str, campaign: Optional[str] = None,
                  adset: Optional[str] = None) -> dict:
    out = _parse(name, campaign, adset)
    out["media"] = media_type(out.get("format"), name)
    return out


def _parse(name: str, campaign: Optional[str] = None,
           adset: Optional[str] = None) -> dict:
    out = _blank()
    raw = (name or "").strip()
    out["ad_name"] = raw
    out["dedup_key"] = raw
    camp = parse_campaign(campaign)
    for k in ("geo", "buying_type", "funnel", "offer"):
        out[k] = camp[k]

    m = re.search(r"[\s._](\d{1,2})$", raw)
    if m:
        out["copy_no"] = m.group(1)

    # --- Creator (Trybe) ads: Name_Product_Angletrybe=hash
    if "trybe=" in raw.lower():
        base = re.split(r"trybe=", raw, flags=re.I)[0]
        toks = [t for t in base.split("_") if t]
        out["convention"] = "creator"
        out["creator"] = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", toks[0]) if toks else None
        rest = toks[1:]
        for t in rest:
            for w, prod in PRODUCT_WORDS:
                if w in t.lower():
                    out["product"] = prod
        if rest:
            out["angle"] = ANGLES.get(_key(rest[-1]), re.sub(r"(?<=[a-z])(?=[A-Z])", " ", rest[-1]))
        out["format"] = "UGC"
        out["agency"] = "Trybe"
        out["concept"] = f"{out['creator']} · {out['angle']}" if out["creator"] else None
        out["product"] = out["product"] or camp["product"]
        return out

    tokens = raw.split("_")
    first = tokens[0].upper() if tokens else ""
    cid_idx = None
    ver_idx = None

    for i, t in enumerate(tokens):
        tt = t.strip()
        if not tt:
            continue
        up = tt.upper()
        m = CREATIVE_ID.match(tt)
        if (cid_idx is None and m and m.group(1) not in NOT_AGENCY
                and not VERSION.match(tt) and up not in AWARENESS):
            out["creative_id"] = tt
            ag = m.group(1)
            # PR writes gendered/series variants (PRME, PRFE, PRBE, PRE) — one agency.
            out["agency"] = "PR" if ag.startswith("PR") else ag
            cid_idx = i
            continue
        if VERSION.match(tt) and out["version"] is None:
            out["version"] = f"V{VERSION.match(tt).group(1)}"
            ver_idx = i
            continue
        if up in BUILD and out["build"] is None:
            out["build"] = {"N": "NEW"}.get(up, up)
            continue
        if up in AWARENESS and out["awareness"] is None:
            out["awareness"] = up
            continue
        k = _key(tt)
        if out["angle"] is None and k in ANGLES:
            out["angle"] = ANGLES[k]
            continue
        if out["format"] is None and k in FORMATS:
            out["format"] = FORMATS[k]
            continue
        if out["format"] is None and k.startswith("ugc") and len(k) > 3:
            out["format"] = "UGC"   # UGCLeslie, UGCEric — creator glued on
            continue

    # Multi-token angles split by underscores ("Dad_Bod_/_Fatty_liver").
    if out["angle"] is None:
        joined = _key(raw)
        for k, v in sorted(ANGLES.items(), key=lambda kv: -len(kv[0])):
            if len(k) >= 6 and k in joined:
                out["angle"] = v
                break

    # Convention + product
    if cid_idx == 0:
        out["convention"] = "id_first"
    elif first in PRODUCT_PREFIX or first.lower() in dict(PRODUCT_WORDS):
        out["convention"] = "product_first"
        p = PRODUCT_PREFIX.get(first)
        if p is None and first not in PRODUCT_PREFIX:
            p = dict(PRODUCT_WORDS).get(first.lower())
        out["product"] = p
        if first in ("MRG", "MR") and out["agency"] is None:
            out["agency"] = first
    elif re.match(r"^\d{6,8}$", first):
        out["convention"] = "legacy_dated"
    else:
        out["convention"] = "product_first" if out["angle"] else "freeform"

    if out["product"] is None:
        low = raw.lower()
        for w, prod in PRODUCT_WORDS:
            if w in low:
                out["product"] = prod
                break
    out["product"] = out["product"] or camp["product"]

    # Hook text = everything after the version token (or after the creative
    # id when there is no version), for the structured conventions.
    anchor = max(i for i in (ver_idx, cid_idx, -1) if i is not None)
    if anchor >= 0 and anchor < len(tokens) - 1:
        tail = tokens[anchor + 1:]
        # ID-first names put angle/awareness/format/product after the version;
        # drop leading structured tokens so the concept is the hook itself.
        while tail:
            t = tail[0].strip()
            k = _key(t)
            if (not t or t.upper() in AWARENESS or k in ANGLES or k in FORMATS
                    or t.upper() in BUILD or t.upper() in {"NONE", "BOTH", "FRMT", "MSG", "NO", "DN", "RB", "BR"}
                    or k in dict(PRODUCT_WORDS) or t in {"Rosabella", "Competitor", "Primecell", "Lymphoria", "Purelia"}
                    or VERSION.match(t)):
                tail = tail[1:]
                continue
            break
        out["concept"] = _hook_text(tail)
    if out["concept"] is None and out["creative_id"]:
        out["concept"] = out["creative_id"]
    return out


# --- Coverage / self-test ---------------------------------------------------
FIXTURES = [
    ("BR_HighCholesterol_PDA_LongFormStaticScript_No_NO_PR_NEW_PRME609_V1_I_FILL_340_STATIN_PRESCRIPTIONS_A_WEEK.1",
     {"creative_id": "PRME609", "agency": "PR", "angle": "High Cholesterol", "awareness": "PDA", "media": "Static",
      "format": "Long-Form Static", "product": "Beetroot", "version": "V1", "build": "NEW",
      "concept": "I FILL 340 STATIN PRESCRIPTIONS A WEEK"}),
    ("MX146_NEW_NONE_V1_HighCholesterol_NN_MOVIE_Rosabella_MORNING,_MA'AM._I'VE_GOT_ANOTHER_ONE_FOR_YOU._2",
     {"creative_id": "MX146", "agency": "MX", "angle": "High Cholesterol", "format": "Movie",
      "convention": "id_first", "concept": "MORNING, MA'AM. I'VE GOT ANOTHER ONE FOR YOU", "media": "Video"}),
    ("CA683_VAR_NONE_V4_HighCholesterol_TP3_AICharacters_RB_Hey_Hey_Get_Your_Hands_Off_Him",
     {"creative_id": "CA683", "agency": "CA", "build": "VAR", "version": "V4", "awareness": "TP3",
      "format": "AI Characters", "concept": "HEY HEY GET YOUR HANDS OFF HIM"}),
    ("HannaGlenn_Glutathione_DullSkintrybe=f6cb19e9",
     {"convention": "creator", "creator": "Hanna Glenn", "product": "Glutathione", "angle": "Dull Skin"}),
    ("BR_Dad_Bod_/_Fatty_liver_PR___JA__JA005_6_SURGEONS_HAVE_A_NICKNAME_FOR_THE_CLASSIC_DAD_BOD._1",
     {"creative_id": "JA005", "agency": "JA", "angle": "Dad Bod / Fatty Liver", "awareness": "PR"}),
    ("BR_Sale_NO_LongFormStaticScript_MA_CZ_N_No_CH018v38a1_V1_ONE_CAPSULE_A_DAY._THAT_IS_THE_WHOLE_HABIT_2",
     {"creative_id": "CH018v38a1", "agency": "CH", "angle": "Sale", "awareness": "MA"}),
    ("MRG_WeightLoss_UA_Video___MOVIE_MX002_V1_WAIT._IS_THAT_SHARON?",
     {"creative_id": "MX002", "agency": "MX", "angle": "Weight Loss", "format": "Video"}),
    ("Rosabella_WeightLoss_SA_Static_NONE_MRG_TA_NEW_TA004_V1_MY_SISTER_STARTED_TAKING_OZEMPIC_IN_JUNE_2025.1",
     {"creative_id": "TA004", "agency": "TA", "angle": "Weight Loss", "format": "Static"}),
    ("JK178_VAR_NONE_V1_BloodSugar_NN_Doctor_RB_5_Señales_De_Advertencia 3",
     {"creative_id": "JK178", "angle": "Blood Sugar", "format": "Doctor", "awareness": "NN"}),
    ("BR_HighBloodPressure_PDA_AIAVATARdeepfake_No_CH_NP_Original_NP135c-v2_V2_DO_NOT_BUY_ROSABELLA_BEETROOT.2",
     {"creative_id": "NP135c-v2", "agency": "NP", "angle": "High Blood Pressure", "format": "AI Avatar"}),
]


def _selftest() -> int:
    bad = 0
    for name, want in FIXTURES:
        got = parse_ad_name(name)
        for k, v in want.items():
            if got.get(k) != v:
                bad += 1
                print(f"FAIL {k}: want {v!r} got {got.get(k)!r}\n     {name}")
    print(f"{len(FIXTURES)} fixtures, {bad} field mismatches")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(_selftest())
