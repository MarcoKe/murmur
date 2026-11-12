import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../public/js/dsp/fft.js';
import { BAND_FREQS, BANDS, layerDbAt, layerBinPower, layerNorm, stateAt, TARGET_RMS } from '../public/js/dsp/curve.js';
import { NoiseSynth } from '../public/js/dsp/synth.js';
import { moveValue, cycleAt } from '../public/js/dsp/mod.js';
import { readFileSync } from 'node:fs';
import { RoomStats, proposeMask, bandPowers, ANALYSER_WINDOW_POWER } from '../public/js/dsp/mask.js';
import { BUILTINS, defaultLayer, sanitizePreset, tinnitusPreset, PresetError, greyEq, withPattern, patternOf, PATTERNS, stateOf } from '../public/js/preset.js';
import { encodePreset, decodePreset, presetToCode, codeToPreset, presetFromHash, presetToUrl,
	presetFromJson, presetToJson, fromBase64Url } from '../public/js/codec.js';
import { renderLoop, encodeWav } from '../public/js/audio/wav.js';

const SR = 48000;
const one = (o = {}) => sanitizePreset({ name: 't', layers: [{ ...defaultLayer(), level: 0, ...o }] });

/** Averaged power spectrum of a signal (Hann, 50% overlap), per bin. */
function welch(x, n = 8192) {
	const fft = new FFT(n);
	const acc = new Float64Array(n / 2);
	const re = new Float64Array(n), im = new Float64Array(n);
	let frames = 0, wsum = 0;
	for (let i = 0; i < n; i++) wsum += (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)) ** 2;
	for (let s = 0; s + n <= x.length; s += n / 2, frames++) {
		for (let i = 0; i < n; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)); im[i] = 0; }
		fft.transform(re, im);
		for (let k = 0; k < n / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / wsum;
	}
	return acc.map((v) => v / frames);
}

function render(preset, seconds, seed = 7) {
	const s = new NoiseSynth(SR, { seed });
	s.setPreset(preset);
	const frames = Math.ceil((seconds * SR) / s.hop);
	const L = new Float32Array(frames * s.hop), R = new Float32Array(frames * s.hop);
	for (let f = 0; f < frames; f++) s.render(L.subarray(f * s.hop, (f + 1) * s.hop), R.subarray(f * s.hop, (f + 1) * s.hop));
	return { L, R };
}
const rms = (x, from = 4096) => Math.sqrt(x.subarray(from).reduce((a, v) => a + v * v, 0) / (x.length - from));
const bandDb = (spec, n = 8192) => Array.from(bandPowers(spec, SR, n), (p) => 10 * Math.log10(p));

test('fft: inverse of forward is the input', () => {
	const n = 1024, fft = new FFT(n);
	const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + (i % 7)), im = new Float64Array(n);
	const orig = re.slice();
	fft.transform(re, im); fft.inverse(re, im);
	for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] / n - orig[i]) < 1e-9);
});

test('fft: a sine lands in its bin', () => {
	const n = 256, fft = new FFT(n);
	const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n)), im = new Float64Array(n);
	fft.transform(re, im);
	assert.ok(Math.abs(re[5] - n / 2) < 1e-9);
	assert.ok(Math.abs(re[6]) < 1e-9);
});

test('synth: white noise has the target level and a flat spectrum', () => {
	const { L, R } = render(one({ slope: 0 }), 20);
	assert.ok(Math.abs(rms(L) / TARGET_RMS - 1) < 0.03, `rms ${rms(L)}`);
	assert.ok(Math.abs(rms(R) / TARGET_RMS - 1) < 0.03);
	const db = bandDb(welch(L));
	for (let b = 6; b < BANDS - 1; b++) assert.ok(Math.abs(db[b] - db[17]) < 1.2, `band ${b}: ${db[b] - db[17]}`);
});

for (const [name, slope] of [['pink', -3], ['brown', -6], ['blue', 3]]) {
	test(`synth: ${name} falls by ${slope} dB per octave`, () => {
		const { L } = render(one({ slope }), 30);
		const db = bandDb(welch(L));
		// 100 Hz (band 7) to 6.4 kHz (band 25) = 6 octaves
		const perOctave = (db[25] - db[7]) / 6;
		assert.ok(Math.abs(perOctave - slope) < 0.25, `${perOctave}`);
	});
}

