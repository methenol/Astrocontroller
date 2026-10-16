/** Talking to the agent, and editing its skills. */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { BODY_LIMIT_BYTES, badRequest, body, notFound, route } from '../http.js';
import type { WebContext } from '../context.js';
import { REASONING_EFFORTS } from '../../config.js';
import { writeFileAtomic } from '../../util/fs.js';

export type PromptMode = 'auto' | 'steer' | 'followUp';
export const promptMode = (m: unknown): PromptMode => (m === 'steer' || m === 'followUp' ? m : 'auto');

/** Images attached to a message: a few, each a base64 JPEG/PNG/WebP/GIF of a sane size. */
const MAX_PROMPT_IMAGES = 8;
const MAX_IMAGE_BASE64_CHARS = 16 * 1024 * 1024;
/**
 * All of a message's images together: what fits in a request body with room for the text, so a set
 * the schema accepts never meets the body limit first (eight images of the largest size would).
 * The web UI checks the same totals when an image is attached (public/js/chat.js).
 */
export const MAX_PROMPT_BASE64_CHARS = BODY_LIMIT_BYTES - 4 * 1024 * 1024;
const PromptImage = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS, 'image too large').regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image data must be base64'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
});
export const PromptBody = z.object({
  text: z.string().trim().min(1, 'text required'),
  images: z
    .array(PromptImage)
    .max(MAX_PROMPT_IMAGES, `at most ${MAX_PROMPT_IMAGES} images`)
    .refine((imgs) => imgs.reduce((n, i) => n + i.data.length, 0) <= MAX_PROMPT_BASE64_CHARS, `the images together are too large (at most ${Math.floor((MAX_PROMPT_BASE64_CHARS * 3) / 4 / 2 ** 20)} MB)`)
    .optional(),
  mode: z.unknown().optional(),
});

export function agentRoutes({ agent, duty }: WebContext): Router {
  const api = express.Router();

  api.post(
    '/agent/prompt',
    route(async (req) => {
      const b = body(req, PromptBody);
      duty.userSpoke();
      await agent.prompt(b.text, b.images ?? [], promptMode(b.mode));
      return { ok: true };
    }),
  );
  api.post(
    '/agent/queue/remove',
    route(async (req) => {
      const b = body(req, z.object({ message: z.string().default(''), queue: z.string().optional() }));
      return { removed: await agent.removeQueued(b.message, b.queue === 'followUp' ? 'followUp' : 'steering') };
    }),
  );
  api.post('/agent/compact', route(async () => agent.compact()));
  api.post(
    '/agent/abort',
    route(async () => {
      // Stop means stop: no automatic wake right after it
      duty.userStop();
      await agent.abort();
    }),
  );
  api.post('/agent/new', route(async () => agent.newSession()));
  api.post(
    '/agent/thinking',
    route(async (req) => {
      const b = body(req, z.object({ level: z.enum(REASONING_EFFORTS).default('medium') }));
      return agent.setThinking(b.level);
    }),
  );

  // ---- skills (agent/skills/<name>/SKILL.md)
  api.get('/skills', route(async () => listSkills(agent.skillsDir)));
  api.get(
    '/skills/:name',
    route(async (req) => {
      const file = skillFile(agent.skillsDir, String(req.params.name));
      return { name: req.params.name, content: fs.readFileSync(file, 'utf8') };
    }),
  );
  api.put(
    '/skills/:name',
    route(async (req) => {
      const { content } = body(req, z.object({ content: z.string() }));
      const file = skillFile(agent.skillsDir, String(req.params.name), true);
      writeFileAtomic(file, content);
      return { ok: true };
    }),
  );

  return api;
}

function skillFile(dir: string, name: string, create = false): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw badRequest('skill names are lowercase letters, digits and dashes');
  const file = path.join(dir, name, 'SKILL.md');
  if (!create && !fs.existsSync(file)) throw notFound('no such skill');
  return file;
}

function listSkills(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map((d) => {
      const file = path.join(dir, d.name, 'SKILL.md');
      const content = fs.readFileSync(file, 'utf8');
      const desc = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      return { name: d.name, description: desc.replace(/^["']|["']$/g, ''), updatedAt: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
