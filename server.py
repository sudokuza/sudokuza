#!/usr/bin/env python3
"""Local static server and same-origin data bridge for the screener."""
from __future__ import annotations

import json
import os
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from market_data import build_payload

ROOT = Path(__file__).resolve().parent


class ScreenerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/data":
            query = urllib.parse.parse_qs(parsed.query)
            force = query.get("refresh", [""])[0] == "1"
            try:
                payload = build_payload(force=force)
                self._send_json(200, payload)
            except Exception as error:
                print(f"[screener] API data error: {error}")
                self._send_json(500, {"error": "data_unavailable", "message": "Data tidak dapat dimuat."})
            return
        if parsed.path == "/api/health":
            self._send_json(200, {"ok": True, "app": "Sinyal & Trend"})
            return
        super().do_GET()

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[web] {self.address_string()} {fmt % args}")


def main():
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer(("0.0.0.0", port), ScreenerHandler)
    server.daemon_threads = True
    print(f"Screener IDX running at http://0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
