import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LeaderboardError, NAME_MAX, buildEntry, createLeaderboardClient, gradeOf, parseRows, sanitizeName,
} from '../src/leaderboard';
import { BRONZE, GOLD, SILVER } from '../src/sim/tick';
import { createWorld, findStart, loadDistricts } from '../src/sim/world';
import type { RawDistrict } from '../src/sim/world';

const raw = JSON.parse(readFileSync('data/districts.meta.json', 'utf-8')) as Record<string, RawDistrict>;
const districts = loadDistricts(raw);

const URL = 'https://demo.supabase.co';

function fakeFetch(response: { status?: number; body?: unknown } | Error) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    const status = response.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(response.body ?? []), { status });
  });
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, created_at: '2026-10-28T10:00:00Z', name: 'Гриша', scenario: 'boguchany',
  burned: 3_000_000, grade: 'silver', days: 169, districts: 12, evolutions: 6, version: '0.2.0', ...over,
});

describe('подготовка записи', () => {
  it('имя очищается от управляющих символов и лишних пробелов', () => {
    expect(sanitizeName('  Гриша \u0007  Г.  ')).toBe('Гриша Г.');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(NAME_MAX);
    expect(sanitizeName('   ')).toBe('');
  });

  it('ранг совпадает с порогами игры', () => {
    expect(gradeOf(BRONZE - 1)).toBe('none');
    expect(gradeOf(BRONZE)).toBe('bronze');
    expect(gradeOf(SILVER)).toBe('silver');
    expect(gradeOf(GOLD)).toBe('gold');
  });

  it('запись по итогам партии укладывается в ограничения таблицы', () => {
    const s = createWorld(districts, findStart(districts, 'Богучанский'), 7);
    s.tick = 676;
    s.totalBurned = 2_600_000.4;
    s.bought = ['A1', 'A2'];
    const e = buildEntry(s, 'boguchany', '  Гриша  ');
    expect(e).toMatchObject({ name: 'Гриша', scenario: 'boguchany', burned: 2_600_000, grade: 'silver', evolutions: 2 });
    expect(e.days).toBeGreaterThanOrEqual(1);
    expect(e.days).toBeLessThanOrEqual(169);
    expect(e.districts).toBeGreaterThanOrEqual(1);
  });
});

describe('ответ сервера', () => {
  it('строки с неожиданными полями отбрасываются', () => {
    const rows = parseRows([
      row(), row({ id: 'x' }), row({ scenario: 'mars' }), row({ grade: 'platinum' }),
      row({ name: '' }), null, 'garbage',
    ]);
    expect(rows).toHaveLength(1);
    expect(parseRows({ not: 'an array' })).toEqual([]);
  });
});

describe('клиент Supabase', () => {
  it('без адреса и ключа таблица выключена', async () => {
    const c = createLeaderboardClient('', '', fakeFetch({}));
    expect(c.enabled).toBe(false);
    await expect(c.top()).rejects.toBeInstanceOf(LeaderboardError);
  });

  it('отправка: POST в scores с ключом и возвратом id', async () => {
    const f = fakeFetch({ status: 201, body: [{ id: 42 }] });
    const c = createLeaderboardClient(`${URL}/`, 'sb_publishable_test', f);
    const s = createWorld(districts, findStart(districts, 'Богучанский'), 1);
    const id = await c.submit(buildEntry(s, 'boguchany', 'Гриша'));
    expect(id).toBe(42);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe(`${URL}/rest/v1/scores?select=id`);
    const headers = init!.headers as Record<string, string>;
    expect(init!.method).toBe('POST');
    expect(headers.apikey).toBe('sb_publishable_test');
    expect(headers.Prefer).toBe('return=representation');
    // publishable-ключ не JWT и не должен уходить как Bearer
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(init!.body))).toMatchObject({ name: 'Гриша', scenario: 'boguchany' });
  });

  it('адрес, скопированный вместе с /rest/v1/, не удваивает путь', async () => {
    const f = fakeFetch({ body: [] });
    await createLeaderboardClient(`${URL}/rest/v1/`, 'k', f).top();
    expect(String(f.mock.calls[0][0]).startsWith(`${URL}/rest/v1/scores?`)).toBe(true);
  });

  it('старый anon-ключ (JWT) передаётся и как Bearer', async () => {
    const f = fakeFetch({ body: [] });
    await createLeaderboardClient(URL, 'eyJhbGciOi.test.sig', f).top();
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer eyJhbGciOi.test.sig');
  });

  it('пустое имя не отправляется', async () => {
    const f = fakeFetch({ body: [{ id: 1 }] });
    const s = createWorld(districts, findStart(districts, 'Богучанский'), 1);
    await expect(createLeaderboardClient(URL, 'k', f).submit(buildEntry(s, 'boguchany', '  ')))
      .rejects.toThrow('Введите имя');
    expect(f).not.toHaveBeenCalled();
  });

  it('топ: сортировка по площади, фильтр только по известному сценарию', async () => {
    const f = fakeFetch({ body: [row(), row({ id: 2, burned: 100 })] });
    const c = createLeaderboardClient(URL, 'k', f);
    const rows = await c.top('evenkia', 10);
    expect(rows).toHaveLength(2);
    const first = String(f.mock.calls[0][0]);
    expect(first).toContain('order=burned.desc,created_at.asc');
    expect(first).toContain('limit=10');
    expect(first).toContain('scenario=eq.evenkia');
    await c.top('mars; drop table');
    expect(String(f.mock.calls[1][0])).not.toContain('scenario=');
  });

  it('ошибки сервера и сети превращаются в понятные сообщения', async () => {
    await expect(createLeaderboardClient(URL, 'k', fakeFetch({ status: 429 })).top())
      .rejects.toThrow('Слишком много запросов');
    await expect(createLeaderboardClient(URL, 'k', fakeFetch({ status: 500 })).top())
      .rejects.toThrow('ошибкой 500');
    await expect(createLeaderboardClient(URL, 'k', fakeFetch(new TypeError('offline'))).top())
      .rejects.toThrow('Нет связи');
  });
});
