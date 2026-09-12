import maplibregl from 'maplibre-gl';
import { fillColorExpression, fillOpacityExpression } from './ramp';
import type { District, DistrictId, WorldState } from '../sim/types';

const SOURCE = 'districts';

/**
 * Карта края без подложки: только полигоны округов на глухом фоне.
 *
 * Подложка здесь мешала бы — состояние района читается цветом, и спутник или
 * карта OSM конкурировали бы с ним за внимание. Побочно это снимает загрузку
 * тайлов: игра работает полностью офлайн после первой загрузки.
 */
export class MapView {
  readonly map: maplibregl.Map;
  private ready = false;
  private fitted = false;
  private onPick?: (id: DistrictId) => void;
  private readonly geojson: GeoJSON.FeatureCollection;

  constructor(container: string, geojson: GeoJSON.FeatureCollection,
              districts: Record<DistrictId, District>) {
    // Признаки, по которым стилизуются обводки, кладём в properties: dasharray
    // в MapLibre не управляется данными, поэтому зоны контроля рисуются
    // отдельным слоем с фильтром.
    for (const f of geojson.features) {
      const id = (f.properties as { id: string }).id;
      const d = districts[id];
      if (d) {
        f.properties = { ...f.properties, ctrl: d.ctrlZone ? 1 : 0, pop: d.pop };
      }
    }

    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {},
        // Ключ glyphs не задаём вовсе: MapLibre валидирует его как строку,
        // если он присутствует, и падает на `glyphs: undefined`. Подписей
        // средствами карты здесь нет — названия живут в панели района.
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0F1315' } }],
      },
      center: [95, 62],
      zoom: 3,
      attributionControl: false,
      dragRotate: false,
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __map: maplibregl.Map }).__map = this.map;
      (window as unknown as { __mapErr: unknown[] }).__mapErr = [];
      this.map.on('error', (e) => {
        (window as unknown as { __mapErr: unknown[] }).__mapErr.push(String(e.error ?? e));
      });
    }

    this.geojson = geojson;

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

      this.map.addLayer({
        id: 'outline', type: 'line', source: SOURCE,
        filter: ['==', ['get', 'ctrl'], 0],
        paint: { 'line-color': '#0B0E10', 'line-width': 0.8 },
      });

      // Зона контроля — пунктир: сюда не выезжают, пока не станет поздно.
      this.map.addLayer({
        id: 'outline-ctrl', type: 'line', source: SOURCE,
        filter: ['==', ['get', 'ctrl'], 1],
        paint: {
          'line-color': '#74B7BC', 'line-width': 1.4, 'line-dasharray': [3, 2.5],
        },
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

  private fitKrai(): void {
    const b = new maplibregl.LngLatBounds();
    for (const f of this.geojson.features) {
      const g = f.geometry as GeoJSON.MultiPolygon;
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          for (const p of ring) b.extend(p as [number, number]);
        }
      }
    }
    this.map.fitBounds(b, { padding: 40, duration: 0 });
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
      });
    }
  }
}
