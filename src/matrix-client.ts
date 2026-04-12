import axios, { type AxiosInstance } from 'axios';
import {
  clearMatrixTokenFile,
  readMatrixTokenFile,
  writeMatrixTokenFileAtomic,
  type MatrixTokenFilePayload,
} from './matrix-token-file';

interface MatrixLoginResponse {
  user_id: string;
  access_token: string;
  device_id: string;
  home_server: string;
}

interface MatrixSendEventResponse {
  event_id: string;
}

function normalizeHomeserver(url: string): string {
  return url.replace(/\/+$/, '');
}

function matrixErrDetail(err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const st = err.response?.status;
  const data = err.response?.data;
  if (st === undefined) {
    return err.message || 'сеть / нет ответа';
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    const errcode = typeof o.errcode === 'string' ? o.errcode : '';
    const error = typeof o.error === 'string' ? o.error : '';
    const human = [errcode, error].filter(Boolean).join(' — ');
    if (human) {
      return `HTTP ${String(st)} (${human})`;
    }
  }
  if (data !== undefined) {
    try {
      return `HTTP ${String(st)} (${JSON.stringify(data)})`;
    } catch {
      return `HTTP ${String(st)}`;
    }
  }
  return `HTTP ${String(st)}`;
}

export interface MatrixClientOptions {
  /** Файл JSON с access_token (по умолчанию в cwd `.matrix-sender-token.json`). */
  tokenCachePath: string;
  /** Срок хранения токена после логина (Synapse часто ~1 год; по умолчанию 364 дня). */
  tokenCacheTtlMs: number;
}

/** Клиент Synapse по образцу MatrixApiService (controller chatcoop). */
export class MatrixClient {
  private readonly http: AxiosInstance;
  private readonly homeserverNorm: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private cacheUsername: string | null = null;

  constructor(
    homeserverUrl: string,
    private readonly opts: MatrixClientOptions
  ) {
    this.homeserverNorm = normalizeHomeserver(homeserverUrl);
    this.http = axios.create({
      baseURL: this.homeserverNorm,
      timeout: 15_000,
    });
  }

  async loginWithPassword(username: string, password: string): Promise<string> {
    try {
      const response = await this.http.post<MatrixLoginResponse>('/_matrix/client/r0/login', {
        type: 'm.login.password',
        user: username,
        password,
      });
      return response.data.access_token;
    } catch (err: unknown) {
      throw new Error(`Вход в Matrix не удался — ${matrixErrDetail(err)}`);
    }
  }

  private async ensureAccessToken(username: string, password: string): Promise<string> {
    const now = Date.now();
    if (
      this.cachedToken &&
      now < this.tokenExpiresAt &&
      this.cacheUsername === username &&
      this.tokenExpiresAt > 0
    ) {
      return this.cachedToken;
    }

    const fromDisk = await readMatrixTokenFile(this.opts.tokenCachePath);
    if (
      fromDisk &&
      normalizeHomeserver(fromDisk.homeserver_url) === this.homeserverNorm &&
      fromDisk.username === username &&
      fromDisk.expires_at_ms > now &&
      fromDisk.access_token.length > 0
    ) {
      this.cachedToken = fromDisk.access_token;
      this.tokenExpiresAt = fromDisk.expires_at_ms;
      this.cacheUsername = username;
      return fromDisk.access_token;
    }

    const token = await this.loginWithPassword(username, password);
    const expiresAt = now + this.opts.tokenCacheTtlMs;
    const payload: MatrixTokenFilePayload = {
      homeserver_url: this.homeserverNorm,
      username,
      access_token: token,
      expires_at_ms: expiresAt,
    };
    try {
      await writeMatrixTokenFileAtomic(this.opts.tokenCachePath, payload);
    } catch {
      /* файл кэша не обязателен для работы */
    }
    this.cachedToken = token;
    this.tokenExpiresAt = expiresAt;
    this.cacheUsername = username;
    return token;
  }

  async sendTextToRoom(roomId: string, body: string, username: string, password: string): Promise<string> {
    const accessToken = await this.ensureAccessToken(username, password);
    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    try {
      const response = await this.http.put<MatrixSendEventResponse>(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        { msgtype: 'm.text', body },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventId = response.data?.event_id;
      if (!eventId) {
        throw new Error('Matrix не вернул event_id');
      }
      return eventId;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        this.cacheUsername = null;
        await clearMatrixTokenFile(this.opts.tokenCachePath).catch(() => undefined);
        throw err;
      }
      const detail = matrixErrDetail(err);
      throw new Error(`Логин в Matrix прошёл, отправка в комнату «${roomId}» не удалась — ${detail}`);
    }
  }

  async sendTextToRoomRetry(roomId: string, body: string, username: string, password: string): Promise<string> {
    try {
      return await this.sendTextToRoom(roomId, body, username, password);
    } catch (first: unknown) {
      if (!axios.isAxiosError(first) || first.response?.status !== 401) {
        throw first instanceof Error ? first : new Error(String(first));
      }
      return await this.sendTextToRoom(roomId, body, username, password);
    }
  }
}
