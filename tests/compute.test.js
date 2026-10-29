/** @file Проверки алгоритма и стратегий, которые выполняются без браузера. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWork, formatChecksum, MAX_ELEMENTS, processUntil } from '../src/compute.js';
import { runBlocking, runChunked, runMicrotasks } from '../src/runners.js';

/**
 * Независимый эталон на BigInt: маска явно ограничивает каждое число 32 битами.
 * Не вызывает рабочий алгоритм и не импортирует его константы, чтобы одинаковая
 * ошибка в общей реализации не сделала сравнение бессмысленным.
 * @param {number} total Небольшое число элементов для проверки корректности.
 * @returns {number} Ожидаемая беззнаковая 32-битная контрольная сумма.
 */
function reference(total) {
  const mask = 0xffffffffn;
  let checksum = 2166136261n;
  for (let index = 0; index < total; index++) {
    let value = (BigInt(index) ^ 2654435769n) & mask;
    for (let round = 0; round < 128; round++) {
      value = ((value ^ (value >> 16n)) * 2246822507n) & mask;
      value = ((value << 13n) | (value >> 19n)) & mask;
      value = (value + 1831565813n + BigInt(round)) & mask;
    }
    checksum = ((checksum ^ value) * 16777619n) & mask;
  }
  return Number(checksum);
}

test('Integer algorithm matches an independent BigInt reference', () => {
  for (const total of [1, 2, 17, 257]) {
    assert.equal(runBlocking(total).checksum, reference(total));
  }
});

test('Checksum is invariant under arbitrary partition boundaries', () => {
  const work = createWork(10_003);
  for (const end of [1, 19, 256, 8192, 10_003, 20_000]) processUntil(work, end);
  assert.equal(work.processed, work.total);
  assert.equal(work.checksum, runBlocking(work.total).checksum);
  assert.match(formatChecksum(work.checksum), /^0x[\dA-F]{8}$/);
});

test('All main-thread strategies return identical checksums and process the full volume', async () => {
  const total = 30_017;
  const baseline = runBlocking(total);
  const progress = [];
  const signal = new AbortController().signal;
  for (const result of [await runMicrotasks(total), await runChunked(total, { signal, onProgress: value => progress.push(value.processed) })]) {
    assert.equal(result.processed, total);
    assert.equal(result.checksum, baseline.checksum);
    assert.ok(result.computeMs > 0);
  }
  assert.equal(progress.at(-1), total);
  assert.ok(progress.every((value, index) => !index || value > progress[index - 1]));
});

test('Chunking can abort between slices without reporting a complete result', async () => {
  const controller = new AbortController();
  let processed = 0;
  await assert.rejects(runChunked(1_000_000, {
    signal: controller.signal,
    onProgress(result) {
      processed = result.processed;
      controller.abort();
    },
  }), { name: 'AbortError' });
  assert.ok(processed > 0 && processed < 1_000_000);
});

test('Invalid workload is rejected before expensive preparation', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, '10', MAX_ELEMENTS + 1]) {
    assert.throws(() => createWork(value), RangeError);
  }
});
