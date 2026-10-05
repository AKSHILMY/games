import { describe, expect, it } from 'vitest';
import { Track, LapCounter } from '../src/game/track';
import { Car } from '../src/game/car';
import { rankStandings, type Standing } from '../src/game/standings';

// Drives real Car physics + LapCounter around the real track with a simple autopilot,
// then checks positions, lap counting, finish order and speed stats.

const track = new Track();
const DT = 1 / 60;

interface Racer {
  id: string;
  car: Car;
  laps: LapCounter;
  power: number; // throttle cap, makes cars differ in pace
  lane: number; // lateral offset of the autopilot's line, so cars can pass each other
  fin: number;
  lapTimes: number[];
  maxKmh: number;
}

function makeRacer(id: string, slot: number, power: number, lane = 0): Racer {
  const car = new Car();
  const g = track.gridSlot(slot);
  car.reset(g.x, g.z, g.h);
  const laps = new LapCounter(track.count);
  laps.reset(track.project(g.x, g.z).idx);
  return { id, car, laps, power, lane, fin: 0, lapTimes: [], maxKmh: 0 };
}

function autopilot(c: Car, power: number, lane: number) {
  const look = track.samples[(Math.max(0, c.idx) + 8) % track.count];
  const tx = look.x + look.nx * lane;
  const tz = look.z + look.nz * lane;
  let d = Math.atan2(tx - c.x, tz - c.z) - c.h;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const steer = Math.max(-1, Math.min(1, -d * 3));
  return { throttle: Math.abs(d) > 0.35 && c.speed > 30 ? 0 : power, brake: 0, steer };
}

function runRace(
  racers: Racer[],
  totalLaps: number,
  onTick?: (t: number, order: string[]) => void,
  contact = true,
) {
  let t = 0;
  while (t < 400 && racers.some((r) => !r.fin)) {
    for (const r of racers) {
      const input = r.fin ? { throttle: 0, brake: 0.2, steer: 0 } : autopilot(r.car, r.power, r.lane);
      const before = r.laps.lap;
      r.car.step(DT, input, track);
      if (contact) for (const o of racers) if (o !== r) r.car.collide(o.car.x, o.car.z, o.car.vx, o.car.vz);
      r.laps.update(r.car.idx);
      if (r.laps.lap > before) r.lapTimes.push(t);
      if (!r.fin && r.laps.lap >= totalLaps) r.fin = Math.round(t * 1000);
      r.maxKmh = Math.max(r.maxKmh, Math.abs(r.car.forwardSpeed) * 3.6);
    }
    t += DT;
    const list: Standing[] = racers.map((r) => ({ id: r.id, name: r.id, color: 0, progress: r.laps.progress, fin: r.fin }));
    onTick?.(t, rankStandings(list).map((x) => x.id));
  }
  return t;
}

describe('race simulation', () => {
  it('a single car accelerates, hits a sensible top speed and counts laps', () => {
    const r = makeRacer('solo', 0, 1);
    let kmhAt3s = 0;
    runRace([r], 2, (t) => {
      if (Math.abs(t - 3) < DT / 2) kmhAt3s = Math.abs(r.car.forwardSpeed) * 3.6;
    });
    expect(kmhAt3s).toBeGreaterThan(100); // 0→100+ km/h in 3 s
    expect(r.maxKmh).toBeGreaterThan(140);
    expect(r.maxKmh).toBeLessThan(190); // MAX_SPEED cap ~187 km/h
    expect(r.lapTimes).toHaveLength(2);
    const lap1 = r.lapTimes[0];
    const lap2 = r.lapTimes[1] - r.lapTimes[0];
    expect(lap1).toBeGreaterThan(20);
    expect(lap1).toBeLessThan(60);
    expect(Math.abs(lap2 - lap1)).toBeLessThan(5); // consistent lap times
    expect(r.fin).toBe(Math.round(r.lapTimes[1] * 1000));
  });

  it('faster cars finish ahead and positions are tracked during the race', () => {
    // slowest car starts on pole, one row ahead of the others, so it has to be overtaken
    // (grid slots 0/1 share a row, 2/3 the next, ...)
    // The autopilot can't steer around other cars, so contact is off here; collisions are tested separately.
    const slow = makeRacer('slow', 0, 0.5);
    const mid = makeRacer('mid', 2, 0.75);
    const fast = makeRacer('fast', 4, 1);
    const racers = [slow, mid, fast];
    const orderAt = new Map<number, string[]>();
    runRace(
      racers,
      2,
      (t, order) => {
        const sec = Math.round(t);
        if (Math.abs(t - sec) < DT / 2) orderAt.set(sec, order);
      },
      false,
    );

    // At the start the pole-sitter leads
    expect(orderAt.get(1)?.[0]).toBe('slow');
    // By the end of the race everyone finished, fastest first
    for (const r of racers) expect(r.fin).toBeGreaterThan(0);
    expect(fast.fin).toBeLessThan(mid.fin);
    expect(mid.fin).toBeLessThan(slow.fin);
    const finalOrder = rankStandings(
      racers.map((r) => ({ id: r.id, name: r.id, color: 0, progress: r.laps.progress, fin: r.fin })),
    ).map((x) => x.id);
    expect(finalOrder).toEqual(['fast', 'mid', 'slow']);
    // Leader at the 1-lap mark is already the fast car
    const t1 = Math.round(fast.lapTimes[0]);
    expect(orderAt.get(t1 + 1)?.[0]).toBe('fast');
  });

  it('driving backwards over the line does not count a lap', () => {
    const r = makeRacer('cheat', 0, 1);
    // Start at the line and reverse across it, then drive forwards across it again
    const s0 = track.samples[2];
    r.car.reset(s0.x, s0.z, Math.atan2(s0.tx, s0.tz));
    r.laps.reset(2);
    for (let i = 0; i < 180; i++) {
      r.car.step(DT, { throttle: 0, brake: 1, steer: 0 }, track);
      r.laps.update(r.car.idx);
    }
    expect(r.car.idx).toBeGreaterThan(track.count * 0.9); // went behind the line
    for (let i = 0; i < 300; i++) {
      r.car.step(DT, { throttle: 1, brake: 0, steer: 0 }, track);
      r.laps.update(r.car.idx);
    }
    expect(r.car.idx).toBeLessThan(track.count * 0.1); // back in front of the line
    expect(r.laps.lap).toBe(0);
  });

  it('cars collide instead of driving through each other', () => {
    // fast car directly behind a slow one (grid slots 0 and 2 are on the same side)
    const slow = makeRacer('slow', 0, 0.4);
    const fast = makeRacer('fast', 2, 1);
    let minGap = Infinity;
    runRace([slow, fast], 1, () => {
      minGap = Math.min(minGap, Math.hypot(slow.car.x - fast.car.x, slow.car.z - fast.car.z));
    });
    // centres never get much closer than two car radii (3.4 m)
    expect(minGap).toBeGreaterThan(2.8);
    // and both still finish
    expect(slow.fin && fast.fin).toBeTruthy();
  });

  it('cars stay within the barriers', () => {
    const r = makeRacer('wall', 0, 1);
    let worst = 0;
    runRace([r], 1, () => {
      worst = Math.max(worst, Math.abs(track.project(r.car.x, r.car.z, r.car.idx).offset));
    });
    expect(worst).toBeLessThan(13);
  });
});
