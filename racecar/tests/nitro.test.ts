import { describe, expect, it } from 'vitest';
import { Track } from '../src/game/track';
import { Car } from '../src/game/car';
import type { Input } from '../src/input/controls';

const track = new Track();
const DT = 1 / 60;

function newCar() {
  const c = new Car();
  const g = track.gridSlot(0);
  c.reset(g.x, g.z, g.h);
  return c;
}

/** Follow the centre line; `extra` lets a test add nitro etc. */
function drive(c: Car, seconds: number, extra: Partial<Input> = {}, onStep?: (t: number) => void) {
  for (let t = 0; t < seconds; t += DT) {
    const look = track.samples[(Math.max(0, c.idx) + 8) % track.count];
    let d = Math.atan2(look.x - c.x, look.z - c.z) - c.h;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    c.step(DT, { throttle: 1, brake: 0, steer: Math.max(-1, Math.min(1, -d * 3)), ...extra }, track);
    onStep?.(t);
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

  it('fills to full within about one lap of clean driving', () => {
    const c = newCar();
    let fullAt = -1;
    drive(c, 60, {}, (t) => {
      if (fullAt < 0 && c.nitro >= 1) fullAt = t;
    });
    expect(fullAt).toBeGreaterThan(15);
    expect(fullAt).toBeLessThan(40); // a lap is ~33 s
    expect(c.nitroReady).toBe(true);
  });

  it('gives ~3 s of boost, a higher top speed, then empties', () => {
    const c = newCar();
    drive(c, 40); // fill up and reach cruising speed
    expect(c.nitroReady).toBe(true);
    const before = c.forwardSpeed;
    let boostTime = 0;
    let top = 0;
    drive(c, 5, { nitro: true }, () => {
      if (c.boosting) boostTime += DT;
      top = Math.max(top, c.forwardSpeed);
    });
    expect(boostTime).toBeGreaterThan(2.9);
    expect(boostTime).toBeLessThan(3.1);
    expect(top * 3.6).toBeGreaterThan(before * 3.6 + 15); // clearly faster than cruising
    expect(c.nitro).toBeLessThan(0.1); // drained (refilling slowly again)
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
    let soloTop = 0;
    let tuckedTop = 0;
    drive(solo, 25, {}, () => (soloTop = Math.max(soloTop, solo.forwardSpeed)));
    drive(tucked, 25, {}, () => {
      tucked.draft = 1;
      tuckedTop = Math.max(tuckedTop, tucked.forwardSpeed);
    });
    expect(tuckedTop).toBeGreaterThan(soloTop * 1.04);
    expect(tuckedTop).toBeLessThan(soloTop * 1.2); // a nudge, not a rocket
  });

  it('fills nitro faster', () => {
    const solo = newCar();
    const tucked = newCar();
    drive(solo, 8);
    drive(tucked, 8, {}, () => (tucked.draft = 1));
    expect(tucked.nitro).toBeGreaterThan(solo.nitro * 1.5);
  });
});
