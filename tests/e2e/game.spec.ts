import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Map as GameMap } from 'maplibre-gl';
import type { WorldState } from '../../src/sim/types';
import { BRONZE } from '../../src/sim/tick';
import { SEASON_TICKS } from '../../src/sim/weather';

type DevWindow = Window & typeof globalThis & { __state: WorldState; __map: GameMap; __mapErr?: string[] };

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page), 'Uncaught browser errors').toEqual([]);
});

async function currentTick(page: Page): Promise<number> {
  return page.evaluate(() => (window as DevWindow).__state.tick);
}

async function startGame(page: Page): Promise<void> {
  await page.goto('/');
  const start = page.getByRole('dialog', { name: 'Чёрное небо', exact: true });
  await expect(start).toBeVisible();
  await start.locator('.scenario-choice').first().click();
  await expect(start).toHaveCount(0);
  await expect(page.locator('#openTree')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean((window as DevWindow).__state))).toBe(true);
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return target !== null && element.contains(target);
  }), { message: 'The control must not be covered by another panel' }).toBe(true);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewportHeight + 1);
}

async function expectRenderedMap(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const map = (window as DevWindow).__map;
    return Boolean(map?.getLayer('fill') && map.getLayer('terrain') && map.getSource('districts'));
  })).toBe(true);

  await expect.poll(() => page.evaluate(() => {
    const map = (window as DevWindow).__map;
    return map.queryRenderedFeatures({ layers: ['fill'] }).length;
  })).toBeGreaterThan(0);

  // Read in the render callback before WebGL discards the drawing buffer.
  const pixels = await page.evaluate(() => new Promise<{ colors: number; colored: number; samples: number }>((resolve, reject) => {
    const map = (window as DevWindow).__map;
    const timeout = window.setTimeout(() => reject(new Error('Map did not render')), 8000);
    map.once('render', () => {
      window.clearTimeout(timeout);
      const canvas = map.getCanvas();
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) { reject(new Error('WebGL context is unavailable')); return; }
      const buffer = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      const colors = new Set<number>();
      let colored = 0;
      let samples = 0;
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          const i = (y * canvas.width + x) * 4;
          colors.add((buffer[i] << 16) | (buffer[i + 1] << 8) | buffer[i + 2]);
          if (buffer[i + 3] > 0 && Math.max(buffer[i], buffer[i + 1], buffer[i + 2]) > 30) colored++;
          samples++;
        }
      }
      resolve({ colors: colors.size, colored, samples });
    });
    map.triggerRepaint();
  }));
  expect(pixels.colors).toBeGreaterThan(10);
  expect(pixels.colored / pixels.samples).toBeGreaterThan(0.02);
  expect(await page.evaluate(() => (window as DevWindow).__mapErr ?? [])).toEqual([]);
}

test('keyboard start, pause, and game menu preserve the running game', async ({ page }) => {
  await page.goto('/');
  const firstScenario = page.locator('.scenario-choice').first();
  await expect(firstScenario).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  // последний элемент окна — кнопка таблицы лидеров в подвале
  await expect(page.locator('#lbToggle')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.scenario-choice').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(firstScenario).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#openMenu')).toBeVisible();
  await page.locator('[data-speed="3"]').click();
  await expect.poll(() => currentTick(page)).toBeGreaterThan(0);
  await page.locator('[data-speed="0"]').click();
  const pausedTick = await currentTick(page);
  await page.waitForTimeout(1200);
  expect(await currentTick(page)).toBe(pausedTick);

  await page.locator('#openMenu').click();
  const menu = page.getByRole('dialog', { name: 'Партия на паузе', exact: true });
  await expect(menu).toBeVisible();
  await page.locator('#continueGame').click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('#openMenu')).toBeFocused();
  expect(await currentTick(page)).toBe(pausedTick);
});

