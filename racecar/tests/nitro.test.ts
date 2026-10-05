import { describe, expect, it } from 'vitest';
import { Track } from '../src/game/track';
import { Car } from '../src/game/car';
import type { Input } from '../src/input/controls';
import { needsBrake } from './driver';

const track = new Track();
const DT = 1 / 60;

function newCar() {
  const c = new Car();
  const g = track.gridSlot(0);
  c.reset(g.x, g.z, g.h);
  return c;
}

/** Follow the centre line, braking for corners; `extra` lets a test add nitro etc. */
function drive(c: Car, seconds: number, extra: Partial<Input> = {}, onStep?: (t: number) => void) {
  for (let t = 0; t < seconds; t += DT) {
    const look = track.samples[(Math.max(0, c.idx) + 8) % track.count];
    let d = Math.atan2(look.x - c.x, look.z - c.z) - c.h;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const brake = needsBrake(track, c) ? 1 : 0;
    c.step(DT, { throttle: 1 - brake, brake, steer: Math.max(-1, Math.min(1, -d * 3)), ...extra }, track);
    onStep?.(t);
  }
}

/** Straight-line running: the car is held on one spot of the start straight, so only speed changes. */
function cruise(c: Car, seconds: number, input: Partial<Input>, onStep?: () => void) {
  const s = track.samples[track.count - 40];
  const h = Math.atan2(s.tx, s.tz);
  for (let t = 0; t < seconds; t += DT) {
    onStep?.();
    c.x = s.x;
    c.z = s.z;
    c.h = h;
    c.step(DT, { throttle: 0, brake: 0, steer: 0, ...input }, track);
  }
}

describe('nitro', () => {
  it('starts empty and cannot be fired until full', () => {
    const c = newCar();
    expect(c.nitro).toBe(0);
    drive(c, 5, { nitro: true });
    expect(c.boosting).toBe(false);
    expect(c.nitro).toBeGreaterThan(0.05);
    expect(c.nitro).toBeLessThan(1);
  });

  it('fills to full within about half a lap of clean driving', () => {
    const c = newCar();
    let fullAt = -1;
    drive(c, 60, {}, (t) => {
      if (fullAt < 0 && c.nitro >= 1) fullAt = t;
    });
    expect(fullAt).toBeGreaterThan(12);
    expect(fullAt).toBeLessThan(26); // a lap is ~36 s
    expect(c.nitroReady).toBe(true);
  });

  it('gives ~3 s of boost and then empties', () => {
    const c = newCar();
    drive(c, 40); // fill up
    expect(c.nitroReady).toBe(true);
    let boostTime = 0;
    drive(c, 5, { nitro: true }, () => {
      if (c.boosting) boostTime += DT;
    });
    expect(boostTime).toBeGreaterThan(2.9);
    expect(boostTime).toBeLessThan(3.1);
    expect(c.nitro).toBeLessThan(0.2); // drained (2 s of refilling since)
  });

  it('lifts top speed to ~290 km/h, and the extra speed fades slowly, not all at once', () => {
    const c = newCar();
    cruise(c, 40, { throttle: 1 });
    const top = c.forwardSpeed * 3.6;
    expect(top).toBeGreaterThan(245);
    expect(top).toBeLessThan(251); // 250 km/h top speed
    c.nitro = 1;
    cruise(c, 3, { throttle: 1, nitro: true });
    const boosted = c.forwardSpeed * 3.6;
    expect(boosted).toBeGreaterThan(top + 15);
    // Still on the throttle: drag only bleeds the extra speed off gradually
    cruise(c, 2, { throttle: 1 });
    expect(c.forwardSpeed * 3.6).toBeGreaterThan(boosted - 15);
    expect(c.forwardSpeed * 3.6).toBeGreaterThan(top + 5);
    // Braking still scrubs it off fast
    cruise(c, 1, { brake: 1 });
    expect(c.forwardSpeed * 3.6).toBeLessThan(top - 60);
  });

  it('fills much slower on the grass', () => {
    const road = newCar();
    drive(road, 6);
    const grass = newCar();
    // force off-road: same driving but flagged as off the track each step
    for (let t = 0; t < 6; t += DT) {
      grass.step(DT, { throttle: 1, brake: 0, steer: 0 }, track);
      grass.offroad = true;
    }
    expect(grass.nitro).toBeLessThan(road.nitro * 0.5);
  });
});

describe('slipstream', () => {
  it('a car in a slipstream reaches a higher top speed', () => {
    const solo = newCar();
    const tucked = newCar();
    cruise(solo, 40, { throttle: 1 });
    cruise(tucked, 40, { throttle: 1 }, () => (tucked.draft = 1));
    expect(tucked.forwardSpeed).toBeGreaterThan(solo.forwardSpeed * 1.05);
    expect(tucked.forwardSpeed).toBeLessThan(solo.forwardSpeed * 1.2); // a nudge, not a rocket
  });

  it('fills nitro faster', () => {
    const solo = newCar();
    const tucked = newCar();
    drive(solo, 8);
    drive(tucked, 8, {}, () => (tucked.draft = 1));
    expect(tucked.nitro).toBeGreaterThan(solo.nitro * 1.5);
  });
});
