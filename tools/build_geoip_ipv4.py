#!/usr/bin/env python3
"""Build the compact vendored IPv4 -> country table used by the topology collector.

Source data is the public-domain (CC0) ``geo-whois-asn-country`` IPv4 dataset from
``@ip-location-db``. We bake it into a small binary partition of the IPv4 space so
``network-topology-data.py`` can resolve a country offline, with no third-party
calls and no peer IPs ever leaving the machine.

Run this only to refresh the vendored DB:

    python3 tools/build_geoip_ipv4.py            # download fresh source, rebuild
    python3 tools/build_geoip_ipv4.py local.csv  # rebuild from a local CSV

Output: tools/geoip-ipv4-country.bin.gz

Binary format (little-endian), see geoip_ipv4_lookup() in network-topology-data.py:
    magic       b"QGIP1\\n"           (6 bytes)
    numCodes    uint16                (distinct country codes, index 0 == unknown)
    codes       numCodes * 2 ASCII    (alpha-2; index 0 is "\\0\\0")
    numEntries  uint32
    starts      numEntries * uint32   (ascending; starts[0] == 0; full 0..2^32 cover)
    cidx        numEntries * uint8    (index into codes for the range [start, nextStart))
"""
from __future__ import annotations

import gzip
import struct
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = (
    "https://cdn.jsdelivr.net/npm/@ip-location-db/"
    "geo-whois-asn-country/geo-whois-asn-country-ipv4-num.csv"
)
OUT_PATH = Path(__file__).resolve().parent / "geoip-ipv4-country.bin.gz"
MAGIC = b"QGIP1\n"
IPV4_MAX = (1 << 32) - 1


def read_rows(source: str | None) -> list[tuple[int, int, str]]:
    if source:
        text = Path(source).read_text(encoding="utf-8")
    else:
        print(f"Downloading {SOURCE_URL}", file=sys.stderr)
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
            text = response.read().decode("utf-8")

    rows: list[tuple[int, int, str]] = []
    for line in text.splitlines():
        if not line:
            continue
        start_str, end_str, country = line.split(",", 2)
        country = country.strip().upper()
        if len(country) != 2 or not country.isalpha():
            continue
        rows.append((int(start_str), int(end_str), country))

    rows.sort(key=lambda row: row[0])
    return rows


def build_partition(rows: list[tuple[int, int, str]]) -> list[tuple[int, str]]:
    """Partition the whole IPv4 space into (start, country) entries; "" == unknown."""
    entries: list[tuple[int, str]] = []
    cursor = 0
    for start, end, country in rows:
        if start > cursor:
            entries.append((cursor, ""))  # unassigned gap
        if start < cursor:
            continue  # overlap with an earlier range; keep the first claim
        entries.append((start, country))
        cursor = end + 1
    if cursor <= IPV4_MAX:
        entries.append((cursor, ""))

    # Collapse runs of the same country (gap sentinels included).
    merged: list[tuple[int, str]] = []
    for start, country in entries:
        if merged and merged[-1][1] == country:
            continue
        merged.append((start, country))
    if not merged or merged[0][0] != 0:
        merged.insert(0, (0, ""))
    return merged


def encode(entries: list[tuple[int, str]]) -> bytes:
    codes = [""]  # index 0 == unknown
    code_index = {"": 0}
    for _, country in entries:
        if country not in code_index:
            code_index[country] = len(codes)
            codes.append(country)

    out = bytearray()
    out += MAGIC
    out += struct.pack("<H", len(codes))
    for code in codes:
        out += (code.encode("ascii") if code else b"\x00\x00").ljust(2, b"\x00")[:2]
    out += struct.pack("<I", len(entries))
    out += struct.pack(f"<{len(entries)}I", *(start for start, _ in entries))
    out += bytes(code_index[country] for _, country in entries)
    return bytes(out)


def main() -> None:
    source = sys.argv[1] if len(sys.argv) > 1 else None
    rows = read_rows(source)
    entries = build_partition(rows)
    blob = encode(entries)
    OUT_PATH.write_bytes(gzip.compress(blob, 9))
    print(
        f"Wrote {OUT_PATH} "
        f"({len(entries)} entries, {OUT_PATH.stat().st_size / 1024:.0f} KiB gzipped)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
