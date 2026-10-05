import { describe, expect, it } from 'vitest';
import { rankStandings, type Standing } from '../src/game/standings';

const s = (id: string, progress: number, fin = 0): Standing => ({ id, name: id, color: 0, progress, fin });
const order = (list: Standing[]) => rankStandings(list).map((x) => x.id);

describe('rankStandings', () => {
  it('orders racers by distance covered', () => {
    expect(order([s('a', 0.5), s('b', 1.2), s('c', 0.9)])).toEqual(['b', 'c', 'a']);
  });

  it('a car a lap ahead beats one further round the current lap', () => {
    expect(order([s('lapped', 0.95), s('leader', 1.05)])).toEqual(['leader', 'lapped']);
  });

  it('finishers come first, ordered by finish time', () => {
    expect(order([s('racing', 2.9), s('second', 3.1, 70500), s('first', 3.0, 69000)])).toEqual([
      'first',
      'second',
      'racing',
    ]);
  });

  it('a finisher stays ahead even if the other car has more raw progress', () => {
    // after finishing a car brakes; a car still racing can have higher progress numerically
    expect(order([s('fin', 3.0, 60000), s('late', 3.4)])).toEqual(['fin', 'late']);
  });

  it('does not mutate the input', () => {
    const list = [s('a', 0.1), s('b', 0.2)];
    rankStandings(list);
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
