/**
 * @file Проверяет production-сборку через пользовательский интерфейс Chromium.
 * Замеры берутся из выполненных опытов; вычисления и ответы Worker не подменяются.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Observes lifecycle/messages without replacing the Worker implementation.
  await page.addInitScript(() => {
    window.__workerAudit = { created: 0, terminated: 0, progress: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.__workerAudit.created++;
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'progress') window.__workerAudit.progress++;
        });
      }
      terminate() {
        window.__workerAudit.terminated++;
        return super.terminate();
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('#frame-count')).not.toHaveText('0');
});

/**
 * Устанавливает режим и нагрузку через элементы управления страницы.
 * @param {import('@playwright/test').Page} page Страница тестового браузера.
 * @param {import('../../src/modes.js').ModeId} mode Идентификатор режима.
 * @param {string} [total='8000000'] Строковое значение option в списке нагрузки.
 * @returns {Promise<void>} Завершается после применения обеих настроек.
 */
async function select(page, mode, total = '8000000') {
  await page.locator(`.mode-button[data-mode="${mode}"]`).click();
  await page.locator('#load').selectOption(total);
}

/**
 * Дожидается ненулевого прогресса и проверяет, что расчёт ещё продолжается.
 * Используется перед кликом или отменой, чтобы проверить действие во время работы.
 * @param {import('@playwright/test').Page} page Страница с запущенным опытом.
 * @returns {Promise<void>} Отклоняется, если ожидание или проверка не прошли.
 */
async function waitForProgress(page) {
  await expect.poll(async () => Number(await page.locator('#progress').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
}

test('all four production modes: exact checksums, stalls, live clicks, Worker messages, no console errors', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const measurements = [];
  let clicks = 0;
  for (const mode of ['blocking', 'microtasks', 'chunking', 'worker']) {
    await select(page, mode);
    await page.locator('#start').click();
    if (mode === 'chunking' || mode === 'worker') {
      await waitForProgress(page);
      await expect(page.locator('#start')).toBeDisabled();
      await expect(page.locator('#reset')).toBeDisabled();
      await expect(page.locator('#load')).toBeDisabled();
      await expect(page.locator('.mode-button').first()).toBeDisabled();
      await page.locator('#probe').click();
      await expect(page.locator('#click-count')).toHaveText(String(++clicks));
      await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
      expect(Number(await page.locator('#progress').getAttribute('aria-valuenow'))).toBeLessThan(100);
    }
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
    const row = page.locator('#results-body tr').last();
    const measured = await row.evaluate(element => ({ ...element.dataset }));
    measurements.push(measured);
    expect(Number(measured.totalMs)).toBeGreaterThan(0);
    expect(Number(measured.computeMs)).toBeGreaterThan(0);
    expect(Number(measured.computeMs)).toBeLessThanOrEqual(Number(measured.totalMs) + 1);
    expect(measured.checksum).toBe(measurements[0].checksum);
    if (mode === 'blocking' || mode === 'microtasks') {
      // The post-computation rAF must reveal (almost) the whole blocking time.
      expect(Number(measured.maxGap)).toBeGreaterThan(Number(measured.totalMs) * 0.8);
      expect(Number(measured.maxGap)).toBeGreaterThan(200);
    } else {
      expect(Number(measured.frames)).toBeGreaterThan(5);
      expect(Number(measured.maxGap)).toBeLessThan(Number(measurements[0].maxGap) / 3);
    }
  }
  const worker = await page.evaluate(() => window.__workerAudit);
  expect(worker.created).toBe(1);
  expect(worker.terminated).toBe(1);
  expect(worker.progress).toBeGreaterThan(0);
  expect(worker.progress).toBeLessThan(Number(measurements[3].totalMs) / 70 + 1);
  expect(errors).toEqual([]);
  await expect(page.locator('#result-count')).toHaveText('4');
  await expect(page.locator('#checksum-state')).toHaveText('✓ Совпадает');
  await page.screenshot({ path: testInfo.outputPath('comparison-desktop.png'), fullPage: true });
  await testInfo.attach('measurements.json', { body: JSON.stringify({ measurements, worker, consoleErrors: errors }, null, 2), contentType: 'application/json' });
  console.log('REAL_MEASUREMENTS', JSON.stringify({ measurements, worker }));
});

for (const mode of ['chunking', 'worker']) {
  test(`${mode}: cancellation releases controls, terminates worker, and allows a clean next run`, async ({ page }) => {
    await select(page, mode, '16000000');
    await page.locator('#start').click();
    await waitForProgress(page);
    await page.locator('#cancel').click();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.locator('#results-body tr')).toHaveAttribute('data-status', 'cancelled');
    await expect(page.locator('#checksum')).toHaveText('расчёт не завершён');
    await expect(page.locator('#start')).toBeEnabled();
    if (mode === 'worker') expect(await page.evaluate(() => window.__workerAudit.terminated)).toBe(1);
    await page.locator('#load').selectOption('1000000');
    await page.locator('#start').click();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
    await expect(page.locator('#result-count')).toHaveText('2');
    await expect(page.locator('#checksum-state')).toHaveText('Эталон для этой нагрузки');
    if (mode === 'worker') expect(await page.evaluate(() => window.__workerAudit.terminated)).toBe(2);
  });
}

