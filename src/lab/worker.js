/**
 * @file Вычисления в отдельном потоке без доступа к DOM.
 * Этот модуль импортирует тот же алгоритм, что и режимы главного потока.
 */
import { createWork, processUntil } from "./compute.js";

/**
 * Ответ главному потоку: снимок прогресса/итога или сообщение об ошибке.
 * @typedef {(
 *   {type: "progress" | "done", result: import("./runners.js").WorkResult} |
 *   {type: "error", message: string}
 * )} WorkerResponse
 */

/**
 * Выполняет один расчёт и закрывает Worker после отправки ответа.
 * Порции по 4096 элементов позволяют проверять время отправки прогресса;
 * уступать главный поток здесь не требуется, поскольку поток уже отдельный.
 * Входные данные создаются по индексу, поэтому большой массив не пересылается.
 * @param {MessageEvent<{total: number}>} event Запрос с количеством элементов.
 * @returns {void}
 */
self.onmessage = ({ data }) => {
  try {
    const work = createWork(data.total);
    let computeMs = 0;
    let lastReport = performance.now();
    while (work.processed < work.total) {
      const start = performance.now();
      processUntil(work, work.processed + 4096);
      computeMs += performance.now() - start;
      const now = performance.now();
      // Ограничиваем прогресс примерно 12 сообщениями в секунду, чтобы обработка
      // сообщений сама не создавала большую нагрузку на главный поток.
      if (now - lastReport >= 80 && work.processed < work.total) {
        self.postMessage({ type: "progress", result: { ...work, computeMs } });
        lastReport = now;
      }
    }
    self.postMessage({ type: "done", result: { ...work, computeMs } });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  } finally {
    self.close();
  }
};
