import { Car } from './car';
import { CarVisual } from './carModel';
import { LapCounter, type Track } from './track';
import type { Stage } from './scene';
import { readInput, type Input } from '../input/controls';
import type { CarState, PlayerInfo } from '../net/protocol';
import { rankStandings, type Standing } from './standings';
import { RemotePose, angleDiff, type Pose } from './remotePose';
import { Effects } from './effects';
import { sound } from '../audio/sound';

const STEP = 1 / 60;
const SEND_EVERY = 50; // ms → 20 Hz
const COUNTDOWN = 3000;

interface Remote {
  info: PlayerInfo;
  visual: CarVisual;
  motion: RemotePose;
  pose: Pose; // where the car is drawn this frame (also used for collisions)
  braking: boolean;
  boosting: boolean;
  latest?: CarState;
}

export type { Standing };

export interface HudInfo {
  countdown: string | null;
  banner: string | null; // "FINAL LAP", "WRONG WAY"
  lapTime: number; // ms into the current lap
  lastLap: number; // ms, 0 = none yet
  bestLap: number;
  nitro: number; // 0..1
  nitroReady: boolean;
  boosting: boolean;
  draft: number; // slipstream strength 0..1
  lap: number;
  laps: number;
  pos: number;
  total: number;
  kmh: number;
  time: number;
  finished: boolean;
  standings: Standing[];
  dots: { x: number; z: number; color: number; me: boolean }[];
}

export interface RaceHooks {
  sendState(s: CarState): void;
  sendFinish(time: number): void;
  hud(info: HudInfo): void;
}

const NO_INPUT: Input = { throttle: 0, brake: 0, steer: 0 };

export class Race {
  private car = new Car();
  private visual: CarVisual;
  private prev = { x: 0, z: 0, h: 0 }; // pose before the latest physics step, for render interpolation
  private braking = false;
  private remotes = new Map<string, Remote>();
  private laps: LapCounter;
  private startAt: number;
  private acc = 0;
  private lastSend = 0;
  private n = 0;
  private finishTime = 0;
  private me: PlayerInfo;
  private effects: Effects;
  private lastInput: Input = NO_INPUT;
  private lapStart = 0;
  private lastLap = 0;
  private bestLap = 0;
  private finalLapAt = 0; // when the "final lap" banner started
  private wrongWayFor = 0;
  private lastCount = '';
  private wasReady = false;
  private readyFlashAt = 0;

  constructor(
    private stage: Stage,
    private track: Track,
    myId: string,
    players: PlayerInfo[],
    private totalLaps: number,
    private hooks: RaceHooks,
  ) {
    this.laps = new LapCounter(track.count);
    this.me = players.find((p) => p.id === myId) ?? { id: myId, name: 'You', color: 0xffffff };

    const slot = Math.max(0, players.findIndex((p) => p.id === myId));
    const g = track.gridSlot(slot);
    this.car.reset(g.x, g.z, g.h);
    this.laps.reset(track.project(g.x, g.z).idx);

    this.visual = new CarVisual(this.me.color);
    this.visual.setShadows(stage.shadows);
    stage.scene.add(this.visual.group);
    this.prev = { x: g.x, z: g.z, h: g.h };

    players.forEach((p, i) => {
      if (p.id === myId) return;
      const gs = track.gridSlot(i);
      const visual = new CarVisual(p.color, p.name);
      visual.setShadows(stage.shadows);
      visual.update(0, gs.x, gs.z, gs.h, false);
      stage.scene.add(visual.group);
      const pose = { x: gs.x, z: gs.z, h: gs.h, vx: 0, vz: 0 };
      this.remotes.set(p.id, { info: p, visual, motion: new RemotePose(pose), pose, braking: false, boosting: false });
    });

    this.effects = new Effects(track);
    stage.scene.add(this.effects.group);

    this.startAt = performance.now() + COUNTDOWN + 500;
    this.visual.update(0, g.x, g.z, g.h, false);
    stage.follow(g.x, g.z, g.h, 0, 0, true);
  }

