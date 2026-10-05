import type { Car } from '../src/game/car';
import type { Track } from '../src/game/track';

/** Corner radius (m) of the track around sample i. */
export function radiusAt(t: Track, i: number) {
  const n = t.count;
  const a = t.samples[(i - 2 + n) % n];
  const b = t.samples[(i + 2) % n];
  const turn = Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
  return (4 * t.step) / Math.max(1e-6, turn);
}

/** True when the car must brake now to make the corner it is in or one in the next ~130 m. */
export function needsBrake(t: Track, car: Car) {
  const i0 = Math.max(0, car.idx);
  for (let k = 0; k < 40; k++) {
    // corner speed v² = a·r with a margin under the tyre limit, braking distance at ~80% of full brakes
    const cornerV2 = 26 * car.grip * 0.85 * radiusAt(t, (i0 + k) % t.count);
    if (car.speed ** 2 > cornerV2 + 2 * 32 * car.grip * 0.8 * k * t.step) return true;
  }
  return false;
}
