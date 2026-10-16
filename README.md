# Vebai — чат с ИИ-архитектором (Manus-стиль), Vercel-совместимый

Чат с персистентным ИИ-агентом: составляет планы, ищет в интернете, генерирует
изображения и ставит видео (MiniMax H3 на Kaggle GPU) в фоновую очередь —
работает 24/7, результаты приходят в чат, даже если браузер закрыт.

Стек: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Prisma (PostgreSQL) +
REST-клиент Kaggle API (без Python/CLI) + LLM через **официальный API Z.ai**
(бесплатные модели GLM).

## Официальный API Z.ai (v13)

Никаких логинов с Z.ai, капч и сессий chat.z.ai — всё работает на **официальном
OpenAI-совместимом API** с ключом владельца сайта:

| Модель | Статус | Назначение |
|---|---|---|
| `glm-4.5-flash` | бесплатная | основной чат (быстрая и стабильная — по умолчанию) |
| `glm-4.7-flash` | бесплатная | автофолбэк при перегрузке 4.5 (thinking-модель) |
| ~~`cogview-3-flash`~~ | стал платным | **генерация изображений отключена** (владелец) |

- Ключ хранится **только на сервере** (`ZAI_API_KEY`): браузер общается с
  нашим backend'ом, backend — с `ZAI_BASE_URL`
  (по умолчанию `https://open.bigmodel.cn/api/paas/v4`).
- Чат-стрим: `POST /api/chat/stream` (SSE) — сервер инжектит системный промпт,
  опционально подтягивает свежие результаты веб-поиска (Bing RSS + DuckDuckGo,
  без ключей) и стримит ответ; при перегрузке модели автоматически пробуется
  следующая в цепочке.
- Регистрация/вход — обычные локальные аккаунты (email + пароль, scrypt-хэши,
  подписанные HttpOnly cookie). Ничего внешнего.
- Фоновые задачи (видео на Kaggle) работают как раньше 24/7; генерация
  изображений удалена (CogView стал платным).

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
| z-ai-web-dev-sdk (песочный)         | Официальный API Z.ai (`src/lib/zai.ts`)             |
| Регистрация с капчей Z.ai + личные сессии chat.z.ai | Локальные аккаунты, чат на ключе владельца |
| Browser-direct chat.z.ai + попап-капча | Серверный SSE-прокси `/api/chat/stream`          |

## Безопасность

- `kernels/*.ipynb` содержат `KAGGLE_API_TOKEN` — ноутбуку он нужен для
  страхочного пуша результатов изнутри Kaggle. Держи репозиторий **приватным**
  или отзови токен (kaggle.com → Settings → API) и вшей новый при утечке.
- `ZAI_API_KEY` даёт полный доступ к квоте владельца API — храни его только в
  переменных окружения Vercel, не в коде.
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
   ZAI_API_KEY       = <ключ z.ai / bigmodel.cn>       (обязательно)
   ZAI_BASE_URL      = https://open.bigmodel.cn/api/paas/v4
   ZAI_MODEL         = glm-4.5-flash
   KAGGLE_API_TOKEN  = KGAT_...                        (kaggle.com → Settings → API)
   KAGGLE_ACCOUNT    = freedomform
   # ускоритель Kaggle-воркера (опционально):
   KAGGLE_ENABLE_TPU = false        # true — только после порта пайплайна на XLA
   KAGGLE_MACHINE_SHAPE = NvidiaTeslaT4   # либо TpuV5E8 для TPU v5e-8
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
# ... повторить для ZAI_API_KEY, KAGGLE_API_TOKEN и остальных

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

Агент вызывает 🎬-переключатель в композере → задачи `Job` пишутся в БД →
воркер формирует датасет-манифест (JSON + кадры 864×480) → REST-пуш
`rmc-studio-jobs` → воркер-ядро `rmc-studio-worker` (2×T4) забирает задачи,
генерирует клипы и пушит их в `rmc-studio-outputs` после каждого кадра →
сайт доставляет mp4 в БД → видео появляется в чате с Range-стримингом.

Тест-режим (`test_mode`) прогоняет тот же путь через CPU-ffmpeg-заглушку
`rmc-studio-worker-test` — без расхода GPU-квоты.

`kernels/` — исходники ноутбуков (вшиты в `src/lib/kernels.ts` через
`scripts/embed_content.py` — запускать после правок ноутбуков).
