import type { ExpressionSpecification } from 'maplibre-gl';

/**
 * Цветовая шкала района.
 *
 * Следует логике классов пожарной опасности: зелёный → жёлтый → оранжевый →
 * красный, с уходом в тёмное на выгоревших территориях. Значения продублированы
 * в style.css для легенды — держим их здесь как единственный источник.
 */
export const FIRE = {
  intact: '#3E6B52',
  smoulder: '#B8901F',
  active: '#D96F16',
  strong: '#BE3512',
  total: '#7E1808',
  burned: '#33302C',
} as const;

/** Порог доли несгоревшего горючего, ниже которого район считается выгоревшим. */
export const BURNED_OUT = 0.15;

/**
 * Выражение MapLibre для заливки района.
 * Читает feature-state, который обновляется на каждом такте.
 */
export const fillColorExpression = [
  'case',
  ['<', ['coalesce', ['feature-state', 'f'], 1], BURNED_OUT], FIRE.burned,
  [
    'interpolate', ['linear'], ['coalesce', ['feature-state', 'b'], 0],
    0, FIRE.intact,
    0.05, FIRE.smoulder,
    0.25, FIRE.active,
    0.6, FIRE.strong,
    1, FIRE.total,
  ],
] as unknown as ExpressionSpecification;

/**
 * Непрозрачность заливки.
 *
 * Под картой лежит спутниковый снимок, поэтому целый лес закрашивать незачем —
 * настоящая тайга на снимке выразительнее любой заливки. Плотность растёт
 * вместе с огнём: чем сильнее горит, тем меньше видно землю под пожаром.
 * Необнаруженный очаг дополнительно приглушён — игрок видит тление, но не
 * полную картину.
 */
export const fillOpacityExpression = [
  '*',
  [
    'case',
    ['<', ['coalesce', ['feature-state', 'f'], 1], BURNED_OUT], 0.78,
    [
      'interpolate', ['linear'], ['coalesce', ['feature-state', 'b'], 0],
      0, 0.20,
      0.02, 0.40,
      0.25, 0.66,
      1, 0.85,
    ],
  ],
  ['case', ['==', ['coalesce', ['feature-state', 'known'], 0], 0], 0.6, 1],
] as unknown as ExpressionSpecification;

export function describeState(b: number, f: number): string {
  if (f < BURNED_OUT) return 'выгорел';
  if (b <= 0.001) return 'лес цел';
  if (b < 0.05) return 'тлеет';
  if (b < 0.25) return 'активный пожар';
  if (b < 0.6) return 'сильный пожар';
  return 'сплошной пожар';
}
