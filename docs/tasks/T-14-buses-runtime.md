# T-14. Автобусы, остановки, правила выделенки

**Пакет:** `packages/sim-core` · **Волна:** 3 · **Уровень:** M · **Размер:** ~800 строк · **Зависит от:** T-10, T-11 · **Разблокирует:** T-21, T-22

## Цель
Автобусы и троллейбусы по расписанию маршрутов, остановки «в полосе» и «в кармане» со стоянкой, часы действия
выделенки, такси, нарушители. Закрывает N14–N17.

## Контекст
`docs/ARCHITECTURE.md` («Автобусы и пешеходы», «Карманы и выделенки»); `packages/contracts/src/{network,sim-config,causes,state}.ts`
(`BusRoute`, `BusStop`, `BusLaneRule`, `BehaviorConfig`, `bus_dwell`, `behind_stopped_bus`, флаги `DWELLING`, `BUS_LANE_VIOLATOR`);
`docs/NUANCES.md` N14–N17; `straightRoad({busLane, busStop, busRoute})`, `crossroads({busLaneEW})`.

## Что сделать
1. `transit/schedule.ts`: для каждого маршрута спавн на `entryNodeId` каждые `headwayPeakS`/`headwayOffpeakS`
   (по `isPeakHour`) со случайным сдвигом первого автобуса; класс по `route.kind`; маршрут = фиксированная цепочка
   `linkIds` (не через OD), предпочтение полосы `bus`, иначе крайняя правая.
2. `transit/stops.ts`: по достижении `stop.s` на `stop.linkId` (в полосе `stop.laneId` или соседней справа) — стоянка
   `busDwellS` (×`busDwellPeakFactor` в пик), флаг `DWELLING`, причина `bus_dwell`; `in_lane` — автобус остаётся лидером
   в полосе (последователи получают причину `behind_stopped_bus`, если тормозят из-за него); `bay` — автобус исключается
   из списка полосы на время стоянки и возвращается с проверкой зазора (ждёт, если места нет).
3. Правила выделенки во времени: вне `[activeFromMin, activeToMin)` полоса `bus` считается общей; `taxisAllowedInBusLanes`;
   `BUS_LANE_VIOLATOR` для доли легковых при спавне (T-10 читает флаг). Нарушитель ведёт себя как обычная машина в выделенке.
4. Наполненность в статистике поездок: `occupancyPeak/Offpeak` класса по часу окончания поездки (для `tripStats` и T-18).
5. Тесты: N14 (ёмкость и время автобуса), N15 (окно правого поворота на `crossroads({busLaneEW: true})`), N16 (нарушители),
   N17 (`in_lane` vs `bay`), расписание даёт ожидаемое число автобусов за час; детерминизм.

## Файлы
`packages/sim-core/src/transit/{schedule,stops,rules}.ts`, правки `simulation.ts`, тесты `test/transit/*.test.ts`,
`test/nuances/04-buses.test.ts`.

## Критерии приёмки
- [x] N14–N17 зелёные; `pnpm check` зелёный.

## Вне объёма
Приоритет на светофорах, BRT по центру, импорт маршрутов из OSM (T-17).

## Заметки из ревью T-03 (учесть)
- См. заметку T-10 про правый поворот через выделенку в `crossroads({busLaneEW})`.

## Заметки от T-10 (учесть)
- `LaneRuntime.mayAdmit/admitsAt/busLaneActive` уже реализуют N15/N16 на уровне полос (часы действия выделенки,
  окно правого поворота, `BUS_LANE_VIOLATOR`, такси при `taxisAllowedInBusLanes`); есть тесты в
  `packages/sim-core/test/lanes/bus-lane-access.test.ts`. Остаётся сторона автобусов: времена поездки, остановки.
- Фикстуру для N14 стройте на `straightRoad`, а не на `crossroads({busLaneEW: true})`: там легковая с манёвром
  `through` не войдёт в выделенку, потому что её сквозной коннектор ведёт в автобусную полосу противоположного
  плеча. Это корректно, но для проверки самого правила доступа мешает.

## Заметки от T-11 (учесть)
- **`IntersectionRuntime.exitFreeM` не отличает стоящий автобус от затора.** Свободное место на полосе
  выхода считается как +∞, пока последняя машина полосы едет, и как `s − длина − trackStartS`, когда она
  стоит (`v ≤ metrics.stoppedSpeedMps`). Автобус на остановке в начале полосы выхода поэтому читается как
  «выезд заполнен»: дисциплинированные водители перестанут въезжать на перекрёсток (`downstream_spillback`),
  а пересекающие движения могут получить `gridlock`. Скорее всего надо исключить состояние `DWELLING` из
  `freeRoomOn` в `runtime/intersections.ts`.

