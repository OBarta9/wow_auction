#!/usr/bin/env python3
"""WoW Auction Helper - command line entry point.

    python wowah.py fetch         download current prices (TSM public data + Blizzard API if configured)
    python wowah.py houses        list the API's auction houses (needs Blizzard keys); --check verifies
                                  which houses belong to your ruleset by comparing with TSM data
    python wowah.py serve         open the web UI on http://localhost:8000
    python wowah.py run           fetch, then serve
    python wowah.py build-db      (re)build the static recipe/item database

Only the Python standard library is used (Python 3.10+).
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import sys
import threading
import webbrowser

from pipeline.config import WEB_DIR, load_config


def cmd_houses(args) -> None:
    from pipeline.houses import list_houses

    list_houses(load_config(), check=args.check)


def cmd_fetch(args) -> None:
    from pipeline.fetch import run_fetch

    meta = run_fetch(load_config())
    print(json.dumps({k: v for k, v in meta.items() if k != "houses"}, indent=1))


def cmd_serve(args) -> None:
    handler = functools.partial(_QuietHandler, directory=str(WEB_DIR))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://localhost:{args.port}/"
    print(f"Serving {WEB_DIR} at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_run(args) -> None:
    cmd_fetch(args)
    cmd_serve(args)


def cmd_build_db(args) -> None:
    from pipeline.build_db import build

    build(build_id=args.build, cache=not args.no_cache)


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):  # keep the console readable
        if not str(a[1] if len(a) > 1 else "").startswith(("2", "3")):
            super().log_message(fmt, *a)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("houses", help="list auction houses of your ruleset (Blizzard API)")
    s.add_argument("--check", action="store_true", help="compare each house with TSM data to find yours")
    s.set_defaults(func=cmd_houses)

    s = sub.add_parser("fetch", help="download auction data")
    s.set_defaults(func=cmd_fetch)

    for name, fn in (("serve", cmd_serve), ("run", cmd_run)):
        s = sub.add_parser(name)
        s.add_argument("--port", type=int, default=8000)
        s.add_argument("--no-browser", action="store_true")
        s.set_defaults(func=fn)

    s = sub.add_parser("build-db", help="rebuild web/data/static from game data tables")
    s.add_argument("--build", help="game build string, e.g. 1.15.8.65000 (default: latest known)")
    s.add_argument("--no-cache", action="store_true", help="re-download source tables")
    s.set_defaults(func=cmd_build_db)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
