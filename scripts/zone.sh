#!/usr/bin/env bash
# Usage: scripts/zone.sh "Name" <lat> <lon> <radiusM> [--base] [--private] [--visit]
#        scripts/zone.sh "Name" --polygon "POLYGON((lon lat, ...))" [--base] [--private] [--visit]
# Target: $INGEST_URL (default http://localhost:4004)
set -euo pipefail
NAME=$1; shift
BASE=false; PRIVATE=false; VISIT=false; BODY=""
if [ "${1:-}" = "--polygon" ]; then
  BODY=$(node -e 'console.log(JSON.stringify({name:process.argv[1],kind:"polygon",wkt:process.argv[2]}))' "$NAME" "$2"); shift 2
else
  BODY=$(node -e 'console.log(JSON.stringify({name:process.argv[1],kind:"circle",centreLat:+process.argv[2],centreLon:+process.argv[3],radiusM:+process.argv[4]}))' "$NAME" "$1" "$2" "$3"); shift 3
fi
for f in "$@"; do case $f in --base) BASE=true;; --private) PRIVATE=true;; --visit) VISIT=true;; esac; done
BODY=$(node -e 'const b=JSON.parse(process.argv[1]);b.isBase=process.argv[2]==="true";b.isPrivate=process.argv[3]==="true";b.createsVisit=process.argv[4]==="true";console.log(JSON.stringify(b))' "$BODY" $BASE $PRIVATE $VISIT)
curl -sS -X POST "${INGEST_URL:-http://localhost:4004}/ingest/Zones" -H 'Content-Type: application/json' -d "$BODY"
echo
