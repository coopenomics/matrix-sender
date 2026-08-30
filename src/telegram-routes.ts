import type { Express, Request, Response } from 'express';
import type { ResolvedAppConfig } from './config';
import type { MatrixClient } from './matrix-client';

/** Первый сегмент пути до `/sendMessage` (Telegram `bot…:…` или любой секрет, напр. hex). */
const POST_SEND_MESSAGE_PATH = /^\/([^/]+)\/sendMessage\/?$/;

function bodyString(v: unknown): string | null {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  return null;
}

function parseSendBody(req: Request): { chatId: string; text: string; parseMode: string } | null {
  const chatRaw = bodyString(req.body?.chat_id);
  const textRaw = bodyString(req.body?.text);
  if (chatRaw === null || textRaw === null) {
    return null;
  }
  const chatId = chatRaw.trim();
  const text = textRaw;
  if (!chatId || !text) {
    return null;
  }
  const parseMode = (bodyString(req.body?.parse_mode) ?? '').trim();
  return { chatId, text, parseMode };
}

/**
 * Куда слать. Идентификатор комнаты (`!abc:server`) и алиас (`#alarm:server`)
 * проходят как есть; всё остальное считается числовым chat_id из мира Telegram и
 * ищется в сопоставлении, а при промахе уходит в комнату по умолчанию.
 *
 * Зачем: Alertmanager в `telegram_configs` держит `chat_id` целым числом и строку
 * туда положить нечем. Без этого пересыльщик был бы непригоден ровно для того,
 * ради чего заведён.
 */
function resolveRoom(chatId: string, cfg: ResolvedAppConfig): string | null {
  if (chatId.startsWith('!') || chatId.startsWith('#')) {
    return chatId;
  }
  return cfg.roomMap[chatId] ?? cfg.MATRIX_DEFAULT_ROOM ?? null;
}

/**
 * Текст для клиентов без HTML и для уведомления на телефоне. Alertmanager шлёт
 * разметку (`parse_mode: HTML`), и без очистки в списке комнат и в push'е висели
 * бы сырые теги.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function telegramOk(eventId: string, chatId: string, text: string) {
  return {
    ok: true as const,
    result: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId) || chatId, type: 'group' as const },
      text,
      matrix_event_id: eventId,
    },
  };
}

function telegramErr(description: string, status = 400) {
  return { ok: false as const, error_code: status, description };
}

export function registerTelegramCompatRoutes(
  app: Express,
  cfg: ResolvedAppConfig,
  matrix: MatrixClient
): void {
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send('ok');
  });

  app.post(POST_SEND_MESSAGE_PATH, async (req: Request, res: Response) => {
    const m = req.path.match(POST_SEND_MESSAGE_PATH);
    const pathToken = m?.[1];
    if (!pathToken || pathToken !== cfg.ACCESS_TOKEN) {
      res.status(401).json(telegramErr('Unauthorized: неверный токен в пути (должен совпадать с ACCESS_TOKEN)', 401));
      return;
    }

    const parsed = parseSendBody(req);
    if (!parsed) {
      res
        .status(400)
        .json(telegramErr('Bad Request: chat_id (id комнаты Matrix) и text (непустые строки) обязательны', 400));
      return;
    }

    const room = resolveRoom(parsed.chatId, cfg);
    if (!room) {
      res
        .status(400)
        .json(
          telegramErr(
            `Bad Request: для chat_id «${parsed.chatId}» не задана комната — добавьте её в MATRIX_ROOM_MAP ` +
              'или задайте MATRIX_DEFAULT_ROOM',
            400
          )
        );
      return;
    }

    const isHtml = parsed.parseMode.toLowerCase() === 'html';
    const body = isHtml ? stripHtml(parsed.text) : parsed.text;
    const formatted = isHtml ? parsed.text : undefined;

    try {
      const eventId = await matrix.sendTextToRoomRetry(
        room,
        body,
        cfg.MATRIX_USERNAME,
        cfg.MATRIX_PASSWORD,
        formatted
      );
      res.status(200).json(telegramOk(eventId, parsed.chatId, parsed.text));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Matrix request failed';
      res.status(502).json(telegramErr(`Bad Gateway: ${message}`, 502));
    }
  });
}