test('evolutions pause time and preserve keyboard focus after a purchase', async ({ page }) => {
  await startGame(page);
  await page.locator('[data-speed="3"]').click();
  await page.evaluate(() => { (window as DevWindow).__state.sparks = 100; });
  await page.locator('#openTree').click();
  const tree = page.getByRole('dialog', { name: 'Эволюция огня', exact: true });
  await expect(tree).toBeVisible();
  const pausedTick = await currentTick(page);
  await page.waitForTimeout(700);
  expect(await currentTick(page)).toBe(pausedTick);

  const purchase = page.locator('#evo-A1');
  await purchase.focus();
  await page.keyboard.press('Enter');
  await expect(purchase).toBeFocused();
  await expect(purchase).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => page.evaluate(() => (window as DevWindow).__state.bought)).toContain('A1');
  await expect(page.locator('#evo-A2')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#evo-A3')).toContainText('Верховой пожар');
  await page.keyboard.press('Escape');
  await expect(tree).toBeHidden();
  await expect(page.locator('#openTree')).toBeFocused();
  await expect.poll(() => currentTick(page)).toBeGreaterThan(pausedTick);
});

test('closed district panel remains closed on later simulation ticks', async ({ page }) => {
  await startGame(page);
  await page.locator('#districtSelect').selectOption({ index: 1 });
  await expect(page.locator('#panel')).toBeVisible();
  const neighbor = page.locator('.neighbor-link').first();
  const neighborId = await neighbor.getAttribute('data-id');
  await neighbor.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#districtSelect')).toHaveValue(neighborId!);
  await expect(page.locator('#closePanel')).toBeFocused();
  await page.locator('#closePanel').click();
  await expect(page.locator('#panel')).toBeHidden();
  await expect(page.locator('#districtSelect')).toBeFocused();
  await page.locator('[data-speed="3"]').click();
  const closedAt = await currentTick(page);
  await expect.poll(() => currentTick(page)).toBeGreaterThanOrEqual(closedAt + 3);
  await expect(page.locator('#panel')).toBeHidden();
  await expect(page.locator('#districtSelect')).toHaveValue('');
});

test('reload offers the saved season and resumes at the saved tick on pause', async ({ page }) => {
  await startGame(page);
  await page.locator('[data-speed="3"]').click();
  await expect.poll(() => currentTick(page)).toBeGreaterThanOrEqual(3);
  await page.locator('[data-speed="0"]').click();
  const before = await page.evaluate(() => ({
    tick: (window as DevWindow).__state.tick,
    burned: (window as DevWindow).__state.totalBurned,
    rng: (window as DevWindow).__state.rng,
  }));
  await page.reload();
  await expect(page.locator('#resume')).toBeVisible();
  await page.locator('#resume').click();
  await expect(page.locator('[data-speed="0"]')).toHaveAttribute('aria-pressed', 'true');
  const after = await page.evaluate(() => ({
    tick: (window as DevWindow).__state.tick,
    burned: (window as DevWindow).__state.totalBurned,
    rng: (window as DevWindow).__state.rng,
  }));
  expect(after).toEqual(before);
  await page.waitForTimeout(1100);
  expect(await currentTick(page)).toBe(before.tick);
});

