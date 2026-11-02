/** @file Проверяет обе страницы production-сборки и реальные измерения простой демонстрации. */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const DEMO_URL = '/ITMO-event-loop-demo/demo/';
const LAB_URL = '/ITMO-event-loop-demo/';

test.beforeEach(async ({ page }) => {
  await page.goto(DEMO_URL);
  await expect(page.locator('#frame-count')).not.toHaveText('0');
});

/** Устанавливает этап через обычную кнопку интерфейса. */
async function selectStage(page, stage) {
  await page.locator(`.stages button[data-stage="${stage}"]`).click();
}

/** Ждёт финального кадра и возвращает точные измерения текущего результата. */
async function result(page) {
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'completed');
  return page.locator('#experiment').evaluate((panel) => ({ ...panel.dataset }));
}

/** Сопоставляет общие компоненты с лабораторией, включая конфликты каскада страниц. */
async function sharedAppearance(page) {
  return page.locator('.pulse-panel').evaluate((panel) => {
    const properties = {
      '.brand-icon': ['width', 'height', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderRadius'],
      '.footer-link': ['color', 'textDecorationLine', 'textUnderlineOffset'],
      '.pulse-panel': ['padding', 'borderColor', 'borderRadius', 'backgroundImage', 'backgroundColor', 'fontSize', 'lineHeight'],
      '.section-heading': ['display', 'gap', 'marginBottom', 'alignItems', 'justifyContent'],
      '.metric-label': ['color', 'fontSize', 'display'],
      '.orbit': ['width', 'height', 'backgroundImage', 'borderColor'],
      '.orbit-inner': ['borderStyle', 'borderColor'],
      '.orbit-hand i': ['width', 'height', 'backgroundColor', 'boxShadow'],
      '.orbit-center > span': ['fontFamily', 'fontSize', 'letterSpacing'],
      '.hero-metric > span:first-child': ['fontSize', 'color', 'lineHeight'],
      '.tag': ['fontSize', 'padding', 'borderColor'],
      '.probe-button': ['fontSize', 'fontWeight', 'padding', 'minHeight', 'borderRadius', 'backgroundColor', 'color', 'borderColor'],
    };
    return Object.fromEntries(Object.entries(properties).map(([selector, keys]) => {
      const element = selector === '.pulse-panel' ? panel
        : ['.brand-icon', '.footer-link'].includes(selector) ? document.querySelector(selector)
          : panel.querySelector(selector);
      const style = getComputedStyle(element);
      return [selector, Object.fromEntries(keys.map((key) => [key, style[key]]))];
    }));
  });
}

test('три этапа: одинаковый счёт, блокировка, отзывчивость и видимый прогресс', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  // Только наблюдаем реальные rAF и DOM. Таймеры и вычисления не подменяются.
  await page.evaluate(() => {
    window.__demoAudit = { intermediate: [], framesDuringBlocking: 0, progressVisibleTooEarly: false };
    function observe() {
      const stage = document.body.dataset.stage;
      const status = document.querySelector('#status').dataset.state;
      const progress = document.querySelector('#progress');
      if (stage !== 'progress' && progress.getClientRects().length) window.__demoAudit.progressVisibleTooEarly = true;
      if (status === 'running' && stage === 'blocking') window.__demoAudit.framesDuringBlocking++;
      if (status === 'running' && stage === 'progress' && progress.value > 0 && progress.value < progress.max) {
        window.__demoAudit.intermediate.push(progress.value);
      }
      requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
  });

  const measurements = [];
  let clicks = 0;
  for (const stage of ['blocking', 'chunking', 'progress']) {
    await selectStage(page, stage);
    await expect(page.locator('#limit')).toHaveValue('500000000');
    if (stage !== 'progress') await expect(page.locator('#progress-section')).toBeHidden();
    await page.locator('#start').click();
    if (stage !== 'blocking') {
      await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
      for (const selector of ['#start', '#reset', '#load', '#limit', '.stages button']) {
        for (const control of await page.locator(selector).all()) await expect(control).toBeDisabled();
      }
      const frameBefore = await page.locator('#frame-count').textContent();
      await page.locator('#probe').click();
      await expect(page.locator('#click-count')).toHaveText(String(++clicks));
      await expect(page.locator('#probe-hint')).toHaveText(`Обработчик выполнен · нажатие ${clicks}`);
      await expect(page.locator('#status')).toHaveAttribute('data-state', 'running');
      await expect(page.locator('#frame-count')).not.toHaveText(frameBefore);
      if (stage === 'chunking') await expect(page.locator('#progress-section')).toBeHidden();
      else {
        await expect(page.locator('#progress-section')).toBeVisible();
        await expect.poll(() => page.locator('#progress').evaluate((element) => element.value)).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath('progress-running.png') });
      }
    }
    const measured = await result(page);
    await expect(page.locator('#gap-context')).toContainText('включая кадр после расчёта');
    measurements.push(measured);
    expect(measured.result).toBe('500000000');
    expect(Number(measured.totalMs)).toBeGreaterThan(0);
    expect(Number(measured.maxGap)).toBeGreaterThan(0);
    if (stage === 'blocking') {
      expect(Number(measured.totalMs)).toBeGreaterThan(100);
      expect(Number(measured.maxGap)).toBeGreaterThan(Number(measured.totalMs) * .8);
      expect(Number(measured.frames)).toBe(1);
    } else {
      expect(Number(measured.frames)).toBeGreaterThan(10);
      expect(Number(measured.maxGap)).toBeLessThan(Number(measurements[0].maxGap) / 3);
    }
    // Дальнейшие кадры не перезаписывают зафиксированный максимум опыта.
    const frozen = await page.locator('#max-gap').textContent();
    await page.locator('#probe').click();
    clicks++;
    await expect(page.locator('#max-gap')).toHaveText(frozen);
  }
  const audit = await page.evaluate(() => window.__demoAudit);
  expect(audit.progressVisibleTooEarly).toBe(false);
  expect(audit.framesDuringBlocking).toBe(0);
  const progressFrames = [...new Set(audit.intermediate)];
  expect(progressFrames.length).toBeGreaterThan(5);
  expect(progressFrames).toEqual([...progressFrames].sort((a, b) => a - b));
  await expect(page.locator('#progress')).toHaveJSProperty('value', 500000000);
  await expect(page.locator('#progress-percent')).toHaveText('100%');
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('progress-completed.png'), fullPage: true });
  const measurementsPath = testInfo.outputPath('demo-measurements.json');
  writeFileSync(measurementsPath, JSON.stringify({
    browser: page.context().browser().version(), measurements, progressFrames, errors,
  }, null, 2));
  await testInfo.attach('demo-measurements.json', { path: measurementsPath, contentType: 'application/json' });
  console.log('DEMO_REAL_MEASUREMENTS', JSON.stringify({ measurements, visibleProgressFrames: progressFrames.length }));
});

