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
  /** Путь к JSON с access_token; по умолчанию `.matrix-sender-token.json` в cwd. */
  MATRIX_TOKEN_CACHE_PATH: z.string().min(1).optional(),
  /** Сколько дней считать токен валидным в кэше (Synapse ~год; по умолчанию 364). */
  MATRIX_TOKEN_CACHE_TTL_DAYS: z.coerce.number().int().positive().max(400).default(364),
});

export type AppConfig = z.infer<typeof envSchema>;

export type ResolvedAppConfig = AppConfig & {
  resolvedMatrixTokenCachePath: string;
  matrixTokenCacheTtlMs: number;
};

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
  return { ...data, resolvedMatrixTokenCachePath, matrixTokenCacheTtlMs };
}
