/**
 * What every tool module shares: the context, the result shapes, error formatting, saving the
 * images the agent looked at (so the web UI shows them too), and the common argument schemas.
 *
 * registerTools runs once per MCP request (a fresh McpServer each time, see ../server.ts), so no
 * tool may keep state in its registration closure: state that must outlive one call lives at
 * module level, keyed by the device.
 */
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import type { Dwarf } from '../../drivers/dwarf/device.js';
import * as http from '../../drivers/dwarf/http.js';
import { DwarfCommandError } from '../../drivers/dwarf/link.js';
import type { StreamHub } from '../../media/streams.js';
import { autoStretch, toJpeg, type FloatImage } from '../../media/images.js';
import type { DutyLoop } from '../../agent/duty.js';
import { writeFileAtomic } from '../../util/fs.js';
import { SafeEmitter } from '../../util/events.js';
import { toJson } from '../../util/json.js';

const log = logger('mcp');

export interface ToolContext {
  dwarf: Dwarf;
  hub: StreamHub;
  duty?: DutyLoop;
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type Result = { content: Content[]; isError?: boolean };

/** Registers one tool; arguments are validated against `shape` before `fn` runs. */
export type ToolFn = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<Result>) => void;

/** `tool` without the named tools (a driver that has its own, or no equivalent). */
export function except(tool: ToolFn, names: Iterable<string>): ToolFn {
  const skip = new Set(names);
  return (name, description, shape, fn) => {
    if (!skip.has(name)) tool(name, description, shape, fn);
  };
}

/** 'call' {name, args, at}, 'done' {name, ok, ms, error?}, 'image' {path, label, at}, 'stellarium' {name?, raHours?, decDeg?, time?, fovDeg?, at} — for the web UI. */
export const toolEvents = new SafeEmitter();

export const text = (v: unknown): Result => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : toJson(v, 1) }] });

/** A decoded device response as text. */
function responseText(r: unknown): string {
  try {
    return toJson(r);
  } catch {
    return String(r);
  }
}

export function fail(err: unknown): Result {
  let msg = errMsg(err);
  if (err instanceof DwarfCommandError) msg = `${msg}\nresponse: ${responseText(err.response)}`;
  // a bare "aborted due to timeout" told the agent nothing (2026-10-03 night): say what timed out and what that usually means
  if (/aborted due to timeout|TimeoutError/i.test(msg)) msg = `${msg}\n${http.timeoutExplanation()}`;
  return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
}

export function makeTool(server: McpServer): ToolFn {
  return (name, description, shape, fn) => {
    const run = async (args: never): Promise<Result> => {
      const started = Date.now();
      toolEvents.emit('call', { name, args, at: started });
      try {
        const r = await fn(args);
        toolEvents.emit('done', { name, ok: !r.isError, ms: Date.now() - started });
        return r;
      } catch (err) {
        log.warn(`${name} failed: ${errMsg(err)}`);
        toolEvents.emit('done', { name, ok: false, ms: Date.now() - started, error: errMsg(err) });
        return fail(err);
      }
    };
    server.registerTool(name, { description, inputSchema: shape }, run as never);
  };
}

let captureSeq = 0;

/** Save an image the agent looked at, so the UI can show it too. Returns its path under captures/. */
export function saveCapture(jpeg: Buffer, label: string): string {
  const dir = path.join(config.paths.captures, 'agent');
  // the sequence keeps two captures with one label in the same millisecond apart
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${(++captureSeq % 1000).toString().padStart(3, '0')}_${label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60)}.jpg`;
  writeFileAtomic(path.join(dir, name), jpeg);
  const rel = `agent/${name}`;
  toolEvents.emit('image', { path: rel, label, at: Date.now() });
  return rel;
}

/** A text result, with the image in front of it when the model can see images. */
export function withImage(jpeg: Buffer | undefined, body: string): Result {
  const parts: Content[] = config.llm.vision && jpeg ? [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] : [];
  return { content: [...parts, { type: 'text', text: body }] };
}

/** JPEG of an image for display: linear data stretched. */
export function displayJpeg(img: FloatImage, maxSize: number, stretch?: boolean): Promise<Buffer> {
  return toJpeg((stretch ?? img.linear) ? autoStretch(img) : img, maxSize);
}

export async function imageResult(img: FloatImage, label: string, opts: { stretch?: boolean; maxSize?: number; note?: string }): Promise<Result> {
  const jpeg = await displayJpeg(img, opts.maxSize ?? 1280, opts.stretch);
  const saved = saveCapture(jpeg, label);
  const lines = [`${label}: ${img.width}×${img.height}${img.linear ? ' (linear data, auto-stretched for display)' : ''}`, capturedLine(img), `saved as captures/${saved}`].filter(Boolean);
  if (opts.note) lines.push(opts.note);
  if (!config.llm.vision) lines.push('(vision disabled: use analyze_image for numbers)');
  return withImage(jpeg, lines.join('\n'));
}

export function capturedLine(img: FloatImage): string {
  if (!img.capturedAt) return '';
  const age = (Date.now() - img.capturedAt) / 1000;
  return `captured ${new Date(img.capturedAt).toLocaleTimeString('en-US', { timeZone: config.observer.timezone, hour12: false })} (${age < 120 ? `${age.toFixed(1)} s` : `${Math.round(age / 60)} min`} ago)`;
}

export const localTime = (ms: number | Date = Date.now()) => new Date(ms).toLocaleString('en-US', { timeZone: config.observer.timezone });

export const cameraArg = z.enum(['tele', 'wide']).describe('tele = 150mm telephoto (2.95°×1.66° FOV), wide = 6.7mm wide-angle (45°×26°)');

export const cropArg = z
  .object({
    x: z.number().min(0).describe('left edge; 0..1 fraction of width, or pixels if > 1'),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .optional()
  .describe('optional region; fractions (0..1) or pixels');

/** Exposure text ("1/500", "0.5", "15s") in seconds; NaN if it is not one. */
export function exposureArgSeconds(v: string | number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  const s = v.trim();
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (frac) return Number(frac[2]) > 0 ? Number(frac[1]) / Number(frac[2]) : Number.NaN;
  const plain = /^(\d+(?:\.\d+)?|\.\d+)\s*s?$/i.exec(s);
  return plain ? Number(plain[1]) : Number.NaN;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
