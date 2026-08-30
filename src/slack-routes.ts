import type { Express, Request, Response } from 'express';
import type { ResolvedAppConfig } from './config';
import type { MatrixClient } from './matrix-client';

/**
 * Приём уведомлений в формате входящего вебхука Slack.
 *
 * Зачем отдельно от телеграм-совместимого маршрута: у Semaphore адрес Telegram
 * зашит в код (всегда api.telegram.org), переопределить его в настройках нечем,
 * и с блокировкой этих адресов уведомления о прогонах перестали доходить вовсе.
 * А вот адрес Slack-вебхука Semaphore берёт из настроек — значит его можно
 * направить сюда. Тот же приёмник подходит любому, кто умеет слать в Slack.
 */

interface SlackField {
  title?: unknown;
  value?: unknown;
  short?: unknown;
}

interface SlackAttachment {
  title?: unknown;
  title_link?: unknown;
  text?: unknown;
  pretext?: unknown;
  fallback?: unknown;
  color?: unknown;
  fields?: unknown;
}

function str(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  return '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Разметка Slack в человеческий вид: <http://ссылка|подпись> и <http://ссылка>.
 * Без этого в комнате висели бы угловые скобки с дублирующимся адресом.
 */
function unwrapSlackLinks(s: string): { text: string; html: string } {
  const text = s
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1');
  const html = escapeHtml(s)
    .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
    .replace(/&lt;(https?:\/\/[^&]+?)&gt;/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br/>');
  return { text, html };
}

/** Цвет вложения Slack — в значок: по нему видно исход, не читая текст. */
function colorMark(color: string): string {
  const c = color.toLowerCase();
  if (c === 'good' || c === '#36a64f') {
    return '✅ ';
  }
  if (c === 'danger' || c.startsWith('#ff') || c.startsWith('#e0')) {
    return '🔴 ';
  }
  if (c === 'warning') {
    return '⚠️ ';
  }
  return '';
}

/** Сообщение Slack → пара «простой текст, разметка» для Matrix. */
export function renderSlackPayload(body: unknown): { text: string; html: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const o = body as Record<string, unknown>;
  const textParts: string[] = [];
  const htmlParts: string[] = [];

  const top = str(o.text).trim();
  if (top) {
    const { text, html } = unwrapSlackLinks(top);
    textParts.push(text);
    htmlParts.push(html);
  }

  const attachments = Array.isArray(o.attachments) ? (o.attachments as SlackAttachment[]) : [];
  for (const att of attachments) {
    if (typeof att !== 'object' || att === null) {
      continue;
    }
    const mark = colorMark(str(att.color));
    const pretext = str(att.pretext).trim();
    const title = str(att.title).trim();
    const link = str(att.title_link).trim();
    // fallback берётся только если ни title, ни text нет: Semaphore кладёт туда
    // ту же строку, и без этого условия она задваивалась бы в сообщении.
    const attText = str(att.text).trim() || (title ? '' : str(att.fallback).trim());

    if (pretext) {
      const r = unwrapSlackLinks(pretext);
      textParts.push(r.text);
      htmlParts.push(r.html);
    }
    if (title) {
      const r = unwrapSlackLinks(title);
      textParts.push(`${mark}${r.text}`);
      htmlParts.push(
        link
          ? `${mark}<b><a href="${escapeHtml(link)}">${r.html}</a></b>`
          : `${mark}<b>${r.html}</b>`
      );
    }
    if (attText) {
      const r = unwrapSlackLinks(attText);
      textParts.push(r.text);
      htmlParts.push(r.html);
    }

    const fields = Array.isArray(att.fields) ? (att.fields as SlackField[]) : [];
    for (const f of fields) {
      if (typeof f !== 'object' || f === null) {
        continue;
      }
      const ft = str(f.title).trim();
      const fv = str(f.value).trim();
      if (!ft && !fv) {
        continue;
      }
      const rv = unwrapSlackLinks(fv);
      textParts.push(ft ? `${ft}: ${rv.text}` : rv.text);
      htmlParts.push(ft ? `<b>${escapeHtml(ft)}:</b> ${rv.html}` : rv.html);
    }
  }

  const text = textParts.filter(Boolean).join('\n').trim();
  if (!text) {
    return null;
  }
  return { text, html: htmlParts.filter(Boolean).join('<br/>') };
}

export function registerSlackRoutes(
  app: Express,
  cfg: ResolvedAppConfig,
  matrix: MatrixClient
): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    const pathToken = req.params.token;
    if (!pathToken || pathToken !== cfg.ACCESS_TOKEN) {
      res.status(401).json({ ok: false, error: 'неверный токен в пути' });
      return;
    }

    const rendered = renderSlackPayload(req.body);
    if (!rendered) {
      res.status(400).json({ ok: false, error: 'пустое сообщение: нужен text или attachments' });
      return;
    }

    // Комната: ?room=!abc:server или channel из тела (Slack-отправители часто
    // его шлют), иначе — комната по умолчанию.
    const fromQuery = typeof req.query.room === 'string' ? req.query.room.trim() : '';
    const fromBody = str((req.body as Record<string, unknown>)?.channel).trim();
    const candidate = fromQuery || fromBody;
    const room =
      candidate && (candidate.startsWith('!') || candidate.startsWith('#'))
        ? candidate
        : cfg.roomMap[candidate] ?? cfg.MATRIX_DEFAULT_ROOM ?? null;

    if (!room) {
      res.status(400).json({ ok: false, error: 'комната не задана: укажите ?room= или MATRIX_DEFAULT_ROOM' });
      return;
    }

    try {
      const eventId = await matrix.sendTextToRoomRetry(
        room,
        rendered.text,
        cfg.MATRIX_USERNAME,
        cfg.MATRIX_PASSWORD,
        rendered.html
      );
      // Slack отвечает голым "ok" — некоторые отправители сверяют именно тело.
      res.status(200).type('text/plain').send('ok');
      void eventId;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Matrix request failed';
      res.status(502).json({ ok: false, error: message });
    }
  };

  // Два пути к одному обработчику: короткий и похожий на настоящий адрес Slack —
  // некоторые отправители проверяют, что URL выглядит как hooks.slack.com/services/…
  app.post('/slack/:token', handler);
  app.post('/services/:token', handler);
}
