interface DialogOptions {
  onClose?: () => void;
  initialFocus?: string;
}

/** Keep keyboard focus inside an open dialog and return it when the dialog closes. */
export function activateDialog(el: HTMLElement, options: DialogOptions = {}): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.tabIndex = -1;

  const focusable = () => [...el.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);

  const focusFirst = () => {
    const target = options.initialFocus ? el.querySelector<HTMLElement>(options.initialFocus) : null;
    (target ?? focusable()[0] ?? el).focus({ preventScroll: true });
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (el.hidden || !el.isConnected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    const active = document.activeElement;
    if (!first) {
      event.preventDefault();
      el.focus();
    } else if (event.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
      event.preventDefault();
      last!.focus();
    } else if (!event.shiftKey && (active === last || !items.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  const onFocus = (event: FocusEvent) => {
    if (!el.hidden && el.isConnected && event.target instanceof Node && !el.contains(event.target)) focusFirst();
  };

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocus);
  focusFirst();
  return () => {
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocus);
    if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
  };
}
