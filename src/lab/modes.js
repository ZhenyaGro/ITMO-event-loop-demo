/**
 * @file Нагрузки и учебные материалы для интерфейса.
 * Здесь описана модель выполнения; реальные вычисления находятся в runners.js.
 */

/** @typedef {"blocking" | "microtasks" | "chunking" | "worker"} ModeId */

/**
 * @typedef {Object} LoadOption
 * @property {number} value Количество элементов, одинаковое для всех стратегий.
 * @property {string} label Название уровня нагрузки.
 * @property {string} short Короткая подпись для таблицы результатов.
 */

/**
 * Учебное описание режима и его оформление.
 * @typedef {Object} ModeDefinition
 * @property {string} name Название для интерфейса.
 * @property {string} technical Краткая характеристика подхода.
 * @property {string} accent Название цветового акцента.
 * @property {boolean} cancellable Можно ли обработать отмену во время расчёта.
 * @property {string} prediction Что зритель должен наблюдать при запуске.
 * @property {string} description Механизм выполнения и состояние главного потока.
 * @property {string} constraint Ограничения подхода.
 * @property {string} benefit Преимущества и область применения.
 * @property {string} model Пояснение условной схемы потоков.
 * @property {string} mainTrack HTML дорожки главного потока.
 * @property {string} workerTrack HTML дорожки Worker.
 * @property {string} code Учебный фрагмент кода, отображаемый как текст.
 */

/**
 * Предустановленные объёмы работы; должны соответствовать select#load в HTML.
 * Значения фиксированы: скрытой калибровки нагрузки по времени нет.
 * @type {LoadOption[]}
 */
export const LOADS = [
  { value: 1_000_000, label: "Лёгкая", short: "1 млн" },
  { value: 8_000_000, label: "Для доклада", short: "8 млн" },
  { value: 16_000_000, label: "Тяжёлая", short: "16 млн" },
  { value: 24_000_000, label: "Предельная", short: "24 млн" },
];

/**
 * Справочник интерфейса по идентификатору стратегии.
 * Дорожки — иллюстрация, а не трассировка. Фрагменты code не исполняются;
 * обработка ошибок, отмены и часть измерений в них опущены для читаемости.
 * @type {Record<ModeId, ModeDefinition>}
 */
export const MODES = {
  blocking: {
    name: "Синхронно",
    technical: "Один длинный цикл",
    accent: "orange",
    cancellable: false,
    prediction: "Индикатор замрёт. Нажатия подождут.",
    description:
      "Все элементы обрабатываются за один вызов. Пока он не закончится, главный поток не может выполнить обработчик клика или следующий rAF.",
    constraint:
      "Остановить во время расчёта нельзя: обработчик отмены тоже ждёт освобождения главного потока.",
    benefit:
      "Простой код, мало накладных расходов. Подходит для коротких вычислений; длительная работа блокирует интерфейс.",
    model:
      "Одна задача занимает главный поток целиком. Кадр и обработчик клика ждут её окончания.",
    mainTrack:
      '<span class="task long">JavaScript · одна длинная задача</span><span class="ui-slot">UI</span>',
    workerTrack: '<span class="idle-track">Не используется</span>',
    code: `const work = createWork(total);

// Весь объём — за один вызов в главном потоке.
processUntil(work, total);
showResult(work.checksum);`,
  },
  microtasks: {
    name: "Async / await",
    technical: "Ловушка микрозадач",
    accent: "purple",
    cancellable: false,
    prediction: "Есть await. Свободного интерфейса всё ещё нет.",
    description:
      "После await Promise.resolve() продолжение попадает в очередь микрозадач. Она опустошается до перехода к следующей задаче или возможности обновить отрисовку.",
    constraint:
      "Цепочка микрозадач не даёт обработать отмену. Изменения прогресса в DOM станут видны только после расчёта.",
    benefit:
      "Async / await удобен для асинхронных операций, например ожидания сети. Сам по себе он не переносит CPU-вычисления в другой поток.",
    model:
      "Порции есть, но очередь микрозадач постоянно пополняется. Между ними нет возможности отрисовать UI.",
    mainTrack:
      '<span class="micro-chain"><i>JS</i><i>μ</i><i>μ</i><i>μ</i><i>μ</i><i>μ</i><i>μ</i><i>μ</i></span><span class="ui-slot">UI</span>',
    workerTrack: '<span class="idle-track">Не используется</span>',
    code: `async function calculate(total) {
  const work = createWork(total);
  while (work.processed < total) {
    processUntil(work, work.processed + 8192);
    await Promise.resolve(); // Только микрозадача!
  }
  return work.checksum;
}`,
  },
  chunking: {
    name: "Порциями",
    technical: "Передаём управление браузеру",
    accent: "green",
    cancellable: true,
    prediction: "Индикатор движется. Прогресс растёт.",
    description:
      "Вычисления идут в главном потоке порциями примерно по 7 мс. setTimeout(..., 0) планирует следующую задачу; между задачами браузер может обработать ввод и обновить кадр.",
    constraint:
      "Нулевая задержка не означает немедленный запуск. Таймеры, планировщик и обслуживание UI увеличивают общее время.",
    benefit:
      "Можно показывать прогресс и отменять работу между порциями. Вычисления по-прежнему используют главный поток.",
    model:
      "Короткие задачи чередуются с возможностями обработать ввод и отрисовку. Кадр не гарантирован после каждой порции.",
    mainTrack:
      '<span class="task">JS</span><span class="ui-slot">UI</span><span class="task">JS</span><span class="ui-slot">UI</span><span class="task">JS</span><span class="ui-slot">UI</span><span class="task">JS</span><span class="ui-slot">UI</span>',
    workerTrack: '<span class="idle-track">Не используется</span>',
    code: `while (work.processed < total) {
  const start = performance.now();
  do {
    processUntil(work, work.processed + 256);
  } while (work.processed < total &&
           performance.now() - start < 7);

  showProgress(work.processed / total);
  await new Promise(r => setTimeout(r, 0));
}`,
  },
  worker: {
    name: "Web Worker",
    technical: "Вычисления в отдельном потоке",
    accent: "blue",
    cancellable: true,
    prediction: "Расчёт отдельно. Интерфейс продолжает работать.",
    description:
      "Модульный Worker выполняет тот же алгоритм в отдельном потоке. Главный поток получает только сообщения с прогрессом и результатом, оставляя время на интерфейс.",
    constraint:
      "Worker не имеет доступа к DOM. Запуск потока, доставка сообщений и конкуренция за ресурсы процессора имеют свою цену.",
    benefit:
      "Подходит для длительных CPU-вычислений. Прогресс отправляется не чаще примерно 12 раз в секунду; Worker завершается после результата или отмены.",
    model:
      "Основная нагрузка уходит в Worker. Главный поток обрабатывает сообщения, пользовательский ввод и кадры.",
    mainTrack:
      '<span class="ui-slot wide">Кадры · ввод · сообщения</span><span class="ui-slot">UI</span><span class="ui-slot">UI</span><span class="ui-slot">UI</span>',
    workerTrack: '<span class="task long">JavaScript · те же вычисления</span>',
    code: `// Главный поток
const worker = new Worker(
  new URL('./worker.js', import.meta.url),
  { type: 'module' }
);
worker.postMessage({ total });
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') showProgress(data.result);
  if (data.type === 'done') {
    showResult(data.result.checksum);
    worker.terminate();
  }
};`,
  },
};
