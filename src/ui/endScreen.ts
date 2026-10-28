import { BRONZE, GOLD, SILVER } from '../sim/tick';
import { EVOLUTIONS } from '../sim/evolutions';
import { SEASON_DAYS, SEASON_TICKS, TICKS_PER_DAY, formatDate } from '../sim/weather';
import type { District, DistrictId, WorldState } from '../sim/types';
import { activateDialog } from './dialog';
import { escapeHtml } from './html';
import { mountLeaderboard } from './leaderboardView';
import {
  LeaderboardError, buildEntry, leaderboard, loadPlayerName, savePlayerName, sanitizeName,
} from '../leaderboard';

const ha = (n: number) => Math.round(n).toLocaleString('ru');

const GRADE_TEXT: Record<string, [string, string]> = {
  gold: ['Золото', `Достигнут золотой рубеж: ${ha(GOLD)} га.`],
  silver: ['Серебро', `Достигнут серебряный рубеж: ${ha(SILVER)} га.`],
  bronze: ['Бронза', `Достигнут бронзовый рубеж: ${ha(BRONZE)} га.`],
};

interface EndOptions {
  best?: number;
  isRecord?: boolean;
  /** Стартовый сценарий партии — нужен для записи в таблицу лидеров. */
  scenario?: string;
}

export function showEndScreen(
  root: HTMLElement,
  s: WorldState,
  districts: Record<DistrictId, District>,
  onRestart: () => void,
  options: EndOptions = {},
): void {
  const el = document.createElement('div');
  el.className = 'modal end';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'end-title');

  const touched = s.ids.filter((id) => s.districts[id].ignited);
  const top = [...touched]
    .sort((a, b) => s.districts[b].burned - s.districts[a].burned)
    .slice(0, 6);

  const won = s.status === 'won';
  const [title, sub] = won && s.grade
    ? GRADE_TEXT[s.grade]
    : s.tick >= SEASON_TICKS
      ? ['Сезон закончен', `Порога в ${ha(BRONZE)} га взять не удалось.`]
      : ['Очаги ликвидированы', 'МЧС справилось до конца сезона.'];

  el.innerHTML = `
    <div class="sheet narrow">
      <header class="sheet-head">
        <div><b id="end-title" role="heading" aria-level="2" class="${won ? 'won' : 'lost'}">${title}</b><span>${sub}</span></div>
      </header>
      ${options.isRecord ? '<p class="record">Новый личный рекорд</p>' : ''}
      ${options.best !== undefined && options.best > 0 ? `<p class="best-score">Личный рекорд: ${ha(options.best)} га</p>` : ''}
      <dl class="stats">
        <div><dt>Выгорело</dt><dd class="big">${ha(s.totalBurned)} га</dd></div>
        <div><dt>Округов задето</dt><dd>${touched.length} из ${s.ids.length}</dd></div>
        <div><dt>Длительность сезона</dt><dd>${Math.min(SEASON_DAYS, Math.ceil(s.tick / TICKS_PER_DAY))} суток</dd></div>
        <div><dt>Эволюций куплено</dt><dd>${s.bought.length} из ${EVOLUTIONS.length}</dd></div>
        <div><dt>Эскалация к финалу</dt><dd>уровень ${s.escalation}</dd></div>
        <div><dt>Искр осталось</dt><dd>${Math.floor(s.sparks)}</dd></div>
        <div><dt>Дата завершения</dt><dd>${formatDate(s.tick)}</dd></div>
        <div><dt>Перебросов искр</dt><dd>${s.throws}</dd></div>
      </dl>
      <h4>Больше всего сгорело</h4>
      <ul class="top">
        ${top.map((id) => `<li><span>${districts[id].name.replace(' муниципальный округ', '')}</span>`
          + `<em>${ha(s.districts[id].burned)} га</em></li>`).join('')}
      </ul>
      ${leaderboard.enabled && options.scenario ? `
      <section class="lb-submit" aria-labelledby="lb-end-title">
        <h4 id="lb-end-title">Таблица лидеров</h4>
        <form class="lb-form" id="lbForm" novalidate>
          <label for="lbName">Имя игрока</label>
          <div class="lb-row">
            <input id="lbName" name="name" maxlength="24" autocomplete="nickname" value="${escapeHtml(loadPlayerName())}">
            <button type="submit" class="act" id="lbSend">Отправить результат</button>
          </div>
        </form>
        <p class="lb-status" id="lbStatus" role="status"></p>
        <div id="lbMountEnd"></div>
      </section>` : ''}
      <p class="thresholds">Пороги: бронза ${ha(BRONZE)} · серебро ${ha(SILVER)} · золото ${ha(GOLD)}</p>
      <button type="button" class="primary" id="restart">Новая партия</button>
    </div>`;

  root.appendChild(el);
  const releaseFocus = activateDialog(el, { initialFocus: '#restart' });
  const form = el.querySelector<HTMLFormElement>('#lbForm');
  if (form && options.scenario) {
    const scenario = options.scenario;
    const input = form.querySelector<HTMLInputElement>('#lbName')!;
    const send = form.querySelector<HTMLButtonElement>('#lbSend')!;
    const status = el.querySelector<HTMLElement>('#lbStatus')!;
    let sent = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sent) return;
      const name = sanitizeName(input.value);
      if (!name) {
        status.textContent = 'Введите имя игрока.';
        input.focus();
        return;
      }
      input.disabled = send.disabled = true;
      status.textContent = 'Отправка…';
      try {
        const id = await leaderboard.submit(buildEntry(s, scenario, name));
        sent = true;
        savePlayerName(name);
        form.hidden = true;
        status.textContent = `Результат записан: ${name} — ${ha(s.totalBurned)} га.`;
        mountLeaderboard(el.querySelector<HTMLElement>('#lbMountEnd')!,
          { scenario, highlightId: id, limit: 10 });
      } catch (err) {
        status.textContent = err instanceof LeaderboardError ? err.message : 'Не удалось отправить результат.';
        input.disabled = send.disabled = false;
      }
    });
  }

  el.querySelector('#restart')!.addEventListener('click', () => {
    releaseFocus();
    el.remove();
    onRestart();
  });
}