## Заметки после ревью (интеграция T-14 в main)

Слито в `main` мержем `merge: T-14 bus schedule, stops and lane rules` (`--no-ff`, без конфликтов). `pnpm check`
зелёный без единой правки: typecheck/lint (biome)/determinism/тесты все прошли как есть — 520 passed, 12 todo
(числа совпадают с обновлением `docs/NUANCES.md` в самом коммите T-14). `packages/contracts` не тронут
(`git diff --stat main...origin/task/T-14 -- packages/contracts` пуст) — проверено перед слиянием.

Критерии приёмки проверены по коду, не только по отчёту исполнителя:
- N14–N17 — реальные проходящие тесты (не `it.todo`) в `test/nuances/04-buses.test.ts`, плюс модульные
  `test/transit/{schedule,stops}.test.ts`; прочитаны все и прослежены с рантайм-кодом (`BusScheduleRuntime`,
  `BusStopRuntime`, `computeAccelerations`, `IntersectionRuntime.freeRoomOn`).
- Заметка T-11 про `freeRoomOn`/`DWELLING` закрыта именно так, как предлагалось.
- `BusStopRuntime.tryEndDwell` (`bay`) воспроизводит тот же tail-to-head поиск лидера/последователя, что и
  `VehiclePool.insert`, так что проверка зазора перед возвратом в полосу консистентна с тем, как машина
  реально будет вставлена — не отдельная, потенциально рассинхронизированная эвристика.
- Сброс transit-полей (`busRoute`, `busRouteLinkIdx`, `busStopIdx`, `dwellEndS`) при переиспользовании слота
  проверен в обоих местах спавна (`place()` для машин, `placeBus()` для автобусов); `persistentFlags`
  перезаписывается целиком (не через OR), так что `DWELLING` не может пережить переиспользование слота.

Не блокирующее наблюдение (не дефект, править не стал): `pool.occupancy[i] = occupancy;` в `despawn()`
(`simulation.ts`) пишет в поле, которое больше нигде не читается — ни `writeFrame`, ни `tripStats` его не
используют, для `personDelayByClass` в той же строке ниже используется локальная переменная `occupancy`, а не
`pool.occupancy[i]`. Мёртвая, но безвредная запись (слот сразу после этого освобождается).

Заметки исполнителя для последующих задач перенесены в соответствующие карточки: T-15 (свободный RNG-форк),
T-17 (выделенка не удерживается на промежуточных линках маршрута), T-18/T-19/T-22 (occupancy/personDelayS
считается по часу окончания поездки, а не появления — влияет на калибровку допусков, в частности N23).

## Повторная выдача задачи (2026-09-08)

Окно на T-14 было выдано второй раз, уже после слияния (`5ae1cff` + `8155af7` + постревью `b8640e7`) и
после того, как `docs/PLAN.md` был исправлен из-за того же случая с T-11 (`21417e3`) — тот же день видел
и повторную (пустую) выдачу T-12 (`f20d41b`). Код не трогал, `git worktree add ... origin/main`,
`task/T-14` совпадает с `origin/main` (`git diff origin/main --stat` пуст), поэтому мерж снова будет
`Already up to date`.

Приёмка перепроверена по коду, а не по прошлому отчёту:
- `pnpm check` зелёный: typecheck по 5 пакетам, `biome check .` — 217 файлов без замечаний, determinism ok,
  vitest — 63 файла passed / 1 skipped (`test/routing/performance.test.ts`, не относится к T-14), 520
  passed / 12 todo — числа совпадают с записанными в предыдущем разделе этой карточки.
- N14–N17 — настоящие `it` (не `it.todo`) в `test/nuances/04-buses.test.ts:15,40,88,157,201`, плюс
  модульные `test/transit/schedule.test.ts` и `test/transit/stops.test.ts`; `docs/NUANCES.md` отмечает
  все четыре как «зелёный» за T-14.
- Файлы карточки на месте: `src/transit/{schedule,stops,rules}.ts`, README пакета описывает их в разделе
  «`transit/*`: расписание автобусов, остановки (T-14)».
- Заметка T-11 про `freeRoomOn`/`DWELLING` закрыта: `runtime/intersections.ts` пропускает лидера с флагом
  `VehicleFlag.DWELLING` при расчёте свободного места на выходе.
- `packages/contracts` не тронут (`git diff origin/main --stat -- packages/contracts` пуст).

Задача закрыта повторно без изменений в коде.
