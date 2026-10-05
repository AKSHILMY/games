import { Net } from './peer';
import { CIRCUITS } from '../game/track';
import { COLORS, MAX_PLAYERS, type CarState, type Msg, type PlayerInfo, type RaceConfig, type ResultRow } from './protocol';

/** What the UI and race loop need from a room, whether we are the host or a guest. */
export interface Session {
  readonly isHost: boolean;
  readonly code: string;
  readonly myId: string;
  onLobby: (players: PlayerInfo[], cfg: RaceConfig, racing: boolean) => void;
  onStart: (players: PlayerInfo[], cfg: RaceConfig) => void;
  onSnap: (states: CarState[]) => void;
  onResults: (rows: ResultRow[]) => void;
  onEnd: (reason: string) => void;
  sendState(s: CarState): void;
  sendFinish(time: number): void;
  // host only
  configure(change: Partial<RaceConfig>): void;
  startRace(): void;
  backToLobby(): void;
  leave(): void;
}

const noop = () => {};

export class HostSession implements Session {
  readonly isHost = true;
  onLobby: Session['onLobby'] = noop;
  onStart: Session['onStart'] = noop;
  onSnap: Session['onSnap'] = noop;
  onResults: Session['onResults'] = noop;
  onEnd: Session['onEnd'] = noop;

  private players: PlayerInfo[] = [];
  private cfg: RaceConfig = { laps: 3, track: 0, wet: false };
  private racing = false;
  private racers = new Set<string>();
  private results: ResultRow[] = [];

  constructor(
    private net: Net,
    name: string,
  ) {
    this.players.push({ id: net.myId, name, color: COLORS[0] });
    net.onMessage = (from, msg) => this.handle(from, msg);
    net.onLeave = (id) => this.drop(id);
  }

  get code() {
    return this.net.code;
  }
  get myId() {
    return this.net.myId;
  }

  private handle(from: string, msg: Msg) {
    switch (msg.t) {
      case 'hello': {
        if (this.players.some((p) => p.id === from)) return;
        if (this.players.length >= MAX_PLAYERS) {
          this.net.send(from, { t: 'full' });
          this.net.kick(from);
          return;
        }
        const used = new Set(this.players.map((p) => p.color));
        const color = COLORS.find((c) => !used.has(c)) ?? COLORS[0];
        this.players.push({ id: from, name: cleanName(msg.name), color });
        this.pushLobby();
        break;
      }
      case 'state': {
        if (!this.racers.has(from)) return;
        // Relay straight away (not on the host's render loop) so the race keeps flowing
        // even if the host's tab is in the background.
        const s = { ...msg.s, id: from };
        this.net.broadcast({ t: 'snap', s: [s] }, from);
        this.onSnap([s]);
        break;
      }
      case 'finish':
        if (this.racers.has(from)) this.recordFinish(from, msg.time);
        break;
    }
  }

  private drop(id: string) {
    this.players = this.players.filter((p) => p.id !== id);
    this.racers.delete(id);
    this.pushLobby();
    if (this.racing) this.pushResults();
  }

  private pushLobby() {
    const msg: Msg = { t: 'lobby', players: this.players, cfg: this.cfg, racing: this.racing };
    this.net.broadcast(msg);
    this.onLobby(this.players, this.cfg, this.racing);
  }

  private recordFinish(id: string, time: number) {
    if (this.results.some((r) => r.id === id)) return;
    this.results.push({ id, time });
    this.results.sort((a, b) => a.time - b.time);
    this.pushResults();
  }

  private pushResults() {
    this.net.broadcast({ t: 'results', rows: this.results });
    this.onResults(this.results);
  }

  configure(change: Partial<RaceConfig>) {
    const c = { ...this.cfg, ...change };
    this.cfg = {
      laps: Math.max(1, Math.min(10, Math.round(c.laps) || 1)),
      track: Math.max(0, Math.min(CIRCUITS.length - 1, Math.round(c.track) || 0)),
      wet: !!c.wet,
    };
    this.pushLobby();
  }

  startRace() {
    this.racing = true;
    this.results = [];
    this.racers = new Set(this.players.map((p) => p.id));
    const msg: Msg = { t: 'start', players: this.players, cfg: this.cfg };
    this.net.broadcast(msg);
    this.onStart(this.players, this.cfg);
  }

  backToLobby() {
    this.racing = false;
    this.racers.clear();
    this.pushLobby();
  }

  sendState(s: CarState) {
    this.net.broadcast({ t: 'snap', s: [s] });
  }

  sendFinish(time: number) {
    this.recordFinish(this.myId, time);
  }

  leave() {
    this.net.destroy();
  }
}

export class GuestSession implements Session {
  readonly isHost = false;
  onLobby: Session['onLobby'] = noop;
  onStart: Session['onStart'] = noop;
  onSnap: Session['onSnap'] = noop;
  onResults: Session['onResults'] = noop;
  onEnd: Session['onEnd'] = noop;
  private closed = false;

  constructor(
    private net: Net,
    name: string,
  ) {
    net.onMessage = (_from, msg) => this.handle(msg);
    net.onLeave = () => this.end('The host left the race.');
    net.toHost({ t: 'hello', name: cleanName(name) });
  }

  get code() {
    return this.net.code;
  }
  get myId() {
    return this.net.myId;
  }

  private handle(msg: Msg) {
    switch (msg.t) {
      case 'lobby':
        return this.onLobby(msg.players, msg.cfg, msg.racing);
      case 'start':
        return this.onStart(msg.players, msg.cfg);
      case 'snap':
        return this.onSnap(msg.s);
      case 'results':
        return this.onResults(msg.rows);
      case 'full':
        return this.end('That race is full (8 players max).');
    }
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.net.destroy();
    this.onEnd(reason);
  }

  sendState(s: CarState) {
    this.net.toHost({ t: 'state', s });
  }
  sendFinish(time: number) {
    this.net.toHost({ t: 'finish', time });
  }
  configure() {}
  startRace() {}
  backToLobby() {}
  leave() {
    this.closed = true;
    this.net.destroy();
  }
}

function cleanName(name: string): string {
  return (name || 'Driver').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Driver';
}