  /** Remote car states from the network (may include our own, which is ignored). */
  receive(states: CarState[]) {
    const now = performance.now();
    for (const s of states) {
      const r = this.remotes.get(s.id);
      if (!r || !r.motion.push(s, now)) continue;
      r.latest = s;
      r.braking = !!s.br;
      r.boosting = !!s.nb;
    }
  }

  /**
   * Slipstream strength 0..1 from the best-placed car ahead: strongest when right behind
   * (4 m) and lined up, fading out by 30 m back or 3 m to the side.
   */
  private slipstream(): number {
    const c = this.car;
    if (c.forwardSpeed < 15) return 0;
    const fx = Math.sin(c.h);
    const fz = Math.cos(c.h);
    let best = 0;
    for (const r of this.remotes.values()) {
      const p = r.pose;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const ahead = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (ahead < 4 || ahead > 30 || side > 3) continue;
      if (p.vx * fx + p.vz * fz < 10) continue; // they must be moving the same way
      best = Math.max(best, (1 - (ahead - 4) / 26) * (1 - side / 3));
    }
    return best;
  }

  /** Switch every car between real shadows and cheap blob shadows. */
  setShadows(on: boolean) {
    this.visual.setShadows(on);
    for (const r of this.remotes.values()) r.visual.setShadows(on);
  }

  /** A player left mid-race: remove their car. */
  removePlayer(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.visual.dispose(this.stage.scene);
    this.remotes.delete(id);
  }

  update(dt: number) {
    const now = performance.now();
    const racing = now >= this.startAt;
    const elapsed = racing ? now - this.startAt : 0;

    this.interpolateRemotes(now, dt);

    // Fixed-step physics
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      let input = racing ? readInput() : NO_INPUT;
      if (this.finishTime) input = { throttle: 0, brake: 0.2, steer: 0 };
      this.lastInput = input;
      this.braking = input.brake > 0 && this.car.forwardSpeed > 0.5;
      this.prev = { x: this.car.x, z: this.car.z, h: this.car.h };
      const wasBoosting = this.car.boosting;
      this.car.draft += (this.slipstream() - this.car.draft) * (1 - Math.exp(-4 * STEP));
      this.car.step(STEP, input, this.track);
      if (this.car.boosting && !wasBoosting) {
        sound.whoosh();
        this.stage.shake(0.25);
      }
      for (const r of this.remotes.values()) this.car.collide(r.pose.x, r.pose.z, r.pose.vx, r.pose.vz);
    }

    const lapBefore = this.laps.lap;
    this.laps.update(this.car.idx);
    if (this.laps.lap > lapBefore && racing) {
      const t = elapsed - this.lapStart;
      this.lastLap = t;
      this.bestLap = this.bestLap ? Math.min(this.bestLap, t) : t;
      this.lapStart = elapsed;
      if (this.laps.lap === this.totalLaps - 1 && this.totalLaps > 1) this.finalLapAt = now;
    }
    if (!this.finishTime && this.laps.lap >= this.totalLaps) {
      this.finishTime = Math.max(1, Math.round(elapsed));
      this.hooks.sendFinish(this.finishTime);
      sound.fanfare();
    }

    // Wrong way: moving against the track direction for over a second
    const ts = this.track.samples[Math.max(0, this.car.idx)];
    const along = this.car.vx * ts.tx + this.car.vz * ts.tz;
    this.wrongWayFor = racing && !this.finishTime && along < -3 ? this.wrongWayFor + dt : 0;

    // Nitro just became full: chime + flash
    const ready = this.car.nitroReady && racing && !this.finishTime;
    if (ready && !this.wasReady) {
      sound.chime();
      this.readyFlashAt = now;
    }
    this.wasReady = ready;

    // Hits shake the camera and thud
    if (this.car.impact > 0) {
      this.stage.shake(Math.min(1, this.car.impact / 12));
      sound.impact(this.car.impact);
      this.car.impact = 0;
    }

    if (now - this.lastSend >= SEND_EVERY) {
      this.lastSend = now;
      this.hooks.sendState(this.state());
    }

