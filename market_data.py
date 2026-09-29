"""Shared market-data layer for local development and Vercel functions.

Stock rows are built from a full issuer roster plus TradingView scanner quotes.
The 489 rows in APP_EMITEN are deliberately never used as the stock universe.
"""
from __future__ import annotations

import csv
import io
import json
import math
import statistics
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UNIVERSE_PATH = DATA_DIR / "universe.json"
STOCKS_PATH = DATA_DIR / "stocks.json"
MARKET_PATH = DATA_DIR / "market.json"
META_PATH = DATA_DIR / "meta.json"

SHEET_ID = "1DbdIm2NEoMTARuqjCi0DcA1dyOr6Yce77F5EkLQoT3k"
SHEETS_CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet="
TV_SCAN_URL = "https://scanner.tradingview.com/indonesia/scan"
TV_COLUMNS = [
    "name",
    "description",
    "close",
    "open",
    "high",
    "low",
    "change",
    "volume",
    "average_volume_30d_calc",
    "price_earnings_ttm",
    "SMA20",
    "SMA50",
]
CACHE_SECONDS = 60

_cache_lock = threading.Lock()
_cache: dict = {"created": 0.0, "payload": None}


def now_wib() -> str:
    return datetime.now(ZoneInfo("Asia/Jakarta")).strftime("%d %b %Y %H:%M WIB")


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return default


