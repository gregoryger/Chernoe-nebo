import { BRONZE, GOLD, SILVER } from '../sim/tick';
import { formatDate, seasonDay } from '../sim/weather';
import { describeState } from '../map/ramp';
import { canThrow, throwCost } from '../sim/world';
import type { District, DistrictId, WorldState } from '../sim/types';

const ha = (n: number) => Math.round(n).toLocaleString('ru');

const LEVEL_NAME = [
  'тишина',
  'лесничества',
  'авиалесоохрана',
  'ЧС в районах',
  'ЧС в крае',
  'армия',
];

export class Hud {
  private root: HTMLElement;
  private lastEventCount = 0;
  private panelAction?: (act: string, id: DistrictId) => void;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="topbar">
        <div class="cell"><b id="date">15 апреля</b><span id="day">сутки 1 из 169</span></div>
        <div class="cell"><b id="wind">—</b><span>ветер</span></div>
        <div class="cell"><b id="drought">—</b><span>засуха</span></div>
        <div class="cell speeds">
          <button data-speed="0" class="sp" title="Пауза (пробел)">Пауза</button>
          <button data-speed="1" class="sp on" title="Обычная скорость">1&times;</button>
          <button data-speed="2" class="sp" title="Вдвое быстрее">2&times;</button>
          <button data-speed="3" class="sp" title="Пятикратно">5&times;</button>
        </div>
      </div>

      <div class="botbar">
        <div class="cell wide">
          <b id="burned">0</b><span>гектаров выгорело</span>
          <div class="bar"><i id="progress"></i></div>
          <span id="grade" class="grade">до бронзы 1 000 000</span>
        </div>
        <div class="cell"><b id="sparks">0</b><span>искры</span></div>
        <div class="cell"><b id="levelname">тишина</b><span id="level">реакция МЧС · уровень 0</span></div>
        <div class="cell" id="focusCell"><b id="focusName">не задан</b><span>фронт направлен</span></div>
        <button id="openTree" class="primary">Эволюция <i id="treeBadge" class="badge" hidden>0</i></button>
      </div>

      <aside class="legend">
        <h3>Состояние округа</h3>
        <ul class="ramp">
          <li><i style="background:#3E6B52"></i>лес цел</li>
          <li><i style="background:#B8901F"></i>тлеет</li>
          <li><i style="background:#D96F16"></i>активный пожар</li>
          <li><i style="background:#BE3512"></i>сильный пожар</li>
          <li><i style="background:#7E1808"></i>сплошной пожар</li>
          <li><i style="background:#33302C"></i>выгорел</li>
          <li><i class="dashed"></i>зона контроля — не тушат</li>
          <li><i class="faded"></i>бледный — пожар не обнаружен</li>
          <li><i class="focusmark"></i>фронт направлен сюда</li>
        </ul>
        <h3>Управление</h3>
        <ul class="keys">
          <li><kbd>Пробел</kbd>пауза и продолжить</li>
          <li><kbd>E</kbd>дерево эволюций</li>
          <li><kbd>Esc</kbd>закрыть окно</li>
          <li><kbd>клик</kbd>сводка и управление</li>
        </ul>
      </aside>

