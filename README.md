# Vebai — чат с ИИ-архитектором (Manus-стиль), Vercel-совместимый

Чат с персистентным ИИ-агентом: составляет планы, ищет в интернете, генерирует
изображения и ставит видео (MiniMax H3 на Kaggle GPU) в фоновую очередь —
работает 24/7, результаты приходят в чат, даже если браузер закрыт.

Стек: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Prisma (PostgreSQL) +
REST-клиент Kaggle API (без Python/CLI) + LLM через **прокси chat.z.ai**.

## ⚠️ Прозрачный прокси к Z.ai

Сайт — **неофициальный клиент chat.z.ai**, не аффилированный с Z.ai:

- Регистрация проходит **здесь** и защищена **серверной капчей Z.ai** — тем же
  самым виджетом Aliyun Captcha, что открывает chat.z.ai (мы транслируем его
  пользователю, пользователь решает, chat.z.ai проверяет решение).
  Никаких токенов Z.ai у пользователей не запрашивается.
- Каждому пользователю выдаётся **его собственная анонимная сессия chat.z.ai**
  (хранится на строке пользователя в БД). Все запросы к ИИ выполняет
  **агент chat.z.ai (Z.ai)** — с его собственным набором инструментов
  (z.ai web SDK: веб-поиск и др.) — и расходует **личную анонимную квоту
  Z.ai** этого пользователя. Квота владельца сайта не тратится.
- Каждый запрос к модели должен нести одноразовый `captcha_verify_param`:
  в доверенных браузерах виджет проходит **мгновенно и незаметно**
  (smart-верификация Aliyun), в подозрительных — пользователь двигает ползунок.
- Предупреждение об этом показывается на начальной странице и в шапке
  приложения.
- Сверх визуала Z.ai сайт добавляет **свой инструмент создания видео**
  (MiniMax H3 на Kaggle GPU) — он доступен прямо из чата.

### Как это работает (капча-релей)

```
браузер пользователя            наш сервер (Vercel)              chat.z.ai
┌─────────────────────┐        ┌──────────────────────┐        ┌────────────┐
│ виджет Aliyun        │  param │ POST /api/chat       │ signed │ completions │
│ (SceneId didk33e0)   │ ─────► │ + param + сессия юзера│ ─────► │ + param     │
│ success(param)       │        │                      │  200   │ ✓ проверено │
└─────────────────────┘        └──────────────────────┘        └────────────┘
```

- Виджет = официальный скрипт `o.alicdn.com/captcha-frontend/aliyunCaptcha/…`,
  регион `sgp`, prefix `no8xfe`, SceneId `didk33e0` (главная сцена chat.z.ai;
  Aliyun не привязывает её к их домену — проверено живьём).
- Параметр одноразовый (повторное использование отклоняется с кодом F018).
- Если Z.ai требует капчу, а параметра нет — бэкенд отдаёт событие
  `captcha_required`, UI молча решает виджет и повторяет сообщение.

### ZAI_JWT (необязательно)

По умолчанию **не нужен** — каждый пользователь работает на своей анонимной сессии.
Если задать `ZAI_JWT` (токен аккаунта владельца chat.z.ai из Local Storage),
все запросы пойдут через этот аккаунт: капча не требуется, но квота общая.
Пользователи об этом предупреждены. Задавать только по желанию.

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
| Без авторизации                     | Регистрация с капчей Z.ai, диалоги привязаны к аккаунту |
| Самодельная SVG-капча               | Релей серверной капчи Z.ai (`zai-captcha.tsx`)       |
| Общая квота владельца (ZAI_JWT)     | Личные анонимные сессии на пользователя             |

## Безопасность

- `kernels/*.ipynb` содержат `KAGGLE_API_TOKEN` — ноутбуку он нужен для
  страхочного пуша результатов изнутри Kaggle. Держи репозиторий **приватным**
  или отзови токен (kaggle.com → Settings → API) и вшей новый при утечке.
- `ZAI_JWT` (если задан) даёт полный доступ к аккаунту владельца chat.z.ai —
  храни его только в переменных окружения Vercel, не в коде.
- Регистрация защищена **серверной капчей Z.ai**: параметр проверяется самим
  chat.z.ai (гостевым пробным запросом) — подделать нельзя, своей капчи нет.
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
   ZAI_JWT           = (НЕобязательно — токен владельца chat.z.ai; без него каждая сессия на своего пользователя)
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
