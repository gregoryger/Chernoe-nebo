import { rnd } from './rng';
import { stepResponse } from './response';
import { SEASON_TICKS, TICKS_PER_DAY, stepWeather } from './weather';
import type { District, DistrictId, Grade, WorldState } from './types';

/**
 * Доля горючего, выгорающая за такт при полном охвате.
 *
 * 0.03 означало, что за 672 такта сезона выгорает вообще всё, куда дошёл
 * огонь: распределение упиралось в потолок независимо от того, где этот
 * потолок стоял. При 0.003 сезона хватает лишь на часть запаса, и итог
 * начинает зависеть от того, сколько округов успели охватить и как рано.
 */
const CONSUME = 0.00074;
/** Искр за 10 000 га. */
const HA_PER_SPARK = 10_000;
/** Искр за каждый впервые загоревшийся район. */
const SPARK_PER_DISTRICT = 10;

/*
 * Пороги калиброваны по прогону, а не выбраны заранее.
 *
 * Распределение исходов бимодально: между p25 и p50 девятнадцатикратный
 * разрыв — это доля партий, где огонь так и не вышел за стартовый округ.
 * Подобрать три порога, одновременно попадающих в целевые доли рангов, на
 * такой форме невозможно, поэтому шкала привязана к якорю: серебро — это
 * рекордный сезон 2019 года (~2.6 млн га), и медиана удачной партии сведена
 * к нему множителем CONSUME. Бронза и золото поставлены по p25 и p85
 * измеренного распределения.
 */
export const GOLD = 5_500_000;
export const SILVER = 2_600_000;
export const BRONZE = 500_000;

function gradeFor(ha: number): Grade {
  if (ha >= GOLD) return 'gold';
  if (ha >= SILVER) return 'silver';
  if (ha >= BRONZE) return 'bronze';
  return null;
}

/**
 * Один такт мира — 6 игровых часов.
 *
 * Функция МУТИРУЕТ переданное состояние и возвращает его же. В ТЗ значился
 * чистый `tick(state) => state`, но на балансировке гоняется 1000 партий по
 * 672 такта на 39 районов — это 26 млн обновлений, и клонирование состояния
 * на каждом такте съедало бы весь бюджет прогона. Воспроизводимость, ради
 * которой чистота и затевалась, обеспечивается не копированием, а тем, что
 * весь недетерминизм идёт через seed в state.rng: партия восстанавливается
 * из пары «seed + список действий».
 */
