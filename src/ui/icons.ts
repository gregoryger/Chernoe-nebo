import { createElement, Flame, GitBranch, LocateFixed, Menu, Newspaper, Pause, Play, X } from 'lucide';

const icons = { flame: Flame, evolution: GitBranch, locate: LocateFixed, menu: Menu, news: Newspaper, pause: Pause, play: Play, close: X };

export function icon(name: keyof typeof icons): string {
  return createElement(icons[name], { width: 18, height: 18, 'aria-hidden': 'true', 'focusable': 'false' }).outerHTML;
}
