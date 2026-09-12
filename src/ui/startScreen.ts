import { BRONZE, GOLD, SILVER } from '../sim/tick';
import { SCENARIOS, findStart } from '../sim/world';
import type { Scenario } from '../sim/world';
import type { District, DistrictId } from '../sim/types';

const ru = (n: number) => Math.round(n).toLocaleString('ru');

const FUEL = ['', 'тундра', 'северная тайга', 'средняя тайга', 'сосняк', 'лесостепь'];

/**
 * Экран выбора точки возгорания.
 *
 * Показывает не выдуманные «сложности», а реальные цифры округа из данных:
 * игрок выбирает старт по лесистости, населению и признаку зоны контроля —
 * то есть по тем же величинам, которыми потом управляет симуляция.
 */
export function showStartScreen(
  root: HTMLElement,
  districts: Record<DistrictId, District>,
  onPick: (scenario: Scenario, startId: DistrictId) => void,
): void {
  const el = document.createElement('div');
  el.className = 'modal start';

  const cards = SCENARIOS.map((sc) => {
    const id = findStart(districts, sc.match);
    const d = districts[id];
    const maxHa = d.area * d.forest * 100 * d.budget;
    return `
      <li class="scenario" data-id="${sc.id}">
        <div class="sc-head">
          <b>${sc.title}</b>
          ${d.ctrlZone ? '<span class="tag">зона контроля</span>' : ''}
        </div>
        <p class="sc-blurb">${sc.blurb}</p>
        <dl class="sc-stats">
          <div><dt>Площадь</dt><dd>${ru(d.area)} км²</dd></div>
          <div><dt>Лесистость</dt><dd>${Math.round(d.forest * 100)}%</dd></div>
          <div><dt>Горючее</dt><dd>${FUEL[d.fuelClass]}</dd></div>
          <div><dt>Население</dt><dd>${ru(d.pop)}</dd></div>
          <div><dt>Соседей</dt><dd>${d.neighbors.length}</dd></div>
          <div><dt>Потолок за сезон</dt><dd>${ru(maxHa)} га</dd></div>
        </dl>
        <span class="sc-go">Поджечь</span>
      </li>`;
  }).join('');

  el.innerHTML = `
    <div class="sheet">
      <header class="start-head">
        <h1>Чёрное небо</h1>
        <p>Вы — лесной пожар в Красноярском крае. Сезон идёт с 15 апреля
           по 30 сентября, потом приходит циклон. Выберите, где начать.</p>
      </header>
      <ul class="scenarios">${cards}</ul>
      <footer class="start-foot">
        <span>Бронза ${ru(BRONZE)} га · Серебро ${ru(SILVER)} га — сезон 2019 года ·
              Золото ${ru(GOLD)} га</span>
        <span class="hint">Пробел — пауза · E — дерево эволюций · клик по округу — сводка</span>
      </footer>
    </div>`;

  el.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.scenario');
    if (!card) return;
    const sc = SCENARIOS.find((s) => s.id === card.dataset.id)!;
    el.remove();
    onPick(sc, findStart(districts, sc.match));
  });

  root.appendChild(el);
}
