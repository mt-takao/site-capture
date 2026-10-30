import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedError } from '../src/capture/blocked.js';
import { HostGate, withRateLimitRetry } from '../src/capture/host-gate.js';

// 時計と待ち時間を偽物にして、実際には待たずに確かめる
function fakeClock() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

test('同じホストへのアクセスは間隔を空ける', async () => {
  const c = fakeClock();
  const gate = new HostGate(500, c.now, c.sleep);
  await gate.acquire('a.example');
  await gate.acquire('a.example');
  await gate.acquire('b.example'); // 別のホストは待たない
  assert.deepEqual(c.waits, [500]);
});

test('制限を受けたホストは待ち時間を入れ、以降の間隔を2倍にする', async () => {
  const c = fakeClock();
  const gate = new HostGate(500, c.now, c.sleep);
  await gate.acquire('a.example');
  gate.penalize('a.example', 60000);
  await gate.acquire('a.example');
  await gate.acquire('a.example');
  assert.deepEqual(c.waits, [60000, 1000]);
});

test('制限されたら 60秒 → 120秒 待って撮り直し、成功したら結果を返す', async () => {
  const c = fakeClock();
  const gate = new HostGate(0, c.now, c.sleep);
  let calls = 0;
  const waits: number[] = [];
  const result = await withRateLimitRetry(
    gate,
    'a.example',
    async () => {
      calls++;
      if (calls < 3) throw new BlockedError('partially-rate-limited', null);
      return 'ok';
    },
    ({ waitSec }) => waits.push(waitSec),
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [60, 120]);
});

test('Retry-After があればその秒数を待つ', async () => {
  const c = fakeClock();
  const gate = new HostGate(0, c.now, c.sleep);
  let calls = 0;
  const waits: number[] = [];
  await withRateLimitRetry(
    gate,
    'a.example',
    async () => {
      if (calls++ === 0) throw new BlockedError('rate-limited', 7);
      return 'ok';
    },
    ({ waitSec }) => waits.push(waitSec),
  );
  assert.deepEqual(waits, [7]);
});

test('3回撮り直してもだめなら諦める', async () => {
  const c = fakeClock();
  const gate = new HostGate(0, c.now, c.sleep);
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(gate, 'a.example', async () => {
      calls++;
      throw new BlockedError('rate-limited', null);
    }),
    BlockedError,
  );
  assert.equal(calls, 4);
});

test('403 と、制限以外のエラーは撮り直さない', async () => {
  const c = fakeClock();
  const gate = new HostGate(0, c.now, c.sleep);
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(gate, 'a.example', async () => {
      calls++;
      throw new BlockedError('forbidden', null);
    }),
  );
  await assert.rejects(
    withRateLimitRetry(gate, 'a.example', async () => {
      calls++;
      throw new Error('boom');
    }),
  );
  assert.equal(calls, 2);
});
