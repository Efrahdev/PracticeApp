#!/bin/sh
# Runs the corridor on all seven papers, then the golden oracle against the packs made by the first converters.
# Exit 1 if any run FAILs or any oracle difference is unexplained.   Usage: sh ingest/tests/run_all_papers.sh
cd "$(dirname "$0")/../.." || exit 30
status=0
for pair in docx-numbered:class5-calendar-sums docx-numbered:class5-critical-thinking-calendar-sums \
            docx-numbered:equally-spaced-objects-word-problems docx-numbered:advanced-critical-thinking-math-worksheet \
            geometry-html:geometry-olympiad-achiever-100 unitary-html:unitary-method-olympiad-course grammar-json:grammar-midterm-mastery-assessment; do
  profile=${pair%%:*}; job=${pair#*:}
  out=$(ingest/ingest run "ingest/profiles/$profile.yaml" "ingest/jobs/$job.yaml" --json 2>/dev/null); code=$?
  dir=$(printf '%s' "$out" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['run_dir'])" 2>/dev/null)
  printf '%-45s run exit %s  ' "$job" "$code"
  [ "$code" -ge 20 ] && status=1
  if [ -n "$dir" ]; then ingest/ingest oracle "$dir" "ingest/packs/$job.json" | head -1 || status=1; else echo "(no run folder)"; status=1; fi
done
exit $status
