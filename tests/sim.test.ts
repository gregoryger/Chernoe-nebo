import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BY_ID, EVOLUTIONS, canBuy, computeModifiers } from '../src/sim/evolutions';
import { tick } from '../src/sim/tick';
import {
  THROW_BASE, THROW_STEP, buy, canThrow, createWorld, emberThrow, findStart,
  loadDistricts, setFocus, sizeFactor, throwCost,
} from '../src/sim/world';
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

  /*
   * Польза от ветки распространения зависит от старта, и сильно.
   *
   * Замер по 40 партиям на сценарий: Минусинск ×4.3, Богучаны ×2.7,
   * Емельяново ×2.5, Эвенкия всего ×1.5. Эвенкия выбивается не из-за ошибки,
   * а из-за размера: она одна выжигает 220 тыс. га вообще без покупок, и
   * распространяться оттуда особо некуда — семь соседей, все далеко.
   * Поэтому единый порог здесь неуместен: слабый проверяет всё, сильный
   * падает на Эвенкии.
   */
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const spreadGain = (start: string): number => {
    const from = findStart(districts, start);
    const play = (seed: number, buys: string[]) => {
      const s = createWorld(districts, from, seed);
      while (s.status === 'running') {
        for (const id of buys) if (canBuy(id, s.bought, s.sparks)) buy(s, id, BY_ID[id].cost);
        tick(s, districts);
      }
      return s.totalBurned;
    };
    const seeds = Array.from({ length: 24 }, (_, i) => 11 + i * 37);
    const withEvo = median(seeds.map((s) => play(s, ['A1', 'A2', 'A4', 'A3', 'A5'])));
    const without = median(seeds.map((s) => play(s, [])));
    return withEvo / without;
  };

  it('распространение помогает в любом сценарии', () => {
    for (const start of ['Эвенкийский', 'Богучанский', 'Минусинский', 'Емельяновский']) {
      expect(spreadGain(start)).toBeGreaterThan(1.2);
    }
  });

  it('степной пал расширяет охват лесостепи', () => {
    /*
     * A5 заменил «Прорыв по просекам»: тот снимал дорожные барьеры, которых
     * в данных нет — все 176 рёбер имеют road = 0, потому что сибирские трассы
     * идут поперёк границ, а не вдоль. Узел не делал ничего, и тест на это
     * отсутствовал, поэтому мёртвая ветка жила незамеченной.
     */
    const steppe = Object.values(districts).filter((d) => d.forest < 0.35);
    expect(steppe.length).toBeGreaterThan(5);

    const from = findStart(districts, 'Богучанский');
    const reach = (buys: string[]) => {
      let hit = 0;
      const seeds = Array.from({ length: 16 }, (_, i) => 11 + i * 37);
      for (const seed of seeds) {
        const s = createWorld(districts, from, seed);
        while (s.status === 'running') {
          for (const id of buys) if (canBuy(id, s.bought, s.sparks)) buy(s, id, BY_ID[id].cost);
          tick(s, districts);
        }
        for (const d of steppe) if (s.districts[d.id].ignited) hit++;
      }
      return hit / seeds.length;
    };
    expect(reach(['A1', 'A2', 'A4', 'A5'])).toBeGreaterThan(reach(['A1', 'A2', 'A4']));
  });

  it('из компактного округа распространение решает вдвое', () => {
    // Богучаны — представительный средний случай: средняя тайга, пять соседей.
    expect(spreadGain('Богучанский')).toBeGreaterThan(2);
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

describe('управление направлением', () => {
  it('фокус повышает шанс перехода в выбранный округ', () => {
    // Эффект вероятностный, поэтому меряем долю партий, где цель загорелась,
    // на одних и тех же семенах с фокусом и без.
    const target = findStart(districts, 'Туруханский');
    const seeds = Array.from({ length: 40 }, (_, i) => 500 + i * 131);

    const share = (withFocus: boolean) => {
      let hit = 0;
      for (const seed of seeds) {
        const s = createWorld(districts, evenkia, seed);
        if (withFocus) setFocus(s, target);
        for (let i = 0; i < 160 && s.status === 'running'; i++) {
          for (const id of ['A1', 'A2']) {
            if (canBuy(id, s.bought, s.sparks)) buy(s, id, BY_ID[id].cost);
          }
          tick(s, districts);
        }
        if (s.districts[target].ignited) hit++;
      }
      return hit / seeds.length;
    };

    expect(share(true)).toBeGreaterThan(share(false));
  });

  it('фокус на себя ничего не ломает', () => {
    const s = createWorld(districts, evenkia, 5);
    setFocus(s, evenkia);
    expect(() => { for (let i = 0; i < 50; i++) tick(s, districts); }).not.toThrow();
  });

  it('повторный клик снимает фокус', () => {
    const s = createWorld(districts, evenkia, 5);
    const other = findStart(districts, 'Богучанский');
    setFocus(s, other);
    expect(s.focus).toBe(other);
    setFocus(s, other);
    expect(s.focus).toBeNull();
  });

  it('бросок искр требует горящего соседа', () => {
    const s = createWorld(districts, evenkia, 5);
    s.sparks = 500;
    const far = findStart(districts, 'Минусинский');
    expect(canThrow(s, districts, far)).toBe(false);
    expect(emberThrow(s, districts, far)).toBe(false);
    expect(s.sparks).toBe(500);
  });

  it('бросок поджигает округ, списывает искры и уходит в простой', () => {
    const s = createWorld(districts, evenkia, 5);
    s.districts[evenkia].B = 0.4;
    s.sparks = 500;
    const neighbour = districts[evenkia].neighbors[0].to;

    const before = s.sparks;
    expect(emberThrow(s, districts, neighbour)).toBe(true);
    expect(s.districts[neighbour].B).toBeGreaterThan(0);
    // Списана цена, но начислен бонус за новый округ.
    expect(s.sparks).toBe(before - THROW_BASE + 10);
    expect(s.throwCooldown).toBeGreaterThan(0);

    // Пока идёт простой, второй бросок невозможен.
    const other = districts[evenkia].neighbors[1].to;
    expect(canThrow(s, districts, other)).toBe(false);
  });

  it('каждый следующий бросок дороже', () => {
    const s = createWorld(districts, evenkia, 5);
    expect(throwCost(s)).toBe(THROW_BASE);
    s.throws = 2;
    expect(throwCost(s)).toBe(THROW_BASE + 2 * THROW_STEP);
  });
});
