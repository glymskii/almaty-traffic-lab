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
