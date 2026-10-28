import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { fillColorExpression, fillOpacityExpression } from './ramp';
import type { District, DistrictId, WorldState } from '../sim/types';
import type * as GeoJSON from 'geojson';

const SOURCE = 'districts';
const RIVERS = 'rivers';
const MASK = 'mask';
const BORDER = 'border';

maplibregl.setWorkerUrl(workerUrl);

/**
 * Карта края на спутниковой подложке.
 *
 * Изначально подложки не было — считалось, что снимок конкурирует с цветом
 * состояния за внимание. На практике вышло наоборот: пустые многоугольники
 * не давали понять, где тайга, где степь и где горы, и карта читалась как
 * схема, а не как местность. Конфликт снят прозрачностью: целый округ почти
 * не закрашен и показывает настоящий лес, а плотность заливки растёт вместе
 * с огнём.
 *
 * Снимки — ESRI World Imagery, без ключа; требуется указание источника,
 * поэтому атрибуция включена.
 */
export class MapView {
  readonly map: maplibregl.Map;
  private ready = false;
  private fitted = false;
  private overview = true;
  private selected: DistrictId | null = null;
  private pendingFocus: DistrictId | null = null;
  private latestState?: WorldState;
  private fatalError?: Error;
  private errorHandler?: (error: Error) => void;
  private onPick?: (id: DistrictId) => void;
  private readonly geojson: GeoJSON.FeatureCollection;
  private readonly rivers: GeoJSON.FeatureCollection;
  private readonly mask: GeoJSON.Feature;
  private readonly outline: GeoJSON.FeatureCollection;

