import { BY_ID, computeModifiers, isUnlocked } from './sim/evolutions';
import { SEASON_TICKS } from './sim/weather';
import { SCENARIOS } from './sim/world';
import type { District, WorldState } from './sim/types';

export const SAVE_KEY = 'chernoe-nebo.save.v1';
export const RECORD_KEY = 'chernoe-nebo.record.v1';

export interface SavedGame {
  version: 1;
  scenario: string;
  savedAt: number;
  state: WorldState;
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  number(v, min, max) && Number.isInteger(v);

/** Saves are untrusted input: validate every field used by the simulation. */
export function decodeSave(raw: string, districts: Record<string, District>): SavedGame | null {
  try {
    const save: unknown = JSON.parse(raw);
    if (!object(save) || save.version !== 1 || !number(save.savedAt)
      || !SCENARIOS.some((s) => s.id === save.scenario) || !object(save.state)) return null;
    const s = save.state;
    const ids = Object.keys(districts);
    if (!Array.isArray(s.ids) || s.ids.length !== ids.length
      || new Set(s.ids).size !== ids.length || !s.ids.every((id) => ids.includes(id))
      || !object(s.districts) || Object.keys(s.districts).length !== ids.length) return null;
    let total = 0;
    for (const id of ids) {
      const d = s.districts[id];
      if (!object(d) || !number(d.F, 0, 1) || !number(d.B, 0, 1)
        || !number(d.smoke, 0, 1) || !number(d.minLine, 0, 1)
        || !number(d.burned) || !number(d.S)
        || typeof d.known !== 'boolean' || typeof d.ignited !== 'boolean') return null;
      total += d.burned;
    }
    if (!integer(s.tick, 0, SEASON_TICKS - 1) || !integer(s.rng, -2147483648, 4294967295)
      || !number(s.sparks) || !number(s.totalBurned) || Math.abs(s.totalBurned - total) > 0.01
      || !integer(s.escalation, 0, 5) || !integer(s.throws) || !integer(s.throwCooldown, 0, 8)
      || s.status !== 'running' || s.grade !== null
      || (s.focus !== null && !ids.includes(s.focus as string))) return null;
    if (!Array.isArray(s.bought) || new Set(s.bought).size !== s.bought.length
      || !s.bought.every((id) => typeof id === 'string' && Object.hasOwn(BY_ID, id)
        && isUnlocked(id, s.bought as string[]))) return null;
    const w = s.weather;
    if (!object(w) || !number(w.windDir, -1e6, 1e6) || !number(w.targetDir, -1e6, 1e6)
      || !number(w.W, 0, 2) || !number(w.targetW, 0, 2) || !number(w.D, 0, 2)
      || !integer(w.eventTicks, 0, SEASON_TICKS) || !integer(w.nextShift)
      || ![null, 'storm', 'squall', 'rain', 'cyclone'].includes(w.event as string | null)) return null;
    if (!object(s.flags) || !Object.values(s.flags).every((v) => typeof v === 'boolean')
      || !Array.isArray(s.events) || s.events.length > 10000
      || !s.events.every((e) => object(e) && integer(e.tick, 0, s.tick as number)
        && typeof e.text === 'string' && e.text.length <= 2000
        && ['ignite', 'spread', 'detect', 'escalate', 'weather', 'suppress', 'end'].includes(e.kind as string))) return null;
    s.mods = computeModifiers(s.bought as string[]);
    return save as unknown as SavedGame;
  } catch {
    return null;
  }
}

export class GameStorage {
  private storage: Storage | undefined;
  private sessionSave: string | null | undefined;
  available = true;

  constructor(storage?: Storage) {
    try { this.storage = storage ?? window.localStorage; }
    catch { this.available = false; }
  }

  load(districts: Record<string, District>): SavedGame | null {
    try {
      const raw = this.sessionSave !== undefined ? this.sessionSave : this.storage?.getItem(SAVE_KEY);
      return raw ? decodeSave(raw, districts) : null;
    } catch { this.available = false; return null; }
  }

  save(state: WorldState, scenario: string): boolean {
    if (state.status !== 'running') return false;
    try {
      // A full or blocked disk must not lose the run when returning to the menu.
      this.sessionSave = JSON.stringify({ version: 1, scenario, savedAt: Date.now(), state });
      if (!this.storage) return false;
      this.storage.setItem(SAVE_KEY, this.sessionSave);
      this.available = true;
      return true;
    } catch { this.available = false; return false; }
  }

  clear(): void {
    this.sessionSave = null;
    try { this.storage?.removeItem(SAVE_KEY); }
    catch { this.available = false; }
  }

  best(): number {
    try {
      const raw = this.storage?.getItem(RECORD_KEY);
      const best: unknown = raw ? JSON.parse(raw) : 0;
      return number(best) ? best : 0;
    } catch { return 0; }
  }

  record(score: number): { best: number; isRecord: boolean } {
    const previous = this.best();
    const best = Math.max(previous, score);
    try { this.storage?.setItem(RECORD_KEY, JSON.stringify(best)); }
    catch { this.available = false; }
    return { best, isRecord: score > previous };
  }
}
