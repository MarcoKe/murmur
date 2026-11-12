#!/bin/sh
# Regenerates public/apple-touch-icon.png and public/icon-512.png from public/logo.svg.
set -eu
cd "$(dirname "$0")/.."
docker build -q -t murmur-test test >/dev/null
docker run --rm --init --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD/public:/app:ro" -v "$PWD/public:/out" -v "$PWD/scripts:/scripts:ro" murmur-test python3 /scripts/icons.py
