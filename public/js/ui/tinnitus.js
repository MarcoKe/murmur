// "Tinnitus" tab: match the tone by ear, check the octave, then make a comfort sound around it.

import { tinnitusPreset } from '../preset.js';
import { t } from '../strings.js';
import { $, h, store } from '../util.js';
import { formatHz } from './graph.js';

const F_LO = 250, F_HI = 16000;

export function initTinnitus(app) {
	const { engine } = app;
	let f = Math.min(F_HI, Math.max(F_LO, Number(store.get('tone', 4000)) || 4000));
	let playing = false;
	let wasPlaying = false;
	const slider = $('tone-f'), levelSlider = $('tone-level');
	// quiet by default: the tone only has to be audible next to the tinnitus
	const level = () => 0.004 + 0.12 * Number(levelSlider.value) ** 2;
	const toPos = (v) => Math.round(1000 * Math.log(v / F_LO) / Math.log(F_HI / F_LO));

	function show() {
		$('tone-out').textContent = formatHz(f);
		if (document.activeElement !== slider) slider.value = toPos(f);
		$('tone-play').setAttribute('aria-pressed', String(playing));
	}

	let audition = 1; // octave check: which of f/2, f, 2f is sounding

	function setF(value) {
		f = Math.min(F_HI, Math.max(F_LO, value));
		audition = 1;
		store.set('tone', Math.round(f));
		if (playing) engine.toneSet(f, level());
		show();
	}

	async function start() {
		if (playing) return;
		wasPlaying = engine.playing;
		if (wasPlaying) engine.pause(0.2);
		playing = true;
		await engine.toneStart(f, level());
		show();
	}

	function stop({ resume = true } = {}) {
		if (!playing) return;
		playing = false;
		engine.toneStop();
		if (resume && wasPlaying) app.play();
		show();
	}

	$('tone-play').addEventListener('click', () => (playing ? stop() : start()));
	slider.addEventListener('input', () => setF(F_LO * (F_HI / F_LO) ** (Number(slider.value) / 1000)));
	levelSlider.addEventListener('input', () => { if (playing) engine.toneSet(f * audition, level()); });
	$('tone-down').addEventListener('click', () => setF(f / 2 ** (1 / 24)));
	$('tone-up').addEventListener('click', () => setF(f * 2 ** (1 / 24)));

	// octave check: hear the neighbours without losing the choice, then take the one that fits
	const octave = (labelKey, factor) => h('button', { type: 'button', class: 'btn', onclick: async () => {
		if (f * factor < F_LO / 2 || f * factor > 20000) return;
		await start();
		audition = factor;
		engine.toneSet(f * factor, level());
	} }, t(labelKey));
	$('tone-octaves').append(octave('toneCheckLower', 0.5), octave('toneCheckSame', 1), octave('toneCheckHigher', 2),
		h('button', { type: 'button', class: 'btn primary', onclick: () => setF(f * audition) }, t('toneUse')));

	const make = (kind) => () => {
		stop({ resume: false });
		app.setPreset(tinnitusPreset(kind, f), { selected: 0 });
		app.play();
	};
	$('tone-notch').addEventListener('click', make('notch'));
	$('tone-band').addEventListener('click', make('band'));

	app.on('tab', () => { if (app.tab !== 'tinnitus') stop(); });
	show();
}
