export interface Standing {
  id: string;
  name: string;
  color: number;
  progress: number; // laps completed + fraction of current lap
  fin: number; // finish time in ms, 0 while racing
}

/** Race order: finishers first by finish time, then everyone else by distance covered. */
export function rankStandings(list: Standing[]): Standing[] {
  return [...list].sort((a, b) => {
    if (a.fin && b.fin) return a.fin - b.fin;
    if (a.fin || b.fin) return a.fin ? -1 : 1;
    return b.progress - a.progress;
  });
}
