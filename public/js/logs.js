/** The server log, live. */
import { $ } from './dom.js';

const LOG_LINES = 400;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function addLog(l) {
  if (!l || typeof l !== 'object') return;
  const level = LEVELS.has(l.level) ? l.level : 'info';
  const el = document.createElement('div');
  el.className = level;
  el.textContent = `${new Date(l.ts).toLocaleTimeString()} ${level.toUpperCase()} [${l.scope ?? ''}] ${l.msg ?? ''}`;
  const log = $('#log');
  log.appendChild(el);
  while (log.children.length > LOG_LINES) log.firstChild.remove();
}

export function resetLog(entries) {
  $('#log').innerHTML = '';
  for (const l of Array.isArray(entries) ? entries : []) addLog(l);
}
