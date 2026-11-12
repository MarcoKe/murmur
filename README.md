# murmur

(Working title.) A noise generator in the browser: white, pink, brown and anything between, as a
spectrum curve you can see and drag; a microphone mode that measures the room and builds a noise
that sits exactly on it; presets shared as links. Static files only, no build step, no server
side. Public at https://murmur.kemmerling.me (GitHub Pages); the same `public/` folder is also
served as it is on a home server (`http://noise.home`, plain http).

Noise from a speaker covers a sound (masking), it does not cancel it. The app says so, and aims
for the quietest mask that works.

## What it does
- **Sounds**: starting points for focus, sleep and playing around; your own sounds are kept in
  the browser (localStorage).
- **Shape**: up to 4 layers. Each has a colour (slope, −9 … +9 dB per octave), a free curve
  (drag on the graph; 31 third-octave bands), level, stereo width, and with "Advanced" on:
  low/high cut and up to 8 notches or peaks (on the graph: drag the circle, drag the grips beside
  it or scroll over it for the width).
- **Movement**: a moving layer has two complete states, *peak* and *rest*, and travels between
  them. Both are shaped with the same controls ("Now shaping"), so anything can move: level
  (swell), colour or cuts (opening up), a notch's frequency (sweep), stereo width. *When* it
  moves is one cycle drawn by hand (16 points), its length, and an irregularity from "repeats
  exactly" to "drifts freely". Breathing, Waves and Wind are starting patterns for the cycle.
- **Room**: listens for 10–30 s, draws the room on the graph and proposes a mask layer: the
  room's colour, more cover where sounds come and go, narrow peaks on steady tones (hum), extra
  cover for voices. "Follow the room" keeps listening and moves the mask level with the room
  (±8 dB, slow); headphones only, checked by muting the mask for a moment.
- **Tinnitus**: tone finder with octave check, then noise with a gap at the tone or a narrow
  band on it. Comfort only, no medical claims.
- **Timer**: sleep timer with a long fade-out and a dark screen; focus timer where the sound
  steps back during the break.
- **Share**: the whole sound in the link (`#p=…`, never sent to a server), QR code, a JSON file,
  and a WAV that loops without a seam.

## How the sound is made
`js/dsp/synth.js`: each frame (4096 samples) is built in the frequency domain, the wanted power
per bin with a random phase, turned into samples by one inverse FFT and cross-faded with the
previous frame (sine window, 50 % overlap). Any curve is exact, nothing ever loops, and one
complex FFT yields two independent signals, used as mid and side for the stereo width.

Movement: `dsp/mod.js` gives a layer's position between rest (0) and peak (1) as a pure function
of time (periodic for the WAV loop); `stateAt()` in `dsp/curve.js` interpolates every setting
(levels and gains in dB, frequencies and widths in octaves). The synth quantises the position
to 64 steps and keeps the spectrum of each step it has met.

Loudness (`dsp/curve.js`): every layer is normalised to −16 dBFS RMS at level 0, or less when it
would sound louder than white noise of that level (A-weighted), with one gain for both states
of a moving layer; a limiter catches peaks when
layers add up. The volume is a setting of the device, not part of a sound: a link cannot be loud.

The graph's unit is power density in dB (white is flat, pink falls 3 dB per octave), shifted so
the selected layer's shape does not move while it is edited. The live area is measured from the
actual output per channel; the browser tests check it against the drawn curve.

## Layout
```
public/
  index.html, app.css           page and styling (static text lives in the HTML)
  js/app.js                     current sound, transport, tabs
  js/preset.js                  the sound's format, clamping (sanitizePreset), starting points
  js/codec.js                   sound <-> bytes <-> link, JSON file
  js/config.js                  PUBLIC_URL (for share links), SECURE_URL (https copy, for the mic)
  impressum.html, privacy.html  legal pages; name and address from js/contact.js
  js/strings.js                 all text set by scripts: t(key, vars)
  js/dsp/                       fft, curve, mod, synth, mask (room -> layer): no browser needed
  js/audio/engine.js            audio graph around the worklet: fades, limiter, analysers, tone
  js/audio/synth.worklet.js     audio thread
  js/audio/room.js              microphone: sampling, following
  js/audio/wav.js               seamless loop + WAV writer
  js/ui/                        graph and one module per tab
  vendor/qrcode/                qrcode-generator (MIT), fetched by scripts/vendor.sh
  sw.js, manifest.webmanifest   installable, works offline (network first)
scripts/test.sh                 unit tests (node --test in the node:22 container)
test/browsers.sh                the real page in Chromium, Firefox and WebKit
scripts/icons.sh                PNG icons from public/logo.svg
```

