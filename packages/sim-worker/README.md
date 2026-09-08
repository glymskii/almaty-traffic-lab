# @atl/sim-worker

Web Worker вокруг `@atl/sim-core`: протокол сообщений (`@atl/contracts/protocol`), пинг-понг
типизированных буферов кадра и метрик, клиент для главного потока. Сам ничего не считает и не
хранит логику симуляции — только цикл шагов, тайминг и передачу данных. Протокол и инварианты
буферов описаны в `docs/CONTRACTS.md` («Буферы кадра», «Протокол воркера»); поток данных — в
`docs/ARCHITECTURE.md` («Воркер и буферы»).

## Файлы

| Файл | Роль |
|---|---|
| `src/worker-main.ts` | Чистая функция `createWorkerMain({ post, createSimulation? })`: состояние, цикл шагов, ping-pong буферов. Без `self` — тестируется в node. |
| `src/worker-bootstrap.ts` | Общая обвязка `worker-main` над реальным `self`; используется `worker.ts` и `worker-stub.ts`, чтобы не дублировать `postMessage`/`onmessage`. |
| `src/worker.ts` | Реальный воркер: `@atl/sim-core`. |
| `src/worker-stub.ts` | Debug-воркер: `StubSimulation` вместо `@atl/sim-core` (только для `/?debug=worker`). |
| `src/create-worker.ts` | `createSimWorker()` / `createStubSimWorker()` — единственный способ создать настоящий `Worker`. Каждый — это ровно один инлайновый вызов `new Worker(new URL("./worker*.ts", import.meta.url), { type: "module" })`: и разбиение на `const url = new URL(...)`, и вызов из другого пакета (через `@atl/name` или тем более относительным путём через границу пакета) ломают статическое распознавание этого паттерна в Vite — в `vite dev` не заметно (файл читается напрямую с диска), а в `vite build` воркер тихо не стартует (сырой `.ts` инлайнится как `data:`-URL). |
| `src/client.ts` | `createSimClient({ createWorker, ... })`: промисы `init`/`runUntil`, подписки, автоматический `returnFrame`/`returnMetrics`, устойчив к исключениям в колбэках. |
| `src/stub-simulation.ts` | `createStubSimulation`: 500 точек по кругу, детерминированная функция от `simTimeS`. Подменяет `@atl/sim-core` до T-04. |
| `src/index.ts` | Публичный экспорт пакета. |

## Состояния воркера

`worker-main` — конечный автомат. `init` создаёт симуляцию и переводит в `ready`; `play`/`pause`
переключают `playing` ⇄ `paused`; `runUntil` — отдельный режим перемотки без пауз, который сам
возвращается в `paused` по достижении цели. Любое сообщение не по протоколу (например `play` до
`init`) отвечает `error {fatal: false}` и не меняет состояние. `dispose` — терминальное состояние:
дальнейшие сообщения игнорируются.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> ready: init (ok)
  idle --> disposed: init (ошибка конструктора, fatal)

  ready --> playing: play
  ready --> runningUntil: runUntil

  playing --> playing: play (новый speedFactor)
  playing --> paused: pause

  paused --> playing: play
  paused --> runningUntil: runUntil

  runningUntil --> paused: simTimeS >= target (шлёт paused)

  idle --> disposed: dispose
  ready --> disposed: dispose
  playing --> disposed: dispose
  paused --> disposed: dispose
  runningUntil --> disposed: dispose

  disposed --> [*]
```

Сообщение, не подходящее текущему состоянию (например `pause` вне `playing`), не меняет состояние
диаграммы — воркер остаётся там же и отвечает `error {fatal: false}`.

## Цикл `play`

Каждая итерация планируется через `setTimeout(fn, 0)` (в воркере нет `requestAnimationFrame`), и
именно поэтому это не блокирующий `while`-цикл: воркер обязан отдавать управление между итерациями,
иначе `pause`/`returnFrame`/`dispose` не будут обработаны. Шаги накапливаются через аккумулятор
(`accumulatorS += elapsedWallS * speedFactor`, конвертация в шаги по `dtS`), а не пересчётом
`floor(speedFactor * elapsedWall / dtS)` с нуля на каждый тик — так остаток времени, отрезанный
`maxStepsPerIteration` (по умолчанию 50), не теряется, а переносится на следующую итерацию.
При возобновлении после `pause` время простоя не накапливается (не даёт "рывка" вперёд).

`rtFactor` — EMA отношения фактически пройденного sim-времени к запрошенному (`speedFactor`) за
итерацию; 1 = воркер успевает. Кадр пишется в `writeFrame` и уходит `postMessage` с transfer только
если прошло `1000 / frameRateHz` мс с прошлой отправки **и** есть свободный буфер (иначе воркер
молча пропускает кадр и повторяет попытку на следующей итерации). Буфер отправителя после transfer
detached; переиспользовать его можно только после `returnFrame` тем же путём назад. Метрики и отчёт
не завязаны на `playing`/`runningUntil` — сэмплируются по `simTimeS`, поэтому продолжают идти и во
время перемотки `runUntil`.

**Для T-13 (рендер):** колбэк `onFrame` получает `ev.frame` только на время своего вызова — сразу
после возврата `client.ts` отправляет его назад в воркер с transfer, и типизированные массивы
detach'атся у получателя тоже. Рендер обязан **синхронно** скопировать нужные поля (`x`, `y`,
`heading`, ...) внутри самого колбэка; хранить `ev.frame` (или его массивы) между кадрами, в
замыкании или в состоянии компонента нельзя — к следующему кадру буфер уже не тот объект и не та
память.

## `RUNTIME_SAFE_PARAM_PATHS`

`setParams` разбирает патч на пути вида `"demand.multiplier"` и сравнивает с
`RUNTIME_SAFE_PARAM_PATHS` из `@atl/contracts`. Если хоть один задетый путь не входит в список —
патч целиком отклоняется, `sim.setParams` не вызывается, в ответ уходит `error {fatal: false}`.

## StubSimulation

`createStubSimulation` реализует интерфейс `Simulation`, но не читает `network`: 500 машин движутся
по окружности, позиция — чистая функция `simTimeS` (без интегрирования, без дрейфа). Нужна, чтобы
протокол воркера и будущий рендер (T-13) можно было тестировать/показывать до готовности реального
ядра (T-04). `worker-stub.ts` (свой воркер-энтрипоинт, см. выше) использует её вместо
`@atl/sim-core` — `apps/web/src/DebugWorkerView.tsx` (страница `/?debug=worker`) создаёт его через
`createStubSimWorker()`, чтобы показать движение точек живьём; страница временная и уйдёт вместе
с T-13.

## Тесты

`test/fake-worker.ts` — `Worker`-совместимая обвязка над `createWorkerMain`, соединённая с клиентом
настоящим `MessageChannel` (а не прямыми вызовами), чтобы протокол-тесты проверяли реальный
structured-clone/transfer (detach буферов), а не только логику стейт-машины. `test/protocol.test.ts`
гоняет сценарии протокола (init → ready, кадры за реальное время, буфер не шлётся без свободного,
`returnFrame` реально восстанавливает буфер, `setParams` отклоняет небезопасный путь, `runUntil` →
`progress` + `paused`, `dispose` после fatal-ошибки). `test/stub-simulation.test.ts` и
`test/param-guard.test.ts` — точечные unit-тесты соответствующих модулей.
