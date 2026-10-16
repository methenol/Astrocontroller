/**
 * A stand-in for `omp --mode rpc`: newline-delimited JSON frames on stdin/stdout, as the bridge
 * speaks them. FAKE_OMP_MODE picks the behaviour after a prompt:
 *   normal  — agent_start ... agent_end
 *   lost-end — agent_start, then never an end event; get_state says no turn is streaming
 *   hang    — agent_start, then nothing at all (no answers either) until killed
 * FAKE_OMP_ONCE (a file path): the mode applies only to the first process; later ones are normal.
 * FAKE_OMP_HISTORY=1: get_messages returns a short resumed session (a user message with an image,
 * an answer and a tool call with its result).
 */
import fs from 'node:fs';
import readline from 'node:readline';

let mode = process.env.FAKE_OMP_MODE ?? 'normal';
const once = process.env.FAKE_OMP_ONCE;
if (once) {
  if (fs.existsSync(once)) mode = 'normal';
  else fs.writeFileSync(once, String(process.pid));
}
let hung = false;
let streaming = false;
const out = (f: Record<string, unknown>) => process.stdout.write(JSON.stringify(f) + '\n');

out({ type: 'ready', supportedProtocolVersions: [] });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (hung) return;
  const req = JSON.parse(line);
  const ok = (data: unknown = {}) => out({ type: 'response', id: req.id, success: true, data });
  switch (req.type) {
    case 'get_state':
      return ok({ isStreaming: streaming, model: { provider: 'astro', id: 'fake' }, thinkingLevel: 'low' });
    case 'get_messages':
      return ok({
        messages: process.env.FAKE_OMP_HISTORY
          ? [
              { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 1 },
              { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'toolCall', id: 'call_1', name: 'mcp__dwarf3__telescope_status', arguments: {} }], timestamp: 2 },
              { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'saved captures/agent/x.jpg' }], timestamp: 3 },
            ]
          : [],
      });
    case 'prompt':
      ok();
      out({ type: 'agent_start' });
      if (mode === 'hang') {
        hung = true;
        return;
      }
      if (mode === 'lost-end') return; // streaming stays false: the turn is over, its end was lost
      streaming = true;
      setTimeout(() => {
        streaming = false;
        out({ type: 'agent_end' });
      }, 50);
      return;
    default:
      return ok();
  }
});
process.stdin.on('end', () => process.exit(0));
