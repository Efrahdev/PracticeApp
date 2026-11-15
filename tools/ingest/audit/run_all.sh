#!/usr/bin/env bash
# Independent audit of every pack in ingest-out/ against its original source. Run from the repo root.
# Each check re-reads the source with its own simple parser (not the ingester's code).
set -u
d="$(dirname "$0")"
for s in structural sof_keys grid_keys leaks english check_fractions_html pdftext completeness apos_geom apos_slice; do
  echo "================ $s"; python3 "$d/$s.py" 2>&1 | grep -v -i "warn"
done
echo "================ app validator"; node tools/ingest/validate.mjs ingest-out/*/*.zip 2>&1 | grep -E "^RESULT" | sort | uniq -c