      <aside class="feed"><h3>Сводки</h3><ul id="feedList"></ul></aside>
      <aside class="panel" id="panel" hidden></aside>
    `;

    // Панель перерисовывается на каждом такте, поэтому слушатель висит на
    // контейнере, а не на кнопках внутри него.
    this.root.querySelector('#panel')!.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('#closePanel')) {
        this.hidePanel();
        return;
      }
      const btn = target.closest<HTMLElement>('[data-act]');
      if (btn && !btn.hasAttribute('disabled')) {
        this.panelAction?.(btn.dataset.act!, btn.dataset.id!);
      }
    });
  }

  /** Действия из панели округа: 'focus' и 'throw'. */
  onPanelAction(fn: (act: string, id: DistrictId) => void): void {
    this.panelAction = fn;
  }

  onSpeed(fn: (speed: number) => void): void {
    this.root.querySelectorAll<HTMLButtonElement>('.sp').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.root.querySelectorAll('.sp').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        fn(Number(btn.dataset.speed));
      });
    });
  }

  onOpenTree(fn: () => void): void {
    this.root.querySelector('#openTree')!.addEventListener('click', fn);
  }

  setSpeed(speed: number): void {
    this.root.querySelectorAll<HTMLButtonElement>('.sp').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.speed) === speed);
    });
  }

  update(s: WorldState, affordable: number): void {
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    const day = seasonDay(s.tick);

    $('date').textContent = formatDate(s.tick);
    $('day').textContent = `сутки ${day + 1} из 169`;

    const deg = (s.weather.windDir * 180) / Math.PI;
    const compass = ['В', 'СВ', 'С', 'СЗ', 'З', 'ЮЗ', 'Ю', 'ЮВ'];
    const idx = Math.round(((deg + 360) % 360) / 45) % 8;
    $('wind').innerHTML =
      `<span class="arrow" style="transform:rotate(${-deg}deg)">→</span> ${compass[idx]} `
      + `${s.weather.W.toFixed(2)}`;
    $('drought').textContent = s.weather.D.toFixed(2);

    $('burned').textContent = ha(s.totalBurned);
    $('sparks').textContent = String(Math.floor(s.sparks));
    $('levelname').textContent = LEVEL_NAME[s.escalation];
    $('level').textContent = `реакция МЧС · уровень ${s.escalation}`;

    const next = s.totalBurned < BRONZE ? BRONZE : s.totalBurned < SILVER ? SILVER : GOLD;
    const label = next === BRONZE ? 'бронзы' : next === SILVER ? 'серебра' : 'золота';
    $('progress').style.width = `${Math.min(100, (s.totalBurned / next) * 100)}%`;
    $('grade').textContent = s.totalBurned >= GOLD
      ? 'золото взято'
      : `до ${label} ${ha(next - s.totalBurned)}`;

    const focusName = s.focus ? this.focusLabel : 'не задан';
    $('focusName').textContent = focusName;
    $('focusName').classList.toggle('dim', !s.focus);

    const badge = $('treeBadge');
    badge.hidden = affordable === 0;
    badge.textContent = String(affordable);

    this.renderFeed(s);
  }

  /** Имя округа-фокуса; проставляется при отрисовке панели и в main. */
  focusLabel = 'не задан';

  private renderFeed(s: WorldState): void {
    if (s.events.length === this.lastEventCount) return;
    this.lastEventCount = s.events.length;
    const list = this.root.querySelector('#feedList')!;
    list.innerHTML = s.events
      .slice(-14)
      .reverse()
      .map((e) => `<li class="k-${e.kind}"><time>${formatDate(e.tick)}</time>${e.text}</li>`)
      .join('');
  }

  showPanel(d: District, s: WorldState, districts: Record<DistrictId, District>): void {
    const st = s.districts[d.id];
    const panel = this.root.querySelector<HTMLElement>('#panel')!;
    const FUEL = ['', 'тундра', 'северная тайга', 'средняя тайга', 'сосняк', 'лесостепь'];
    const cap = d.area * d.forest * 100 * d.budget;

    const isFocus = s.focus === d.id;
    const cost = throwCost(s);
    const throwOk = canThrow(s, districts, d.id);
    const throwHint = throwOk
      ? 'Головни перелетят от соседнего пожара'
      : st.B > 0.01 ? 'Здесь уже горит'
      : st.F < 0.1 ? 'Гореть нечему'
      : s.throwCooldown > 0 ? `Искры кончились, ждать ${s.throwCooldown} тактов`
      : s.sparks < cost ? `Не хватает ${Math.ceil(cost - s.sparks)} искр`
      : 'Рядом нет достаточно сильного пожара';

    panel.hidden = false;
    panel.innerHTML = `
      <button class="close" id="closePanel">&times;</button>
      <h3>${d.name}</h3>
      <p class="status">${describeState(st.B, st.F)}${d.ctrlZone ? ' · зона контроля' : ''}</p>
      <dl>
        <div><dt>Площадь</dt><dd>${d.area.toLocaleString('ru')} км²</dd></div>
        <div><dt>Лесистость</dt><dd>${Math.round(d.forest * 100)}% · ${FUEL[d.fuelClass]}</dd></div>
        <div><dt>Население</dt><dd>${d.pop.toLocaleString('ru')}</dd></div>
        <div><dt>Охвачено огнём</dt><dd>${(st.B * 100).toFixed(1)}%</dd></div>
        <div><dt>Выгорело</dt><dd>${ha(st.burned)} из ${ha(cap)} га</dd></div>
        <div><dt>Силы тушения</dt><dd>${st.S.toFixed(1)}${st.known ? '' : ' · не обнаружен'}</dd></div>
        <div><dt>Задымление</dt><dd>${Math.round(st.smoke * 100)}%</dd></div>
        <div><dt>Аэродром</dt><dd>${d.hasAirfield ? 'есть' : 'нет'}</dd></div>
      </dl>
      <div class="acts">
        <button data-act="focus" data-id="${d.id}" class="act ${isFocus ? 'on' : ''}">
          ${isFocus ? 'Снять фокус' : 'Направить фронт сюда'}
        </button>
        <button data-act="throw" data-id="${d.id}" class="act throw"
                ${throwOk ? '' : 'disabled'}>
          Бросить искры · ${cost}
        </button>
        <span class="act-hint">${throwHint}</span>
      </div>

      <h4>Соседи</h4>
      <ul class="neigh">
        ${d.neighbors.map((e) => {
          const nb = districts[e.to];
          const bar = e.river > 0 ? ' · река' : '';
          return `<li><span>${nb.name.replace(' муниципальный округ', '')}</span>`
            + `<em>${(s.districts[e.to].B * 100).toFixed(0)}%${bar}</em></li>`;
        }).join('')}
      </ul>
    `;
    panel.querySelector('#closePanel')!.addEventListener('click', () => {
      panel.hidden = true;
    });
  }

  hidePanel(): void {
    this.root.querySelector<HTMLElement>('#panel')!.hidden = true;
  }
}
