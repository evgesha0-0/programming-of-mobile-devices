# REST API Smart Cat Feeder

## Общие правила

- Базовый префикс всех путей: `/api/v1`.
- Ниже зафиксированы HTTP-методы, пути, имена полей и семантика. Их изменение требует новой версии контракта и обновления всей документации.
- Формат тела: JSON, кодировка UTF-8, имена полей в `snake_case`.
- Идентификаторы `device_id`, `schedule_id`, `command_id` и `feeding_id` — UUID в строковом представлении.
- Временные метки событий передаются в UTC по ISO 8601, например `2026-10-17T08:15:30Z`.
- `time_local` расписания имеет формат `HH:mm:ss`, а `timezone` — IANA timezone. `days_of_week` содержит уникальные значения из `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`.
- `portion_grams` и `actual_grams` — JSON number в граммах.
- Статусы кормления: `pending`, `running`, `completed`, `failed`, `expired`.
- Источник кормления: `manual`, `scheduled`.
- Состояния устройства в этом контракте: `online`, `busy`, `error`, `offline`, `unknown`. `offline` вычисляет backend по давности `last_seen_at`; Khadas его не отправляет.

### Единый формат ошибки

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Поле portion_grams должно быть положительным",
    "details": [
      {"field": "portion_grams", "reason": "must_be_positive"}
    ],
    "request_id": "req_01JAG4M6Y7R2"
  }
}
```

Общие HTTP-ошибки: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`, `503 SERVICE_UNAVAILABLE`. `message` предназначено для безопасного отображения или журнала и не содержит секретов.

## Android → Backend

### Получить состояние кормушки

**Метод и путь:** `GET /api/v1/devices/{device_id}/state`

Тела запроса нет.

Успешный ответ `200 OK`:

```json
{
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "status": "online",
  "last_seen_at": "2026-10-17T08:15:30Z",
  "last_error": null,
  "schedule_revision": 12
}
```

Ошибки: `401`, `403`, `404`, `500`.

### Получить список расписаний

**Метод и путь:** `GET /api/v1/devices/{device_id}/schedules`

Тела запроса нет.

Успешный ответ `200 OK`:

```json
{
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "schedule_revision": 12,
  "items": [
    {
      "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
      "time_local": "08:30:00",
      "days_of_week": ["mon", "wed", "fri"],
      "timezone": "Asia/Yekaterinburg",
      "portion_grams": 45.0,
      "active": true,
      "created_at": "2026-10-16T12:00:00Z",
      "updated_at": "2026-10-17T07:00:00Z"
    }
  ]
}
```

Ошибки: `401`, `403`, `404`, `500`.

### Создать расписание

**Метод и путь:** `POST /api/v1/devices/{device_id}/schedules`

Запрос:

```json
{
  "time_local": "08:30:00",
  "days_of_week": ["mon", "wed", "fri"],
  "timezone": "Asia/Yekaterinburg",
  "portion_grams": 45.0,
  "active": true
}
```

Успешный ответ `201 Created`:

```json
{
  "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "time_local": "08:30:00",
  "days_of_week": ["mon", "wed", "fri"],
  "timezone": "Asia/Yekaterinburg",
  "portion_grams": 45.0,
  "active": true,
  "schedule_revision": 12,
  "created_at": "2026-10-17T07:00:00Z",
  "updated_at": "2026-10-17T07:00:00Z"
}
```

Ошибки: `400` при неверном времени, timezone, днях или массе; `401`, `403`, `404`, `409`, `500`.

### Изменить расписание

**Метод и путь:** `PUT /api/v1/devices/{device_id}/schedules/{schedule_id}`

`PUT` передаёт полное изменяемое представление расписания.

Запрос:

```json
{
  "time_local": "09:00:00",
  "days_of_week": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Asia/Yekaterinburg",
  "portion_grams": 50.0,
  "active": true
}
```

Успешный ответ `200 OK`:

```json
{
  "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "time_local": "09:00:00",
  "days_of_week": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Asia/Yekaterinburg",
  "portion_grams": 50.0,
  "active": true,
  "schedule_revision": 13,
  "created_at": "2026-10-17T07:00:00Z",
  "updated_at": "2026-10-17T07:30:00Z"
}
```

Ошибки: `400`, `401`, `403`, `404`, `409` при конфликте состояния, `500`.

### Удалить расписание

**Метод и путь:** `DELETE /api/v1/devices/{device_id}/schedules/{schedule_id}`

Тела запроса нет. Backend выполняет мягкое удаление для доставки изменения Khadas.

Успешный ответ `200 OK`:

```json
{
  "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
  "deleted": true,
  "schedule_revision": 14,
  "deleted_at": "2026-10-17T07:45:00Z"
}
```

Ошибки: `401`, `403`, `404`, `409`, `500`.

### Запустить ручное кормление

**Метод и путь:** `POST /api/v1/devices/{device_id}/feeding-commands`

Запрос:

```json
{
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "portion_grams": 40.0,
  "expires_at": "2026-10-17T08:20:00Z"
}
```

