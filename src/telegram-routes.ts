import type { Express, Request, Response } from 'express';
import type { AppConfig } from './config';
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

function parseSendBody(req: Request): { chatId: string; text: string } | null {
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
  return { chatId, text };
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
  cfg: AppConfig,
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

    try {
      const eventId = await matrix.sendTextToRoomRetry(
        parsed.chatId,
        parsed.text,
        cfg.MATRIX_USERNAME,
        cfg.MATRIX_PASSWORD
      );
      res.status(200).json(telegramOk(eventId, parsed.chatId, parsed.text));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Matrix request failed';
      res.status(502).json(telegramErr(`Bad Gateway: ${message}`, 502));
    }
  });
}
