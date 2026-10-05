import { describe, expect, it } from 'vitest';
import { RemotePose } from '../src/game/remotePose';
import type { CarState } from '../src/net/protocol';

// Simulates another player's car at 50 m/s (180 km/h) sending 20 Hz updates over a bad network,
// and checks the car we draw at 120 fps moves smoothly (no stutters, jumps or backwards steps).

const SPEED = 50; // m/s along +x
const SEND_MS = 50;
const FRAME_MS = 1000 / 120;
const SENDER_CLOCK = 5_000_000; // the other machine's performance.now() is unrelated to ours

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function state(n: number, sendT: number): CarState {
  const x = (SPEED * (sendT - SENDER_CLOCK)) / 1000;
  return { id: 'r', n, t: sendT, x, z: 0, h: Math.PI / 2, vx: SPEED, vz: 0, lap: 0, prog: 0, fin: 0, br: 0, nb: 0 };
}

/** Deliver updates with latency(sendTime) ms delay (may reorder), sample at 120 fps, return per-frame moves. */
function simulate(opts: { latency: (sendT: number, r: () => number) => number; loss?: number; gap?: [number, number] }) {
  const r = rng(42);
  const arrivals: { at: number; s: CarState }[] = [];
  let n = 0;
  for (let t = SENDER_CLOCK; t < SENDER_CLOCK + 10_000; t += SEND_MS) {
    const s = state(n++, t);
    if (opts.loss && r() < opts.loss) continue;
    const rel = t - SENDER_CLOCK;
    if (opts.gap && rel >= opts.gap[0] && rel < opts.gap[1]) continue;
    arrivals.push({ at: t - SENDER_CLOCK + 777 + opts.latency(t, r), s }); // our clock = sender − offset
  }
  arrivals.sort((a, b) => a.at - b.at);

  const remote = new RemotePose({ x: 0, z: 0, h: 0, vx: 0, vz: 0 });
  const moves: number[] = [];
  let next = 0;
  let lastX: number | null = null;
  for (let now = 1500; now < 10_500; now += FRAME_MS) {
    // network events fire as messages arrive, between frames
    while (next < arrivals.length && arrivals[next].at <= now) remote.push(arrivals[next].s, arrivals[next++].at);
    const x = remote.sample(now).x;
    if (lastX !== null) moves.push(x - lastX);
    lastX = x;
  }
  return moves;
}

const expected = (SPEED * FRAME_MS) / 1000; // ≈ 0.417 m per frame

function stats(moves: number[]) {
  const bad = moves.filter((m) => Math.abs(m - expected) > expected * 0.25);
  return { bad: bad.length, min: Math.min(...moves), max: Math.max(...moves) };
}

describe('remote car smoothing', () => {
  it('perfect network: every frame moves the same distance', () => {
    const s = stats(simulate({ latency: () => 40 }));
    expect(s.bad).toBe(0);
  });

  it('heavy jitter (40–120 ms, packets reordered): still no stutter', () => {
    const s = stats(simulate({ latency: (_t, r) => 40 + r() * 80 }));
    expect(s.min).toBeGreaterThan(0); // never moves backwards
    expect(s.bad).toBe(0);
  });

  it('10% packet loss on top of jitter: still smooth', () => {
    const s = stats(simulate({ latency: (_t, r) => 40 + r() * 50, loss: 0.1 }));
    expect(s.min).toBeGreaterThan(0);
    expect(s.bad).toBe(0);
  });

  it('connection gets slower mid-race (40 → 100 ms): smooth apart from a brief adjustment', () => {
    const moves = simulate({ latency: (t) => 40 + Math.min(60, Math.max(0, (t - SENDER_CLOCK - 4000) / 50)) });
    const s = stats(moves);
    expect(s.min).toBeGreaterThan(0);
    expect(s.bad / moves.length).toBeLessThan(0.02); // under 2% of frames off by >25%
  });

  it('a 300 ms dropout: car keeps moving (dead reckoning) and never jumps', () => {
    const s = stats(simulate({ latency: () => 50, gap: [5000, 5300] }));
    expect(s.min).toBeGreaterThanOrEqual(0);
    expect(s.max).toBeLessThan(expected * 3); // no teleport when updates resume
  });
});
