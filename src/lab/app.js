/**
 * @file Связывает элементы страницы, вычислительные стратегии и измерения.
 * Основной маршрут чтения: обработчик кнопки → startExperiment() → выбранный
 * runner → проверка суммы → завершение наблюдения → отображение результата.
 */
import { formatChecksum, ROUNDS } from "./compute.js";
import { FrameMonitor } from "./frame-monitor.js";
import { LOADS, MODES } from "./modes.js";
import {
  runBlocking,
  runChunked,
  runMicrotasks,
  runWorker,
} from "./runners.js";

/**
 * Состояние выполняющегося опыта; используется для прогресса, времени и отмены.
 * @typedef {Object} ActiveRun
 * @property {import("./modes.js").ModeId} mode Выбранная стратегия.
 * @property {number} total Количество элементов, зафиксированное при запуске.
 * @property {AbortController} controller Источник сигнала отмены.
 * @property {number} processed Последнее известное число обработанных элементов.
 * @property {number | null} computeMs Последнее известное время вычислений в мс.
 * @property {number | null} startedAt Начало стратегии по performance.now().
 * @property {number | null} endedAt Конец стратегии, без ожидания последнего кадра.
 */

/**
 * Завершённая запись истории, в том числе отменённый или ошибочный запуск.
 * @typedef {Object} ExperimentRecord
 * @property {number} id Порядковый номер запуска после последнего сброса.
 * @property {import("./modes.js").ModeId} mode Стратегия выполнения.
 * @property {number} total Запрошенное количество элементов.
 * @property {number} processed Последний полученный прогресс, не всегда полный.
 * @property {"completed" | "cancelled" | "error"} status Исход эксперимента.
 * @property {number | null} checksum Итоговая сумма или null, если итог не получен.
 * @property {"reference" | "match" | "mismatch" | null} match Сравнение с эталоном.
 * @property {number} totalMs Полное время стратегии в миллисекундах.
 * @property {number | null} computeMs Время вычислительных участков успешного опыта.
 * @property {number | null} overheadMs Разность полного времени и computeMs.
 * @property {number} maxGap Максимальный наблюдаемый интервал rAF в мс.
 * @property {number} frames Число rAF за опыт, включая первый после расчёта.
 * @property {boolean} hidden Замечен ли уход вкладки в фон во время измерения.
 * @property {string} [error] Описание ошибки или причины отмены.
 */

/**
 * Короткая запись поиска элемента в разметке index.html.
 * @param {string} id HTML-идентификатор без символа #.
 * @returns {HTMLElement | null} Найденный элемент или null при отсутствии.
 */
const $ = (id) => document.getElementById(id);
const modeButtons = [...document.querySelectorAll(".mode-button")];
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const seconds = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/**
 * Форматирует измеренную длительность для русскоязычного интерфейса.
 * @param {number | null} ms Миллисекунды; null означает отсутствие полного замера.
 * @returns {string} Миллисекунды, секунды для значений >= 1000 мс либо «—».
 */
const duration = (ms) =>
  ms == null
    ? "—"
    : ms < 1000
      ? `${number.format(ms)} мс`
      : `${seconds.format(ms / 1000)} с`;

/** @type {import("./modes.js").ModeId} */
let selectedMode = "blocking";
/** @type {ActiveRun | null} null означает, что новый эксперимент можно запускать. */
let active = null;
/** @type {ExperimentRecord[]} История в памяти страницы до сброса или перезагрузки. */
let records = [];
/** @type {Map<number, number>} Эталонная сумма для каждого количества элементов. */
let references = new Map();
let clicks = 0;
// Смещение обнуляет видимый счётчик, не перезапуская непрерывный монитор rAF.
let frameOffset = 0;
let lastUiUpdate = 0;

