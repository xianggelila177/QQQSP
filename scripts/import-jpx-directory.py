"""Build the offline ordinary-share search index from matching official JPX files.

Development-only dependency: openpyxl. Production reads the generated JSON.
Download the English and Japanese XLSX links from JPX's List of TSE-listed Issues,
then run: python scripts/import-jpx-directory.py data_e.xlsx data_j.xlsx OUTPUT.json
Never infer fund classifications or quote-provider coverage from a listing.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import openpyxl

SOURCES = [
    "https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html",
    "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html",
]


def load(filename):
    book = openpyxl.load_workbook(filename, read_only=True, data_only=True)
    try:
        return list(book.active.values)[1:]
    finally:
        book.close()


def build(english, japanese):
    local = {str(row[1]).strip(): row for row in load(japanese)}
    rows, dates, seen = [], set(), set()
    for row in load(english):
        date, code, name, section = row[:4]
        if not re.match(r"^(Prime|Standard|Growth) Market", str(section)):
            continue
        code = str(code).strip()
        # JPX's five-character codes here identify preferred/bond-type class
        # shares. They are not the ordinary share and must not be truncated.
        if re.fullmatch(r"\d{5}", code):
            continue
        native = local.get(code)
        if not re.fullmatch(r"\d[0-9A-Z]{3}", code) or code in seen:
            raise ValueError(f"Invalid or repeated JPX code: {code}")
        if not native or native[0] != date or not name or not native[2]:
            raise ValueError(f"English/Japanese identity/date mismatch: {code}")
        seen.add(code)
        dates.add(str(date))
        rows.append({"code": code, "name": str(name).strip(), "nameJa": str(native[2]).strip(), "section": section})
    if len(dates) != 1 or len(rows) < 3000:
        raise ValueError("Incomplete or mixed-date JPX directory")
    date = dates.pop()
    return {
        "schemaVersion": 1,
        "source": "JPX",
        "asOf": f"{date[:4]}-{date[4:6]}-{date[6:8]}",
        "scope": "TSE Prime, Standard and Growth ordinary shares; excludes preferred/bond-type class shares, funds, ETNs and PRO Market",
        "sources": SOURCES,
        "inputSha256": {"english": hashlib.sha256(Path(english).read_bytes()).hexdigest(), "japanese": hashlib.sha256(Path(japanese).read_bytes()).hexdigest()},
        "rows": sorted(rows, key=lambda row: row["code"]),
    }


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: import-jpx-directory.py ENGLISH.xlsx JAPANESE.xlsx OUTPUT.json")
    data = build(sys.argv[1], sys.argv[2])
    # Complete validation precedes the write, preserving the last good snapshot.
    Path(sys.argv[3]).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"JPX {data['asOf']}: {len(data['rows'])} ordinary shares")
