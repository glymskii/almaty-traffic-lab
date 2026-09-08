# @atl/map-data

Импорт OSM-данных (тайловые запросы к Overpass) и компилятор OSM → `Network` с генератором допущений
и provenance. Node-скрипты, детерминированный вывод, без ручных данных.

## Импортёр (`src/importer/`)

`pnpm import --bbox small|big` — тайловый импорт данных Overpass для пресета bbox
(`src/bboxes.ts`) в `data/osm/<bboxId>/`. Приложение и тесты в сеть не ходят: единственный
вход дальше по пайплайну — закоммиченный `snapshot.json.gz`.

> Важно: `import` — зарезервированное имя команды в самом pnpm (`pnpm import` генерирует
> `pnpm-lock.yaml` из чужого лок-файла), поэтому короткая форма `pnpm import ...` не доходит
> до нашего скрипта. Явная форма всегда работает: `pnpm run import --bbox small` из корня,
> или `pnpm --filter @atl/map-data run import --bbox small`.

### Слои

Каждая плитка запрашивается пятью независимыми Overpass-запросами (`src/importer/queries.ts`):

| Слой | Что берём | `out` |
|---|---|---|
| `roads` | `way[highway]` нужных классов + узлы `traffic_signals\|crossing\|stop\|give_way` | `geom` |
| `transit` | `relation[type=route]` (bus/trolleybus) + `bus_stop` + `platform[bus=yes]` | `body` |
| `pois` | торговые центры, вузы/больницы/театры/кино, стадионы, офисы, вокзалы/станции | `center` |
| `buildings` | `way[building]` и `relation[building][type=multipolygon]` | `geom` |
| `landuse` | парки, вода, газоны, реки/ручьи/каналы | `geom` |

Здания и landuse качаются в T-01, но используются только в T-27 (городские слои сцены).

### Плитки и склейка

`tiles.ts` делит bbox на `tilesPerSide × tilesPerSide` плиток (пресет `tilesPerSide` — в
`bboxes.ts`) с перекрытием `TILE_OVERLAP_DEG = 0.0005°` на каждую сторону, чтобы объект,
пересекающий границу плитки, целиком попал хотя бы в одну из них.

`merge.ts` склеивает элементы всех плиток и слоёв, дедуплицирует по `(type, id)` (побеждает
первое вхождение), стабильно сортирует по типу (`node < way < relation`), затем по `id`.
`fetchedAt`/`osmTimestamp` берутся из ответа первой плитки — это и делает повторный
кэшированный запуск побайтово идентичным предыдущему снимку.

### Кэш и сеть

`fetch.ts` шлёт POST на зеркала Overpass по очереди (`overpass-api.de`, `overpass.kumi.systems`,
`overpass.private.coffee`), до 3 попыток на зеркало с экспоненциальной паузой (2с, 4с), затем
переход к следующему зеркалу. Ответ, который не парсится как JSON с полем `elements`
(главный сервер иногда отдаёт HTML-страницу таймаута вместо JSON), считается неудачей.

Каждая пара плитка+слой кэшируется в `data/osm/<bboxId>/tiles/<row>-<col>.<layer>.json.gz`.
При `useCache: true` (по умолчанию, флаг CLI `--refresh` его отключает) уже скачанные плитки не
перекачиваются. Пауза 2 секунды выдерживается между плитками (не между 5 слоями одной плитки),
чтобы не словить 429 от зеркала.

Итоговый снимок пишется в `data/osm/<bboxId>/snapshot.json.gz` — см. `data/README.md`.

## Компилятор (`src/compiler/`)

`compileNetwork` (OSM snapshot → `Network`) и `applyOverrides` — заглушки, реализуются в T-02+.

## Тесты

`test/importer/*.test.ts`: разбиение на плитки, снапшот-тест текста запросов, дедупликация
слияния (фикстуры `test/importer/fixtures/tile-{a,b}.roads.json` — две перекрывающиеся плитки),
gzip round-trip и побайтовая стабильность сжатия, ретраи/фолбэк на зеркала `fetchOverpassQuery`
(сеть замокана через `fetchImpl`/`sleep`). Сети в тестах нет.
