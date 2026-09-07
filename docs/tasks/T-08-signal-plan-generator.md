# T-08. Генератор планов светофоров

**Пакет:** `packages/map-data` · **Волна:** 2 · **Уровень:** S · **Размер:** ~900 строк · **Зависит от:** T-03, T-07 · **Разблокирует:** T-24, T-29

## Цель
Для каждого узла `signalized` построить `SignalController`: сигнальные группы по манёврам (с доп. секциями),
пешеходные группы, фазы и длительности по методу Вебстера, типы левого поворота, назначить `signalGroupId`
и `protection` коннекторам. Плюс функция пересборки контроллера по overrides сценария (для T-24).

## Контекст
`docs/ARCHITECTURE.md` («Светофоры»); `docs/CONTRACTS.md`; `packages/contracts/src/{network,sim-config,overrides}.ts`
(`SignalTiming`, `SignalOverride`); T-03 (`test/fixtures/signals.ts` как образец плана на синтетике).

## Что сделать
1. `generateController(net, nodeId, cfg: SignalTiming, opts?)`:
   - подходы = входящие линки; для каждого: группа `main` (through + right + left, если режим permissive),
     группа `arrow_left` (если protected или protected_permissive), группа `arrow_right` не создавать (правый всегда в main).
   - **Тип левого поворота** по умолчанию: `protected`, если у подхода есть карман (`turn_pocket`) и встречный подход
     имеет ≥ 2 сквозных полосы; `permissive`, если кармана нет; `prohibited`, если левых коннекторов нет. Provenance `default`.
   - **Фазы:** группировка подходов по осям (угол между противоположными подходами > 150° → одна ось). Порядок:
     [ось1 защищённые левые] → [ось1 сквозные+правые] → [ось2 защищённые левые] → [ось2 сквозные+правые];
     на Т-образных и нестандартных узлах — по одной фазе на подход, если оси не выделяются.
   - **Пешеходные группы:** по зебре, зелёные вместе с параллельными сквозными движениями (не с защищёнными левыми);
     при `pedestrianPhase: false` группы не создаются, зебры без `signalGroupId`.
   - **Вебстер:** предполагаемый поток подхода `q = 400 веh/ч × число сквозных полос × коэффициент класса`
     (trunk 1.5, primary 1.2, secondary 1.0, tertiary 0.7, residential 0.4); критические отношения `y = q / (s·n)`,
     `s = saturationFlowVehPerHPerLane`; потерянное время `L = Σ(yellow + allRed)`; `C = (1.5L + 5) / (1 − Σy)`,
     обрезать в `[40, maxCycleS]`; зелёные пропорционально `y` с минимумом `minGreenS`; защищённым левым 10–15 с.
   - `offsetS = 0`, provenance `default` для phases/leftTurnModes.
   - Назначить `signalGroupId` и `protection` (`protected` — если все конфликты группы красные в её зелёных фазах,
     иначе `permissive`) всем коннекторам узла. Пешеходным зебрам — `signalGroupId`.
2. `regenerateController(net, nodeId, override: SignalOverride["set"], cfg)`: применяет `leftTurnModes`, `pedestrianPhase`,
   `cycleS` (масштабирует зелёные), `greenS` по группам, `offsetS`; результат снова проходит integrity.
3. Интеграция в `compileNetwork` как стадия после T-07; отчёт допущений: число контроллеров, распределение типов левого.
4. Тесты: на `crossroads` из T-03 с удалёнными контроллерами — план проходит integrity, есть стрелки при карманах;
   на `tJunction`; Вебстер на ручных числах; `regenerateController` с `leftTurnModes: protected` добавляет группу
   `arrow_left` и фазу; на маленьком квадрате все 93 узла получают контроллеры и integrity пустой.

## Файлы
`packages/map-data/src/signals/{groups,phases,webster,generate,regenerate}.ts`, тесты `test/signals/*.test.ts`.

## Критерии приёмки
- [ ] Маленький квадрат: 100% сигнализированных узлов с контроллерами, integrity пустой, циклы 40–120 с.
- [ ] Ни одна фаза не даёт зелёный двум конфликтующим `protected` группам (тест перебором фаз и конфликтов).
- [ ] `pnpm check` зелёный.

## Вне объёма
Координация смещений (только поле), адаптивное управление, рантайм (T-09).
