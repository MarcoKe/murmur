// "Shape" tab: the layers of the sound and the controls of the selected one.

import { defaultLayer, greyEq, withPattern, patternOf, LIMITS, MAX_LAYERS, MAX_NOTCHES } from '../preset.js';
import { CycleEditor } from './cycle.js';
import { t } from '../strings.js';
import { $, h, slopeColor } from '../util.js';
import { formatHz } from './graph.js';

export function colourName(slope) {
	if (slope >= 4.5) return t('cViolet');
	if (slope >= 1.5) return t('cBlue');
	if (slope > -1.5) return t('cWhite');
	if (slope > -4.5) return t('cPink');
	if (slope >= -7) return t('cBrown');
	return t('cDeep');
}

const signed = (v, unit = ' dB') => `${v > 0 ? '+' : ''}${v}${unit}`.replace('-', '−');
let ids = 0;

export function initLayers(app) {
	const box = $('layer-controls');
	const updaters = [];
	const layer = () => app.preset.layers[app.selected];
	// The sliders shape one state of the layer: its peak, or (for a moving layer) its rest.
	const state = () => app.state();
	const change = (fn) => {
		const s = structuredClone(state());
		fn(s);
		app.updateState(s);
	};
	/** Changes to the layer as a whole: its movement, or something both states share. */
	const changeLayer = (fn) => {
		const l = structuredClone(layer());
		fn(l);
		app.updateLayer(l);
	};

	/** A labelled slider. `log` sliders run 0..1000 over a geometric range. */
	function slider({ label, min, max, step, log = false, get, set, format, adv = false, list, whole = false }) {
		const id = 'c' + ++ids;
		const toPos = (v) => (log ? Math.round(1000 * Math.log(v / min) / Math.log(max / min)) : v);
		const fromPos = (p) => (log ? min * (max / min) ** (p / 1000) : p);
		const input = h('input', { id, type: 'range', min: log ? 0 : min, max: log ? 1000 : max, step: log ? 1 : step, list });
		const out = h('output', { for: id });
		input.addEventListener('input', () => (whole ? changeLayer : change)((l) => set(l, fromPos(Number(input.value)))));
		updaters.push(() => {
			const v = get(whole ? layer() : state());
			if (v === undefined) return;
			if (document.activeElement !== input) input.value = toPos(v);
			out.textContent = format(v);
		});
		return h('div', { class: 'control' + (adv ? ' adv' : '') }, h('label', { for: id }, label), input, out);
	}

	function segmented({ label, options, get, onpick }) {
		const buttons = options.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => onpick(value) }, text));
		updaters.push(() => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === get()))));
		return h('div', { class: 'control' }, h('label', {}, label), h('div', {}, h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...buttons)), h('span'));
	}

	// ---- movement: when (the cycle) and between what (rest and peak) ----
	const cycleCanvas = h('canvas', { class: 'cycle', tabindex: '0', role: 'img', 'aria-label': t('cycleLabel') });
	const cycle = new CycleEditor(cycleCanvas, {
		onEdit: (points) => changeLayer((l) => { l.move.cycle = points; }),
		announce: (text) => { $('announce').textContent = text; },
	});
	const moving = h('div', { class: 'moving' },
		h('div', { class: 'control cycle-row' }, h('label', {}, t('cycle')),
			h('div', { class: 'cycle-wrap' }, cycleCanvas, h('span', { class: 'cycle-top' }, t('peak')), h('span', { class: 'cycle-bottom' }, t('rest'))), h('span')),
		slider({ label: t('speed'), whole: true, min: 120, max: 0.5, log: true, get: (l) => l.move?.period, set: (l, v) => { l.move.period = v; }, format: (v) => t('every', { s: v >= 10 ? Math.round(v) : v }) }),
		slider({ label: t('irregular'), whole: true, min: 0, max: 1, step: 0.01, get: (l) => l.move?.irregular, set: (l, v) => { l.move.irregular = v; },
			format: (v) => (v <= 0 ? t('irregNone') : v >= 1 ? t('irregFull') : `${Math.round(v * 100)}%`) }),
		h('p', { class: 'hint' }, t('moveHint')));
	// above the sliders it decides about: which of the two shapes they (and the graph) change
	const stateSwitch = segmented({ label: t('editState'), options: [['peak', t('peak')], ['rest', t('rest')]], get: () => app.editing, onpick: (v) => app.setEditing(v) });

	// Notches and peaks: one line each (frequency, depth, width), opening to its sliders. They are
	// rebuilt only when their number changes, so a slider being dragged is never replaced.
	const notchBox = h('div');
	let notchCount = '';
	let notchUpdaters = [];
	function notchRows(openLast) {
		const base = updaters.length;
		const count = state().notches.length;
		notchBox.replaceChildren(...state().notches.map((_, i) => {
			const text = h('span', { class: 'notch-text' });
			updaters.push(() => {
				const n = state().notches[i];
				if (n) text.textContent = `${n.gain > 0 ? t('peak') : t('notch')} · ${formatHz(n.f)} · ${signed(n.gain)} · ${t('octaves', { n: n.width })}`;
			});
			return h('details', { class: 'notch', open: openLast && i === count - 1 },
				h('summary', {}, text,
					h('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('removeNotch'), title: t('removeNotch'),
						onclick: (e) => { e.preventDefault(); changeLayer((l) => { l.notches.splice(i, 1); l.rest?.notches.splice(i, 1); }); } }, '✕')),
				slider({ label: t('notchF'), min: 20, max: 20000, log: true, get: (l) => l.notches[i]?.f ?? 1000, set: (l, v) => { l.notches[i].f = v; }, format: formatHz }),
				slider({ label: t('notchGain'), min: LIMITS.notchGain[0], max: LIMITS.notchGain[1], step: 1, get: (l) => l.notches[i]?.gain ?? 0, set: (l, v) => { l.notches[i].gain = v; }, format: (v) => signed(v) }),
				slider({ label: t('notchWidth'), min: 0.04, max: 4, log: true, get: (l) => l.notches[i]?.width ?? 1, set: (l, v) => { l.notches[i].width = v; }, format: (v) => t('octaves', { n: v }) }));
		}));
		notchUpdaters = updaters.splice(base);
	}
	const addNotch = h('button', { type: 'button', class: 'btn small', onclick: () => changeLayer((l) => { for (const st of [l, l.rest]) st?.notches.push({ f: 1000, width: 0.5, gain: -24 }); }) }, t('addNotch'));
	const notchHint = h('p', { class: 'hint' }, t('notchHint'));

	box.append(
		stateSwitch,
		slider({ label: t('colour'), min: -9, max: 9, step: 0.5, list: 'colours', get: (l) => l.slope, set: (l, v) => { l.slope = v; },
			format: (v) => t('colourValue', { name: colourName(v), slope: signed(v, '') }) }),
		h('datalist', { id: 'colours' }, ...[-6, -3, 0, 3, 6].map((v) => h('option', { value: v }))),
		slider({ label: t('level'), min: LIMITS.level[0], max: 0, step: 0.5, get: (l) => l.level, set: (l, v) => { l.level = v; }, format: (v) => signed(v) }),
		slider({ label: t('width'), min: 0, max: 1, step: 0.01, get: (l) => l.width, set: (l, v) => { l.width = v; },
			format: (v) => (v < 0.05 ? t('mono') : v > 0.95 ? t('wide') : `${Math.round(v * 100)}%`) }),
		segmented({ label: t('movement'), options: [['', t('steady')], ['breathing', t('breathing')], ['waves', t('waves')], ['wind', t('wind')]],
			get: () => (layer().move ? patternOf(layer().move) : ''),
			onpick: (name) => { app.updateLayer(withPattern(layer(), name)); if (!name) app.setEditing('peak'); } }),
		moving,
		slider({ label: t('lowCut'), adv: true, min: 20, max: 16000, log: true, get: (l) => l.lowCut, set: (l, v) => { l.lowCut = v; }, format: (v) => (v <= 20 ? t('off') : formatHz(v)) }),
		slider({ label: t('highCut'), adv: true, min: 25, max: 20000, log: true, get: (l) => l.highCut, set: (l, v) => { l.highCut = v; }, format: (v) => (v >= 20000 ? t('off') : formatHz(v)) }),
		h('div', { class: 'group adv' }, h('h3', {}, t('notches')), notchHint, notchBox, addNotch),
		h('div', { class: 'row' },
			h('button', { type: 'button', class: 'btn small', onclick: () => change((l) => { l.eq.fill(0); }) }, t('resetCurve')),
			h('button', { type: 'button', class: 'btn small adv', onclick: () => change((l) => { l.eq = greyEq(); l.slope = 0; }) }, t('greyCurve'))));

	function renderChips() {
		const { layers } = app.preset;
		$('layers').replaceChildren(
			...layers.map((l, i) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(i === app.selected), onclick: () => app.select(i) },
				h('span', { class: 'swatch', style: `--c: ${slopeColor(l.slope)}` }), t('layerN', { n: i + 1 }))),
			layers.length < MAX_LAYERS ? h('button', { type: 'button', class: 'chip', onclick: () => {
				const next = defaultLayer();
				next.level = -12;
				app.setPreset({ ...app.preset, layers: [...layers, next] }, { selected: layers.length });
			} }, '+ ' + t('addLayer')) : null,
			layers.length > 1 ? h('button', { type: 'button', class: 'chip', onclick: () => {
				app.setPreset({ ...app.preset, layers: layers.filter((_, i) => i !== app.selected) }, { selected: Math.max(0, app.selected - 1) });
			} }, '✕ ' + t('removeLayer')) : null);
	}

	let chipKey = '';
	app.on('preset', () => {
		// the chips too are only rebuilt when something they show changed (keeps keyboard focus)
		const key = app.selected + '|' + app.preset.layers.map((l) => l.slope).join();
		if (key !== chipKey) { chipKey = key; renderChips(); }
		const l = layer();
		const key2 = app.selected + app.editing + ':' + l.notches.length;
		if (key2 !== notchCount) {
			// a notch that was just added opens; switching layers or removing one opens nothing
			const [was, n] = notchCount.split(':');
			notchRows(was === app.selected + app.editing && l.notches.length === Number(n) + 1);
			notchCount = key2;
		}
		for (const u of updaters) u();
		for (const u of notchUpdaters) u();
		moving.hidden = stateSwitch.hidden = !l.move;
		if (l.move) cycle.set(l.move.cycle, slopeColor(l.slope));
		addNotch.hidden = l.notches.length >= MAX_NOTCHES;
	});
}