/** Монитор работает постоянно; метрики отдельного опыта собираются begin/finish. */
const monitor = new FrameMonitor(({ now, frames, sample }) => {
  // Индикатор двигается только из JavaScript: CSS-анимация его не продолжает.
  $("orbit-hand").style.transform =
    `rotate(${((frames - frameOffset) * 2.2) % 360}deg)`;
  $("frame-count").textContent = integer.format(frames - frameOffset);
  if (active?.startedAt != null && now - lastUiUpdate > 60) {
    lastUiUpdate = now;
    $("elapsed").textContent = duration(
      (active.endedAt ?? now) - active.startedAt,
    );
    if (sample) $("max-gap").textContent = number.format(sample.maxGap);
  }
});

/**
 * Обновляет текст статуса и атрибут, от которого зависит его оформление.
 * @param {"idle" | "running" | "completed" | "cancelled" | "error"} state Состояние.
 * @param {string} text Понятная пользователю подпись.
 * @returns {void}
 */
function setStatus(state, text) {
  $("status").dataset.state = state;
  $("status").textContent = text;
}

/**
 * Согласованно обновляет число процентов, полосу и доступное ARIA-описание.
 * До фактического завершения подпись ограничена 99%, чтобы округление не
 * показало 100% раньше обработки последнего элемента.
 * @param {number} processed Количество обработанных элементов.
 * @param {number} total Общее положительное количество элементов.
 * @returns {void}
 */
function setProgress(processed, total) {
  const percent = Math.min(100, (processed / total) * 100);
  const displayed =
    processed === total ? 100 : Math.min(99, Math.floor(percent));
  $("progress-value").innerHTML = `${displayed}<span>%</span>`;
  $("progress-fill").style.width = `${percent}%`;
  $("progress").setAttribute("aria-valuenow", String(displayed));
  $("progress").setAttribute(
    "aria-valuetext",
    `${displayed} процентов, ${integer.format(processed)} из ${integer.format(total)} элементов`,
  );
}

/**
 * Подготавливает панель вычислений к новому запуску или выбору настроек.
 * История результатов, эталоны и счётчик нажатий при этом сохраняются.
 * @returns {void}
 */
function clearComputation() {
  setProgress(0, Number($("load").value));
  for (const id of ["elapsed", "compute-time", "overhead-time"])
    $(id).textContent = "—";
  $("checksum").textContent = "ещё не вычислена";
  $("checksum-state").textContent = "";
  $("checksum-state").className = "";
  $("error-message").hidden = true;
  $("task-message").textContent = MODES[selectedMode].prediction;
  setStatus("idle", "Ожидание");
}

/**
 * Выбирает стратегию, обновляет объяснение, схему, код и доступность отмены.
 * Во время активного опыта или при неизвестном режиме ничего не меняет.
 * @param {import("./modes.js").ModeId} mode Идентификатор из MODES.
 * @returns {void}
 */
function selectMode(mode) {
  if (active || !MODES[mode]) return;
  selectedMode = mode;
  document.body.dataset.mode = mode;
  modeButtons.forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode)),
  );
  const info = MODES[mode];
  $("current-mode").textContent = info.name;
  $("cancel-hint").textContent = info.cancellable
    ? "Можно остановить расчёт и сразу запустить новый опыт."
    : "Этот режим нельзя остановить во время расчёта.";
  $("main-track").innerHTML = info.mainTrack;
  $("worker-track").innerHTML = info.workerTrack;
  $("model-number").textContent =
    `0${Object.keys(MODES).indexOf(mode) + 1} / ${info.name.toUpperCase()}`;
  $("model-description").textContent = info.model;
  $("learning-title").textContent = info.name;
  $("learning-description").textContent = info.description;
  $("learning-benefit").textContent = info.benefit;
  $("learning-constraint").textContent = info.constraint;
  $("mode-code").textContent = info.code;
  clearComputation();
}

/**
 * Блокирует конкурирующие действия на время опыта, сохраняя кнопку проверки UI.
 * Отмена разрешается только у порционной обработки и Worker.
 * @param {boolean} locked Нужно ли заблокировать запуск и изменение настроек.
 * @returns {void}
 */
