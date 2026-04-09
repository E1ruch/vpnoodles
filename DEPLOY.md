# 🚀 Деплой VPNoodles на TimeWeb VPS

## 📋 Что нужно подготовить

### 1. VPS на TimeWeb

- **ОС:** Ubuntu 22.04 LTS (рекомендуется)
- **RAM:** минимум 1 GB (рекомендуется 2 GB)
- **CPU:** 1 vCPU минимум
- **Диск:** 20 GB минимум
- **Локация:** любая НЕ российская (Amsterdam, Frankfurt и т.д.) — чтобы был доступ к Telegram API

> ⚠️ Если VPS в России — Telegram API будет заблокирован. Выбирайте европейский датацентр.

---

## 🛠 Шаг 1 — Подключение к VPS

```bash
ssh root@YOUR_VPS_IP
```

---

## 🛠 Шаг 2 — Установка Docker и Docker Compose

```bash
# Обновить систему
apt update && apt upgrade -y

# Установить зависимости
apt install -y curl git

# Установить Docker
curl -fsSL https://get.docker.com | sh

# Добавить пользователя в группу docker (опционально)
usermod -aG docker $USER

# Проверить установку
docker --version
docker compose version
```

---

## 🛠 Шаг 3 — Клонировать репозиторий

```bash
# Создать директорию для проекта
mkdir -p /opt/vpnoodles
cd /opt/vpnoodles

# Клонировать репозиторий
git clone https://github.com/E1ruch/vpnoodles.git .
```

---

## 🛠 Шаг 4 — Настроить .env для production

```bash
# Скопировать шаблон
cp .env.example .env

# Открыть редактор
nano .env
```

**Заполните эти значения:**

```env
# Telegram
BOT_TOKEN=ваш_токен_от_botfather
BOT_USERNAME=vpnoodles_bot
ADMIN_IDS=ваш_telegram_id

# App
NODE_ENV=production
LOG_LEVEL=info
BOT_MODE=polling          # polling проще для старта

# PostgreSQL — оставить как есть (docker-compose сам создаст)
DB_HOST=postgres
DB_PORT=5432
DB_NAME=vpnoodles
DB_USER=vpnoodles_user
DB_PASSWORD=ПРИДУМАЙТЕ_СЛОЖНЫЙ_ПАРОЛЬ
DB_SSL=false

# Redis — оставить как есть
REDIS_HOST=redis
REDIS_PORT=6379

# VPN Panel
VPN_PANEL_URL=https://ваш_vpn_сервер:порт/путь
VPN_PANEL_USERNAME=логин
VPN_PANEL_PASSWORD=пароль
VPN_API_TOKEN=токен_из_админ_дашборда
VPN_PANEL_TYPE=3xui
VPN_SUBSCRIPTION_TOKEN=токен_подписки_если_нужен

# Безопасность — ОБЯЗАТЕЛЬНО поменяйте!
JWT_SECRET=сгенерируйте_случайную_строку_32_символа
ENCRYPTION_KEY=сгенерируйте_случайную_строку_32_символа
```

**Сгенерировать случайные строки:**

```bash
openssl rand -hex 32
```

---

## 🛠 Шаг 5 — Запустить контейнеры

```bash
cd /opt/vpnoodles

# Собрать и запустить все сервисы
docker compose up -d --build

# Проверить статус
docker compose ps
```

Все три контейнера должны быть `healthy`:

```
vpnoodles_bot       running (healthy)
vpnoodles_postgres  running (healthy)
vpnoodles_redis     running (healthy)
```

---

## 🛠 Шаг 6 — Применить миграции и seed

```bash
# Применить миграции (создать таблицы)
docker exec vpnoodles_bot node src/database/migrate.js up

# Заполнить дефолтные планы
docker exec vpnoodles_bot node src/database/seed.js
```

---

## 🛠 Шаг 7 — Проверить работу бота

```bash
# Посмотреть логи бота
docker logs vpnoodles_bot -f

# Должно быть:
# ✅ PostgreSQL connected
# ✅ Redis connected
# ✅ Bot launched in POLLING mode
```

Откройте Telegram и напишите боту `/start` — он должен ответить.

---

## 🔄 Обновление бота

```bash
cd /opt/vpnoodles

# Получить новый код
git pull

# Пересобрать и перезапустить
docker compose up -d --build bot

# Применить новые миграции (если есть)
docker exec vpnoodles_bot node src/database/migrate.js up
```

---

## 📊 Мониторинг

```bash
# Логи бота в реальном времени
docker logs vpnoodles_bot -f

# Логи всех сервисов
docker compose logs -f

# Статус контейнеров
docker compose ps

# Использование ресурсов
docker stats
```

---

## 🔒 Безопасность (рекомендуется)

### Настроить firewall

```bash
# Установить ufw
apt install -y ufw

# Разрешить SSH
ufw allow 22/tcp

# Запретить всё остальное входящее
ufw default deny incoming
ufw default allow outgoing

# Включить
ufw enable
```

> ⚠️ Порты 5432 (PostgreSQL) и 6379 (Redis) НЕ должны быть открыты наружу в production!
> В `docker-compose.yml` они не проброшены на хост — это правильно.

---

## 🆘 Частые проблемы

### Бот не отвечает

```bash
docker logs vpnoodles_bot --tail 50
```

### Ошибка подключения к БД

```bash
# Проверить что postgres запущен
docker compose ps postgres

# Проверить логи postgres
docker logs vpnoodles_postgres --tail 20
```

### Пересоздать всё с нуля

```bash
docker compose down -v   # удалит контейнеры И данные!
docker compose up -d --build
docker exec vpnoodles_bot node src/database/migrate.js up
docker exec vpnoodles_bot node src/database/seed.js
```

---

## 📁 Структура на сервере

```
/opt/vpnoodles/
├── .env                 # ← секреты (не в git!)
├── docker-compose.yml   # ← production compose
├── logs/                # ← логи бота (монтируется из контейнера)
└── src/
```
