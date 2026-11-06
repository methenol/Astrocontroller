/**
 * One Astrocontroller process per active profile. Each is the ordinary single-telescope app
 * (dist/index.js) with the profile's environment: its own driver, data folder (agent home,
 * workspace, sessions, notes), library folder, site, time zone and web port on loopback. Nothing
 * of one profile's runs in another's process, so two agents, two duty loops and two night plans
 * never share state.
 *
 * An inactive profile has no process: no link, no duty sample, no Starfront roof poll, no
 * autonomous night, no agent wake. A process that dies while its profile is active is started
 * again with a backoff; one that keeps dying at start (a configuration problem) is given up on and
 * shows its last output.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';

const log = logger('hub');

const OUTPUT_LINES = 400;
const READY_POLL_MS = 400;
const READY_TIMEOUT_MS = 90_000;
/** the child's own shutdown takes ~1.5 s; this covers a slow one before SIGKILL */
const STOP_GRACE_MS = 10_000;
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/** a process that ran this long was healthy: its next crash restarts at the minimum backoff */
const STABLE_MS = 60_000;
/** this many exits in a row before STABLE_MS = a configuration problem: stop trying */
const MAX_QUICK_EXITS = 5;

export type InstancePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'failed';

export interface InstanceStatus {
  phase: InstancePhase;
  pid: number | null;
  port: number;
  since: number;
  restarts: number;
  lastExit: string | null;
}

export interface InstanceSpec {
  id: string;
  name: string;
  port: number;
  env: Record<string, string>;
}

export interface InstanceOptions {
  /** node and the script of the single-telescope app */
  command: string;
  args: string[];
  cwd: string;
  spawnFn?: typeof spawn;
  probe?: (port: number) => Promise<boolean>;
  /** the first restart's delay (doubles up to a minute); tests shorten it */
  restartMinMs?: number;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** One profile's process. Events: 'status' (InstanceStatus), 'line' (string). */
export class Instance extends EventEmitter {
  private child: ChildProcess | null = null;
  private wanted = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  private quickExits = 0;
  private startedAt = 0;
  private readonly lines: string[] = [];
  private readonly st: InstanceStatus;
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private spec: InstanceSpec,
    private readonly o: InstanceOptions,
  ) {
    super();
    this.backoff = o.restartMinMs ?? RESTART_MIN_MS;
    this.st = { phase: 'stopped', pid: null, port: spec.port, since: Date.now(), restarts: 0, lastExit: null };
  }

  get id(): string {
    return this.spec.id;
  }

  get port(): number {
    return this.spec.port;
  }

  status(): InstanceStatus {
    return { ...this.st };
  }

  output(n = OUTPUT_LINES): string[] {
    return this.lines.slice(-n);
  }

  /** New settings take effect at the next start (restart() applies them now). */
  configure(spec: InstanceSpec): void {
    this.spec = spec;
    this.st.port = spec.port;
  }

  start(): void {
    this.wanted = true;
    this.quickExits = 0;
    this.backoff = this.o.restartMinMs ?? RESTART_MIN_MS;
    if (this.child) return;
    this.clearRestart();
    this.launch();
  }

  /** Stop the process and keep it stopped. Resolves once it has exited. */
  async stop(): Promise<void> {
    this.wanted = false;
    this.clearRestart();
    const child = this.child;
    if (!child) {
      if (this.st.phase !== 'failed') this.set('stopped');
      return;
    }
    this.set('stopping');
    child.kill('SIGTERM');
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn(`${this.spec.name}: did not stop within ${STOP_GRACE_MS / 1000} s, killing it`);
        child.kill('SIGKILL');
      }
    }, STOP_GRACE_MS);
    await this.exited;
    clearTimeout(kill);
  }

  async restart(): Promise<void> {
    await this.stop();
    this.st.restarts++;
    this.start();
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private set(phase: InstancePhase): void {
    if (this.st.phase === phase) return;
    this.st.phase = phase;
    this.st.since = Date.now();
    this.emit('status', this.status());
  }

  private remember(chunk: string, carry: { text: string }): void {
    const text = carry.text + chunk;
    const parts = text.split(/\r?\n/);
    carry.text = parts.pop() ?? '';
    for (const line of parts) {
      if (!line) continue;
      this.lines.push(line);
      this.emit('line', line);
      // the hub's own log carries every profile's output, tagged with its id
      process.stdout.write(`[${this.spec.id}] ${line}\n`);
    }
    if (this.lines.length > OUTPUT_LINES) this.lines.splice(0, this.lines.length - OUTPUT_LINES);
  }

  private launch(): void {
    const spawnFn = this.o.spawnFn ?? spawn;
    this.set('starting');
    this.startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawnFn(this.o.command, this.o.args, { cwd: this.o.cwd, env: this.spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.st.lastExit = `could not start: ${(e as Error).message}`;
      this.set('failed');
      return;
    }
    this.child = child;
    this.st.pid = child.pid ?? null;
    const out = { text: '' };
    const err = { text: '' };
    child.stdout?.setEncoding('utf8').on('data', (c: string) => this.remember(c, out));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => this.remember(c, err));
    let resolveExit!: () => void;
    this.exited = new Promise<void>((r) => (resolveExit = r));
    child.once('error', (e) => {
      this.remember(`could not start: ${e.message}\n`, err);
    });
    child.once('close', (code, signal) => {
      this.child = null;
      this.st.pid = null;
      this.st.lastExit = signal ? `killed by ${signal}` : `exited with code ${code}`;
      resolveExit();
      this.onExit();
    });
    void this.waitReady(child);
  }

  private async waitReady(child: ChildProcess): Promise<void> {
    const probe = this.o.probe ?? portOpen;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.child === child && Date.now() < deadline) {
      if (await probe(this.spec.port)) {
        if (this.child === child && this.st.phase === 'starting') {
          log.info(`${this.spec.name}: running (pid ${child.pid}, port ${this.spec.port})`);
          this.set('running');
        }
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (this.child === child) log.warn(`${this.spec.name}: its web server did not come up within ${READY_TIMEOUT_MS / 1000} s`);
  }

  private onExit(): void {
    if (!this.wanted) {
      this.set('stopped');
      return;
    }
    const ran = Date.now() - this.startedAt;
    if (ran >= STABLE_MS) {
      this.quickExits = 0;
      this.backoff = this.o.restartMinMs ?? RESTART_MIN_MS;
    } else if (++this.quickExits >= MAX_QUICK_EXITS) {
      log.error(`${this.spec.name}: ${this.st.lastExit} ${MAX_QUICK_EXITS} times in a row at start: given up (see its output in Profiles)`);
      this.wanted = false;
      this.set('failed');
      return;
    }
    log.warn(`${this.spec.name}: ${this.st.lastExit}; starting it again in ${Math.round(this.backoff / 1000)} s`);
    this.set('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.st.restarts++;
      if (this.wanted && !this.child) this.launch();
    }, this.backoff);
    this.restartTimer.unref?.();
    this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
  }
}
