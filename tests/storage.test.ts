import { describe, expect, it } from 'vitest';
import raw from '../data/districts.meta.json';
import { createWorld, findStart, loadDistricts } from '../src/sim/world';
import type { RawDistrict } from '../src/sim/world';
import { tick } from '../src/sim/tick';
import { decodeSave, GameStorage, SAVE_KEY } from '../src/storage';

const districts = loadDistricts(raw as unknown as Record<string, RawDistrict>);
const world = () => createWorld(districts, findStart(districts, 'Богучанский'), 'save-test');
const encode = (state = world()) => JSON.stringify({ version: 1, scenario: 'boguchany', savedAt: 1, state });

describe('saved games', () => {
  it('resumes the exact weather and fire sequence', () => {
    const original = world();
    for (let i = 0; i < 30; i++) tick(original, districts);
    const restored = decodeSave(encode(original), districts)!.state;
    for (let i = 0; i < 50; i++) {
      tick(original, districts);
      tick(restored, districts);
    }
    expect(restored).toEqual(original);
  });

  it('rejects malformed, incompatible and incomplete saves', () => {
    for (const value of ['{', '{}', 'null', encode().replace('"version":1', '"version":99')]) {
      expect(decodeSave(value, districts)).toBeNull();
    }
    const state = world();
    delete (state.districts as Record<string, unknown>)[state.ids[0]];
    expect(decodeSave(encode(state), districts)).toBeNull();
  });

  it('rejects impossible purchases, terminal states and invalid numbers', () => {
    const state = world();
    state.bought = ['A6'];
    expect(decodeSave(encode(state), districts)).toBeNull();
    state.bought = [];
    state.status = 'won';
    expect(decodeSave(encode(state), districts)).toBeNull();
    state.status = 'running';
    state.weather.W = NaN;
    expect(decodeSave(encode(state), districts)).toBeNull();
  });

  it('rebuilds derived modifiers instead of trusting saved values', () => {
    const state = world();
    state.mods.r = 999;
    expect(decodeSave(encode(state), districts)!.state.mods.r).toBe(world().mods.r);
  });

  it('keeps playing if storage is blocked or full', () => {
    const storage = new GameStorage({
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('full'); },
      removeItem() { throw new Error('blocked'); },
    } as unknown as Storage);
    expect(storage.load(districts)).toBeNull();
    expect(storage.save(world(), 'boguchany')).toBe(false);
    expect(storage.load(districts)?.state).toEqual(world());
    expect(() => storage.clear()).not.toThrow();
    expect(storage.available).toBe(false);
  });

  it('preserves the best score and clears only its own save', () => {
    const data = new Map<string, string>();
    const storage = new GameStorage({
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    } as unknown as Storage);
    storage.save(world(), 'boguchany');
    expect(storage.load(districts)?.scenario).toBe('boguchany');
    expect(storage.record(100)).toEqual({ best: 100, isRecord: true });
    expect(storage.record(50)).toEqual({ best: 100, isRecord: false });
    storage.clear();
    expect(data.has(SAVE_KEY)).toBe(false);
    expect(storage.best()).toBe(100);
  });

  it('does not resurrect a finished season when removing its disk save fails', () => {
    const storage = new GameStorage({
      getItem: () => encode(),
      removeItem() { throw new Error('blocked'); },
    } as unknown as Storage);
    expect(storage.load(districts)).not.toBeNull();
    storage.clear();
    expect(storage.load(districts)).toBeNull();
  });
});
