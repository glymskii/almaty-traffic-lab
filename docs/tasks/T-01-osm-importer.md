# T-01. Импортёр OSM плитками

**Пакет:** `packages/map-data` · **Волна:** 1 · **Уровень:** C · **Размер:** ~400 строк · **Зависит от:** — · **Разблокирует:** T-02, T-17, T-27, T-29

## Цель
`pnpm import --bbox small|big` скачивает данные OSM для полигона через Overpass плитками, с повторами и зеркалами,
и сохраняет воспроизводимый снимок в `data/osm/<bboxId>/`. Приложение и тесты никогда не ходят в сеть.

## Контекст
`CLAUDE.md`; `packages/map-data/src/bboxes.ts` (пресеты, `tilesPerSide`); `packages/map-data/src/importer/index.ts`
(сигнатуры `importOsm`, `OsmSnapshot`, `OsmElement`); `data/README.md`. Overpass главный сервер иногда отвечает
HTML-страницей с таймаутом; зеркало `https://overpass.kumi.systems/api/interpreter` в наших проверках справлялось.

## Контракты
Реализует `importOsm(opts): Promise<OsmSnapshot>` как объявлено. Ничего в `contracts` не трогает.

## Что сделать
1. `tiles.ts`: разбиение bbox на `tilesPerSide × tilesPerSide` плиток с перекрытием 0,0005°; чистая функция с тестом.
2. `queries.ts`: генераторы текста Overpass QL по слоям, каждый слой отдельным запросом на плитку:
   - `roads`: `way[highway~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street)$"]` с `out geom` (нужны координаты узлов и `nodes`), плюс `node[highway~"^(traffic_signals|crossing|stop|give_way)$"]`;
   - `transit`: `relation[type=route][route~"^(bus|trolleybus)$"]` с `out body`, `node[highway=bus_stop]`, `node[public_transport=platform][bus=yes]`;
   - `pois`: `node|way` с `shop=mall`, `amenity~"^(university|college|hospital|theatre|cinema)$"`, `leisure=stadium`, `office`, `railway=station`, `public_transport=station` (`out center`);
   - `buildings`: `way[building]` и `relation[building][type=multipolygon]` с `out geom`;
   - `landuse`: `way|relation` с `leisure=park`, `natural=water`, `landuse=grass`, `waterway~"^(river|stream|canal)$"` с `out geom`.
   Таймаут в запросе `[timeout:180]`, формат `[out:json]`. Снапшот-тест на текст запросов.
3. `fetch.ts`: POST на список зеркал по очереди (`overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`),
   до 3 попыток на зеркало с экспоненциальной паузой, проверка, что ответ JSON с полем `elements`; иначе следующая попытка.
   Пауза 2 с между плитками, чтобы не ловить 429.
4. Кэш: плитка `data/osm/<bboxId>/tiles/<r>-<c>.<layer>.json.gz`; при `useCache` не перекачивать. `--refresh` в CLI сбрасывает кэш.
5. `merge.ts`: склейка всех плиток и слоёв, дедупликация по `(type, id)`, стабильная сортировка по типу и id,
   запись `snapshot.json.gz` c `fetchedAt` и `osmTimestamp` (из `osm3s.timestamp_osm_base`).
6. CLI `src/cli/import.ts` уже вызывает `importOsm`; допилить вывод статистики: элементов по типам, размер файла.
7. Выполнить `pnpm import --bbox small` и закоммитить снимок. Выполнить `pnpm import --bbox big`; если суммарный размер
   `data/osm/almaty-center-big` больше 60 МБ, не коммитить, а описать в отчёте (владелец решит про LFS).

## Файлы
`packages/map-data/src/importer/{tiles,queries,fetch,merge,index}.ts`, `packages/map-data/test/importer/*.test.ts`
с JSON-фикстурами двух перекрывающихся плиток, `packages/map-data/README.md`.

## Критерии приёмки
- [ ] Тесты: разбиение на плитки, текст запросов, склейка с дедупликацией, gz-раундтрип. Без сети.
- [ ] `pnpm import --bbox small` создаёт `snapshot.json.gz`, повторный запуск использует кэш и даёт байт-в-байт тот же снимок.
- [ ] Снимок маленького квадрата закоммичен, в нём ≥ 500 way с `highway`, ≥ 90 узлов `traffic_signals`, ≥ 30 отношений маршрутов.
- [ ] `pnpm check` зелёный.

## Вне объёма
Разбор тегов, проекция, построение графа (T-02). Здания/парки используются только в T-27, но качаются здесь.

## DoD
`pnpm check`; критерии выше; README пакета описывает слои, кэш и зеркала; отчёт по шаблону `CLAUDE.md`.
