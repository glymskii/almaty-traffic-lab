# T-06. Протокол воркера и клиент

**Пакет:** `packages/sim-worker` · **Волна:** 1 · **Уровень:** M · **Размер:** ~700 строк · **Зависит от:** — (T-04 подключается фабрикой) · **Разблокирует:** T-13, T-23, T-26

## Цель
Реализовать `worker.ts` и `createSimClient` по `packages/contracts/src/protocol.ts`: цикл симуляции в воркере,
пинг-понг кадров, метрики и отчёты, безопасные параметры, обработка ошибок. До появления T-04 работает с
заглушкой `StubSimulation` (точки, летящие по прямой), чтобы T-13 мог рисовать движение.

## Контекст
`CLAUDE.md`; `docs/CONTRACTS.md` («Буферы кадра», «Протокол воркера» с диаграммой); `docs/ARCHITECTURE.md`
(«Воркер и буферы»); `packages/contracts/src/{protocol,state,metrics}.ts`; `packages/sim-core/src/simulation.ts`.

## Контракты
Реализует протокол один в один. Не меняет `contracts`. Фабрика симуляции передаётся при создании воркера
(`createWorkerMain({ createSimulation })`), по умолчанию из `@atl/sim-core`.

## Что сделать
1. `worker-main.ts`: чистая функция, принимающая `post`/`onMessage` (без глобального `self`), чтобы тестировать в node:
   состояние `idle → ready → playing/paused`; `init` создаёт симуляцию, выделяет `frameBufferCount` буферов,
   отвечает `ready` со `stats` из `sim.segments()/signalGroupIds()/crosswalkIds()`.
2. Цикл: `setTimeout(0)`-итерации (в воркере нет rAF): за итерацию делать `n = floor(speedFactor · elapsedWall / dtS)`
   шагов, не больше `maxStepsPerIteration` (по умолчанию 50); считать `rtFactor` как EMA достигнутого/запрошенного.
   Кадр отправлять не чаще `frameRateHz` и только при наличии свободного буфера; после `postMessage` буфер помечать
   занятым до `returnFrame`.
3. `runUntil`: шаги без пауз, `progress` каждые 2 симуляционные минуты, по достижении `paused`.
4. `metrics` раз в `config.metrics.sampleIntervalS` симуляционных секунд (два буфера метрик, пинг-понг через `returnMetrics`),
   `report` раз в `windowS` и по `requestReport`.
5. `setParams`: проверка путей по `RUNTIME_SAFE_PARAM_PATHS`, иначе `error {fatal: false}`.
6. `worker.ts`: тонкая обёртка над `self` для браузера. `client.ts`: `createSimClient` с подписками, промисами `init`/`runUntil`,
   автоматическим `returnFrame` после колбэков `onFrame`, `dispose` (terminate).
7. `stub-simulation.ts`: реализует `Simulation`, 500 точек по кругу/прямой, детерминированно; используется в тестах и в
   `apps/web` до T-04/T-13 (экспортировать `createStubSimulation`).
8. Тесты: гарнитура `FakeWorker` на `MessageChannel`; сценарии: init → ready; play даёт ≥ N кадров за время; кадр не
   отправляется без свободного буфера; `returnFrame` возвращает буферы (не detached); `setParams` отклоняет небезопасный путь;
   `runUntil` даёт `progress` и `paused`; `dispose` после ошибки `fatal`.

## Файлы
`packages/sim-worker/src/{worker,worker-main,client,stub-simulation,index}.ts`, `packages/sim-worker/test/*.test.ts`, README.

## Критерии приёмки
- [ ] Все сценарии протокола покрыты тестами в node без браузера.
- [ ] С `StubSimulation` в `apps/web` (временная страница или флаг) видно движение точек: описать в отчёте.
- [ ] `pnpm check` зелёный.

## Вне объёма
Рендер (T-13), UI (T-23), два воркера A/B (T-26).

## DoD
`pnpm check`; критерии; README с диаграммой состояний воркера; отчёт по шаблону.
