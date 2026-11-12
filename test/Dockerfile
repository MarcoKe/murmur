# Browser test runner: the Playwright image (Chromium, Firefox, WebKit) plus its Python package.
# PulseAudio gives the container a dummy sound device: without one Firefox never starts an
# AudioContext (Chromium and WebKit do not need it).
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends pulseaudio && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --break-system-packages playwright==1.63.0
