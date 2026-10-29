/**
 * @file Наблюдение за интервалами фактических вызовов requestAnimationFrame.
 * Это измерение доступности главного потока для callback, а не INP или FPS.
 */

/**
 * @typedef {Object} FrameSample
 * @property {number} maxGap Максимальный наблюдаемый интервал между rAF, в мс.
 * @property {number} frames Число callback в периоде наблюдения эксперимента.
 * @property {boolean} hidden Замечена ли скрытая вкладка во время наблюдения.
 */

/**
 * @typedef {Object} FrameUpdate
 * @property {number} now Время вызова по performance.now(), в мс.
 * @property {number} gap Интервал от предыдущего callback; у первого равен 0.
 * @property {number} frames Общее число callback с момента создания монитора.
 * @property {FrameSample | null} sample Текущее наблюдение или null вне опыта.
 */

/**
 * Непрерывно вызывает обработчик UI и по запросу собирает метрики одного опыта.
 * Во время блокировки сам монитор также не выполняется: пауза обнаруживается
 * только при следующем callback, когда главный поток снова получает управление.
 */
export class FrameMonitor {
  /**
   * Сразу запускает цикл rAF и отслеживание видимости вкладки.
   * @param {(frame: FrameUpdate) => void} onFrame Обновление UI на каждом callback.
   */
  constructor(onFrame) {
    this.lastAt = null;
    this.frames = 0;
    /** @type {(FrameSample & {resolve?: (sample: FrameSample) => void}) | null} */
    this.sample = null;
    /** Измеряет интервал, уведомляет UI и планирует следующий callback. */
    this.tick = () => {
      const now = performance.now();
      const gap = this.lastAt === null ? 0 : now - this.lastAt;
      this.lastAt = now;
      this.frames++;
      const sample = this.sample;
      if (sample) {
        sample.maxGap = Math.max(sample.maxGap, gap);
        sample.frames++;
        if (document.hidden) sample.hidden = true;
      }
      onFrame({ now, gap, frames: this.frames, sample });
      // Сначала учитываем этот кадр, затем завершаем наблюдение: именно его
      // интервал содержит паузу, которую создал синхронный расчёт.
      if (sample?.resolve) {
        this.sample = null;
        const { resolve, ...result } = sample;
        resolve(result);
      }
      this.rafId = requestAnimationFrame(this.tick);
    };
    /** Помечает измерения, на которые могло повлиять ограничение фоновой вкладки. */
    this.onVisibility = () => {
      if (this.sample && document.hidden) this.sample.hidden = true;
    };
    document.addEventListener("visibilitychange", this.onVisibility);
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * Начинает новое наблюдение перед вычислениями.
   * lastAt сохраняется: первый интервал начнётся в предыдущем callback rAF.
   * Вызывается только при отсутствии незавершённого опыта.
   * @returns {void}
   */
  begin() {
    this.sample = { maxGap: 0, frames: 0, hidden: document.hidden };
  }

  /**
   * Запрашивает итог, но дожидается ещё одного rAF после расчёта.
   * Так в максимум попадает интервал, включающий синхронную блокировку.
   * В скрытой вкладке ожидание может продолжаться до возобновления rAF.
   * Вызывается один раз после begin(); сам цикл монитора продолжает работать.
   * @returns {Promise<FrameSample>} Метрики с учётом первого кадра после расчёта.
   */
  finish() {
    return new Promise((resolve) => {
      this.sample.resolve = resolve;
    });
  }
}