function lockControls(locked) {
  modeButtons.forEach((button) => {
    button.disabled = locked;
  });
  $("load").disabled = locked;
  $("start").disabled = locked;
  $("reset").disabled = locked;
  $("cancel").disabled = !locked || !MODES[selectedMode].cancellable;
  document.querySelectorAll(".repeat-button").forEach((button) => {
    button.disabled = locked;
  });
  $("start").lastElementChild.textContent = locked
    ? "Эксперимент идёт…"
    : "Запустить эксперимент";
}

/**
 * Даёт браузеру возможность отрисовать «Выполняется» перед тяжёлой задачей.
 * Два rAF и отдельная задача таймера отделяют изменение DOM от начала расчёта.
 * Подготовительное ожидание не включается в измеряемое время стратегии.
 * @returns {Promise<void>} Разрешается в задаче таймера после двух callback rAF.
 */
function allowPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, 0)),
    ),
  );
}

/**
 * Проводит один опыт: фиксирует настройки, запускает стратегию, проверяет сумму
 * и сохраняет измерения после первого кадра, следующего за вычислениями.
 * Повторный вызов во время работы игнорируется. Ошибки стратегии и отмена
 * превращаются в записи истории; после финализации управление освобождается.
 * @returns {Promise<void>} Завершается после сохранения и отображения результата.
 */
async function startExperiment() {
  if (active) return;
  const run = {
    mode: selectedMode,
    total: Number($("load").value),
    controller: new AbortController(),
    processed: 0,
    computeMs: null,
    startedAt: null,
    endedAt: null,
  };
  active = run;
  clearComputation();
  lockControls(true);
  $("visibility-warning").hidden = true;
  $("max-gap").textContent = "—";
  $("gap-context").textContent = "Наблюдаем кадры этого эксперимента.";
  $("task-message").textContent = MODES[run.mode].prediction;
  setStatus("running", "Выполняется");
  await allowPaint();

  run.startedAt = performance.now();
  monitor.begin();
  const record = {
    mode: run.mode,
    total: run.total,
    status: "completed",
    checksum: null,
    match: null,
  };
  /**
   * Отображает только прогресс текущего, ещё не отменённого запуска.
   * @param {import("./runners.js").WorkResult} result Снимок вычислений.
   * @returns {void}
   */
  const onProgress = (result) => {
    if (active !== run || run.controller.signal.aborted) return;
    run.processed = result.processed;
    run.computeMs = result.computeMs;
    setProgress(result.processed, run.total);
    $("compute-time").textContent = duration(result.computeMs);
  };

  try {
    run.controller.signal.throwIfAborted();
    let result;
    if (run.mode === "blocking") result = runBlocking(run.total);
    if (run.mode === "microtasks")
      result = await runMicrotasks(run.total, onProgress);
    if (run.mode === "chunking")
      result = await runChunked(run.total, {
        signal: run.controller.signal,
        onProgress,
      });
    if (run.mode === "worker")
      result = await runWorker(run.total, {
        signal: run.controller.signal,
        onProgress,
      });
    run.endedAt = performance.now();
    if (
      result.processed !== run.total ||
      !Number.isInteger(result.checksum) ||
      !Number.isFinite(result.computeMs)
    ) {
      throw new Error(
        "Получен неполный результат вычислений. Повторите эксперимент.",
      );
    }
    onProgress(result);
    record.checksum = result.checksum;
    record.computeMs = result.computeMs;
    // Сравниваем только одинаковые нагрузки. Первый успешный результат становится
    // эталоном серии, поэтому дополнительный тяжёлый проверочный расчёт не нужен.
    const reference = references.get(run.total);
    if (reference !== undefined && reference !== result.checksum) {
      record.match = "mismatch";
      throw new Error(
        "Контрольная сумма не совпала с предыдущим запуском при той же нагрузке. Результат не считается успешным.",
      );
    }
    record.match = reference === undefined ? "reference" : "match";
    references.set(run.total, result.checksum);
  } catch (error) {
    run.endedAt = performance.now();
    record.status = error.name === "AbortError" ? "cancelled" : "error";
    record.error = error.message;
    // Частичный прогресс Worker не описывает полную длительность его работы.
    record.computeMs = null;
  }

  $("cancel").disabled = true;
  $("task-message").textContent = "Фиксируем первый кадр после расчёта…";
  record.totalMs = run.endedAt - run.startedAt;
  record.processed = run.processed;
  record.overheadMs =
    record.computeMs == null
      ? null
      : Math.max(0, record.totalMs - record.computeMs);
  // Расчёт уже окончен, но интервал блокировки станет известен лишь в следующем
  // rAF. Не добавляем ожидание этого кадра к общему времени самой стратегии.
  const sample = await monitor.finish();
  record.maxGap = sample.maxGap;
  record.frames = sample.frames;
  record.hidden = sample.hidden;
  record.id = records.length + 1;
  records.push(record);
  active = null;
  lockControls(false);
  showResult(record);
  renderResults();
}

