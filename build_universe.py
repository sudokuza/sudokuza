#!/usr/bin/env python3
"""Build a provisional IDX ticker roster from the Feb 2026 KSEI snapshot.

This is intentionally marked unverified: the count matches IDX's reported
recordsTotal, but the codes have not been reconciled one-by-one against IDX.
"""
from __future__ import annotations

import csv
import io
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "universe.json"
KSEI_CSV_URL = (
    "https://raw.githubusercontent.com/aryakdaniswara/idx-stock-ownership/"
    "main/data/kepemilikan_saham_20260227.csv"
)
EXPECTED_COUNT = 962

# Listings after the KSEI CSV snapshot. Names are normalized against the IPO
# listing announcements; code-by-code reconciliation with IDX is still pending.
POST_SNAPSHOT_LISTINGS = {
    "WBSA": {"name": "PT BSA Logistics Indonesia Tbk", "listingDate": "2026-04-10"},
    "JELI": {"name": "PT Niramas Utama Tbk", "listingDate": "2026-07-07"},
    "JECX": {"name": "PT Nitrasanata Dharma Tbk", "listingDate": "2026-07-07"},
    "BACH": {"name": "PT Bach Multi Global Tbk", "listingDate": "2026-07-08"},
    "EMMI": {"name": "PT Esa Medika Mandiri Tbk", "listingDate": "2026-07-08"},
    "PRDL": {"name": "PT Prodia Diagnostic Line Tbk", "listingDate": "2026-07-09"},
    "RANS": {"name": "PT Rans Entertainment Indonesia Tbk", "listingDate": "2026-07-10"},
}


def clean_name(value: str) -> str:
    value = re.sub(r"\s+", " ", (value or "").strip())
    comparable = re.sub(r"\s+TBK\.?$", "", value, flags=re.IGNORECASE)
    if comparable.isupper():
        value = value.title()
    # Keep common Indonesian corporate suffixes legible after title-casing.
    value = re.sub(r"\bTbk\.?$", "Tbk", value, flags=re.IGNORECASE)
    value = re.sub(r"\bPt\b", "PT", value)
    return value


def fetch_ksei_codes() -> tuple[dict[str, str], int]:
    request = urllib.request.Request(
        KSEI_CSV_URL,
        headers={"User-Agent": "Mozilla/5.0 (compatible; ScreenerIDX/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        text = response.read().decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    codes: dict[str, str] = {}
    for row in reader:
        ticker = (row.get("share_code") or "").strip().upper()
        if not ticker:
            continue
        name = clean_name(row.get("issuer_name") or "")
        if ticker not in codes or (not codes[ticker] and name):
            codes[ticker] = name
    return codes, len(text.encode("utf-8"))


def main() -> None:
    codes, _ = fetch_ksei_codes()
    additions = 0
    for ticker, details in POST_SNAPSHOT_LISTINGS.items():
        if ticker not in codes:
            codes[ticker] = details["name"]
            additions += 1

    if len(codes) != EXPECTED_COUNT:
        raise SystemExit(
            f"Refusing to write roster: expected {EXPECTED_COUNT} unique codes, "
            f"found {len(codes)}. Review the source/update list first."
        )

    issuers = []
    for ticker in sorted(codes):
        item = {"ticker": ticker, "name": codes[ticker] or ticker, "source": "KSEI-2026-02-27"}
        if ticker in POST_SNAPSHOT_LISTINGS:
            item.update(POST_SNAPSHOT_LISTINGS[ticker])
            item["source"] = "IDX/e-IPO-2026-listing"
        issuers.append(item)

    payload = {
        "count": len(issuers),
        "asOf": "2026-09-29",
        "verifiedAgainstIDX": False,
        "rosterSource": "KSEI ownership CSV dated 2026-02-27 + seven 2026 IPO listings",
        "verificationNote": (
            "Provisional roster only. The count matches IDX's reported 962 records, "
            "but the codes have not been reconciled one-by-one against the official IDX list."
        ),
        "sourceUrl": KSEI_CSV_URL,
        "ipoListings": list(POST_SNAPSHOT_LISTINGS),
        "issuers": issuers,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(issuers)} provisional issuer codes to {OUTPUT.relative_to(ROOT)} "
        f"({additions} IPO additions; official code-by-code check still required)."
    )


if __name__ == "__main__":
    main()
