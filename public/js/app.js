// The page: holds the current sound and wires engine, graph and the tab panels together.

import { Engine } from './audio/engine.js';
import { Graph } from './ui/graph.js';
import { BUILTINS, sanitizePreset, clonePreset, stateOf, patternOf, PresetError } from './preset.js';
import { BANDS, layerNorm } from './dsp/curve.js';
import { presetFromHash } from './codec.js';
import { t } from './strings.js';
import { $, store, slopeColor } from './util.js';
import { initLibrary } from './ui/library.js';
import { initLayers, colourName } from './ui/layers.js';
import { initShare } from './ui/share.js';
import { initTimer } from './ui/timer.js';
import { initTinnitus } from './ui/tinnitus.js';
import { initRoom } from './ui/roomui.js';

const TABS = ['sounds', 'shape', 'room', 'tinnitus', 'timer', 'share'];

class App extends EventTarget {
	constructor() {
		super();
		this.engine = new Engine();
		this.graph = new Graph($('graph'), {
			onEdit: (state) => this.updateState(state),
			announce: (text) => { $('announce').textContent = text; },
		});
		this.preset = null;
		this.selected = 0;
		this.editing = 'peak'; // which state of a moving layer the controls and the graph shape: 'peak' | 'rest'
		this.norms = [];
		this.tab = 'sounds';
	}

	emit(type) { this.dispatchEvent(new Event(type)); }
	on(type, fn) { this.addEventListener(type, fn); }

	/** Every change of the sound goes through here. */
	setPreset(preset, { selected = this.selected } = {}) {
		this.preset = sanitizePreset(preset);
		const sampleRate = this.engine.ctx?.sampleRate ?? 48000;
		selected = Math.min(this.preset.layers.length - 1, Math.max(0, selected));
		if (selected !== this.selected || !this.preset.layers[selected].rest) this.editing = 'peak';
		this.selected = selected;
		this.norms = this.preset.layers.map((l) => layerNorm(l, 4096, sampleRate).normDb);
		this.engine.setPreset(this.preset);
		const accent = slopeColor(this.preset.layers[this.selected].slope);
		document.documentElement.style.setProperty('--accent', accent);
		this.graph.accent = accent;
		this.graph.setModel(this.preset, this.selected, this.norms, this.editing === 'rest');
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => store.set('current', this.preset), 300);
		this.emit('preset');
	}

	updateLayer(layer, index = this.selected) {
		const p = clonePreset(this.preset);
		p.layers[index] = layer;
		this.setPreset(p);
	}

	/** The state being shaped: the selected layer itself (its peak), or its rest state. */
	state() {
		const l = this.preset.layers[this.selected];
		return this.editing === 'rest' && l.rest ? l.rest : l;
	}

	updateState(state) {
		const l = this.preset.layers[this.selected];
		this.updateLayer(this.editing === 'rest' && l.rest ? { ...l, rest: stateOf(state) } : { ...l, ...stateOf(state) });
	}

	setEditing(which) {
		this.editing = which === 'rest' && this.preset.layers[this.selected].rest ? 'rest' : 'peak';
		this.setPreset(this.preset);
	}

	select(index) { this.setPreset(this.preset, { selected: index }); }

	toast(text, ms = 3200) {
		const el = $('toast');
		el.textContent = text;
		el.classList.add('show');
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
	}

	errorText(e) {
		if (e instanceof PresetError) return t(e.code === 'version' ? 'errVersion' : 'errCorrupt');
		return String(e?.message || e);
	}

	async play() {
		try {
			await this.engine.play();
		} catch (e) {
			console.error(e);
			this.toast(t('errAudio', { reason: e?.message || e }), 8000);
		}
	}

	showTab(name) {
		if (!TABS.includes(name)) name = 'sounds';
		const previous = this.tab;
		this.tab = name;
		for (const id of TABS) {
			$('t-' + id).setAttribute('aria-selected', String(id === name));
			$('t-' + id).tabIndex = id === name ? 0 : -1;
			$('p-' + id).hidden = id !== name;
		}
		this.graph.setEditable(name === 'shape');
		store.set('tab', name);
		if (previous !== name) this.emit('tab');
	}
}

const app = new App();
window.murmur = app; // for the browser tests and for tinkering in the console