test('synth: a notch is as deep and as wide as asked', () => {
	const { L } = render(one({ slope: 0, notches: [{ f: 4000, width: 1, gain: -30 }] }), 30);
	const db = bandDb(welch(L));
	const ref = db[14]; // 500 Hz
	const at = (f) => db[Math.round(3 * Math.log2(f / 20))] - ref;
	assert.ok(at(4000) < -24, `centre ${at(4000)}`);
	assert.ok(Math.abs(at(1000)) < 1.5 && Math.abs(at(16000)) < 1.5);
	// half the depth (in dB) half the width away from the centre
	assert.ok(Math.abs(layerDbAt(one({ slope: 0, notches: [{ f: 4000, width: 1, gain: -30 }] }).layers[0], 4000 * 2 ** 0.5) + 15) < 0.1);
});

test('synth: low and high cut', () => {
	const { L } = render(one({ slope: 0, lowCut: 500, highCut: 4000 }), 20);
	const db = bandDb(welch(L));
	const mid = db[18];
	assert.ok(db[8] - mid < -30 && db[29] - mid < -30);
});

test('synth: width 0 is mono, width 1 uncorrelated', () => {
	const corr = (a, b) => { let s = 0; for (let i = 4096; i < a.length; i++) s += a[i] * b[i]; return s / (a.length - 4096) / (rms(a) * rms(b)); };
	let { L, R } = render(one({ width: 0 }), 5);
	assert.ok(corr(L, R) > 0.999);
	({ L, R } = render(one({ width: 1 }), 10));
	assert.ok(Math.abs(corr(L, R)) < 0.05);
	assert.ok(Math.abs(rms(L) / rms(render(one({ width: 0 }), 10).L) - 1) < 0.05, 'width keeps the level');
});

test('synth: every starting point stays within a safe level', () => {
	for (const { preset } of BUILTINS) {
		const { L } = render(preset, 6);
		const r = rms(L);
		assert.ok(r > 0.005 && r < TARGET_RMS * 2.1, `${preset.name}: ${r}`);
		assert.ok(L.every(Number.isFinite), preset.name);
	}
});

test('loudness: sounds concentrated where the ear is sensitive are turned down, none up', () => {
	const sum = (l) => layerBinPower(l, 4096, SR).power.reduce((a, v) => a + v, 0);
	const white = sum(one({ slope: 0 }).layers[0]);
	assert.ok(Math.abs(white / TARGET_RMS ** 2 - 1) < 0.01);
	assert.ok(sum(tinnitusPreset('band', 3000).layers[0]) < white * 0.9 * 10 ** -1);
	assert.ok(sum(one({ slope: -6 }).layers[0]) <= white * 1.001);
});

test('movement: stays in 0..1, is continuous, and loops are periodic', () => {
	for (const [name, pattern] of Object.entries(PATTERNS)) {
		for (const irregular of [pattern.irregular, 0, 0.3, 0.7, 1]) {
			const move = { ...pattern, irregular, period: 7 };
			let prev = moveValue(move, 0, 3);
			for (let t = 0.02; t < 120; t += 0.02) {
				const u = moveValue(move, t, 3);
				assert.ok(u >= 0 && u <= 1, `${name} ${irregular} t ${t}: ${u}`);
				assert.ok(Math.abs(u - prev) < 0.12, `${name} ${irregular} jumps at ${t}: ${prev} -> ${u}`);
				prev = u;
			}
			for (const t of [0, 1.3, 9.9, 29.99]) {
				assert.ok(Math.abs(moveValue(move, t, 3, 30) - moveValue(move, t + 30, 3, 30)) < 1e-6, `${name} ${irregular} loop`);
			}
		}
	}
	// regular: exactly the drawn cycle, every cycle
	const drawn = { cycle: [0, 100, 100, 0, 0, 0, 50, 50, 50, 50, 0, 0, 0, 0, 0, 0], irregular: 0, period: 4 };
	assert.ok(Math.abs(moveValue(drawn, 0.25, 1) - 1) < 1e-9 && moveValue(drawn, 1.5 + 8, 9) === 0.5);
	assert.equal(cycleAt(drawn.cycle, 3 / 16), 0);
	// irregular: cycles differ; fully irregular ignores the cycle
	const waves = { ...PATTERNS.waves, period: 4 };
	const peaks = Array.from({ length: 30 }, (_, c) => Math.max(...Array.from({ length: 40 }, (_, i) => moveValue(waves, c * 4 + i / 10, 2))));
	assert.ok(Math.max(...peaks) - Math.min(...peaks) > 0.15, 'wave heights vary');
	assert.equal(moveValue({ ...PATTERNS.wind, period: 5 }, 3.3, 4), moveValue({ ...PATTERNS.breathing, irregular: 1, period: 5 }, 3.3, 4));
});

