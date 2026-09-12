/**
 * Headless-прогон партий без браузера.
 *
 * Ради этого симуляция и отделена от рендера: константы подбираются по
 * распределению исходов на тысяче партий, а не на глаз кликами мышкой.
 *
 *   npx tsx tools/balance.ts [партий] [--dist]
 *
 * Без флага печатает сводку по сценариям и стратегиям. С `--dist` — форму
 * распределения и диагностику ранней гибели: именно она, а не пороги,
 * определяет, попадает ли игра в целевые доли рангов.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BY_ID, EVOLUTIONS, canBuy } from '../src/sim/evolutions';
import { BRONZE, GOLD, SILVER, tick } from '../src/sim/tick';
import { SCENARIOS, buy, createWorld, findStart, loadDistricts } from '../src/sim/world';
import type { RawDistrict } from '../src/sim/world';
import type { WorldState } from '../src/sim/types';
import { TICKS_PER_DAY } from '../src/sim/weather';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(join(here, '..', 'data', 'districts.meta.json'), 'utf-8'),
) as Record<string, RawDistrict>;
const districts = loadDistricts(raw);

type Strategy = (s: WorldState) => void;

/** Порядок покупок как список приоритетов; берём первое доступное по карману. */
function byOrder(order: string[]): Strategy {
  return (s) => {
    for (const id of order) {
      if (canBuy(id, s.bought, s.sparks)) {
        buy(s, id, BY_ID[id].cost);
        return;
      }
    }
  };
}

const STRATEGIES: Record<string, Strategy> = {
  'бездействие': () => {},
  'ширина': byOrder(['A1', 'A2', 'V1', 'A4', 'A3', 'A5', 'V2', 'B3', 'A6', 'B1', 'V3', 'B4', 'V4', 'B5', 'B2', 'V5', 'V6']),
  'живучесть': byOrder(['A1', 'V1', 'V2', 'A2', 'V3', 'V4', 'A4', 'V5', 'V6', 'A3', 'B3', 'A5', 'A6', 'B1', 'B4', 'B5', 'B2']),
  'дешёвое': (s) => {
    const options = EVOLUTIONS
      .filter((e) => canBuy(e.id, s.bought, s.sparks))
      .sort((a, b) => a.cost - b.cost);
    if (options.length) buy(s, options[0].id, options[0].cost);
  },
};

interface Result {
  burned: number;
  status: string;
  ticks: number;
  touched: number;
  bought: number;
  /** Сутки, на которые очаги были ликвидированы; null — партия дожила до конца. */
  diedDay: number | null;
}

function play(scenarioMatch: string, strategy: Strategy, seed: number): Result {
  const start = findStart(districts, scenarioMatch);
  const s = createWorld(districts, start, seed);
  while (s.status === 'running') {
    strategy(s);
    tick(s, districts);
  }
  let touched = 0;
  for (const id of s.ids) if (s.districts[id].ignited) touched++;
  const died = s.status === 'lost' && s.tick < 671;
  return {
    burned: s.totalBurned,
    status: s.status,
    ticks: s.tick,
    touched,
    bought: s.bought.length,
    diedDay: died ? Math.floor(s.tick / TICKS_PER_DAY) : null,
  };
}

const RUNS = Number(process.argv[2] ?? 200);
const DIST = process.argv.includes('--dist');
const pctl = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
const ru = (n: number) => Math.round(n).toLocaleString('ru');

const t0 = Date.now();
let games = 0;

if (!DIST) {
  console.log(`Прогон: ${RUNS} партий × ${Object.keys(STRATEGIES).length} стратегий `
    + `× ${SCENARIOS.length} сценария\n`);
  console.log('сценарий'.padEnd(24) + 'стратегия'.padEnd(14)
    + 'медиана га'.padStart(12) + 'бронза'.padStart(9)
    + 'серебро'.padStart(9) + 'золото'.padStart(8) + 'потушен'.padStart(10));
  console.log('-'.repeat(86));
}

/** Агрегат по всем сценариям для каждой «играющей» стратегии. */
const overall: Record<string, number[]> = {};
const deaths: Record<string, number[]> = {};

for (const sc of SCENARIOS) {
  for (const [name, strat] of Object.entries(STRATEGIES)) {
    const burned: number[] = [];
    let bronze = 0, silver = 0, gold = 0, extinguished = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = play(sc.match, strat, 1000 + i * 7919);
      games++;
      burned.push(r.burned);
      if (r.burned >= BRONZE) bronze++;
      if (r.burned >= SILVER) silver++;
      if (r.burned >= GOLD) gold++;
      if (r.diedDay !== null) {
        extinguished++;
        (deaths[name] ??= []).push(r.diedDay);
      }
      (overall[name] ??= []).push(r.burned);
    }
    if (!DIST) {
      burned.sort((a, b) => a - b);
      const pct = (n: number) => `${Math.round((100 * n) / RUNS)}%`;
      console.log(
        sc.title.padEnd(24) + name.padEnd(14)
        + ru(pctl(burned, 50)).padStart(12)
        + pct(bronze).padStart(9) + pct(silver).padStart(9)
        + pct(gold).padStart(8) + pct(extinguished).padStart(10),
      );
    }
  }
  if (!DIST) console.log('-'.repeat(86));
}

if (DIST) {
  console.log('Форма распределения по всем сценариям сразу\n');
  console.log('стратегия'.padEnd(14) + ['p10', 'p25', 'p50', 'p75', 'p90']
    .map((h) => h.padStart(11)).join('')
    + 'бронза'.padStart(9) + 'серебро'.padStart(9) + 'золото'.padStart(8));
  console.log('-'.repeat(90));
  for (const [name, arr] of Object.entries(overall)) {
    const a = [...arr].sort((x, y) => x - y);
    const share = (t: number) => `${Math.round((100 * a.filter((v) => v >= t).length) / a.length)}%`;
    console.log(
      name.padEnd(14)
      + [10, 25, 50, 75, 90].map((p) => ru(pctl(a, p)).padStart(11)).join('')
      + share(BRONZE).padStart(9) + share(SILVER).padStart(9) + share(GOLD).padStart(8),
    );
  }

  console.log('\nКогда гибнут очаги (сутки сезона из 169)\n');
  console.log('стратегия'.padEnd(14) + 'гибнет'.padStart(9)
    + 'до 30 сут'.padStart(12) + 'медиана'.padStart(10) + 'p90'.padStart(8));
  console.log('-'.repeat(54));
  for (const name of Object.keys(overall)) {
    const d = (deaths[name] ?? []).sort((a, b) => a - b);
    const total = overall[name].length;
    const early = d.filter((x) => x <= 30).length;
    console.log(
      name.padEnd(14)
      + `${Math.round((100 * d.length) / total)}%`.padStart(9)
      + `${Math.round((100 * early) / total)}%`.padStart(12)
      + (d.length ? String(pctl(d, 50)) : '—').padStart(10)
      + (d.length ? String(pctl(d, 90)) : '—').padStart(8),
    );
  }
}

const dt = (Date.now() - t0) / 1000;
console.log(`\n${games} партий за ${dt.toFixed(1)} с — ${(games / dt).toFixed(0)} партий/с`);
console.log(`Критерий ТЗ: 1000 партий < 30 с → ${(1000 / (games / dt)).toFixed(1)} с`);
console.log(`Пороги: бронза ${ru(BRONZE)} · серебро ${ru(SILVER)} · золото ${ru(GOLD)}`);
