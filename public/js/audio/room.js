// The microphone: sampling the room once, and following it while playing.
// Sound is only analysed here, as numbers per frequency band; nothing is recorded, stored or sent.

import { RoomStats } from '../dsp/mask.js';
import { aWeightDb } from '../dsp/curve.js';

/** null when the microphone can be used here, else the reason: 'insecure' | 'unsupported'. */
export function micProblem() {
	if (!window.isSecureContext) return 'insecure';
	if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
	return null;
}

function audioSession(type) {
	try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* not on this browser */ }
}

/**
 * Opens the microphone with all processing switched off (it would remove exactly the steady
 * noise we want to see).
 */
export async function openMic(engine) {
	await engine.init();
	// iOS: the engine asks for a playback-only audio session (sound with the silent switch on);
	// that one refuses the microphone, so switch while listening and back afterwards
	audioSession('play-and-record');
	let stream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
		});
	} catch (e) {
		audioSession('playback');
		throw e;
	}
	await engine.hold('mic');
	const ctx = engine.ctx;
	const source = ctx.createMediaStreamSource(stream);
	const analyser = new AnalyserNode(ctx, { fftSize: 16384, smoothingTimeConstant: 0 });
	source.connect(analyser); // never connected to the speakers
	const db = new Float32Array(analyser.frequencyBinCount);
	// weights for a loudness-like broadband level, 100 Hz - 8 kHz
	const hz = ctx.sampleRate / analyser.fftSize;
	const k0 = Math.ceil(100 / hz), k1 = Math.floor(8000 / hz);
	const weights = Float32Array.from({ length: k1 - k0 + 1 }, (_, i) => 10 ** (aWeightDb((k0 + i) * hz) / 10));
	return {
		analyser, sampleRate: ctx.sampleRate,
		spectrum() { analyser.getFloatFrequencyData(db); return db; },
		/** Broadband level in dB (uncalibrated). */
		level() {
			analyser.getFloatFrequencyData(db);
			let sum = 0;
			for (let k = k0; k <= k1; k++) if (Number.isFinite(db[k])) sum += 10 ** (db[k] / 10) * weights[k - k0];
			return 10 * Math.log10(sum + 1e-20);
		},
		close() {
			source.disconnect();
			for (const t of stream.getTracks()) t.stop();
			audioSession('playback');
			engine.release('mic');
		},
	};
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(new DOMException('stopped', 'AbortError'));
	const id = setTimeout(resolve, ms);
	signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('stopped', 'AbortError')); }, { once: true });
});

/**
 * Listens for `seconds` and returns the measurement for proposeMask().
 * @param {(fraction: number, levelDb: number) => void} [onProgress]
 */
export async function sampleRoom(mic, seconds, onProgress, signal) {
	const stats = new RoomStats(mic.sampleRate, mic.analyser.fftSize);
	await sleep(400, signal); // let the microphone settle (some start with a click or a fade)
	const start = performance.now();
	for (;;) {
		const elapsed = (performance.now() - start) / 1000;
		if (elapsed >= seconds) break;
		stats.add(mic.spectrum());
		onProgress?.(elapsed / seconds, mic.level());
		await sleep(50, signal);
	}
	return stats.result();
}

const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

/**
 * Follows the room: when it gets louder the mask comes up a little, when it calms down the mask
 * goes back. Works with headphones only. With speakers the microphone hears the mask itself, which
 * start() checks by muting the mask for a moment.
 */
export class Adaptive {
	/** @param {(state: {offset: number, level: number}) => void} onChange */
	constructor(engine, mic, onChange) {
		this.engine = engine; this.mic = mic; this.onChange = onChange;
		this.offset = 0;
		this.abort = new AbortController();
	}

	async measure(ms) {
		const levels = [];
		const end = performance.now() + ms;
		while (performance.now() < end) {
			await sleep(100, this.abort.signal);
			levels.push(this.mic.level());
		}
		return median(levels);
	}

	/** Resolves once following; rejects with Error('feedback') when the mic hears the mask. */
	async start() {
		const { engine } = this;
		try {
			const withMask = await this.measure(1500);
			engine.setAdaptDb(-Infinity, 0.25);
			await sleep(700, this.abort.signal);
			const roomOnly = await this.measure(1500);
			engine.setAdaptDb(0, 0.6);
			if (withMask - roomOnly > 2) throw new Error('feedback');
			this.reference = roomOnly;
			this.smooth = roomOnly;
			this.loop().catch(() => {});
		} catch (e) {
			engine.setAdaptDb(0, 0.3);
			throw e;
		}
	}

	async loop() {
		const dt = 0.25;
		for (;;) {
			await sleep(dt * 1000, this.abort.signal);
			const level = this.mic.level();
			// rise within a few seconds, fall back slowly
			const tau = level > this.smooth ? 3 : 10;
			this.smooth += (level - this.smooth) * (1 - Math.exp(-dt / tau));
			const offset = Math.min(8, Math.max(-8, 0.7 * (this.smooth - this.reference)));
			if (Math.abs(offset - this.offset) >= 0.25) {
				this.offset = offset;
				this.engine.setAdaptDb(offset, 1);
			}
			this.onChange?.({ offset: this.offset, level });
		}
	}

	stop() {
		this.abort.abort();
		this.engine.setAdaptDb(0, 0.5);
	}
}
