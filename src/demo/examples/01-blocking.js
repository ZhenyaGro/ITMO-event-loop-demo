/**
 * Считает от 0 до LIMIT одной задачей главного потока.
 * @param {object} options Параметры, проверенные интерфейсом перед запуском.
 * @param {number} options.LIMIT Целое число итераций.
 * @param {(result: number) => void} options.showResult Принимает итог счёта.
 * @returns {void}
 */
export function runBlocking({ LIMIT, showResult }) {
  // demo:start
  let i = 0;

  function count() {
    while (i < LIMIT) {
      i++;
    }
    showResult(i);
  }

  count();
  // demo:end
}