test('начальное состояние получает кадр; реальное нажатие ждёт окончания синхронного цикла', async ({ page }) => {
  const bounds = await page.locator('#probe').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.evaluate(() => {
    window.__inputTrace = { preparingFrames: 0, clickedAt: 0 };
    document.querySelector('#probe').addEventListener('click', () => { window.__inputTrace.clickedAt = performance.now(); }, { once: true });
    function observe() {
      const status = document.querySelector('#status').dataset.state;
      if (status === 'preparing') window.__inputTrace.preparingFrames++;
      if (status !== 'completed') requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
    setTimeout(() => document.querySelector('#start').click(), 0);
  });
  // Ждёт только тестовый драйвер, приложение выполняет настоящий цикл i++.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const sentAt = performance.now();
  await Promise.all([page.mouse.down(), page.mouse.up()]);
  const inputRoundTripMs = performance.now() - sentAt;
  await result(page);
  await expect(page.locator('#click-count')).toHaveText('1');
  const trace = await page.evaluate(() => window.__inputTrace);
  expect(trace.preparingFrames).toBeGreaterThan(0);
  // Это время команды внешней автоматизации, его не называем INP.
  expect(inputRoundTripMs).toBeGreaterThan(100);
  console.log('DEMO_INPUT_ROUNDTRIP', JSON.stringify({ ...trace, inputRoundTripMs }));
});

test('нет автоматической нагрузки; код совпадает с файлами, изменения выделены, прогресс скрывается', async ({ page }) => {
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#result')).toHaveText('—');
  for (const [stage, name, highlight] of [
    ['blocking', '01-blocking', 'while (i < LIMIT)'],
    ['chunking', '02-chunking', 'setTimeout(count, 0);'],
    ['progress', '03-progress', 'updateProgress(i, LIMIT);'],
  ]) {
    await selectStage(page, stage);
    const expected = readFileSync(new URL(`../../src/demo/examples/${name}.js`, import.meta.url), 'utf8')
      .split('// demo:start\n')[1].split('  // demo:end')[0].trimEnd().split('\n').map((line) => line.replace(/^  /, ''));
    const actual = await page.locator('.code-line').allTextContents();
    expect(actual.map((line) => line === '\n' ? '' : line)).toEqual(expected);
    await expect(page.locator('.highlight').filter({ hasText: highlight })).toHaveCount(1);
    await expect(page.locator('#progress-section')).toBeVisible({ visible: stage === 'progress' });
  }
  await selectStage(page, 'blocking');
  await expect(page.locator('#progress-section')).toBeHidden();
});

test('повтор, неполная порция, защита от второго запуска и сброс', async ({ page }) => {
  await page.evaluate(() => {
    window.__completedRuns = 0;
    const status = document.querySelector('#status');
    new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === 'data-state') && status.dataset.state === 'completed') {
        window.__completedRuns++;
      }
    }).observe(status, { attributes: true });
  });
  await selectStage(page, 'progress');
  await page.locator('#limit').fill('10000007');
  await page.locator('#start').click();
  expect((await result(page)).result).toBe('10000007');
  await page.locator('#start').click();
  expect((await result(page)).result).toBe('10000007');
  expect(await page.evaluate(() => window.__completedRuns)).toBe(2);
  await page.locator('#load').selectOption('50000000');
  // Два submit в одной задаче проверяют guard, независимо от disabled кнопки.
  await page.locator('#controls').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect((await result(page)).result).toBe('50000000');
  expect(await page.evaluate(() => window.__completedRuns)).toBe(3);
  await page.locator('#probe').click();
  await page.locator('#reset').click();
  await expect(page.locator('#experiment')).not.toHaveAttribute('data-result');
  await expect(page.locator('#result')).toHaveText('—');
  await expect(page.locator('#max-gap')).toHaveText('—');
  await expect(page.locator('#click-count')).toHaveText('0');
  await expect(page.locator('#probe-hint')).toHaveText('Нажимайте во время вычислений');
  await expect(page.locator('#gap-context')).toHaveText('Измерение начнётся с запуском опыта.');
  await expect(page.locator('#progress')).toHaveJSProperty('value', 0);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'idle');
});

