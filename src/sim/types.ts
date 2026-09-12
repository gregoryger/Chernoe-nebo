export type DistrictId = string;

/** Ребро графа соседства. */
export interface Edge {
  to: DistrictId;
  /** Доля общего периметра, 0…1. Считается по длине общих OSM-way. */
  w: number;
  /** Барьер, 0…0.6: река 0.40, трасса или ж/д 0.25, суммируются. */
  barrier: number;
  /** Из чего состоит барьер — нужно, чтобы эволюции А4/А5 снимали его выборочно. */
  river: number;
  road: number;
  /**
   * Азимут от центроида района к центроиду соседа, радианы, в той же системе,
   * что и Weather.windDir (0 = на восток, π/2 = на север).
   * Считается один раз при загрузке мира.
   */
  bearing: number;
}

/** Константы района. Приходят из data/districts.meta.json, в игре не меняются. */
export interface District {
  id: DistrictId;
  name: string;
  /** Площадь, км². */
  area: number;
  /** Лесистость, 0…1. */
  forest: number;
  /** 1 тундра · 2 северная тайга · 3 средняя тайга · 4 сосняк · 5 лесостепь */
  fuelClass: 1 | 2 | 3 | 4 | 5;
  /** Горимость, производная от fuelClass. */
  k: number;
  pop: number;
  /** Доступность для сил тушения, 0…1. */
  access: number;
  ctrlZone: boolean;
  hasAirfield: boolean;
  hasWater: boolean;
  centroid: [number, number];
  /**
   * Поправка скорости роста на размер района, считается при загрузке.
   *
   * Фронт пожара продвигается линейно, поэтому охваченная ПЛОЩАДЬ растёт
   * квадратично по времени, а её ДОЛЯ от района — обратно пропорционально
   * площади района. Без этой поправки Эвенкия (715 тыс. км²) выгорала за
   * сезон так же охотно, как округ на 3 тыс. км², и давала 20 млн га.
   */
  sizeFactor: number;
  /**
   * Сезонный бюджет, 0…1 — какая доля леса района может выгореть за ОДИН
   * сезон. Не «сколько там леса вообще»: в рекордном 2019 году по всему краю
   * сгорело 2,6 млн га при 103 млн га лесов, то есть 2,5%. Без этого потолка
   * одна Эвенкия с её 51 млн га леса перекрывала золотой порог в 6 млн
   * в любой партии, где огонь вообще выжил.
   */
  budget: number;
  neighbors: Edge[];
}

/** Изменяемое состояние района. */
export interface DistrictState {
  /** Доля несгоревшего горючего, 0…1. */
  F: number;
  /** Доля площади в огне, 0…1. */
  B: number;
  /** Накопленно выгорело, га. */
  burned: number;
  /** Силы тушения, условные единицы. */
  S: number;
  known: boolean;
  /** Задымление, 0…1. */
  smoke: number;
  /** Прогресс прокладки минполосы, 0…1. При 1 добавляет барьер. */
  minLine: number;
  /** Район когда-либо горел — чтобы не начислять бонус за него дважды. */
  ignited: boolean;
}

export interface Weather {
  /** Направление, КУДА дует ветер, радианы (0 = на восток, π/2 = на север). */
  windDir: number;
  /** Множитель силы ветра W, 0.70…1.60. */
  W: number;
  /** Сезонный индекс засухи D. */
  D: number;
  event: WeatherEvent | null;
  eventTicks: number;
  /** Целевое направление для плавной интерполяции. */
  targetDir: number;
  targetW: number;
  nextShift: number;
}

export type WeatherEvent = 'storm' | 'squall' | 'rain' | 'cyclone';

/** Модификаторы — свёртка купленных эволюций. Пересчитываются при покупке. */
export interface Modifiers {
  r: number;
  tau: number;
  e: number;
  damageMult: number;
  nightPenalty: number;
  riverBarrierMult: number;
  roadBarrierMult: number;
  minLineMult: number;
  aviationMult: number;
  backfireMult: number;
  droughtFloor: number;
  spotting: boolean;
  peat: boolean;
  /** Куплен «Верховой пожар» — держим флагом, а не поиском по bought в горячем цикле. */
  crownFire: boolean;
  smokeOn: boolean;
  blackSky: boolean;
  villageThreat: boolean;
  infraDamage: boolean;
  smolder: number;
}

export interface GameEvent {
  tick: number;
  kind: 'ignite' | 'spread' | 'detect' | 'escalate' | 'weather' | 'suppress' | 'end';
  text: string;
}

export type Status = 'running' | 'won' | 'lost';
export type Grade = null | 'bronze' | 'silver' | 'gold';

export interface WorldState {
  tick: number;
  /** Порядок обхода районов. Массив вместо for..in по объекту — горячий цикл. */
  ids: DistrictId[];
  rng: number;
  districts: Record<DistrictId, DistrictState>;
  sparks: number;
  bought: string[];
  mods: Modifiers;
  escalation: number;
  weather: Weather;
  totalBurned: number;
  events: GameEvent[];
  status: Status;
  grade: Grade;
  /** Уже объявленные разово события, чтобы не спамить ленту. */
  flags: Record<string, boolean>;
}

export type Action = { type: 'buy'; id: string };
