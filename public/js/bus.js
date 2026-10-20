/**
 * Events between the screens, so no module has to know which others react:
 *   'telescope' state · 'config' config · 'screen' name · 'tab' name (a tab was opened by the user)
 *   'view' (the live view's visibility or sources changed) · 'album-changed'
 * A throwing listener is reported and never stops the others.
 */
const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function emit(name, arg) {
  for (const fn of [...(listeners.get(name) ?? [])]) {
    try {
      fn(arg);
    } catch (e) {
      console.error(`listener for '${name}' failed`, e);
    }
  }
}
