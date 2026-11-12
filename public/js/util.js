// Small helpers shared by the UI modules.

export const $ = (id) => document.getElementById(id);

/** Element builder: h('button', { class: 'btn', onclick: fn }, 'text', child, ...). */
export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === false || v == null) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	el.append(...children.filter((c) => c != null));
	return el;
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
	get(key, fallback = null) {
		try {
			const v = localStorage.getItem('murmur.' + key);
			return v == null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try { localStorage.setItem('murmur.' + key, JSON.stringify(value)); } catch { /* not kept, fine */ }
	},
};

export function download(name, blob) {
	const url = URL.createObjectURL(blob);
	const a = h('a', { href: url, download: name });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const fileName = (name) => (name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'murmur');

/** 754 -> "12:34", 4000 -> "1:06:40" */
export function clock(seconds) {
	seconds = Math.max(0, Math.ceil(seconds));
	const hh = Math.floor(seconds / 3600), mm = Math.floor((seconds % 3600) / 60), ss = seconds % 60;
	return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm)) + ':' + String(ss).padStart(2, '0');
}

const STOPS = [[-9, [176, 110, 58]], [-6, [209, 150, 88]], [-3, [229, 143, 177]], [0, [226, 230, 240]], [3, [127, 178, 255]], [6, [176, 140, 255]], [9, [205, 125, 255]]];
/** The colour of a noise colour: brown is amber, pink pink, white white, blue blue, violet violet. */
export function slopeColor(slope) {
	const s = Math.min(9, Math.max(-9, slope));
	let i = 0;
	while (i < STOPS.length - 2 && s > STOPS[i + 1][0]) i++;
	const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1];
	const u = (s - a) / (b - a);
	return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * u)).join(', ')})`;
}
