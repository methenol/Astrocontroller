/** Copying sessions and files into the library, background jobs, and AstroPhoto Studio processing. */
import { roiForTarget } from '../../processing/roi.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import * as library from '../../library/transfer.js';
import * as processing from '../../processing/queue.js';
import * as studio from '../../processing/studio.js';
import { except, localTime, text, type ToolFn } from './common.js';

/** The tools that read the telescope's SD card (the Dwarf's album and sessions). */
const DEVICE_TOOLS = ['list_device_sessions', 'transfer_session', 'transfer_files'];

/**
 * device: the telescope has an SD card to transfer from (the Dwarf); otherwise only the library and processing.
 * transferHold: why transfers must wait now (Starfront's roof open), or null.
 */
export function registerLibraryTools(all: ToolFn, o: { device: boolean; transferHold?: () => string | null } = { device: true }): void {
  const tool = o.device ? all : except(all, DEVICE_TOOLS);
  // the owner can always transfer (the web UI is never held; in chat, owner_requested=true)
  const holdCheck = (ownerRequested?: boolean) => {
    const why = ownerRequested ? null : o.transferHold?.();
    if (why) throw new Error(`${why} Only if the owner asked for this transfer themselves, call again with owner_requested=true.`);
  };
  const ownerRequested = z.boolean().optional().describe('the owner asked for this transfer themselves (in chat): it goes ahead even while an autonomous Starfront night holds transfers. Never set it on your own initiative.');
  tool(
    'list_device_sessions',
    'List deep-sky imaging sessions stored on the telescope (folder, target, camera, exposure, gain, start time, FITS count, size) and whether each is already in the local library.',
    { counts: z.boolean().optional().describe('include FITS counts/sizes (slower), default true') },
    async ({ counts }) => text(await library.listDeviceSessions(counts !== false)),
  );

  tool(
    'transfer_session',
    `Copy an imaging session from the telescope to the imagery library (${config.paths.library}) in the background: stacked results, metadata, raw FITS subframes and the matching calibration masters (CALI_FRAME). session: folder name from list_device_sessions, or "latest". Returns a job id; check with jobs. ${
      config.studio.url
        ? `When it finishes, processing in AstroPhoto Studio is queued automatically${config.studio.autoProcess ? '' : ' only if process=true'} (profile ${config.studio.profile}); follow it with processing_status.`
        : 'Processing is off (ASTROPHOTO_URL not set).'
    }`,
    {
      session: z.string(),
      include_subframes: z.boolean().optional(),
      include_calibration: z.boolean().optional(),
      process: z.boolean().optional().describe(`queue processing after the transfer (default ${config.studio.autoProcess && !!config.studio.url})`),
      profile: z.string().optional().describe('processing profile for this session (names from processing_status); default from .env'),
      pool: z.boolean().optional().describe(`process this session pooled with every earlier library session of the same target, as one multi-night image (default ${config.studio.poolSessions})`),
      owner_requested: ownerRequested,
    },
    async ({ session, include_subframes, include_calibration, process, profile, pool, owner_requested }) => {
      holdCheck(owner_requested);
      const job = await library.transferSession(session, { includeSubframes: include_subframes !== false, includeCalibration: include_calibration !== false, process, profile, pool, origin: 'agent' });
      return text({ ...job, note: 'Runs in the background; Astrocontroller tells you with an event when it ends (done, partial or failed), and again when its processing finishes. No need to poll.' });
    },
  );

  tool(
    'transfer_files',
    'Copy specific album files (photos, videos, stacked images) from the telescope into the library. Runs in the background; you get an event when it ends.',
    { paths: z.array(z.string()).min(1), owner_requested: ownerRequested },
    async ({ paths, owner_requested }) => {
      holdCheck(owner_requested);
      return text(library.transferFiles(paths, 'agent'));
    },
  );

  tool(
    'jobs',
    'List background jobs (transfers), get one, or cancel one. Transfer status: done; partial = finished but some files could not be copied after 3 attempts each (error lists them; run the same transfer again: copied files are skipped); failed = could not run at all (e.g. telescope unreachable).',
    { action: z.enum(['list', 'get', 'cancel']).optional(), id: z.string().optional() },
    async ({ action, id }) => {
      if ((action === 'get' || action === 'cancel') && !id) throw new Error(`id is required for ${action}`);
      if (action === 'cancel') {
        if (!library.getJob(id!)) return text('no such job');
        return text(library.cancelJob(id!) ? 'cancelled' : `not cancelled: the job already ended (${library.getJob(id!)!.status})`);
      }
      if (action === 'get') return text(library.getJob(id!) ?? 'no such job');
      return text(library.listJobs());
    },
  );

  tool('list_library', 'What is already in the imagery library: sessions (DWARF_RAW_… folders) by target, with their number of subs (lights) and rejected subs.', {}, async () =>
    text({ root: config.paths.library, targets: library.listLibrary() }),
  );

  tool(
    'processing_status',
    'AstroPhoto Studio processing: whether the server is reachable, its GPU, the processing profiles it offers and the one configured, the local outbox (sessions waiting to be sent, uploading, processing on the server, done, failed) and the server queue with ETAs. Items wait in the outbox while the server is out of reach (field sessions) and go out by themselves later.',
    { server_queue: z.boolean().optional().describe('include the server queue and server info (default true)') },
    async ({ server_queue }) => {
      const out: Record<string, unknown> = { server: processing.reachability(), configuredProfile: config.studio.profile, dataAccess: config.studio.dataAccess, autoProcess: config.studio.autoProcess };
      if (config.studio.url && server_queue !== false) {
        try {
          const i = await studio.info();
          out.serverInfo = {
            version: i.version,
            device: i.devices?.default,
            gpus: i.devices?.gpus?.map((g) => g.name),
            profiles: Object.fromEntries(Object.entries(i.profiles ?? {}).map(([k, v]) => [k, v.label])),
            defaultProfile: i.default_profile,
          };
          if (!Object.hasOwn(i.profiles ?? {}, config.studio.profile)) out.warning = `ASTROPHOTO_PROFILE=${config.studio.profile} is not a profile this server offers`;
          const q = await studio.queue();
          out.serverQueue = {
            drainsInMin: q.drains_in != null ? Math.round(q.drains_in / 60) : null,
            jobs: [...q.running, ...q.queued].map((j) => ({
              id: j.id,
              label: j.label ?? j.dataset,
              state: j.state,
              profile: j.profile,
              progress: Number.isFinite(j.progress) ? `${Math.round(j.progress * 100)}%` : null,
              stage: j.message,
              position: j.position,
              etaMin: j.total_eta != null ? Math.round(j.total_eta / 60) : undefined,
            })),
          };
        } catch (e) {
          out.serverError = errMsg(e);
        }
      }
      out.outbox = processing.listItems(20).map((i) => ({
        id: i.id,
        target: i.target,
        sessions: i.sessions,
        profile: i.profile,
        state: i.state,
        access: i.access,
        studioJob: i.studioJobId,
        message: i.message,
        upload: i.upload,
        outputs: i.outputs,
        created: localTime(i.createdAt),
      }));
      return text(out);
    },
  );

  tool(
    'process_session',
    "Queue processing in AstroPhoto Studio (normally automatic after transfer_session). ONE job = ONE image: every session given is pooled into one stack, so several nights of the same object (sessions from different days) become one deep image. Give target (every library session of that target, e.g. all nights of NGC 7000) and/or sessions (DWARF_RAW_… folder names from list_library, to pick specific nights). The server keeps the dominant filter/exposure group across the pool, so do not mix filters (e.g. Duo-Band and Astro nights) unless intended. profile: one of the server's profiles (processing_status), default from .env.",
    {
      sessions: z.array(z.string()).optional(),
      target: z.string().optional().describe('add every library session of this target (as named in list_library)'),
      camera: z.enum(['tele', 'wide']).optional().describe('with target: only this camera (default tele)'),
      label: z.string().optional().describe('name of the pooled image (default: the target)'),
      profile: z.string().optional(),
      kind: z.string().optional().describe('job kind (default "all" = analyse, stack, restore, star remover, export)'),
      roi_crop_percent: z.number().min(0).lt(100).optional().describe("Studio crops the finished image to this percentage of the frame's width and height, around its centre (0 = no crop). Default: worked out from the target's catalog size, when cropping is on for it (roi_crop in plan_program, roiCropEnabled in the plan settings)"),
    },
    async ({ sessions, target, camera, label, profile, kind, roi_crop_percent }) => {
      const names = (sessions ?? []).map((s) => s.replace(/\/+$/, '').split('/').pop()!).filter(Boolean);
      if (target) names.push(...library.librarySessionsFor(target, camera ?? 'tele'));
      const unique = [...new Set(names)];
      if (!unique.length) throw new Error(target ? `no library sessions of "${target}" (list_library)` : 'give sessions and/or target');
      const targets = [...new Set(unique.map((n) => library.parseSessionFolder(n)?.target ?? n))];
      const roiCropPercent = roi_crop_percent ?? roiForTarget(target ?? targets[0]);
      const it = processing.enqueueProcessing({ sessions: unique, target: label ?? target ?? targets[0], profile, kind, origin: 'agent', roiCropPercent });
      return text({ ...it, note: `${unique.length} session(s) pooled into one image${targets.length > 1 ? ` (folder targets: ${targets.join(', ')})` : ''}` });
    },
  );

  tool(
    'processing_job',
    'Act on one processing item (id from processing_status: the local proc_… id or the server job id). get = details; cancel = stop it (also on the server); retry = send a failed/cancelled item again; move = change its place in the server queue (position 1 = next).',
    { action: z.enum(['get', 'cancel', 'retry', 'move']), id: z.string(), position: z.number().int().min(1).optional() },
    async ({ action, id, position }) => {
      if (action === 'cancel') return text(await processing.cancelItem(id));
      if (action === 'retry') return text(processing.retryItem(id));
      const it = processing.getItem(id);
      if (action === 'move') {
        // a local item that was not submitted has no place in the server queue
        if (it && !it.studioJobId) throw new Error(`item ${id} is ${it.state} and not on the server yet: nothing to move`);
        return text(await studio.move(it?.studioJobId ?? id, position ?? 1));
      }
      if (!it) throw new Error(`no processing item ${id}`);
      const server = it.studioJobId ? await studio.job(it.studioJobId).catch((e) => ({ error: errMsg(e) })) : undefined;
      return text({ ...it, server });
    },
  );
}
