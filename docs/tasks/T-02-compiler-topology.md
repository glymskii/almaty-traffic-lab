# T-02. Компилятор, часть 1: топология, полосы, скорости, происхождение

**Пакет:** `packages/map-data` · **Волна:** 1 · **Уровень:** S · **Размер:** ~1200 строк · **Зависит от:** T-01 (снимок; для тестов хватает ручной фикстуры) · **Разблокирует:** T-07, T-27, T-29

## Цель
Из `OsmSnapshot` построить направленный граф `Network` с узлами, линками и полосами: реальная геометрия и теги
OSM плюс генератор допущений для всего, чего нет, с честной пометкой `provenance`. Коннекторы, светофоры,
маршруты и здания добавят следующие задачи; эта задача оставляет `connectors: []`.

## Контекст
`CLAUDE.md`; `docs/CONTRACTS.md` (координаты, id, provenance, конвенция полос); `docs/ARCHITECTURE.md` (сеть в рантайме);
`packages/contracts/src/network.ts`, `integrity.ts`; `packages/map-data/src/{projection,bboxes}.ts`;
`packages/map-data/src/compiler/index.ts` (сигнатуры `compileNetwork`, `CompileReport`).
Покрытие тегов в тестовом квадрате: `lanes` 93%, `maxspeed` 55%, `turn:lanes` 14%, `busway`/`bus:lanes`/`psv:lanes`
на Абая и Тимирязева, `lanes:forward/backward` ~40%.

## Контракты
Реализует `compileNetwork` до стадии «топология + полосы» (остальные стадии вызываются, если модули существуют,
иначе пропускаются с предупреждением). Не меняет `contracts`.

## Что сделать
1. **Отбор и разрезание.** Взять way с классами из `HighwayClassSchema` (кроме `service`), обрезать по bbox
   (пересечение с границей создаёт узел `kind: gate`), разрезать на узлах, где сходятся ≥ 2 way, и на узлах
   с `highway=traffic_signals`. Узлы степени 2 склеивать в один линк (геометрия полилинией, упрощение
   Дугласа–Пекера 0,5 м), кроме мест смены имени/класса/числа полос.
2. **Узлы.** `signalized` при теге `traffic_signals` на узле (или в пределах 15 м на этой же улице, схлопывать
   дубли `traffic_signals:direction`), `junction` при степени ≥ 3, `dead_end` при степени 1 внутри bbox,
   `gate` на границе, `bend` для оставленных промежуточных. Имя узла: «A × B» по именам линков (кириллица, как в OSM `name`, при наличии `name:ru` предпочесть его).
3. **Линки.** По одному на направление (`oneway=yes|-1` учитывать; `junction=roundabout` ⇒ oneway). Геометрия
   каждого направления = осевая линия way, смещённая вправо на половину ширины своей проезжей части
   (число полос направления × 3,5 / 2), чтобы встречные линки не совпадали; для oneway без смещения.
   `lengthM` = длина геометрии. `layer`/`bridge`/`tunnel` сохранять в provenance-соседнем поле? Нет: сохранить как
   часть `id`-независимого маппинга в отчёте; пересечения линков с разным `layer` не являются узлами (важно для T-07): узел
   создаётся только если way реально делят OSM-узел.
4. **Число полос.** `lanes:forward`/`lanes:backward` → напрямую; иначе `lanes` (для двусторонних делить пополам,
   нечётное — большая половина в направлении forward); иначе дефолт по классу на направление:
   trunk 3, primary 3, secondary 2, tertiary 2, residential 1, unclassified 1, living_street 1 (`provenance: default`).
5. **Скорость.** `maxspeed` (число, `RU:urban`=60) иначе дефолт: trunk 80, primary/secondary/tertiary 60, residential 40,
   living_street 20 (`default`).
6. **Полосы и повороты.** `turn:lanes`(`:forward`/`:backward`) → `turns` по полосам (`left;through` → `["left","through"]`,
   `slight_*`/`merge_*` → ближайшее из TurnKind, `none`/пусто → through). Без тега — правило по числу полос:
   1 полоса `[left, through, right]`; 2 `[left, through] [through, right]`; ≥ 3 `[left, through] [through]… [through, right]`
   (`default`). **Левый карман:** если крайняя левая по `turn:lanes` только `left` — сделать её `turn_pocket`
   со `startS = lengthM − 80` (или 40% длины, если линк короче 200 м) и `provenance.startS: default`; если тега нет,
   на подходах к `signalized` узлу с ≥ 2 полосами класса ≥ secondary и длиной ≥ 120 м добавить карман 60 м (`default`).
7. **Выделенки.** `busway=lane`, `busway:right=lane`, `lanes:bus`/`lanes:psv`, `bus:lanes`/`psv:lanes` с `designated`
   на крайней правой → крайняя правая полоса `kind: bus`, `allowed: [bus, trolleybus]`, `busLane` c дефолтными
   часами 0..1440 (`default`) и `carsMayEnterForRightTurnWithinM: 50`. `bus:lanes` с `designated` в другой позиции —
   предупреждение и трактовка как крайняя правая.
8. **Отчёт допущений** `CompileReport.assumptions`: сгруппированные счётчики по видам (скорость, полосы, повороты,
   карманы, выделенки) с примером линка. `warnings` для неразобранных тегов.
9. Запись `data/networks/<bboxId>.network.json.gz` и `<bboxId>.assumptions.json`; `meta.generatedAt` фиксируется
   опцией для воспроизводимости; `sourceHash` = sha256 снимка.
10. Детерминизм: одинаковый снимок ⇒ байт-в-байт одинаковый вывод (стабильные сортировки, id из OSM id).

## Файлы
`packages/map-data/src/compiler/{osm-graph,topology,lanes,speeds,assumptions,write,index}.ts`,
`packages/map-data/test/compiler/*.test.ts`, фикстура `test/fixtures/mini-osm.json` (крест из двух улиц:
одна двусторонняя с `lanes=4`, `turn:lanes:forward=left|through`, одна oneway с `busway=lane` и `maxspeed=40`,
плюс way, выходящий за bbox).

## Критерии приёмки
- [ ] На мини-фикстуре: ожидаемое число узлов/линков/полос, карман создан, выделенка распознана, ворота на границе, provenance расставлен.
- [ ] `parseNetwork` + `checkNetworkIntegrity` без ошибок на фикстуре и (если снимок есть) на маленьком квадрате.
- [ ] Детерминизм: два прогона дают одинаковый gz-распакованный JSON.
- [ ] На маленьком квадрате отчёт допущений печатается, доля `default` по скоростям ≈ 45%.
- [ ] `pnpm check` зелёный.

## Вне объёма
Коннекторы, конфликты, зебры, ворота как сущности спроса (T-07); планы светофоров (T-08); ОТ (T-17); здания (T-27).

## DoD
`pnpm check`; критерии; README пакета описывает стадии компилятора и правила дефолтов; отчёт по шаблону.

## Заметки после ревью волны 1
- Критерий «доля default по скоростям ≈ 45%» заменён на диапазон 30–90%: на реальном снимке `maxspeed` есть у 34% way, доля default по линкам ≈ 66%.
- Радиус схлопывания светофоров в перекрёсток принят 30 м (решение D17).