## Sound format (v2)
`{ v: 2, name, layers: [{ slope, level, width, lowCut, highCut, eq[31], notches[≤8]{f, width,
gain}, rest: null | {the same state fields}, move: null | { period, irregular, cycle[16] } }] }`.
The layer's own fields are its peak; `rest` and `move` exist together or not at all, and the
two states pair their notches one to one. Limits and step sizes are `LIMITS` in `preset.js`.
Everything that is loaded, shared or sent to the synth passes `sanitizePreset()`, which clamps
and snaps to the grid the link stores, so a link round trip is exact and a hostile link can only
sound odd. The link is the binary form in `codec.js`, base64url: about 25 characters for a
simple sound, about 60 with a movement (only the rest fields that differ are stored), under
1000 at the very worst. A newer version number gives a "reload to update" message.

Version 1 (until 2026-11-12: four fixed movements that changed only the level, `mod`) is still
read, as links and as files: `upgradeLayer()` turns the movement into a rest state with a lower
level (or lower lows/highs) and the matching pattern. `test/v1-links.json` holds version 1
links and what they meant; the unit tests open them. When the format changes again, bump
`VERSION` and keep decoding the old ones the same way.

## Microphone
- Needs a secure context: https or localhost. On `http://noise.home` the Room tab explains this
  and links to `SECURE_URL` (playing works there, see Browsers).
- Opened with echo cancellation, noise suppression and auto gain off; analysed as loudness per
  frequency (the browser's AnalyserNode); never recorded, stored or sent. The indicator on the
  graph shows while it is open, with a stop button.
- Not calibrated: only the shape of the room's noise is used; the level is set by ear. Phone
  microphones filter the lows, so below 50 Hz and above 12.5 kHz the measurement is ignored.

## Tests
- `scripts/test.sh`: spectra of the synth (slopes, notch, cuts, level, stereo), movement and the
  two states, loop seam, link round trips, version 1 links, 4000 damaged links, room matching on a synthetic room.
- `test/browsers.sh [chromium firefox webkit] [-v]`: plays every starting point and compares the
  output with the curve (within 3.5 dB per band, typically under 1), edits by mouse and
  keyboard, share link in a fresh profile (identical sound, name shown as text), file and WAV
  export, tinnitus and timers. Chromium also gets a fake microphone (`test/make-room-wav.mjs`: brown
  rumble with a 100 Hz hum that gets 10 dB louder) for room matching and following.
  Screenshots land in `test/out/`.

## Not verified yet (needs real devices)
- **iPhone with the screen locked**: Safari may pause live web audio. `navigator.audioSession`
  is set to "playback", which should keep it going; if it does not, the fallback is to play the
  rendered loop through an audio element.
- **iPhone while the microphone is open** ("Follow the room"): iOS may switch the audio route or
  quality when recording starts.
- How well real phone and laptop microphones capture the room; the feedback check with real
  speakers.

## Public site
https://murmur.kemmerling.me is GitHub Pages: `.github/workflows/pages.yml` runs the unit tests
and publishes `public/` on every push to `main` (repository settings: Pages, source "GitHub
Actions", custom domain `murmur.kemmerling.me`, enforce HTTPS; DNS: CNAME `murmur` to
`marcoke.github.io`). Share links always point there (`PUBLIC_URL`), also when made on another
copy. GitHub Pages cannot set response headers, so the Content-Security-Policy is a `<meta>` tag
in each page (`default-src 'self'`: nothing is fetched from or sent to anywhere else; no inline
scripts). No server side is needed for anything.

## Browsers
Current Chrome/Edge, Firefox and Safari. On https and localhost the synth runs in an AudioWorklet
(audio thread). Browsers offer no AudioWorklet on plain http addresses such as `http://noise.home`;
there the same synth runs on the main thread through a ScriptProcessorNode (`mainThreadSynth` in
`engine.js`): same sound, but it can stutter while the page is busy, and background tabs may be
throttled. Use the https address for long listening.
