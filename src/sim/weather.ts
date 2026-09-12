import { rnd, rndInt } from './rng';
import type { Weather, WorldState } from './types';

/** Такт = 6 часов, сезон 15 апреля — 30 сентября. */
export const TICKS_PER_DAY = 4;
// 16 (15–30 апреля) + 31 + 30 + 31 + 31 + 30 = 169. Стояло 168, и сезон
// заканчивался 29 сентября.
export const SEASON_DAYS = 169;
export const SEASON_TICKS = SEASON_DAYS * TICKS_PER_DAY;
/** Гарантированный циклон — 10 сентября, 148-е сутки сезона. */
export const CYCLONE_DAY = 148;

const MONTHS = ['апреля', 'мая', 'июня', 'июля', 'августа', 'сентября'];
const MONTH_START = [15, 1, 1, 1, 1, 1];
const MONTH_LEN = [30, 31, 30, 31, 31, 30];

/** Номер суток сезона → человекочитаемая дата. */
export function formatDate(tick: number): string {
  let day = Math.floor(tick / TICKS_PER_DAY);
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const span = MONTH_LEN[mi] - MONTH_START[mi] + 1;
    if (day < span) return `${MONTH_START[mi] + day} ${MONTHS[mi]}`;
    day -= span;
  }
  return '30 сентября';
}

export function seasonDay(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY);
}

/**
 * Сезонный индекс засухи: 0.55 в апреле → 1.50 в июле → 0.60 в сентябре.
 * Асимметричная парабола с пиком на 95-х сутках (середина июля).
 */
export function droughtBase(day: number): number {
  const peak = 95;
  const t = (day - peak) / (day < peak ? 80 : 60);
  return Math.max(0.45, 1.5 - 0.95 * t * t);
}

export function initWeather(state: { rng: number }): Weather {
  const dir = rnd(state) * Math.PI * 2;
  return {
    windDir: dir,
    W: 1.0,
    D: droughtBase(0),
    event: null,
    eventTicks: 0,
    targetDir: dir,
    targetW: 1.0,
    nextShift: 12,
  };
}

/** Кратчайший угловой шаг от a к b. */
function angleTowards(a: number, b: number, step: number): number {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(d) <= step) return b;
  return a + Math.sign(d) * step;
}

export function stepWeather(s: WorldState): void {
  const w = s.weather;
  const day = seasonDay(s.tick);

  if (w.eventTicks > 0) {
    w.eventTicks--;
    if (w.eventTicks === 0 && w.event !== 'cyclone') w.event = null;
  }

  // Новая цель ветра раз в 8–16 тактов, между ними плавная интерполяция.
  if (s.tick >= w.nextShift) {
    w.targetDir = rnd(s) * Math.PI * 2;
    w.targetW = 0.7 + rnd(s) * 0.6;
    w.nextShift = s.tick + rndInt(s, 8, 16);
  }
  w.windDir = angleTowards(w.windDir, w.targetDir, 0.09);
  w.W += (w.targetW - w.W) * 0.12;

  w.D = Math.max(s.mods.droughtFloor, droughtBase(day));

  // Циклон: с 10 сентября сезон закрывается принудительно.
  if (day >= CYCLONE_DAY && w.event !== 'cyclone') {
    w.event = 'cyclone';
    w.eventTicks = SEASON_TICKS;
    s.events.push({ tick: s.tick, kind: 'weather',
      text: 'Циклон с запада. Дожди по всему краю — сезон закрывается.' });
  }
  if (w.event === 'cyclone') {
    w.D *= 0.35;
    w.W = Math.min(w.W, 1.0);
    return;
  }

  if (w.event === null) {
    const roll = rnd(s);
    const summer = day > 45 && day < 130;
    if (roll < (summer ? 0.030 : 0.012)) {
      w.event = 'storm';
      w.eventTicks = 2;
      s.events.push({ tick: s.tick, kind: 'weather', text: 'Сухая гроза.' });
    } else if (roll < 0.045) {
      w.event = 'squall';
      w.eventTicks = 4;
      w.targetW = 1.6;
      s.events.push({ tick: s.tick, kind: 'weather', text: 'Шквалистый ветер.' });
    } else if (roll < 0.045 + 0.010 + day / 4000) {
      w.event = 'rain';
      w.eventTicks = 6;
      s.events.push({ tick: s.tick, kind: 'weather', text: 'Прошли дожди.' });
    }
  }

  if (w.event === 'squall') w.W = Math.max(w.W, 1.5);
  if (w.event === 'rain') w.D *= 0.5;
}