test('starting a new season requires confirmation and cancelling preserves the save', async ({ page }) => {
  await startGame(page);
  await page.locator('[data-speed="3"]').click();
  await expect.poll(() => currentTick(page)).toBeGreaterThanOrEqual(3);
  await page.locator('#openMenu').click();
  const savedTick = await currentTick(page);
  await page.locator('#returnStart').click();
  await expect(page.locator('#resume')).toBeVisible();
  await page.locator('.scenario-choice').last().click();
  const confirm = page.getByRole('dialog', { name: 'Начать новый сезон?', exact: true });
  await expect(confirm).toBeVisible();
  await expect(page.locator('#cancelNew')).toBeFocused();
  await page.locator('#cancelNew').click();
  await expect(confirm).toHaveCount(0);
  await page.locator('#resume').click();
  expect(await currentTick(page)).toBe(savedTick);
  await expect(page.locator('[data-speed="0"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#openMenu').click();
  await page.locator('#returnStart').click();
  await page.locator('.scenario-choice').last().click();
  await page.locator('#confirmNew').click();
  await page.locator('[data-speed="0"]').click();
  expect(await currentTick(page)).toBe(0);
  await expect(page.locator('#openTree')).toBeVisible();
});

test('season completion records the result and returns to a clean new game', async ({ page }) => {
  await startGame(page);
  await page.locator('[data-speed="0"]').click();
  await page.evaluate(({ endTick, score }) => {
    const state = (window as DevWindow).__state;
    state.tick = endTick - 1;
    state.totalBurned = score;
    for (const id of state.ids) state.districts[id].burned = 0;
    const firstFire = state.ids.find((id) => state.districts[id].ignited)!;
    state.districts[firstFire].burned = score;
  }, { endTick: SEASON_TICKS, score: BRONZE + 1000 });
  await page.locator('[data-speed="3"]').click();
  const result = page.getByRole('dialog', { name: 'Бронза', exact: true });
  await expect(result).toBeVisible();
  await expect(result.locator('.record')).toHaveText('Новый личный рекорд');
  await expect(result.locator('.stats')).toContainText('30 сентября');
  await expect(result.locator('.stats')).toContainText('Искр осталось');
  await page.locator('#restart').click();
  await expect(page.getByRole('dialog', { name: 'Чёрное небо', exact: true })).toBeVisible();
  await expect(page.locator('#resume')).toHaveCount(0);
  await expect(page.locator('.best-score')).toBeVisible();
  await page.locator('.scenario-choice').first().click();
  await page.locator('[data-speed="0"]').click();
  expect(await currentTick(page)).toBe(0);
  expect(await page.evaluate(() => (window as DevWindow).__state.bought)).toEqual([]);
});

test('failed world data loading can be retried', async ({ page }) => {
  let fail = true;
  await page.route('**/data/districts.meta.json', async (route) => {
    if (fail) await route.fulfill({ status: 503, body: 'Unavailable' });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('#retryBoot')).toBeVisible();
  fail = false;
  await page.locator('#retryBoot').click();
  await expect(page.getByRole('dialog', { name: 'Чёрное небо', exact: true })).toBeVisible();
  await page.locator('.scenario-choice').first().click();
  await expect(page.locator('#openTree')).toBeVisible();
});

test('local map remains visible and playable when satellite tiles are unavailable', async ({ page }) => {
  await page.route('https://server.arcgisonline.com/**', (route) => route.abort());
  await startGame(page);
  await page.locator('[data-speed="0"]').click();
  await expectRenderedMap(page);
  await page.locator('#districtSelect').selectOption({ index: 1 });
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#retryBoot')).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`viewport ${viewport.width}x${viewport.height} keeps the map and controls usable`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const start = page.getByRole('dialog', { name: 'Чёрное небо', exact: true });
    await expect(start).toBeVisible();
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('start.png') });
    await page.locator('.scenario-choice').first().click();
    await page.locator('[data-speed="0"]').click();
    await expectRenderedMap(page);
    const overviewZoom = await page.evaluate(() => (window as DevWindow).__map.getZoom());
    await expectNoPageOverflow(page);
    for (const selector of ['#openMenu', '#districtSelect', '#resetMap', '#openTree', '[data-speed="0"]']) {
      await expectInsideViewport(page, page.locator(selector));
    }
    await page.screenshot({ path: testInfo.outputPath('game.png') });

    await page.locator('#openTree').click();
    await expectInsideViewport(page, page.locator('#closeTree'));
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('evolutions.png') });
    await page.locator('#evo-V6').scrollIntoViewIfNeeded();
    await expectInsideViewport(page, page.locator('#evo-V6'));
    await page.keyboard.press('Escape');

    await page.locator('#districtSelect').selectOption({ index: 1 });
    await expectInsideViewport(page, page.locator('#closePanel'));
    await expect.poll(() => page.evaluate(() => (window as DevWindow).__map.getZoom())).toBeGreaterThan(overviewZoom);
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('district.png') });
    await page.locator('#closePanel').click();
    await page.locator('#resetMap').click();
    await expect.poll(() => page.evaluate(() => (window as DevWindow).__map.getZoom())).toBeCloseTo(overviewZoom, 4);
  });
}

