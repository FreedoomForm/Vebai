# Vebai — чат с ИИ-архитектором (Manus-стиль), Vercel-совместимый

Чат с персистентным ИИ-агентом: составляет планы, ищет в интернете, генерирует
изображения и ставит видео (MiniMax H3 на Kaggle GPU) в фоновую очередь —
работает 24/7, результаты приходят в чат, даже если браузер закрыт.

Стек: Next.js 16 + TypeScript + Tailwind + shadcn/ui + Prisma (PostgreSQL) +
REST-клиент Kaggle API (без Python/CLI) + LLM через **прокси chat.z.ai**.

## ⚠️ Прозрачный прокси к Z.ai

Сайт — **неофициальный клиент chat.z.ai**, не аффилированный с Z.ai:

- Регистрация на сайте создаёт **настоящий аккаунт chat.z.ai** (тот же email и
  пароль работают на chat.z.ai) — под защитой **серверной капчи Z.ai**
  (auth-сцена Aliyun, embed-виджет — ровно как на странице регистрации
  chat.z.ai). Мы пересылаем одноразовый `captcha_verify_param` в
  `/api/v1/auths/signup`; JWT нового аккаунта сохраняется на строке
  пользователя в нашей БД.
- **Свой аккаунт = своя квота**: все запросы к ИИ выполняет агент chat.z.ai
  (Z.ai) с его собственным набором инструментов (z.ai web SDK: веб-поиск и
  др.) **под аккаунтом пользователя** — никаких общих пулов и квоты
  владельца.
- **Капча не нужна на каждое сообщение**: пер-сообщная капча Z.ai существует
  только для анонимных гостевых сессий. У реального аккаунта — JWT без
  капчи; капча требуется лишь при регистрации и повторном входе (когда JWT
  истёк после долгого простоя).
- JWT обновляется «скользяще» через `GET /api/v1/auths/` (Bearer) при каждом
  запросе; если сессия всё же истекла — UI показывает баннер «Сессия Z.ai
  истекла», пользователь решает капчу один раз при входе.
- Предупреждение об этом показывается на начальной странице и в шапке
  приложения.
- Сверх визуала Z.ai сайт добавляет **свой инструмент создания видео**
  (MiniMax H3 на Kaggle GPU) — он доступен прямо из чата.

### Как это работает (регистрация = реальный аккаунт)

```
браузер пользователя            наш сервер (Vercel)              chat.z.ai
┌─────────────────────┐        ┌──────────────────────┐        ┌────────────┐
│ auth-виджет Aliyun   │  param │ POST /api/auth/      │ signup │ /auths/     │
│ (SceneId 36qgs6xb,   │ ─────► │ {email, password,    │ ─────► │ /signup     │
│  embed, как у них)   │        │  zaiCaptchaParam}    │  JWT   │ → аккаунт   │
│ success(param)       │        │ сохраняем JWT юзера  │ ◄───── │ собственный │
└─────────────────────┘        └──────────────────────┘        └────────────┘
```

- Auth-сцена = `36qgs6xb` (region `sgp`, prefix `no8xfe`, embed 320×40) —
  вытянуто из фронта chat.z.ai (prod-fe-1.1.98); работает на чужом домене.
- Параметр одноразовый (повторное использование отклоняется).
- Логин: локальный хэш → живой JWT? → ок; иначе нужен капча-param →
  `/auths/signin`; фолбэк-адоптация аккаунта, созданного на chat.z.ai.
- Устаревшие пользователи (до этой версии) остаются на гостевых сессиях —
  для них сохранён капча-релей чат-сцены `didk33e0` на каждое сообщение.

### ZAI_JWT (необязательно, легаси)

Не используется новой архитектурой. Если задан — применяется только как
фолбэк для анонимного трафика без пользователя. Свежие регистрации его
не трогают: у каждого свой аккаунт.

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

> ### 🔐 Аутентификация v5 (побайтовый ресёрч chat.z.ai, prod-fe-1.1.98)
>
> | Механизм | Как работает |
> |---|---|
> | Регистрация сайта | мгновенно, локальный аккаунт, ничего Z.ai-стороны не блокирует |
> | Реальный аккаунт Z.ai | капча Aliyun (один раз) → `signup` → **код из письма** → `verify_email` + `finish_signup` (без капчи) → свой JWT и своя квота; `/api/auth/zai/verify`, `/api/auth/zai/resend` |
> | Вход | локальный пароль; скользящий рефреш сессии Z.ai; signin у Z.ai всегда требует капчу |
> | Google / GitHub | мост: настоящий OAuth-вход chat.z.ai (popup) + вставка адреса `chat.z.ai/auth#token=…`; `/api/auth/google/claim` валидирует JWT живым запросом и привязывает/создаёт аккаунт. Бесшовный перехват невозможен (redirect_uri закреплён, state серверный одноразовый, whitelist qot() = zread.ai / test.cgx.dev / z.ai / www.chatglm.site) |
> | Silent-downgrade guard | протухший Bearer у Z.ai НЕ даёт 401 — сервер молча выдаёт гостя; детектор по identity JWT бросает `zai_session_expired`, гостевой токен никогда не перезаписывает настоящий |
> | `zaiLinked` | true только для настоящего JWT; гостевой токен = личная анонимная сессия, не «подключённый аккаунт» |

> ### ✅ Текущий статус деплоя (выполнено через Vercel API)
>
> | Шаг | Состояние |
> |---|---|
> | Проект Vercel | `vebai` (аккаунт `afotimabegim-2706`) — https://vebai-six.vercel.app |
> | Postgres | `vebai-postgres` (Supabase Free, регион eu-central-1, `store_fM3dyjNBWiFDv4gF`), подключён к проекту |
> | `DATABASE_URL` | задан (pooled `pgbouncer=true` — для рантайма) |
> | `KAGGLE_API_TOKEN` | задан (`KGAT_…`, аккаунт freedomform) |
> | Схема БД | `npx prisma db push` выполнен против продовой базы |
> | Git-интеграция | `FreedoomForm/Vebai` → main; каждый пуш = автодеплой |
> | Deployment Protection | отключена (сайт публичный) |
> | Режим чата | **Агент-режим Z.ai** (`type: general_agent`, модель `x-preview-l`/GLM-5.3-Flash): веб-поиск, генерация изображений, работа с файлами и кодом — внутри квоты аккаунта Z.ai, без отдельных API-ключей |
| Google-вход (v6) | Настоящий Google-OAuth chat.z.ai (`/oauth/google/login?t=2` → `accounts.google.com`, client_id `800424391928-…`) + **автокопирование токена** букмарклетом «⚡ Vebai — забрать токен» → `/auth/google/catch#token=…` → `/api/auth/google/claim` (live-валидация на chat.z.ai). Бесшовный `sso_redirect` закрыт их whitelist'ом (`zread.ai / test.cgx.dev / z.ai / www.chatglm.site` — проверено по байтам фронтенда `prod-fe-1.1.98`), один клик букмарклета — минимальный честный шаг |
>
> Дальнейшие изменения деплоятся автоматически при пуше в `main`.

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
