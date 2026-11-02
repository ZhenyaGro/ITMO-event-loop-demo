/** @file Управление тремя примерами, измерения и общий интерфейс доклада. */
import "./style.css";
import { runBlocking } from "./examples/01-blocking.js";
import { runChunking } from "./examples/02-chunking.js";
import { runProgress } from "./examples/03-progress.js";
// Панель кода использует исходники выполняемых функций, а не их копии.
import blockingSource from "./examples/01-blocking.js?raw";
import chunkingSource from "./examples/02-chunking.js?raw";
import progressSource from "./examples/03-progress.js?raw";

const MAX_LIMIT = 1_000_000_000;
const CHUNK_SIZE = 1_000_000;
const integer = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const byId = (id) => document.getElementById(id);
const stageButtons = [...document.querySelectorAll(".stages button")];
const ui = Object.fromEntries(
  [
    "controls",
    "load",
    "limit",
    "start",
    "reset",
    "source-code",
    "constants",
    "code-title",
    "code-change",
    "status",
    "frame-count",
    "orbit-hand",
    "probe",
    "click-count",
    "elapsed",
    "max-gap",
    "result",
    "progress-section",
    "progress",
    "progress-percent",
    "progress-count",
    "explanation-title",
    "explanation-text",
    "experiment",
    "gap-context",
    "probe-hint",
    "error",
    "visibility-warning",
  ].map((id) => [id, byId(id)]),
);

const stages = {
  blocking: {
    label: "1. Синхронный цикл",
    title: "Одна длинная задача",
    change: "while",
    source: blockingSource,
    run: runBlocking,
    highlight: (line) => /while|i\+\+/.test(line),
    heading: "Всё время занято одним циклом",
    explanation:
      "Пока цикл не завершится, главный поток занят: обработчики нажатий и JS-индикатор ждут. Промежуточных обновлений интерфейса нет.",
  },
  chunking: {
    label: "2. Разбиение · setTimeout",
    title: "Работа небольшими порциями",
    change: "+ setTimeout",
    source: chunkingSource,
    run: runChunking,
    highlight: (line) => line.includes("setTimeout(count, 0)"),
    heading: "Браузер получает управление между задачами",
    explanation:
      "setTimeout не создаёт отдельный поток. Нулевая задержка не обещает немедленный вызов: следующая порция ждёт своей очереди. Между задачами возможны ввод и отрисовка.",
  },
  progress: {
    label: "3. Разбиение + прогресс",
    title: "Добавляем одну строку",
    change: "+ updateProgress",
    source: progressSource,
    run: runProgress,
    highlight: (line) => line.includes("updateProgress(i, LIMIT)"),
    heading: "Изменить DOM ≠ сразу отрисовать",
    explanation:
      "После порции обновляем DOM. Браузер может показать новый процент и полосу между задачами, но не обязан отрисовывать каждую порцию.",
  },
};

let selectedStage = "blocking";
let busy = false;
let clicks = 0;
let frames = 0;
let lastFrameAt = null;
let lastUiUpdate = 0;
/**
 * Измерения текущего запуска; история предыдущих запусков не ведётся.
 * @type {{stage: string, limit: number, startedAt: number, maxGap: number,
 * frames: number, hidden: boolean, finished: boolean, result?: number, totalMs?: number} | null}
 */
let sample = null;

/** Форматирует реальное измерение времени. @param {number} value Миллисекунды. */
function milliseconds(value) {
  return `${decimal.format(value)} мс`;
}

/** Очищает показания текущего этапа. */
function clearReadout() {
  for (const id of ["elapsed", "max-gap", "result"]) ui[id].textContent = "—";
  for (const key of Object.keys(ui.experiment.dataset))
    delete ui.experiment.dataset[key];
  ui["gap-context"].textContent = "Измерение начнётся с запуском опыта.";
  ui.error.hidden = true;
  ui["visibility-warning"].hidden = true;
  ui.status.dataset.state = "idle";
  ui.status.textContent = "Готов к запуску";
  updateProgress(0, Number(ui.limit.value) || 1);
}

