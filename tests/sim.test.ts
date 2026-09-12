import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BY_ID, EVOLUTIONS, canBuy, computeModifiers } from '../src/sim/evolutions';
import { tick } from '../src/sim/tick';
import { buy, createWorld, findStart, loadDistricts, sizeFactor } from '../src/sim/world';
import type { RawDistrict } from '../src/sim/world';
import { SEASON_TICKS, droughtBase, formatDate } from '../src/sim/weather';

const raw = JSON.parse(readFileSync('data/districts.meta.json', 'utf-8')) as Record<string, RawDistrict>;
const districts = loadDistricts(raw);
const evenkia = findStart(districts, 'Эвенкийский');

function run(seed: number, buys: string[] = [], ticks = SEASON_TICKS) {
  const s = createWorld(districts, evenkia, seed);
  for (let i = 0; i < ticks && s.status === 'running'; i++) {
    for (const id of buys) if (canBuy(id, s.bought, s.sparks)) buy(s, id, BY_ID[id].cost);
    tick(s, districts);
  }
  return s;
}

describe('данные', () => {
  it('загружены все 39 округов', () => {
    expect(Object.keys(districts)).toHaveLength(39);
  });

  it('в графе нет изолированных узлов', () => {
    for (const id in districts) expect(districts[id].neighbors.length).toBeGreaterThan(0);
  });

  it('граф соседства симметричен', () => {
    for (const id in districts) {
      for (const e of districts[id].neighbors) {
        expect(districts[e.to].neighbors.some((b) => b.to === id)).toBe(true);
      }
    }
  });

  it('площадь края сходится с официальной', () => {
    const total = Object.values(districts).reduce((s, d) => s + d.area, 0);
    expect(total).toBeGreaterThan(2_300_000);
    expect(total).toBeLessThan(2_400_000);
  });

  it('зоны контроля — северные округа, а не городские анклавы', () => {
    const zones = Object.values(districts).filter((d) => d.ctrlZone).map((d) => d.name);
    expect(zones.some((n) => n.includes('Эвенкийский'))).toBe(true);
    expect(zones.some((n) => n.includes('ЗАТО'))).toBe(false);
    expect(zones.some((n) => n.includes('Красноярск'))).toBe(false);
  });
});

describe('симуляция', () => {
  it('детерминирована по seed', () => {
    const a = run(42);
    const b = run(42);
    expect(b.totalBurned).toBeCloseTo(a.totalBurned, 6);
    expect(b.status).toBe(a.status);
  });

  it('разные seed дают разные партии', () => {
    expect(run(1).totalBurned).not.toBeCloseTo(run(2).totalBurned, 0);
  });

  it('без горючего огонь не растёт', () => {
    const s = createWorld(districts, evenkia, 7);
    for (const id of s.ids) s.districts[id].F = 0;
    s.districts[evenkia].B = 0.5;
    const before = s.districts[evenkia].B;
    tick(s, districts);
    expect(s.districts[evenkia].B).toBeLessThanOrEqual(before);
    expect(s.totalBurned).toBe(0);
  });

  it('партия всегда завершается за сезон', () => {
    for (const seed of [1, 99, 12345]) {
      const s = run(seed);
      expect(s.status).not.toBe('running');
      expect(s.tick).toBeLessThanOrEqual(SEASON_TICKS);
    }
  });

  it('выгоревшая площадь не превышает сезонный бюджет района', () => {
    const s = run(555, ['A1', 'A2', 'A4', 'A3']);
    for (const id of s.ids) {
      const d = districts[id];
      const cap = d.area * d.forest * 100 * d.budget;
      expect(s.districts[id].burned).toBeLessThanOrEqual(cap * 1.001);
    }
  });
});

describe('эволюции', () => {
  it('узел нельзя купить без предка', () => {
    expect(canBuy('A2', [], 999)).toBe(false);
    expect(canBuy('A2', ['A1'], 999)).toBe(true);
  });

  it('покупка списывает искры ровно один раз', () => {
    const s = createWorld(districts, evenkia, 3);
    s.sparks = 100;
    expect(buy(s, 'A1', 5)).toBe(true);
    expect(buy(s, 'A1', 5)).toBe(false);
    expect(s.sparks).toBe(95);
  });

  it('каждая из 17 эволюций меняет модификаторы', () => {
    const base = computeModifiers([]);
    for (const ev of EVOLUTIONS) {
      const chain: string[] = [];
      let cur: string | null = ev.id;
      while (cur) { chain.unshift(cur); cur = BY_ID[cur].needs; }
      const withIt = computeModifiers(chain);
      const without = computeModifiers(chain.slice(0, -1));
      expect(JSON.stringify(withIt), `${ev.id} ${ev.name}`).not.toBe(JSON.stringify(without));
      expect(JSON.stringify(withIt)).not.toBe(JSON.stringify(base));
    }
  });

  it('переход через реки ослабляет речные барьеры', () => {
    expect(computeModifiers(['A1', 'A2', 'A4']).riverBarrierMult).toBeLessThan(1);
  });

  it('распространение увеличивает выгоревшую площадь', () => {
    // Распределение исходов бимодально, поэтому шести семян не хватало:
    // тест падал на шуме, а не на регрессии. Сравниваем медианы на 24 партиях.
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    const seeds = Array.from({ length: 24 }, (_, i) => 11 + i * 37);
    const withEvo = median(seeds.map((s) => run(s, ['A1', 'A2', 'A4', 'A3', 'A5']).totalBurned));
    const without = median(seeds.map((s) => run(s).totalBurned));
    expect(withEvo).toBeGreaterThan(without * 1.5);
  });
});

describe('погода и календарь', () => {
  it('сезон идёт с 15 апреля по 30 сентября', () => {
    expect(formatDate(0)).toBe('15 апреля');
    expect(formatDate(SEASON_TICKS - 1)).toBe('30 сентября');
  });

  it('засуха максимальна в июле', () => {
    expect(droughtBase(95)).toBeGreaterThan(droughtBase(5));
    expect(droughtBase(95)).toBeGreaterThan(droughtBase(160));
  });

  it('крупный округ горит медленнее по доле охвата', () => {
    expect(sizeFactor(700_000)).toBeLessThan(sizeFactor(15_000));
  });
});
