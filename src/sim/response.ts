import { rnd, pick } from './rng';
import type { District, DistrictId, WorldState } from './types';

/** Наземные и авиационные силы по уровню эскалации 0…5. */
const GROUND_BY_LEVEL = [0, 2, 7, 11, 17, 24];
const AIR_BY_LEVEL = [0, 0, 5, 12, 16, 20];

/** Доля пути к целевому наряду сил за такт — силы прибывают не мгновенно. */
const DEPLOY_RATE = 0.15;

export function escalationTarget(s: WorldState, districts: Record<DistrictId, District>): number {
  let level = 0;
  let knownFires = 0;
  let bigTown = false;

  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i];
    const st = s.districts[id];
    if (st.B > 0.005 && st.known) {
      knownFires++;
      if (districts[id].pop >= 20000) bigTown = true;
    }
  }

  if (knownFires >= 1) level = 1;
  if (knownFires >= 3 || bigTown) level = 2;
  if (s.totalBurned > 100_000) level = 3;
  if (s.totalBurned > 500_000 || s.flags.blackSky) level = 4;
  if (s.totalBurned > 1_500_000) level = 5;

  // «Угроза посёлкам» даёт искры, но сразу поднимает приоритет тушения.
  if (s.mods.villageThreat && level > 0) level = Math.min(5, level + 1);

  return level;
}

const LEVEL_TEXT = [
  '',
  'Лесничества подняты по тревоге.',
  'Подключилась Авиалесоохрана: десантники и Ми-8.',
  'Режим ЧС в районах. Работают Бе-200, прокладываются минполосы.',
  'Режим ЧС краевого уровня. Прибыла федеральная группировка.',
  'К тушению привлечена армия.',
];

export function stepResponse(s: WorldState, districts: Record<DistrictId, District>): void {
  // ------------------------------------------------------------ обнаружение
  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i];
    const st = s.districts[id];
    const d = districts[id];
    if (st.known || st.B <= 0) continue;
    // Спутниковый мониторинг включается с 1 мая (16-е сутки сезона).
    const satellite = s.tick >= 16 * 4 ? 1 : 0;
    const p = st.B * (0.05 + 0.6 * Math.min(1, d.pop / 20000) + 0.2 * satellite);
    if (rnd(s) < p) {
      st.known = true;
      s.events.push({ tick: s.tick, kind: 'detect',
        text: `Обнаружен пожар: ${d.name}.` });
    }
  }

  // ------------------------------------------------------------- эскалация
  const target = escalationTarget(s, districts);
  if (target > s.escalation) {
    s.escalation = target;
    s.events.push({ tick: s.tick, kind: 'escalate',
      text: `Уровень ${target}. ${LEVEL_TEXT[target]}` });
  }

  const lvl = s.escalation;

  // ---------------------------------------------------- наряд сил по районам
  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i];
    const st = s.districts[id];
    const d = districts[id];

    let targetS = 0;
    if (st.known && st.B > 0.001) {
      // Зона контроля: пока ущерб по краю не вышел за рамки, туда не летят.
      // Абсолютное население для зоны контроля не годится: в Эвенкии живёт
      // 14 816 человек, но на 715 тыс. км² — это 0.02 чел/км². Признак
      // удалённости уже зашит в ctrlZone при подготовке данных.
      const ignored = d.ctrlZone && lvl < 4;
      if (!ignored) {
        // «Обрыв ЛЭП и дорог» бьёт по подвозу сил к соседям очага.
        let access = d.access;
        if (s.mods.infraDamage) {
          const nearFire = d.neighbors.some((e) => s.districts[e.to].B > 0.15);
          if (nearFire) access *= 0.6;
        }

        const ground = GROUND_BY_LEVEL[lvl] * (0.3 + 0.7 * access);

        const airBase = d.hasAirfield || d.neighbors.some((e) => districts[e.to].hasAirfield)
          ? 1 : 0.4;
        const smokeBlocked = s.mods.smokeOn && st.smoke > 0.6;
        const air = smokeBlocked
          ? 0
          : AIR_BY_LEVEL[lvl] * airBase * s.mods.aviationMult
            * (1 - 0.5 * st.smoke) * (d.hasWater ? 1 : 0.5);

        const priority = 1 + Math.min(2, d.pop / 50000);
        targetS = (ground + air) * priority;
      }
    }

    st.S += (targetS - st.S) * DEPLOY_RATE;
    if (st.S < 0.01) st.S = 0;

    // ------------------------------------------------------- минерализованные полосы
    if (lvl >= 3 && st.known && st.B > 0.05) {
      st.minLine = Math.min(1, st.minLine + 1 / 3);
    } else if (st.B <= 0.001) {
      st.minLine = 0;
    }
  }

  // --------------------------------------------------------- встречный отжиг
  // С уровня 4, по одному району за такт, и только при несильном ветре.
  if (lvl >= 4 && s.weather.W <= 1.2) {
    const hot = s.ids.filter(
      (id) => s.districts[id].known && s.districts[id].B > 0.3 && s.districts[id].S > 5,
    );
    if (hot.length && rnd(s) < 0.12) {
      const id = pick(s, hot);
      const st = s.districts[id];
      st.B *= 1 - 0.3 * s.mods.backfireMult;
      s.events.push({ tick: s.tick, kind: 'suppress',
        text: `Встречный отжиг: ${districts[id].name}.` });
      // Отжиг при смене ветра уходит — это не условность, так бывает.
      if (rnd(s) < 0.25) {
        const ns = districts[id].neighbors;
        if (ns.length) {
          const n = pick(s, ns);
          const nst = s.districts[n.to];
          if (nst.F > 0.1) {
            nst.B = Math.max(nst.B, nst.B + 0.05);
            s.events.push({ tick: s.tick, kind: 'spread',
              text: `Отжиг ушёл: огонь перекинулся в ${districts[n.to].name}.` });
          }
        }
      }
    }
  }
}
