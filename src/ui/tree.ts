import { BY_ID, EVOLUTIONS, canBuy, isUnlocked } from '../sim/evolutions';
import type { WorldState } from '../sim/types';
import { activateDialog } from './dialog';

const BRANCH_TITLE: Record<string, [string, string]> = {
  A: ['Распространение', 'куда и как быстро идёт огонь'],
  B: ['Ущерб', 'что он ломает и сколько за это дают'],
  V: ['Устойчивость', 'как не дать себя потушить'],
};

/** Экран дерева эволюций — модальное окно поверх карты. */
export class TreeView {
  private el: HTMLElement;
  private onBuy?: (id: string) => void;
  private onVisibility?: (visible: boolean) => void;
  private releaseFocus?: () => void;
  private lastRender = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'modal';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'tree-title');
    this.el.hidden = true;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const t = e.target;
      if (t === this.el || t.closest('#closeTree')) {
        this.hide();
        return;
      }
      const card = t.closest<HTMLElement>('.evo');
      if (card && !card.classList.contains('locked') && !card.classList.contains('owned')) {
        this.onBuy?.(card.dataset.id!);
      }
    });
  }

  onPurchase(fn: (id: string) => void): void {
    this.onBuy = fn;
  }

  onVisibilityChange(fn: (visible: boolean) => void): void {
    this.onVisibility = fn;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(s: WorldState): void {
    if (this.visible) return;
    this.el.hidden = false;
    this.onVisibility?.(true);
    this.render(s);
    this.releaseFocus = activateDialog(this.el, { onClose: () => this.hide(), initialFocus: '#closeTree' });
  }

  hide(): void {
    if (!this.visible) return;
    this.el.hidden = true;
    this.releaseFocus?.();
    this.releaseFocus = undefined;
    this.onVisibility?.(false);
  }

  toggle(s: WorldState): void {
    if (this.visible) this.hide();
    else this.show(s);
  }

  render(s: WorldState): void {
    if (this.el.hidden) return;
    const renderKey = `${Math.floor(s.sparks)}:${s.bought.join(',')}`;
    if (renderKey === this.lastRender) return;
    this.lastRender = renderKey;
    const scrollTop = this.el.querySelector('.sheet')?.scrollTop ?? 0;
    const active = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement)
      ? document.activeElement.id : '';
    const branches = (['A', 'B', 'V'] as const).map((br) => {
      const items = EVOLUTIONS.filter((e) => e.branch === br).map((e) => {
        const owned = s.bought.includes(e.id);
        const unlocked = isUnlocked(e.id, s.bought);
        const buyable = canBuy(e.id, s.bought, s.sparks);
        const cls = owned ? 'owned' : !unlocked || !buyable ? 'locked' : 'ready';
        const note = owned ? 'куплено'
          : !unlocked ? `нужно: ${e.needs ? BY_ID[e.needs].name : ''}`
          : !buyable ? `не хватает ${Math.ceil(e.cost - s.sparks)} искр`
          : 'купить';
        return `
          <li class="evo ${cls}" data-id="${e.id}">
            <button type="button" class="evo-choice" id="evo-${e.id}" aria-disabled="${!buyable}" aria-labelledby="evo-name-${e.id}" aria-describedby="evo-cost-${e.id} evo-desc-${e.id} evo-note-${e.id}">
              <span class="evo-head">
                <b id="evo-name-${e.id}">${e.name}</b>
                <span class="evo-cost" id="evo-cost-${e.id}" aria-label="${e.cost} искр">${e.cost}</span>
              </span>
              <span class="evo-desc" id="evo-desc-${e.id}">${e.desc}</span>
              <span class="evo-note" id="evo-note-${e.id}">${note}</span>
            </button>
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
          <div><b id="tree-title" role="heading" aria-level="2">Эволюция огня</b><span aria-live="polite">${Math.floor(s.sparks)} искр в запасе</span></div>
          <button type="button" id="closeTree" class="close" aria-label="Закрыть эволюции" title="Закрыть эволюции">&times;</button>
        </header>
        <div class="branches">${branches}</div>
      </div>`;
    if (active) this.el.querySelector<HTMLElement>(`#${active}`)?.focus({ preventScroll: true });
    this.el.querySelector('.sheet')!.scrollTop = scrollTop;
  }
}