test('предел нагрузки действует и при обходе HTML-валидации; корректный N восстанавливает запуск', async ({ page }) => {
  for (const invalid of ['', '0', '-1', '1.5', '1000000001', '1e20']) {
    await page.locator('#limit').fill(invalid);
    await page.locator('#controls').evaluate((form) => form.dispatchEvent(new Event('submit', { cancelable: true })));
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#start')).toBeEnabled();
    await expect(page.locator('#experiment')).not.toHaveAttribute('data-result');
  }
  await page.locator('#limit').fill('1');
  await page.locator('#start').click();
  expect((await result(page)).result).toBe('1');
});

test('основной экран без таблицы и режима презентации; мобильная вёрстка; переход в лабораторию', async ({ page }, testInfo) => {
  await selectStage(page, 'progress');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Режим презентации' })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  const demoDesktopPulse = await sharedAppearance(page);
  await page.locator('.pulse-panel').screenshot({ path: testInfo.outputPath('demo-pulse.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(1080);
  const demoWidePulse = await sharedAppearance(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  const demoMobilePulse = await sharedAppearance(page);
  await expect(page.locator('#lab-link')).toHaveAttribute('href', LAB_URL);
  await page.locator('#lab-link').click();
  await expect(page).toHaveURL(new RegExp(`${LAB_URL}$`));
  await expect(page.locator('.mode-button')).toHaveCount(4);
  await expect(page.locator('#frame-count')).not.toHaveText('0');
  expect(await sharedAppearance(page)).toEqual(demoMobilePulse);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await sharedAppearance(page)).toEqual(demoDesktopPulse);
  await page.locator('.pulse-panel').screenshot({ path: testInfo.outputPath('lab-pulse.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect(await sharedAppearance(page)).toEqual(demoWidePulse);
  await page.locator('#demo-link').click();
  await expect(page).toHaveURL(new RegExp(`${DEMO_URL}$`));
  await expect(page.locator('.stages button')).toHaveCount(3);
  await expect(page.locator('#frame-count')).not.toHaveText('0');
});

test('dev-сервер обслуживает /demo/ и лабораторию под базовым путём GitHub Pages', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
  try {
    await server.listen();
    const base = server.resolvedUrls.local[0];
    const response = await page.goto(`${base}demo/?view=talk`);
    expect(response.status()).toBe(200);
    await expect(page).toHaveURL(`${base}demo/?view=talk`);
    await expect(page.locator('.stages button')).toHaveCount(3);
    await expect(page.locator('#frame-count')).not.toHaveText('0');
    await selectStage(page, 'progress');
    await page.locator('#limit').fill('1000007');
    await page.locator('#start').click();
    expect((await result(page)).result).toBe('1000007');
    expect((await page.goto(`${base}demo/index.html`)).status()).toBe(200);
    await expect(page.locator('.stages button')).toHaveCount(3);
    await expect(page.locator('#frame-count')).not.toHaveText('0');
    await page.locator('#lab-link').click();
    await expect(page.locator('.mode-button')).toHaveCount(4);
    await page.locator('#demo-link').click();
    await expect(page).toHaveURL(`${base}demo/`);
    await expect(page.locator('.stages button')).toHaveCount(3);
  } finally {
    await server.close();
  }
});