test('two states: everything is interpolated between rest and peak', () => {
	const peak = { ...defaultLayer(), slope: 0, level: 0, highCut: 8000, notches: [{ f: 2000, width: 0.5, gain: 12 }] };
	const layer = sanitizePreset({ layers: [{ ...peak, rest: { ...stateOf(peak), slope: -6, level: -20, highCut: 500, width: 0, notches: [{ f: 500, width: 2, gain: -12 }] },
		move: { period: 4, irregular: 0, cycle: PATTERNS.breathing.cycle } }] }).layers[0];
	assert.equal(stateAt(layer, 1), layer);
	assert.equal(stateAt(layer, 0), layer.rest);
	const mid = stateAt(layer, 0.5);
	assert.equal(mid.slope, -3); assert.equal(mid.level, -10); assert.equal(mid.width, 0.5);
	assert.ok(Math.abs(mid.highCut - 2000) < 1e-6, 'cuts move in octaves');
	assert.ok(Math.abs(mid.notches[0].f - 1000) < 1e-6 && mid.notches[0].gain === 0 && Math.abs(mid.notches[0].width - 1) < 1e-9, 'notches sweep');
	// one loudness normalisation for both states: neither is louder than a steady layer may be
	const { gain } = layerNorm(layer, 4096, SR);
	for (const st of [layer, layer.rest]) {
		const own = layerNorm({ ...st, rest: null, move: null }, 4096, SR).gain;
		assert.ok(gain * 10 ** (st.level / 10) <= own * 1.0001, 'never louder than the layer\'s level allows');
	}
	// the sound really moves: quiet and dull at rest, loud and bright at the peak
	const { L } = render(sanitizePreset({ layers: [layer] }), 16);
	const at = (sec) => L.subarray(Math.round(sec * SR) - 6000, Math.round(sec * SR) + 6000);
	assert.ok(rms(at(2), 0) > 5 * rms(at(4), 0), `peak ${rms(at(2), 0)} rest ${rms(at(4), 0)}`);
	assert.ok(Math.abs(rms(at(2), 0) - rms(at(10), 0)) / rms(at(2), 0) < 0.25, 'regular cycle repeats');
});

test('patterns: start, change and stop a movement', () => {
	const steady = sanitizePreset({ layers: [{ ...defaultLayer(), level: -6 }] }).layers[0];
	const breathing = withPattern(steady, 'breathing');
	assert.equal(patternOf(breathing.move), 'breathing');
	assert.equal(breathing.rest.level, -24);
	const custom = { ...breathing, rest: { ...breathing.rest, slope: -9 } };
	const waves = withPattern(custom, 'waves');
	assert.equal(patternOf(waves.move), 'waves');
	assert.equal(waves.rest.slope, -9, 'changing the pattern keeps the rest state');
	assert.equal(patternOf({ ...waves.move, cycle: waves.move.cycle.map((v) => 100 - v) }), null);
	assert.equal(withPattern(waves, '').move, null);
	assert.deepEqual(sanitizePreset({ layers: [waves] }).layers[0], waves);
});

