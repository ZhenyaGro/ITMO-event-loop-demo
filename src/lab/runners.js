/**
 * @file Стратегии выполнения одного алгоритма: меняется способ планирования,
 * но число преобразований и порядок обработки элементов остаются одинаковыми.
 */
import { BATCH_SIZE, createWork, processUntil } from "./compute.js";

/**
 * Снимок вычислений вместе с измеренным временем вычислительных участков.
 * В промежуточном сообщении processed может быть меньше total.
 * computeMs — прошедшее время в миллисекундах, не аппаратное CPU time.
 * @typedef {import("./compute.js").WorkState & {computeMs: number}} WorkResult
 */

/**
 * Получатель очередного снимка прогресса.
 * @callback ProgressCallback
 * @param {WorkResult} result Снимок, отделённый от изменяемого состояния расчёта.
 * @returns {void}
 */

/**
 * @typedef {Object} RunOptions
 * @property {AbortSignal} signal Сигнал отмены текущего запуска.
 * @property {ProgressCallback} [onProgress] Обработчик промежуточных результатов.
 */

/** Целевой бюджет порции в мс; проверяется после каждого блока элементов. */
export const SLICE_BUDGET_MS = 7;
/** Минимальный интервал сообщений о прогрессе микрозадачного режима в мс. */
export const PROGRESS_INTERVAL_MS = 80;

/**
 * Выполняет весь объём одним синхронным вызовом в текущем потоке.
 * Во время работы главный поток не может выполнять обработчики ввода и rAF.
 * @param {number} total Общее количество элементов.
 * @returns {WorkResult} Полный результат и длительность вычислительного участка.
 * @throws {RangeError} Если нагрузка недопустима.
 */
export function runBlocking(total) {
  const work = createWork(total);
  const start = performance.now();
  processUntil(work, total);
  return { ...work, computeMs: performance.now() - start };
}

/**
 * Демонстрирует блокировку UI цепочкой микрозадач, несмотря на async / await.
 * Продолжение после разрешённого Promise снова попадает в очередь микрозадач:
 * разбиение вычислений здесь не создаёт возможности обработать следующую задачу.
 * @param {number} total Общее количество элементов.
 * @param {ProgressCallback} [onProgress] Обновляет DOM, но не гарантирует отрисовку.
 * @returns {Promise<WorkResult>} Полный результат; ожидания таймеров здесь нет.
 */
export async function runMicrotasks(total, onProgress = () => {}) {
  const work = createWork(total);
  let computeMs = 0;
  let lastReport = performance.now();
  while (work.processed < total) {
    const start = performance.now();
    processUntil(work, work.processed + 8192);
    computeMs += performance.now() - start;
    if (performance.now() - lastReport >= PROGRESS_INTERVAL_MS) {
      onProgress({ ...work, computeMs });
      lastReport = performance.now();
    }
    // Намеренная ловушка: очередь микрозадач продолжает опустошаться.
    // DOM меняется, но браузер ещё не получает возможность показать изменения.
    await Promise.resolve();
  }
  return { ...work, computeMs };
}

/**
 * Возвращает управление браузеру до выполнения отдельной задачи таймера.
 * Задержка 0 не обещает немедленный запуск или отрисовку между всеми порциями.
 * При отмене ожидающий таймер удаляется, а Promise отклоняется с signal.reason.
 * @param {AbortSignal} signal Сигнал отмены; может быть уже отменённым.
 * @returns {Promise<void>} Ожидание следующей задачи или отклонение при отмене.
 */
function nextTask(signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    /** Удаляет таймер, чтобы отменённый запуск не продолжил вычисления. */
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 0);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Обрабатывает элементы порциями с передачей управления через setTimeout.
 * Бюджет проверяется после BATCH_SIZE элементов, поэтому может быть превышен
 * на длительность одного блока или при вытеснении потока операционной системой.
 * В computeMs входят вычислительные участки, но не ожидания между порциями.
 * @param {number} total Общее количество элементов.
 * @param {RunOptions} options Отмена и обработчик прогресса.
 * @returns {Promise<WorkResult>} Полный результат; при отмене Promise отклоняется.
 */
export async function runChunked(total, { signal, onProgress = () => {} }) {
  const work = createWork(total);
  let computeMs = 0;
  while (work.processed < total) {
    signal.throwIfAborted();
    const start = performance.now();
    do {
      processUntil(work, work.processed + BATCH_SIZE);
    } while (
      work.processed < total &&
      performance.now() - start < SLICE_BUDGET_MS
    );
    computeMs += performance.now() - start;
    onProgress({ ...work, computeMs });
    if (work.processed < total) await nextTask(signal);
  }
  return { ...work, computeMs };
}

/**
 * Запускает вычисления в отдельном модульном Worker и принимает его сообщения.
 * В Worker передаётся только число элементов. Обработчики прогресса выполняются
 * в главном потоке, а computeMs измеряется внутри Worker.
 * Worker завершается при получении результата, ошибке или отмене.
 * @param {number} total Общее количество элементов.
 * @param {RunOptions} options Отмена и обработчик прогресса.
 * @returns {Promise<WorkResult>} Итог Worker; при ошибке или отмене отклоняется.
 */
export function runWorker(total, { signal, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    if (typeof Worker === "undefined") {
      reject(
        new Error(
          "Этот браузер не поддерживает Web Worker. Выберите порционную обработку.",
        ),
      );
      return;
    }
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    /** Останавливает поток и удаляет подписку на отмену завершённого запуска. */
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    /**
     * Освобождает ресурсы и передаёт ошибку вызывающей стороне.
     * @param {unknown} error Ошибка Worker или произвольное значение signal.reason.
     * @returns {void}
     */
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    // terminate() не требует, чтобы занятый Worker сначала обработал сообщение.
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      fail(
        new Error(
          "Не удалось выполнить Web Worker. Проверьте HTTP-сервер и повторите запуск.",
        ),
      );
    };
    worker.onmessageerror = () =>
      fail(new Error("Не удалось прочитать сообщение Web Worker."));
    /**
     * @param {MessageEvent<import("./worker.js").WorkerResponse>} event
     * Сообщение протокола Worker: прогресс, итог или описание ошибки.
     * @returns {void}
     */
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.result);
      if (data.type === "done") {
        cleanup();
        resolve(data.result);
      }
      if (data.type === "error") fail(new Error(data.message));
    };
    try {
      worker.postMessage({ total });
    } catch (error) {
      fail(error);
    }
  });
}
