import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDecoder } from './stream.js';

test('SSE decoder preserves split CRLF boundaries and complete snapshot JSON', () => {
  const events = [];
  const decoder = new EventDecoder((name, data) => events.push([name, JSON.parse(data)]));
  for (const chunk of [': keepalive\r', '\n\r\n', 'event: sess', 'ion\r\ndata: {"name":"Žygimantas",', '"votes":[]}\r', '\n\r', '\n']) decoder.push(chunk);
  assert.deepEqual(events, [['session', { name: 'Žygimantas', votes: [] }]]);
});

test('comments do not dispatch; multiline data and named errors are retained', () => {
  const events = [];
  const decoder = new EventDecoder((name, data) => events.push([name, data]));
  decoder.push(': keepalive\n\nevent: session\ndata: first\ndata: second\n\nevent: error\ndata: {"code":"FORBIDDEN"}\n\n');
  assert.deepEqual(events, [['session', 'first\nsecond'], ['error', '{"code":"FORBIDDEN"}']]);
});

test('unfinished events do not become a partially applied snapshot', () => {
  const events = [];
  const decoder = new EventDecoder((name, data) => events.push([name, data]));
  decoder.push('event: session\ndata: {"partial":');
  assert.equal(events.length, 0);
  assert.throws(() => decoder.push('x'.repeat(1_000_001)), /too large/);
});
