# Vebai — чат с ИИ-архитектором (Manus-стиль), Vercel-совместимый

Чат с персистентным ИИ-агентом: составляет планы, ищет в интернете, генерирует
изображения и ставит видео (MiniMax H3 на Kaggle GPU) в фоновую очередь —
работает 24/7, результаты приходят в чат, даже если браузер закрыт.

Стек: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Prisma (PostgreSQL) +
REST-клиент Kaggle API (без Python/CLI) + LLM через **прокси chat.z.ai**.

## ⚠️ Прозрачный прокси к Z.ai

Сайт — **неофициальный клиент chat.z.ai**, не аффилированный с Z.ai:

- Регистрация проходит **здесь** и защищена **капчей**; никаких токенов Z.ai
  у пользователей не запрашивается (email + пароль хранятся локально в БД сайта).
- Все запросы к ИИ выполняет **агент chat.z.ai (Z.ai)** — с его собственным
  набором инструментов (z.ai web SDK: веб-поиск и др.) — и расходует
  **квоту Z.ai**, закреплённую за сайтом (аккаунт владельца `ZAI_JWT`).
- Предупреждение об этом показывается на начальной странице и в шапке
  приложения.
- Сверх визуала Z.ai сайт добавляет **свой инструмент создания видео**
  (MiniMax H3 на Kaggle GPU) — он доступен прямо из чата.

### Как задать токен владельца (ZAI_JWT)

1. Войди на https://chat.z.ai в браузере.
2. DevTools (F12) → Application → Local Storage → `https://chat.z.ai`.
3. Скопируй значение ключа **`token`**.
4. Вставь его в переменную окружения `ZAI_JWT` (Vercel → Settings →
   Environment Variables) и сделай Redeploy.

Без `ZAI_JWT` сайт работает на анонимных гостевых сессиях chat.z.ai — они
ограничены капчей и уровнем моделей, поэтому для стабильной работы задай
`ZAI_JWT`.

Модели прокси (переменная `ZAI_CHATWEB_MODEL`, по умолчанию `glm-4.7`):
`glm-5.3` · `glm-5.2` · `GLM-5-Turbo` · `x-preview-l` (GLM-5.3-Flash) ·
`glm-4.7` · `0727-360B-API` (GLM-4.5, агентская) · `0727-106B-API`
(GLM-4.5-Air) · `deep-research` · `zero`. Доступность зависит от уровня
аккаунта Z.ai.

## Что адаптировано под Vercel

| Было (песочница)                    | Стало (Vercel)                                      |
|-------------------------------------|-----------------------------------------------------|
| SQLite-файл `db/custom.db`          | PostgreSQL (Neon / Vercel Postgres)                 |
| Kaggle CLI (Python, child_process)  | Чистый REST-клиент на `fetch` (`src/lib/kaggle.ts`) |
| ffmpeg/ffprobe для кадров           | `sharp` (contain 864×480 + тёмный паддинг)          |
| Локальные файлы видео/картинок      | Байты в БД (`Bytes`), отдача с Range-стримингом     |
| `studio-state.json`                 | Таблица `StudioState`                               |
| Воркер `setInterval` в instrumentation | `/api/agent/tick` (cron) + тики от опросов UI     |
| socket.io релей на :3003            | HTTP-поллинг `/api/agent/state` (socket опционален) |
| Скилл/ноутбуки с диска              | Вшиты в бандл (`h3-content.ts`, `kernels.ts`)       |
| z-ai-web-dev-sdk (песочный)         | Прокси chat.z.ai (`src/lib/chatweb.ts`)             |
| Без авторизации                     | Регистрация с капчей, диалоги привязаны к аккаунту  |

## Безопасность

- `kernels/*.ipynb` содержат `KAGGLE_API_TOKEN` — ноутбуку он нужен для
  страхочного пуша результатов изнутри Kaggle. Держи репозиторий **приватным**
  или отзови токен (kaggle.com → Settings → API) и вшей новый при утечке.
- `ZAI_JWT` даёт полный доступ к аккаунту владельца chat.z.ai — храни его
  только в переменных окружения Vercel, не в коде. Квота аккаунта расходуется
  всеми пользователями сайта (о чём они предупреждены на стартовой странице).
- Регистрация защищена самодельной SVG-капчей (`/api/auth/captcha`): задачи
  одноразовые, живут 10 минут, хранятся в БД (работает на serverless).
