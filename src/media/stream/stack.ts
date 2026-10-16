/** The telescope's own multipart JPEG stream on :8092/mainstream (the live stack, and the tele preview in astro modes). */
import { config } from '../../config.js';
import { logger, errMsg } from '../../log.js';
import { JpegSplitter } from './jpeg.js';
import { Source } from './source.js';

const log = logger('stream');

const RETRY_MS = 3000;
/** A connection that delivers no bytes for this long is dropped and reopened. */
const SILENT_MS = 90000;

export class StackSource extends Source {
  private abort: AbortController | null = null;
  private retry: NodeJS.Timeout | null = null;

  /** Whether the telescope may be contacted now (set by the hub: linked and connected). */
  allowed: () => boolean = () => true;

  constructor() {
    super('stack');
  }

  protected startSource(): void {
    void this.connect();
  }

  protected stopSource(): void {
    this.clearRetry();
    this.abort?.abort();
    this.abort = null;
  }

  /** Drop the current connection; the loop reconnects when allowed. */
  interrupt(): void {
    this.abort?.abort();
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private schedule(): void {
    this.clearRetry();
    this.retry = setTimeout(() => void this.connect(), RETRY_MS);
    this.retry.unref();
  }

  private async connect(): Promise<void> {
    this.retry = null;
    if (!this.running) return;
    if (!this.allowed()) return this.schedule();
    const ac = new AbortController();
    this.abort = ac;
    let watchdog: NodeJS.Timeout | null = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => ac.abort(new Error(`no data for ${SILENT_MS / 1000} s`)), SILENT_MS);
      watchdog.unref();
    };
    try {
      arm();
      const res = await fetch(`http://${config.dwarf.host}:${config.dwarf.stackPort}/mainstream`, { signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const splitter = new JpegSplitter((jpeg) => this.frame(jpeg));
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        splitter.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    } catch (err) {
      if (this.running) log.debug(`stack stream: ${errMsg(ac.signal.aborted ? (ac.signal.reason ?? err) : err)}`);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      // an error reply's body (or a stream left early) is never read: close the telescope connection now
      ac.abort();
    }
    // one loop only: a stop + restart meanwhile started a new one with its own controller
    if (this.running && this.abort === ac) this.schedule();
  }
}