function summary(preset) {
	const parts = [t('noiseOf', { colour: colourName(preset.layers[0].slope) })];
	if (preset.layers.length > 1) parts.push(t('layersN', { n: preset.layers.length }));
	const moves = [...new Set(preset.layers.filter((l) => l.move).map((l) => t(patternOf(l.move) ?? 'moving').toLowerCase()))];
	parts.push(moves.length ? moves.join(', ') : t('steady').toLowerCase());
	return parts.join(' · ');
}

// ---- transport ----
const playButton = $('play');
playButton.addEventListener('click', () => (app.engine.playing ? app.engine.pause() : app.play()));
app.engine.addEventListener('state', () => {
	const on = app.engine.playing;
	playButton.setAttribute('aria-pressed', String(on));
	playButton.setAttribute('aria-label', t(on ? 'pause' : 'play'));
	if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
	app.emit('play');
});
document.addEventListener('keydown', (e) => {
	if (e.key !== ' ' || e.target.closest('input, button, select, textarea, a, canvas')) return;
	e.preventDefault();
	playButton.click();
});

const volume = $('volume');
volume.value = store.get('volume', 0.5);
app.engine.setVolume(Number(volume.value));
volume.addEventListener('input', () => {
	app.engine.setVolume(Number(volume.value));
	store.set('volume', Number(volume.value));
});

const name = $('name');
name.addEventListener('input', () => app.setPreset({ ...app.preset, name: name.value }));
name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
app.on('preset', () => {
	if (document.activeElement !== name) name.value = app.preset.name;
	$('summary').textContent = summary(app.preset);
	$('legend-all').hidden = app.preset.layers.length < 2;
	$('legend-other').hidden = !app.preset.layers[app.selected].rest;
	$('legend-other').textContent = t(app.editing === 'rest' ? 'legendPeak' : 'legendRest');
	if ('mediaSession' in navigator && window.MediaMetadata) {
		navigator.mediaSession.metadata = new MediaMetadata({ title: app.preset.name || t('untitled'), artist: 'murmur' });
	}
});
if ('mediaSession' in navigator) {
	navigator.mediaSession.setActionHandler('play', () => app.play());
	navigator.mediaSession.setActionHandler('pause', () => app.engine.pause());
}

// ---- advanced switch, tabs ----
const advanced = $('advanced');
advanced.checked = store.get('advanced', false);
const applyAdvanced = () => {
	document.body.classList.toggle('advanced', advanced.checked);
	app.graph.detail = advanced.checked;
	app.graph.dirty = true;
	store.set('advanced', advanced.checked);
};
advanced.addEventListener('change', applyAdvanced);
applyAdvanced();

for (const id of TABS) {
	$('t-' + id).addEventListener('click', () => app.showTab(id));
	$('t-' + id).addEventListener('keydown', (e) => {
		const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
		if (!d) return;
		const next = TABS[(TABS.indexOf(id) + d + TABS.length) % TABS.length];
		app.showTab(next);
		$('t-' + next).focus();
	});
}

$('graph').setAttribute('aria-label', t('graphLabel'));

// ---- panels ----
initLibrary(app);
initLayers(app);
initShare(app);
initTimer(app);
initTinnitus(app);
initRoom(app);

// ---- the sound to start with: a shared link, else the last one, else pink ----
function loadShared() {
	let shared;
	try {
		shared = presetFromHash(location.hash);
	} catch (e) {
		app.toast(app.errorText(e), 9000);
	}
	if (location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search);
	if (!shared) return false;
	const previous = app.preset;
	app.setPreset(shared, { selected: 0 });
	$('shared-text').textContent = t('sharedBanner', { name: shared.name || t('untitled') });
	$('shared-back').hidden = !previous;
	$('shared-back').onclick = () => { app.setPreset(previous, { selected: 0 }); $('shared').hidden = true; };
	$('shared').hidden = false;
	return true;
}
$('shared-close').addEventListener('click', () => { $('shared').hidden = true; });
$('shared-save').addEventListener('click', () => { $('save').click(); $('shared').hidden = true; });
window.addEventListener('hashchange', loadShared);

let stored = null;
try { stored = sanitizePreset(store.get('current')); } catch { /* none yet, or unreadable */ }
if (stored) app.setPreset(stored, { selected: 0 });
if (!loadShared() && !stored) app.setPreset(BUILTINS.find((b) => b.preset.name === 'Pink').preset);
app.showTab(store.get('tab', 'sounds'));

// ---- drawing ----
const live = new Float32Array(BANDS);
function frame() {
	app.graph.setLive(app.engine.spectrum(live));
	app.graph.draw();
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && window.isSecureContext) {
	navigator.serviceWorker.register('sw.js').catch(() => {});
}
