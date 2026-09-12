import { EVOLUTIONS, canBuy, isUnlocked } from '../sim/evolutions';
import type { WorldState } from '../sim/types';

const BRANCH_TITLE: Record<string, [string, string]> = {
  A: ['Распространение', 'куда и как быстро идёт огонь'],
  B: ['Ущерб', 'что он ломает и сколько за это дают'],
  V: ['Устойчивость', 'как не дать себя потушить'],
};

/** Экран дерева эволюций — модальное окно поверх карты. */
export class TreeView {
  private el: HTMLElement;
  private onBuy?: (id: string) => void;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'modal';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('modal') || t.id === 'closeTree') this.hide();
      const card = t.closest<HTMLElement>('.evo');
      if (card && !card.classList.contains('locked') && !card.classList.contains('owned')) {
        this.onBuy?.(card.dataset.id!);
      }
    });
  }

  onPurchase(fn: (id: string) => void): void {
    this.onBuy = fn;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(s: WorldState): void {
    this.el.hidden = false;
    this.render(s);
  }

  hide(): void {
    this.el.hidden = true;
  }

  toggle(s: WorldState): void {
    if (this.visible) this.hide();
    else this.show(s);
  }

  render(s: WorldState): void {
    if (this.el.hidden) return;
    const branches = (['A', 'B', 'V'] as const).map((br) => {
      const items = EVOLUTIONS.filter((e) => e.branch === br).map((e) => {
        const owned = s.bought.includes(e.id);
        const unlocked = isUnlocked(e.id, s.bought);
        const buyable = canBuy(e.id, s.bought, s.sparks);
        const cls = owned ? 'owned' : !unlocked || !buyable ? 'locked' : 'ready';
        const note = owned ? 'куплено'
          : !unlocked ? `нужно: ${e.needs}`
          : !buyable ? `не хватает ${Math.ceil(e.cost - s.sparks)}`
          : 'купить';
        return `
          <li class="evo ${cls}" data-id="${e.id}">
            <div class="evo-head">
              <b>${e.name}</b>
              <span class="evo-cost">${e.cost}</span>
            </div>
            <p>${e.desc}</p>
            <span class="evo-note">${note}</span>
          </li>`;
      }).join('');
      const [title, sub] = BRANCH_TITLE[br];
      return `<section class="branch">
          <header><b>${title}</b><span>${sub}</span></header>
          <ul>${items}</ul>
        </section>`;
    }).join('');

    this.el.innerHTML = `
      <div class="sheet">
        <header class="sheet-head">
          <div><b>Эволюция огня</b><span>${Math.floor(s.sparks)} искр в запасе</span></div>
          <button id="closeTree" class="close">&times;</button>
        </header>
        <div class="branches">${branches}</div>
      </div>`;
  }
}