/**
 * Показывает итог выбранного опыта, включая отмену, ошибку и уход вкладки в фон.
 * Не пересчитывает метрики: использует уже сохранённую запись.
 * @param {ExperimentRecord} record Финализированный результат эксперимента.
 * @returns {void}
 */
function showResult(record) {
  $("max-gap").textContent = number.format(record.maxGap);
  $("gap-context").textContent =
    `Последний опыт: ${MODES[record.mode].name} · ${integer.format(record.frames)} кадров, включая кадр после расчёта.`;
  $("visibility-warning").hidden = !record.hidden;
  $("elapsed").textContent = duration(record.totalMs);
  $("compute-time").textContent = duration(record.computeMs);
  $("overhead-time").textContent = duration(record.overheadMs);
  if (record.checksum !== null)
    $("checksum").textContent = formatChecksum(record.checksum);
  if (record.status === "completed") {
    setStatus("completed", "Завершено");
    $("task-message").textContent =
      `${integer.format(record.total)} элементов × ${ROUNDS} раундов. Можно сравнить со следующим режимом.`;
    $("checksum-state").textContent =
      record.match === "reference" ? "Эталон для этой нагрузки" : "✓ Совпадает";
    $("checksum-state").className = "checksum-ok";
  } else if (record.status === "cancelled") {
    setStatus("cancelled", "Отменено");
    $("task-message").textContent =
      "Вычисления остановлены. Неполный результат не сравнивается; можно запустить опыт снова.";
    $("checksum").textContent = "расчёт не завершён";
  } else {
    setStatus("error", "Ошибка");
    $("task-message").textContent =
      "Можно повторить запуск, сменить режим или сбросить результаты.";
    $("error-message").hidden = false;
    $("error-message").textContent = record.error;
    if (record.match === "mismatch") {
      $("checksum-state").textContent = "Не совпадает";
      $("checksum-state").className = "checksum-error";
    }
  }
}

/**
 * Выбирает условную оценку наблюдаемых интервалов для строки таблицы.
 * Пороги 50 и 200 мс учебные; они не превращают rAF-замер в INP или Long Tasks.
 * Отменённым, ошибочным и фоновым запускам оценка отзывчивости не присваивается.
 * @param {ExperimentRecord} record Финализированный результат эксперимента.
 * @returns {[string, string]} CSS-класс оценки и подпись для пользователя.
 */
function observation(record) {
  if (record.status === "cancelled") return ["neutral", "Отменено"];
  if (record.status === "error") return ["bad", "Ошибка"];
  if (record.hidden) return ["neutral", "Фоновая вкладка"];
  if (record.maxGap > 200) return ["bad", "Долгая пауза"];
  if (record.maxGap > 50) return ["medium", "Заметная пауза"];
  return ["good", "Короткие интервалы"];
}

/**
 * Перестраивает таблицу из records и связывает кнопки повтора с их запусками.
 * Повтор восстанавливает исходные режим и нагрузку, а затем создаёт новый опыт.
 * @returns {void}
 */
