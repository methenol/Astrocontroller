/** The state socket (/ws): everything the server pushes, dispatched to the screens. Reconnects by itself. */
import { toast } from './dom.js';
import { wsUrl } from './api.js';
import { emit } from './bus.js';
import { state } from './state.js';
import { renderTelescope, setConn } from './telescope.js';
import { renderAgentStatus, renderChat, onAgentEvent } from './chat.js';
import { renderDuty } from './duty.js';
import { renderJobs, renderProcessing, addCapture } from './library.js';
import { resetLog, addLog } from './logs.js';
import { renderStreamHealth } from './video.js';
import { onStellariumMessage } from './stellarium.js';
import { renderGuardState } from './weather.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10000;
let retry = 0;

function hello(m) {
  state.config = m.config ?? null;
  state.history = Array.isArray(m.history) ? m.history : [];
  state.jobs.clear();
  for (const j of m.jobs ?? []) state.jobs.set(j.id, j);
  state.proc.clear();
  for (const i of m.processing ?? []) state.proc.set(i.id, i);
  renderTelescope(m.telescope);
  emit('config', state.config);
  renderAgentStatus(m.agent);
  renderDuty(m.duty);
  renderChat();
  renderJobs();
  renderProcessing();
  resetLog(m.logs);
  if (m.guard) renderGuardState(m.guard);
}

const HANDLERS = {
  hello,
  telescope: (m) => renderTelescope(m.state),
  config: (m) => {
    state.config = m.config;
    emit('config', m.config);
  },
  agentStatus: (m) => renderAgentStatus(m.status),
  duty: (m) => renderDuty(m.duty),
  agent: (m) => onAgentEvent(m.event),
  log: (m) => addLog(m.entry),
  job: (m) => {
    if (!m.job?.id) return;
    state.jobs.set(m.job.id, m.job);
    renderJobs();
  },
  processing: (m) => {
    if (m.item?.id) state.proc.set(m.item.id, m.item);
    renderProcessing();
  },
  capture: (m) => addCapture(m.path, m.label),
  notify: (m) => {
    if (m.name === 'albumUpdate') emit('album-changed');
  },
  error: (m) => toast(m.message, true),
  streams: (m) => renderStreamHealth(m.streams, m.now),
  stellarium: onStellariumMessage,
  guard: (m) => renderGuardState(m.guard),
};

function handle(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    console.warn('the server sent a frame that is not JSON');
    return;
  }
  // own handlers only: a type such as "constructor" must not reach a prototype method
  const fn = m && typeof m === 'object' && Object.hasOwn(HANDLERS, m.type) ? HANDLERS[m.type] : undefined;
  if (!fn) return;
  try {
    fn(m);
  } catch (e) {
    // one bad message never stops the ones after it
    console.error(`handling '${m.type}' failed`, e);
  }
}

export function connect() {
  const ws = new WebSocket(wsUrl('ws'));
  ws.onopen = () => {
    retry = 0;
    emit('socket', true);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') handle(ev.data);
  };
  ws.onclose = () => {
    setConn(false, 'UI disconnected');
    emit('socket', false);
    setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** retry++, RETRY_MAX_MS));
  };
}
