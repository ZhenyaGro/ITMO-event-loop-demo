/** @file Проверки простой задачи: точный счёт, остаток порции и передачa управления. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runBlocking } from '../src/demo/examples/01-blocking.js';
import { runChunking } from '../src/demo/examples/02-chunking.js';
import { runProgress } from '../src/demo/examples/03-progress.js';

for (const LIMIT of [1, 5, 17]) {
  test(`все три примера возвращают N = ${LIMIT}, включая неполную последнюю порцию`, async () => {
    for (const run of [runBlocking, runChunking, runProgress]) {
      const values = [];
      const result = await new Promise((resolve) => run({
        LIMIT, CHUNK_SIZE: 5, showResult: resolve,
        updateProgress: (processed, total) => { assert.equal(total, LIMIT); values.push(processed); },
      }));
      assert.equal(result, LIMIT);
      if (run === runProgress) {
        assert.deepEqual(values, Array.from({ length: Math.ceil(LIMIT / 5) }, (_, index) => Math.min((index + 1) * 5, LIMIT)));
      } else {
        assert.deepEqual(values, [], 'первые два этапа не сообщают промежуточный прогресс');
      }
    }
  });
}

test('синхронный пример завершает счёт до возврата, оба порционных дают выполнить другую задачу', async () => {
  let syncResult;
  runBlocking({ LIMIT: 17, showResult: (value) => { syncResult = value; } });
  assert.equal(syncResult, 17);
  for (const run of [runChunking, runProgress]) {
    const events = [];
    setTimeout(() => events.push('другая задача'), 0);
    await new Promise((resolve) => {
      run({ LIMIT: 17, CHUNK_SIZE: 5, updateProgress() {}, showResult: () => { events.push('результат'); resolve(); } });
      assert.deepEqual(events, []);
    });
    assert.deepEqual(events, ['другая задача', 'результат']);
  }
});

test('третий учебный фрагмент отличается от второго только вызовом updateProgress', () => {
  const fragment = (name) => readFileSync(new URL(`../src/demo/examples/${name}.js`, import.meta.url), 'utf8')
    .split('// demo:start\n')[1].split('  // demo:end')[0];
  assert.equal(fragment('03-progress').replace('    updateProgress(i, LIMIT);\n', ''), fragment('02-chunking'));
});
