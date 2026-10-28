import { BRONZE, GOLD, SILVER } from '../sim/tick';
import { SCENARIOS, findStart } from '../sim/world';
import type { Scenario } from '../sim/world';
import type { District, DistrictId } from '../sim/types';
import { activateDialog } from './dialog';
import { leaderboard } from '../leaderboard';
import { mountLeaderboard } from './leaderboardView';

const ru = (n: number) => Math.round(n).toLocaleString('ru');

const FUEL = ['', 'тундра', 'северная тайга', 'средняя тайга', 'сосняк', 'лесостепь'];

interface StartOptions {
  resume?: { label: string; onResume: () => void };
  best?: number;
}

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
  options: StartOptions = {},
): void {
  const el = document.createElement('div');
  el.className = 'modal start';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'start-title');

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
        <button type="button" class="sc-go scenario-choice" aria-label="Начать: ${sc.title}">Поджечь</button>
      </li>`;
  }).join('');

  el.innerHTML = `
    <div class="sheet">
      <header class="start-head">
        <h1 id="start-title">Чёрное небо</h1>
        <p>Вы — лесной пожар в Красноярском крае. Сезон с 15 апреля по 30 сентября.</p>
      </header>
      ${options.resume ? '<div class="start-resume"><button type="button" class="primary" id="resume">Продолжить сезон</button><span id="resume-label"></span></div>' : ''}
      ${options.best !== undefined && options.best > 0 ? `<p class="best-score">Личный рекорд: ${ru(options.best)} га</p>` : ''}
      <ul class="scenarios">${cards}</ul>
      <section class="lb-view" id="lbView" hidden aria-labelledby="lb-title">
        <h2 id="lb-title" class="lb-title">Таблица лидеров</h2>
        <div id="lbMount"></div>
      </section>
      <footer class="start-foot">
        <span>Бронза ${ru(BRONZE)} га · Серебро ${ru(SILVER)} га — сезон 2019 года ·
              Золото ${ru(GOLD)} га</span>
        ${leaderboard.enabled ? '<button type="button" class="act lb-toggle" id="lbToggle" aria-expanded="false">Таблица лидеров</button>' : ''}
      </footer>
    </div>`;

  root.appendChild(el);
  const releaseFocus = activateDialog(el, { initialFocus: options.resume ? '#resume' : '.scenario-choice' });

  if (options.resume) {
    const resume = options.resume;
    el.querySelector('#resume-label')!.textContent = resume.label;
    el.querySelector('#resume')!.addEventListener('click', () => {
      releaseFocus();
      el.remove();
      resume.onResume();
    });
  }

  // Таблица лидеров открывается внутри этого же окна вместо карточек
  // сценариев: отдельное окно поверх конфликтовало бы с удержанием фокуса.
  const toggle = el.querySelector<HTMLButtonElement>('#lbToggle');
  if (toggle) {
    let mounted = false;
    toggle.addEventListener('click', () => {
      const view = el.querySelector<HTMLElement>('#lbView')!;
      const open = view.hidden;
      view.hidden = !open;
      el.querySelector<HTMLElement>('.scenarios')!.hidden = open;
      toggle.textContent = open ? 'К выбору старта' : 'Таблица лидеров';
      toggle.setAttribute('aria-expanded', String(open));
      if (open && !mounted) {
        mountLeaderboard(el.querySelector<HTMLElement>('#lbMount')!);
        mounted = true;
      }
    });
  }

  el.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('.scenario');
    if (!card) return;
    const sc = SCENARIOS.find((s) => s.id === card.dataset.id);
    if (!sc) return;
    releaseFocus();
    el.remove();
    onPick(sc, findStart(districts, sc.match));
  });
}
