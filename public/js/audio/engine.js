// Playback: the audio graph around the synth worklet.
//
//   synth -> (analysers for the graph) ; synth -> adapt (room following) -> timer (fades) -> noise (play/pause)
//         -> master (volume) -> limiter -> trim -> speakers
//   tone (tinnitus tone finder) -> toneGain -> master
//
// The context only runs while something is audible or the microphone is listening.

import { BANDS } from '../dsp/curve.js';
import { NoiseSynth } from '../dsp/synth.js';
import { bandPowers, ANALYSER_WINDOW_POWER } from '../dsp/mask.js';

const FADE = 0.5;
const dbToGain = (db) => 10 ** (db / 20);

/**
 * The analysers smooth magnitudes over time; the mean magnitude of noise is 1.05 dB below its
 * root mean square (Rayleigh distribution), which is added back here.
 */
const SMOOTHING_BIAS = 10 ** (1.05 / 10);

/**
 * Band densities in dB (the graph's unit), averaged over the given AnalyserNodes (one per
 * channel: an analyser fed with stereo would mix it to mono and lose up to 3 dB).
 */
export function analyserBands(analysers, scratch, out) {
	const first = analysers[0];
	const n = first.frequencyBinCount;
	scratch.db ??= new Float32Array(n);
	scratch.p ??= new Float64Array(n);
	scratch.b ??= new Float64Array(BANDS);
	scratch.p.fill(0);
	const scale = (first.fftSize / ANALYSER_WINDOW_POWER) * SMOOTHING_BIAS / analysers.length;
	for (const analyser of analysers) {
		analyser.getFloatFrequencyData(scratch.db);
		for (let k = 0; k < n; k++) if (Number.isFinite(scratch.db[k])) scratch.p[k] += 10 ** (scratch.db[k] / 10) * scale;
	}
	bandPowers(scratch.p, first.context.sampleRate, first.fftSize, scratch.b);
	for (let b = 0; b < BANDS; b++) out[b] = 10 * Math.log10(Math.max(scratch.b[b], 1e-20));
	return out;
}

/**
 * Browsers offer AudioWorklet only on https and localhost. On a plain http address (like a home
 * server's) the same synth runs on the main thread through the older ScriptProcessorNode: the
 * sound is identical, but heavy work on the page can make it stutter.
 * Has the worklet node's interface as far as the engine uses it.
 */
function mainThreadSynth(ctx) {
	const synth = new NoiseSynth(ctx.sampleRate);
	const node = ctx.createScriptProcessor(synth.hop, 1, 2); // one (unused) input: Safari wants one
	let active = false;
	node.onaudioprocess = (e) => {
		const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
		if (active) synth.render(L, R); else { L.fill(0); R.fill(0); }
	};
	node.port = {
		postMessage(m) {
			if (m.preset) synth.setPreset(m.preset);
			if (m.active !== undefined) active = m.active;
		},
	};
	return node;
}

export class Engine extends EventTarget {
	constructor() {
		super();
		this.ctx = null;
		this.playing = false;
		this.volume = 0.5;
		this.preset = null;
		this.holds = new Set(); // reasons to keep the context running: 'noise', 'tone', 'mic'
		this.scratch = {};
		this.pendingPreset = false;
	}

	/** Must first be called from a user gesture (browsers only start audio then). */
	async init() {
		if (this.ctx) return;
		if (this.starting) return this.starting;
		this.starting = (async () => {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			const ctx = new Ctx({ latencyHint: 'playback' });
			// iOS: play like a media app (also with the silent switch on)
			try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* optional */ }
			let node;
			if (ctx.audioWorklet) {
				await ctx.audioWorklet.addModule(new URL('./synth.worklet.js', import.meta.url));
				node = new AudioWorkletNode(ctx, 'murmur-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
			} else {
				node = mainThreadSynth(ctx);
			}
			const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
			this.analysers = [0, 1].map((channel) => {
				const analyser = new AnalyserNode(ctx, { fftSize: 8192, smoothingTimeConstant: 0.82 });
				splitter.connect(analyser, channel);
				return analyser;
			});
			const gain = (value) => new GainNode(ctx, { gain: value });
			this.adapt = gain(1); this.timer = gain(1); this.noise = gain(0); this.master = gain(this.volume ** 2);
			// limiter: only catches peaks when several loud layers add up
			const limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
			// the browser's compressor adds make-up gain (0.6 of the reduction at full scale): take it out
			const trim = gain(dbToGain(-0.6 * (6 - 6 / 20)));
			node.connect(splitter);
			node.connect(this.adapt).connect(this.timer).connect(this.noise).connect(this.master)
				.connect(limiter).connect(trim).connect(ctx.destination);
			this.toneGain = gain(0);
			this.toneGain.connect(this.master);
			this.node = node; this.ctx = ctx;
			if (this.preset) node.port.postMessage({ preset: this.preset });
			ctx.addEventListener('statechange', () => this.dispatchEvent(new Event('state')));
			await ctx.suspend();
		})();
		return this.starting;
	}

