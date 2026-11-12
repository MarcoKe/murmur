// "Room" tab: listen once and build a mask, or keep following the room while playing.

import { micProblem, openMic, sampleRoom, Adaptive } from '../audio/room.js';
import { proposeMask, soundsLikeVoices, VALID_LO, VALID_HI } from '../dsp/mask.js';
import { BAND_FREQS } from '../dsp/curve.js';
import { MAX_LAYERS } from '../preset.js';
import { SECURE_URL } from '../config.js';
import { t } from '../strings.js';
import { $, h } from '../util.js';
import { formatHz } from './graph.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The parts of a layer the mask proposal decides (the rest stays the user's). */
const shapeOf = (l) => JSON.stringify([l.slope, l.eq, l.notches, l.lowCut, l.highCut]);

function describe(m) {
	const parts = [];
	const slope = proposeMask(m, { strength: 0, voices: false }).slope;
	let unsteady = 0, n = 0;
	BAND_FREQS.forEach((f, b) => { if (f >= VALID_LO && f <= VALID_HI) { unsteady += m.bandLoud[b] - m.bandMean[b]; n++; } });
	unsteady /= n;
	const voices = soundsLikeVoices(m);
	let kind = t(slope <= -4.5 ? 'roomRumble' : slope >= -1 ? 'roomHiss' : 'roomEven');
	if (unsteady < 3.5) kind += ', ' + t('roomSteady');
	else if (unsteady > 7 && !voices) kind += ', ' + t('roomUnsteady');
	parts.push(kind);
	if (m.tones.length) parts.push(t(m.tones.length > 1 ? 'roomTones' : 'roomTone', { f: m.tones.map((x) => formatHz(x.f)).join(', ') }));
	if (voices) parts.push(t('roomVoices'));
	return t('roomHeard', { parts: parts.join('; ') });
}

function micErrorText(e) {
	if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return t('roomDenied');
	if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return t('roomNoMic');
	return String(e?.message || e);
}

