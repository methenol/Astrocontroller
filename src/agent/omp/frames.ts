/**
 * omp's RPC frames, as far as the bridge reads them. Frames come from another process, so every
 * field is optional and checked before use.
 */

export interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface OmpMessage {
  role?: string;
  content?: string | ContentPart[];
  synthetic?: boolean;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
}

export interface OmpState {
  isStreaming?: boolean;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  queuedMessages?: { steering?: string[]; followUp?: string[] };
  todoPhases?: unknown;
  tokensPerSecond?: number;
}

/** Every frame type the bridge reads, loosely: fields per type are read where they are handled. */
export interface Frame {
  type?: string;
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
  // rpc_chunk
  chunkId?: string;
  index?: number;
  count?: number;
  byteLength?: number;
  // ready
  supportedProtocolVersions?: number[];
  // queue_update
  steering?: string[];
  followUp?: string[];
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  intent?: string;
  isError?: boolean;
  partialResult?: { content?: ContentPart[] };
  result?: { content?: ContentPart[]; details?: { phases?: unknown } };
  // prompt_result
  status?: string;
  // agent_end
  yielded?: boolean;
  // message_*
  messageId?: string;
  message?: OmpMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
  // auto_retry_start
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  // notice
  level?: string;
}

const parts = (content: OmpMessage['content'] | ContentPart[] | undefined): ContentPart[] => (Array.isArray(content) ? content.filter((c): c is ContentPart => !!c && typeof c === 'object') : []);

/** The text of a message or tool result (a plain string counts as text). */
export function textOf(content: OmpMessage['content'] | ContentPart[] | undefined, sep = '\n'): string {
  if (typeof content === 'string') return content;
  return parts(content)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(sep);
}

export function thinkingOf(content: OmpMessage['content'] | undefined): string {
  return parts(content)
    .filter((c) => c.type === 'thinking' && typeof c.thinking === 'string')
    .map((c) => c.thinking)
    .join('\n');
}

export function imageCount(content: OmpMessage['content'] | undefined): number {
  return parts(content).filter((c) => c.type === 'image').length;
}

export function toolCalls(content: OmpMessage['content'] | undefined): Array<{ id: string; name: string; arguments: unknown }> {
  return parts(content)
    .filter((c) => c.type === 'toolCall' && typeof c.id === 'string')
    .map((c) => ({ id: c.id!, name: String(c.name ?? ''), arguments: c.arguments }));
}

/** Images the vision tools saved, named in a tool's text output. */
export function capturedImages(text: string): string[] {
  return [...text.matchAll(/captures\/(agent\/[^\s]+\.jpg)/g)].map((m) => m[1]);
}

/** A tool name as shown: the MCP server prefix dropped. */
export function prettyTool(name: unknown): string {
  return String(name ?? '').replace(/^mcp__(dwarf3|seestar)_+/, '');
}

/** An error field from omp: a string, or an object with a message. */
export function errorText(e: unknown, fallback: string): string {
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : fallback;
}

/** omp's ceiling for one reassembled frame (MAX_RPC_REASSEMBLED_BYTES), and its piece size. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PIECE_BYTES = 256 * 1024;
const MAX_PARTS = Math.ceil(MAX_FRAME_BYTES / PIECE_BYTES);

/**
 * Large frames arrive as rpc_chunk pieces, each the base64 of its own slice of the frame's UTF-8
 * bytes (omp rpc-frame.ts). Pieces of one frame share a chunkId; a new id drops an unfinished frame.
 * Returns the whole frame's JSON once every piece is in and the size matches what omp announced.
 */
export class ChunkAssembler {
  private cur: { id: string; parts: Array<string | undefined>; count: number; have: number; byteLength?: number } | null = null;

  push(f: Frame): string | null {
    const { chunkId, index, count, data, byteLength } = f;
    if (typeof chunkId !== 'string' || typeof data !== 'string' || !Number.isInteger(count) || !Number.isInteger(index)) return null;
    if (count! < 1 || count! > MAX_PARTS || index! < 0 || index! >= count!) return null;
    if (byteLength !== undefined && (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > MAX_FRAME_BYTES)) return null;
    if (!this.cur || this.cur.id !== chunkId || this.cur.count !== count) this.cur = { id: chunkId, parts: new Array(count), count: count!, have: 0, byteLength };
    if (this.cur.parts[index!] === undefined) this.cur.have++;
    this.cur.parts[index!] = data;
    if (this.cur.have < this.cur.count) return null;
    const bytes = Buffer.concat(this.cur.parts.map((p) => Buffer.from(p!, 'base64')));
    const want = this.cur.byteLength;
    this.cur = null;
    // a piece lost or mangled in transit: drop the frame rather than parse a corrupt one
    if (want !== undefined && bytes.length !== want) return null;
    return bytes.toString('utf8');
  }

  reset(): void {
    this.cur = null;
  }
}
