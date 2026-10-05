import { ROAD_HALF, WALL, type Track } from './track';
import type { Input } from '../input/controls';

export const CAR_RADIUS = 1.7;

const MAX_SPEED = 52; // m/s on asphalt (~187 km/h)
const ACCEL = 24;
const BRAKE = 40;
const REVERSE_MAX = 12;
const GRIP = 7; // how fast sideways velocity is killed; lower = more drift
const TURN = 2.3; // rad/s at full lock
const OFFROAD_MAX = 22;

// Nitro: the bar fills with distance driven, and only a full bar can be fired
const NITRO_FILL_DIST = 1100; // metres of clean road driving for a full bar (~¾ of a lap)
const NITRO_TIME = 3; // seconds of boost from a full bar
const NITRO_SPEED = 1.25; // top speed multiplier while boosting
const NITRO_ACCEL = 1.6;
// Slipstream: following close behind another car cuts drag and fills nitro faster
const DRAFT_DRAG_CUT = 0.4;
const DRAFT_SPEED = 1.04;

/** Locally simulated car (the player's own). Remote cars are just interpolated meshes. */
export class Car {
  x = 0;
  z = 0;
  h = 0;
  vx = 0;
  vz = 0;
  idx = -1; // nearest track sample, used as search hint
  offroad = false;
  /** Strongest hit (m/s of speed lost) since the last read, for sound and camera shake. */
  impact = 0;
  /** Nitro bar 0..1 (drains while boosting). */
  nitro = 0;
  /** Seconds of boost left; > 0 while boosting. */
  boost = 0;
  /** Slipstream strength 0..1, set each step by the race from the cars ahead. */
  draft = 0;

  reset(x: number, z: number, h: number) {
    this.x = x;
    this.z = z;
    this.h = h;
    this.vx = this.vz = 0;
    this.idx = -1;
    this.nitro = 0;
    this.boost = 0;
    this.draft = 0;
  }

  get boosting(): boolean {
    return this.boost > 0;
  }

  get nitroReady(): boolean {
    return this.nitro >= 1 && !this.boosting;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /** Signed speed along the car's heading. */
  get forwardSpeed(): number {
    return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h);
  }

  step(dt: number, input: Input, track: Track) {
    const fx = Math.sin(this.h);
    const fz = Math.cos(this.h);
    const rx = fz; // car's left
    const rz = -fx;
    let vf = this.vx * fx + this.vz * fz;
    let vr = this.vx * rx + this.vz * rz;

    // Nitro: fire a full bar, then drain it over the boost
    if (input.nitro && this.nitroReady) this.boost = NITRO_TIME;
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - dt);
      this.nitro = this.boost / NITRO_TIME;
    }
    const boost = this.boosting ? 1 : 0;

    const draft = this.offroad ? 0 : this.draft;
    let maxSpeed = this.offroad ? OFFROAD_MAX : MAX_SPEED;
    maxSpeed *= 1 + (NITRO_SPEED - 1) * boost + (DRAFT_SPEED - 1) * draft;
    const accel = ACCEL * (boost ? NITRO_ACCEL : 1);

    // Throttle / brake / reverse (nitro pushes even without throttle)
    const push = Math.max(input.throttle, boost);
    if (push > 0) vf += push * accel * (1 - Math.max(0, vf) / maxSpeed) * dt;
    if (input.brake > 0) {
      if (vf > 0.5) vf -= input.brake * BRAKE * dt;
      else if (vf > -REVERSE_MAX) vf -= input.brake * ACCEL * 0.5 * dt;
    }
    // Rolling resistance, plus strong slowdown when over the off-road limit
    vf -= vf * (this.offroad ? 0.6 : 0.08 * (1 - DRAFT_DRAG_CUT * draft)) * dt;
    if (input.throttle === 0 && input.brake === 0) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 3 * dt);

    // Lateral grip
    vr *= Math.exp(-(this.offroad ? GRIP * 0.6 : GRIP) * dt);

    // Steering: needs some speed, softer at top speed, reversed when going backwards
    const speedFactor = Math.min(1, Math.abs(vf) / 8) * (1 - 0.45 * Math.min(1, Math.abs(vf) / MAX_SPEED));
    this.h -= input.steer * TURN * speedFactor * (boost ? 0.85 : 1) * Math.sign(vf) * dt;

    const nfx = Math.sin(this.h);
    const nfz = Math.cos(this.h);
    this.vx = nfx * vf + nfz * vr;
    this.vz = nfz * vf - nfx * vr;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Fill nitro with forward distance: full rate on the road, quarter on grass, faster in a slipstream
    if (!this.boosting && vf > 3) {
      const rate = (this.offroad ? 0.25 : 1) * (1 + draft);
      this.nitro = Math.min(1, this.nitro + (vf * dt * rate) / NITRO_FILL_DIST);
    }

    // Track interaction
    const p = track.project(this.x, this.z, this.idx);
    this.idx = p.idx;
    this.offroad = Math.abs(p.offset) > ROAD_HALF + 1.2;
    const limit = WALL - CAR_RADIUS * 0.6;
    if (Math.abs(p.offset) > limit) {
      const s = track.samples[p.idx];
      const side = Math.sign(p.offset);
      const push = Math.abs(p.offset) - limit;
      this.x -= s.nx * side * push;
      this.z -= s.nz * side * push;
      // remove outward velocity and scrub some speed
      const out = (this.vx * s.nx + this.vz * s.nz) * side;
      if (out > 0) {
        this.vx -= s.nx * side * out * 1.3;
        this.vz -= s.nz * side * out * 1.3;
        this.impact = Math.max(this.impact, out);
        if (!this.boosting) this.nitro = Math.max(0, this.nitro - out * 0.01);
      }
      this.vx *= 1 - 0.8 * dt;
      this.vz *= 1 - 0.8 * dt;
    }
  }

  /** Push this car out of another car's circle (the other car is not moved locally). */
  collide(ox: number, oz: number, ovx: number, ovz: number) {
    const dx = this.x - ox;
    const dz = this.z - oz;
    const d = Math.hypot(dx, dz);
    const min = CAR_RADIUS * 2;
    if (d >= min || d < 1e-4) return;
    const nx = dx / d;
    const nz = dz / d;
    // Each side resolves half the overlap on its own machine
    const push = (min - d) * 0.5 + 0.01;
    this.x += nx * push;
    this.z += nz * push;
    const rel = (this.vx - ovx) * nx + (this.vz - ovz) * nz;
    if (rel < 0) {
      this.vx -= nx * rel * 0.9;
      this.vz -= nz * rel * 0.9;
      this.impact = Math.max(this.impact, -rel);
    }
  }
}
