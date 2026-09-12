import { computeModifiers } from './evolutions';
import { seedFrom } from './rng';
import { initWeather } from './weather';
import type { District, DistrictId, DistrictState, WorldState } from './types';

/** Сырая запись из data/districts.meta.json. */
export interface RawDistrict {
  id: string;
  name: string;
  area: number;
  centroid: [number, number];
  forest: number;
  fuelClass: 1 | 2 | 3 | 4 | 5;
  k: number;
  pop: number;
  access: number;
  ctrlZone: boolean;
  hasAirfield: boolean;
  hasWater: boolean;
  neighbors: { to: string; w: number; barrier: number; river: number; road: number }[];
}

export interface Scenario {
  id: string;
  /** Часть названия округа, по которой ищем район старта. */
  match: string;
  title: string;
  blurb: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'evenkia', match: 'Эвенкийский', title: 'Эвенкия',
    blurb: 'Зона контроля. Тушить не будут долго, но северная тайга горит неохотно.',
  },
  {
    id: 'boguchany', match: 'Богучанский', title: 'Богучаны',
    blurb: 'Средняя тайга и лесозаготовка. Горючего много, силы далеко.',
  },
  {
    id: 'minusinsk', match: 'Минусинский', title: 'Минусинская котловина',
    blurb: 'Лесостепь. Палы травы разгоняются мгновенно, но леса мало и заметят сразу.',
  },
  {
    id: 'emelyanovo', match: 'Емельяновский', title: 'Под Красноярском',
    blurb: 'Сосновые боры у миллионника. Тройные искры и авиация на вторые сутки.',
  },
];

/**
 * Опорная площадь района, км². Округ такого размера горит «в номинале»,
 * более крупные — медленнее по доле охвата, мелкие — быстрее.
 */
const REF_AREA = 15_000;

/** Поправка скорости роста на размер района, см. District.sizeFactor. */
export function sizeFactor(area: number): number {
  // Границы не дают ЗАТО на 3 км² вспыхивать мгновенно, а Таймыру — замирать.
  return Math.max(0.18, Math.min(1.6, Math.sqrt(REF_AREA / Math.max(1, area))));
}

/**
 * Сезонный бюджет района, см. District.budget. Мелкий округ может выгореть
 * заметной долей, у гиганта вроде Эвенкии за сезон реально уходят проценты.
 */
export function budget(area: number): number {
  // Коэффициент намеренно щедрый. При 0.25 суммарный бюджет края выходил
  // ~7.9 млн га, и КАЖДАЯ выжившая партия упиралась в этот потолок: p75 и p90
  // отличались на проценты, верхняя половина распределения была плоской.
  // Ограничителем должно быть время сезона и противодействие МЧС, а не запас
  // горючего, поэтому потолок поднят заведомо выше достижимого.
  return Math.max(0.12, Math.min(0.9, 0.9 * sizeFactor(area)));
}

/** Азимут от a к b в системе windDir: 0 — на восток, π/2 — на север. */
function bearing(a: [number, number], b: [number, number]): number {
  const latMean = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * Math.cos(latMean);
  const dy = b[1] - a[1];
  return Math.atan2(dy, dx);
}

/** Превратить сырые данные в константы районов, досчитав азимуты рёбер. */
export function loadDistricts(raw: Record<string, RawDistrict>): Record<DistrictId, District> {
  const out: Record<DistrictId, District> = {};
  for (const id in raw) {
    const r = raw[id];
    out[id] = {
      id,
      name: r.name,
      area: r.area,
      forest: r.forest,
      fuelClass: r.fuelClass,
      k: r.k,
      pop: r.pop,
      access: r.access,
      ctrlZone: r.ctrlZone,
      hasAirfield: r.hasAirfield,
      hasWater: r.hasWater,
      centroid: r.centroid,
      sizeFactor: sizeFactor(r.area),
      budget: budget(r.area),
      neighbors: r.neighbors
        .filter((e) => raw[e.to])
        .map((e) => ({
          to: e.to,
          w: e.w,
          barrier: e.barrier,
          river: e.river,
          road: e.road,
          bearing: bearing(r.centroid, raw[e.to].centroid),
        })),
    };
  }
  return out;
}

export function findStart(districts: Record<DistrictId, District>, match: string): DistrictId {
  const id = Object.keys(districts).find((k) => districts[k].name.includes(match));
  if (!id) throw new Error(`Район старта не найден: ${match}`);
  return id;
}

export function createWorld(
  districts: Record<DistrictId, District>,
  startId: DistrictId,
  seed: string | number = 'chernoe-nebo',
): WorldState {
  const states: Record<DistrictId, DistrictState> = {};
  for (const id in districts) {
    states[id] = {
      F: 1,
      B: 0,
      burned: 0,
      S: 0,
      known: false,
      smoke: 0,
      minLine: 0,
      ignited: false,
    };
  }
  states[startId].B = 0.01;
  states[startId].ignited = true;

  const s: WorldState = {
    tick: 0,
    ids: Object.keys(districts),
    rng: typeof seed === 'string' ? seedFrom(seed) : seed | 0,
    districts: states,
    sparks: 0,
    bought: [],
    mods: computeModifiers([]),
    escalation: 0,
    weather: initWeather({ rng: 0 }),
    totalBurned: 0,
    events: [],
    status: 'running',
    grade: null,
    flags: {},
  };
  s.weather = initWeather(s);
  s.events.push({
    tick: 0,
    kind: 'ignite',
    text: `Очаг возгорания: ${districts[startId].name}.`,
  });
  return s;
}

/** Применить покупку эволюции. Возвращает false, если купить нельзя. */
export function buy(s: WorldState, id: string, cost: number): boolean {
  if (s.bought.includes(id) || s.sparks < cost) return false;
  s.sparks -= cost;
  s.bought.push(id);
  s.mods = computeModifiers(s.bought);
  return true;
}