  constructor(container: string, geojson: GeoJSON.FeatureCollection,
              districts: Record<DistrictId, District>,
              rivers: GeoJSON.FeatureCollection,
              outline: GeoJSON.FeatureCollection) {
    // Признаки, по которым стилизуются обводки, кладём в properties: dasharray
    // в MapLibre не управляется данными, поэтому зоны контроля рисуются
    // отдельным слоем с фильтром.
    for (const f of geojson.features) {
      const id = (f.properties as { id: string }).id;
      const d = districts[id];
      if (d) {
        f.properties = {
          ...f.properties, ctrl: d.ctrlZone ? 1 : 0, pop: d.pop, forest: d.forest,
        };
      }
    }

    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          sat: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/'
              + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 17,
            attribution: 'Esri, Maxar, Earthstar Geographics',
          },
        },
        // Ключ glyphs не задаём вовсе: MapLibre валидирует его как строку,
        // если он присутствует, и падает на `glyphs: undefined`. Подписей
        // средствами карты здесь нет — названия живут в панели района.
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0F1315' } },
          // Снимок приглушён: поверх него читаются заливка пожара и обводки,
          // а полная яркость спутника перетягивала бы внимание на себя.
          {
            id: 'sat', type: 'raster', source: 'sat',
            paint: { 'raster-opacity': 0.82, 'raster-saturation': -0.25 },
          },
        ],
      },
      center: [95, 62],
      zoom: 3,
      attributionControl: { compact: true },
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      maxPitch: 0,
      minZoom: 1.8,
      maxZoom: 11,
      // Без этого MapLibre повторяет мир по горизонтали, и на малом зуме
      // в кадр влезает несколько копий края разом.
      renderWorldCopies: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.getCanvas().setAttribute('aria-label', 'Карта лесных пожаров Красноярского края');

    if (import.meta.env.DEV) {
      (window as unknown as { __map: maplibregl.Map }).__map = this.map;
      (window as unknown as { __mapErr: unknown[] }).__mapErr = [];
    }
    this.map.on('error', (event) => {
      // Спутник необязателен: геометрия и состояние игры доступны без сети.
      if (!('sourceId' in event) || event.sourceId !== 'sat') this.reportError(event.error);
    });

    this.geojson = geojson;
    this.rivers = rivers;

    /*
     * Снимок за пределами края такой же яркий, как внутри, и игровое поле
     * в нём теряется. Затемняем всё вокруг: многоугольник на весь мир с
     * дырой по контуру края.
     *
     * Первая версия вырезала 51 дыру — по внешнему кольцу каждого округа.
     * Такая фигура не триангулируется: маска шла тёмными полосами, а то и
     * накрывала карту целиком. Дыра должна быть одна, поэтому берём готовый
     * контур края (tools/step6_outline.py) и из него — крупнейшее кольцо,
     * материковую часть. Острова в Карском море под маской: их всё равно
     * не поджечь.
     */
    this.outline = outline;
    const rings = (outline.features[0].geometry as GeoJSON.MultiPolygon).coordinates;
    const mainland = rings.reduce((a, b) => (b[0].length > a[0].length ? b : a))[0];
    this.mask = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
          mainland,
        ],
      },
    };

    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    // Контейнер может быть ещё нулевым в момент конструирования (шрифты,
    // раскладка, вкладка в фоне). Тогда карта остаётся пустой, а fitBounds по
    // нулевому вьюпорту даёт бессмысленный масштаб — поэтому рамку выставляем
    // не по событию load, а при первом ненулевом размере.
    const el = document.getElementById(container);
    if (el) {
      const observer = new ResizeObserver(() => {
        this.map.resize();
        if (this.ready && el.clientWidth > 0 && el.clientHeight > 0) {
          if (this.pendingFocus) this.focusDistrict(this.pendingFocus);
          else if (!this.fitted || this.overview) this.resetView();
          else this.map.setPadding(this.viewPadding());
        }
      });
      observer.observe(el);
      this.map.once('remove', () => observer.disconnect());
    }
    this.map.on('movestart', (event) => {
      if (event.originalEvent) this.overview = false;
    });

    // load ждёт все видимые тайлы, style.load позволяет играть до загрузки снимков.
    this.map.once('style.load', () => {
      try {
        this.buildLayers();
      } catch (err) {
        this.reportError(err);
      }
    });
  }

  private buildLayers(): void {
      this.map.addSource(SOURCE, {
        type: 'geojson',
        data: this.geojson,
        promoteId: 'id',
        attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      });
      this.map.addLayer({
        id: 'terrain', type: 'fill', source: SOURCE,
        paint: {
          'fill-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'forest'], 0],
            0, '#3B4442', 0.25, '#344E3B', 1, '#233E30',
          ],
        },
      }, 'sat');

      this.map.addSource(MASK, { type: 'geojson', data: this.mask });
      this.map.addLayer({
        id: 'mask', type: 'fill', source: MASK,
        paint: { 'fill-color': '#080B0D', 'fill-opacity': 0.72 },
      });

      // Граница края целиком, включая острова: маска их не выделяет, а рамка
      // игрового поля должна быть замкнутой.
      this.map.addSource(BORDER, { type: 'geojson', data: this.outline });
      this.map.addLayer({
        id: 'border', type: 'line', source: BORDER,
        paint: { 'line-color': '#C8D4D8', 'line-width': 1.6, 'line-opacity': 0.75 },
      });

      this.map.addLayer({
        id: 'fill', type: 'fill', source: SOURCE,
        paint: {
          'fill-color': fillColorExpression,
          'fill-opacity': fillOpacityExpression,
        },
      });

      // Дым поверх заливки, непрозрачность равна smoke.
      this.map.addLayer({
        id: 'smoke', type: 'fill', source: SOURCE,
        paint: {
          'fill-color': '#8A8D8E',
          'fill-opacity': [
            '*', 0.65, ['coalesce', ['feature-state', 'smoke'], 0],
          ] as unknown as maplibregl.ExpressionSpecification,
        },
      });

      this.map.addSource(RIVERS, { type: 'geojson', data: this.rivers });

      // Барьерные реки рисуются ПОВЕРХ заливки: если убрать их под неё, они
      // исчезали бы ровно там, где горит, то есть там, где игрок про них
      // и вспоминает. Свечение — широкая размытая линия под тонкой яркой.
      this.map.addLayer({
        id: 'rivers-glow', type: 'line', source: RIVERS,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#2BA3E3',
          'line-blur': 3.5,
          'line-opacity': 0.5,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 5, 8, 16],
        } as unknown as maplibregl.LineLayerSpecification['paint'],
      });
      this.map.addLayer({
        id: 'rivers-core', type: 'line', source: RIVERS,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#9BE0FF',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 8, 4],
        } as unknown as maplibregl.LineLayerSpecification['paint'],
      });

      this.map.addLayer({
        id: 'outline', type: 'line', source: SOURCE,
        filter: ['==', ['get', 'ctrl'], 0],
        paint: { 'line-color': '#E3EAEC', 'line-width': 0.9, 'line-opacity': 0.5 },
      });

      // Зона контроля — пунктир: сюда не выезжают, пока не станет поздно.
      this.map.addLayer({
        id: 'outline-ctrl', type: 'line', source: SOURCE,
        filter: ['==', ['get', 'ctrl'], 1],
        paint: {
          'line-color': '#74B7BC', 'line-width': 1.4, 'line-dasharray': [3, 2.5],
        },
      });

      // Округ, на который направлен фронт.
      this.map.addLayer({
        id: 'focus', type: 'line', source: SOURCE,
        paint: {
          'line-color': '#F0813A',
          'line-width': ['case', ['==', ['coalesce', ['feature-state', 'focus'], 0], 1], 2.6, 0],
          'line-dasharray': [2, 1.6],
        } as unknown as maplibregl.LineLayerSpecification['paint'],
      });

      this.map.addLayer({
        id: 'hover', type: 'line', source: SOURCE,
        paint: {
          'line-color': '#F0813A',
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 2.4, 0],
        } as unknown as maplibregl.LineLayerSpecification['paint'],
      });

      this.map.on('click', 'fill', (e) => {
        const f = e.features?.[0];
        const id = f?.properties?.id;
        if (id != null && this.onPick) this.onPick(String(id));
      });
      this.map.on('mouseenter', 'fill', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'fill', () => {
        this.map.getCanvas().style.cursor = '';
      });

    if (this.fatalError) return;
    this.ready = true;
    if (this.latestState) this.sync(this.latestState);
    this.select(this.selected);
    const box = this.map.getContainer();
    if (box.clientWidth > 0 && box.clientHeight > 0) {
      if (this.pendingFocus) this.focusDistrict(this.pendingFocus);
      else this.resetView();
    }
  }

  private reportError(cause: unknown): void {
    if (this.fatalError) return;
    this.fatalError = cause instanceof Error ? cause : new Error(String(cause));
    this.ready = false;
    console.error('[mapView]', this.fatalError);
    (window as unknown as { __mapErr?: unknown[] }).__mapErr?.push(String(this.fatalError));
    this.errorHandler?.(this.fatalError);
  }

  onError(fn: (error: Error) => void): void {
    this.errorHandler = fn;
    if (this.fatalError) fn(this.fatalError);
  }

  private viewPadding(): maplibregl.PaddingOptions {
    const { clientWidth: width, clientHeight: height } = this.map.getContainer();
    const wide = width > 1180;
    const mobile = width <= 700;
    return {
      top: Math.min(wide ? 72 : mobile ? 165 : 135, height * 0.3),
      bottom: Math.min(mobile ? 155 : 110, height * 0.3),
      left: wide ? 230 : 20,
      right: wide ? 310 : 20,
    };
  }

  private boundsFor(features: GeoJSON.Feature[]): maplibregl.LngLatBounds {
    const bounds = new maplibregl.LngLatBounds();
    for (const { geometry } of features) {
      const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates
        : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
      for (const polygon of polygons) {
        for (const point of polygon[0] ?? []) bounds.extend(point as [number, number]);
      }
    }
    return bounds;
  }

  /**
   * Вписать лесную часть края, а не весь край.
   *
   * Таймыр уходит за 81° с. ш., и в проекции Меркатора приполярные широты
   * растягиваются так, что вмещение всего края требует зума 2.4 вместо 3.3:
   * обжитой юг, где и происходит игра, сжимается в нечитаемую полоску. Тундра
   * Таймыра при fuelClass 1 почти не горит, поэтому по умолчанию кадрируем по
   * округам с лесистостью от 25% — север остаётся доступен панорамированием.
   */
  private fitKrai(): void {
    const forested = this.geojson.features.filter(
      (f) => ((f.properties as { forest?: number }).forest ?? 0) >= 0.25,
    );
    const bounds = this.boundsFor(forested.length ? forested : this.geojson.features);
    if (bounds.isEmpty()) throw new Error('Не найдены границы игровых районов');
    // Справа стоят сводки и панель района, слева — легенда: если вписывать
    // с одинаковыми отступами, край уезжает под панели.
    this.map.fitBounds(bounds, {
      padding: this.viewPadding(),
      bearing: 0,
      pitch: 0,
      duration: 0,
    });
  }

  resetView(): void {
    this.overview = true;
    this.pendingFocus = null;
    this.fitted = false;
    const box = this.map.getContainer();
    if (!this.ready || box.clientWidth === 0 || box.clientHeight === 0) return;
    this.fitKrai();
    this.fitted = true;
  }

  focusDistrict(id: DistrictId): void {
    const feature = this.geojson.features.find((f) => String(f.properties?.id) === id);
    if (!feature) return;
    this.overview = false;
    this.pendingFocus = id;
    const box = this.map.getContainer();
    if (!this.ready || box.clientWidth === 0 || box.clientHeight === 0) return;
    const bounds = this.boundsFor([feature]);
    if (bounds.isEmpty()) return;
    this.map.fitBounds(bounds, {
      padding: this.viewPadding(),
      maxZoom: 8,
      bearing: 0,
      pitch: 0,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450,
    });
    this.pendingFocus = null;
    this.fitted = true;
  }

  onDistrictClick(fn: (id: DistrictId) => void): void {
    this.onPick = fn;
  }

  select(id: DistrictId | null, prev: DistrictId | null = this.selected): void {
    const previous = this.selected ?? prev;
    this.selected = id;
    if (!this.ready) return;
    if (previous) this.map.setFeatureState({ source: SOURCE, id: previous }, { sel: false });
    if (id) this.map.setFeatureState({ source: SOURCE, id }, { sel: true });
  }

  /** Перелить состояние симуляции в feature-state. Вызывается каждый такт. */
  sync(s: WorldState): void {
    this.latestState = s;
    if (!this.ready) return;
    for (let i = 0; i < s.ids.length; i++) {
      const id = s.ids[i];
      const st = s.districts[id];
      this.map.setFeatureState({ source: SOURCE, id }, {
        b: st.B,
        f: st.F,
        smoke: st.smoke,
        known: st.known ? 1 : 0,
        focus: s.focus === id ? 1 : 0,
      });
    }
  }
}