def numeric(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def round_sheet(value: float, digits: int = 0):
    """Google Sheets ROUND behavior for the non-negative values used here."""
    scale = 10 ** digits
    magnitude = math.floor(abs(value) * scale + 0.5) / scale
    rounded = math.copysign(magnitude, value)
    if digits == 0:
        return int(rounded)
    return rounded


def load_universe() -> tuple[list[dict], dict]:
    document = _read_json(UNIVERSE_PATH, {})
    issuers = document.get("issuers", []) if isinstance(document, dict) else []
    clean = []
    seen = set()
    for issuer in issuers:
        ticker = str(issuer.get("ticker") or "").strip().upper()
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        clean.append({
            "ticker": ticker,
            "name": str(issuer.get("name") or ticker).strip(),
        })
    meta = {
        "count": len(clean),
        "rosterSource": document.get("rosterSource", "Roster lokal"),
        "rosterVerified": bool(document.get("verifiedAgainstIDX", False)),
        "rosterNote": document.get("verificationNote", ""),
        "rosterAsOf": document.get("asOf", ""),
    }
    return clean, meta


def fetch_tradingview_scan() -> tuple[dict[str, dict], int]:
    payload = {
        "filter": [{"left": "type", "operation": "equal", "right": "stock"}],
        "options": {"lang": "en"},
        "markets": ["indonesia"],
        "symbols": {"query": {"types": ["stock"]}, "tickers": []},
        "columns": TV_COLUMNS,
        "range": [0, 1000],
    }
    request = urllib.request.Request(
        TV_SCAN_URL,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (compatible; ScreenerIDX/1.0)",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=14) as response:
        result = json.loads(response.read().decode("utf-8"))

    records: dict[str, dict] = {}
    for item in result.get("data", []):
        values = item.get("d") or []
        row = dict(zip(TV_COLUMNS, values))
        ticker = str(row.get("name") or "").strip().upper()
        if ticker:
            records[ticker] = row
    if not records:
        raise ValueError("TradingView returned no stock records")
    return records, int(result.get("totalCount") or len(records))


def _fetch_sheet_csv(tab: str) -> str:
    request = urllib.request.Request(
        SHEETS_CSV_URL + urllib.parse.quote(tab),
        headers={"User-Agent": "Mozilla/5.0 (compatible; ScreenerIDX/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode("utf-8-sig")


def parse_market_sentiment(raw: str) -> dict:
    rows = list(csv.reader(io.StringIO(raw)))
    if not rows or not rows[0]:
        return {}
    # APP_SENTIMEN!A1 is JSON. Google Visualization may append the row-3
    # table header to that cell, so keep the JSON through its final brace.
    cell = rows[0][0]
    end = cell.rfind("}")
    if end < 0:
        return {}
    try:
        result = json.loads(cell[: end + 1])
        if isinstance(result, dict):
            # Do not expose the old 489-row APP_EMITEN summary as if it were
            # calculated over this full-universe screener.
            result.pop("ringkas", None)
            return result
    except json.JSONDecodeError:
        pass
    return {}


def fetch_market_sentiment() -> dict:
    return parse_market_sentiment(_fetch_sheet_csv("APP_SENTIMEN"))


def _sheet_score(rvol, position, change, turnover):
    if any(value is None for value in (rvol, position, change, turnover)):
        return None
    raw = (
        min(rvol, 3) / 3 * 40
        + position * 25
        + min(max(change, 0), 5) / 5 * 20
        + min(turnover, 100) / 100 * 15
    )
    return round_sheet(raw, 0)


def _sheet_psychology(rvol, position, change, turnover):
    if any(value is None for value in (rvol, position, change, turnover)):
        return None
    if rvol >= 2 and position >= 0.8 and change >= 3 and turnover >= 100:
        return "🔥 SUPER BULLISH"
    if rvol >= 2 and position >= 0.7 and change >= 2 and turnover >= 30:
        return "🚀 BREAKOUT"
    if rvol >= 1.5 and position >= 0.6 and -1 <= change <= 2:
        return "🟢 AKUMULASI"
    if rvol >= 1 and position >= 0.6 and change > 0:
        return "👍 BULLISH"
    if rvol >= 1.5 and position < 0.35 and change <= -2:
        return "🔻 SELL OFF"
    if rvol >= 1.5 and position < 0.35 and change > -2:
        return "⚠️ DISTRIBUSI"
    if rvol < 1 and position >= 0.8 and change > 0:
        return "🤔 NAIK NO VOLUME"
    if rvol < 1 and position < 0.3 and change <= -1:
        return "💧 LEMAH SEPI"
    return "➖ SIDEWAYS"


def _sheet_strength(rvol, position, change, turnover):
    if any(value is None for value in (rvol, position, change, turnover)):
        return None
    score = (
        (2 if rvol >= 2 else 1 if rvol >= 1.2 else 0)
        + (2 if position >= 0.7 else 1 if position >= 0.5 else 0)
        + (2 if change >= 2 else 1 if change > 0 else 0)
        + (2 if turnover >= 50 else 1 if turnover >= 10 else 0)
    )
    if score >= 7:
        return "🟩🟩🟩 SANGAT KUAT"
    if score >= 5:
        return "🟩🟩 KUAT"
    if score >= 3:
        return "🟨 SEDANG"
    if score >= 1:
        return "🟧 LEMAH"
    return "🟥 SANGAT LEMAH"


def _sheet_activity(rvol):
    if rvol is None:
        return None
    if rvol >= 3:
        return "🔥 SANGAT AKTIF"
    if rvol >= 2:
        return "🚀 AKTIF"
    if rvol >= 1.2:
        return "🟢 DI ATAS NORMAL"
    if rvol >= 0.8:
        return "➖ NORMAL"
    if rvol >= 0.5:
        return "😴 SEPI"
    return "💤 SANGAT SEPI"


def _sheet_fast_trade(volatility, price, open_price, rvol):
    if any(value is None for value in (volatility, price, open_price, rvol)):
        return None, None
    score = (
        (30 if volatility > 0.03 else 15 if volatility > 0.02 else 0)
        + (30 if price > open_price else 0)
        + (40 if rvol > 1.5 else 20 if rvol > 1 else 0)
    )
    label = "🔥 HOT SCALP (LIAR & VOLUME BESAR)" if score >= 80 else (
        "⚡ AKTIF TRADING" if score >= 50 else "⚠️ SKIP / SEPI"
    )
    return score, f"{score} | {label}"


def _sheet_trend(price, sma20, sma50):
    if any(value is None for value in (price, sma20, sma50)):
        return None
    if price > sma20 > sma50:
        return "🟢 UPTREND"
    if price > sma20 and sma20 <= sma50:
        return "🔵 REBOUND"
    if price <= sma20 and sma20 > sma50:
        return "🟡 PULLBACK"
    return "🔴 DOWNTREND"


def _valuation(pe, median_pe):
    if pe is None:
        return None
    if pe <= 0:
        return "⚠ Rugi / P/E negatif"
    if median_pe is None:
        return None
    if pe < median_pe * 0.6:
        return "💚 Sangat Murah"
    if pe < median_pe:
        return "🟢 Murah"
    if pe < median_pe * 1.8:
        return "🟡 Wajar"
    return "🔴 Mahal"


def _base_stock(issuer: dict) -> dict:
    return {
        "ticker": issuer["ticker"],
        "name": issuer["name"],
        "open": None,
        "price": None,
        "low": None,
        "high": None,
        "pe": None,
        "volatility": None,
        "valuation": None,
        "rvol": None,
        "position": None,
        "change": None,
        "score": None,
        "turnover": None,
        "psychology": None,
        "strength": None,
        "activity": None,
        "fastTrade": None,
        "fastScore": None,
        "trend": None,
        "candidate": None,
        "closeHigh": None,
        "volume": None,
        "averageVolume30d": None,
        "sma20": None,
        "sma50": None,
        "quoteAvailable": False,
        "quoteSource": None,
    }


def build_stock_rows(universe: list[dict], quotes: dict[str, dict]) -> tuple[list[dict], float | None, int]:
    universe_codes = {issuer["ticker"] for issuer in universe}
    matched = {ticker: row for ticker, row in quotes.items() if ticker in universe_codes}
    positive_pe = [
        value for row in matched.values()
        if (value := numeric(row.get("price_earnings_ttm"))) is not None and value > 0
    ]
    median_pe = statistics.median(positive_pe) if positive_pe else None
    output = []

    for issuer in universe:
        stock = _base_stock(issuer)
        row = matched.get(issuer["ticker"])
        if row is None:
            output.append(stock)
            continue

        price = numeric(row.get("close"))
        open_price = numeric(row.get("open"))
        high = numeric(row.get("high"))
        low = numeric(row.get("low"))
        change_raw = numeric(row.get("change"))
        change = round_sheet(change_raw, 2) if change_raw is not None else None
        volume = numeric(row.get("volume"))
        average_volume = numeric(row.get("average_volume_30d_calc"))
        pe = numeric(row.get("price_earnings_ttm"))
        sma20 = numeric(row.get("SMA20"))
        sma50 = numeric(row.get("SMA50"))

        rvol = None
        if volume is not None and average_volume is not None and average_volume > 0:
            rvol = volume / average_volume

        position = None
        if price is not None and low is not None and high is not None:
            # Matches the sheet formula, including its small denominator guard.
            position = round_sheet((price - low) / (high - low + 0.001), 2)

        turnover = None
        if price is not None and volume is not None:
            turnover = round_sheet(price * volume / 1_000_000_000, 2)

        volatility = None
        if high is not None and low is not None and low > 0:
            volatility = (high - low) / low

        score = _sheet_score(rvol, position, change, turnover)
        psychology = _sheet_psychology(rvol, position, change, turnover)
        strength = _sheet_strength(rvol, position, change, turnover)
        activity = _sheet_activity(rvol)
        fast_score, fast_trade = _sheet_fast_trade(volatility, price, open_price, rvol)
        trend = _sheet_trend(price, sma20, sma50)

        stock.update({
            "open": open_price,
            "price": price,
            "low": low,
            "high": high,
            "pe": pe,
            "volatility": volatility,
            "valuation": _valuation(pe, median_pe),
            "rvol": rvol,
            "position": position,
            "change": change,
            "score": score,
            "turnover": turnover,
            "psychology": psychology,
            "strength": strength,
            "activity": activity,
            "fastTrade": fast_trade,
            "fastScore": fast_score,
            "trend": trend,
            # The workbook stores historical candidate booleans, but no
            # candidate-generation formula is present. Do not guess true/false.
            "candidate": None,
            # Transparent approximation: close is in the top 2% of today's range.
            "closeHigh": position >= 0.98 if position is not None else None,
            "volume": volume,
            "averageVolume30d": average_volume,
            "sma20": sma20,
            "sma50": sma50,
            "quoteAvailable": price is not None,
            "quoteSource": "TradingView",
        })
        output.append(stock)

    return output, median_pe, len(matched)


def _read_fallback() -> tuple[list, dict, dict]:
    return (
        _read_json(STOCKS_PATH, []),
        _read_json(MARKET_PATH, {}),
        _read_json(META_PATH, {}),
    )


def _valid_full_snapshot(stocks: list, universe: list[dict]) -> bool:
    if not isinstance(stocks, list) or len(stocks) != len(universe):
        return False
    codes = {str(row.get("ticker") or "").upper() for row in stocks if isinstance(row, dict)}
    return codes == {issuer["ticker"] for issuer in universe}


def build_payload(force: bool = False) -> dict:
    now = time.time()
    with _cache_lock:
        if not force and _cache["payload"] and now - _cache["created"] < CACHE_SECONDS:
            return _cache["payload"]

    universe, roster_meta = load_universe()
    fallback_stocks, fallback_market, fallback_meta = _read_fallback()
    live_quotes = None
    scan_records = 0
    scan_error = None
    live_market = None
    market_error = None

    with ThreadPoolExecutor(max_workers=2) as pool:
        quote_future = pool.submit(fetch_tradingview_scan)
        market_future = pool.submit(fetch_market_sentiment)
        try:
            live_quotes, scan_records = quote_future.result()
        except Exception as error:  # network and upstream schema failures use snapshot fallback
            scan_error = str(error)
            print(f"[screener] TradingView unavailable; using snapshot: {error}")
        try:
            live_market = market_future.result()
        except Exception as error:
            market_error = str(error)
            print(f"[screener] APP_SENTIMEN unavailable; using market snapshot: {error}")

    source = "tradingview" if live_quotes else "snapshot"
    if live_quotes:
        stocks, median_pe, matched_count = build_stock_rows(universe, live_quotes)
        quote_source = "TradingView scanner"
    elif _valid_full_snapshot(fallback_stocks, universe):
        stocks = fallback_stocks
        positive_pe = [
            value for row in stocks
            if (value := numeric(row.get("pe"))) is not None and value > 0
        ]
        median_pe = statistics.median(positive_pe) if positive_pe else None
        matched_count = sum(bool(row.get("quoteAvailable")) for row in stocks)
        quote_source = "snapshot JSON"
    else:
        stocks = [_base_stock(issuer) for issuer in universe]
        median_pe = None
        matched_count = 0
        quote_source = "none"

    market = live_market if live_market else fallback_market
    if isinstance(market, dict):
        market = dict(market)
        market.pop("ringkas", None)
    else:
        market = {}

    quote_count = sum(row.get("price") is not None for row in stocks)
    roster_count = len(universe)
    matched_count = sum(
        1 for row in (live_quotes or {}) if row in {issuer["ticker"] for issuer in universe}
    ) if live_quotes else matched_count
    unmatched_records = max(0, scan_records - matched_count) if live_quotes else None
    synced_at = now_wib()

    meta = dict(fallback_meta or {})
    meta.update({
        "syncedAt": synced_at,
        "snapshotAt": fallback_meta.get("snapshotAt", "") if isinstance(fallback_meta, dict) else "",
        "quoteSource": quote_source,
        "marketSource": "Google Sheets · APP_SENTIMEN" if live_market else "snapshot JSON",
        "rosterSource": roster_meta.get("rosterSource", "Roster lokal"),
        "rosterVerified": roster_meta.get("rosterVerified", False),
        "rosterStatus": "verified" if roster_meta.get("rosterVerified") else "provisional",
        "rosterNote": roster_meta.get("rosterNote", ""),
        "rosterAsOf": roster_meta.get("rosterAsOf", ""),
        "rosterCount": roster_count,
        "quoteCount": quote_count,
        "quoteMissing": max(0, roster_count - quote_count),
        "scannerRecords": scan_records if live_quotes else None,
        "scannerMatched": matched_count if live_quotes else None,
        "scannerUnmatched": unmatched_records,
        "medianPe": median_pe,
        "candidateRuleReady": False,
        "candidateNote": (
            "Formula flag kandidat tidak tersedia di workbook; seluruh flag ditampilkan N/A "
            "agar tidak menebak berdasarkan data historis."
        ),
        "closeHighRule": "Posisi harga >= 98% dari low-high hari ini (heuristik tampilan).",
    })

    payload = {
        "stocks": stocks,
        "market": market,
        "meta": meta,
        "source": source,
        "quoteSource": quote_source,
        "marketSource": meta["marketSource"],
        "syncedAt": synced_at,
        "rows": roster_count,
        "quoteCount": quote_count,
        "coverage": {
            "universe": roster_count,
            "quoteAvailable": quote_count,
            "quoteUnavailable": max(0, roster_count - quote_count),
            "scannerRecords": scan_records if live_quotes else None,
            "scannerMatched": matched_count if live_quotes else None,
            "scannerUnmatched": unmatched_records,
            "rosterVerified": meta["rosterVerified"],
        },
    }
    if scan_error:
        payload["quoteWarning"] = "Feed quote gagal; snapshot lokal digunakan."
    if market_error:
        payload["marketWarning"] = "Ringkasan makro gagal diperbarui; snapshot lokal digunakan."

    with _cache_lock:
        _cache["created"] = time.time()
        _cache["payload"] = payload
    return payload
