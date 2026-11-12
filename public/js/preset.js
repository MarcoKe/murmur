// The preset: what a sound is. Everything that is saved, shared or sent to the synth passes
// through sanitizePreset(), which clamps every field and snaps it to the grid the link format
// stores, so a sound survives a round trip through a link unchanged and a hostile link can do
// nothing worse than sound odd.
//
// A layer is a state (slope, level, width, lowCut, highCut, eq, notches). A moving layer has a
// second state, `rest`, and `move`, which says how it travels between rest and the layer's own
// state (its peak): the shape of one cycle, how long a cycle takes, how irregular it is.
//
// Version 1 had four fixed movements that only changed the level (`mod`); such sounds are
// converted on loading (upgradeLayer).

import { BANDS, BAND_FREQS, aWeightDb } from './dsp/curve.js';
import { CYCLE_POINTS } from './dsp/mod.js';

export const VERSION = 2;
export const MAX_LAYERS = 4;
export const MAX_NOTCHES = 8;
export const NAME_MAX = 40;

export const LIMITS = {
	slope: [-9, 9, 0.5],
	level: [-70, 0, 0.5],
	width: [0, 1, 0.01],
	cut: [20, 20000, 1],
	eq: [-40, 40, 1],
	notchWidth: [0.04, 4, 0.02],
	notchGain: [-48, 24, 1],
	period: [0.5, 120, 0.1],
	irregular: [0, 1, 0.01],
	cycle: [0, 100, 1],
};

export class PresetError extends Error {
	/** @param {'version'|'corrupt'} code */
	constructor(code, message) { super(message || code); this.code = code; }
}

const num = (v, [min, max, step], fallback) => {
	v = Number(v);
	if (!Number.isFinite(v)) v = fallback;
	v = Math.round(v / step) * step;
	return Math.min(max, Math.max(min, Number(v.toFixed(4))));
};

// ---- movement: the cycles the pattern buttons start from ----
const smooth = (x) => x * x * (3 - 2 * x);
const cycleOf = (fn) => Array.from({ length: CYCLE_POINTS }, (_, i) => Math.round(100 * fn(i / CYCLE_POINTS)));
export const PATTERNS = {
	breathing: { cycle: cycleOf((p) => 0.5 - 0.5 * Math.cos(2 * Math.PI * p)), irregular: 0 },
	// a wave: quick swell, long wash out
	waves: { cycle: cycleOf((p) => (p < 0.25 ? smooth(p / 0.25) : (1 - (p - 0.25) / 0.75) ** 1.8)), irregular: 0.45 },
	// fully irregular: the cycle no longer shows, the layer drifts freely
	wind: { cycle: cycleOf(() => 0.5), irregular: 1 },
};
/** 'breathing' | 'waves' | 'wind' when the movement is still one of the patterns, else null. */
export function patternOf(move) {
	if (!move) return null;
	return Object.keys(PATTERNS).find((k) => PATTERNS[k].irregular === move.irregular &&
		(k === 'wind' || PATTERNS[k].cycle.every((v, i) => v === move.cycle[i]))) ?? null;
}

export const STATE_KEYS = ['slope', 'level', 'width', 'lowCut', 'highCut', 'eq', 'notches'];
/** A copy of just the state part of a layer (or of a state). */
export const stateOf = (l) => ({
	slope: l.slope, level: l.level, width: l.width, lowCut: l.lowCut, highCut: l.highCut,
	eq: [...l.eq], notches: l.notches.map((n) => ({ ...n })),
});

export function defaultLayer() {
	return {
		slope: -3, level: -6, width: 1, lowCut: 20, highCut: 20000,
		eq: new Array(BANDS).fill(0), notches: [],
		rest: null, move: null,
	};
}

/** Starts (or changes) a layer's movement from one of the patterns. Returns a new layer. */
export function withPattern(layer, name) {
	if (!name) return { ...layer, rest: null, move: null };
	const rest = layer.rest ?? { ...stateOf(layer), level: Math.max(LIMITS.level[0], layer.level - 18) };
	const move = { period: layer.move?.period ?? 8, cycle: [...PATTERNS[name].cycle], irregular: PATTERNS[name].irregular };
	return { ...layer, rest, move };
}

