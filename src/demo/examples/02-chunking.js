/**
 * Считает порциями; между ними возвращает управление браузеру через таймер.
 * @param {object} options Параметры, проверенные интерфейсом перед запуском.
 * @param {number} options.LIMIT Целое число итераций.
 * @param {number} options.CHUNK_SIZE Максимальное число итераций в порции.
 * @param {(result: number) => void} options.showResult Принимает итог счёта.
 * @returns {void}
 */
export function runChunking({ LIMIT, CHUNK_SIZE, showResult }) {
  // demo:start
  let i = 0;

  function count() {
    const end = Math.min(i + CHUNK_SIZE, LIMIT);
    while (i < end) {
      i++;
    }
    if (i < LIMIT) {
      setTimeout(count, 0);
    } else {
      showResult(i);
    }
  }

  count();
  // demo:end
}
