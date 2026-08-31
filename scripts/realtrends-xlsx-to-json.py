#!/usr/bin/env python3
"""Spec 124 data pass: convert the purchased RealTrends workbook to JSON for
the TypeScript importer (scripts/ingest-realtrends.ts). Pure conversion —
no normalization, no filtering; every row travels with its sheet name, row
number, and raw header-keyed values. The output MUST be written inside a
gitignored directory (.local-data/): it is licensed data.

Usage: python3 scripts/realtrends-xlsx-to-json.py <workbook.xlsx> <out.json>
"""
import json
import sys

import openpyxl


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows_iter = ws.iter_rows(values_only=True)
        header = [str(h) if h is not None else "" for h in next(rows_iter)]
        rows = []
        for idx, row in enumerate(rows_iter, start=2):
            if all(v is None for v in row):
                continue
            rows.append({"row": idx, "values": list(row)})
        sheets.append({"sheet": ws.title, "header": header, "rows": rows})
    with open(out, "w") as f:
        json.dump({"sheets": sheets}, f)
    print(f"Wrote {sum(len(s['rows']) for s in sheets)} rows from "
          f"{len(sheets)} sheets to {out}")


if __name__ == "__main__":
    main()
