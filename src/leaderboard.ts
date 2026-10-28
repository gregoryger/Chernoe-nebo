import { BRONZE, GOLD, SILVER } from './sim/tick';
import { SEASON_DAYS, TICKS_PER_DAY } from './sim/weather';
import { SCENARIOS } from './sim/world';
import type { WorldState } from './sim/types';

/**
 * Общая таблица лидеров на Supabase.
 *
 * GitHub Pages отдаёт только статичные файлы, поэтому результаты хранятся в
 * таблице Supabase и читаются через её REST API обычным fetch — без SDK, чтобы
 * не раздувать бандл. Публичный ключ проекта по замыслу Supabase виден всем:
 * права задают политики RLS в supabase/leaderboard.sql (только чтение и
 * добавление, без изменения и удаления), а ограничения таблицы отсекают
 * невозможные значения.
 */

export const NAME_MAX = 24;
export const NAME_KEY = 'chernoe-nebo.name.v1';
export const APP_VERSION = '0.2.0';

export type LeaderGrade = 'none' | 'bronze' | 'silver' | 'gold';

export interface LeaderboardEntry {
  name: string;
  scenario: string;
  burned: number;
  grade: LeaderGrade;
  days: number;
  districts: number;
  evolutions: number;
  version: string;
}

export interface LeaderboardRow extends LeaderboardEntry {
  id: number;
  created_at: string;
}

export class LeaderboardError extends Error {}

const SCENARIO_IDS = new Set(SCENARIOS.map((s) => s.id));
const GRADES = new Set<LeaderGrade>(['none', 'bronze', 'silver', 'gold']);

/** Имя игрока: без управляющих символов и лишних пробелов, не длиннее NAME_MAX. */
export function sanitizeName(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/** Ранг по выгоревшей площади — те же пороги, что в симуляции и в ограничении таблицы. */
export function gradeOf(burned: number): LeaderGrade {
  if (burned >= GOLD) return 'gold';
  if (burned >= SILVER) return 'silver';
  if (burned >= BRONZE) return 'bronze';
  return 'none';
}

/** Запись для отправки по итогам завершённой партии. */
export function buildEntry(s: WorldState, scenario: string, name: string): LeaderboardEntry {
  const burned = Math.round(s.totalBurned);
  return {
    name: sanitizeName(name),
    scenario,
    burned,
    grade: gradeOf(burned),
    days: Math.min(SEASON_DAYS, Math.max(1, Math.ceil(s.tick / TICKS_PER_DAY))),
    districts: s.ids.filter((id) => s.districts[id].ignited).length,
    evolutions: s.bought.length,
    version: APP_VERSION,
  };
}

/** Ответ сервера — недоверенные данные: строки с неожиданными полями отбрасываются. */
export function parseRows(data: unknown): LeaderboardRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is LeaderboardRow =>
    typeof r === 'object' && r !== null
    && Number.isInteger(r.id)
    && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= NAME_MAX
    && SCENARIO_IDS.has(r.scenario)
    && Number.isFinite(r.burned) && r.burned >= 0
    && GRADES.has(r.grade)
    && Number.isInteger(r.days)
    && typeof r.created_at === 'string');
}

type Fetch = typeof fetch;

export interface LeaderboardClient {
  readonly enabled: boolean;
  submit(entry: LeaderboardEntry): Promise<number>;
  top(scenario?: string, limit?: number): Promise<LeaderboardRow[]>;
}

const COLUMNS = 'id,created_at,name,scenario,burned,grade,days,districts,evolutions,version';

export function createLeaderboardClient(
  baseUrl: string | undefined,
  key: string | undefined,
  fetchImpl: Fetch = (...args) => fetch(...args),
  timeoutMs = 8000,
): LeaderboardClient {
  // Адрес проекта часто копируют вместе с путём REST API — он добавляется ниже сам.
  const url = (baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const apiKey = (key ?? '').trim();
  const enabled = Boolean(url && apiKey);

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { apikey: apiKey, 'Content-Type': 'application/json' };
    // Старый anon-ключ — это JWT и передаётся ещё и как Bearer. Новый
    // publishable-ключ (sb_publishable_…) не JWT: его достаточно в apikey.
    if (apiKey.startsWith('eyJ')) h.Authorization = `Bearer ${apiKey}`;
    return h;
  };

  async function request(path: string, init: RequestInit): Promise<unknown> {
    if (!enabled) throw new LeaderboardError('Таблица лидеров не настроена.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${url}/rest/v1/${path}`, {
        ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) }, signal: ctrl.signal,
      });
    } catch {
      throw new LeaderboardError('Нет связи с таблицей лидеров. Проверьте интернет и повторите.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new LeaderboardError(res.status === 429
        ? 'Слишком много запросов. Попробуйте через минуту.'
        : `Сервер таблицы лидеров ответил ошибкой ${res.status}.`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    enabled,
    async submit(entry) {
      if (!entry.name) throw new LeaderboardError('Введите имя игрока.');
      const data = await request('scores?select=id', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(entry),
      });
      const id = Array.isArray(data) ? (data[0] as { id?: unknown })?.id : undefined;
      if (!Number.isInteger(id)) throw new LeaderboardError('Сервер не подтвердил запись результата.');
      return id as number;
    },
    async top(scenario, limit = 20) {
      const filter = scenario && SCENARIO_IDS.has(scenario) ? `&scenario=eq.${scenario}` : '';
      const data = await request(
        `scores?select=${COLUMNS}&order=burned.desc,created_at.asc&limit=${limit}${filter}`,
        { method: 'GET' },
      );
      return parseRows(data);
    },
  };
}

export const leaderboard = createLeaderboardClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
);

export function loadPlayerName(): string {
  try { return sanitizeName(localStorage.getItem(NAME_KEY) ?? ''); } catch { return ''; }
}

export function savePlayerName(name: string): void {
  try { localStorage.setItem(NAME_KEY, sanitizeName(name)); } catch { /* приватный режим */ }
}
