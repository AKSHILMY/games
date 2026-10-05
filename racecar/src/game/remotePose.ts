import type { CarState } from '../net/protocol';

export const INTERP_DELAY = 100; // ms that remote cars are drawn in the past (absorbs network jitter)
const MAX_EXTRAPOLATE = 0.25; // s of dead reckoning if updates stop arriving
const OFFSET_CREEP = 0.5; // ms per update the target offset may rise (follows a slowing connection)
const MAX_WARP = 0.08; // playback may run at most 8% fast/slow while catching up with offset changes
const WARMUP = 10; // updates during which the offset snaps instead of easing

interface Snap {
  t: number; // sender's clock
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
}

export interface Pose {
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
}

/**
 * Smooth playback of another player's car from 20 Hz network updates.
 * Each update is placed on our timeline by the sender's own timestamp (not arrival time),
 * so network jitter doesn't become jerky motion; we then draw slightly in the past and
 * interpolate between the two surrounding updates.
 */
export class RemotePose {
  private buf: Snap[] = [];
  private lastN = -1;
  private target = Infinity; // local − sender time, smallest seen ≈ fastest one-way trip
  private offset = Infinity; // offset actually used for playback, eases towards target
  private received = 0;
  private lastSample = 0;

  constructor(private pose: Pose) {}

  /** Returns false for stale or duplicate updates. */
  push(s: CarState, now: number): boolean {
    if (s.n <= this.lastN) return false;
    this.lastN = s.n;
    this.target = Math.min(now - s.t, this.target + OFFSET_CREEP);
    if (++this.received <= WARMUP) this.offset = this.target;
    this.buf.push({ t: s.t, x: s.x, z: s.z, h: s.h, vx: s.vx, vz: s.vz });
    if (this.buf.length > 30) this.buf.shift();
    return true;
  }

  /** Pose to draw at local time `now`. */
  sample(now: number): Pose {
    const b = this.buf;
    if (!b.length) return this.pose;
    // Ease the playback offset towards the target by briefly running a little fast or slow,
    // so a change in network delay never makes the car jump.
    const elapsed = Math.min(100, Math.max(0, now - this.lastSample));
    this.lastSample = now;
    const step = elapsed * MAX_WARP;
    this.offset += Math.max(-step, Math.min(step, this.target - this.offset));
    const t = now - INTERP_DELAY - this.offset; // render time on the sender's clock
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > t) i--;
    const p = this.pose;
    if (i > 0 && b[i].t >= t && b[i - 1].t <= t) {
      const a = b[i - 1];
      const c = b[i];
      const k = (t - a.t) / Math.max(1, c.t - a.t);
      p.x = a.x + (c.x - a.x) * k;
      p.z = a.z + (c.z - a.z) * k;
      p.h = a.h + angleDiff(a.h, c.h) * k;
      p.vx = c.vx;
      p.vz = c.vz;
    } else {
      // Past the newest update: dead-reckon briefly; before the oldest: hold it
      const last = t > b[b.length - 1].t ? b[b.length - 1] : b[0];
      const ex = Math.min(MAX_EXTRAPOLATE, Math.max(0, (t - last.t) / 1000));
      p.x = last.x + last.vx * ex;
      p.z = last.z + last.vz * ex;
      p.h = last.h;
      p.vx = last.vx;
      p.vz = last.vz;
    }
    return p;
  }
}

export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
