"""Diagnosis kesegaran data: /api/debug?ticker=SEMA

Membandingkan baris mentah dari scanner TradingView dengan quote Yahoo Finance (SEMA.JK)
lengkap dengan cap waktunya, supaya kelihatan sumber mana yang tertinggal.
Hanya membaca data pasar publik; tidak ada data pribadi.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from market_data import TV_COLUMNS, TV_SCAN_URL, now_wib  # noqa: E402

UA = "Mozilla/5.0 (compatible; ScreenerIDX/1.0)"
WIB = ZoneInfo("Asia/Jakarta")


def _wib(ts):
    try:
        return datetime.fromtimestamp(int(ts), WIB).strftime("%d %b %Y %H:%M:%S WIB")
    except (TypeError, ValueError, OSError):
        return None


def tradingview_row(ticker: str) -> dict:
    columns = TV_COLUMNS + ["update_mode"]
    result = {"ok": False}
    for cols in (columns, TV_COLUMNS):  # kalau kolom update_mode ditolak, ulangi tanpa itu
        payload = {
            "filter": [{"left": "type", "operation": "equal", "right": "stock"}],
            "options": {"lang": "en"},
            "markets": ["indonesia"],
            "symbols": {"query": {"types": ["stock"]}, "tickers": []},
            "columns": cols,
            "range": [0, 1000],
        }
        request = urllib.request.Request(
            TV_SCAN_URL,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": UA, "Cache-Control": "no-cache"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=14) as response:
                headers = {k.lower(): v for k, v in response.headers.items()}
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            result["error"] = f"HTTP {error.code}"
            continue
        except Exception as error:  # noqa: BLE001 - endpoint diagnosis, tampilkan apa adanya
            result["error"] = str(error)
            break
        for item in body.get("data", []):
            row = dict(zip(cols, item.get("d") or []))
            if str(row.get("name", "")).upper() == ticker:
                result = {"ok": True, "row": row, "totalCount": body.get("totalCount"),
                          "responseHeaders": {k: headers[k] for k in
                                              ("date", "age", "cache-control", "x-cache", "cf-cache-status", "last-modified")
                                              if k in headers}}
                return result
        result = {"ok": False, "error": f"{ticker} tidak ada di hasil scan ({len(body.get('data', []))} baris)"}
        return result
    return result


def yahoo_quote(ticker: str) -> dict:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}.JK?interval=1m&range=1d"
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            body = json.loads(response.read().decode("utf-8"))
        result = body["chart"]["result"][0]
        meta = result.get("meta", {})
        stamps = result.get("timestamp") or []
        closes = (result.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
        last_price = next((c for c in reversed(closes) if c is not None), None)
        price = meta.get("regularMarketPrice", last_price)
        previous = meta.get("chartPreviousClose") or meta.get("previousClose")
        change = round((price / previous - 1) * 100, 2) if price and previous else None
        return {"ok": True, "price": price, "previousClose": previous, "changePct": change,
                "marketTime": _wib(meta.get("regularMarketTime")),
                "lastCandle": _wib(stamps[-1]) if stamps else None}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": str(error)}


def diagnose(tv: dict, yahoo: dict) -> str:
    if not tv.get("ok"):
        return "Scan TradingView gagal dari server Vercel; halaman akan jatuh ke snapshot lama."
    tv_price = tv["row"].get("close")
    if not yahoo.get("ok") or tv_price in (None, 0):
        return "Yahoo tidak bisa dijadikan pembanding; bandingkan angka TradingView di bawah dengan aplikasi sekuritasmu."
    gap = abs(tv_price - yahoo["price"]) / yahoo["price"] * 100
    if gap < 0.5:
        return ("Harga TradingView dan Yahoo cocok. Kalau aplikasi sekuritasmu beda, sumber tertunda "
                "atau perbandinganmu berbeda waktu.")
    return (f"Harga TradingView ({tv_price}) beda {gap:.1f}% dari Yahoo ({yahoo['price']}, update "
            f"{yahoo.get('marketTime')}). Kemungkinan besar feed TradingView tertinggal.")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        ticker = (query.get("ticker", ["SEMA"])[0] or "SEMA").strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{3,6}", ticker):
            self._send(400, {"error": "ticker tidak valid"})
            return
        tv = tradingview_row(ticker)
        yahoo = yahoo_quote(ticker)
        self._send(200, {"ticker": ticker, "serverTime": now_wib(),
                         "diagnosis": diagnose(tv, yahoo), "tradingview": tv, "yahoo": yahoo})

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[vercel-debug] " + (fmt % args))
