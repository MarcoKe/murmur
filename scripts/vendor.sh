#!/bin/sh
# Fetch the vendored library into public/vendor (npm tarball; no Node needed).
# qrcode-generator (Kazuhiko Arase): MIT. The package ships no license file, only the notice in
# the source header, so the MIT text is written next to it here.
set -eu
cd "$(dirname "$0")/../public/vendor"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

version=2.0.4
curl -fsSL "https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-$version.tgz" | tar -xz -C "$tmp"
mkdir -p qrcode
cp "$tmp/package/dist/qrcode.mjs" qrcode/qrcode.mjs
cat > qrcode/LICENSE <<EOF
qrcode-generator $version
https://github.com/kazuhikoarase/qrcode-generator

The MIT License (MIT)

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
EOF
