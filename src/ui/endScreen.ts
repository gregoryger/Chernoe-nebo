import { BRONZE, GOLD, SILVER } from '../sim/tick';
import type { District, DistrictId, WorldState } from '../sim/types';

const ha = (n: number) => Math.round(n).toLocaleString('ru');

const GRADE_TEXT: Record<string, [string, string]> = {
  gold: ['Золото', 'Втрое больше, чем в рекордном 2019 году.'],
  silver: ['Серебро', 'Сезон 2019 года превзойдён.'],
  bronze: ['Бронза', 'Миллион гектаров. До рекорда не дотянули.'],
};

export function showEndScreen(
  root: HTMLElement,
  s: WorldState,
  districts: Record<DistrictId, District>,
  onRestart: () => void,
): void {
  const el = document.createElement('div');
  el.className = 'modal end';

  const touched = s.ids.filter((id) => s.districts[id].ignited);
  const burnedOut = s.ids.filter((id) => s.districts[id].F < 0.15);
  const top = [...touched]
    .sort((a, b) => s.districts[b].burned - s.districts[a].burned)
    .slice(0, 6);

  const won = s.status === 'won';
  const [title, sub] = won && s.grade
    ? GRADE_TEXT[s.grade]
    : s.tick >= 676
      ? ['Сезон закончен', `Порога в ${ha(BRONZE)} га взять не удалось.`]
      : ['Очаги ликвидированы', 'МЧС справилось до конца сезона.'];

  el.innerHTML = `
    <div class="sheet narrow">
      <header class="sheet-head">
        <div><b class="${won ? 'won' : 'lost'}">${title}</b><span>${sub}</span></div>
      </header>
      <div class="stats">
        <div><dt>Выгорело</dt><dd class="big">${ha(s.totalBurned)} га</dd></div>
        <div><dt>Округов задето</dt><dd>${touched.length} из ${s.ids.length}</dd></div>
        <div><dt>Выгорели дотла</dt><dd>${burnedOut.length}</dd></div>
        <div><dt>Эволюций куплено</dt><dd>${s.bought.length} из 17</dd></div>
        <div><dt>Максимум эскалации</dt><dd>уровень ${s.escalation}</dd></div>
        <div><dt>Искр собрано</dt><dd>${Math.floor(s.sparks + s.bought.length)}</dd></div>
      </div>
      <h4>Больше всего сгорело</h4>
      <ul class="top">
        ${top.map((id) => `<li><span>${districts[id].name.replace(' муниципальный округ', '')}</span>`
          + `<em>${ha(s.districts[id].burned)} га</em></li>`).join('')}
      </ul>
      <p class="thresholds">Пороги: бронза ${ha(BRONZE)} · серебро ${ha(SILVER)} · золото ${ha(GOLD)}</p>
      <button class="primary" id="restart">Новая партия</button>
    </div>`;

  root.appendChild(el);
  el.querySelector('#restart')!.addEventListener('click', () => {
    el.remove();
    onRestart();
  });
}