test('repeat preserves mode and workload; reset clears measurements, clicks and references', async ({ page }) => {
  await select(page, 'worker', '1000000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  const checksum = await page.locator('#checksum').textContent();
  await select(page, 'blocking', '16000000');
  await page.locator('.repeat-button').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#load')).toHaveValue('1000000');
  await expect(page.locator('#current-mode')).toHaveText('Web Worker');
  await expect(page.locator('#checksum')).toHaveText(checksum);
  await expect(page.locator('#result-count')).toHaveText('2');
  await page.locator('#probe').click();
  await page.locator('#reset').click();
  await expect(page.locator('#result-count')).toHaveText('0');
  await expect(page.locator('#results-body tr')).toHaveCount(0);
  await expect(page.locator('#click-count')).toHaveText('0');
  await expect(page.locator('#max-gap')).toHaveText('—');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'idle');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#checksum-state')).toHaveText('Эталон для этой нагрузки');
});

test('a different workload gets its own checksum reference', async ({ page }) => {
  await select(page, 'worker', '1000000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  const first = await page.locator('#checksum').textContent();
  await page.locator('#load').selectOption('8000000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#checksum-state')).toHaveText('Эталон для этой нагрузки');
  await expect(page.locator('#checksum')).not.toHaveText(first);
});

test('Worker error is visible and recoverable without reloading', async ({ page }) => {
  await page.evaluate(() => { window.Worker = undefined; });
  await select(page, 'worker', '1000000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#error-message')).toBeVisible();
  await expect(page.locator('#error-message')).toContainText('не поддерживает Web Worker');
  await expect(page.locator('#start')).toBeEnabled();
  await select(page, 'chunking', '1000000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#error-message')).toBeHidden();
  await expect(page.locator('#result-count')).toHaveText('2');
});

test('educational code switches with the selected mode and mobile has no page overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await select(page, 'microtasks', '1000000');
  await page.locator('summary').click();
  await expect(page.locator('#mode-code')).toContainText('await Promise.resolve()');
  await expect(page.locator('#learning-description')).toContainText('очередь микрозадач');
  await select(page, 'chunking', '1000000');
  await expect(page.locator('#mode-code')).toContainText('setTimeout(r, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('summary').click();
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});

for (const mode of ['blocking', 'microtasks']) {
  test(`${mode}: running state gets a frame before work, and real input waits for computation`, async ({ page }) => {
    await select(page, mode);
    const bounds = await page.locator('#probe').boundingBox();
    // Position the pointer before work starts. mouse.click() moves first and
    // waits for that move; during a stall it would only create the click later.
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.evaluate(() => {
      window.__inputTrace = { beforeWorkFrames: 0, progressAtClick: null };
      document.querySelector('#probe').addEventListener('click', () => {
        window.__inputTrace.progressAtClick = document.querySelector('#progress').getAttribute('aria-valuenow');
      }, { once: true });
      const observe = () => {
        const state = document.querySelector('#status').dataset.state;
        if (state === 'running' && document.querySelector('#progress').getAttribute('aria-valuenow') === '0') {
          window.__inputTrace.beforeWorkFrames++;
        }
        if (state !== 'completed') requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
      // Return to the test driver before the blocking experiment starts.
      setTimeout(() => document.querySelector('#start').click(), 0);
    });
    // This waits only in the external test driver. App computation is real.
    await new Promise(resolve => setTimeout(resolve, 150));
    const inputSentAt = performance.now();
    await Promise.all([page.mouse.down(), page.mouse.up()]);
    const inputRoundTripMs = performance.now() - inputSentAt;
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
    await expect(page.locator('#click-count')).toHaveText('1');
    const trace = await page.evaluate(() => window.__inputTrace);
    expect(trace.beforeWorkFrames).toBeGreaterThan(0);
    // Measure from the external driver: synthesized click.timeStamp may be
    // created after queued pointer events, hiding their earlier wait. This is
    // an end-to-end automation check, not a browser input performance metric.
    expect(inputRoundTripMs).toBeGreaterThan(200);
    expect(trace.progressAtClick).toBe('100');
    console.log('INPUT_ROUNDTRIP', mode, JSON.stringify({ ...trace, inputRoundTripMs }));
  });
}