/** Обновляет параметры над кодом. Изменение настроек не запускает вычисления. */
function renderConstants() {
  const limit = Number(ui.limit.value);
  ui.constants.textContent =
    `LIMIT = ${integer.format(limit)}` +
    (selectedStage === "blocking"
      ? ""
      : ` · CHUNK_SIZE = ${integer.format(CHUNK_SIZE)}`);
}

/**
 * Показывает исполняемый фрагмент без обёртки экспорта и JSDoc.
 * @param {string} id Один из трёх идентификаторов этапа.
 */
function selectStage(id) {
  if (busy) return;
  selectedStage = id;
  const stage = stages[id];
  document.body.dataset.stage = id;
  stageButtons.forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.stage === id)),
  );
  ui["code-title"].textContent = stage.title;
  ui["code-change"].textContent = stage.change;
  ui["explanation-title"].textContent = stage.heading;
  ui["explanation-text"].textContent = stage.explanation;
  ui["progress-section"].hidden = id !== "progress";
  const source = stage.source
    .split("// demo:start\n")[1]
    .split("  // demo:end")[0]
    .trimEnd();
  ui["source-code"].replaceChildren(
    ...source.split("\n").map((line) => {
      const span = document.createElement("span");
      span.className = `code-line${stage.highlight(line) ? " highlight" : ""}${line.trim() ? "" : " blank"}`;
      span.textContent = line.replace(/^  /, "") || "\n";
      return span;
    }),
  );
  clearReadout();
  renderConstants();
}

/**
 * Обновляет DOM после каждой порции третьего примера. CSS-анимации нет.
 * Браузер сам выбирает, какие промежуточные состояния попадут в отрисовку.
 * @param {number} processed Число реально выполненных инкрементов.
 * @param {number} total Количество итераций выбранного запуска.
 */
function updateProgress(processed, total) {
  const percent =
    processed === 0
      ? "0"
      : processed === total
        ? "100"
        : decimal.format(Math.floor((processed / total) * 1000) / 10);
  ui.progress.max = total;
  ui.progress.value = processed;
  ui["progress-percent"].textContent = `${percent}%`;
  ui["progress-count"].textContent =
    `${integer.format(processed)} из ${integer.format(total)} итераций`;
}

/** Запрещает пересечение запусков и изменение их параметров. @param {boolean} value Занятость. */
function setBusy(value) {
  busy = value;
  [ui.start, ui.reset, ui.load, ui.limit, ...stageButtons].forEach(
    (control) => {
      control.disabled = value;
    },
  );
}

/**
 * Принимает вычисленный результат. Ожидание последующего кадра не входит в totalMs.
 * @param {number} result Реальный итоговый счётчик из выбранного примера.
 */
function showResult(result) {
  sample.totalMs = performance.now() - sample.startedAt;
  if (result !== sample.limit) {
    showError(new Error("Итоговый счётчик не совпал с N."));
    return;
  }
  sample.result = result;
  sample.finished = true;
}

/** Показывает текущий результат после учёта первого кадра, следующего за расчётом. */
function finishMeasurement() {
  const {
    stage,
    limit,
    totalMs,
    maxGap,
    result,
    hidden,
    frames: runFrames,
  } = sample;
  ui.elapsed.textContent = milliseconds(totalMs);
  ui["max-gap"].textContent = decimal.format(maxGap);
  ui["gap-context"].textContent =
    `Последний опыт: ${stages[stage].label} · ${integer.format(runFrames)} кадров, включая кадр после расчёта.`;
  ui.result.textContent = integer.format(result);
  ui.status.dataset.state = "completed";
  ui.status.textContent = "Завершено";
  ui["visibility-warning"].hidden = !hidden;
  // Точные значения относятся только к показанному сейчас результату.
  Object.assign(ui.experiment.dataset, {
    stage,
    limit,
    totalMs,
    maxGap,
    result,
    hidden,
    frames: runFrames,
  });
  sample = null;
  setBusy(false);
}

