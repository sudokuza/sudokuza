#!/usr/bin/env python3
"""Build a self-contained index.html from the editable HTML/CSS/JS and snapshot."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

template = (ROOT / "index.template.html").read_text(encoding="utf-8")
css = (ROOT / "styles.css").read_text(encoding="utf-8")
js = (ROOT / "app.js").read_text(encoding="utf-8")
stocks = json.loads((ROOT / "data" / "stocks.json").read_text(encoding="utf-8"))
market = json.loads((ROOT / "data" / "market.json").read_text(encoding="utf-8"))
meta = json.loads((ROOT / "data" / "meta.json").read_text(encoding="utf-8"))

stylesheet_link = '<link rel="stylesheet" href="styles.css">'
inline_styles = '<style>\n' + css + '\n</style>'
if stylesheet_link not in template:
    raise SystemExit("Stylesheet link was not found in index.template.html")
template = template.replace(stylesheet_link, inline_styles, 1)

script_tag = '<script src="app.js" defer></script>'
snapshot = json.dumps({"stocks": stocks, "market": market, "meta": meta}, ensure_ascii=False, separators=(",", ":"))
# Protect against an accidental </script sequence inside future sheet text.
snapshot = snapshot.replace("</", "<\\/")
inline_scripts = '<script>window.SCREENER_SNAPSHOT = ' + snapshot + ';</script>\n'
inline_scripts += '<script>\n' + js + '\n</script>'
if script_tag not in template:
    raise SystemExit("App script tag was not found in index.template.html")
template = template.replace(script_tag, inline_scripts, 1)

(ROOT / "index.html").write_text(template, encoding="utf-8")
print(f"Built standalone index.html with {len(stocks)} snapshot rows ({(ROOT / 'index.html').stat().st_size:,} bytes).")
