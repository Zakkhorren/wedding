# Ручное внедрение RSVP API v2

## Готовые файлы

- **Полный Worker для ручной загрузки:** `worker/wedding-rsvp-api.js`. Самодостаточный ES Module, дополнительных импортов нет.
- **Миграция:** `worker/migrations/0001_rsvp_v2.sql`, под предоставленную схему `rsvp_responses`. Существующие ID, ответы и `edit_token_hash` сохраняются. Таблица ответов не пересоздаётся, `_cf_KV` не затрагивается.
- `worker/reference/wedding-rsvp-api.current.js` — точная копия переданного действующего исходника. `telegram-worker.js` — старый пример, для внедрения не использовать.
- `wedding-rsvp-api.source.mjs`, `test-admin.mjs`, `rsvp-policy.mjs`, `turnstile-verifier.mjs` — исходные модули; сборка: `node scripts/build-worker.mjs`.
- `rsvp-session.mjs` — адаптер ID/ключей/повторов/редактирования. Основной сайт его пока не загружает: **демо-режим сохранён**.
- `tests/manual-api.html` — отдельный технический стенд с Turnstile. Он не включён в навигацию сайта.

Действующие Worker, webhook, база и endpoint сайта автоматически не менялись. Никакие реальные анкеты агентом не удалялись и не отправлялись.

## 1. Локальные проверки

Проверено: Node 24, Wrangler 4.154.0 и поставляемый им Miniflare/workerd. Windows PowerShell:

```powershell
npm.cmd install --no-save --package-lock=false wrangler@4.154.0 playwright
npx.cmd playwright install chromium
node scripts/build-worker.mjs
node scripts/build-worker.mjs --without-test-deletes
node --test --test-concurrency=1 tests/*.test.mjs
node tests/miniflare-smoke.mjs
node tests/company-browser.cjs
```

Тесты используют временные локальные базы; Siteverify/Telegram подменены. Реальные API/бот и база не получают запросов. Miniflare проверяет доставляемый файл в workerd с локальным D1: batch, миграцию, триггеры, редактирование и каскадное удаление.

## 2. Изолированный облачный прогон

Рекомендуется отдельный тестовый Worker и отдельная копия D1. Это не замена и не пересоздание `wedding-rsvp-db`.

1. Сохранить резервную копию базы и текущего Worker. Копия исходника в Git не является резервной копией анкет.
2. Для Telegram использовать отдельного тестового бота либо пока ограничиться локальными моками. У бота один webhook: не переключать `@sonya_lesha_rsvp_bot` на тестовый адрес, пока рабочий бот нужен на прежнем.
3. Скопировать `worker/wrangler.example.jsonc` в игнорируемый Git файл `worker/wrangler.local.jsonc`, указать ID **тестовой** D1. В примере намеренно тестовые имена и нет реального database_id.
4. Для клона сначала восстановить схему/данные из резервной копии, затем применить миграцию. Пустой синтетический тест можно начать с `tests/fixtures/legacy-schema.sql`. Этот fixture **не запускать на существующей рабочей базе**.

## 3. Миграция существующей D1 после резервной копии

Для рабочей базы использовать отдельный локальный конфиг с `wedding-rsvp-api`, `wedding-rsvp-db`, правильным database_id и binding `DB`. Перед командой сверить целевую базу в выводе Wrangler.

```powershell
New-Item -ItemType Directory -Force .qa
npx.cmd wrangler d1 export DB --remote --output .qa/wedding-rsvp-before-v2.sql --config worker/wrangler.local.jsonc
npx.cmd wrangler d1 migrations list DB --remote --config worker/wrangler.local.jsonc
npx.cmd wrangler d1 migrations apply DB --remote --config worker/wrangler.local.jsonc
```

Это инструкция для будущего ручного выполнения, не уже выполненные действия. Экспорт содержит персональные данные: не публиковать. Wrangler применяет файл миграции транзакционно и откатывает его при ошибке. Не запускать ALTER-команды по одной в Dashboard и не применять файл повторно вручную.

Предварительная проверка только чтением:

```sql
PRAGMA table_info(rsvp_responses);
SELECT COUNT(*) AS answers FROM rsvp_responses;
SELECT COALESCE(SUM(cars_requested),0) AS approved_cars
FROM rsvp_responses WHERE parking_status='approved';
```

Если уже одобрено больше 8 машин или одобренные legacy-строки некорректны, миграция остановится без изменения ответов. Их не исправлять/удалять автоматически. `DROP TABLE rsvp_v2_migration_guard` удаляет только проверочную таблицу, созданную этим же файлом.

После миграции сверить прежнее число строк, `PRAGMA foreign_key_check`, `PRAGMA quick_check`. Новые таблицы: `rsvp_control`, `rsvp_requests`, `rsvp_outbox`, `telegram_updates`, `rsvp_admin_confirmations`.

## 4. Ручная загрузка кода

Cloudflare → Workers & Pages → выбранный **тестовый** Worker → Edit code → вставить целиком `worker/wedding-rsvp-api.js` → Save/Deploy. Для действующего Worker повторять только после проверки и вашего решения о замене.

| Имя | Тип | Значение |
|---|---|---|
| `DB` | D1 binding | выбранная мигрированная база |
| `ALLOWED_ORIGIN` | переменная | `https://zakkhorren.github.io`, без пути |
| `BOT_TOKEN` | Secret | токен соответствующего бота |
| `ADMIN_IDS` | Secret | числовые user ID администраторов через пробел/запятую |
| `WEBHOOK_SECRET` | Secret | длинный случайный секрет |
| `TURNSTILE_SECRET` | Secret | секрет виджета |
| `ENABLE_TEST_DELETIONS` | переменная | `false` по умолчанию, `true` только для тестирования |

