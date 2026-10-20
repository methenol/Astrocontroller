/**
 * The processing outbox on disk (DATA_DIR/processing.json), so nothing is lost across restarts or
 * while the server is out of reach. Written atomically; an unreadable file is set aside, not
 * overwritten.
 */
import fs from 'node:fs';
import { logger, errMsg } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';

const log = logger('processing');

export type ItemState = 'waiting' | 'uploading' | 'submitted' | 'done' | 'failed' | 'cancelled';

export interface ProcessingItem {
  id: string;
  sessions: string[];
  target: string;
  profile: string;
  kind: string;
  origin: string;
  createdAt: number;
  state: ItemState;
  generation: number;
  /** times the job was sent again because the server restarted mid-job (not the user's retries) */
  resends?: number;
  access?: 'shared' | 'upload';
  upload?: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number };
  studioJobId?: string;
  studio?: { state: string; progress: number; message?: string; position?: number; startsInS?: number | null; etaS?: number | null; activeS?: number };
  outputs?: string[];
  message?: string;
  lastError?: string;
  attempts: number;
  finishedAt?: number;
}

export const OPEN_STATES: readonly ItemState[] = ['waiting', 'uploading', 'submitted'];
const STATES: ReadonlySet<string> = new Set<ItemState>(['waiting', 'uploading', 'submitted', 'done', 'failed', 'cancelled']);
export const isOpen = (it: ProcessingItem) => OPEN_STATES.includes(it.state);

/** Finished items kept in the outbox; older ones are dropped. */
const KEEP_FINISHED = 200;

function isItem(x: unknown): x is ProcessingItem {
  const i = x as ProcessingItem | null;
  return !!i && typeof i.id === 'string' && Array.isArray(i.sessions) && i.sessions.every((s) => typeof s === 'string') && STATES.has(i.state) && typeof i.createdAt === 'number';
}

export class OutboxStore {
  private list: ProcessingItem[] = [];
  private loaded = false;

  constructor(private readonly file: () => string) {}

  get items(): ProcessingItem[] {
    this.load();
    return this.list;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.file();
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${file}: ${errMsg(err)}`);
      return;
    }
    try {
      const parsed = (JSON.parse(raw) as { items?: unknown }).items;
      const items = Array.isArray(parsed) ? parsed : [];
      this.list = items.filter(isItem).map((it) => ({ ...it, generation: it.generation ?? 0, attempts: it.attempts ?? 0 }));
      const dropped = items.length - this.list.length;
      if (dropped) log.warn(`${file}: ignored ${dropped} malformed item(s)`);
      // an upload cut off by the restart resumes (already uploaded files are skipped)
      for (const it of this.list) if (it.state === 'uploading') it.state = 'waiting';
    } catch (err) {
      const aside = `${file}.bad-${Date.now()}`;
      log.warn(`${file} is not valid JSON (${errMsg(err)}): moved to ${aside}, starting with an empty outbox`);
      try {
        fs.renameSync(file, aside);
      } catch {
        /* the next save replaces it */
      }
    }
  }

  add(it: ProcessingItem): void {
    this.items.push(it);
    this.prune();
  }

  find(id: string): ProcessingItem | undefined {
    return this.items.find((i) => i.id === id || i.studioJobId === id);
  }

  private prune(): void {
    const finished = this.list.filter((i) => !isOpen(i)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(finished.slice(KEEP_FINISHED));
    this.list = this.list.filter((i) => !drop.has(i));
  }

  /** Write the outbox; a failure is logged (the items stay in memory and the next save retries). */
  save(): void {
    // never write before the file has been read: that would replace a saved outbox with an empty one
    this.load();
    const file = this.file();
    try {
      writeFileAtomic(file, JSON.stringify({ items: this.list }, null, 1));
    } catch (err) {
      log.warn(`could not save the processing outbox to ${file}: ${errMsg(err)}`);
    }
  }
}
