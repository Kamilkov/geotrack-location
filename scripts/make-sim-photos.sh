#!/bin/bash
# Makes five synthetic photos for the iOS Simulator: plain coloured images with the metadata of an iPhone photo,
# near 42.50/1.50. Nothing real. Needs exiftool (brew install exiftool).
# Run: scripts/make-sim-photos.sh <folder>   then: xcrun simctl addmedia booted <folder>/sim-*
set -euo pipefail
out="${1:?usage: make-sim-photos.sh <folder>}"
mkdir -p "$out"
cd "$out"

python3 - <<'EOF'
import struct, zlib
def png(path, rgb, w=1600, h=1200):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
png('blue.png', (40, 120, 200))
png('orange.png', (200, 120, 40))
EOF
for name in gps nogps nooffset; do sips -s format jpeg blue.png --out "sim-$name.jpg" >/dev/null; done
sips -s format jpeg orange.png --out sim-portrait.jpg >/dev/null
sips -s format heic blue.png --out sim-heic.heic >/dev/null
rm blue.png orange.png

tag() { exiftool -q -overwrite_original -Make=Apple "-Model=iPhone 17 Pro" "$@"; }
gps() { echo "-GPSLatitude=$1" -GPSLatitudeRef=N "-GPSLongitude=$2" -GPSLongitudeRef=E; }
# Outside the stand-in server's private zone, with every value the app reads.
tag "-DateTimeOriginal=2026:09:22 17:50:12" -SubSecTimeOriginal=345 -OffsetTimeOriginal=+02:00 $(gps 42.51 1.52) \
  -GPSAltitude=1012.4 -GPSAltitudeRef=0 -GPSHPositioningError=4.7 -GPSImgDirection=271.6 -GPSImgDirectionRef=T sim-gps.jpg
# No GPS: the app asks before sending it.
tag "-DateTimeOriginal=2026:09:22 17:51:12" -SubSecTimeOriginal=120 -OffsetTimeOriginal=+02:00 sim-nogps.jpg
# No UTC offset: the app skips it.
tag "-DateTimeOriginal=2026:09:22 17:52:12" $(gps 42.51 1.52) sim-nooffset.jpg
# Stored on its side (orientation 6), inside the private zone: the server drops it.
tag "-DateTimeOriginal=2026:09:22 17:53:12" -SubSecTimeOriginal=007 -OffsetTimeOriginal=+02:00 "-Orientation#=6" $(gps 42.4999 1.5) sim-portrait.jpg
tag "-DateTimeOriginal=2026:09:22 17:54:12" -SubSecTimeOriginal=500 -OffsetTimeOriginal=+02:00 $(gps 42.52 1.53) sim-heic.heic
ls sim-*
