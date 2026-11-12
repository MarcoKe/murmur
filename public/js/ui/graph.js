// The spectrum graph: what plays right now (soft area), the sound's curve (line), the room as the
// microphone heard it (dashed), and editing the selected layer by dragging.
//
// Vertical unit: dB of power density, shifted so that the selected layer's own shape stays put
// while it is edited (its loudness normalisation is taken out): 0 is that layer's level at 1 kHz.

import { BANDS, BAND_FREQS, F_MIN, F_MAX, layerDbAt, bandIndex } from '../dsp/curve.js';
import { VALID_LO, VALID_HI } from '../dsp/mask.js';
import { t } from '../strings.js';

const DB_TOP = 42, DB_BOTTOM = -48;
const POINTS = 161;
const FREQS = Float64Array.from({ length: POINTS }, (_, i) => F_MIN * (F_MAX / F_MIN) ** (i / (POINTS - 1)));
const TICKS = [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']];
const BRUSH_OCTAVES = 0.6;

export const formatHz = (f) => (f >= 1000 ? `${Number((f / 1000).toFixed(f >= 10000 ? 1 : 2))} kHz` : `${Math.round(f)} Hz`);

export class Graph {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{onEdit: (layer: object) => void, announce: (text: string) => void}} hooks
	 */
	constructor(canvas, hooks) {
		this.canvas = canvas;
		this.hooks = hooks;
		this.g = canvas.getContext('2d');
		this.preset = null; this.selected = 0; this.norms = [];
		this.room = null; this.live = null; this.liveAlpha = 0;
		this.liveSmooth = new Float32Array(BANDS).fill(DB_BOTTOM);
		this.editable = false; this.detail = false;
		this.accent = '#e58fb1';
		this.cursor = 17; // keyboard: band under the cursor (1 kHz)
		this.active = -1; // the notch or peak under the pointer (or last touched): shows its width grips
		this.dirty = true;
		new ResizeObserver(() => this.resize()).observe(canvas);
		this.resize();
		canvas.addEventListener('pointerdown', (e) => this.down(e));
		canvas.addEventListener('pointermove', (e) => this.move(e));
		for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, (e) => this.up(e));
		canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
		canvas.addEventListener('pointerleave', () => { if (!this.drag) this.canvas.style.cursor = ''; });
		canvas.addEventListener('keydown', (e) => this.key(e));
		canvas.addEventListener('focus', () => { this.focused = true; this.dirty = true; });
		canvas.addEventListener('blur', () => { this.focused = false; this.dirty = true; });
	}

	resize() {
		const r = this.canvas.getBoundingClientRect();
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		this.w = Math.max(50, r.width); this.h = Math.max(50, r.height);
		this.canvas.width = Math.round(this.w * dpr);
		this.canvas.height = Math.round(this.h * dpr);
		this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.dirty = true;
	}

	setModel(preset, selected, norms, rest = false) {
		this.rest = rest && Boolean(preset.layers[selected].rest);
		if (selected !== this.selected || this.active >= preset.layers[selected].notches.length) this.active = -1;
		this.preset = preset; this.selected = selected; this.norms = norms;
		this.dirty = true;
	}

	setRoom(bands) { this.room = bands; this.dirty = true; }

	setEditable(on) {
		this.editable = on;
		this.canvas.classList.toggle('editable', on);
		this.canvas.tabIndex = on ? 0 : -1;
		this.dirty = true;
	}

	/** @param {Float32Array|null} bands what the engine plays, or null while silent */
	setLive(bands) {
		if (bands) {
			const shift = this.norms[this.selected] ?? 0;
			for (let b = 0; b < BANDS; b++) {
				const v = Math.max(DB_BOTTOM - 20, bands[b] - shift);
				this.liveSmooth[b] += (v - this.liveSmooth[b]) * (this.liveAlpha < 0.05 ? 1 : 0.3);
			}
			this.liveAlpha = Math.min(1, this.liveAlpha + 0.08);
			this.dirty = true;
		} else if (this.liveAlpha > 0) {
			this.liveAlpha = Math.max(0, this.liveAlpha - 0.06);
			this.dirty = true;
		}
	}

	// ---- geometry ----
	get bottom() { return this.h - 22; }
	x(f) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * this.w; }
	fAt(x) { return F_MIN * (F_MAX / F_MIN) ** Math.min(1, Math.max(0, x / this.w)); }
	y(db) { return ((DB_TOP - db) / (DB_TOP - DB_BOTTOM)) * this.bottom; }
	dbPerPx() { return (DB_TOP - DB_BOTTOM) / this.bottom; }

	/** The state being shaped: the selected layer (its peak) or its rest state. */
	get layer() {
		const l = this.preset?.layers[this.selected];
		return this.rest ? l.rest : l;
	}

	layerDb(i, f) {
		const l = i === this.selected ? this.layer : this.preset.layers[i];
		return layerDbAt(l, f) + l.level + (this.norms[i] ?? 0) - (this.norms[this.selected] ?? 0);
	}

	// ---- drawing ----
	draw() {
		if (!this.dirty || !this.preset) return;
		this.dirty = false;
		const { g, w, h, bottom } = this;
		const css = getComputedStyle(this.canvas);
		const grid = css.getPropertyValue('--grid').trim() || '#222834';
		const muted = css.getPropertyValue('--muted').trim() || '#8a92a3';
		const roomColor = css.getPropertyValue('--room').trim() || '#6fd3c0';
		g.clearRect(0, 0, w, h);

		g.lineWidth = 1; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'alphabetic';
		for (const [f, label] of TICKS) {
			const x = Math.round(this.x(f)) + 0.5;
			g.strokeStyle = grid; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, bottom); g.stroke();
			g.fillStyle = muted;
			g.textAlign = f === 20 ? 'left' : f === 20000 ? 'right' : 'center';
			g.fillText(label, f === 20 ? 2 : f === 20000 ? w - 2 : x, h - 6);
		}
		g.textAlign = 'left';
		for (let db = DB_TOP - 6; db > DB_BOTTOM; db -= 12) {
			const y = Math.round(this.y(db)) + 0.5;
			g.strokeStyle = grid; g.globalAlpha = db === 0 ? 1 : 0.55;
			g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
			g.globalAlpha = 1;
			if (this.detail && db % 24 === 0) { g.fillStyle = muted; g.fillText(`${db > 0 ? '+' : ''}${db} dB`, 4, y - 3); }
		}

		g.save();
		g.beginPath(); g.rect(0, 0, w, bottom); g.clip();

		// what is playing
		if (this.liveAlpha > 0) {
			const pts = BAND_FREQS.map((f, b) => [this.x(f), this.y(this.liveSmooth[b])]);
			g.beginPath(); g.moveTo(0, bottom); g.lineTo(pts[0][0], pts[0][1]);
			this.smoothPath(pts);
			g.lineTo(w, pts[BANDS - 1][1]); g.lineTo(w, bottom); g.closePath();
			const fill = g.createLinearGradient(0, 0, 0, bottom);
			fill.addColorStop(0, this.accent); fill.addColorStop(1, 'transparent');
			g.globalAlpha = 0.42 * this.liveAlpha; g.fillStyle = fill; g.fill();
			g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); this.smoothPath(pts);
			g.globalAlpha = 0.5 * this.liveAlpha; g.strokeStyle = this.accent; g.lineWidth = 1; g.stroke();
			g.globalAlpha = 1;
		}

		const layers = this.preset.layers;
		// the other layers, faint
		if (layers.length > 1) {
			g.lineWidth = 1.2; g.strokeStyle = muted; g.globalAlpha = 0.55;
			layers.forEach((_, i) => { if (i !== this.selected) this.curve((f) => this.layerDb(i, f)); });
			// all layers together
			g.globalAlpha = 0.9; g.setLineDash([2, 4]); g.strokeStyle = this.accent;
			this.curve((f) => {
				let p = 0;
				for (let i = 0; i < layers.length; i++) p += 10 ** (this.layerDb(i, f) / 10);
				return 10 * Math.log10(p);
			});
			g.setLineDash([]); g.globalAlpha = 1;
		}

		// the room
		if (this.room) {
			const shift = this.roomShift();
			const pts = [];
			BAND_FREQS.forEach((f, b) => { if (f >= VALID_LO && f <= VALID_HI) pts.push([this.x(f), this.y(this.room[b] + shift)]); });
			g.strokeStyle = roomColor; g.lineWidth = 1.6; g.setLineDash([6, 5]);
			g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); this.smoothPath(pts); g.stroke();
			g.setLineDash([]);
		}

		// a moving layer: its other state (the sound travels between the two lines)
		const whole = layers[this.selected];
		if (whole.rest) {
			const other = this.rest ? whole : whole.rest;
			g.strokeStyle = this.accent; g.lineWidth = 1.5; g.globalAlpha = 0.75; g.setLineDash([7, 5]);
			this.curve((f) => layerDbAt(other, f) + other.level);
			g.setLineDash([]); g.globalAlpha = 1;
		}

		// the selected layer
		g.strokeStyle = this.accent; g.lineWidth = 2.4; g.lineJoin = 'round';
		g.shadowColor = this.accent; g.shadowBlur = 12;
		this.curve((f) => this.layerDb(this.selected, f));
		g.shadowBlur = 0;

		if (this.editable) this.drawHandles(muted);
		g.restore();
	}

	curve(fn) {
		const { g } = this;
		g.beginPath();
		for (let i = 0; i < POINTS; i++) {
			const x = this.x(FREQS[i]), y = this.y(Math.max(DB_BOTTOM - 10, fn(FREQS[i])));
			if (i) g.lineTo(x, y); else g.moveTo(x, y);
		}
		g.stroke();
	}

	/** Continues the current path through the points with rounded corners. */
	smoothPath(pts) {
		const { g } = this;
		for (let i = 1; i < pts.length - 1; i++) {
			g.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
		}
		const lastPt = pts[pts.length - 1];
		g.lineTo(lastPt[0], lastPt[1]);
	}

	/** The microphone is not calibrated: the room curve is laid over the sound's curve. */
	roomShift() {
		let room = 0, own = 0, n = 0;
		BAND_FREQS.forEach((f, b) => {
			if (f < VALID_LO || f > VALID_HI) return;
			room += this.room[b]; own += Math.max(DB_BOTTOM, this.layerDb(this.selected, f)); n++;
		});
		return (own - room) / n;
	}

	drawHandles(muted) {
		const { g, bottom } = this;
		const l = this.layer;
		// low and high cut: grips at the bottom
		for (const [f, dir] of [[l.lowCut, 1], [l.highCut, -1]]) {
			const x = this.x(f);
			g.strokeStyle = muted; g.globalAlpha = 0.6; g.lineWidth = 1; g.setLineDash([3, 4]);
			g.beginPath(); g.moveTo(x, 0); g.lineTo(x, bottom); g.stroke();
			g.setLineDash([]); g.globalAlpha = 1; g.fillStyle = muted;
			g.beginPath(); g.moveTo(x, bottom - 16); g.lineTo(x + 11 * dir, bottom - 8); g.lineTo(x, bottom); g.closePath(); g.fill();
		}
		// notches and peaks; the active one also shows its width: a grip on either side
		l.notches.forEach((n, i) => {
			const [x, y] = this.notchXY(n);
			if (i === this.active) {
				const grips = this.gripXY(n);
				g.strokeStyle = this.accent; g.lineWidth = 1; g.globalAlpha = 0.6; g.setLineDash([2, 3]);
				g.beginPath(); g.moveTo(grips[0][0], grips[0][1]); g.lineTo(x, y); g.lineTo(grips[1][0], grips[1][1]); g.stroke();
				g.setLineDash([]); g.globalAlpha = 1;
				for (const [gx, gy] of grips) {
					g.fillStyle = this.accent;
					g.beginPath(); g.roundRect(gx - 3.5, gy - 9, 7, 18, 3.5); g.fill();
				}
				const label = `${formatHz(n.f)} · ${n.gain > 0 ? '+' : ''}${Math.round(n.gain)} dB · ${Number(n.width.toFixed(2))} oct`;
				g.font = '12px system-ui, sans-serif';
				const tw = g.measureText(label).width;
				const lx = Math.min(this.w - tw - 8, Math.max(8, x - tw / 2));
				const ly = y > 44 ? y - 18 : y + 30;
				g.fillStyle = 'rgba(12, 14, 19, 0.82)';
				g.beginPath(); g.roundRect(lx - 6, ly - 13, tw + 12, 18, 6); g.fill();
				g.fillStyle = '#dfe3ea'; g.textAlign = 'left'; g.fillText(label, lx, ly);
			}
			g.fillStyle = i === this.active ? this.accent : '#0d0f14'; g.strokeStyle = this.accent; g.lineWidth = 2;
			g.beginPath(); g.arc(x, y, 6.5, 0, 2 * Math.PI); g.fill(); g.stroke();
		});
		if (this.focused) {
			const f = BAND_FREQS[this.cursor];
			const x = this.x(f), y = this.y(this.layerDb(this.selected, f));
			g.strokeStyle = '#fff'; g.lineWidth = 1.5;
			g.beginPath(); g.arc(x, y, 9, 0, 2 * Math.PI); g.stroke();
		}
	}

	// ---- editing ----
	pos(e) {
		const r = this.canvas.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	notchXY(n) {
		return [this.x(n.f), Math.min(this.bottom - 8, Math.max(8, this.y(this.layerDb(this.selected, n.f))))];
	}

	/** The two width grips of a notch: where it has fallen to half its depth (in dB). */
	gripXY(n) {
		return [-1, 1].map((side) => {
			const f = Math.min(F_MAX, Math.max(F_MIN, n.f * 2 ** ((side * n.width) / 2)));
			return [this.x(f), Math.min(this.bottom - 12, Math.max(12, this.y(this.layerDb(this.selected, f))))];
		});
	}

	hit(x, y) {
		const l = this.layer;
		const near = (px, py, r) => Math.hypot(x - px, y - py) < r;
		for (let i = 0; i < l.notches.length; i++) {
			if (near(...this.notchXY(l.notches[i]), 16)) return { kind: 'notch', index: i };
		}
		if (l.notches[this.active]) {
			for (const [gx, gy] of this.gripXY(l.notches[this.active])) {
				if (near(gx, gy, 16)) return { kind: 'width', index: this.active };
			}
		}
		if (y > this.bottom - 34) {
			const dLow = Math.abs(x - this.x(l.lowCut) - 5), dHigh = Math.abs(x - this.x(l.highCut) + 5);
			if (Math.min(dLow, dHigh) < 20) return { kind: dLow <= dHigh ? 'lowCut' : 'highCut' };
		}
		return { kind: 'curve' };
	}

	setActive(index) {
		if (index === this.active) return;
		this.active = index;
		this.dirty = true;
	}

	down(e) {
		if (!this.editable || !this.preset || (e.pointerType === 'mouse' && e.button !== 0)) return;
		const [x, y] = this.pos(e);
		const hit = this.hit(x, y);
		// touching a notch selects it (its grips appear), touching the bare curve deselects
		this.setActive(hit.kind === 'curve' ? -1 : hit.index ?? this.active);
		this.drag = { ...hit, x, y, work: structuredClone(this.layer) };
		this.canvas.setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	move(e) {
		if (!this.editable || !this.preset) return;
		const [x, y] = this.pos(e);
		const d = this.drag;
		if (!d) {
			const hit = this.hit(x, y);
			// hovering selects; it stays selected on the way to its grips
			if (hit.kind === 'notch' && e.pointerType === 'mouse') this.setActive(hit.index);
			this.canvas.style.cursor = hit.kind === 'curve' ? 'ns-resize' : hit.kind === 'notch' ? 'move' : 'ew-resize';
			return;
		}
		const w = d.work;
		const dDb = -(y - d.y) * this.dbPerPx();
		if (d.kind === 'curve') {
			const centre = bandIndex(this.fAt(x));
			for (let b = 0; b < BANDS; b++) {
				const oct = (b - centre) / 3;
				w.eq[b] = Math.min(40, Math.max(-40, w.eq[b] + dDb * Math.exp(-0.5 * (oct / BRUSH_OCTAVES) ** 2)));
			}
		} else if (d.kind === 'notch') {
			const n = w.notches[d.index];
			n.f = this.fAt(x);
			n.gain = Math.min(24, Math.max(-48, n.gain + dDb));
		} else if (d.kind === 'width') {
			const n = w.notches[d.index];
			n.width = Math.min(4, Math.max(0.04, 2 * Math.abs(Math.log2(this.fAt(x) / n.f))));
		} else {
			w[d.kind] = this.fAt(x);
		}
		d.x = x; d.y = y;
		this.hooks.onEdit(structuredClone(w));
	}

	up(e) {
		if (!this.drag) return;
		this.drag = null;
		try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
	}

	/** Mouse wheel (or two-finger scroll) over a notch: wider and narrower. */
	wheel(e) {
		if (!this.editable || !this.preset || this.drag) return;
		const hit = this.hit(...this.pos(e));
		if (hit.kind !== 'notch' && hit.kind !== 'width') return;
		e.preventDefault();
		const l = structuredClone(this.layer);
		const n = l.notches[hit.index];
		const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
		// at least one step of the grid per wheel event, so small movements are not rounded away
		const next = n.width * Math.exp(-delta * 0.003);
		n.width = Math.min(4, Math.max(0.04, Math.abs(next - n.width) < 0.02 ? n.width - Math.sign(delta) * 0.02 : next));
		this.setActive(hit.index);
		this.hooks.onEdit(l);
	}

	key(e) {
		if (!this.editable || !this.preset) return;
		const step = e.shiftKey ? 3 : 1;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			this.cursor = Math.min(BANDS - 1, Math.max(0, this.cursor + (e.key === 'ArrowRight' ? 1 : -1) * step));
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			const l = structuredClone(this.layer);
			const d = e.key === 'ArrowUp' ? step : -step;
			for (let b = 0; b < BANDS; b++) {
				l.eq[b] = Math.min(40, Math.max(-40, l.eq[b] + d * Math.exp(-0.5 * ((b - this.cursor) / 3 / (BRUSH_OCTAVES / 2)) ** 2)));
			}
			this.hooks.onEdit(l);
		} else {
			return;
		}
		e.preventDefault();
		this.dirty = true;
		const eq = this.layer.eq[this.cursor];
		this.hooks.announce(t('graphCursor', { f: formatHz(BAND_FREQS[this.cursor]), db: `${eq > 0 ? '+' : ''}${eq}` }));
	}
}
