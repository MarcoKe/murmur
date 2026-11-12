// Preset <-> compact bytes <-> base64url, for share links. The link carries the whole sound in
// the address fragment (#p=...), which browsers never send to a server.
//
// Format 2 (all integers unsigned unless noted):
//   u8 version, u8 layer count, then per layer:
//     state: u8 slope*2+18, u8 -level*2, u8 width*100, u16 lowCut, u16 highCut,
//            u8 flags (notch count | eq present << 4), notches: u16 f, u8 width*50, i8 gain,
//            eq: 31 x i8 (only when present)
//     u8 moving (0 | 1); when moving: u16 period*10, u8 irregular*100, 16 x u8 cycle,
//       u8 mask of the rest state's fields that differ from the peak (bit 0 slope, 1 level,
//       2 width, 3 lowCut, 4 highCut, 5 eq, 6 notches), then those fields, encoded as above
//   u8 name length in bytes, name as UTF-8
// Format 1 (four fixed movements, `mod`) is still read: see decodeV1.

import { sanitizePreset, PresetError, VERSION, MAX_LAYERS, MAX_NOTCHES } from './preset.js';
import { BANDS } from './dsp/curve.js';
import { CYCLE_POINTS } from './dsp/mod.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function encodePreset(preset) {
	const p = sanitizePreset(preset);
	const out = [VERSION, p.layers.length];
	const u16 = (v) => out.push((v >> 8) & 255, v & 255);
	const fields = {
		slope: (s) => out.push(Math.round(s.slope * 2) + 18),
		level: (s) => out.push(Math.round(-s.level * 2)),
		width: (s) => out.push(Math.round(s.width * 100)),
		lowCut: (s) => u16(s.lowCut),
		highCut: (s) => u16(s.highCut),
		eq: (s) => { for (const v of s.eq) out.push(v & 255); },
		notches: (s) => { for (const n of s.notches) { u16(n.f); out.push(Math.round(n.width * 50), n.gain & 255); } },
	};
	for (const l of p.layers) {
		for (const k of ['slope', 'level', 'width', 'lowCut', 'highCut']) fields[k](l);
		const hasEq = l.eq.some((v) => v !== 0);
		out.push(l.notches.length | (hasEq ? 16 : 0));
		fields.notches(l);
		if (hasEq) fields.eq(l);
		if (!l.move) { out.push(0); continue; }
		out.push(1);
		u16(Math.round(l.move.period * 10));
		out.push(Math.round(l.move.irregular * 100), ...l.move.cycle);
		const differing = Object.keys(fields).filter((k) => !same(l.rest[k], l[k]));
		out.push(Object.keys(fields).reduce((m, k, bit) => m | (differing.includes(k) ? 1 << bit : 0), 0));
		for (const k of differing) fields[k](l.rest);
	}
	const name = new TextEncoder().encode(p.name);
	out.push(name.length, ...name);
	return Uint8Array.from(out);
}

export function decodePreset(bytes) {
	let i = 0;
	const u8 = () => {
		if (i >= bytes.length) throw new PresetError('corrupt');
		return bytes[i++];
	};
	const u16 = () => (u8() << 8) | u8();
	const i8 = () => (u8() << 24) >> 24;
	const notches = (count) => Array.from({ length: count }, () => ({ f: u16(), width: u8() / 50, gain: i8() }));
	const eq = () => Array.from({ length: BANDS }, i8);
	const name = () => {
		const len = u8();
		if (i + len > bytes.length) throw new PresetError('corrupt');
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(i, i + len));
		} catch {
			throw new PresetError('corrupt');
		}
	};
	const version = u8();
	if (version > VERSION) throw new PresetError('version');
	if (version < 1) throw new PresetError('corrupt');
	const count = u8();
	if (count < 1 || count > MAX_LAYERS) throw new PresetError('corrupt');
	const layers = [];
	for (let n = 0; n < count; n++) {
		const l = { slope: (u8() - 18) / 2, level: -u8() / 2, width: u8() / 100, lowCut: u16(), highCut: u16() };
		if (version === 1) {
			// format 1: the movement came before the notches, as shape | band << 4, depth, period
			const mod = u8();
			l.mod = { shape: mod & 15, band: mod >> 4, depth: u8() / 100, period: u16() / 10 };
		}
		const flags = u8();
		if ((flags & 15) > MAX_NOTCHES) throw new PresetError('corrupt');
		l.notches = notches(flags & 15);
		l.eq = flags & 16 ? eq() : [];
		if (version > 1 && u8()) {
			l.move = { period: u16() / 10, irregular: u8() / 100, cycle: Array.from({ length: CYCLE_POINTS }, u8) };
			const mask = u8();
			const r = { ...l, eq: [...l.eq], notches: l.notches.map((x) => ({ ...x })) };
			delete r.move;
			if (mask & 1) r.slope = (u8() - 18) / 2;
			if (mask & 2) r.level = -u8() / 2;
			if (mask & 4) r.width = u8() / 100;
			if (mask & 8) r.lowCut = u16();
			if (mask & 16) r.highCut = u16();
			if (mask & 32) r.eq = eq();
			if (mask & 64) r.notches = notches(l.notches.length);
			l.rest = r;
		}
		layers.push(l);
	}
	return sanitizePreset({ v: version, name: name(), layers });
}

export function toBase64Url(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length > 2000) throw new PresetError('corrupt');
	let s;
	try {
		s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	} catch {
		throw new PresetError('corrupt');
	}
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export const presetToCode = (preset) => toBase64Url(encodePreset(preset));
export const codeToPreset = (code) => decodePreset(fromBase64Url(code));

/** The preset in a location hash like "#p=...", or null when there is none. Throws PresetError. */
export function presetFromHash(hash) {
	const m = /^#?p=([^&]*)/.exec(hash || '');
	return m ? codeToPreset(m[1]) : null;
}

export const presetToUrl = (preset, base) => `${base.replace(/#.*$/, '')}#p=${presetToCode(preset)}`;

/** Preset from the text of an exported file. Throws PresetError. */
export function presetFromJson(text) {
	let obj;
	try {
		obj = JSON.parse(text);
	} catch {
		throw new PresetError('corrupt');
	}
	return sanitizePreset(obj?.murmur === 'preset' ? obj.preset : obj);
}

export const presetToJson = (preset) =>
	JSON.stringify({ murmur: 'preset', preset: sanitizePreset(preset) }, null, '\t');
