# @atl/map-data

Импорт OSM плитками (T-01) и компилятор OSM → `network.json` (T-02 и далее).

Импорт OSM-данных (тайловые запросы к Overpass) и компилятор OSM → `Network` с генератором допущений
и provenance. Node-скрипты, детерминированный вывод, без ручных данных.

## Импортёр (`src/importer/`)

`pnpm run import --bbox small|big` — тайловый импорт данных Overpass для пресета bbox
(`src/bboxes.ts`) в `data/osm/<bboxId>/`. Приложение и тесты в сеть не ходят: единственный
вход дальше по пайплайну — закоммиченный `snapshot.json.gz`.

> Важно: `import` — зарезервированное имя команды в самом pnpm (`pnpm run import` генерирует
> `pnpm-lock.yaml` из чужого лок-файла), поэтому короткая форма `pnpm run import ...` не доходит
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

---

Импорт OSM (снимок Overpass плитками) и компилятор `OsmSnapshot → Network` с генератором допущений
и происхождением атрибутов. Node-скрипты, детерминированный вывод. Контракты: `packages/contracts`,
пояснения: `docs/CONTRACTS.md`.

```bash
pnpm run import --bbox small|big [--refresh]      # OSM → data/osm/<bboxId>/snapshot.json.gz (T-01)
pnpm run compile --bbox small|big                 # snapshot → data/networks/<bboxId>.network.json.gz
pnpm run compile --bbox small --snapshot path.json.gz --out out.network.json.gz --generated-at 2026-01-01T00:00:00Z
```

Пресеты bbox: `src/bboxes.ts` (`small` — тестовый квадрат, `big` — весь центр). Проекция: `src/projection.ts`
(равнопромежуточная с `cos(lat0)`, x = восток, y = север, метры от центра bbox).

## Импортёр (T-01)

`src/importer/`: `importOsm(opts)` — слои, плитки, кэш и зеркала описаны в карточке `docs/tasks/T-01-osm-importer.md`.
Компилятор читает только `snapshot.json.gz` (`readSnapshotFile`), сеть никогда не ходит в сеть.
Снимок в форме Overpass `out geom`: way несут `nodes` и параллельный `geometry`; отдельные `node`-элементы
нужны только для тегированных узлов (светофоры, переходы, остановки).

## Компилятор (T-02: топология, полосы, скорости)

Точка входа `compileNetwork(opts): CompileReport` (`src/compiler/index.ts`). Стадии:

| Стадия | Модуль | Что делает |
|---|---|---|
| 1. Граф OSM | `osm-graph.ts` | Отбор way с `highway` из `HighwayClassSchema` кроме `service` (и кроме `area=yes`), разбор тегов в `WayAttrs`, проекция, отсечение по bbox: пересечение границы даёт вершину-ворота `ng<wayId>_<k>`; `oneway=-1` разворачивает порядок узлов |
| 2. Топология | `topology.ts` | Разрезание на концах way, в узлах, которые делят ≥ 2 way, на воротах и на `highway=traffic_signals`; схлопывание светофоров ближе 30 м (вдоль дороги; `SIGNAL_COLLAPSE_M`) к перекрёстку в этот перекрёсток; склейка узлов степени 2 при полном совпадении атрибутов; типы и имена узлов |
| 3. Линки и полосы | `links.ts`, `lanes.ts`, `speeds.ts` | По одному линку на направление, геометрия = осевая way, упрощённая Дугласом–Пекером 0,5 м и смещённая вправо на половину ширины своей проезжей части (`N · 3,5 / 2`; oneway без смещения); полосы, повороты, карманы, выделенки; provenance |
| 4. Поздние стадии | `stages.ts` | `intersections` (T-07), `signals` (T-08), `transit` (T-17), `city` (T-27), `overrides` (T-24): вызываются, если задача заполнила `run`, иначе пропуск с предупреждением. Пока `connectors: []` |
| 5. Проверка и запись | `index.ts`, `write.ts` | `parseNetwork` + `checkNetworkIntegrity` (ошибка = исключение); `writeCompileOutputs` пишет `<bboxId>.network.json.gz` и `<bboxId>.assumptions.json` |

`CompileReport`: `network`, `assumptions` (счётчики по видам с примером), `warnings` (уникальные строки),
`stats` (число сущностей, доли `default`), `linkLevels` (`layer`/`bridge`/`tunnel` по id линка; только не на земле).
Мосты и туннели не входят в `Network` (контракты заморожены), T-07 берёт их из отчёта; узел создаётся только там,
где way реально делят OSM-узел, поэтому пересечения на разных уровнях узлов не порождают.

### Узлы
Приоритет типов: `gate` (на границе bbox, в том числе OSM-узел ровно на границе) → `signalized` (тег на узле или
светофор в 30 м вдоль той же улицы, степень ≥ 2) → `junction` (степень ≥ 3) → `dead_end` (степень 1) → `bend`
(оставшиеся узлы степени 2: смена имени, класса, числа полос, скорости, уровня; светофор на тупике остаётся `dead_end`).
Имя: `name:ru`, иначе `name`; на перекрёстке «A × B» по именам линков, сначала старший класс, потом по алфавиту.
`provenance.kind = osm` у `signalized`; остальные типы структурные.

