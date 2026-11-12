// "Timer" tab: sleep timer (long fade-out, then stop) and focus timer (work and break in turns;
// in the break the sound steps back instead of a beep). The fades are scheduled on the audio
// clock, so they stay smooth when the browser slows a background tab's timers down.

import { t } from '../strings.js';
import { $, h, store, clock } from '../util.js';

const SLEEP_CHOICES = [15, 30, 45, 60, 90];
const BREAK_DB = -14, BREAK_RAMP = 20;

export function initTimer(app) {
	const { engine } = app;
	/** @type {null | {kind: 'sleep', end: number} | {kind: 'focus', phase: 'work'|'break', end: number, work: number, rest: number}} */
	let timer = null;
	let ticker = 0;
	let sleepMinutes = store.get('sleepMinutes', 30);

	const buttons = SLEEP_CHOICES.map((m) => h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => startSleep(m) }, `${m} min`));
	$('sleep-buttons').append(...buttons);
	$('focus-work').value = store.get('focusWork', 25);
	$('focus-break').value = store.get('focusBreak', 5);

	function cancel({ keepLevel = false } = {}) {
		timer = null;
		clearInterval(ticker);
		if (!keepLevel) engine.timerReset();
		show();
	}

	function begin(next) {
		cancel();
		timer = next;
		ticker = setInterval(tick, 500);
		show();
	}

	async function startSleep(minutes) {
		minutes = Math.min(720, Math.max(1, Math.round(minutes)));
		sleepMinutes = minutes;
		store.set('sleepMinutes', minutes);
		if (!engine.playing) await app.play();
		const total = minutes * 60;
		// fade over the last fifth, at most ten minutes, at least half a minute
		const fade = Math.min(total, Math.max(30, Math.min(600, total / 5)));
		begin({ kind: 'sleep', end: Date.now() + total * 1000 });
		engine.timerFade(-Infinity, fade, total - fade);
	}

	async function startFocus() {
		const work = Math.min(180, Math.max(1, Math.round(Number($('focus-work').value) || 25)));
		const rest = Math.min(60, Math.max(1, Math.round(Number($('focus-break').value) || 5)));
		store.set('focusWork', work); store.set('focusBreak', rest);
		if (!engine.playing) await app.play();
		begin({ kind: 'focus', phase: 'work', end: Date.now() + work * 60000, work, rest });
	}

	function tick() {
		if (!timer) return;
		if (Date.now() >= timer.end) {
			if (timer.kind === 'sleep') {
				cancel({ keepLevel: true }); // before pausing: the pause would cancel it and jump back to full level
				engine.pause(0.1);
				setTimeout(() => engine.timerReset(), 500);
				app.toast(t('timerDone'));
				return;
			}
			const toBreak = timer.phase === 'work';
			timer.phase = toBreak ? 'break' : 'work';
			timer.end = Date.now() + (toBreak ? timer.rest : timer.work) * 60000;
			engine.timerFade(toBreak ? BREAK_DB : 0, BREAK_RAMP);
		}
		show();
	}

	function label() {
		if (!timer) return '';
		const time = clock((timer.end - Date.now()) / 1000);
		if (timer.kind === 'sleep') return t('sleepIn', { time });
		return t(timer.phase === 'work' ? 'focusWork' : 'focusBreak', { time });
	}

	function show() {
		const text = label();
		$('timer-status').textContent = text;
		$('timer-chip').textContent = text;
		$('timer-chip').hidden = !timer;
		$('timer-cancel').hidden = !timer;
		$('night-timer').textContent = text;
		buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(timer?.kind === 'sleep' && SLEEP_CHOICES[i] === sleepMinutes)));
	}

	$('sleep-start').addEventListener('click', () => startSleep(Number($('sleep-custom').value) || sleepMinutes));
	$('focus-start').addEventListener('click', startFocus);
	$('timer-cancel').addEventListener('click', () => cancel());
	$('timer-chip').addEventListener('click', () => app.showTab('timer'));
	// stopping the sound by hand ends the timer too
	app.on('play', () => { if (timer && !engine.playing) cancel(); });

	// dark screen for the bedside: nothing but a dim clock
	const night = $('night-screen');
	let nightTicker = 0;
	const nightClock = () => { $('night-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
	$('night').addEventListener('click', () => {
		night.hidden = false;
		nightClock();
		nightTicker = setInterval(nightClock, 5000);
	});
	night.addEventListener('click', () => { night.hidden = true; clearInterval(nightTicker); });
	show();
}
