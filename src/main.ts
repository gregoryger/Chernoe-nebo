import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { MapView } from './map/mapView';
import { EVOLUTIONS, canBuy } from './sim/evolutions';
import { tick } from './sim/tick';
import { buy, createWorld, emberThrow, loadDistricts, SCENARIOS, setFocus } from './sim/world';
import type { RawDistrict } from './sim/world';
import { formatDate } from './sim/weather';
import { GameStorage } from './storage';
import { Hud } from './ui/hud';
import { TreeView } from './ui/tree';
import { activateDialog } from './ui/dialog';
import { icon } from './ui/icons';
import { showEndScreen } from './ui/endScreen';
import { showStartScreen } from './ui/startScreen';
import type { DistrictId, WorldState } from './sim/types';
import type * as GeoJSON from 'geojson';

const SPEED_MS = [0, 1000, 500, 200];
const uiRoot = document.getElementById('ui')!;

async function fetchData<T>(file: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${file}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Не загружен ${file}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function boot(): Promise<void> {
  uiRoot.innerHTML = '<div class="loading-screen" role="status"><b>Чёрное небо</b><span>Загрузка карты края…</span></div>';
  const [geojson, meta, rivers, outline] = await Promise.all([
    fetchData<GeoJSON.FeatureCollection>('districts.geojson'),
    fetchData<Record<string, RawDistrict>>('districts.meta.json'),
    fetchData<GeoJSON.FeatureCollection>('rivers.geojson'),
    fetchData<GeoJSON.FeatureCollection>('krai_outline.geojson'),
  ]);
  const districts = loadDistricts(meta);
  const mapView = new MapView('map', geojson, districts, rivers, outline);
  const hud = new Hud(uiRoot);
  const tree = new TreeView(uiRoot);
  const storage = new GameStorage();
  let state: WorldState | undefined;
  let scenario = SCENARIOS[0].id;
  let speed = 0;
  let lastSpeed = 1;
  let timer = 0;
  let selected: DistrictId | null = null;
  let treeResume = 0;
  let menu: HTMLElement | undefined;
  let mapFailed = false;

  function persist(): void {
    if (state?.status === 'running') hud.saveStatus(storage.save(state, scenario));
  }

  function redraw(): void {
    if (!state) return;
    if (import.meta.env.DEV) (window as unknown as { __state: WorldState }).__state = state;
    hud.focusLabel = state.focus ? districts[state.focus].name.replace(' муниципальный округ', '') : 'не задан';
    mapView.sync(state);
    hud.update(state, EVOLUTIONS.filter((e) => canBuy(e.id, state!.bought, state!.sparks)).length);
    tree.render(state);
    if (selected) hud.showPanel(districts[selected], state, districts);
  }

  function stop(): void {
    window.clearInterval(timer);
    timer = 0;
  }

  function applySpeed(next: number): void {
    if (!Number.isInteger(next) || next < 0 || next >= SPEED_MS.length) return;
    speed = mapFailed ? 0 : next;
    if (speed > 0) lastSpeed = speed;
    stop();
    hud.setSpeed(speed);
    if (speed > 0 && state?.status === 'running' && !document.hidden) {
      timer = window.setInterval(step, SPEED_MS[speed]);
    }
  }

  function clearSelection(): void {
    selected = null;
    mapView.select(null);
    hud.hidePanel();
  }

  function step(): void {
    if (!state || state.status !== 'running') return;
    tick(state, districts);
    redraw();
    if (state.status !== 'running') {
      applySpeed(0);
      tree.hide();
      clearSelection();
      storage.clear();
      showEndScreen(uiRoot, state, districts, start, { ...storage.record(state.totalBurned), scenario });
    } else if (state.tick % 4 === 0) persist();
  }

  function launch(next: WorldState, scenarioId: string, resumed = false): void {
    state = next;
    scenario = scenarioId;
    uiRoot.classList.add('playing');
    redraw();
    mapView.resetView();
    applySpeed(resumed ? 0 : 1);
    persist();
  }

  function confirmNewGame(onConfirm: () => void): void {
    const el = document.createElement('div');
    el.className = 'modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'confirm-title');
    el.innerHTML = '<div class="sheet narrow"><h2 id="confirm-title">Начать новый сезон?</h2><p>Текущее сохранение будет заменено.</p><div class="menu-actions"><button class="primary" id="confirmNew">Начать новый сезон</button><button class="act" id="cancelNew">Назад</button></div></div>';
    uiRoot.append(el);
    const close = () => { release(); el.remove(); };
    const release = activateDialog(el, { onClose: () => { close(); start(); }, initialFocus: '#cancelNew' });
    el.querySelector('#confirmNew')!.addEventListener('click', () => { close(); onConfirm(); });
    el.querySelector('#cancelNew')!.addEventListener('click', () => { close(); start(); });
  }

  function start(): void {
    applySpeed(0);
    treeResume = 0;
    tree.hide();
    state = undefined;
    clearSelection();
    uiRoot.classList.remove('playing', 'feed-open');
    const saved = storage.load(districts);
    const title = saved ? SCENARIOS.find((s) => s.id === saved.scenario)!.title : '';
    showStartScreen(uiRoot, districts, (sc, startId) => {
      const begin = () => launch(createWorld(districts, startId, Date.now()), sc.id);
      if (saved) confirmNewGame(begin);
      else begin();
    }, {
      best: storage.best(),
      resume: saved ? {
        label: `${title} · ${formatDate(saved.state.tick)} · ${Math.round(saved.state.totalBurned).toLocaleString('ru')} га`,
        onResume: () => launch(saved.state, saved.scenario, true),
      } : undefined,
    });
  }

  function openMenu(): void {
    if (!state || state.status !== 'running' || menu) return;
    const previousSpeed = speed;
    applySpeed(0);
    persist();
    menu = document.createElement('div');
    menu.className = 'modal game-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-labelledby', 'menu-title');
    menu.innerHTML = `<div class="sheet narrow">
      <header class="sheet-head"><div><b id="menu-title">Партия на паузе</b><span>${SCENARIOS.find((s) => s.id === scenario)!.title} · ${formatDate(state.tick)}</span></div></header>
      <div class="menu-actions">
        <button class="primary" id="continueGame">${icon('play')} Продолжить</button>
        <button class="act" id="returnStart">К выбору сезона</button>
      </div>
      <p class="menu-save">${storage.available ? 'Партия сохранена' : 'Сохранение недоступно в этом браузере'}</p>
    </div>`;
    uiRoot.append(menu);
    const close = (resume: boolean) => {
      release();
      menu?.remove();
      menu = undefined;
      if (resume) applySpeed(previousSpeed);
    };
    const release = activateDialog(menu, { onClose: () => close(true), initialFocus: '#continueGame' });
    menu.querySelector('#continueGame')!.addEventListener('click', () => close(true));
    menu.querySelector('#returnStart')!.addEventListener('click', () => { close(false); start(); });
  }

  function selectDistrict(id: DistrictId, move = false): void {
    if (!state || state.status !== 'running' || !districts[id]) return;
    mapView.select(id);
    selected = id;
    hud.showPanel(districts[id], state, districts);
    if (move) mapView.focusDistrict(id);
  }

  hud.onSpeed((next) => { if (state?.status === 'running') applySpeed(next); });
  hud.onOpenTree(() => { if (state?.status === 'running') tree.toggle(state); });
  hud.onMenu(openMenu);
  hud.onResetMap(() => mapView.resetView());
  hud.onPanelClose(clearSelection);
  hud.setDistricts(districts, (id) => selectDistrict(id, true));
  tree.onVisibilityChange((visible) => {
    if (visible) { treeResume = speed; applySpeed(0); persist(); }
    else if (state?.status === 'running') applySpeed(treeResume);
  });
  tree.onPurchase((id) => {
    if (state && buy(state, id)) { redraw(); persist(); }
  });
  hud.onPanelAction((act, id) => {
    if (state?.status !== 'running') return;
    if (act === 'select') { selectDistrict(id, true); return; }
    if (act === 'focus') setFocus(state, id);
    if (act === 'throw') emberThrow(state, districts, id);
    redraw();
    persist();
  });
  mapView.onDistrictClick((id) => selectDistrict(id));
  mapView.onError((error) => {
    mapFailed = true;
    applySpeed(0);
    persist();
    console.error(error);
    const notice = document.createElement('div');
    notice.className = 'map-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Карта недоступна. Перезагрузите страницу; сохранённую партию можно продолжить.';
    uiRoot.append(notice);
  });

  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey
      || state?.status !== 'running' || menu) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (event.code === 'KeyE') {
      event.preventDefault();
      tree.toggle(state);
      return;
    }
    if (tree.visible) return;
    if (event.code === 'Space' && !target?.closest('button, a')) {
      event.preventDefault();
      applySpeed(speed === 0 ? lastSpeed : 0);
    }
    if (event.code === 'Escape') {
      if (selected) clearSelection();
      else openMenu();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { treeResume = 0; applySpeed(0); persist(); }
  });
  window.addEventListener('pagehide', persist);
  start();
}

function showBootError(error: unknown): void {
  console.error(error);
  uiRoot.innerHTML = '<div class="loading-screen"><b>Не удалось запустить игру</b><p id="boot-error"></p><button class="primary" id="retryBoot">Повторить загрузку</button></div>';
  uiRoot.querySelector('#boot-error')!.textContent = /webgl|context/i.test(String(error))
    ? 'Для карты нужен WebGL 2. Проверьте аппаратное ускорение в настройках браузера.'
    : 'Проверьте соединение и доступность файлов карты.';
  uiRoot.querySelector('#retryBoot')!.addEventListener('click', () => { window.location.reload(); });
}

void boot().catch(showBootError);
