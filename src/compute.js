/**
 * @file Общий вычислительный алгоритм для всех четырёх режимов.
 * Целочисленная арифметика даёт одинаковый результат при разных границах порций.
 * Объём работы задаётся числом элементов и раундов, а не временем ожидания.
 */

/**
 * Изменяемое состояние последовательного расчёта.
 * @typedef {Object} WorkState
 * @property {number} total Общее количество элементов.
 * @property {number} processed Число обработанных элементов; индекс следующего.
 * @property {number} checksum Накопленная беззнаковая 32-битная контрольная сумма.
 */

/** Количество одинаковых преобразований каждого элемента. */
export const ROUNDS = 128;
/** Начальное значение контрольной суммы, общее для всех запусков. */
export const SEED = 0x811c9dc5;
/** Число элементов между проверками временного бюджета порции. */
export const BATCH_SIZE = 256;
/** Верхняя допустимая нагрузка; защищает от случайного чрезмерного значения. */
export const MAX_ELEMENTS = 24_000_000;

/**
 * Создаёт состояние расчёта без подготовки большого массива входных данных.
 * @param {number} total Целое количество элементов от 1 до MAX_ELEMENTS.
 * @returns {WorkState} Новое состояние с нулевым прогрессом.
 * @throws {RangeError} Если количество элементов вне допустимого диапазона.
 */
export function createWork(total) {
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_ELEMENTS) {
    throw new RangeError(
      `Количество элементов должно быть от 1 до ${MAX_ELEMENTS}.`,
    );
  }
  return { total, processed: 0, checksum: SEED };
}

/**
 * Синхронно обрабатывает диапазон [work.processed, end), изменяя work на месте.
 * Значение каждого элемента создаётся по его индексу; массив не требуется.
 * Последовательное накопление checksum сохраняется между вызовами, поэтому
 * разбиение одного объёма на порции не меняет итоговую сумму.
 * @param {WorkState} work Состояние, полученное из createWork().
 * @param {number} end Исключительная верхняя граница: целое >= work.processed.
 * Значения больше work.total ограничиваются общим количеством элементов.
 * @returns {WorkState} Тот же объект с обновлёнными processed и checksum.
 */
export function processUntil(work, end) {
  end = Math.min(end, work.total);
  let checksum = work.checksum;
  for (let index = work.processed; index < end; index++) {
    // >>> 0 приводит результат к беззнаковому 32-битному числу.
    let value = (index ^ 0x9e3779b9) >>> 0;
    for (let round = 0; round < ROUNDS; round++) {
      // Math.imul сохраняет младшие 32 бита произведения; затем вращаем биты.
      value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
      value = (value << 13) | (value >>> 19);
      value = (value + 0x6d2b79f5 + round) | 0;
    }
    checksum = Math.imul(checksum ^ value, 0x01000193) >>> 0;
  }
  work.processed = end;
  work.checksum = checksum;
  return work;
}

/**
 * Представляет контрольную сумму в виде восьми шестнадцатеричных цифр.
 * @param {number} value Беззнаковое 32-битное целое.
 * @returns {string} Строка вида «0x78F6DE67».
 */
export function formatChecksum(value) {
  return `0x${value.toString(16).padStart(8, "0").toUpperCase()}`;
}
