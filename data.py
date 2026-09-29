from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from http.server import BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from market_data import build_payload  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") != "/api/data":
            self._send_json(404, {"error": "not_found"})
            return
        query = parse_qs(parsed.query)
        force = query.get("refresh", [""])[0] == "1"
        try:
            self._send_json(200, build_payload(force=force))
        except Exception as error:
            self.log_error("API data error: %s", error)
            self._send_json(500, {"error": "data_unavailable", "message": "Data tidak dapat dimuat."})

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if status != 204:
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[vercel-api] " + (fmt % args))