test('version 1 sounds and links still open, as the same sound', () => {
	const old = JSON.parse(readFileSync(new URL('./v1-links.json', import.meta.url), 'utf8'));
	for (const [name, { code, preset }] of Object.entries(old)) {
		const viaLink = codeToPreset(code), viaFile = presetFromJson(JSON.stringify({ murmur: 'preset', preset }));
		assert.deepEqual(viaLink, viaFile, name);
		assert.equal(viaLink.v, 2);
		assert.equal(viaLink.name, name);
		viaLink.layers.forEach((l, i) => {
			const was = preset.layers[i];
			for (const k of ['slope', 'level', 'width', 'lowCut', 'highCut', 'eq', 'notches']) assert.deepEqual(l[k], was[k], `${name} ${k}`);
			const moved = was.mod.shape && was.mod.depth > 0;
			assert.equal(Boolean(l.move), Boolean(moved), name);
			if (!moved) return;
			assert.equal(l.move.period, was.mod.period);
			assert.equal(patternOf(l.move), ['breathing', 'waves', 'wind'][was.mod.shape - 1]);
			// the quietest moment is as far down as before: depth * 30 dB, over all or part of the spectrum
			const drop = was.mod.depth * 30;
			const f = was.mod.band === 1 ? 60 : 8000;
			const now = layerDbAt(l, f) + l.level - (layerDbAt(l.rest, f) + l.rest.level);
			assert.ok(Math.abs(now - drop) < 0.8, `${name}: ${now} vs ${drop}`);
			if (was.mod.band) {
				const other = was.mod.band === 1 ? 8000 : 60;
				assert.ok(Math.abs(layerDbAt(l, other) - layerDbAt(l.rest, other)) < 0.8, `${name}: the other end stays`);
			}
		});
	}
	// the level of a version 1 sound is unchanged: normalised at its peak
	const surf = codeToPreset(old.Surf.code).layers[1];
	assert.ok(Math.abs(layerNorm(surf, 4096, SR).gain / layerNorm({ ...surf, rest: null, move: null }, 4096, SR).gain - 1) < 1e-6);
});

test('wav: the loop has no seam and a valid header', async () => {
	const preset = BUILTINS.find((b) => b.preset.name === 'Slow waves').preset;
	const loop = await renderLoop(preset, 6, SR, null, 11);
	const { left } = loop;
	let diffs = 0;
	for (let i = 1; i < left.length; i++) diffs += (left[i] - left[i - 1]) ** 2;
	const typical = Math.sqrt(diffs / left.length);
	assert.ok(Math.abs(left[0] - left[left.length - 1]) < 5 * typical, 'seam');
	// level is even across the seam (the first half frame is complete)
	assert.ok(Math.abs(rms(left.subarray(0, 2048), 0) / rms(left.subarray(2048, 8192), 0) - 1) < 0.5);
	const wav = encodeWav(loop);
	assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
	assert.equal(wav.length, 44 + left.length * 4);
	assert.equal(new DataView(wav.buffer).getUint32(24, true), SR);
});

