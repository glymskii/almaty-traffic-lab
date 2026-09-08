# @atl/web

Three.js-рендер полотна дорог и разметки по `Network` из `@atl/contracts`, плюс тонкая React-обвязка
(верхний бар, атрибуция ODbL, состояние загрузки). Ничего не считает про движение — это задача
`sim-core`/`sim-worker` (см. T-13, который добавит машины и светофоры поверх этой сцены).

## Структура сцены

```
src/
  geometry/lane-geometry.ts   чистая 2D-математика (без Three.js), проверяется юнит-тестами:
                              смещение полосы, offsetPolyline (стыки со скруглением угла),
                              sampleAtS/slicePolyline (точка и подотрезок по длине дуги)
  scene/
    ribbon.ts             THREE.BufferGeometry для ленты полосы, прямоугольника и треугольника
                           (используются для полотна, стрелок, стоп-линий, зебр); merge в одну
                           геометрию на класс поверхности
    roads.ts               полотно дорог: по одному Mesh на класс полосы (general/turn_pocket/bus),
                           цвет через vertex colors; полупрозрачная лента коннекторов
    markings.ts             штрих/сплошная разметка между полосами, стоп-линии перед узлами
                           signalized, зебры по crosswalks.geometry, стрелки поворотов по
                           lane.turns (последние 20 м полосы), буква «А» на выделенке
                           (canvas-текстура, повторяющиеся спрайты)
    labels.ts               CSS2DRenderer: подписи улиц trunk/primary/secondary в середине линка,
                           гаснут дальше VISIBLE_DISTANCE_M от камеры
    camera.ts               CameraRig поверх OrbitControls: overview(network), плавный
                           focus(x, y, radius), WASD-панорамирование, ограничение наклона
    renderer.ts             WebGLRenderer, PerspectiveCamera, полусферический + направленный
                           свет без теней, земля, resize (ResizeObserver), rAF-цикл (onFrame)
  data/
    demo-network.ts          T-образный перекрёсток, собранный вручную: левый карман, выделенка
                           с буквой, стоп-линия и зебры на signalized-узле, коннекторы через все
                           повороты. Используется, когда скомпилированной сети нет
    loadNetwork.ts            fetch('/networks/<id>.network.json.gz') + DecompressionStream,
                           иначе demo-network.ts
  Viewport.tsx                грузит сеть и монтирует сцену в контейнер (useEffect + cleanup)
  App.tsx                      верхний бар (название, атрибуция ODbL) + <Viewport />
  i18n/ru.ts                   все строки интерфейса
scripts/copy-networks.mjs      data/networks/*.gz -> public/networks/ (predev/prebuild)
```

## Как подложить свою сеть

1. Сгенерируй `data/networks/<bboxId>.network.json.gz` компилятором (`pnpm compile --bbox <id>`, T-02).
2. `pnpm dev`/`pnpm build` сами копируют `data/networks/*.gz` в `apps/web/public/networks/`
   через `predev`/`prebuild` (`scripts/copy-networks.mjs`). Ничего вручную копировать не нужно.
3. `loadNetwork(networkId = "small")` в `src/data/loadNetwork.ts` подставляет `bboxId` в URL.
   Если файла нет (в т.ч. когда дев-сервер отвечает 200 с `index.html` вместо 404 — обычное
   поведение SPA-фолбэка) или сеть не прошла gzip-магию/`parseNetwork`, приложение показывает
   встроенную демо-сеть из `src/data/demo-network.ts`, чтобы разработка не блокировалась на T-02.

## Команды

```bash
pnpm --filter @atl/web dev      # то же, что pnpm dev из корня
pnpm --filter @atl/web build    # то же, что pnpm build из корня
pnpm --filter @atl/web test     # vitest, окружение node (без DOM)
```

## Вне объёма (T-05)

Машины, светофоры и их визуальное состояние — T-13. Тепловая карта — T-25. Здания/парки/реки — T-27.
UI-панели (HUD, редактор сценариев, A/B) — T-23/T-24/T-26.