const LEADERS = 'https://leaderboard.test/rest/v1/scores**';
const leaderRow = (over: Record<string, unknown>) => ({
  id: 1, created_at: '2026-10-20T10:00:00Z', name: 'Аня', scenario: 'evenkia', burned: 3_100_000,
  grade: 'silver', days: 169, districts: 14, evolutions: 7, version: '0.2.0', ...over,
});

async function finishSeason(page: Page, score: number): Promise<void> {
  await page.locator('[data-speed="0"]').click();
  await page.evaluate(({ endTick, value }) => {
    const state = (window as DevWindow).__state;
    state.tick = endTick - 1;
    state.totalBurned = value;
    for (const id of state.ids) state.districts[id].burned = 0;
    const firstFire = state.ids.find((id) => state.districts[id].ignited)!;
    state.districts[firstFire].burned = value;
  }, { endTick: SEASON_TICKS, value: score });
  await page.locator('[data-speed="3"]').click();
}

test('leaderboard opens from the start screen and records a finished season', async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  let rows = [leaderRow({ name: '<b>x</b><img src=x>' })];
  await page.route(LEADERS, async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postDataJSON());
      rows = [...rows, leaderRow({ id: 77, name: posted[0].name, burned: posted[0].burned, grade: 'bronze' })];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 77 }]) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
  });

  await page.goto('/');
  const start = page.getByRole('dialog', { name: 'Чёрное небо', exact: true });
  await start.locator('#lbToggle').click();
  await expect(start.locator('.lb-table')).toBeVisible();
  await expect(start.locator('.scenarios')).toBeHidden();
  // имя с сервера выводится как текст, а не как разметка
  await expect(start.locator('.lb-name').first()).toHaveText('<b>x</b><img src=x>');
  await expect(start.locator('.lb-table img')).toHaveCount(0);
  await start.locator('#lbToggle').click();
  await expect(start.locator('.scenarios')).toBeVisible();

  await startGame(page);
  await finishSeason(page, BRONZE + 1000);
  const result = page.getByRole('dialog', { name: 'Бронза', exact: true });
  await expect(result).toBeVisible();
  await result.locator('#lbName').fill('  Гриша  ');
  await result.locator('#lbSend').click();
  await expect(result.locator('#lbStatus')).toContainText('Результат записан: Гриша');
  expect(posted).toHaveLength(1);
  // последний такт успевает дожечь несколько гектаров, поэтому сверяемся с
  // итоговым состоянием партии, а не с подставленным значением
  const finalBurned = await page.evaluate(() => Math.round((window as DevWindow).__state.totalBurned));
  expect(finalBurned).toBeGreaterThanOrEqual(BRONZE + 1000);
  expect(posted[0]).toMatchObject({ name: 'Гриша', scenario: 'evenkia', burned: finalBurned, grade: 'bronze' });
  await expect(result.locator('.lb-table tr.mine .lb-name')).toHaveText('Гриша');
  await expect(result.locator('#lbForm')).toBeHidden();
});

test('a failed leaderboard submission can be retried', async ({ page }) => {
  let fail = true;
  await page.route(LEADERS, async (route) => {
    if (route.request().method() === 'POST' && fail) {
      await route.fulfill({ status: 500, body: '{}' });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[{"id":5}]' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
  });
  await startGame(page);
  await finishSeason(page, 1000);
  const result = page.getByRole('dialog', { name: 'Сезон закончен', exact: true });
  await expect(result).toBeVisible();
  await result.locator('#lbName').fill('Гриша');
  await result.locator('#lbSend').click();
  await expect(result.locator('#lbStatus')).toContainText('ошибкой 500');
  await expect(result.locator('#lbSend')).toBeEnabled();
  fail = false;
  await result.locator('#lbSend').click();
  await expect(result.locator('#lbStatus')).toContainText('Результат записан');
  await expect(result.locator('.lb-empty')).toHaveText('Пока нет результатов — станьте первым.');
});