`command_id` генерируется клиентом заново для намерения выполнить новое кормление. Повтор запроса с тем же `command_id` и тем же содержимым возвращает сохранённую команду. Тот же идентификатор с иным содержимым даёт `409 CONFLICT`.

Успешный ответ `202 Accepted` при первом запросе или `200 OK` при идемпотентном повторе:

```json
{
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "source": "manual",
  "portion_grams": 40.0,
  "status": "pending",
  "created_at": "2026-10-17T08:15:00Z",
  "expires_at": "2026-10-17T08:20:00Z",
  "started_at": null,
  "finished_at": null,
  "actual_grams": null,
  "error_code": null
}
```

Ответ означает только принятие команды backend, а не выдачу корма. Ошибки: `400` при неверной массе или сроке; `401`, `403`, `404`, `409`, `500`, `503`.

### Получить историю кормлений

**Метод и путь:** `GET /api/v1/devices/{device_id}/feedings?limit=50&cursor={cursor}`

Тела запроса нет. `limit` по умолчанию `50`; точный максимум требует согласования. `cursor` непрозрачен для клиента.

Успешный ответ `200 OK`:

```json
{
  "items": [
    {
      "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
      "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
      "schedule_id": null,
      "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
      "source": "manual",
      "portion_grams": 40.0,
      "actual_grams": 39.5,
      "status": "completed",
      "created_at": "2026-10-17T08:15:00Z",
      "started_at": "2026-10-17T08:15:20Z",
      "finished_at": "2026-10-17T08:15:32Z",
      "error_code": null
    }
  ],
  "next_cursor": null
}
```

Ошибки: `400` при неверной пагинации; `401`, `403`, `404`, `500`.

### Получить состояние конкретного кормления

**Метод и путь:** `GET /api/v1/devices/{device_id}/feedings/{feeding_id}`

Тела запроса нет.

Успешный ответ `200 OK`:

```json
{
  "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "schedule_id": null,
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "source": "manual",
  "portion_grams": 40.0,
  "actual_grams": 39.5,
  "status": "completed",
  "created_at": "2026-10-17T08:15:00Z",
  "started_at": "2026-10-17T08:15:20Z",
  "finished_at": "2026-10-17T08:15:32Z",
  "error_code": null,
  "error_message": null
}
```

Ошибки: `401`, `403`, `404`, `500`.

## Khadas → Backend

### Отправить текущее состояние устройства

**Метод и путь:** `PUT /api/v1/devices/{device_id}/state`

Запрос:

```json
{
  "status": "online",
  "reported_at": "2026-10-17T08:15:30Z",
  "firmware_version": "0.1.0",
  "error_code": null,
  "error_message": null
}
```

Успешный ответ `200 OK`:

```json
{
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "status": "online",
  "last_seen_at": "2026-10-17T08:15:30Z",
  "server_time": "2026-10-17T08:15:31Z"
}
```

Ошибки: `400`, `401`, `403` при несовпадении идентичности устройства, `404`, `409` для устаревшего состояния, `500`.

### Получить актуальные расписания

**Метод и путь:** `GET /api/v1/devices/{device_id}/sync/schedules?known_revision=11`

Тела запроса нет. Backend возвращает полный снимок; `deleted_at` сообщает об удалении. Если версия не изменилась, допустим тот же `200` с текущим снимком, чтобы семантика оставалась простой.

Успешный ответ `200 OK`:

```json
{
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "schedule_revision": 12,
  "generated_at": "2026-10-17T08:15:31Z",
  "items": [
    {
      "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
      "time_local": "08:30:00",
      "days_of_week": ["mon", "wed", "fri"],
      "timezone": "Asia/Yekaterinburg",
      "portion_grams": 45.0,
      "active": true,
      "updated_at": "2026-10-17T07:00:00Z",
      "deleted_at": null
    }
  ]
}
```

Ошибки: `400` при неверной ревизии; `401`, `403`, `404`, `500`, `503`.

### Получить ожидающие команды

**Метод и путь:** `GET /api/v1/devices/{device_id}/commands/pending?limit=10`

Тела запроса нет. Backend не возвращает команды с истёкшим `expires_at`.

Успешный ответ `200 OK`:

```json
{
  "items": [
    {
      "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
      "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
      "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
      "portion_grams": 40.0,
      "status": "pending",
      "created_at": "2026-10-17T08:15:00Z",
      "expires_at": "2026-10-17T08:20:00Z"
    }
  ],
  "server_time": "2026-10-17T08:15:31Z"
}
```

Ошибки: `400`, `401`, `403`, `404`, `500`, `503`.

### Подтвердить начало команды

**Метод и путь:** `POST /api/v1/devices/{device_id}/commands/{command_id}/ack`

Запрос:

```json
{
  "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
  "status": "running",
  "started_at": "2026-10-17T08:15:20Z"
}
```

Успешный ответ `200 OK`:

```json
{
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
  "status": "running",
  "started_at": "2026-10-17T08:15:20Z"
}
```