test('codec: every starting point survives the round trip', () => {
	for (const { preset } of [...BUILTINS, { preset: tinnitusPreset('notch', 6200) }, { preset: tinnitusPreset('band', 11000) }]) {
		assert.deepEqual(codeToPreset(presetToCode(preset)), preset, preset.name);
		assert.deepEqual(presetFromJson(presetToJson(preset)), preset);
	}
	const p = one({ eq: greyEq(), slope: -9, level: -40, width: 0.37, rest: defaultLayer(), lowCut: 123, highCut: 19999,
		notches: [{ f: 20, width: 0.04, gain: -48 }, { f: 20000, width: 4, gain: 24 }, { f: 777, width: 1.5, gain: 0 }],
		move: { period: 120, irregular: 0.37, cycle: [0, 100, 3, 97, 50, 50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } });
	p.layers[0].rest = { ...stateOf(p.layers[0]), slope: 9, level: -70, width: 1, lowCut: 20, highCut: 150, eq: p.layers[0].eq.map((v) => 0 - v),
		notches: [{ f: 20000, width: 4, gain: 24 }, { f: 20, width: 0.04, gain: -48 }, { f: 778, width: 1.5, gain: 0 }] };
	assert.deepEqual(sanitizePreset(p), p, 'the extreme sound is on the grid');
	p.name = 'Büro 😴 低音';
	assert.deepEqual(codeToPreset(presetToCode(p)), p);
	const url = presetToUrl(p, 'https://example.org/#old');
	assert.deepEqual(presetFromHash(new URL(url).hash), p);
	assert.equal(presetFromHash('#other'), null);
});

test('codec: a typical link is short', () => {
	assert.ok(presetToCode(BUILTINS[2].preset).length < 40);
	const worst = sanitizePreset({ name: 'x'.repeat(40), layers: Array.from({ length: 4 }, () => ({ ...defaultLayer(), eq: greyEq(),
		notches: Array.from({ length: 12 }, () => ({ f: 1, width: 1, gain: 1 })),
		rest: { slope: 9, level: -70, width: 0, lowCut: 100, highCut: 200, eq: greyEq().map((v) => 0 - v), notches: Array.from({ length: 8 }, () => ({ f: 2, width: 2, gain: 2 })) },
		move: { period: 3, irregular: 0.5, cycle: [] } })) });
	assert.equal(worst.layers[0].notches.length, 8);
	assert.equal(worst.layers[3].rest.notches[7].f, 20);
	assert.deepEqual(codeToPreset(presetToCode(worst)), worst);
	assert.ok(presetToCode(worst).length < 1000, String(presetToCode(worst).length));
});

test('codec: garbage is rejected or clamped, never anything else', () => {
	assert.throws(() => codeToPreset(''), PresetError);
	assert.throws(() => codeToPreset('!!!'), PresetError);
	assert.throws(() => presetFromJson('{'), PresetError);
	assert.throws(() => presetFromJson('[1]'), PresetError);
	assert.throws(() => decodePreset(Uint8Array.of(9, 1)), (e) => e.code === 'version');
	assert.throws(() => sanitizePreset({ v: 3, layers: [] }), (e) => e.code === 'version');
	let seed = 1;
	const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
	const good = encodePreset(BUILTINS[7].preset);
	let decoded = 0;
	for (let i = 0; i < 4000; i++) {
		const bytes = i % 2 ? good.slice(0, 1 + Math.floor(rnd() * good.length)) : Uint8Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
		if (i % 2) for (let k = 0; k < 3; k++) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
		if (i % 4 === 0) bytes[0] = 1 + (i % 8 === 0);
		try {
			const p = decodePreset(bytes);
			decoded++;
			assert.deepEqual(sanitizePreset(p), p);
			assert.deepEqual(codeToPreset(presetToCode(p)), p);
			for (const l of p.layers) assert.ok(layerBinPower(l, 1024, SR).power.every(Number.isFinite));
		} catch (e) {
			assert.ok(e instanceof PresetError, String(e?.stack));
		}
	}
	assert.ok(decoded > 20, `only ${decoded} decoded`);
	assert.throws(() => fromBase64Url('a'.repeat(3000)), PresetError);
});

test('preset: hostile objects are clamped', () => {
	const p = sanitizePreset({ name: '<img src=x onerror=alert(1)>\n' + 'y'.repeat(100), layers: [
		{ slope: 1e9, level: 'NaN', width: -4, lowCut: 30000, highCut: 1, eq: 'no', notches: [null, { f: -1, width: 99, gain: 99 }, 1, 2, 3, 4],
			rest: { level: -1e9, notches: [] }, move: { period: 0, irregular: 7, cycle: [-5, 500, 'x'] } },
		null, 5, {}, {}, {}, {},
	] });
	assert.equal(p.layers.length, 4);
	assert.equal(Array.from(p.name).length, 40);
	assert.ok(!p.name.includes('\n'));
	const l = p.layers[0];
	assert.equal(l.slope, 9); assert.equal(l.level, -6); assert.equal(l.width, 0);
	assert.ok(l.lowCut < l.highCut && l.highCut <= 20000);
	assert.equal(l.eq.length, BANDS);
	assert.deepEqual(l.notches, [{ f: 20, width: 4, gain: 24 }]);
	assert.deepEqual(l.move, { period: 0.5, irregular: 1, cycle: [0, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50] });
	assert.equal(l.rest.level, -70);
	assert.deepEqual(l.rest.notches, l.notches, 'the rest state gets the peak\'s notches when it has none');
	assert.equal(sanitizePreset({ layers: [{ rest: {} }] }).layers[0].rest, null, 'no movement without both rest and move');
});

// ---- room matching ----

/** What the browser's analyser would report (dB per bin) for a signal. */
function analyserFrames(x, n = 16384, step = 2400) {
	const fft = new FFT(n);
	const out = [];
	const re = new Float64Array(n), im = new Float64Array(n);
	for (let s = 0; s + n <= x.length; s += step) {
		for (let i = 0; i < n; i++) {
			const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
			re[i] = x[s + i] * w; im[i] = 0;
		}
		fft.transform(re, im);
		out.push(Float32Array.from({ length: n / 2 }, (_, k) => 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (n * n) + 1e-30)));
	}
	return out;
}

