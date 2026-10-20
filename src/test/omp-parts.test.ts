import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { ChunkAssembler, textOf, thinkingOf, toolCalls, capturedImages, prettyTool, errorText } from '../agent/omp/frames.js';
import { ChatLog, HISTORY_LIMIT } from '../agent/omp/chat.js';
import { configYml, modelsYml, seedWorkspace, systemPromptPath, appendPromptPath } from '../agent/omp/setup.js';

describe('omp frames', () => {
  const pieces = (json: string, n: number, id = 'c1') => {
    // each piece is its own base64 of a slice of the frame's bytes
    const bytes = Buffer.from(json);
    const size = Math.ceil(bytes.length / n);
    return Array.from({ length: n }, (_, i) => ({ type: 'rpc_chunk', chunkId: id, index: i, count: n, data: bytes.subarray(i * size, (i + 1) * size).toString('base64') }));
  };

  test('chunks reassemble in any order; a repeated piece is not counted twice', () => {
    const a = new ChunkAssembler();
    const [p0, p1, p2] = pieces('{"type":"agent_end"}', 3);
    assert.equal(a.push(p2), null);
    assert.equal(a.push(p2), null);
    assert.equal(a.push(p0), null);
    assert.equal(a.push(p1), '{"type":"agent_end"}');
  });

  test('a new chunk id drops the unfinished frame; malformed pieces are ignored', () => {
    const a = new ChunkAssembler();
    const old = pieces('{"a":1}', 2, 'old');
    const fresh = pieces('{"b":2}', 2, 'new');
    a.push(old[0]);
    a.push(fresh[0]);
    assert.equal(a.push(old[1]), null, 'the old frame was dropped');
    assert.equal(a.push({ type: 'rpc_chunk', chunkId: 'x', index: 5, count: 2, data: '' }), null);
    assert.equal(a.push({ type: 'rpc_chunk', chunkId: 'x', index: 0, count: 0, data: '' }), null);
  });

  test('a frame whose size differs from the announced byteLength is dropped', () => {
    const json = '{"type":"agent_end"}';
    const good = pieces(json, 2, 'g').map((p) => ({ ...p, byteLength: Buffer.byteLength(json) }));
    const a = new ChunkAssembler();
    a.push(good[0]);
    assert.equal(a.push(good[1]), json);
    const bad = pieces(json, 2, 'b').map((p) => ({ ...p, byteLength: Buffer.byteLength(json) + 1 }));
    a.push(bad[0]);
    assert.equal(a.push(bad[1]), null);
    assert.equal(a.push({ type: 'rpc_chunk', chunkId: 'h', index: 0, count: 1, data: '', byteLength: -1 }), null);
  });

  test('content helpers read only well-formed parts', () => {
    const content = [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 't' }, null, { type: 'text' }, { type: 'toolCall', id: 'k', name: 'mcp__dwarf3__goto', arguments: { x: 1 } }, { type: 'text', text: 'b' }];
    assert.equal(textOf(content as never), 'a\nb');
    assert.equal(textOf(content as never, ''), 'ab');
    assert.equal(textOf('plain'), 'plain');
    assert.equal(thinkingOf(content as never), 't');
    assert.deepEqual(toolCalls(content as never), [{ id: 'k', name: 'mcp__dwarf3__goto', arguments: { x: 1 } }]);
    assert.equal(prettyTool('mcp__dwarf3__goto'), 'goto');
    assert.deepEqual(capturedImages('saved captures/agent/x_1.jpg and captures/agent/y.jpg'), ['agent/x_1.jpg', 'agent/y.jpg']);
    assert.equal(errorText({ message: 'boom' }, 'f'), 'boom');
    assert.equal(errorText(undefined, 'f'), 'f');
  });
});

describe('chat log', () => {
  test('bounded, indexed by kind and id, and the index follows evictions', () => {
    const c = new ChatLog();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) c.push({ kind: 'notice', id: `n${i}`, level: 'info', text: '', at: i });
    assert.equal(c.entries.length, HISTORY_LIMIT);
    c.push({ kind: 'tool', id: 't1', name: 'x', args: {}, status: 'running', at: Date.now() });
    c.push({ kind: 'assistant', id: 't1', text: '', thinking: '', at: 0, streaming: true });
    assert.equal(c.tool('t1')?.kind, 'tool');
    assert.equal(c.assistant('t1')?.kind, 'assistant');
    const settled = c.settleUnfinished('the agent process ended');
    assert.equal(settled.length, 2);
    assert.equal(c.tool('t1')?.status, 'error');
    assert.match(c.tool('t1')?.result ?? '', /process ended/);
    assert.equal(c.assistant('t1')?.streaming, false);
    c.remove(c.assistant('t1')!);
    assert.equal(c.assistant('t1'), undefined);
  });
});

describe('agent setup', () => {
  const saved = { ...config.paths };
  let dir = '';
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-'));
    const tmpl = path.join(dir, 'tmpl');
    fs.mkdirSync(path.join(tmpl, 'skills', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmpl, 'skills', 'a', 'SKILL.md'), 'shipped skill');
    fs.writeFileSync(path.join(tmpl, 'SYSTEM.md'), 'v1');
    fs.writeFileSync(path.join(tmpl, 'NOTES.md'), 'notes');
    fs.writeFileSync(path.join(tmpl, 'APPEND.md'), 'rules');
    Object.assign(config.paths, { workspace: path.join(dir, 'ws'), agentTemplate: tmpl });
  });
  after(() => {
    Object.assign(config.paths, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('SYSTEM.md follows the shipped version until the user edits it; skills and notes stay the agent\'s', () => {
    seedWorkspace();
    assert.equal(fs.readFileSync(systemPromptPath(), 'utf8'), 'v1');
    assert.equal(fs.readFileSync(appendPromptPath(), 'utf8'), 'rules');
    const skill = path.join(config.paths.workspace, '.omp', 'skills', 'a', 'SKILL.md');
    fs.writeFileSync(skill, 'edited by the agent');
    fs.writeFileSync(path.join(config.paths.agentTemplate, 'SYSTEM.md'), 'v2');
    seedWorkspace();
    assert.equal(fs.readFileSync(systemPromptPath(), 'utf8'), 'v2', 'an untouched SYSTEM.md is updated');
    assert.equal(fs.readFileSync(skill, 'utf8'), 'edited by the agent');
    fs.writeFileSync(systemPromptPath(), 'customised');
    fs.writeFileSync(path.join(config.paths.agentTemplate, 'SYSTEM.md'), 'v3');
    seedWorkspace();
    assert.equal(fs.readFileSync(systemPromptPath(), 'utf8'), 'customised', 'a customised SYSTEM.md is kept');
  });

  test('generated YAML quotes values and denies idling commands', () => {
    assert.match(modelsYml(), /baseUrl: ".*"/);
    assert.match(configYml(), /\{ match: "sleep\*", approval: deny \}/);
  });
});
