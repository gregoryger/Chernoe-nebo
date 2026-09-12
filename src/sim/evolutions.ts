import type { Modifiers } from './types';

export interface Evolution {
  id: string;
  branch: 'A' | 'B' | 'V';
  name: string;
  cost: number;
  /** Предыдущий узел ветви; null — доступен сразу. */
  needs: string | null;
  desc: string;
}

/** Базовые константы огня до единой покупки. */
export const BASE_MODS: Modifiers = {
  r: 0.08,
  // При 0.02 выход огня за пределы стартового округа был монеткой, и
  // распределение распадалось надвое: p25 = 0.4 млн против p50 = 7.4 млн.
  tau: 0.06,
  // Гасящий член в такте — e * S, а S доходит до сотни. При e=0.05
  // очаг умирал за один такт: константа не была согласована с масштабом сил.
  e: 0.0016,
  damageMult: 1,
  nightPenalty: 0.55,
  riverBarrierMult: 1,
  roadBarrierMult: 1,
  minLineMult: 1,
  aviationMult: 1,
  backfireMult: 1,
  droughtFloor: 0,
  spotting: false,
  peat: false,
  crownFire: false,
  smokeOn: false,
  blackSky: false,
  villageThreat: false,
  infraDamage: false,
  smolder: 0,
};

export const EVOLUTIONS: Evolution[] = [
  // ------------------------------------------------------- А. Распространение
  { id: 'A1', branch: 'A', name: 'Низовой пал', cost: 5, needs: null,
    desc: 'Огонь идёт по подстилке. Переброс в соседние районы ×1.5.' },
  { id: 'A2', branch: 'A', name: 'Верховой пожар', cost: 15, needs: 'A1',
    desc: 'Пламя выходит в кроны. Скорость ×1.4, переброс ×1.3. Только в хвойных районах.' },
  { id: 'A3', branch: 'A', name: 'Пятнистость', cost: 30, needs: 'A2',
    desc: 'Головни улетают по ветру: огонь перескакивает через район.' },
  { id: 'A4', branch: 'A', name: 'Переход через реки', cost: 25, needs: 'A2',
    desc: 'Речные барьеры ослаблены на 80%. Открывает правый берег Енисея.' },
  { id: 'A5', branch: 'A', name: 'Прорыв по просекам', cost: 20, needs: 'A4',
    desc: 'Дорожные и железнодорожные барьеры сняты полностью.' },
  { id: 'A6', branch: 'A', name: 'Торфяной пожар', cost: 40, needs: 'A5',
    desc: 'Огонь уходит под землю: не гаснет полностью и переживает дождь.' },

  // ---------------------------------------------------------------- Б. Ущерб
  { id: 'B1', branch: 'B', name: 'Задымление', cost: 10, needs: null,
    desc: 'Дым копится вместе с пожаром. Эффективность авиации −25%.' },
  { id: 'B2', branch: 'B', name: 'Чёрное небо', cost: 25, needs: 'B1',
    desc: 'Режим НМУ в крупных городах: +2 искры за такт.' },
  { id: 'B3', branch: 'B', name: 'Гибель древостоя', cost: 15, needs: 'B1',
    desc: 'Лес не восстанавливается. Искры за гектар ×1.5.' },
  { id: 'B4', branch: 'B', name: 'Обрыв ЛЭП и дорог', cost: 30, needs: 'B3',
    desc: 'Доступность соседних районов −40%: силы добираются вдвое дольше.' },
  { id: 'B5', branch: 'B', name: 'Угроза посёлкам', cost: 12, needs: 'B3',
    desc: 'Тройные искры в населённых районах, но сразу +1 к эскалации.' },

  // --------------------------------------------------------- В. Устойчивость
  { id: 'V1', branch: 'V', name: 'Засухоустойчивость', cost: 10, needs: null,
    desc: 'Индекс засухи не опускается ниже 0.80. Спасает апрель и сентябрь.' },
  { id: 'V2', branch: 'V', name: 'Ночное горение', cost: 18, needs: 'V1',
    desc: 'Ночной штрафной множитель снят.' },
  { id: 'V3', branch: 'V', name: 'Устойчивость к воде', cost: 35, needs: 'V2',
    desc: 'Эффективность Ми-8 и Бе-200 снижена на 40%.' },
  { id: 'V4', branch: 'V', name: 'Прорыв минполосы', cost: 30, needs: 'V2',
    desc: 'Минерализованные полосы работают на 30% от номинала.' },
  { id: 'V5', branch: 'V', name: 'Стойкость к отжигу', cost: 25, needs: 'V4',
    desc: 'Встречный отжиг снимает вдвое меньше площади.' },
  { id: 'V6', branch: 'V', name: 'Тление', cost: 45, needs: 'V5',
    desc: 'Потушенный район с шансом 8% за такт вспыхивает снова.' },
];

export const BY_ID: Record<string, Evolution> =
  Object.fromEntries(EVOLUTIONS.map((e) => [e.id, e]));

export const TOTAL_COST = EVOLUTIONS.reduce((s, e) => s + e.cost, 0);

/** Куплен ли узел и открыт ли он (предок куплен). */
export function isUnlocked(id: string, bought: readonly string[]): boolean {
  const ev = BY_ID[id];
  if (!ev) return false;
  return ev.needs === null || bought.includes(ev.needs);
}

export function canBuy(id: string, bought: readonly string[], sparks: number): boolean {
  const ev = BY_ID[id];
  return !!ev && !bought.includes(id) && isUnlocked(id, bought) && sparks >= ev.cost;
}

/**
 * Свернуть купленные узлы в набор модификаторов.
 * Чистая функция от списка покупок — пересчитывается при каждой покупке,
 * а не накапливается инкрементально: так порядок покупок не может разъехаться
 * с результатом.
 */
export function computeModifiers(bought: readonly string[]): Modifiers {
  const m: Modifiers = { ...BASE_MODS };
  const has = (id: string) => bought.includes(id);

  if (has('A1')) m.tau *= 1.5;
  if (has('A2')) { m.r *= 1.4; m.tau *= 1.3; m.crownFire = true; }
  if (has('A3')) m.spotting = true;
  if (has('A4')) m.riverBarrierMult = 0.2;
  if (has('A5')) m.roadBarrierMult = 0;
  if (has('A6')) m.peat = true;

  if (has('B1')) { m.smokeOn = true; m.aviationMult *= 0.75; }
  if (has('B2')) m.blackSky = true;
  if (has('B3')) m.damageMult *= 1.5;
  if (has('B4')) m.infraDamage = true;
  if (has('B5')) m.villageThreat = true;

  if (has('V1')) m.droughtFloor = 0.8;
  if (has('V2')) m.nightPenalty = 1;
  if (has('V3')) m.aviationMult *= 0.6;
  if (has('V4')) m.minLineMult = 0.3;
  if (has('V5')) m.backfireMult = 0.5;
  if (has('V6')) m.smolder = 0.08;

  return m;
}
