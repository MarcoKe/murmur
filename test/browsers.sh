#!/bin/sh
# Cross-browser test of the real page: ./test/browsers.sh [chromium firefox webkit]
# Runs in a container built from test/Dockerfile (Playwright); screenshots go to test/out/.
set -eu
cd "$(dirname "$0")/.."
mkdir -p test/out
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w -w /w node:22 node test/make-room-wav.mjs
docker build -q -t murmur-test test >/dev/null
exec docker run --rm --init --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD/public:/app:ro" -v "$PWD/test:/test" -w /test \
	murmur-test sh -c 'export XDG_RUNTIME_DIR=/tmp/run; mkdir -p -m 700 $XDG_RUNTIME_DIR; pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1; exec python3 browsers.py "$@"' sh "$@"
