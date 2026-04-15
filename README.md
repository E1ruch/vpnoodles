# 🌐 VPNoodles Bot

> Масштабируемый Telegram-бот для продажи VPN/Proxy подписок.  
> Node.js · Telegraf · PostgreSQL · Docker

---

## 📐 Архитектура

```
vpnoodles/
├── src/
│   ├── index.js                  # Точка входа (bootstrap)
│   ├── config/
│   │   └── index.js              # Централизованная конфигурация из .env
│   ├── bot/
│   │   ├── index.js              # Telegraf bot factory
│   │   ├── middleware/
│   │   │   ├── auth.js           # Блокировка банов, isAdmin флаг
│   │   │   ├── logger.js         # Логирование каждого update
│   │   │   ├── rateLimit.js      # Redis rate limiter (30 req/min)
│   │   │   └── user.js           # Авто-регистрация пользователя
│   │   ├── handlers/
│   │   │   ├── start.js          # /start + приветствие
│   │   │   ├── menu.js           # Главное меню
│   │   │   ├── subscribe.js      # Выбор плана + оплата
│   │   │   ├── myVpn.js          # Конфиги + QR-коды
│   │   │   ├── profile.js        # Профиль пользователя
│   │   │   ├── referral.js       # Реферальная программа
│   │   │   ├── payment.js        # pre_checkout + successful_payment
│   │   │   └── admin.js          # Панель администратора
│   │   └── scenes/
│   │       └── index.js          # Telegraf Stage (для будущих wizard-сцен)
│   ├── services/
│   │   ├── UserService.js        # Регистрация, рефералы, бан
│   │   ├── SubscriptionService.js# Активация, продление, истечение
│   │   ├── VpnService.js         # Фасад над VPN-панелью
│   │   ├── YookassaService.js    # Платежный шлюз YooKassa
│   │   ├── PaymentService.js     # Платежи (Stars, YooKassa, Cryptomus)
│   │   └── vpn/
│   │       └── RemnawaveAdapter.js # Remnawave Panel API
│   ├── models/
│   │   ├── User.js               # CRUD пользователей
│   │   ├── Plan.js               # Тарифные планы
│   │   ├── Subscription.js       # Подписки
│   │   ├── Payment.js            # Платежи
│   │   └── VpnConfig.js          # VPN конфигурации
│   ├── database/
│   │   ├── knex.js               # Knex (PostgreSQL) клиент
│   │   ├── redis.js              # Redis клиент + helpers
│   │   ├── migrate.js            # CLI для миграций
│   │   ├── seed.js               # Seed дефолтных планов
│   │   └── migrations/
│   │       └── 001_initial.js    # Начальная схема БД
│   ├── cron/
│   │   └── index.js              # Cron-задачи (истечение, уведомления)
│   └── utils/
│       └── logger.js             # Winston logger
│   └── webhooks/
│       └── yookassa.js           # Yookassa
├── .env.example                  # Шаблон переменных окружения
├── Dockerfile                    # Multi-stage Docker build
├── docker-compose.yml            # Bot + PostgreSQL
└── package.json
```

---

## 🗄️ Схема базы данных

| Таблица         | Описание                                 |
| --------------- | ---------------------------------------- |
| `users`         | Telegram-пользователи, статус, рефералы  |
| `plans`         | Тарифные планы (цена, трафик, срок)      |
| `subscriptions` | Активные/истёкшие подписки пользователей |
| `payments`      | История платежей (Stars, RUB, USD)       |
| `vpn_configs`   | VPN конфиги (ссылки, QR, panel_user_id)  |
| `referrals`     | Реферальные связи и бонусы               |
| `audit_logs`    | Лог действий для безопасности            |

---

## 🚀 Быстрый старт

### 1. Клонировать и настроить

```bash
cp .env.example .env
# Заполните .env: BOT_TOKEN, DB_*, VPN_PANEL_*
```

### 2. Запуск через Docker (рекомендуется)

```bash
# Запустить все сервисы
docker-compose up -d

# Применить миграции
docker-compose exec bot node src/database/migrate.js up

# Заполнить дефолтные планы
docker-compose exec bot node src/database/seed.js
```

### 3. Локальная разработка

```bash
# Установить зависимости
npm install

# Запустить PostgreSQL и Redis (через Docker)
docker-compose up -d postgres redis

# Применить миграции
npm run migrate

# Заполнить планы
npm run seed

# Запустить бота в режиме разработки
npm run dev
```

---

## ⚙️ Переменные окружения

Смотрите `.env.example` — все переменные задокументированы.

Ключевые:

| Переменная      | Описание                             |
| --------------- | ------------------------------------ |
| `BOT_TOKEN`     | Токен от @BotFather                  |
| `ADMIN_IDS`     | Telegram ID администраторов          |
| `BOT_MODE`      | `polling` (dev) или `webhook` (prod) |
| `VPN_API_TOKEN` | API-токен Remnawave                  |
| `VPN_PANEL_URL` | URL панели Remnawave                 |
| `STARS_ENABLED` | Включить оплату Telegram Stars       |

---

## 💳 Платёжные системы

| Провайдер      | Статус    | Описание                     |
| -------------- | --------- | ---------------------------- |
| Telegram Stars | ✅ Готово | Встроенная оплата в Telegram |
| YooKassa       | ✅ Готово | RUB платежи                  |
| CryptoBot      | ✅ Готово | Крипто платежи               |

---

## 🔌 VPN-панель

Поддерживается только **Remnawave** (подписка, internal squads, теги и лимит устройств на стороне панели).

---

## 🔄 Cron-задачи

| Задача                      | Расписание            | Описание                           |
| --------------------------- | --------------------- | ---------------------------------- |
| Истечение подписок          | Каждые 15 мин         | Деактивирует просроченные подписки |
| Уведомления об истечении    | Каждый день 10:00 UTC | Предупреждает за N дней до конца   |
| Уведомления об срока оплаты | В течении часа        | За 30 минут и за 10 минут          |

---

## 📈 Масштабирование

### Горизонтальное масштабирование

- Бот поддерживает **webhook-режим** для запуска нескольких инстансов
- [Отключено] Сессии хранятся в **Redis** — инстансы не зависят друг от друга
- PostgreSQL с **connection pooling** (Knex)

### Будущие улучшения

- [ ] Несколько VPN-серверов (multi-node routing)
- [ ] Web-панель администратора
- [ ] Поддержка Outline / WireGuard
- [ ] Автоматическое продление (auto-renew)
- [ ] Telegram Mini App для управления подпиской
- [ ] Webhook для YooKassa / Cryptomus
- [ ] Метрики (Prometheus + Grafana)
- [ ] Тесты (Jest)

---

## 🛠 Команды

```bash
npm start          # Запуск в production
npm run dev        # Запуск с nodemon (hot-reload)
npm run migrate    # Применить миграции
npm run seed       # Заполнить дефолтные планы
npm run lint       # ESLint
npm test           # Jest тесты
```

---

## 🔐 Безопасность

- Все пользователи проходят через middleware авторизации
- Забаненные пользователи блокируются на уровне middleware
- Rate limiting: 30 запросов/минуту на пользователя
- Секреты только через переменные окружения
- Docker: запуск от непривилегированного пользователя
- PostgreSQL: параметризованные запросы (Knex, без SQL-инъекций)

---

## 📞 Поддержка

Для вопросов и предложений — создайте Issue в репозитории.