function sanitizeState(l, d) {
	const out = {
		slope: num(l.slope, LIMITS.slope, d.slope),
		level: num(l.level, LIMITS.level, d.level),
		width: num(l.width, LIMITS.width, d.width),
		lowCut: num(l.lowCut, LIMITS.cut, d.lowCut),
		highCut: num(l.highCut, LIMITS.cut, d.highCut),
		eq: d.eq.map((v, i) => num(Array.isArray(l.eq) ? l.eq[i] : v, LIMITS.eq, v)),
		notches: (Array.isArray(l.notches) ? l.notches : []).slice(0, MAX_NOTCHES)
			.filter((n) => n && typeof n === 'object')
			.map((n) => ({
				f: num(n.f, LIMITS.cut, 1000),
				width: num(n.width, LIMITS.notchWidth, 1),
				gain: num(n.gain, LIMITS.notchGain, -24),
			})),
	};
	// keep at least a third of an octave between the cuts
	if (out.highCut < out.lowCut * 1.26) {
		out.highCut = Math.min(20000, Math.round(out.lowCut * 1.26));
		if (out.highCut < out.lowCut * 1.26) out.lowCut = Math.round(out.highCut / 1.26);
	}
	return out;
}

/** Version 1: `mod` { shape 1 breathing | 2 waves | 3 wind, depth, period, band 0 all | 1 lows | 2 highs }. */
function upgradeLayer(l) {
	const mod = l.mod;
	const out = { ...l, rest: null, move: null };
	delete out.mod;
	const shape = Math.round(Number(mod?.shape) || 0), depth = Number(mod?.depth) || 0;
	if (shape < 1 || shape > 3 || !(depth > 0)) return out;
	const peak = sanitizeState(l, defaultLayer());
	const drop = Math.min(1, depth) * 30; // dB at the quietest moment
	const band = Math.round(Number(mod.band) || 0);
	const rest = stateOf(peak);
	if (band === 1 || band === 2) {
		// only the lows or the highs moved, crossing over at 700 Hz
		rest.eq = rest.eq.map((v, i) => {
			const highs = 1 / (1 + (700 / BAND_FREQS[i]) ** 4);
			return v - drop * (band === 2 ? highs : 1 - highs);
		});
	} else {
		rest.level -= drop;
	}
	const name = ['breathing', 'waves', 'wind'][shape - 1];
	return { ...out, rest, move: { period: mod.period, cycle: PATTERNS[name].cycle, irregular: PATTERNS[name].irregular } };
}

function sanitizeLayer(l, version) {
	const d = defaultLayer();
	if (!l || typeof l !== 'object') return d;
	if (version === 1) l = upgradeLayer(l);
	const out = { ...sanitizeState(l, d), rest: null, move: null };
	if (l.rest && typeof l.rest === 'object' && l.move && typeof l.move === 'object') {
		const rest = sanitizeState(l.rest, out);
		// the two states pair their notches one to one
		rest.notches = out.notches.map((n, i) => rest.notches[i] ?? { ...n });
		out.rest = rest;
		out.move = {
			period: num(l.move.period, LIMITS.period, 8),
			irregular: num(l.move.irregular, LIMITS.irregular, 0),
			cycle: Array.from({ length: CYCLE_POINTS }, (_, i) => num(Array.isArray(l.move.cycle) ? l.move.cycle[i] : 50, LIMITS.cycle, 50)),
		};
	}
	return out;
}

