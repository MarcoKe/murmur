// A layer's spectrum: from the preset fields to decibels at a frequency and to power per FFT bin.
// "dB" here is always power density (per Hz), so white noise is a flat line and pink falls by 3 dB
// per octave.

export const BANDS = 31; // third octaves, 20 Hz ... 20.5 kHz
export const F_MIN = 20;
export const F_MAX = 20000;
export const bandFreq = (i) => 20 * 2 ** (i / 3);
export const BAND_FREQS = Array.from({ length: BANDS }, (_, i) => bandFreq(i));
export const bandIndex = (f) => 3 * Math.log2(f / 20);

/** RMS of one layer at level 0 dB, per channel (-16 dBFS). */
export const TARGET_RMS = 0.16;

export function eqAt(eq, f) {
	const x = Math.min(BANDS - 1, Math.max(0, bandIndex(f)));
	const i = Math.min(BANDS - 2, Math.floor(x));
	return eq[i] + (eq[i + 1] - eq[i]) * (x - i);
}

/** The layer's shape in dB at f, before level and loudness normalisation (flat layer: 0). */
export function layerDbAt(layer, f) {
	let db = layer.slope * Math.log2(f / 1000) + eqAt(layer.eq, f);
	if (layer.lowCut > F_MIN) db -= 10 * Math.log10(1 + (layer.lowCut / f) ** 8);
	if (layer.highCut < F_MAX) db -= 10 * Math.log10(1 + (f / layer.highCut) ** 8);
	for (const n of layer.notches) {
		const x = Math.log2(f / n.f) / (n.width / 2.3548);
		db += n.gain * Math.exp(-0.5 * x * x);
	}
	return db;
}

/** A-weighting in dB (IEC 61672). */
export function aWeightDb(f) {
	const f2 = f * f;
	const ra = (12194 ** 2 * f2 * f2) /
		((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
	return 20 * Math.log10(ra) + 2.0;
}

const aCache = new Map();
function aWeights(n, sampleRate) {
	const key = n + ':' + sampleRate;
	let c = aCache.get(key);
	if (!c) {
		const w = new Float32Array(n / 2);
		let flat = 0, weighted = 0;
		for (let k = 1; k < n / 2; k++) {
			const f = (k * sampleRate) / n;
			if (f < F_MIN || f > F_MAX) continue;
			w[k] = 10 ** (aWeightDb(f) / 10);
			flat++; weighted += w[k];
		}
		c = { w, whiteRatio: weighted / flat };
		aCache.set(key, c);
	}
	return c;
}

/** The shape of a state without its level, as power per bin (zero outside 20 Hz - 20 kHz). */
function rawPower(state, n, sampleRate, out) {
	const half = n / 2;
	out.fill(0);
	for (let k = 1; k < half; k++) {
		const f = (k * sampleRate) / n;
		if (f >= F_MIN && f <= F_MAX) out[k] = 10 ** (layerDbAt(state, f) / 10);
	}
	return out;
}

const lerp = (a, b, u) => a + (b - a) * u;
const glide = (a, b, u) => a * (b / a) ** u; // frequencies and widths move in octaves

/**
 * A moving layer has two states: the layer itself (its "peak") and layer.rest. This is the state
 * a fraction u of the way from rest (0) to peak (1): every setting is interpolated, so a
 * differing level makes it swell, a differing colour or cut makes it open up, a notch at two
 * frequencies makes it sweep.
 */
export function stateAt(layer, u) {
	const r = layer.rest;
	if (!r || u >= 1) return layer;
	if (u <= 0) return r;
	return {
		slope: lerp(r.slope, layer.slope, u),
		level: lerp(r.level, layer.level, u),
		width: lerp(r.width, layer.width, u),
		lowCut: glide(r.lowCut, layer.lowCut, u),
		highCut: glide(r.highCut, layer.highCut, u),
		eq: layer.eq.map((v, i) => lerp(r.eq[i], v, u)),
		notches: layer.notches.map((n, i) => ({
			f: glide(r.notches[i].f, n.f, u),
			width: glide(r.notches[i].width, n.width, u),
			gain: lerp(r.notches[i].gain, n.gain, u),
		})),
	};
}

/**
 * Loudness normalisation of a layer: one gain for all its states, such that no state exceeds
 * TARGET_RMS (times the layer's level), or less when it would sound louder than white noise of that RMS
 * (A-weighted). Shapes with their energy where the ear is most sensitive are turned down;
 * nothing is ever turned up beyond the plain RMS target.
 * Returns { gain, normDb }: gain multiplies rawPower * 10^(level/10); normDb is the same in the
 * graph's unit (density relative to white noise of full-scale variance).
 */
export function layerNorm(layer, n, sampleRate) {
	const half = n / 2;
	const { w, whiteRatio } = aWeights(n, sampleRate);
	const scratch = new Float32Array(half);
	const target = TARGET_RMS * TARGET_RMS;
	const states = layer.rest ? [layer, layer.rest] : [layer];
	// the layer's level is that of its louder state; the other one may use what that leaves
	const top = Math.max(...states.map((s) => s.level));
	let gain = Infinity;
	for (const state of states) {
		const raw = rawPower(state, n, sampleRate, scratch);
		let sum = 0, sumA = 0;
		for (let k = 1; k < half; k++) { sum += raw[k]; sumA += raw[k] * w[k]; }
		if (sum > 0) gain = Math.min(gain, Math.min(target / sum, (target * whiteRatio) / sumA) * 10 ** ((top - state.level) / 10));
	}
	if (!Number.isFinite(gain)) gain = 0;
	return { gain, normDb: gain > 0 ? 10 * Math.log10(gain * half) : 0 };
}

/** Variance per FFT bin (the bin and its mirror together) of one state of a layer. */
export function stateBinPower(state, gain, n, sampleRate, out = new Float32Array(n / 2)) {
	rawPower(state, n, sampleRate, out);
	const g = gain * 10 ** (state.level / 10);
	for (let k = 1; k < n / 2; k++) out[k] *= g;
	return out;
}

/** Power per bin of the layer at its peak, and the normalisation that was applied. */
export function layerBinPower(layer, n, sampleRate) {
	const { gain, normDb } = layerNorm(layer, n, sampleRate);
	return { power: stateBinPower(layer, gain, n, sampleRate), normDb };
}

/**
 * What the graph shows for a state at f: density in dB relative to white noise of full-scale
 * variance. normDb comes from layerNorm.
 */
export const layerDisplayDb = (state, normDb, f) => layerDbAt(state, f) + state.level + normDb;
