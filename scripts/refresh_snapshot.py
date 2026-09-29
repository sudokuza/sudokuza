#!/usr/bin/env python3
"""Refresh the deployable JSON snapshot from the same live data pipeline."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from market_data import build_payload  # noqa: E402


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    data_dir = ROOT / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    payload = build_payload(force=True)
    meta = dict(payload.get("meta") or {})
    meta["snapshotAt"] = payload.get("syncedAt", "")
    meta["snapshotSource"] = payload.get("source", "snapshot")

    write_json(data_dir / "stocks.json", payload.get("stocks", []))
    write_json(data_dir / "market.json", payload.get("market", {}))
    write_json(data_dir / "meta.json", meta)

    coverage = payload.get("coverage") or {}
    print(
        f"Snapshot saved: {payload.get('rows', 0)} rows; "
        f"quotes {coverage.get('quoteAvailable', 0)}/{coverage.get('universe', 0)}; "
        f"source={payload.get('source')}; "
        f"roster={'verified' if coverage.get('rosterVerified') else 'provisional'}."
    )


if __name__ == "__main__":
    main()