	setPreset(preset) {
		this.preset = preset;
		if (!this.node || this.pendingPreset) return;
		this.pendingPreset = true;
		// at most one update per frame while a slider is dragged
		requestAnimationFrame(() => {
			this.pendingPreset = false;
			this.node.port.postMessage({ preset: this.preset });
		});
	}

	async hold(reason) {
		this.holds.add(reason);
		clearTimeout(this.suspendTimer);
		if (this.ctx.state !== 'running') await this.ctx.resume();
	}

	release(reason, after = 0) {
		this.holds.delete(reason);
		clearTimeout(this.suspendTimer);
		this.suspendTimer = setTimeout(() => {
			if (!this.holds.size && this.ctx.state === 'running') this.ctx.suspend();
		}, after * 1000 + 50);
	}

	ramp(param, value, seconds) {
		const t = this.ctx.currentTime;
		param.cancelScheduledValues(t);
		param.setValueAtTime(param.value, t);
		param.linearRampToValueAtTime(value, t + seconds);
	}

	async play() {
		await this.init();
		this.playing = true;
		this.node.port.postMessage({ active: true });
		await this.hold('noise');
		this.ramp(this.noise.gain, 1, FADE);
		this.dispatchEvent(new Event('state'));
	}

	pause(fade = FADE) {
		if (!this.ctx || !this.playing) return;
		this.playing = false;
		this.ramp(this.noise.gain, 0, fade);
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (!this.playing) this.node.port.postMessage({ active: false });
		}, fade * 1000 + 100);
		this.release('noise', fade);
		this.dispatchEvent(new Event('state'));
	}

	toggle() { return this.playing ? this.pause() : this.play(); }

	/** @param {number} v 0..1 on the slider; the gain follows its square. */
	setVolume(v) {
		this.volume = v;
		if (this.ctx) this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.03);
	}

	/** Timer fades: go to `db` (-Infinity = silence) over `seconds`, starting `delay` from now. */
	timerFade(db, seconds, delay = 0) {
		if (!this.ctx) return;
		const g = this.timer.gain, t = this.ctx.currentTime + delay;
		g.cancelScheduledValues(this.ctx.currentTime);
		g.setValueAtTime(g.value, this.ctx.currentTime);
		g.setValueAtTime(g.value, t);
		g.linearRampToValueAtTime(db === -Infinity ? 0 : dbToGain(db), t + seconds);
	}

	timerReset() {
		if (!this.ctx) return;
		this.timer.gain.cancelScheduledValues(this.ctx.currentTime);
		this.timer.gain.setValueAtTime(1, this.ctx.currentTime);
	}

	setAdaptDb(db, seconds = 1) {
		if (this.ctx) this.ramp(this.adapt.gain, db === -Infinity ? 0 : dbToGain(db), seconds);
	}

	/** What is playing right now, per band, in the graph's unit. Null while silent. */
	spectrum(out) {
		if (!this.ctx || this.ctx.state !== 'running' || !this.playing) return null;
		return analyserBands(this.analysers, this.scratch, out);
	}

	// ---- tinnitus tone finder ----

	async toneStart(f, level = 0.05) {
		await this.init();
		await this.hold('tone');
		if (!this.osc) {
			this.osc = new OscillatorNode(this.ctx, { type: 'sine', frequency: f });
			this.osc.connect(this.toneGain);
			this.osc.start();
		}
		this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
		this.toneGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05);
	}

	toneSet(f, level) {
		if (!this.osc) return;
		this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
		if (level !== undefined) this.toneGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05);
	}

	toneStop() {
		if (!this.osc) return;
		const osc = this.osc;
		this.osc = null;
		this.toneGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
		setTimeout(() => { osc.stop(); osc.disconnect(); }, 400);
		this.release('tone', 0.4);
	}
}
