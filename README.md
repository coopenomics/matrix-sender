# matrix-sender

Пересыльщик уведомлений в Matrix с интерфейсом Telegram Bot API. Всё, что умеет
слать сообщения в Telegram, шлёт их в комнату Matrix — достаточно подменить адрес
API, код отправителя не трогается.

Заведён потому, что уведомления в Telegram с наших узлов перестали доходить:
адреса блокируются, и Alertmanager сутками не может доставить тревогу. Тревога,
которая не дошла, хуже отсутствующей — она создаёт ложное чувство присмотра.

## Как отправить

```
POST /<ACCESS_TOKEN>/sendMessage
{"chat_id": "!room:server", "text": "сообщение", "parse_mode": "HTML"}
```

- `chat_id` — идентификатор комнаты (`!abc:server`), алиас (`#alarm:server`) или
  число. Число ищется в `MATRIX_ROOM_MAP`, при промахе уходит в
  `MATRIX_DEFAULT_ROOM`. Числа нужны для Alertmanager: в `telegram_configs` поле
  `chat_id` целое, и строку туда положить нечем.
- `parse_mode: HTML` — разметка уходит в `formatted_body`, а в `body` кладётся
  очищенный текст: его показывают клиенты без HTML и уведомления на телефоне.
- Ответ имитирует Telegram (`{"ok": true, "result": {…}}`) и добавляет
  `matrix_event_id`.

`GET /health` отвечает `ok`.

## Поведение

- **Токен доступа Matrix кэшируется** в файле и переиспользуется: логин по паролю
  на каждое сообщение Synapse не любит. При 401 кэш сбрасывается, вход
  повторяется.
- **Бот сам входит в комнату**, если получил 403 на отправке, и повторяет
  сообщение. Для закрытой комнаты вернётся внятная ошибка вместо тишины.
- **Алиас разрешается в идентификатор** комнаты и запоминается.

## Alertmanager

```yaml
receivers:
  - name: 'matrix_notifications'
    telegram_configs:
      - api_url: 'https://<домен пересыльщика>'
        bot_token: '<ACCESS_TOKEN без префикса bot>'
        chat_id: 1
        parse_mode: 'HTML'
        send_resolved: true
```

Alertmanager соберёт адрес как `<api_url>/bot<bot_token>/sendMessage`, поэтому
`ACCESS_TOKEN` пересыльщика должен начинаться с `bot`.

## Настройки

Смотри `.env.example`. Развёртывание — `playbooks/matrix-sender/setup.yaml`.
