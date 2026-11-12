// Movement: where a layer is between its rest state (0) and its peak (1), as a pure function of
// time. The shape of one cycle is drawn by the user (16 points); "irregular" makes every cycle
// differ, up to free drifting like wind. Random parts come from a hash of the cycle number, so
// the same movement can be made periodic for a seamless loop.

export const CYCLE_POINTS = 16;

function hash(c, salt) {
	let h = (Math.imul(c | 0, 0x9e3779b1) ^ Math.imul((salt | 0) + 1, 0x85ebca6b)) >>> 0;
	h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
	h ^= h >>> 15;
	return (h >>> 0) / 4294967296;
}

const smooth = (x) => x * x * (3 - 2 * x);

function valueNoise(t, period, salt, loopSeconds) {
	let cycles = 0;
	if (loopSeconds) {
		cycles = Math.max(1, Math.round(loopSeconds / period));
		period = loopSeconds / cycles;
	}
	const x = t / period;
	const c = Math.floor(x);
	const wrap = (i) => (cycles ? ((i % cycles) + cycles) % cycles : i);
	const a = hash(wrap(c), salt), b = hash(wrap(c + 1), salt);
	return a + (b - a) * smooth(x - c);
}

/** Free drifting: slow random swells with a faster ripple on top. */
function drift(t, period, salt, loopSeconds) {
	return Math.min(1, 0.9 * valueNoise(t, period, salt + 7, loopSeconds) +
		0.28 * valueNoise(t, period / 3, salt + 13, loopSeconds));
}

/** The drawn cycle at phase p (0..1): a smooth closed curve through the points (0..100). */
export function cycleAt(cycle, p) {
	const n = cycle.length;
	const x = (((p % 1) + 1) % 1) * n;
	const i = Math.floor(x), u = x - i;
	const at = (k) => cycle[((k % n) + n) % n] / 100;
	const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
	// Catmull-Rom
	const v = p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)));
	return Math.min(1, Math.max(0, v));
}

/**
 * 0..1: how far the layer is from rest (0) towards its peak (1) at time t (seconds).
 * @param {{cycle: number[], period: number, irregular: number}} move
 */
export function moveValue(move, t, salt = 0, loopSeconds = 0) {
	const r = move.irregular;
	const wander = r * r; // share of free drifting; the rest follows the drawn cycle
	let u = 0;
	if (wander < 1) {
		let period = move.period;
		let cycles = 0;
		if (loopSeconds) {
			cycles = Math.max(1, Math.round(loopSeconds / period));
			period = loopSeconds / cycles;
		}
		const x = t / period;
		const c = Math.floor(x);
		let p = x - c;
		const wrap = (i) => (cycles ? ((i % cycles) + cycles) % cycles : i);
		let height = 1;
		if (r > 0) {
			// every cycle a little early or late in itself, and not as high as the last
			p += r * 0.11 * Math.sin(2 * Math.PI * p) * (2 * hash(wrap(c), salt + 101) - 1);
			const a = hash(wrap(c), salt), b = hash(wrap(c + 1), salt);
			height = 1 - 0.9 * r * (1 - wander) * (a + (b - a) * smooth(x - c));
		}
		u = (1 - wander) * cycleAt(move.cycle, p) * height;
	}
	if (wander > 0) u += wander * drift(t, move.period, salt, loopSeconds);
	return Math.min(1, Math.max(0, u));
}
