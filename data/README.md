# Данные

- `osm/<bboxId>/tiles/*.json.gz` — сырые ответы Overpass по плиткам (T-01).
- `osm/<bboxId>/snapshot.json.gz` — склеенный и дедуплицированный снимок; единственный вход компилятора.
- `networks/<bboxId>.network.json.gz` — скомпилированная сеть (`Network`), плюс `<bboxId>.assumptions.json`
  с отчётом генератора допущений.
- `golden/` — эталонные `RunSummary` для регрессии (T-20).
- `runs/` — сохранённые прогоны конвейера: `<bboxId>-<минуты>min-seed<N>.txt` (вывод `compile` и `sim`
  как есть) и `.json` (`RunSummary`). Воспроизводятся `pnpm run compile --bbox <key>` +
  `pnpm sim --bbox <key> --minutes <N> --seed <N>`; сравнивать прогоны можно по `trajectoryHash`.

Пресеты bbox: `packages/map-data/src/bboxes.ts` (`small`, `big`). Несжатые `.json` в `osm/` игнорируются git.
Данные © OpenStreetMap contributors, ODbL. Снимок воспроизводим командой `pnpm run import --bbox <key> --refresh`.
