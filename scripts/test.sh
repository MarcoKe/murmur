#!/bin/sh
# Unit tests of the pure modules (no browser): ./scripts/test.sh [node --test arguments]
# Node comes from the node:22 container, as nothing else on colossus needs it.
set -eu
cd "$(dirname "$0")/.."
exec docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w:ro -w /w node:22 \
	node --test --test-reporter=spec "$@" "test/*.test.mjs"
