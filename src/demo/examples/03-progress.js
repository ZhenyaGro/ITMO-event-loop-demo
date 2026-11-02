/**
 * Тот же порционный счёт, дополненный обновлением DOM после каждой порции.
 * Изменение DOM не гарантирует отрисовку после каждого вызова count().
 * @param {object} options Параметры, проверенные интерфейсом перед запуском.
 * @param {number} options.LIMIT Целое число итераций.
 * @param {number} options.CHUNK_SIZE Максимальное число итераций в порции.
 * @param {(result: number) => void} options.showResult Принимает итог счёта.
 * @param {(processed: number, total: number) => void} options.updateProgress Обновляет DOM.
 * @returns {void}
 */
export function runProgress({ LIMIT, CHUNK_SIZE, showResult, updateProgress }) {
  // demo:start
  let i = 0;

  function count() {
    const end = Math.min(i + CHUNK_SIZE, LIMIT);
    while (i < end) {
      i++;
    }
    updateProgress(i, LIMIT);
    if (i < LIMIT) {
      setTimeout(count, 0);
    } else {
      showResult(i);
    }
  }

  count();
  // demo:end
}