test('room: the measurement is in the same unit as the graph', () => {
	const { L } = render(one({ slope: 0 }), 12);
	const stats = new RoomStats(SR, 16384);
	for (const f of analyserFrames(L)) stats.add(f);
	const m = stats.result();
	// white noise at TARGET_RMS: density = 20 log10(TARGET_RMS) relative to full-scale white
	const want = 20 * Math.log10(TARGET_RMS) + 10 * Math.log10(24000 / 19980);
	for (let b = 6; b < BANDS - 1; b++) assert.ok(Math.abs(m.bandMean[b] - want) < 1.5, `band ${b}: ${m.bandMean[b]} vs ${want}`);
	assert.equal(m.tones.length, 0);
	assert.ok(ANALYSER_WINDOW_POWER > 0.3 && ANALYSER_WINDOW_POWER < 0.31);
});

test('room: hum, rumble and voices-like bursts give a matching mask', () => {
	// a room: brown rumble, a 100 Hz hum, and bursts between 300 Hz and 3 kHz
	const { L: rumble } = render(one({ slope: -6, level: -10 }), 24, 3);
	const { L: speech } = render(one({ slope: -2, level: -14, lowCut: 300, highCut: 3000 }), 24, 5);
	const x = new Float32Array(rumble.length);
	for (let i = 0; i < x.length; i++) {
		const t = i / SR;
		const talking = Math.floor(t / 1.5) % 4 === 0 ? 1 : 0.03;
		x[i] = rumble[i] + 0.05 * Math.sin(2 * Math.PI * 100 * t) + speech[i] * talking;
	}
	const stats = new RoomStats(SR, 16384);
	for (const f of analyserFrames(x)) stats.add(f);
	const m = stats.result();
	assert.ok(m.tones.some((t) => Math.abs(t.f - 100) < 4), JSON.stringify(m.tones));
	const layer = proposeMask(m);
	assert.deepEqual(sanitizePreset({ layers: [layer] }).layers[0], layer, 'the proposal is a valid layer');
	assert.ok(layer.slope <= -3, `slope ${layer.slope}`);
	assert.ok(layer.notches.some((n) => Math.abs(n.f - 100) < 4 && n.gain > 0));
	// more cover where the bursts are than the plain slope would give
	const at = (f) => layer.eq[Math.round(3 * Math.log2(f / 20))];
	assert.ok(at(1000) > at(160) + 3 && at(1000) > at(8000) + 3, `${layer.eq}`);
	// strength 0: just the colour
	const plain = proposeMask(m, { strength: 0, voices: false });
	assert.ok(plain.eq.every((v) => v === 0));
	// the mask's own spectrum follows the room where it matters
	const maskDb = BAND_FREQS.map((f) => layerDbAt(layer, f));
	const d = (lo, hi, arr) => arr[Math.round(3 * Math.log2(hi / 20))] - arr[Math.round(3 * Math.log2(lo / 20))];
	assert.ok(Math.abs(d(63, 250, maskDb) - d(63, 250, m.bandMean)) < 8);
});
