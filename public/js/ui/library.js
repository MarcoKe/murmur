// "Sounds" tab: the starting points and the sounds saved in this browser.

import { BUILTINS, sanitizePreset, samePreset } from '../preset.js';
import { t } from '../strings.js';
import { $, h, store, slopeColor } from '../util.js';

const GROUPS = [['basics', 'groupBasics'], ['focus', 'groupFocus'], ['sleep', 'groupSleep'], ['play', 'groupPlay']];

function loadMine() {
	const out = [];
	for (const p of store.get('library', []) || []) {
		try { out.push(sanitizePreset(p)); } catch { /* skip what cannot be read */ }
	}
	return out;
}

export function initLibrary(app) {
	let mine = loadMine();
	const chips = [];

	const chip = (preset) => {
		const el = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: () => {
			app.setPreset(preset, { selected: 0 });
			if (!app.engine.playing) app.play();
		} }, h('span', { class: 'swatch', style: `--c: ${slopeColor(preset.layers[0].slope)}` }), preset.name || t('untitled'));
		chips.push([el, preset]);
		return el;
	};

	for (const [group, key] of GROUPS) {
		$('builtins').append(h('div', { class: 'group' },
			h('h3', {}, t(key)),
			h('div', { class: 'chips' }, ...BUILTINS.filter((b) => b.group === group).map((b) => chip(b.preset)))));
	}
	const fixed = chips.length;

	function renderMine() {
		chips.length = fixed;
		$('mine').replaceChildren(...mine.map((preset, i) => h('span', { class: 'chip-wrap' },
			chip(preset),
			h('button', { type: 'button', class: 'del', 'aria-label': t('deleteSound', { name: preset.name }), title: t('deleteSound', { name: preset.name }), onclick: () => {
				mine.splice(i, 1);
				store.set('library', mine);
				renderMine();
				app.toast(t('deleted'));
			} }, '✕'))));
		$('mine-empty').hidden = mine.length > 0;
		mark();
	}

	function mark() {
		for (const [el, preset] of chips) el.setAttribute('aria-pressed', String(samePreset(preset, app.preset)));
	}

	$('save').addEventListener('click', () => {
		if (!app.preset.name) {
			app.toast(t('nameFirst'));
			$('name').focus();
			return;
		}
		const at = mine.findIndex((p) => p.name === app.preset.name);
		if (at >= 0) mine[at] = app.preset; else mine.push(app.preset);
		store.set('library', mine);
		renderMine();
		app.toast(t(at >= 0 ? 'updated' : 'saved'));
	});

	app.on('preset', mark);
	renderMine();
}
