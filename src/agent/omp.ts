/**
 * Runs Oh My Pi (`omp --mode rpc`) as the telescope agent and bridges its NDJSON event stream to
 * the web UI. Config and workspace: omp/setup.ts; frame shapes: omp/frames.ts; the chat view:
 * omp/chat.ts.
 *
 * The process is supervised: it restarts after an exit (backing off up to a minute), a failed
 * handshake kills it for a clean restart, and a busy turn with no output for `timing.stallMs` is
 * checked (a lost end event is repaired; a hung process is killed and restarted).
 */
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { config, type ReasoningEffort } from '../config.js';
import { logger, errMsg } from '../log.js';
import { ChatLog, TOOL_RESULT_CHARS, type AssistantEntry, type ChatEntry } from './omp/chat.js';
import { ChunkAssembler, capturedImages, errorText, imageCount, prettyTool, textOf, thinkingOf, toolCalls, type Frame, type OmpMessage, type OmpState } from './omp/frames.js';
import { MCP_TIMEOUT_MS, appendPromptPath, seedWorkspace, skillsDir, systemPromptPath, writeAgentConfig } from './omp/setup.js';
import { withoutCredentials } from '../util/url.js';
import { SafeEmitter } from '../util/events.js';

export type { ChatEntry } from './omp/chat.js';

const log = logger('agent');

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/** After stdin is closed, the process gets this long to exit before SIGTERM. */
const STOP_GRACE_MS = 2_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 120_000;
const HISTORY_TIMEOUT_MS = 30_000;
const COMPACT_TIMEOUT_MS = 600_000;
/** A line longer than this from omp is dropped (a runaway frame must not exhaust memory). */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;
/** Live tool output goes to the UI at most this often per tool. */
const TOOL_UPDATE_EMIT_MS = 500;
const AGENT_TOOLS = 'read,write,edit,grep,glob,bash,todo';

/** What the agent is doing right now (for the status line). */
export type Activity = { kind: 'idle' | 'thinking' | 'writing' | 'tool' | 'compacting' | 'retrying'; tool?: string; since: number };
export interface TodoPhase {
  name: string;
  tasks: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'; blocker?: string }>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const isPhases = (x: unknown): x is TodoPhase[] => Array.isArray(x) && x.every((p) => !!p && typeof (p as TodoPhase).name === 'string' && Array.isArray((p as TodoPhase).tasks));
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** A list of strings from omp (anything else in it dropped). */
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

export class AgentBridge extends SafeEmitter {
  private proc: ChildProcess | null = null;
  private buf = '';
  private reqSeq = 0;
  private noteSeq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly chunks = new ChunkAssembler();
  private readonly chat = new ChatLog();
  private stopping = false;
  private restartDelay = RESTART_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** last time omp wrote anything: a busy turn with nothing for a long time is checked */
  private lastFrameAt = 0;
  private mcpUrl = '';
  /** first thinking delta of each streaming message, to time the reasoning */
  private readonly thinkStart = new Map<string, number>();
  private readonly toolEmitAt = new Map<string, number>();
  /**
   * stallMs: a busy turn silent this long is checked with get_state (longer than the 15-min MCP
   * tool timeout, so a long tool call is never mistaken for a hang). checkEveryMs: how often.
   */
  readonly timing = { stallMs: 20 * 60_000, checkEveryMs: 60_000, stateTimeoutMs: 15_000 };
  busy = false;
  ready = false;
  model = '';
  /** omp's thinking level (it may report one this controller does not name) */
  thinking: string = config.llm.reasoningEffort;
  lastError: string | null = null;
  activity: Activity = { kind: 'idle', since: Date.now() };
  turnStartedAt: number | null = null;
  queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  todos: TodoPhase[] = [];
  context: { tokens: number; contextWindow: number; percent: number } | null = null;
  tokensPerSecond: number | null = null;

  get history(): ChatEntry[] {
    return this.chat.entries;
  }

  get skillsDir(): string {
    return skillsDir();
  }

