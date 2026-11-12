// "Share" tab: the link, its QR code, and files.

import { presetToUrl, presetToJson, presetFromJson } from '../codec.js';
import { renderLoop, encodeWav } from '../audio/wav.js';
import { PUBLIC_URL } from '../config.js';
import { t } from '../strings.js';
import { $, download, fileName } from '../util.js';
import qrcode from '../../vendor/qrcode/qrcode.mjs';

function qrSvg(text) {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	let d = '';
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

export function initShare(app) {
	const base = PUBLIC_URL || location.origin + location.pathname;
	const link = $('link');
	let dirty = true;

	function render() {
		if (!dirty || app.tab !== 'share') return;
		dirty = false;
		link.value = presetToUrl(app.preset, base);
		$('qr').innerHTML = qrSvg(link.value); // built here from module coordinates only
		const host = new URL(base).hostname;
		const local = !PUBLIC_URL && (/\.(home|lan|local|internal)$|^localhost$|^[\d.]+$|\.ts\.net$/.test(host));
		$('link-note').hidden = !local;
		$('link-note').textContent = t('localLinkNote', { host });
	}
	app.on('preset', () => { dirty = true; render(); });
	app.on('tab', render);

	link.addEventListener('focus', () => link.select());
	$('copy').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(link.value);
			app.toast(t('linkCopied'));
		} catch {
			link.select();
			app.toast(document.execCommand?.('copy') ? t('linkCopied') : t('copyFailed'));
		}
	});
	if (navigator.share) {
		$('share-native').hidden = false;
		$('share-native').addEventListener('click', () => {
			navigator.share({ title: t('shareTitle', { name: app.preset.name || t('untitled') }), url: link.value }).catch(() => {});
		});
	}

	$('export-json').addEventListener('click', () => {
		download(fileName(app.preset.name) + '.murmur.json', new Blob([presetToJson(app.preset)], { type: 'application/json' }));
	});
	$('import-json').addEventListener('click', () => $('import-file').click());
	$('import-file').addEventListener('change', async (e) => {
		const file = e.target.files[0];
		e.target.value = '';
		if (!file) return;
		try {
			if (file.size > 200000) throw new Error(t('errCorrupt'));
			const preset = presetFromJson(await file.text());
			app.setPreset(preset, { selected: 0 });
			app.toast(t('importOk', { name: preset.name || t('untitled') }));
		} catch (err) {
			app.toast(app.errorText(err), 7000);
		}
	});

	$('export-wav').addEventListener('click', async () => {
		const button = $('export-wav'), status = $('wav-status');
		button.disabled = true;
		try {
			const loop = await renderLoop(app.preset, Number($('wav-seconds').value), 48000,
				(f) => { status.textContent = t('wavRendering', { pct: Math.round(f * 100) }); });
			const wav = encodeWav(loop);
			const name = fileName(app.preset.name) + '.wav';
			download(name, new Blob([wav], { type: 'audio/wav' }));
			status.textContent = t('wavDone', { name, mb: (wav.length / 1e6).toFixed(1) });
		} catch (err) {
			status.textContent = String(err?.message || err);
		} finally {
			button.disabled = false;
		}
	});
}
