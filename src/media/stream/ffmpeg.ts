/**
 * ffmpeg options that changed name between versions: `-fps_mode` arrived in 5.1, and older builds
 * (Ubuntu 22.04 ships 4.4) refuse it ("Option not found"), so they get the old `-vsync` spelling.
 */
import { spawnSync } from 'node:child_process';

let fpsModeFlag: string | null = null;

/** Every decoded frame passed through unchanged, in the spelling this ffmpeg understands. */
export function passthroughFrames(): string[] {
  if (!fpsModeFlag) {
    const help = spawnSync('ffmpeg', ['-hide_banner', '-h', 'full'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    fpsModeFlag = typeof help.stdout === 'string' && help.stdout.includes('-fps_mode') ? '-fps_mode' : '-vsync';
  }
  return [fpsModeFlag, 'passthrough'];
}
