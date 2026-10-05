// Wire format shared by host and guests. All messages are small JSON objects.

export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
}

/** One car's state as sent over the network. */
export interface CarState {
  id: string;
  n: number; // per-car sequence number, lets receivers drop stale/duplicate updates
  t: number; // sender's clock (ms) when sent, lets receivers replay motion without network jitter
  x: number;
  z: number;
  h: number; // heading (radians)
  vx: number;
  vz: number;
  lap: number;
  prog: number; // 0..1 along the track
  fin: number; // finish time in ms, 0 while racing
  br: number; // 1 while braking (brake lights)
  nb: number; // 1 while boosting (exhaust flames)
}

export interface ResultRow {
  id: string;
  time: number; // ms, 0 = did not finish
}

export type Msg =
  // guest → host
  | { t: 'hello'; name: string }
  | { t: 'state'; s: CarState }
  | { t: 'finish'; time: number }
  // host → guests
  | { t: 'lobby'; players: PlayerInfo[]; laps: number; racing: boolean }
  | { t: 'start'; laps: number; players: PlayerInfo[] }
  | { t: 'snap'; s: CarState[] }
  | { t: 'results'; rows: ResultRow[] }
  | { t: 'full' };

/** Messages that go over the unordered, low-latency channel. */
export function isStateMsg(m: Msg): boolean {
  return m.t === 'state' || m.t === 'snap';
}

export const MAX_PLAYERS = 8;
export const COLORS = [0xe63946, 0x1d8cf8, 0xffb703, 0x2ec27e, 0x9b5de5, 0xf15bb5, 0x00c2c7, 0xf77f00];
