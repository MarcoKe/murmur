// The noise itself. Each frame is built in the frequency domain (the wanted magnitude per bin,
// a random phase), turned into samples by one inverse FFT and cross-faded with the previous frame.
// One complex FFT gives two independent signals; they are used as mid and side, which is how the
// stereo width works. Used by the audio worklet (endless) and by the WAV export (loop).

import { FFT } from './fft.js';
import { layerNorm, stateBinPower, stateAt } from './curve.js';
import { moveValue } from './mod.js';

/** A moving layer's spectrum is computed for this many steps between rest and peak (and kept). */
const STEPS = 64;

export class NoiseSynth {
	/**
	 * @param {number} sampleRate
	 * @param {{size?: number, loopFrames?: number, seed?: number}} [opts] loopFrames: make the
	 *   movement periodic over that many frames (the caller wraps the last frame's tail around).
	 */
	constructor(sampleRate, { size = 4096, loopFrames = 0, seed } = {}) {
		this.sampleRate = sampleRate;
		this.n = size;
		this.hop = size / 2;
		this.loopSeconds = (loopFrames * this.hop) / sampleRate;
		this.fft = new FFT(size);
		this.re = new Float64Array(size);
		this.im = new Float64Array(size);
		this.win = new Float32Array(size);
		// sine window: the squares of two overlapping halves add up to 1, so the level stays even
		for (let i = 0; i < size; i++) this.win[i] = Math.sin((Math.PI * (i + 0.5)) / size);
		this.tailL = new Float32Array(this.hop);
		this.tailR = new Float32Array(this.hop);
		this.mid = new Float32Array(this.hop);
		this.side = new Float32Array(this.hop);
		this.layers = [];
		this.frame = 0;
		this.state = (seed ?? (Math.random() * 4294967296)) >>> 0 || 1;
	}

	setPreset(preset) {
		const { n, sampleRate } = this;
		this.layers = preset.layers.map((layer, index) => {
			const { gain } = layerNorm(layer, n, sampleRate);
			const moving = Boolean(layer.rest && layer.move);
			return {
				layer, gain, moving, salt: index * 31,
				// steady layers: one table; moving ones: a table per step, made when first needed
				tables: moving ? new Array(STEPS + 1) : [stateBinPower(layer, gain, n, sampleRate)],
			};
		});
	}

	/** Bin powers and width of a layer at time t. */
	tableAt(l, t) {
		if (!l.moving) return [l.tables[0], l.layer.width];
		const step = Math.round(moveValue(l.layer.move, t, l.salt, this.loopSeconds) * STEPS);
		const state = stateAt(l.layer, step / STEPS);
		l.tables[step] ??= stateBinPower(state, l.gain, this.n, this.sampleRate);
		return [l.tables[step], state.width];
	}

	rand() {
		let s = this.state;
		s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
		this.state = s >>>= 0;
		return s / 4294967296;
	}

	/** Writes the next hop (size / 2) samples to outL and outR. */
	render(outL, outR) {
		const { n, hop, re, im, win, mid, side, tailL, tailR } = this;
		const t = (this.frame * hop) / this.sampleRate;
		mid.fill(0); side.fill(0);
		let wide = false;
		for (const l of this.layers) {
			const [power, width] = this.tableAt(l, t);
			const w2 = width * width;
			const m = 1 / (1 + w2), s = w2 / (1 + w2);
			if (s > 0) wide = true;
			for (let k = 1; k < hop; k++) {
				mid[k] += power[k] * m;
				side[k] += power[k] * s;
			}
		}
		re[0] = im[0] = re[hop] = im[hop] = 0;
		const twoPi = 2 * Math.PI;
		for (let k = 1; k < hop; k++) {
			// each bin and its mirror together carry the bin's variance, hence the half
			const a = Math.sqrt(mid[k] * 0.5);
			const phi = twoPi * this.rand();
			const xr = a * Math.cos(phi), xi = a * Math.sin(phi);
			let yr = 0, yi = 0;
			if (wide) {
				const b = Math.sqrt(side[k] * 0.5);
				const psi = twoPi * this.rand();
				yr = b * Math.cos(psi); yi = b * Math.sin(psi);
			}
			// Z = X + iY with X, Y the (Hermitian) spectra of two real signals
			re[k] = xr - yi; im[k] = xi + yr;
			re[n - k] = xr + yi; im[n - k] = yr - xi;
		}
		this.fft.inverse(re, im);
		for (let i = 0; i < hop; i++) {
			const w = win[i];
			outL[i] = tailL[i] + (re[i] + im[i]) * w;
			outR[i] = tailR[i] + (re[i] - im[i]) * w;
			const j = i + hop, w2 = win[j];
			tailL[i] = (re[j] + im[j]) * w2;
			tailR[i] = (re[j] - im[j]) * w2;
		}
		this.frame++;
	}
}