  // ---------------------------------------------------------------- lifecycle
  async start(mcpUrl: string): Promise<void> {
    this.mcpUrl = config.agent.mcpUrl || mcpUrl;
    this.stopping = false;
    writeAgentConfig(this.mcpUrl);
    seedWorkspace();
    if (!this.proc && !this.restartTimer) this.spawnProc();
    if (!this.watchdog && this.timing.checkEveryMs > 0) {
      this.watchdog = setInterval(() => void this.checkStall().catch((e) => log.warn(`stall check: ${errMsg(e)}`)), this.timing.checkEveryMs);
      this.watchdog.unref();
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const proc = this.proc;
    if (!proc) return;
    proc.stdin?.end();
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    }, STOP_GRACE_MS).unref();
  }

  /**
   * A turn that has been busy with no output from omp for stallMs: ask omp. Not streaming → the
   * turn's end was missed, so it is marked ended (else the duty loop never wakes the agent again).
   * No answer → omp is hung: it is killed and restarted.
   */
  async checkStall(): Promise<void> {
    if (!this.busy || !this.ready || !this.proc) return;
    if (Date.now() - this.lastFrameAt < this.timing.stallMs) return;
    const proc = this.proc;
    const silentMin = Math.round((Date.now() - this.lastFrameAt) / 60_000);
    const st = await this.command<OmpState>('get_state', {}, this.timing.stateTimeoutMs).catch(() => null);
    if (!this.busy || this.proc !== proc) return;
    if (!st) {
      this.lastError = `agent unresponsive: busy with no output for ${silentMin} min and it did not answer a state request`;
      log.warn(`${this.lastError} — restarting it`);
      this.note('error', `${this.lastError} — restarting the agent.`);
      proc.kill('SIGKILL');
      return;
    }
    if (st.isStreaming === false) {
      log.warn(`agent marked idle: busy with no output for ${silentMin} min and omp reports no running turn`);
      this.note('warn', `The agent's turn ended without an end event (no output for ${silentMin} min): marked idle.`);
      this.setBusy(false);
    } else {
      // still working (a long tool call): look again one stall period from now
      this.lastFrameAt = Date.now();
    }
  }

  private spawnArgs(): string[] {
    const args = [
      '--mode', 'rpc',
      '--model', `astro/${config.llm.model}`,
      '--thinking', config.llm.reasoningEffort,
      '--session-dir', config.paths.sessions,
      '--continue',
      '--system-prompt', systemPromptPath(),
    ];
    if (fs.existsSync(appendPromptPath())) args.push('--append-system-prompt', appendPromptPath());
    args.push('--tools', AGENT_TOOLS, '--no-lsp', '--no-title');
    return args;
  }

  private spawnProc(): void {
    this.restartTimer = null;
    if (this.stopping) return;
    log.info(`starting ${config.agent.command} (model astro/${config.llm.model} @ ${withoutCredentials(config.llm.baseUrl)}, thinking ${config.llm.reasoningEffort})`);
    const proc = spawn(config.agent.command, this.spawnArgs(), {
      cwd: config.paths.workspace,
      env: {
        ...process.env,
        HOME: config.paths.home,
        ASTRO_LLM_API_KEY: config.llm.apiKey || 'none',
        PI_NO_TITLE: '1',
        OMP_MCP_TIMEOUT_MS: String(MCP_TIMEOUT_MS),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.ready = false;
    this.buf = '';
    this.chunks.reset();
    this.lastFrameAt = Date.now();
    // writing to a pipe whose reader has died raises EPIPE on the stream: never an unhandled error
    proc.stdin!.on('error', (err) => log.warn(`agent stdin: ${errMsg(err)}`));
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => {
      if (this.proc === proc) this.onData(d);
    });
    let errTail = '';
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      errTail = (errTail + d).slice(-STDERR_TAIL_CHARS);
      for (const line of d.split('\n')) if (line.trim()) log.debug(`omp: ${line.trim()}`);
    });
    let startError: string | null = null;
    proc.on('error', (err) => {
      startError = `cannot start "${config.agent.command}": ${errMsg(err)}`;
      this.lastError = startError;
      log.error(this.lastError);
    });
    // 'close', not 'exit': a command that cannot be started (ENOENT) emits 'error' and 'close' only
    proc.on('close', (code, sig) => {
      if (this.proc !== proc) return;
      this.onExit();
      if (this.stopping) return;
      const tail = errTail.trim().split('\n').slice(-3).join(' | ');
      this.lastError = startError ?? `agent exited (${code ?? sig})${tail ? `: ${tail}` : ''}`;
      log.warn(this.lastError);
      this.note('error', startError ? `${startError} — retrying in ${Math.round(this.restartDelay / 1000)} s.` : `Agent process exited — restarting. ${tail}`);
      this.restartTimer = setTimeout(() => this.spawnProc(), this.restartDelay);
      this.restartTimer.unref();
      this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
      this.emit('status', this.status());
    });
  }

