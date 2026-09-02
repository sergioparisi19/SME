"""Build and preview the static site.

Kept out of `sme_pipeline/` on purpose: that package is the data pipeline, and
this is the presentation layer that reads its output. Nothing here touches the
Parquet tables - it only turns them into the curated bundle the page fetches,
then serves the folder so you can iterate on the HTML.

The folder is named docs/ because that is one of only two locations GitHub
Pages will serve from on a branch deployment; the other is the repo root.

    python build_site.py              # rebuild data/*.json, then serve
    python build_site.py --no-serve   # rebuild only (what CI would run)
    python build_site.py --no-build   # serve what is already there
    python build_site.py --port 8000

Serving matters: opening index.html from disk gives it a file:// origin, where
fetch() is blocked and the page stalls on "Loading data...". It needs HTTP.
"""

from __future__ import annotations

import argparse
import contextlib
import socket
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from sme_pipeline.export import SITE_DATA_DIR, export

SITE_DIR = Path(__file__).resolve().parent / "docs"


class Handler(SimpleHTTPRequestHandler):
    """Static handler that never lets a browser cache a stale bundle."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter than the default one-line-per-asset
        if "GET / " in fmt % args or ".json" in (fmt % args):
            super().log_message(fmt, *args)


def build() -> None:
    written = export(SITE_DATA_DIR)
    total = sum(written.values())
    for name, size in written.items():
        print(f"  {name:<14} {size / 1024:>8.1f} KB")
    print(f"  {'total':<14} {total / 1024:>8.1f} KB")


def free_port(preferred: int) -> int:
    """Fall back to an ephemeral port rather than dying on 'address in use'."""
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def serve(port: int, open_browser: bool) -> None:
    port = free_port(port)
    url = f"http://127.0.0.1:{port}/"
    handler = partial(Handler, directory=str(SITE_DIR))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"\nServing {SITE_DIR} at {url}")
        print("This URL is local to this machine and stops when you press Ctrl+C.")
        if open_browser:
            webbrowser.open(url)
        with contextlib.suppress(KeyboardInterrupt):
            httpd.serve_forever()
        print("\nStopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8731)
    parser.add_argument("--no-build", action="store_true", help="skip regenerating data/*.json")
    parser.add_argument("--no-serve", action="store_true", help="build and exit")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    if not args.no_build:
        print("Building page-ready export...")
        build()

    if not args.no_serve:
        serve(args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    main()