/**
 * Двигает индикатор только из JavaScript и измеряет промежутки между callback.
 * Используется performance.now(), а не timestamp rAF: нужен момент вызова.
 */
function onFrame() {
  const now = performance.now();
  const gap = lastFrameAt === null ? 0 : now - lastFrameAt;
  lastFrameAt = now;
  frames++;
  ui["frame-count"].textContent = integer.format(frames);
  ui["orbit-hand"].style.transform = `rotate(${(frames * 2.2) % 360}deg)`;
  if (sample) {
    sample.frames++;
    sample.maxGap = Math.max(sample.maxGap, gap);
    sample.hidden ||= document.hidden;
    if (now - lastUiUpdate > 60) {
      lastUiUpdate = now;
      ui["max-gap"].textContent = decimal.format(sample.maxGap);
    }
    // Сначала учитываем разрыв после блокировки, затем фиксируем итог.
    if (sample.finished) finishMeasurement();
  }
  requestAnimationFrame(onFrame);
}

/** Сообщает об ошибке и восстанавливает управление. @param {Error} error Причина. */
function showError(error) {
  sample = null;
  setBusy(false);
  ui.error.textContent = error.message;
  ui.error.hidden = false;
  ui.status.dataset.state = "error";
  ui.status.textContent = "Проверьте параметры";
}

/**
 * Проверяет N, показывает начальное состояние и запускает выбранный пример.
 * Два rAF и отдельная задача дают возможность показать статус до блокировки;
 * эта подготовка не является нагрузкой и не входит в общее время эксперимента.
 * @param {SubmitEvent} event Отправка формы настроек.
 */
function start(event) {
  event.preventDefault();
  if (busy) return;
  const limit = Number(ui.limit.value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    showError(
      new Error(`Введите целое N от 1 до ${integer.format(MAX_LIMIT)}.`),
    );
    return;
  }
  clearReadout();
  setBusy(true);
  ui.status.dataset.state = "preparing";
  ui.status.textContent = "Выполняется…";
  ui["gap-context"].textContent = "Наблюдаем кадры этого эксперимента.";
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      setTimeout(() => {
        sample = {
          stage: selectedStage,
          limit,
          startedAt: performance.now(),
          maxGap: 0,
          frames: 0,
          hidden: document.hidden,
          finished: false,
        };
        ui.status.dataset.state = "running";
        try {
          stages[selectedStage].run({
            LIMIT: limit,
            CHUNK_SIZE,
            showResult,
            updateProgress,
          });
        } catch (error) {
          showError(error);
        }
      }, 0),
    ),
  );
}

stageButtons.forEach((button) =>
  button.addEventListener("click", () => selectStage(button.dataset.stage)),
);
ui.controls.addEventListener("submit", start);
ui.load.addEventListener("change", () => {
  ui.limit.value = ui.load.value;
  clearReadout();
  renderConstants();
});
ui.limit.addEventListener("input", () => {
  ui.load.value = [...ui.load.options].some(
    (option) => option.value === ui.limit.value,
  )
    ? ui.limit.value
    : "custom";
  clearReadout();
  renderConstants();
});
ui.probe.addEventListener("click", () => {
  ui["click-count"].textContent = String(++clicks);
  ui["probe-hint"].textContent = `Обработчик выполнен · нажатие ${clicks}`;
});
ui.reset.addEventListener("click", () => {
  if (busy) return;
  clicks = 0;
  frames = 0;
  ui["click-count"].textContent = "0";
  ui["probe-hint"].textContent = "Нажимайте во время вычислений";
  clearReadout();
});
document.addEventListener("visibilitychange", () => {
  if (sample && document.hidden) sample.hidden = true;
});

selectStage("blocking");
requestAnimationFrame(onFrame);
