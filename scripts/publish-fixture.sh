#!/usr/bin/env bash
# Usage: scripts/publish-fixture.sh [device]   (needs mosquitto_pub; MQTT_* from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
DEV=${1:-fixture}
eval "$(node --env-file=.env -e 'for (const k of ["MQTT_HOST","MQTT_PORT","MQTT_USER","MQTT_PASS"]) console.log(`${k}=${JSON.stringify(process.env[k]??"")}`)')"
node -e "const f=require('./test/fixtures/location.json'); f.tst=Math.floor(Date.now()/1000); console.log(JSON.stringify(f))" \
 | mosquitto_pub -h "$MQTT_HOST" -p "${MQTT_PORT:-1883}" -u "$MQTT_USER" -P "$MQTT_PASS" -q 1 -t "owntracks/kamil/$DEV" -l
echo "published to owntracks/kamil/$DEV"
