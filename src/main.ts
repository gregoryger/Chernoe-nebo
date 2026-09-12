import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { MapView } from './map/mapView';
import { BY_ID, EVOLUTIONS, canBuy } from './sim/evolutions';
import { tick } from './sim/tick';
import { buy, createWorld, loadDistricts } from './sim/world';
import type { RawDistrict } from './sim/world';
import { Hud } from './ui/hud';
import { TreeView } from './ui/tree';
import { showEndScreen } from './ui/endScreen';
import { showStartScreen } from './ui/startScreen';
import type { District, DistrictId, WorldState } from './sim/types';

/** Миллисекунд на такт для скоростей: пауза, 1×, 3×. */
const SPEED_MS = [0, 400, 120];

async function boot() {
  const [geojson, meta] = await Promise.all([
    fetch('data/districts.geojson').then((r) => r.json()) as Promise<GeoJSON.FeatureCollection>,
    fetch('data/districts.meta.json').then((r) => r.json()) as Promise<Record<string, RawDistrict>>,
  ]);

  const districts: Record<DistrictId, District> = loadDistricts(meta);
  const uiRoot = document.getElementById('ui')!;
  const mapView = new MapView('map', geojson, districts);
  const hud = new Hud(uiRoot);
  const tree = new TreeView(uiRoot);

  let state: WorldState | undefined;
  let speed = 1;
  let timer = 0;
  let selected: DistrictId | null = null;

  function affordableCount(s: WorldState): number {
    return EVOLUTIONS.filter((e) => canBuy(e.id, s.bought, s.sparks)).length;
  }

  function redraw(): void {
    if (!state) return;
    mapView.sync(state);
    hud.update(state, affordableCount(state));
    tree.render(state);
    if (selected) hud.showPanel(districts[selected], state, districts);
  }

  function step(): void {
    if (!state || state.status !== 'running') return;
    tick(state, districts);
    redraw();
    if (state.status !== 'running') {
      stop();
      showEndScreen(uiRoot, state, districts, start);
    }
  }

  function stop(): void {
    if (timer) window.clearInterval(timer);
    timer = 0;
  }

  function applySpeed(next: number): void {
    speed = next;
    stop();
    hud.setSpeed(speed);
    if (speed > 0 && state && state.status === 'running') {
      timer = window.setInterval(step, SPEED_MS[speed]);
    }
  }

  /** Экран выбора точки возгорания; партия стартует после выбора. */
  function start(): void {
    stop();
    selected = null;
    hud.hidePanel();
    tree.hide();
    // До выбора сценария HUD показывал бы шаблонные нули — прячем его целиком.
    uiRoot.classList.remove('playing');
    showStartScreen(uiRoot, districts, (_scenario, startId) => {
      uiRoot.classList.add('playing');
      state = createWorld(districts, startId, Date.now());
      redraw();
      applySpeed(1);
    });
  }

  hud.onSpeed(applySpeed);
  hud.onOpenTree(() => { if (state) tree.toggle(state); });
  tree.onPurchase((id) => {
    if (state && buy(state, id, BY_ID[id].cost)) redraw();
  });

  mapView.onDistrictClick((id) => {
    if (!state) return;
    mapView.select(id, selected);
    selected = id;
    hud.showPanel(districts[id], state, districts);
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (state) applySpeed(speed === 0 ? 1 : 0);
    }
    if (e.code === 'Escape') {
      tree.hide();
      hud.hidePanel();
    }
    if (e.code === 'KeyE' && state) tree.toggle(state);
  });

  start();
}

boot().catch((err) => {
  document.body.innerHTML =
    `<pre style="color:#E7EDEF;padding:24px;font:14px monospace">Не удалось запустить игру:\n\n${err}</pre>`;
  throw err;
});