function renderResults() {
  $("result-count").textContent = records.length;
  $("empty-results").hidden = records.length > 0;
  $("results-container").hidden = records.length === 0;
  $("results-body").replaceChildren();
  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.mode = record.mode;
    row.dataset.status = record.status;
    // Исходные числа в data-атрибутах позволяют тестировать метрики независимо
    // от пробелов, десятичных запятых и округления в пользовательских подписях.
    row.dataset.totalMs = record.totalMs;
    row.dataset.computeMs = record.computeMs ?? "";
    row.dataset.maxGap = record.maxGap;
    row.dataset.frames = record.frames;
    row.dataset.total = record.total;
    row.dataset.checksum = record.checksum ?? "";
    const [quality, label] = observation(record);
    const checksumLabel =
      record.match === "reference"
        ? "эталон серии"
        : record.match === "match"
          ? "✓ совпадает"
          : record.match === "mismatch"
            ? "не совпадает"
            : "не завершено";
    const load = LOADS.find((item) => item.value === record.total);
    row.innerHTML = `<td><span class="result-mode"><i class="mode-dot ${MODES[record.mode].accent}"></i>${MODES[record.mode].name}</span><small>Запуск ${String(record.id).padStart(2, "0")}</small></td>
      <td class="numeric">${load?.short ?? integer.format(record.total)}</td>
      <td class="numeric">${integer.format(record.totalMs)} мс<small>${record.computeMs == null ? "неполный запуск" : `расчёт: ${integer.format(record.computeMs)} мс`}</small></td>
      <td class="numeric gap-cell">${number.format(record.maxGap)} мс</td>
      <td><span class="quality ${quality}"><i></i>${label}</span></td>
      <td><code>${record.checksum === null ? "—" : formatChecksum(record.checksum)}</code><small class="${record.match === "mismatch" ? "checksum-error" : ""}">${checksumLabel}</small></td>
      <td><button type="button" class="repeat-button" aria-label="Повторить запуск ${record.id}: ${MODES[record.mode].name}" title="Повторить с той же нагрузкой">↻</button></td>`;
    row.querySelector("button").addEventListener("click", () => {
      if (active) return;
      $("load").value = String(record.total);
      selectMode(record.mode);
      void startExperiment();
    });
    $("results-body").append(row);
  }
}

// Подключаем события один раз. Проверки active дополняют disabled в интерфейсе.
modeButtons.forEach((button) =>
  button.addEventListener("click", () => selectMode(button.dataset.mode)),
);
$("load").addEventListener("change", clearComputation);
$("start").addEventListener("click", () => {
  void startExperiment();
});
$("cancel").addEventListener("click", () => {
  // Один сигнал используется и для остановки таймера порций, и для terminate().
  if (active && MODES[active.mode].cancellable)
    active.controller.abort(
      new DOMException("Остановлено пользователем.", "AbortError"),
    );
});
$("probe").addEventListener("click", () => {
  // Счётчик меняется в обычном обработчике главного потока: при блокировке он ждёт.
  clicks++;
  $("click-count").textContent = clicks;
  $("probe-hint").textContent = `Обработчик выполнен · нажатие ${clicks}`;
});
$("reset").addEventListener("click", () => {
  // Полный сброс опыта: таблица, эталоны, нажатия и показания панели.
  if (active) return;
  records = [];
  references = new Map();
  clicks = 0;
  frameOffset = monitor.frames;
  $("click-count").textContent = "0";
  $("probe-hint").textContent = "Нажимайте во время вычислений";
  $("max-gap").textContent = "—";
  $("gap-context").textContent = "Измерение начнётся с запуском опыта.";
  $("visibility-warning").hidden = true;
  clearComputation();
  renderResults();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && active) $("visibility-warning").hidden = false;
});
// При уходе со страницы освобождаем ресурсы отменяемого запуска.
window.addEventListener("pagehide", () => active?.controller.abort());
selectMode(selectedMode);
