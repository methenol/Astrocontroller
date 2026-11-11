/**
 * The agent's research packages (workspace/research/<designation>.md, written by the
 * target-research skill): list them, search them by target name or designation, read one.
 * Their images are captures/agent/… paths, which the server already serves under /captures.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { config } from '../../config.js';
import { findObject } from '../../astro/catalog.js';
import { badRequest, notFound, queryString, route } from '../http.js';

export const researchDir = (): string => path.join(config.paths.workspace, 'research');

/** What the list shows of one package. */
export interface ResearchEntry {
  name: string; // the file stem: "M-33"
  title: string; // the first heading: "M 33 — The Triangulum Galaxy (NGC 598)"
  hook: string; // the first plain paragraph under it
  aliases: string[]; // the "Other names" row and the designation in the file name
  date?: string; // "compiled 2026-11-09", when the package says
  image?: string; // the first image, captures/agent/…
  updatedAt: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .+_()'-]{0,127}$/;

/** "M 33", "M-33", "m33" all compare equal. */
export const compact = (s: string): string => s.toLowerCase().replace(/[\s\-_*`'"()]/g, '');

function parse(name: string, content: string, updatedAt: number): ResearchEntry {
  const lines = content.split(/\r?\n/);
  const title = (lines.find((l) => /^#\s+/.test(l)) ?? `# ${name}`).replace(/^#\s+/, '').trim();
  const titleAt = lines.findIndex((l) => /^#\s+/.test(l));
  const hook = lines.slice(titleAt + 1).find((l) => l.trim() && !/^(#|_|\||!\[|>|-{3})/.test(l.trim()))?.trim() ?? '';
  const other = lines.find((l) => /^\|\s*Other names\s*\|/i.test(l))?.replace(/^\|\s*Other names\s*\|/i, '').replace(/\|\s*$/, '') ?? '';
  const aliases = [
    ...new Set(
      [name.replace(/-/g, ' '), ...(title.match(/\(([^)]+)\)\s*$/)?.[1]?.split(/[,;/]/) ?? []), ...other.replace(/\*\*/g, '').replace(/\([^)]*\)/g, '').split(/[,·;/]|\s—\s/)]
        .map((a) => a.replace(/\(.*?\)/g, '').trim())
        .filter((a) => a && a.length <= 60),
    ),
  ];
  const date = content.match(/(?:compiled|updated|refreshed)\s+(\d{4}-\d{2}-\d{2})/i)?.[1] ?? content.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  const image = content.match(/!\[[^\]]*\]\(([^)\s]+)/)?.[1];
  return { name, title, hook: hook.replace(/[*_`]/g, '').slice(0, 220), aliases, date, image, updatedAt };
}

export function listResearch(dir = researchDir()): ResearchEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => {
      const file = path.join(dir, d.name);
      return parse(d.name.slice(0, -3), fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The packages that match `q`: a substring of the file name, the title or an alias (spaces and
 * dashes ignored), or any designation the local catalog knows the target by ("Triangulum" finds
 * M-33.md, "NGC 598" too).
 */
export function searchResearch(q: string, entries: ResearchEntry[]): ResearchEntry[] {
  const needle = compact(q);
  if (!needle) return entries;
  const o = findObject(q.trim());
  const known = new Set(o ? [o.id, ...o.aliases, ...(o.names ?? [])].map(compact) : []);
  return entries.filter((e) => {
    const keys = [e.name, e.title, ...e.aliases].map(compact);
    return keys.some((k) => k.includes(needle)) || e.aliases.some((a) => known.has(compact(a)));
  });
}

function researchFile(name: string, dir = researchDir()): string {
  if (!NAME_RE.test(name)) throw badRequest('not a research package name');
  const file = path.resolve(dir, `${name}.md`);
  if (path.dirname(file) !== path.resolve(dir)) throw badRequest('not a research package name');
  if (!fs.existsSync(file)) throw notFound('no such research package');
  return file;
}

export function researchRoutes(): Router {
  const api = express.Router();
  api.get(
    '/research',
    route(async (req) => searchResearch(queryString(req, 'q') ?? '', listResearch())),
  );
  api.get(
    '/research/:name',
    route(async (req) => {
      const name = String(req.params.name);
      const file = researchFile(name);
      const content = fs.readFileSync(file, 'utf8');
      return { ...parse(name, content, fs.statSync(file).mtimeMs), content };
    }),
  );
  return api;
}
