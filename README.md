# Vebai — чат с ИИ-архитектором (Manus-стиль), Vercel-совместимый

Чат с персистентным ИИ-агентом: составляет планы, ищет в интернете, генерирует
изображения и ставит видео (MiniMax H3 на Kaggle GPU) в фоновую очередь —
работает 24/7, результаты приходят в чат, даже если браузер закрыт.

Стек: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Prisma (PostgreSQL) +
REST-клиент Kaggle API (без Python/CLI) + Z.ai LLM (OpenAI-совместимый).

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

## Безопасность

- `kernels/*.ipynb` содержат `KAGGLE_API_TOKEN` — ноутбуку он нужен для
  страхочного пуша результатов изнутри Kaggle. Держи репозиторий **приватным**
  или отзови токен (kaggle.com → Settings → API) и вшей новый при утечке.
- Все остальные секреты (DATABASE_URL, ZAI_*) живут только в переменных
  окружения Vercel — в коде их нет.

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
   ZAI_BASE_URL      = https://api.z.ai/api/paas/v4
   ZAI_API_KEY       = ...
   CRON_SECRET       = (опционально)
   ```

4. **Схема БД** — один раз локально против продовой базы:

   ```bash
   npm i
   npx prisma db push
   ```

5. Deploy. Готово — сайт отвечает, агент обрабатывает задачи.

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
