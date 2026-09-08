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
- [ ] N14–N17 зелёные; `pnpm check` зелёный.

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