### Идентификаторы
Узлы `n<osmNodeId>`, ворота `ng<wayId>_<k>`; линки `w<wayId>_<seq>_<f|b>`, где `wayId` — наименьший id way
в склеенной цепочке, `seq` — порядковый номер вдоль этого way, `f` — направление порядка узлов этого way;
полосы `<linkId>:<index>`. Одинаковый снимок ⇒ одинаковые id и байт-в-байт одинаковый JSON и gzip
(`meta.generatedAt` фиксируется опцией, `sourceHash` = sha256 JSON снимка).

### Правила дефолтов (provenance `default`)

| Атрибут | Из OSM | Дефолт |
|---|---|---|
| Полос на направление | `lanes:forward/backward`; иначе `lanes` (oneway — все, либо минус устаревший `lanes:backward`; двусторонняя — минус явный тег другого направления, иначе по числу элементов `turn:lanes:<dir>`, иначе пополам, нечётное — большая половина в forward); иначе число элементов `turn:lanes` или `bus:lanes` | trunk 3, primary 3, secondary 2, tertiary 2, residential 1, unclassified 1, living_street 1, все `*_link` 1 |
| Скорость, км/ч | `maxspeed:<dir>`, `maxspeed`: число, `N mph`, `RU:urban`/`KZ:urban` = 60, `*:living_street` = 20, `*:rural` = 90, `walk` = 5; `none`/`signals` → предупреждение и дефолт | trunk 80, primary/secondary/tertiary 60, residential/unclassified 40, living_street 20, trunk_link 60, остальные `*_link` 40 |
| Повороты полос | `turn:lanes(:forward/backward)`: `slight_*`/`sharp_*` → `left`/`right`, `reverse` → `uturn`, `merge_to_*` → `merge`, `none`/пусто → `through`; число элементов должно совпадать с числом полос: на oneway при противоречии с `lanes` верим `turn:lanes` (предупреждение), на двусторонней тег игнорируется с предупреждением; `turn:lanes` без направления на двусторонней улице игнорируется | 1 полоса `[left, through, right]`; 2 — `[left, through] [through, right]`; ≥ 3 — `[left, through] [through]… [through, right]` |
| Левый карман | Крайняя левая по `turn:lanes` только `left` (и полос ≥ 2) ⇒ `turn_pocket`, `startS = L − 80` (при `L < 200` — `0,4·L`), `provenance.startS = default` | Без тега: подход к `signalized` узлу, ≥ 2 общих полос, класс trunk/primary/secondary, `L ≥ 120` ⇒ добавляется полоса-карман 60 м с `turns: [left]`, крайняя левая общая полоса теряет `left` |
| Выделенка | `bus:lanes`/`psv:lanes` с `designated` (не крайняя правая → предупреждение, моделируется как крайняя правая), `lanes:bus`/`lanes:psv` ≥ 1 (без направления на двусторонней улице — поровну на оба направления), `busway=lane|yes`, `busway:both`, `busway:right` (forward), `busway:left` (backward; на oneway — предупреждение). Крайняя правая: `kind: bus`, `allowed: [bus, trolleybus]`, `busLane.carsMayEnterForRightTurnWithinM: 50` | Часы `0..1440` (`busLaneHours: default`). Если число полос дефолтное или равно 1, выделенка добавляется сверху, а не забирает общую полосу |

Ширина полосы 3,5 м; `lengthM` = длина смещённой геометрии; координаты и длины округлены до сантиметра.

### Отчёт допущений
`assumptions[].kind` (счётчик — линки для атрибутов линка, полосы для атрибутов полосы; `example` — первый id):
`speed_limit_default`, `lane_count_default`, `turns_default`, `left_pocket_default` (карман по правилу подхода),
`pocket_length_default` (карман по тегу, длина по умолчанию), `bus_lane_hours_default`, `bus_lane_position_assumed`.
`warnings` — неразобранные или противоречивые теги (`way <id>: …`) и пропущенные стадии. Файл
`data/networks/<bboxId>.assumptions.json` содержит `stats`, `assumptions`, `warnings`, `linkLevels`.

### Тесты
`test/compiler/*.test.ts`; фикстура `test/fixtures/mini-osm.json` — крест «Проспект Абая» (двусторонняя, `lanes=4`,
`turn:lanes:forward=left|through`) × «Сейфуллина» (oneway, `busway=lane`, `maxspeed=40`, светофор в 10 м от
перекрёстка) плюс «Тимирязева» из двух склеиваемых way, уходящая за bbox. Тест на реальном снимке
`data/osm/almaty-abay-small/snapshot.json.gz` пропускается, пока файла нет. Снимки из локальных метров
собирает `test/compiler/helpers.ts` (`localSnapshot`).
