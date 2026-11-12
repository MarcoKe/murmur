// Writes the fake microphone input for the browser test: a room with brown rumble and a 100 Hz
// hum, 10 s at one level, then 10 s about 10 dB louder (mono, 16 bit, 48 kHz).
import { writeFileSync, mkdirSync } from 'node:fs';
import { NoiseSynth } from '../public/js/dsp/synth.js';
import { sanitizePreset, defaultLayer } from '../public/js/preset.js';

const sr = 48000, seconds = 20;
const synth = new NoiseSynth(sr, { seed: 42 });
synth.setPreset(sanitizePreset({ layers: [{ ...defaultLayer(), slope: -6, level: -14, width: 0 }] }));
const n = Math.ceil((seconds * sr) / synth.hop) * synth.hop;
const x = new Float32Array(n), scrap = new Float32Array(synth.hop);
for (let i = 0; i < n; i += synth.hop) synth.render(x.subarray(i, i + synth.hop), scrap);

const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) {
	const t = i / sr;
	// smooth steps between the quiet and the loud half
	const loud = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, Math.max(0, (t % 20 - 9.5))) / 2) - (t % 20 > 19.5 ? 0.5 - 0.5 * Math.cos(Math.PI * (t % 20 - 19.5) / 0.5) : 0);
	const gain = 0.3 * 10 ** ((10 * loud) / 20);
	const v = gain * (x[i] + 0.04 * Math.sin(2 * Math.PI * 100 * t));
	buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
}
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/room.wav', import.meta.url), buf);