export function tick(s: WorldState, districts: Record<DistrictId, District>): WorldState {
  if (s.status !== 'running') return s;

  s.tick++;
  stepWeather(s);

  const w = s.weather;
  const hourOfDay = s.tick % TICKS_PER_DAY;
  const night = hourOfDay === 2 || hourOfDay === 3 ? s.mods.nightPenalty : 1;

  // ------------------------------------------------- горение внутри районов
  let sparksGained = 0;

  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i];
    const st = s.districts[id];
    const d = districts[id];

    if (st.B > 0.0001) {
      // «Верховой пожар» уже учтён в mods.r, но кроны есть только в тайге —
      // в тундре и лесостепи прибавку снимаем.
      const r = s.mods.crownFire && d.fuelClass < 3 ? s.mods.r / 1.4 : s.mods.r;

      // sizeFactor здесь НЕ применяется: за «гигантский округ не выгорает
      // целиком» отвечает d.budget в пересчёте гектаров. Два механизма на одну
      // задачу душили крупные округа вдвойне.
      const growth = st.B * r * st.F * d.k * w.W * w.D * night * (1 - st.B);

      // Минполоса не гасит очаг, а мешает ему расти вширь.
      const lineDrag = st.minLine >= 1 ? 0.75 * s.mods.minLineMult + (1 - s.mods.minLineMult) : 1;
      const decay = st.B * s.mods.e * st.S;

      st.B = Math.max(0, Math.min(1, st.B + growth * lineDrag - decay));

      // Торфяной пожар: очаг уходит под землю и не гаснет совсем.
      if (s.mods.peat && st.ignited && st.F > 0.02 && st.B < 0.02) st.B = 0.02;

      // ------------------------------------------------------- выгорание
      const consumed = Math.min(st.F, st.B * CONSUME * st.F);
      st.F -= consumed;
      const ha = consumed * d.area * d.forest * 100 * d.budget;
      st.burned += ha;
      s.totalBurned += ha;

      let mult = s.mods.damageMult;
      if (s.mods.villageThreat && d.pop >= 5000) mult *= 3;
      sparksGained += (ha / HA_PER_SPARK) * mult;

      // --------------------------------------------------------- дым
      if (s.mods.smokeOn) {
        st.smoke = Math.min(1, st.smoke * 0.96 + st.B * 0.12);
      }
    } else {
      st.smoke *= 0.9;
      // «Тление»: потушенный район может вспыхнуть заново.
      if (s.mods.smolder > 0 && st.ignited && st.F > 0.05 && rnd(s) < s.mods.smolder) {
        st.B = 0.01;
        s.events.push({ tick: s.tick, kind: 'ignite',
          text: `Тлеющий очаг разгорелся снова: ${d.name}.` });
      }
    }

    if (w.event === 'rain' && !s.mods.peat) st.B *= 0.6;
    if (w.event === 'cyclone' && !s.mods.peat) st.B *= 0.75;
  }

  // --------------------------------------------------------- «Чёрное небо»
  if (s.mods.blackSky) {
    for (const id of s.ids) {
      if (districts[id].pop >= 100_000 && s.districts[id].smoke > 0.5) {
        sparksGained += 2;
        if (!s.flags.blackSky) {
          s.flags.blackSky = true;
          s.events.push({ tick: s.tick, kind: 'escalate',
            text: `Режим НМУ: ${districts[id].name} под дымом. «Чёрное небо».` });
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------- переброс
  // Копим намерения и применяем после обхода: иначе район, обойдённый раньше,
  // успевал бы поджечь соседа и тот в этом же такте поджигал бы следующего.
  const ignitions: { id: DistrictId; from: string }[] = [];

  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i];
    const st = s.districts[id];
    if (st.B <= 0.01) continue;
    const d = districts[id];

    for (const e of d.neighbors) {
      const dst = s.districts[e.to];
      if (dst.B > 0.01 || dst.F < 0.05) continue;

      const barrier = Math.min(0.6,
        e.river * s.mods.riverBarrierMult
        + e.road * s.mods.roadBarrierMult
        + (dst.minLine >= 1 ? 0.5 * s.mods.minLineMult : 0));

      const align = 0.4 + 0.6 * Math.max(0, Math.cos(e.bearing - w.windDir));
      const p = st.B * s.mods.tau * e.w * align * (1 - barrier) * dst.F * w.W;

      if (rnd(s) < p) ignitions.push({ id: e.to, from: d.name });
    }

    // «Пятнистость»: головни перелетают через район по ветру.
    if (s.mods.spotting && st.B > 0.25) {
      for (const e of d.neighbors) {
        for (const e2 of districts[e.to].neighbors) {
          const far = s.districts[e2.to];
          if (e2.to === id || far.B > 0.01 || far.F < 0.05) continue;
          const align = 0.4 + 0.6 * Math.max(0, Math.cos(e2.bearing - w.windDir));
          if (align < 0.8) continue;
          if (rnd(s) < st.B * s.mods.tau * 0.15 * align * far.F) {
            ignitions.push({ id: e2.to, from: `${d.name} (перенос искр)` });
          }
        }
      }
    }
  }

  for (const ig of ignitions) {
    const st = s.districts[ig.id];
    if (st.B > 0.01) continue;
    st.B = Math.max(st.B, 0.01);
    if (!st.ignited) {
      st.ignited = true;
      sparksGained += SPARK_PER_DISTRICT;
    }
    s.events.push({ tick: s.tick, kind: 'spread',
      text: `Огонь перешёл в ${districts[ig.id].name} из ${ig.from}.` });
  }

  // Сухая гроза поджигает случайный лесной район.
  if (w.event === 'storm' && w.eventTicks === 2) {
    const candidates = s.ids.filter(
      (id) => districts[id].forest > 0.4 && s.districts[id].B < 0.005 && s.districts[id].F > 0.3,
    );
    if (candidates.length) {
      const id = candidates[Math.floor(rnd(s) * candidates.length)];
      s.districts[id].B = 0.005;
      if (!s.districts[id].ignited) {
        s.districts[id].ignited = true;
        sparksGained += SPARK_PER_DISTRICT;
      }
      s.events.push({ tick: s.tick, kind: 'ignite',
        text: `Молния зажгла лес: ${districts[id].name}.` });
    }
  }

  s.sparks += sparksGained;

  // Лента новостей не должна расти бесконечно: на headless-прогоне это
  // десятки тысяч записей на партию и заметная доля времени на GC.
  if (s.events.length > 300) s.events.splice(0, s.events.length - 200);

  stepResponse(s, districts);

  // ------------------------------------------------------------- завершение
  let totalB = 0;
  for (let i = 0; i < s.ids.length; i++) totalB += s.districts[s.ids[i]].B;

  // Поражение от ликвидации очагов засчитывается только ДО циклона. Циклон —
  // штатный конец сезона, он гасит всё по краю: без этой оговорки партия с
  // пятью миллионами гектаров заканчивалась «все очаги потушены, поражение».
  const cycloneCame = s.weather.event === 'cyclone';

  if (totalB < 1e-6 && s.tick > 6 && !cycloneCame) {
    s.status = 'lost';
    s.grade = null;
    s.events.push({ tick: s.tick, kind: 'end',
      text: `Все очаги ликвидированы. Выгорело ${Math.round(s.totalBurned).toLocaleString('ru')} га.` });
  } else if (s.tick >= SEASON_TICKS) {
    const g = gradeFor(s.totalBurned);
    s.status = g ? 'won' : 'lost';
    s.grade = g;
    s.events.push({ tick: s.tick, kind: 'end',
      text: `Сезон закончен. Выгорело ${Math.round(s.totalBurned).toLocaleString('ru')} га.` });
  }

  return s;
}