- Пароли хранятся как scrypt-хэши; сессии — подписанные HttpOnly cookie
  (`APP_SECRET` или, по умолчанию, хэш `DATABASE_URL`).

## Деплой на Vercel

1. **База данных** — создай Postgres (Neon, Vercel Marketplace → Neon, или
   Supabase) и скопируй connection string.
2. **Импорт репозитория** — Vercel → Add New Project → импортируй `Vebai`
   (framework определится сам, build = `next build`).
3. **Environment Variables** (Settings → Environment Variables):

   ```
   DATABASE_URL      = postgresql://...?sslmode=require
   KAGGLE_API_TOKEN  = KGAT_...                (kaggle.com → Settings → API)
   KAGGLE_ACCOUNT    = freedomform
   ZAI_JWT           = (токен chat.z.ai — см. раздел выше)
   ZAI_CHATWEB_MODEL = glm-4.7
   APP_SECRET        = (случайная строка, опционально)
   CRON_SECRET       = (опционально)
   ```

4. **Схема БД** — один раз локально против продовой базы:

   ```bash
   npm i
   npx prisma db push
   ```

5. Deploy. Готово: открой сайт, зарегистрируйся и работай с агентом.

### Деплой полностью через API (без dashboard)

Нужен Vercel API token (https://vercel.com/account/tokens → Create Token):

```bash
# проект
curl -s -X POST https://api.vercel.com/v10/projects -H "Authorization: Bearer $VERCEL_TOKEN" \
  -d '{"name":"vebai","framework":"nextjs"}'

# переменные окружения
curl -s -X POST https://api.vercel.com/v10/projects/vebai/env -H "Authorization: Bearer $VERCEL_TOKEN" \
  -d '{"key":"DATABASE_URL","value":"postgresql://...","type":"encrypted","target":["production","preview","development"]}'
# ... повторить для KAGGLE_API_TOKEN, ZAI_JWT и остальных

# деплой из git
curl -s -X POST https://api.vercel.com/v13/deployments -H "Authorization: Bearer $VERCEL_TOKEN" \
  -d '{"name":"vebai","gitSource":{"type":"github","repo":"FreedoomForm/Vebai","ref":"main","repoId":"<repoId>"}}'
```

И проще: `npx vercel --prod` с токеном в `VERCEL_TOKEN`.

## Режим «агент работает 24/7»

Фоновый воркер (генерация картинок, пуш/поллинг Kaggle, доставка видео в чат)
на Vercel приводится в движение тремя способами — включи любые:

- **Опрос из UI** — каждый открытый сайт опрашивает `/api/agent/state` раз в
  4с; при наличии задач триггерится тик (`waitUntil`). Работает сразу.
- **Vercel Cron** (Pro) — добавь в `vercel.json`:

  ```json
  "crons": [{ "path": "/api/agent/tick", "schedule": "* * * * *" }]
  ```

- **Внешний пингер** (бесплатно, Hobby) — cron-job.org / UptimeRobot / GitHub
  Actions раз в минуту дергают `https://<домен>/api/agent/tick?secret=<CRON_SECRET>`.

Локально (`npm run dev`) воркер запускается сам в процессе сервера —
`instrumentation.ts` видит, что это не Vercel, и стартует интервал 3с.

## Локальная разработка

```bash
npm i
cp .env.example .env      # заполни значения
npx prisma db push
npm run dev               # http://localhost:3000
```

## Конвейер видео (MiniMax H3 на Kaggle)

Агент вызывает `generate_video` → задачи `Job` пишутся в БД → воркер
формирует датасет-манифест (JSON + кадры 864×480) → REST-пуш
`rmc-studio-jobs` → воркер-ядро `rmc-studio-worker` (2×T4) забирает задачи,
генерирует клипы и пушит их в `rmc-studio-outputs` после каждого кадра →
сайт доставляет mp4 в БД → видео появляется в чате с Range-стримингом.

Тест-режим (`test_mode`) прогоняет тот же путь через CPU-ffmpeg-заглушку
`rmc-studio-worker-test` — без расхода GPU-квоты.

`kernels/` — исходники ноутбуков (вшиты в `src/lib/kernels.ts` через
`scripts/embed_content.py` — запускать после правок ноутбуков).
