# T-30. CI, smoke-тест, конфигурация деплоя

**Пакет:** корень · **Волна:** 6 · **Уровень:** C · **Размер:** ~300 строк · **Зависит от:** T-23 · **Разблокирует:** —

## Что сделать
1. `.github/workflows/check.yml`: на push/PR — `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`; кэш pnpm; Node 22.
   Job `bench` (ручной запуск `workflow_dispatch`) с `ATL_BENCH=1`.
2. Playwright smoke: `apps/web/e2e/smoke.spec.ts` — открыть `pnpm preview`, дождаться канваса, проверить, что за 15 с пришло
   ≥ 10 кадров (окно экспонирует счётчик `window.__atl.frames` в dev/preview) и нет ошибок в консоли. Отдельный скрипт
   `pnpm e2e`, в CI как отдельный job.
3. Vercel: `vercel.json`/`vercel.ts` для статической сборки `apps/web` (`outputDirectory: apps/web/dist`, `buildCommand: pnpm build`),
   инструкция в README: `npm i -g vercel@latest`, `vercel link`, `vercel --prod`. **Не деплоить**: деплой делает владелец.
4. Бейдж статуса CI в README.

## Критерии приёмки
- [ ] CI зелёный на `main`; smoke проходит локально; `pnpm check` зелёный.
