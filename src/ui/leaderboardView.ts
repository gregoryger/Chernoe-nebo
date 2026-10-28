import { LeaderboardError, leaderboard } from '../leaderboard';
import type { LeaderGrade, LeaderboardClient, LeaderboardRow } from '../leaderboard';
import { SCENARIOS } from '../sim/world';
import { escapeHtml } from './html';

const GRADE_LABEL: Record<LeaderGrade, string> = {
  gold: 'золото', silver: 'серебро', bronze: 'бронза', none: '—',
};
const ha = (n: number) => Math.round(n).toLocaleString('ru');
const scenarioTitle = (id: string) => SCENARIOS.find((s) => s.id === id)?.title ?? id;
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru');
};

/** Таблица результатов; строка highlightId помечается как своя. */
export function renderRows(rows: LeaderboardRow[], highlightId?: number): string {
  if (!rows.length) return '<p class="lb-empty">Пока нет результатов — станьте первым.</p>';
  return `
    <table class="lb-table">
      <thead><tr><th>№</th><th>Игрок</th><th>Старт</th><th>Выгорело, га</th><th>Ранг</th><th class="lb-date">Дата</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="${r.id === highlightId ? 'mine' : ''}">
          <td>${i + 1}</td>
          <td class="lb-name">${escapeHtml(r.name)}</td>
          <td>${escapeHtml(scenarioTitle(r.scenario))}</td>
          <td class="lb-num">${ha(r.burned)}</td>
          <td class="lb-grade g-${r.grade}">${GRADE_LABEL[r.grade]}</td>
          <td class="lb-date">${day(r.created_at)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

interface MountOptions {
  scenario?: string;
  highlightId?: number;
  limit?: number;
  client?: LeaderboardClient;
}

/**
 * Встраивает таблицу лидеров в контейнер внутри уже открытого окна. Отдельного
 * модального окна нет намеренно: activateDialog удерживает фокус во внешнем
 * окне и отбирал бы его у вложенного.
 */
export function mountLeaderboard(container: HTMLElement, options: MountOptions = {}) {
  const client = options.client ?? leaderboard;
  let scenario = options.scenario ?? '';
  let highlightId = options.highlightId;
  let request = 0;

  container.innerHTML = `
    <div class="lb-filters" role="group" aria-label="Стартовая точка">
      <button type="button" class="lb-filter" data-scenario="">Все старты</button>
      ${SCENARIOS.map((s) => `<button type="button" class="lb-filter" data-scenario="${s.id}">${escapeHtml(s.title)}</button>`).join('')}
    </div>
    <div class="lb-body" aria-live="polite"></div>`;
  const body = container.querySelector<HTMLElement>('.lb-body')!;

  const markFilter = () => {
    container.querySelectorAll<HTMLButtonElement>('.lb-filter').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.scenario === scenario));
    });
  };

  async function load(): Promise<void> {
    const id = ++request;
    markFilter();
    body.innerHTML = '<p class="lb-empty">Загрузка таблицы…</p>';
    try {
      const rows = await client.top(scenario || undefined, options.limit ?? 20);
      if (id !== request) return;              // успел смениться фильтр
      body.innerHTML = renderRows(rows, highlightId);
    } catch (err) {
      if (id !== request) return;
      const text = err instanceof LeaderboardError ? err.message : 'Не удалось загрузить таблицу.';
      body.innerHTML = `<p class="lb-error">${escapeHtml(text)}</p>
        <button type="button" class="act lb-retry">Повторить</button>`;
    }
  }

  container.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const filter = target?.closest<HTMLButtonElement>('.lb-filter');
    if (filter) {
      scenario = filter.dataset.scenario ?? '';
      void load();
    } else if (target?.closest('.lb-retry')) {
      void load();
    }
  });

  void load();
  return {
    reload(next?: { scenario?: string; highlightId?: number }) {
      if (next?.scenario !== undefined) scenario = next.scenario;
      if (next?.highlightId !== undefined) highlightId = next.highlightId;
      return load();
    },
  };
}
