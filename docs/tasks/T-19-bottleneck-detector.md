# T-19. Детектор узких мест, объяснение, рекомендации

**Пакет:** `packages/sim-core` · **Волна:** 4 · **Уровень:** S · **Размер:** ~800 строк · **Зависит от:** T-18 · **Разблокирует:** T-20, T-25, T-26

## Цель
Реализовать `report()`: найти узкие места по трём условиям, ранжировать по задержке, собрать объяснение из долей
корневых причин и рекомендации с готовыми overrides. Закрывает N22, N23 и первую проверку N24.

## Контекст
`docs/ARCHITECTURE.md` («Метрики и детектор»); `packages/contracts/src/metrics.ts` (`BottleneckItem`, `Recommendation*`,
`losFromVc`); `docs/DECISIONS.md` D11; `describeApproach` из T-07 (в sim-core недоступен: сим-ядро получает имена узлов
из `Network.nodes[].name` и направления считает сам по геометрии подхода: запад/восток/север/юг по углу).

## Что сделать
1. **Кандидаты.** Группы сегментов: «подход» = последние `min(6, все)` сегменты полос одного линка перед узлом,
   агрегированные по полосам (взвешенно по числу машин); «середина линка» = остальные сегменты линка. Для каждой группы
   за окно: `speedRatio`, `congestedShare`, `queueM` (макс по полосам), `delayVehH/PersonH` (сумма), `vcRatio` (макс).
2. **Условия.** `speedRatio < speedRatioMax`, `congestedShare ≥ minPersistence`, `queueM ≥ minQueueM`, и следующий по потоку
   участок (сегменты линков-выходов через коннекторы с наибольшим потоком) имеет `speedRatio ≥ downstreamSpeedRatioMin`.
   Исключение: если выход ведёт на ворота (ничего дальше нет), условие «ниже свободнее» считается выполненным.
3. **Ранжирование** по `delayVehH` (переключатель на person в конфиге отчёта — параметр `report({by: "person"})`?
   Интерфейс `report()` без аргументов: считать оба, `rank` по машинам; UI пересортирует по людям сам).
4. **Объяснение.** `causes` = нормированные доли `causeShare` по группе, только `DELAY_CAUSE_KEYS`, топ-5.
   `title` = `${node.name}, подход с ${направление}` или `${link.name}, участок`. `focus` = координата стоп-линии.
   `id` стабильный: `${linkId}:${nodeId ?? "mid"}`.
5. **Рекомендации** таблицей «доминирующая причина → сценарий» с готовыми overrides:
   `gap_left_turn` → `add_left_arrow` (`signal.leftTurnModes[link] = protected`) и `prohibit_left_turn`;
   `pocket_spillback` → `extend_left_pocket` (+60 м) ; `signal_red` при V/C > 0.9 → `rebalance_green` (+10 с группе подхода);
   `arrow_off` → `rebalance_green` стрелке; `behind_stopped_bus` → `bus_stop_bay`; `pedestrian_yield` → `rebalance_green`;
   `gridlock` → `discipline_enforcement` (params `gridlockDiscipline: 1`, без overrides); `merge_yield` → `ramp_metering` (только label);
   `downstream_spillback` → `none` с подписью «причина ниже по потоку: см. #N» (ссылка на другой элемент отчёта);
   на выделенке с низкой загрузкой автобусов при `signal_red` → `bus_lane_hours`. Не более 3 рекомендаций.
6. `totals` из T-18; `items` до `topN`.
7. Тесты: N22 (`multiplier` 0.5 vs 1.5), N23 (сценарий выделенки: person-delay ниже при vehicle-delay выше — фикстура
   `straightRoad` с частыми автобусами и насыщением легковых), N24 первая проверка (`crossroads({leftPocketM: 40})` с высоким
   левым спросом → топ-1 подход с доминирующей `pocket_spillback`; `crossroads({leftPocketM: 0, permissive})` → `gap_left_turn`);
   стабильность `id` между двумя отчётами; рекомендации содержат валидные overrides (парсятся `NetworkOverrideSchema`).

## Файлы
`packages/sim-core/src/detector/{candidates,rank,explain,recommend,report}.ts`, тесты, `test/nuances/06-…` (N22), `07-…` (N23, N24).

## Критерии приёмки
- [ ] N22, N23, первая проверка N24 зелёные; `pnpm check` зелёный; отчёт на 20 000 машин < 20 мс.

## Заметки от T-14 (учесть)
- **N23 стоит перепроверять на реальном прогоне.** С T-14 `occupancy`/`personDelayS` считается по часу окончания
  поездки, а не появления (`SimulationImpl.despawn()`, `simulation.ts`) — см. заметку T-14 в карточке T-18. Это
  может сдвинуть числа в сценарии N23 (выделенка с частыми автобусами: person-delay ниже при vehicle-delay выше)
  относительно допусков, продуманных до этого изменения.