Секреты вводить только в Cloudflare Settings → Variables and Secrets, не в GitHub/клиент/чат. Turnstile: Managed, hostname `zakkhorren.github.io`. Публичный sitekey вводится на стенде; action задан как `rsvp`. Сервер проверяет hostname/action.

Не включать Authorization и тела запросов в журналы, Logpush/аналитику/`wrangler tail`. Код не логирует входящие данные или ошибки с телом/ключом. Пример конфига отключает Observability; при её включении отдельно проверить редактирование чувствительных данных.

## 5. Cron и webhook

Добавить Cron `* * * * *` для повторной доставки очереди. Сохранение анкеты не зависит от Telegram. Доставка уведомлений — как минимум один раз: таймаут после фактической доставки может привести к повторному сообщению, но анкета/статистика не дублируются. В сообщениях есть стабильные ID и версия.

Webhook: путь `/telegram`, secret совпадает с `WEBHOOK_SECRET`, `allowed_updates` содержит `message` и `callback_query`. `drop_pending_updates:true` не используется.

Подготовлен `scripts/set-webhook.mjs`: читает `BOT_TOKEN`, `WEBHOOK_SECRET`, `WORKER_URL` только из локального окружения, не выводит секреты. `DRY_RUN=1` показывает только адрес и не отправляет запрос. После одобренного переключения выполнить `node scripts/set-webhook.mjs` с установленными переменными. **Для действующего бота пока не выполнять.** Не вводить токен в адресную строку браузера.

Сохранены `/start`, `/help`, `/stats`, `/guests`, `/drinks`, `/parking`, `/export`. Статистика больше не ограничена первыми 500 строками; legacy-анкеты без количества людей отмечаются отдельно. Напитки считаются по компаниям.

## 6. Реальные тестовые отправки без основной анкеты

После ручного развёртывания тестового Worker открыть `https://zakkhorren.github.io/wedding/tests/manual-api.html` (либо локально с соответствующими `ALLOWED_ORIGIN` и hostname Turnstile).

1. Ввести публичный URL тестового Worker с `/rsvp` и публичный sitekey. Telegram/Turnstile Secret на странице не нужны.
2. Создать компанию из 3 человек, выбрать напитки/парковку, пройти Turnstile, сохранить. Успех только по `saved:true` от базы.
3. Повторить отправку после потери сети: тот же ID, одна запись.
4. Конфиденциальную ссылку открыть в другом браузере, указать тот же API/sitekey, изменить 3 гостя на 2. Проверить Telegram и статистику.
5. В `/parking` проверить подтверждение, отказ, отмену, отказ при превышении 8. Изменение машин возвращает pending, только сообщение/напитки сохраняют одобрение.
6. При неизвестном исходе стенд блокирует изменение исходного payload и позволяет повтор с новым Turnstile. Загрузка записи явно принимает серверную версию.

Основная страница всё это время остаётся демо. **Не менять только `rsvpEndpoint`**: ей ещё нужно подключение адаптера, виджета и UI персональной ссылки отдельным этапом. Подробный контракт — [API-V2.md](API-V2.md).

## 7. Временное удаление

При `ENABLE_TEST_DELETIONS=true` доступны `/delete ID` и `/clear_test`. Обе команды сначала показывают предупреждение с отдельной кнопкой подтверждения. Токен связан с администратором/private-чатом/epoch, действует 5 минут и используется один раз.

- Удаление одной анкеты не затрагивает изменившуюся после вопроса ревизию.
- Очистка сохраняет записи, созданные или изменённые после предупреждения. Проверить остаток через `/stats`; при необходимости запросить новое подтверждение.
- Анкета, квитанции и очередь удаляются каскадно. Именных tombstone-записей нет; меняется общий epoch для защиты старых браузерных ID.
- Публичных маршрутов удаления нет. Административные удаления в реальной базе агент не выполнял.

После вашего **отдельного явного разрешения** на финальную очистку: выполнить подтверждённую очистку, проверить базу, выставить флаг `false`, загрузить `worker/wedding-rsvp-api.production.js`, затем удалить ненужную переменную. Сборка этого файла: `node scripts/build-worker.mjs --without-test-deletes`. В нём физически нет обработчиков `/delete` и `/clear_test`; старые кнопки этих команд не смогут выполнить действие. Отдельное подтверждаемое удаление одной анкеты `/erase ID` сохраняется согласно новому ТЗ. Этот файл подготовлен, но автоматически не загружается.

## 8. Откат и границы проверки

При проблеме кода можно временно вернуть предыдущую Worker-версию через Dashboard; добавленные столбцы ей не мешают. Сайт оставить демо. Старый Worker не поддерживает новые ключи/редактирование — это только временный откат сервиса. Восстановление данных из резервной копии/Time Travel — отдельное согласованное действие, не пересоздание базы.

Локальные тесты не проверяют реальные секреты, разрешения бота, delivery Telegram, webhook и виджет вашего Cloudflare. Их необходимо проверить после ручного развёртывания тестового сервера.

Официальные источники: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [setWebhook](https://core.telegram.org/bots/api#setwebhook), [Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/).


Обновление архива и точечное `/erase ID`: см. [ARCHIVE-ROLLOUT.md](ARCHIVE-ROLLOUT.md). В финальной сборке массового удаления нет.
