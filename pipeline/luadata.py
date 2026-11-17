"""Minimal parser for Lua table literals (used for QuestieDB data files)."""
from __future__ import annotations

import re

_TOKEN = re.compile(
    r"""\s*(?:
      (?P<comment>--\[\[.*?\]\]|--[^\n]*)
    | (?P<lstr>\[\[.*?\]\])
    | (?P<str>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")
    | (?P<num>-?(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?))
    | (?P<punct>[{}\[\]=,;])
    | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)
    )""",
    re.S | re.X,
)
_ESC = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"'}


def _unescape(s: str) -> str:
    return re.sub(r"\\(.)", lambda m: _ESC.get(m.group(1), m.group(1)), s)


def tokens(src: str):
    pos, n = 0, len(src)
    while pos < n:
        m = _TOKEN.match(src, pos)
        if not m:
            if src[pos:].strip() == "":
                return
            raise ValueError(f"unexpected Lua text near: {src[pos:pos + 40]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "comment":
            continue
        v = m.group(kind)
        if kind == "str":
            yield ("str", _unescape(v[1:-1]))
        elif kind == "lstr":
            yield ("str", v[2:-2])
        elif kind == "num":
            yield ("num", int(v, 16) if v.lower().startswith(("0x", "-0x")) else (float(v) if any(c in v for c in ".eE") else int(v)))
        elif kind == "punct":
            yield ("p", v)
        else:
            yield ("name", {"nil": None, "true": True, "false": False}.get(v, v))


def parse_value(src: str):
    """Parse one Lua value (typically a table constructor) into Python.
    Tables become dicts; positional entries get integer keys starting at 1."""
    toks = list(tokens(src))
    i = 0

    def value():
        nonlocal i
        kind, v = toks[i]
        if kind == "p" and v == "{":
            return table()
        i += 1
        return v

    def table():
        nonlocal i
        i += 1  # {
        out, idx = {}, 1
        while toks[i] != ("p", "}"):
            if toks[i] == ("p", "["):
                i += 1
                k = value()
                i += 2  # ] =
                out[k] = value()
            elif toks[i][0] == "name" and i + 1 < len(toks) and toks[i + 1] == ("p", "="):
                k = toks[i][1]
                i += 2
                out[k] = value()
            else:
                out[idx] = value()
                idx += 1
            if toks[i] in (("p", ","), ("p", ";")):
                i += 1
        i += 1  # }
        return out

    return value()
