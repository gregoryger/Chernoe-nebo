/**
 * mulberry32 — быстрый детерминированный ГПСЧ.
 *
 * Состояние живёт в WorldState.rng, а не в замыкании: партия должна
 * полностью восстанавливаться из seed и списка действий. Это то, ради чего
 * вообще затевалась отделённая от рендера симуляция — прогон тысячи партий
 * без браузера и воспроизведение бага по номеру seed.
 */

/** Продвинуть состояние и вернуть новое. */
export function nextState(s: number): number {
  return (s + 0x6d2b79f5) | 0;
}

/** Число из [0, 1) по состоянию. Само состояние не меняет. */
export function valueOf(s: number): number {
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Мутирующий помощник: тянет число из объекта с полем rng. */
export function rnd(holder: { rng: number }): number {
  holder.rng = nextState(holder.rng);
  return valueOf(holder.rng);
}

/** Целое из [lo, hi]. */
export function rndInt(holder: { rng: number }, lo: number, hi: number): number {
  return lo + Math.floor(rnd(holder) * (hi - lo + 1));
}

/** Случайный элемент массива. */
export function pick<T>(holder: { rng: number }, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rnd(holder) * arr.length))];
}

/** Строковый seed → 32-битное целое, чтобы можно было писать seed словом. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
