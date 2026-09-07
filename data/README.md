# Данные

- `osm/<bboxId>/tiles/*.json.gz` — сырые ответы Overpass по плиткам (T-01).
- `osm/<bboxId>/snapshot.json.gz` — склеенный и дедуплицированный снимок; единственный вход компилятора.
- `networks/<bboxId>.network.json.gz` — скомпилированная сеть (`Network`), плюс `<bboxId>.assumptions.json`
  с отчётом генератора допущений.
- `golden/` — эталонные `RunSummary` для регрессии (T-20).

Пресеты bbox: `packages/map-data/src/bboxes.ts` (`small`, `big`). Несжатые `.json` в `osm/` игнорируются git.
Данные © OpenStreetMap contributors, ODbL. Снимок воспроизводим командой `pnpm import --bbox <key> --refresh`.
