// Audio thread: pulls frames from the NoiseSynth and hands them out in the 128-sample blocks the
// browser asks for.

import { NoiseSynth } from '../dsp/synth.js';

class MurmurSynth extends AudioWorkletProcessor {
	constructor() {
		super();
		this.synth = new NoiseSynth(sampleRate);
		this.bufL = new Float32Array(this.synth.hop);
		this.bufR = new Float32Array(this.synth.hop);
		this.pos = this.synth.hop; // empty
		this.active = false;
		this.port.onmessage = (e) => {
			const m = e.data;
			if (m.preset) this.synth.setPreset(m.preset);
			if (m.active !== undefined) this.active = m.active;
		};
	}

	process(_inputs, outputs) {
		if (!this.active) return true; // silence, no work
		const out = outputs[0];
		const L = out[0], R = out[1] || out[0];
		let done = 0;
		while (done < L.length) {
			if (this.pos === this.bufL.length) {
				this.synth.render(this.bufL, this.bufR);
				this.pos = 0;
			}
			const take = Math.min(L.length - done, this.bufL.length - this.pos);
			L.set(this.bufL.subarray(this.pos, this.pos + take), done);
			if (R !== L) R.set(this.bufR.subarray(this.pos, this.pos + take), done);
			this.pos += take; done += take;
		}
		return true;
	}
}

registerProcessor('murmur-synth', MurmurSynth);