export function initRoom(app) {
	const { engine } = app;
	let measurement = null;
	let written = null; // { index, shape }: the layer the strength slider may still rewrite
	let stopListening = null;
	let adaptive = null, adaptMic = null;

	const problem = micProblem();
	if (problem) {
		const box = $('room-problem');
		box.append(h('span', {}, t(problem === 'insecure' ? 'roomInsecure' : 'roomUnsupported')));
		if (problem === 'insecure' && SECURE_URL) {
			const [before, after] = t('roomInsecureUrl', { url: '\n' }).split('\n');
			box.append(h('span', {}, before, h('a', { href: SECURE_URL }, SECURE_URL.replace(/^https:\/\/|\/$/g, '')), after));
		}
		box.hidden = false;
		$('room-listen').disabled = true;
		$('adapt').disabled = true;
	}

	function micIndicator() {
		const on = Boolean(stopListening || adaptMic);
		$('mic').hidden = !on;
		$('mic-text').textContent = t('micOn');
	}
	$('mic-stop').addEventListener('click', () => {
		stopListening?.();
		if (adaptMic) stopAdaptive();
	});

	// ---- listen once ----
	$('room-listen').addEventListener('click', async () => {
		if (stopListening) return;
		stopAdaptive();
		const seconds = Number($('room-seconds').value);
		const wasPlaying = engine.playing;
		const abort = new AbortController();
		let mic;
		$('room-listen').disabled = true;
		try {
			if (wasPlaying) { engine.pause(0.3); await wait(500); }
			mic = await openMic(engine);
			stopListening = () => abort.abort();
			micIndicator();
			$('room-progress').hidden = false;
			$('room-result').hidden = true;
			const m = await sampleRoom(mic, seconds, (fraction) => {
				$('room-bar').style.width = `${fraction * 100}%`;
				$('room-status').textContent = t('roomListening', { s: Math.ceil(seconds * (1 - fraction)) });
			}, abort.signal);
			const valid = m.bandMean.filter((_, b) => BAND_FREQS[b] >= VALID_LO && BAND_FREQS[b] <= VALID_HI);
			if (valid.reduce((a, v) => a + v, 0) / valid.length < -100) throw new Error(t('roomTooQuiet'));
			measurement = m;
			app.graph.setRoom(m.bandMean);
			$('legend-room').hidden = false;
			$('room-heard').textContent = describe(m);
			$('room-voices').checked = soundsLikeVoices(m);
			$('room-progress').hidden = true;
			$('room-result').hidden = false;
		} catch (e) {
			$('room-progress').hidden = e?.name === 'AbortError';
			if (e?.name !== 'AbortError') $('room-status').textContent = micErrorText(e);
			$('room-bar').style.width = '0';
		} finally {
			mic?.close();
			stopListening = null;
			micIndicator();
			$('room-listen').disabled = false;
			if (wasPlaying) app.play();
		}
	});

	const options = () => ({ strength: Number($('room-strength').value), voices: $('room-voices').checked });
	const showStrength = () => { $('room-strength-out').textContent = `${Math.round(Number($('room-strength').value) * 100)}%`; };

	function useMask(asNew) {
		if (!measurement) return;
		const layer = proposeMask(measurement, options());
		if (asNew) {
			app.setPreset({ name: t('roomMaskName'), layers: [layer] }, { selected: 0 });
		} else {
			if (app.preset.layers.length >= MAX_LAYERS) { app.toast(t('roomLayersFull'), 6000); return; }
			layer.level = -10;
			app.setPreset({ ...app.preset, layers: [...app.preset.layers, layer] }, { selected: app.preset.layers.length });
		}
		written = { index: app.selected, shape: shapeOf(app.preset.layers[app.selected]) };
		if (!engine.playing) app.play();
	}
	$('room-new').addEventListener('click', () => useMask(true));
	$('room-add').addEventListener('click', () => useMask(false));

	// The slider reshapes the mask in place, as long as it still is what was put there (a mask
	// bent by hand, or another sound loaded since, is left alone).
	function restrength() {
		showStrength();
		const current = written && app.preset.layers[written.index];
		if (!measurement || !current || shapeOf(current) !== written.shape) return;
		const next = proposeMask(measurement, options());
		app.updateLayer({ ...current, slope: next.slope, eq: next.eq, notches: next.notches }, written.index);
		written.shape = shapeOf(app.preset.layers[written.index]);
	}
	$('room-strength').addEventListener('input', restrength);
	$('room-voices').addEventListener('change', restrength);
	showStrength();

	// ---- follow the room ----
	function stopAdaptive() {
		adaptive?.stop();
		adaptMic?.close();
		adaptive = adaptMic = null;
		$('adapt').checked = false;
		micIndicator();
	}

	$('adapt').addEventListener('change', async () => {
		const status = $('adapt-status');
		if (!$('adapt').checked) { stopAdaptive(); status.textContent = ''; return; }
		if (!engine.playing) { $('adapt').checked = false; status.textContent = t('adaptNeedsPlay'); return; }
		try {
			adaptMic = await openMic(engine);
			micIndicator();
			status.textContent = t('adaptChecking');
			adaptive = new Adaptive(engine, adaptMic, ({ offset }) => {
				const db = Math.round(offset);
				status.textContent = t('adaptOn', { db: `${db > 0 ? '+' : db < 0 ? '−' : '±'}${Math.abs(db)}` });
			});
			app.adaptive = adaptive;
			await adaptive.start();
			status.textContent = t('adaptOn', { db: '±0' });
		} catch (e) {
			const stoppedByUser = e?.name === 'AbortError';
			stopAdaptive();
			status.textContent = stoppedByUser ? '' : e?.message === 'feedback' ? t('adaptFeedback') : micErrorText(e);
		}
	});
	app.on('play', () => { if (adaptMic && !engine.playing) { stopAdaptive(); $('adapt-status').textContent = ''; } });
}
