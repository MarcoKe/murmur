// Export: render a preset as a loop that repeats without a seam, and write it as a WAV file.

import { NoiseSynth } from '../dsp/synth.js';

/**
 * Renders `seconds` of the preset as a seamless loop: the last frame's fade-out is laid over the
 * start, and the movement is made periodic over the loop.
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}>}
 */
export async function renderLoop(preset, seconds, sampleRate = 48000, onProgress, seed) {
	const size = 4096, hop = size / 2;
	const frames = Math.max(2, Math.round((seconds * sampleRate) / hop));
	const synth = new NoiseSynth(sampleRate, { size, loopFrames: frames, seed });
	synth.setPreset(preset);
	const left = new Float32Array(frames * hop), right = new Float32Array(frames * hop);
	for (let f = 0; f < frames; f++) {
		synth.render(left.subarray(f * hop, (f + 1) * hop), right.subarray(f * hop, (f + 1) * hop));
		if (onProgress && f % 64 === 63) {
			onProgress(f / frames);
			await new Promise((r) => setTimeout(r));
		}
	}
	for (let i = 0; i < hop; i++) { left[i] += synth.tailL[i]; right[i] += synth.tailR[i]; }
	return { left, right, sampleRate };
}

/** 16-bit stereo PCM WAV. */
export function encodeWav({ left, right, sampleRate }) {
	const n = left.length;
	const buf = new ArrayBuffer(44 + n * 4);
	const v = new DataView(buf);
	const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
	text(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); text(8, 'WAVE');
	text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
	v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
	v.setUint16(32, 4, true); v.setUint16(34, 16, true);
	text(36, 'data'); v.setUint32(40, n * 4, true);
	const pcm = new Int16Array(buf, 44);
	const s16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
	for (let i = 0; i < n; i++) { pcm[2 * i] = s16(left[i]); pcm[2 * i + 1] = s16(right[i]); }
	return new Uint8Array(buf);
}
