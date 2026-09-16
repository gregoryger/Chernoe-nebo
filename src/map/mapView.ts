import maplibregl from 'maplibre-gl';
import { fillColorExpression, fillOpacityExpression } from './ramp';
import type { District, DistrictId, WorldState } from '../sim/types';

const SOURCE = 'districts';
const RIVERS = 'rivers';
const MASK = 'mask';

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
  private onPick?: (id: DistrictId) => void;
  private readonly geojson: GeoJSON.FeatureCollection;
  private readonly rivers: GeoJSON.FeatureCollection;
  private readonly mask: GeoJSON.Feature;

  constructor(container: string, geojson: GeoJSON.FeatureCollection,
              districts: Record<DistrictId, District>,
              rivers: GeoJSON.FeatureCollection) {
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
      minZoom: 1.8,
      maxZoom: 11,
      // Без этого MapLibre повторяет мир по горизонтали, и на малом зуме
      // в кадр влезает несколько копий края разом.
      renderWorldCopies: false,
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __map: maplibregl.Map }).__map = this.map;
      (window as unknown as { __mapErr: unknown[] }).__mapErr = [];
      this.map.on('error', (e) => {
        (window as unknown as { __mapErr: unknown[] }).__mapErr.push(String(e.error ?? e));
      });
    }

    this.geojson = geojson;
    this.rivers = rivers;

    // Снимок за пределами края такой же яркий, как внутри, и игровое поле
    // в нём теряется. Затемняем всё вокруг: многоугольник на весь мир, в
    // котором внешние кольца округов вырезаны дырами.
    const holes: GeoJSON.Position[][] = [];
    for (const f of geojson.features) {
      const g = f.geometry as GeoJSON.MultiPolygon;
      for (const poly of g.coordinates) holes.push(poly[0]);
    }
    this.mask = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
          ...holes,
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
      new ResizeObserver(() => {
        this.map.resize();
        if (!this.fitted && this.ready && el.clientWidth > 0 && el.clientHeight > 0) {
          this.fitKrai();
          this.fitted = true;
        }
      }).observe(el);
    }

    this.map.on('load', () => {
      this.map.addSource(SOURCE, {
        type: 'geojson',
        data: geojson,
        promoteId: 'id',
      });

      this.map.addSource(MASK, { type: 'geojson', data: this.mask });
      this.map.addLayer({
        id: 'mask', type: 'fill', source: MASK,
        paint: { 'fill-color': '#080B0D', 'fill-opacity': 0.74 },
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
        if (f && this.onPick) this.onPick(String(f.properties?.id));
      });
      this.map.on('mouseenter', 'fill', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'fill', () => {
        this.map.getCanvas().style.cursor = '';
      });

      this.ready = true;
      const box = this.map.getContainer();
      if (box.clientWidth > 0 && box.clientHeight > 0) {
        this.fitKrai();
        this.fitted = true;
      }
    });
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
    const b = new maplibregl.LngLatBounds();
    const forested = this.geojson.features.filter(
      (f) => ((f.properties as { forest?: number }).forest ?? 0) >= 0.25,
    );
    for (const f of (forested.length ? forested : this.geojson.features)) {
      const g = f.geometry as GeoJSON.MultiPolygon;
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          for (const p of ring) b.extend(p as [number, number]);
        }
      }
    }
    // Справа стоят сводки и панель района, слева — легенда: если вписывать
    // с одинаковыми отступами, край уезжает под панели.
    const wide = this.map.getContainer().clientWidth > 900;
    this.map.fitBounds(b, {
      padding: wide
        ? { top: 90, bottom: 90, left: 260, right: 330 }
        : { top: 70, bottom: 70, left: 20, right: 20 },
      duration: 0,
    });
  }

  onDistrictClick(fn: (id: DistrictId) => void): void {
    this.onPick = fn;
  }

  select(id: DistrictId | null, prev: DistrictId | null): void {
    if (!this.ready) return;
    if (prev) this.map.setFeatureState({ source: SOURCE, id: prev }, { sel: false });
    if (id) this.map.setFeatureState({ source: SOURCE, id }, { sel: true });
  }

  /** Перелить состояние симуляции в feature-state. Вызывается каждый такт. */
  sync(s: WorldState): void {
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