export function cleanName(name) {
	return Array.from(String(name ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim())
		.slice(0, NAME_MAX).join('');
}

export function sanitizePreset(p) {
	if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PresetError('corrupt');
	const version = p.v ?? VERSION;
	if (version !== 1 && version !== VERSION) throw new PresetError(Number(version) > VERSION ? 'version' : 'corrupt');
	const layers = (Array.isArray(p.layers) ? p.layers : []).slice(0, MAX_LAYERS).map((l) => sanitizeLayer(l, version));
	if (!layers.length) layers.push(defaultLayer());
	return { v: VERSION, name: cleanName(p.name), layers };
}

export const clonePreset = (p) => JSON.parse(JSON.stringify(p));
export const samePreset = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- starting points ----

// Written in the short version 1 form (`mod`: a pattern that changes the level) and converted;
// `tune` then gives the rest state more than a lower level where that makes the sound.
const layer = (o = {}) => ({ ...defaultLayer(), ...o, mod: { shape: 0, depth: 0.5, period: 8, band: 0, ...(o.mod || {}) } });
/** eq with a raised (or lowered) plateau between two frequencies, with soft shoulders. */
function bump(lo, hi, db) {
	return BAND_FREQS.map((f) => {
		const a = 1 / (1 + (lo / f) ** 4), b = 1 / (1 + (f / hi) ** 4);
		return Math.round(db * a * b);
	});
}
/** Equal-loudness-like: more where the ear is less sensitive. */
export const greyEq = () => BAND_FREQS.map((f) => Math.round(Math.min(24, Math.max(-24, -aWeightDb(f)))));

const B = (group, name, layers, tune) => {
	const preset = sanitizePreset({ v: 1, name, layers });
	tune?.(preset.layers);
	return { group, preset: sanitizePreset(preset) };
};

export const BUILTINS = [
	B('basics', 'White', [layer({ slope: 0 })]),
	B('basics', 'Pink', [layer({ slope: -3 })]),
	B('basics', 'Brown', [layer({ slope: -6 })]),
	B('basics', 'Grey', [layer({ slope: 0, eq: greyEq() })]),
	B('basics', 'Blue', [layer({ slope: 3 })]),
	B('focus', 'Speech masker', [layer({ slope: -4, eq: bump(180, 4500, 6), lowCut: 60, highCut: 9000 })]),
	B('focus', 'Deep brown', [layer({ slope: -7, lowCut: 30, highCut: 6000 })]),
	B('focus', 'Open plan', [
		layer({ slope: -4.5, lowCut: 50, highCut: 7000, eq: bump(250, 3000, 3) }),
		layer({ slope: -2, level: -17, lowCut: 300, highCut: 5000, mod: { shape: 3, depth: 0.35, period: 11 } }),
	]),
	B('sleep', 'Soft brown', [layer({ slope: -6.5, highCut: 3500, width: 0.8 })]),
	B('sleep', 'Slow waves', [
		layer({ slope: -6, level: -10, highCut: 2500 }),
		layer({ slope: -2.5, level: -5, lowCut: 150, highCut: 9000, mod: { shape: 2, depth: 0.75, period: 10, band: 0 } }),
	]),
	B('sleep', 'Fan', [
		layer({
			slope: -4.5, lowCut: 40, highCut: 8000, width: 0.5,
			notches: [{ f: 118, width: 0.1, gain: 12 }, { f: 236, width: 0.1, gain: 7 }],
			mod: { shape: 1, depth: 0.06, period: 0.7, band: 2 },
		}),
	]),
	B('sleep', 'Distant rain', [
		layer({ slope: -1, level: -8, lowCut: 500, highCut: 12000, eq: bump(1500, 8000, 4) }),
		layer({ slope: -6, level: -14, highCut: 800, mod: { shape: 3, depth: 0.3, period: 14 } }),
	]),
	B('play', 'Wind', [
		layer({ slope: -5, level: -6, lowCut: 60, highCut: 5000, mod: { shape: 3, depth: 0.7, period: 7 } }),
		layer({ slope: -1, level: -18, lowCut: 700, highCut: 6000, notches: [{ f: 1400, width: 0.6, gain: 9 }],
			mod: { shape: 3, depth: 0.9, period: 4.5 } }),
	], (l) => {
		// the whistle rises with the gusts
		l[1].rest.notches[0].f = 850; l[1].rest.notches[0].width = 0.9;
	}),
	B('play', 'Surf', [
		layer({ slope: -6, level: -9, highCut: 1200, mod: { shape: 2, depth: 0.35, period: 9 } }),
		layer({ slope: -1.5, level: -5, lowCut: 250, mod: { shape: 2, depth: 0.85, period: 9, band: 2 } }),
	], (l) => {
		// the wash is dull while it draws back and opens up as the wave breaks
		l[1].rest.highCut = 2200; l[1].rest.slope = -4;
	}),
	B('play', 'Static', [layer({ slope: 1, lowCut: 200, width: 0 })]),
	B('play', 'Engine room', [
		layer({ slope: -7, level: -5, lowCut: 30, highCut: 2000,
			notches: [{ f: 62, width: 0.12, gain: 14 }, { f: 124, width: 0.12, gain: 9 }],
			mod: { shape: 1, depth: 0.1, period: 1.6 } }),
		layer({ slope: -3, level: -20, lowCut: 800, highCut: 9000 }),
	]),
];

/** Tinnitus comfort sounds around a matched tone. */
export function tinnitusPreset(kind, f) {
	f = Math.round(Math.min(16000, Math.max(250, f)));
	const label = f >= 1000 ? `${(f / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : `${f} Hz`;
	if (kind === 'notch') {
		return sanitizePreset({
			v: 1, name: `Notched, ${label}`,
			layers: [layer({ slope: -2, lowCut: 100, notches: [{ f, width: 1, gain: -48 }] })],
		});
	}
	return sanitizePreset({
		v: 1, name: `Narrow band, ${label}`,
		layers: [layer({ slope: 0, level: -10, lowCut: Math.round(f / 1.19), highCut: Math.min(20000, Math.round(f * 1.19)) })],
	});
}