Повтор с теми же данными идемпотентен. Khadas обязан проверить `expires_at` непосредственно перед выполнением. Ошибки: `400`, `401`, `403`, `404`, `409` если команда истекла, завершена или идентификаторы не совпадают, `500`.

### Отправить результат ручного кормления

**Метод и путь:** `POST /api/v1/devices/{device_id}/feedings/{feeding_id}/result`

Запрос успешного выполнения:

```json
{
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "source": "manual",
  "portion_grams": 40.0,
  "actual_grams": 39.5,
  "status": "completed",
  "started_at": "2026-10-17T08:15:20Z",
  "finished_at": "2026-10-17T08:15:32Z",
  "error_code": null,
  "error_message": null
}
```

Для ошибки используются `status=failed`, соответствующий `error_code` и безопасное `error_message`; `actual_grams` может быть `null`, если измерение невозможно.

Успешный ответ `200 OK` как для первого приёма, так и для точного повтора:

```json
{
  "feeding_id": "ebc2fd74-7272-4c9e-a416-bdffde906913",
  "command_id": "1875723f-f6e1-4307-92c8-81577f1ea2fb",
  "status": "completed",
  "actual_grams": 39.5,
  "finished_at": "2026-10-17T08:15:32Z"
}
```

Ошибки: `400`, `401`, `403`, `404`, `409` при конфликтующем повторе или недопустимом переходе статуса, `500`, `503`.

### Отправить событие автоматического кормления

**Метод и путь:** `POST /api/v1/devices/{device_id}/feeding-events`

Запрос:

```json
{
  "feeding_id": "b01f6503-fad1-4d5d-b734-864159d9b1e6",
  "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
  "source": "scheduled",
  "portion_grams": 45.0,
  "actual_grams": 44.7,
  "status": "completed",
  "created_at": "2026-10-17T03:30:00Z",
  "started_at": "2026-10-17T03:30:00Z",
  "finished_at": "2026-10-17T03:30:14Z",
  "error_code": null,
  "error_message": null
}
```

Khadas создаёт `feeding_id` до локального выполнения и сохраняет его вместе с событием. При ошибке отправляется `status=failed`. Повтор с тем же идентификатором и содержимым безопасен.

Успешный ответ `201 Created` при первом приёме или `200 OK` при точном повторе:

```json
{
  "feeding_id": "b01f6503-fad1-4d5d-b734-864159d9b1e6",
  "device_id": "d6d174f4-e79f-49d1-9476-78bc99483752",
  "schedule_id": "36ee8225-cd00-46ea-b6ef-db9e66c0946b",
  "source": "scheduled",
  "status": "completed",
  "actual_grams": 44.7,
  "received_at": "2026-10-17T08:16:00Z"
}
```

Ошибки: `400`, `401`, `403`, `404` для неизвестного устройства или расписания, `409` при другом содержимом существующего `feeding_id`, `500`, `503`.

## Идемпотентность и доставка

- Уникальность ручной операции задаёт `command_id`; уникальность результата — `feeding_id`.
- Backend создаёт один `feeding_id` для ручной команды и возвращает его Android и Khadas.
- Khadas ведёт устойчивый журнал обработанных `command_id` и не запускает механизм повторно после перезапуска или повторной доставки.
- Автономное событие получает `feeding_id` на Khadas до исполнения и повторно отправляется с тем же значением до успешного ответа.
- Точный повтор возвращает существующий ресурс. Иное содержимое под тем же идентификатором — `409 CONFLICT`.
- Истёкшая ручная команда получает `expired` и не выполняется после восстановления сети.
- `pending` или `running` не означают успешную выдачу. Только `completed` с результатом Khadas подтверждает завершение.

## Авторизация

### Android-клиент

Android передаёт пользовательский access token в `Authorization: Bearer <token>` по HTTPS. Backend проверяет срок действия токена и доступ пользователя к указанному `device_id`. Конкретный провайдер идентификации, схема обновления токенов и модель пользователей требуют согласования.

### Устройство Khadas

Каждое устройство имеет отдельные отзываемые учётные данные и аутентифицируется по HTTPS. Минимальный вариант — `Authorization: Bearer <device_token>` с серверным хранением только защищённого представления секрета; предпочтительный окончательный механизм и ротация ключей требуют согласования. Идентичность токена должна совпадать с `device_id` в пути. Устройство не получает доступ к данным другого устройства.

Токены, пароли, приватные ключи, заполненные `.env` и иные секреты запрещено размещать в публичном репозитории, документации, примерах, логах и мобильном APK. В примерах используются только фиктивные значения.

## Параметры, требующие подтверждения

- допустимый диапазон и точность `portion_grams`/`actual_grams`;
- срок `expires_at` по умолчанию и максимальный срок ручной команды;
- интервалы опроса, лимиты пагинации и запросов;
- полный справочник `error_code` и состояния устройства;
- провайдер авторизации Android и механизм учётных данных Khadas;
- критерий `offline`, срок хранения истории и tombstone-записей расписаний;
- политика обработки переходов летнего времени для расписаний.