  /** The process is gone: fail what waited on it, and close what it left open. */
  private onExit(): void {
    this.proc = null;
    this.ready = false;
    this.buf = '';
    this.chunks.reset();
    for (const p of this.pending.values()) p.reject(new Error('agent exited'));
    this.pending.clear();
    this.thinkStart.clear();
    this.toolEmitAt.clear();
    for (const e of this.chat.settleUnfinished('the agent process ended')) this.emit('event', { kind: 'entry', entry: e });
    this.setBusy(false);
  }

  // ---------------------------------------------------------------- RPC
  private send(obj: Record<string, unknown>): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  }

  private command<T = unknown>(type: string, extra: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const id = `ac_${++this.reqSeq}`;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent command ${type} timed out`));
      }, timeoutMs);
      t.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      // no process to write to: fail now, not after the timeout
      if (!this.send({ id, type, ...extra })) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.reject(new Error(this.lastError ?? 'the agent is not running'));
      }
    });
  }

  private onData(chunk: string): void {
    this.lastFrameAt = Date.now();
    this.buf += chunk;
    // one pass over the buffer: slicing it after every line is quadratic on a chunk of many lines
    let from = 0;
    let nl: number;
    while ((nl = this.buf.indexOf('\n', from)) >= 0) {
      const line = this.buf.slice(from, nl).trim();
      from = nl + 1;
      if (line) this.onLine(line);
      // a frame handler may have restarted the process (and cleared the buffer)
      if (this.buf.length < from) return;
    }
    if (from) this.buf = this.buf.slice(from);
    if (this.buf.length > MAX_LINE_CHARS) {
      log.warn(`dropping ${this.buf.length} chars from omp with no line end`);
      this.buf = '';
    }
  }

  private onLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      log.debug(`non-JSON from omp: ${line.slice(0, 200)}`);
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    try {
      this.onFrame(frame as Frame);
    } catch (err) {
      // one odd frame must never take the bridge down
      log.warn(`could not handle a ${(frame as Frame).type ?? 'typeless'} frame from omp: ${errMsg(err)}`);
    }
  }

  // ---------------------------------------------------------------- frames
  private onFrame(f: Frame): void {
    switch (f.type) {
      case 'rpc_chunk': {
        const json = this.chunks.push(f);
        if (json !== null) this.onLine(json);
        return;
      }
      case 'ready':
        void this.onReady(f);
        return;
      case 'response':
        return this.onResponse(f);
      case 'agent_start':
        this.turnStartedAt = Date.now();
        this.setBusy(true);
        return;
      case 'queue_update':
        this.queue = { steering: strings(f.steering), followUp: strings(f.followUp) };
        this.emit('status', this.status());
        return;
      case 'auto_retry_end':
      case 'auto_compaction_end':
        this.setActivity(this.busy ? 'thinking' : 'idle');
        void this.refreshState();
        return;
      case 'tool_execution_update':
        return this.onToolUpdate(f);
      case 'prompt_result': {
        const e = f.error as { message?: string; httpStatus?: number } | undefined;
        if (f.status === 'error' && e) this.note('error', `LLM error: ${errorText(e, 'unknown')}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}`);
        return;
      }
      case 'session_settled':
        this.setBusy(false);
        void this.refreshState();
        return;
      case 'agent_end':
        if (f.yielded !== false) this.setBusy(false);
        void this.refreshState();
        return;
      case 'message_start':
        if (f.message?.role === 'assistant' && f.messageId) this.upsertAssistant(f.messageId, '', '', true);
        return;
      case 'message_update':
        return this.onMessageUpdate(f);
      case 'message_end':
        return this.onMessageEnd(f);
      case 'tool_execution_start': {
        if (!f.toolCallId) return;
        const name = prettyTool(f.toolName);
        this.push({ kind: 'tool', id: f.toolCallId, name, args: f.args, intent: f.intent, status: 'running', at: Date.now() });
        this.setActivity('tool', name);
        return;
      }
      case 'tool_execution_end':
        return this.onToolEnd(f);
      case 'auto_compaction_start':
        this.note('info', 'Compacting conversation context…');
        this.setActivity('compacting');
        return;
      case 'auto_retry_start':
        this.setActivity('retrying');
        this.note('warn', `Retrying LLM request (${f.attempt ?? ''}/${f.maxAttempts ?? ''}): ${f.errorMessage ?? ''}`);
        return;
      case 'extension_error':
        this.note('warn', `extension error: ${errorText(f.error, 'unknown')}`);
        return;
      case 'notice': {
        // a notice's message is plain text, not a chat message
        const text: unknown = f.message;
        if (typeof text === 'string' && text) this.note(f.level === 'error' ? 'error' : f.level === 'warn' ? 'warn' : 'info', text);
        return;
      }
      default:
        return;
    }
  }

  private onResponse(f: Frame): void {
    const p = f.id ? this.pending.get(f.id) : undefined;
    if (p) {
      this.pending.delete(f.id!);
      if (f.success) p.resolve(f.data);
      else p.reject(new Error(errorText(f.error, 'agent command failed')));
    } else if (!f.success) {
      this.note('error', errorText(f.error, 'agent error'));
    }
  }

  private onToolUpdate(f: Frame): void {
    const e = f.toolCallId ? this.chat.tool(f.toolCallId) : undefined;
    const content = f.partialResult?.content;
    if (!e || !Array.isArray(content)) return;
    e.result = textOf(content).slice(-TOOL_RESULT_CHARS);
    const last = this.toolEmitAt.get(e.id) ?? 0;
    if (Date.now() - last > TOOL_UPDATE_EMIT_MS) {
      this.toolEmitAt.set(e.id, Date.now());
      this.emit('event', { kind: 'entry', entry: e });
    }
  }

  private onToolEnd(f: Frame): void {
    const id = f.toolCallId;
    const textOut = textOf(f.result?.content);
    const phases = f.result?.details?.phases;
    if (isPhases(phases)) {
      this.todos = phases;
      this.emit('status', this.status());
    }
    if (id) this.toolEmitAt.delete(id);
    if (this.busy) this.setActivity('thinking');
    const e = id ? this.chat.tool(id) : undefined;
    if (!e) return;
    e.status = f.isError ? 'error' : 'ok';
    e.result = textOut.slice(0, TOOL_RESULT_CHARS);
    e.images = capturedImages(textOut);
    e.ms = Date.now() - e.at;
    this.emit('event', { kind: 'entry', entry: e });
  }

  private onMessageUpdate(f: Frame): void {
    const ev = f.assistantMessageEvent;
    if (!ev || !f.messageId || typeof ev.delta !== 'string') return;
    if (ev.type !== 'text_delta' && ev.type !== 'thinking_delta') return;
    const e = this.chat.assistant(f.messageId) ?? this.upsertAssistant(f.messageId, '', '', true);
    if (ev.type === 'text_delta') {
      e.text += ev.delta;
      this.endThinking(e);
      this.setActivity('writing');
    } else {
      e.thinking += ev.delta;
      if (!this.thinkStart.has(e.id)) this.thinkStart.set(e.id, Date.now());
      this.setActivity('thinking');
    }
    this.emit('event', { kind: 'delta', id: f.messageId, channel: ev.type === 'text_delta' ? 'text' : 'thinking', delta: ev.delta });
  }

  private onMessageEnd(f: Frame): void {
    const m = f.message;
    if (m?.role === 'assistant' && f.messageId) {
      const e = this.upsertAssistant(f.messageId, textOf(m.content, ''), thinkingOf(m.content), false);
      this.endThinking(e);
      if (!e.text && !e.thinking) this.chat.remove(e);
      if (m.stopReason === 'error' && m.errorMessage) this.note('error', `LLM error: ${m.errorMessage}`);
      this.emit('event', { kind: 'entry', entry: e });
    } else if (m?.role === 'user' && !m.synthetic) {
      this.push({ kind: 'user', id: f.messageId ?? `u${Date.now().toString(36)}_${++this.noteSeq}`, text: textOf(m.content), images: imageCount(m.content), at: Date.now() });
    }
  }

  private async onReady(f: Frame): Promise<void> {
    const proc = this.proc;
    try {
      if ((f.supportedProtocolVersions ?? []).includes(2)) await this.command('negotiate_protocol', { protocolVersion: 2 });
      await this.command('set_event_filter', { events: null, messageUpdates: 'delta' }).catch(() => undefined);
      const state = await this.command<OmpState>('get_state').catch(() => null);
      if (this.proc !== proc) return;
      this.model = state?.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : `astro/${config.llm.model}`;
      this.thinking = state?.thinkingLevel ?? this.thinking;
      this.ready = true;
      this.restartDelay = RESTART_MIN_MS;
      this.lastError = null;
      await this.loadHistory();
      await this.refreshState();
      log.info(`agent ready (${this.model}, thinking ${this.thinking})`);
      this.emit('status', this.status());
    } catch (err) {
      // not ready would otherwise last until the process happens to exit: restart it now
      if (!proc || this.proc !== proc) return; // it already exited (and is being restarted)
      this.ready = false;
      this.lastError = `agent handshake failed: ${errMsg(err)}`;
      log.warn(`${this.lastError} — restarting it`);
      this.emit('status', this.status());
      proc.kill('SIGKILL');
    }
  }

  /** Rebuild the chat view from the resumed session. */
  private async loadHistory(): Promise<void> {
    const res = await this.command<{ messages?: OmpMessage[] }>('get_messages', {}, HISTORY_TIMEOUT_MS).catch(() => null);
    const msgs = Array.isArray(res?.messages) ? res.messages : [];
    const entries: ChatEntry[] = [];
    const tools = new Map<string, Extract<ChatEntry, { kind: 'tool' }>>();
    msgs.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const at = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
      if (m.role === 'user' && !m.synthetic) {
        entries.push({ kind: 'user', id: `h${i}`, text: textOf(m.content), images: imageCount(m.content), at });
      } else if (m.role === 'assistant') {
        const text = textOf(m.content, '');
        const thinking = thinkingOf(m.content);
        if (text || thinking) entries.push({ kind: 'assistant', id: `h${i}`, text, thinking, at });
        for (const c of toolCalls(m.content)) {
          const e: Extract<ChatEntry, { kind: 'tool' }> = { kind: 'tool', id: c.id, name: prettyTool(c.name), args: c.arguments, status: 'ok', at };
          tools.set(c.id, e);
          entries.push(e);
        }
      } else if (m.role === 'toolResult' && m.toolCallId) {
        const e = tools.get(m.toolCallId);
        if (!e) return;
        const t = textOf(m.content);
        e.status = m.isError ? 'error' : 'ok';
        e.result = t.slice(0, TOOL_RESULT_CHARS);
        e.images = capturedImages(t);
      }
    });
    this.chat.reset(entries);
    this.emit('event', { kind: 'reset', history: this.history });
  }

  // ---------------------------------------------------------------- chat
  private upsertAssistant(id: string, text: string, thinking: string, streaming: boolean): AssistantEntry {
    const e = this.chat.assistant(id);
    if (!e) {
      const fresh: AssistantEntry = { kind: 'assistant', id, text, thinking, at: Date.now(), streaming };
      this.push(fresh);
      return fresh;
    }
    if (!streaming || text) e.text = text || e.text;
    if (!streaming || thinking) e.thinking = thinking || e.thinking;
    e.streaming = streaming;
    return e;
  }

  private push(e: ChatEntry): void {
    this.chat.push(e);
    this.emit('event', { kind: 'entry', entry: e });
  }

  note(level: 'info' | 'warn' | 'error', text: string): void {
    this.push({ kind: 'notice', id: `n${Date.now().toString(36)}_${++this.noteSeq}`, level, text, at: Date.now() });
  }

  private endThinking(e: AssistantEntry): void {
    const t0 = this.thinkStart.get(e.id);
    if (t0 === undefined) return;
    this.thinkStart.delete(e.id);
    e.thinkingMs = Date.now() - t0;
  }

  // ---------------------------------------------------------------- status
  private setBusy(b: boolean): void {
    if (this.busy === b) return;
    this.busy = b;
    if (!b) {
      this.activity = { kind: 'idle', since: Date.now() };
      this.turnStartedAt = null;
    } else if (this.activity.kind === 'idle') this.activity = { kind: 'thinking', since: Date.now() };
    this.emit('status', this.status());
  }

  status() {
    return {
      ready: this.ready,
      busy: this.busy,
      model: this.model || `astro/${config.llm.model}`,
      thinking: this.thinking,
      baseUrl: withoutCredentials(config.llm.baseUrl),
      error: this.lastError,
      activity: this.activity,
      turnStartedAt: this.busy ? this.turnStartedAt : null,
      queue: this.queue,
      todos: this.todos,
      context: this.context,
      tokensPerSecond: this.tokensPerSecond,
    };
  }

  private setActivity(kind: Activity['kind'], tool?: string): void {
    if (this.activity.kind === kind && this.activity.tool === tool) return;
    this.activity = { kind, tool, since: Date.now() };
    this.emit('status', this.status());
  }

  /** Context usage, queue, todos and speed from omp (after every turn). */
  async refreshState(): Promise<void> {
    if (!this.ready) return;
    const st = await this.command<OmpState>('get_state', {}, this.timing.stateTimeoutMs).catch(() => null);
    if (!st) return;
    const cu = st.contextUsage;
    if (cu && isNum(cu.tokens) && isNum(cu.contextWindow) && isNum(cu.percent)) this.context = { tokens: cu.tokens, contextWindow: cu.contextWindow, percent: cu.percent };
    if (st.queuedMessages && typeof st.queuedMessages === 'object') this.queue = { steering: strings(st.queuedMessages.steering), followUp: strings(st.queuedMessages.followUp) };
    if (isPhases(st.todoPhases)) this.todos = st.todoPhases;
    if (isNum(st.tokensPerSecond)) this.tokensPerSecond = st.tokensPerSecond;
    if (!st.isStreaming && !this.busy && this.activity.kind !== 'idle') this.activity = { kind: 'idle', since: Date.now() };
    this.emit('status', this.status());
  }

  // ---------------------------------------------------------------- actions
  /**
   * Send a message. While the agent works, "steer" delivers it at the next step of the running
   * turn and "followUp" queues it until the turn ends (omp's two queues).
   */
  async prompt(text: string, images: Array<{ data: string; mimeType: string }> = [], mode: 'auto' | 'steer' | 'followUp' = 'auto'): Promise<void> {
    if (!this.ready) throw new Error(this.lastError ?? 'agent is not ready yet');
    const imgs = images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }));
    const behaviour = this.busy ? (mode === 'followUp' ? 'followUp' : 'steer') : undefined;
    await this.command('prompt', { message: text, images: imgs.length ? imgs : undefined, ...(behaviour ? { streamingBehavior: behaviour } : {}) }, PROMPT_TIMEOUT_MS);
  }

  async removeQueued(message: string, queue: 'steering' | 'followUp'): Promise<boolean> {
    const r = await this.command<{ removed?: boolean } | null>('remove_queued_message', { message, queue });
    await this.refreshState();
    return !!r?.removed;
  }

  async compact(): Promise<void> {
    this.note('info', 'Compacting conversation context…');
    this.setActivity('compacting');
    try {
      await this.command('compact', {}, COMPACT_TIMEOUT_MS);
    } finally {
      this.setActivity(this.busy ? 'thinking' : 'idle');
      await this.refreshState();
    }
  }

  async abort(): Promise<void> {
    await this.command('abort').catch(() => undefined);
  }

  async newSession(): Promise<void> {
    await this.command('new_session');
    this.chat.reset();
    this.todos = [];
    this.thinkStart.clear();
    this.toolEmitAt.clear();
    this.emit('event', { kind: 'reset', history: [] });
    await this.refreshState();
  }

  async setThinking(level: ReasoningEffort): Promise<void> {
    await this.command('set_thinking_level', { level });
    this.thinking = level;
    this.emit('status', this.status());
  }
}