    // Draw the car between the last two physics steps so motion is smooth at any refresh rate
    const a = this.acc / STEP;
    const x = this.prev.x + (this.car.x - this.prev.x) * a;
    const z = this.prev.z + (this.car.z - this.prev.z) * a;
    const h = this.prev.h + angleDiff(this.prev.h, this.car.h) * a;
    this.visual.update(dt, x, z, h, this.braking, this.car.boosting);
    this.stage.follow(x, z, h, this.car.speed, dt, false, this.car.boosting);

    const cars = [{ id: this.me.id, visual: this.visual, x, z, h }];
    for (const [id, r] of this.remotes) cars.push({ id, visual: r.visual, x: r.pose.x, z: r.pose.z, h: r.pose.h });
    this.effects.update(dt, cars, this.stage.pointScale());

    sound.engineOn(true);
    sound.drive(this.car.forwardSpeed, Math.max(this.lastInput.throttle, this.car.boosting ? 1 : 0), this.visual.slide, this.car.boosting);
    this.hooks.hud(this.hudInfo(now, elapsed));
  }

  private state(): CarState {
    const c = this.car;
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      id: this.me.id,
      n: this.n++,
      t: Math.round(performance.now()),
      x: r(c.x),
      z: r(c.z),
      h: r(c.h),
      vx: r(c.vx),
      vz: r(c.vz),
      lap: this.laps.lap,
      prog: Math.round((this.laps.idx / this.track.count) * 1e4) / 1e4,
      fin: this.finishTime,
      br: this.braking ? 1 : 0,
      nb: this.car.boosting ? 1 : 0,
    };
  }

  private interpolateRemotes(now: number, dt: number) {
    for (const r of this.remotes.values()) {
      const p = r.motion.sample(now);
      r.visual.update(dt, p.x, p.z, p.h, r.braking, r.boosting);
    }
  }

  private hudInfo(now: number, elapsed: number): HudInfo {
    const list: Standing[] = [
      { id: this.me.id, name: this.me.name, color: this.me.color, progress: this.laps.progress, fin: this.finishTime },
    ];
    for (const r of this.remotes.values()) {
      const s = r.latest;
      list.push({
        id: r.info.id,
        name: r.info.name,
        color: r.info.color,
        progress: s ? s.lap + s.prog : 0,
        fin: s?.fin ?? 0,
      });
    }
    const standings = rankStandings(list);

    const left = this.startAt - now;
    let countdown: string | null = null;
    if (left > 0) countdown = left > COUNTDOWN ? '' : String(Math.ceil(left / 1000));
    else if (left > -900) countdown = 'GO!';
    if (countdown && countdown !== this.lastCount) sound.beep(countdown === 'GO!');
    this.lastCount = countdown ?? '';

    let banner: string | null = null;
    if (this.wrongWayFor > 1) banner = 'WRONG WAY';
    else if (this.finalLapAt && now - this.finalLapAt < 2500) banner = 'FINAL LAP';
    else if (this.readyFlashAt && now - this.readyFlashAt < 1300 && !this.car.boosting) banner = 'NITRO READY';

    const dots = [...this.remotes.values()].map((r) => ({ x: r.pose.x, z: r.pose.z, color: r.info.color, me: false }));
    dots.push({ x: this.car.x, z: this.car.z, color: this.me.color, me: true });

    return {
      countdown,
      banner,
      lapTime: this.finishTime ? 0 : Math.max(0, elapsed - this.lapStart),
      lastLap: this.lastLap,
      bestLap: this.bestLap,
      nitro: this.car.nitro,
      nitroReady: this.car.nitroReady && !this.finishTime,
      boosting: this.car.boosting,
      draft: this.car.draft,
      lap: Math.min(this.laps.lap + 1, this.totalLaps),
      laps: this.totalLaps,
      pos: standings.findIndex((s) => s.id === this.me.id) + 1,
      total: standings.length,
      kmh: Math.round(Math.abs(this.car.forwardSpeed) * 3.6),
      time: this.finishTime || elapsed,
      finished: !!this.finishTime,
      standings,
      dots,
    };
  }

  dispose() {
    sound.engineOn(false);
    this.effects.dispose(this.stage.scene);
    this.visual.dispose(this.stage.scene);
    for (const r of this.remotes.values()) r.visual.dispose(this.stage.scene);
    this.remotes.clear();
  }
}
