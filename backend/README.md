# Backend Smart Cat Feeder

Минимальный backend-каркас системы Smart Cat Feeder. На этом этапе сервис предоставляет только технические проверки HTTP-сервера и PostgreSQL. Бизнес-логика кормления, расписания, история, авторизация, таблицы и миграции ещё не реализованы.

## Технологии

- Node.js 24 LTS;
- TypeScript;
- Fastify;
- PostgreSQL;
- драйвер `pg`;
- `dotenv`;
- Docker Compose;
- встроенный тестовый раннер Node.js.

## Требования

- Node.js 24 LTS;
- npm;
- Docker и Docker Compose для локального PostgreSQL.

## Установка

Перейдите в каталог backend и установите зависимости:

```powershell
cd backend
npm install
```

## Настройка окружения

Создайте локальный `.env` на основе примера:

```powershell
Copy-Item .env.example .env
```

Демонстрационные значения согласованы с Docker Compose. Перед использованием вне локальной разработки замените пароль. Файл `.env` исключён из Git.

## PostgreSQL

Запустить PostgreSQL:

```powershell
docker compose up -d postgres
```

Проверить состояние контейнера:

```powershell
docker compose ps
```

Остановить контейнер:

```powershell
docker compose down
```

Данные PostgreSQL сохраняются в именованном Docker volume. Команда `docker compose down` его не удаляет.

## Запуск backend

Режим разработки с автоматическим перезапуском:

```powershell
npm run dev
```

По умолчанию сервер доступен по адресу `http://localhost:3000`.

## Сборка и запуск

```powershell
npm run typecheck
npm run build
npm start
```

## Тесты

```powershell
npm test
```

Тесты используют подменённую проверку PostgreSQL и не требуют запущенной внешней базы данных.

## Технические endpoint

Проверка HTTP-сервера:

```http
GET /health
```

Успешный ответ:

```json
{
  "status": "ok",
  "service": "smart-cat-feeder-backend"
}
```

Проверка подключения к PostgreSQL:

```http
GET /ready
```

При доступной базе endpoint возвращает HTTP 200, при недоступной — HTTP 503. `/health` от состояния PostgreSQL не зависит.
