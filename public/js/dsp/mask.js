// Room matching: from what the microphone heard to a layer that covers it.
// RoomStats collects spectra; proposeMask() turns the result into a normal, editable layer.
// The microphone is not calibrated, so only the shape of the room's noise is used, never its
// absolute level.

import { BANDS, BAND_FREQS, bandIndex } from './curve.js';
import { defaultLayer } from '../preset.js';

/** Bands the measurement is trusted in (small microphones are unreliable outside). */
export const VALID_LO = 50, VALID_HI = 12500;
/** Sum of squares of the Blackman window the browser's analyser applies, per sample. */
export const ANALYSER_WINDOW_POWER = 0.3046;

/** Mean power density per third-octave band from per-bin power. */
export function bandPowers(binPower, sampleRate, fftSize, out = new Float64Array(BANDS)) {
	const hz = sampleRate / fftSize;
	const last = binPower.length - 1;
	for (let b = 0; b < BANDS; b++) {
		const lo = BAND_FREQS[b] * 2 ** (-1 / 6), hi = BAND_FREQS[b] * 2 ** (1 / 6);
		let k0 = Math.ceil(lo / hz), k1 = Math.floor(hi / hz);
		if (k1 < k0) k0 = k1 = Math.round(BAND_FREQS[b] / hz);
		k0 = Math.min(last, Math.max(1, k0)); k1 = Math.min(last, Math.max(k0, k1));
		let sum = 0;
		for (let k = k0; k <= k1; k++) sum += binPower[k];
		out[b] = sum / (k1 - k0 + 1);
	}
	return out;
}

const toDb = (p) => 10 * Math.log10(Math.max(p, 1e-20));

export class RoomStats {
	constructor(sampleRate, fftSize) {
		this.sampleRate = sampleRate;
		this.fftSize = fftSize;
		this.binSum = new Float64Array(fftSize / 2);
		this.frames = [];
		this.scratch = new Float64Array(fftSize / 2);
	}

	/** @param {Float32Array} db one spectrum from AnalyserNode.getFloatFrequencyData */
	add(db) {
		const p = this.scratch;
		// same unit as the graph: density relative to white noise of full-scale variance
		const scale = this.fftSize / ANALYSER_WINDOW_POWER;
		for (let k = 0; k < p.length; k++) {
			p[k] = Number.isFinite(db[k]) ? 10 ** (db[k] / 10) * scale : 0;
			this.binSum[k] += p[k];
		}
		this.frames.push(Float32Array.from(bandPowers(p, this.sampleRate, this.fftSize), toDb));
	}

	get count() { return this.frames.length; }

	/** Per band: the average and the level of the loud moments (90th percentile), plus steady tones. */
	result() {
		const n = this.frames.length;
		if (!n) return null;
		const bandMean = new Array(BANDS), bandLoud = new Array(BANDS);
		const col = new Float32Array(n);
		for (let b = 0; b < BANDS; b++) {
			let sum = 0;
			for (let i = 0; i < n; i++) { col[i] = this.frames[i][b]; sum += 10 ** (col[i] / 10); }
			bandMean[b] = toDb(sum / n);
			col.sort();
			bandLoud[b] = col[Math.min(n - 1, Math.floor(n * 0.9))];
		}
		return { bandMean, bandLoud, tones: this.tones() };
	}

