// The movement of a layer over one cycle, drawn by hand: left to right is time, bottom is the
// rest state, top is the peak.

import { cycleAt, CYCLE_POINTS } from '../dsp/mod.js';

export class CycleEditor {
	/** @param {{onEdit: (cycle: number[]) => void, announce: (text: string) => void}} hooks */
	constructor(canvas, hooks) {
		this.canvas = canvas; this.hooks = hooks;
		this.g = canvas.getContext('2d');
		this.cycle = new Array(CYCLE_POINTS).fill(50);
		this.accent = '#e58fb1';
		this.cursor = 0;
		new ResizeObserver(() => this.resize()).observe(canvas);
		canvas.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			canvas.setPointerCapture(e.pointerId);
			this.last = null;
			this.work = [...this.cycle];
			this.paint(e);
			e.preventDefault();
		});
		canvas.addEventListener('pointermove', (e) => { if (this.work) this.paint(e); });
		for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => { this.work = null; });
		canvas.addEventListener('keydown', (e) => this.key(e));
		canvas.addEventListener('focus', () => { this.focused = true; this.draw(); });
		canvas.addEventListener('blur', () => { this.focused = false; this.draw(); });
		this.resize();
	}

	resize() {
		const r = this.canvas.getBoundingClientRect();
		if (!r.width) return; // hidden
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		this.w = r.width; this.h = r.height;
		this.canvas.width = Math.round(this.w * dpr);
		this.canvas.height = Math.round(this.h * dpr);
		this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}

	set(cycle, accent) {
		this.cycle = cycle; this.accent = accent;
		if (!this.w) this.resize(); else this.draw();
	}

	y(v) { return 6 + (1 - v / 100) * (this.h - 12); }

	draw() {
		if (!this.w) return;
		const { g, w, h } = this;
		const css = getComputedStyle(this.canvas);
		const grid = css.getPropertyValue('--grid').trim() || '#222834';
		g.clearRect(0, 0, w, h);
		g.strokeStyle = grid; g.lineWidth = 1;
		for (let i = 1; i < 4; i++) { const x = Math.round((w * i) / 4) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
		g.beginPath();
		for (let i = 0; i <= 200; i++) {
			const x = (w * i) / 200, y = this.y(100 * cycleAt(this.cycle, i / 200));
			if (i) g.lineTo(x, y); else g.moveTo(x, y);
		}
		g.strokeStyle = this.accent; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
		g.lineTo(w, h); g.lineTo(0, h); g.closePath();
		g.globalAlpha = 0.14; g.fillStyle = this.accent; g.fill(); g.globalAlpha = 1;
		g.fillStyle = this.accent;
		this.cycle.forEach((v, i) => { g.beginPath(); g.arc((w * i) / CYCLE_POINTS, this.y(v), 2.5, 0, 2 * Math.PI); g.fill(); });
		if (this.focused) {
			g.strokeStyle = '#fff'; g.lineWidth = 1.5;
			g.beginPath(); g.arc((w * this.cursor) / CYCLE_POINTS, this.y(this.cycle[this.cursor]), 7, 0, 2 * Math.PI); g.stroke();
		}
	}

	paint(e) {
		const r = this.canvas.getBoundingClientRect();
		const pos = ((e.clientX - r.left) / r.width) * CYCLE_POINTS;
		const value = Math.round(Math.min(100, Math.max(0, 100 * (1 - (e.clientY - r.top - 6) / (r.height - 12)))));
		const i = Math.min(CYCLE_POINTS - 1, Math.max(0, Math.round(pos)));
		// a fast stroke skips points: fill in the ones between
		const from = this.last ?? { i, value };
		const step = Math.sign(i - from.i) || 1;
		for (let k = from.i; ; k += step) {
			const u = i === from.i ? 1 : (k - from.i) / (i - from.i);
			this.work[k] = Math.round(from.value + (value - from.value) * u);
			if (k === i) break;
		}
		this.last = { i, value };
		this.hooks.onEdit([...this.work]);
	}

	key(e) {
		const step = e.shiftKey ? 20 : 5;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			this.cursor = (this.cursor + (e.key === 'ArrowRight' ? 1 : CYCLE_POINTS - 1)) % CYCLE_POINTS;
			this.draw();
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			const next = [...this.cycle];
			next[this.cursor] = Math.min(100, Math.max(0, next[this.cursor] + (e.key === 'ArrowUp' ? step : -step)));
			this.hooks.onEdit(next);
		} else {
			return;
		}
		e.preventDefault();
		this.hooks.announce(`${this.cursor + 1} / ${CYCLE_POINTS}: ${this.cycle[this.cursor]}%`);
	}
}
