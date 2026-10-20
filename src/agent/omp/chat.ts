/** The chat as the web UI shows it: user, assistant, tool and notice entries, bounded, indexed by id. */

export type ChatEntry =
  | { kind: 'user'; id: string; text: string; images?: number; at: number }
  | { kind: 'assistant'; id: string; text: string; thinking: string; at: number; streaming?: boolean; thinkingMs?: number }
  | { kind: 'tool'; id: string; name: string; args: unknown; intent?: string; status: 'running' | 'ok' | 'error'; result?: string; images?: string[]; at: number; ms?: number }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; at: number };

export type AssistantEntry = Extract<ChatEntry, { kind: 'assistant' }>;
export type ToolEntry = Extract<ChatEntry, { kind: 'tool' }>;

/** Entries kept for the UI. */
export const HISTORY_LIMIT = 400;
/** Tool output kept per entry. */
export const TOOL_RESULT_CHARS = 6000;

export class ChatLog {
  private list: ChatEntry[] = [];
  private readonly byId = new Map<string, ChatEntry>();

  get entries(): ChatEntry[] {
    return this.list;
  }

  /** Replace everything (a resumed or new session). */
  reset(entries: ChatEntry[] = []): void {
    this.list = entries.slice(-HISTORY_LIMIT);
    this.byId.clear();
    for (const e of this.list) this.byId.set(`${e.kind}:${e.id}`, e);
  }

  push(e: ChatEntry): void {
    this.list.push(e);
    this.byId.set(`${e.kind}:${e.id}`, e);
    while (this.list.length > HISTORY_LIMIT) {
      const old = this.list.shift()!;
      const key = `${old.kind}:${old.id}`;
      if (this.byId.get(key) === old) this.byId.delete(key);
    }
  }

  remove(e: ChatEntry): void {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    const key = `${e.kind}:${e.id}`;
    if (this.byId.get(key) === e) this.byId.delete(key);
  }

  assistant(id: string): AssistantEntry | undefined {
    return this.byId.get(`assistant:${id}`) as AssistantEntry | undefined;
  }

  tool(id: string): ToolEntry | undefined {
    return this.byId.get(`tool:${id}`) as ToolEntry | undefined;
  }

  /** Entries left mid-way when the agent process ended: streaming text stops, running tools fail. */
  settleUnfinished(reason: string): ChatEntry[] {
    const touched: ChatEntry[] = [];
    for (const e of this.list) {
      if (e.kind === 'assistant' && e.streaming) {
        e.streaming = false;
        touched.push(e);
      } else if (e.kind === 'tool' && e.status === 'running') {
        e.status = 'error';
        e.result = e.result ? `${e.result}\n(${reason})` : `(${reason})`;
        e.ms = Date.now() - e.at;
        touched.push(e);
      }
    }
    return touched;
  }
}