	/** Steady tones (hum, whine): narrow peaks well above their surroundings in the average. */
	tones() {
		const n = this.frames.length;
		const hz = this.sampleRate / this.fftSize;
		const db = Float32Array.from(this.binSum, (s) => toDb(s / n));
		const found = [];
		const k0 = Math.ceil(45 / hz), k1 = Math.min(db.length - 2, Math.floor(2000 / hz));
		for (let k = k0; k <= k1; k++) {
			if (db[k] < db[k - 1] || db[k] < db[k + 1]) continue;
			const span = Math.max(8, Math.round(k * (2 ** (1 / 3) - 1)));
			const around = Array.from(db.subarray(Math.max(1, k - span), Math.min(db.length, k + span + 1))).sort((a, b) => a - b);
			const prominence = db[k] - around[around.length >> 1];
			if (prominence >= 10) found.push({ f: k * hz, prominence });
		}
		found.sort((a, b) => b.prominence - a.prominence);
		const tones = [];
		for (const t of found) {
			if (tones.every((o) => Math.abs(Math.log2(o.f / t.f)) > 1 / 6)) tones.push(t);
			if (tones.length === 3) break;
		}
		return tones.sort((a, b) => a.f - b.f);
	}
}

/** Do sounds come and go mostly where voices are? (A hint for the default, not a detector.) */
export function soundsLikeVoices(m) {
	let inside = 0, ni = 0, outside = 0, no = 0;
	for (let b = 0; b < BANDS; b++) {
		const f = BAND_FREQS[b];
		if (f < VALID_LO || f > VALID_HI) continue;
		const d = m.bandLoud[b] - m.bandMean[b];
		if (f >= 250 && f <= 4000) { inside += d; ni++; } else { outside += d; no++; }
	}
	return inside / ni > 5 && inside / ni > outside / no + 1.5;
}

/**
 * A layer that covers the measured room.
 * @param {{bandMean:number[], bandLoud:number[], tones:{f:number, prominence:number}[]}} m
 * @param {{strength?: number, voices?: boolean}} [opts] strength 0 = plain sloped noise that
 *   follows the room only roughly, 1 = follows it closely, up to 1.5 = exaggerated.
 */
export function proposeMask(m, { strength = 1, voices = soundsLikeVoices(m) } = {}) {
	const valid = BAND_FREQS.map((f) => f >= VALID_LO && f <= VALID_HI);
	const first = valid.indexOf(true), last = valid.lastIndexOf(true);
	const at = (arr, b) => arr[Math.min(last, Math.max(first, b))];
	const shape = new Array(BANDS);
	for (let b = first; b <= last; b++) {
		const smooth = (at(m.bandMean, b - 1) + 2 * m.bandMean[b] + at(m.bandMean, b + 1)) / 4;
		// sounds that come and go need more cover than their average suggests
		const comesAndGoes = Math.min(12, Math.max(0, m.bandLoud[b] - m.bandMean[b] - 4));
		shape[b] = smooth + 0.5 * comesAndGoes;
	}
	// straight line through the shape (dB over octaves): the colour of the mask
	let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
	for (let b = first; b <= last; b++) {
		const x = Math.log2(BAND_FREQS[b] / 1000);
		sx += x; sy += shape[b]; sxx += x * x; sxy += x * shape[b]; n++;
	}
	const rawSlope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
	const slope = Math.min(6, Math.max(-9, Math.round(rawSlope * 2) / 2));
	const mean = sy / n, meanX = sx / n;
	const layer = defaultLayer();
	layer.slope = slope;
	layer.lowCut = 40;
	layer.highCut = 16000;
	for (let b = 0; b < BANDS; b++) {
		const bb = Math.min(last, Math.max(first, b));
		const x = Math.log2(BAND_FREQS[bb] / 1000);
		let db = strength * (shape[bb] - (mean + slope * (x - meanX)));
		if (voices) {
			const f = BAND_FREQS[b];
			db += 5 * Math.min(1, strength) / (1 + (280 / f) ** 4) / (1 + (f / 3500) ** 4);
		}
		layer.eq[b] = Math.min(24, Math.max(-24, Math.round(db)));
	}
	layer.notches = m.tones.slice(0, 3).map((t) => ({
		f: Math.round(t.f), width: 0.12,
		gain: Math.min(18, Math.max(3, Math.round(t.prominence * 0.7 * Math.max(0.3, strength)))),
	}));
	return layer;
}

/** Where a frequency sits on the band axis; exported for the graph. */
export { bandIndex };
