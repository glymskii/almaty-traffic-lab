# T-20. Headless CLI, регрессия, бенчмарк

**Пакет:** `packages/sim-core` · **Волна:** 4 · **Уровень:** C · **Размер:** ~500 строк · **Зависит от:** T-18, T-19 · **Разблокирует:** T-22, T-28, T-29

## Цель
`pnpm sim --network <file> --minutes 10 --seed 1 [--scenario <file>] [--json <out>] [--bench]` прокручивает
симуляцию без браузера, печатает `totals` и Топ-N с причинами, пишет `RunSummary`; режим регрессии сравнивает с эталоном.

## Контекст
`packages/sim-core/src/cli.ts` (заглушка, помечена `allow-wall-clock`); `packages/contracts/src/metrics.ts` (`RunSummary`);
`packages/contracts/src/overrides.ts` (`Scenario`); `data/README.md` (`golden/`).

## Что сделать
1. Аргументы: `--network` (gz или json), `--bbox small|big` как синоним `data/networks/<id>.network.json.gz`, `--minutes`,
   `--seed`, `--start HH:MM`, `--scenario` (JSON `Scenario`: params применяются, overrides применяются через `@atl/map-data`
   `applyOverrides`, если он реализован, иначе ошибка), `--json`, `--bench` (печатает шаги/с и среднее число машин по
   3 прогонам), `--quiet`.
2. Вывод: таблица `totals`, затем Топ-N: ранг, title, задержка (маш-ч / чел-ч), LOS, V/C, причины в процентах,
   рекомендации одной строкой. Прогресс прогрева в stderr.
3. `RunSummary` с `trajectoryHash` и `perf`.
4. Регрессия: `pnpm sim:regress` = прогон эталонных конфигураций из `data/golden/*.json` (сеть, сид, минуты) и сравнение
   `totals` (допуск 5%) и `top[0..2].id` (точно); `trajectoryHash` сравнивается только при флаге `--strict`. Эталоны
   создаются `pnpm sim:golden`. Первый эталон: маленький квадрат, если сеть скомпилирована, иначе `crossroads` синтетика
   (сериализованная в `data/golden/crossroads.network.json`).
5. Vitest-тест, запускающий CLI на синтетической сети 2 минуты и проверяющий формат `RunSummary` (через `child_process`
   с `node src/cli.ts`, таймаут 60 с).

## Файлы
`packages/sim-core/src/cli.ts`, `src/cli/{args,print,regress}.ts`, скрипты в `package.json`, `data/golden/`.

## Критерии приёмки
- [ ] CLI печатает отчёт на синтетике и на маленьком квадрате; `pnpm sim:regress` зелёный; `pnpm check` зелёный.

## Заметки от T-18 (учесть)
- `report().totals` — настоящие: `congestedSegmentShare` — доля сегментов в LOS E/F по оконному V/C,
  `meanSpeedKph`/`carMeanSpeedKph`/`busMeanSpeedKph` — по поездкам, завершившимся в окне (расстояние/время).
- **`meanSpeedKph` смещена вверх в заторе**: застрявшие и не доехавшие машины в среднюю не попадают, её
  считают те, кто как раз проехал. В сводке раннера показывайте рядом `stoppedShare` и
  `congestedSegmentShare` — они в заторе честные.
- Класс без завершённых поездок в окне (автобусы на коротком прогоне) отдаёт мгновенную среднюю скорость
  своих активных машин, а не ноль. На прогонах короче окна это не «средняя за окно».

## Заметки от T-19 (интеграция детектора в main, учесть)
- **`report().items` теперь настоящие** — `RunSummary.top` можно заполнять прямо из них: у элемента есть
  `rank`, `id`, `title`, `delayVehH`/`delayPersonH`, `causes` и `recommendations`.
- **Что класть в эталон регрессии.** `items` детерминированы при равных (сеть, конфиг, сид): ничьи по
  задержке разводятся по `id`, порядок повторяем. Но `delayVehH` оконные и пилят ±6 % с периодом
  `windowS / 8` (заметка T-18), поэтому в golden-файл клади `id` + `rank` + доминирующую причину,
  а не сами числа; иначе регрессия будет краснеть от момента вызова `report()`, а не от изменений кода.
- **Бюджет.** Один `report()` на 32 000 сегментов и 20 000 машин — 13,2 мс на M-серии, из них 12,6 мс
  это `MetricsAccumulators.write`. Если CLI зовёт отчёт в цикле по минутам прогона, это заметная доля
  времени: зови его только на тех отсечках, которые действительно попадут в `RunSummary`.
