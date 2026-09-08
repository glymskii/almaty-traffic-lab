# @atl/web

Three.js-рендер полотна дорог и разметки по `Network` из `@atl/contracts`, инстансы машин/светофоров/
пешеходов по `FrameBuffers` из `@atl/sim-worker`, плюс тонкая React-обвязка (верхний бар, атрибуция
ODbL, состояние загрузки/прогрева). Сам ничего не считает про движение — только читает буферы кадров
и метрики (`sim-core`/`sim-worker`).

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
    interpolation.ts         чистая логика (без Three.js): FrameBuffers -> плавная поза машины.
                           Каждый id раскладывается в стабильный слот id % capacity (T-13:
                           id = slot + generation*capacity), слот хранит последние "from"/"to"
                           замеры; смена владельца слота (респавн) даёт мгновенный снап, а не лерп
                           через чужую позицию. lerpAngle — кратчайшая дуга; isBlinkOn — фаза
                           мигания (поворотники 2 Гц, мигающий зелёный светофора)
    vehicles.ts               InstancedMesh на деталь кузова (легковая: кузов+кабина, автобус/
                           троллейбус: кузов(+2 штанги), плюс стоп-сигнал и 2 поворотника на
                           машину), ёмкость = vehicleCapacity, индекс инстанса = id % capacity
                           (слот держит не больше одной машины разом). Неиспользуемые/пропавшие
                           инстансы скрываются масштабом 0, а не через mesh.count. Палитра легковых
                           (carColorFor) — 6 приглушённых цветов по id % 6, такси — жёлтый
    signals.ts                Столб + головка на сигнальную группу (позиция — конец первой полосы
                           группы, вправо на 2 м): основная секция — 3 лампы (инстансы сфер),
                           arrow_left/right — 1 лампа сбоку. Индекс группы для FrameBuffers.
                           signalStates считается по всем группам всех контроллеров по порядку
                           (включая пешеходные — они не рисуются, но не должны сбивать индексацию)
    pedestrians.ts            crosswalkPeds[i] точек (сферы r=0.3) вдоль geometry зебры i
  sim/
    client.ts                 SimClient из @atl/sim-worker: ?sim=stub — заглушка (T-06), иначе
                           реальное ядро; владеет interpolation-буфером и "дисплейными часами"
                           (реальное время -> симуляционное, не забегая вперёд последнего кадра);
                           отдаёт готовые сигналы/пешеходов без интерполяции (дискретное состояние).
                           sampleStressFrame/wantsStressMode — стресс-режим `?stress=1`
                           (докарточка T-13: 20 000 инстансов без воркера, для проверки FPS)
  data/
    demo-network.ts          T-образный перекрёсток, собранный вручную: левый карман, выделенка
                           с буквой, стоп-линия и зебры на signalized-узле, коннекторы через все
                           повороты. Используется, когда скомпилированной сети нет
    loadNetwork.ts            fetch('/networks/<id>.network.json.gz') + DecompressionStream,
                           иначе demo-network.ts
  Viewport.tsx                грузит сеть, монтирует сцену, запускает sim/client.ts (прогрев по
                           demand.warmupMinutes с прогресс-баром, затем play(1)) и на каждый
                           тик rAF обновляет vehicles/signals/pedestrians (useEffect + cleanup)
  App.tsx                      верхний бар (название, атрибуция ODbL) + <Viewport />
  i18n/ru.ts                   все строки интерфейса
scripts/copy-networks.mjs      data/networks/*.gz -> public/networks/ (predev/prebuild)
```

## Отладка и стресс-тест

- `?sim=stub` — воркер со `StubSimulation` (500 точек по окружности) вместо реального ядра
  `@atl/sim-core`; полезно, пока сигналы/пешеходы (T-09/T-15) не посчитаны реальным ядром
  (оно сейчас всегда отдаёт `OFF`/`0` — см. `packages/sim-core/src/simulation.ts`).
- `?stress=1` — рендерит 20 000 инстансов машин без воркера вообще (`sampleStressFrame` в
  `src/sim/client.ts`), для проверки FPS (критерий приёмки T-13).
- `KeyC` — переключает видимость ленты коннекторов (T-05, временно, до панели слоёв T-23).

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

## Вне объёма (T-13)

Тепловая карта — T-25. Здания/парки/реки — T-27. UI-панели (HUD, редактор сценариев, A/B) —
T-23/T-24/T-26.
