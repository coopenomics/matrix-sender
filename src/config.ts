import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3780),
  MATRIX_HOMESERVER_URL: z.string().url(),
  MATRIX_USERNAME: z.string().min(1),
  MATRIX_PASSWORD: z.string().min(1),
  /** Сегмент пути `/ACCESS_TOKEN/sendMessage` (как `bot123:AA…` у Telegram или длинный hex). */
  ACCESS_TOKEN: z.string().min(1),
  /**
   * Комната по умолчанию: `!abc:server` или алиас `#alarm:server`. Нужна тем
   * отправителям, которые не умеют передавать идентификатор комнаты — Alertmanager
   * в `telegram_configs` требует `chat_id` целым числом и строку туда не положить.
   */
  MATRIX_DEFAULT_ROOM: z.string().min(1).optional(),
  /**
   * Сопоставление `chat_id` → комната, JSON вида `{"-1001234567":"!abc:server"}`.
   * Позволяет одному пересыльщику обслуживать несколько комнат при числовых
   * идентификаторах: тревоги в одну, отчёты в другую.
   */
  MATRIX_ROOM_MAP: z.string().optional(),
  /** Путь к JSON с access_token; по умолчанию `.matrix-sender-token.json` в cwd. */
  MATRIX_TOKEN_CACHE_PATH: z.string().min(1).optional(),
  /** Сколько дней считать токен валидным в кэше (Synapse ~год; по умолчанию 364). */
  MATRIX_TOKEN_CACHE_TTL_DAYS: z.coerce.number().int().positive().max(400).default(364),
});

export type AppConfig = z.infer<typeof envSchema>;

export type ResolvedAppConfig = AppConfig & {
  resolvedMatrixTokenCachePath: string;
  matrixTokenCacheTtlMs: number;
  roomMap: Record<string, string>;
};

/**
 * Разбор MATRIX_ROOM_MAP. Ошибка разбора роняет старт намеренно: пересыльщик с
 * молча пустым сопоставлением отправлял бы тревоги не туда (или никуда), а
 * заметили бы это тогда, когда тревога понадобится.
 */
function parseRoomMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MATRIX_ROOM_MAP — не JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MATRIX_ROOM_MAP должен быть объектом вида {"chat_id":"!room:server"}');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`MATRIX_ROOM_MAP: значение для «${k}» должно быть непустой строкой`);
    }
    out[k.trim()] = v.trim();
  }
  return out;
}

export function loadConfig(): ResolvedAppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Некорректные переменные окружения: ${JSON.stringify(msg)}`);
  }
  const data = parsed.data;
  const resolvedMatrixTokenCachePath =
    data.MATRIX_TOKEN_CACHE_PATH ?? path.join(process.cwd(), '.matrix-sender-token.json');
  const matrixTokenCacheTtlMs = data.MATRIX_TOKEN_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const roomMap = parseRoomMap(data.MATRIX_ROOM_MAP);
  return { ...data, resolvedMatrixTokenCachePath, matrixTokenCacheTtlMs, roomMap };
}
