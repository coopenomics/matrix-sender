import express from 'express';
import { loadConfig } from './config';
import { MatrixClient } from './matrix-client';
import { registerTelegramCompatRoutes } from './telegram-routes';

const cfg = loadConfig();
const matrix = new MatrixClient(cfg.MATRIX_HOMESERVER_URL, {
  tokenCachePath: cfg.resolvedMatrixTokenCachePath,
  tokenCacheTtlMs: cfg.matrixTokenCacheTtlMs,
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

registerTelegramCompatRoutes(app, cfg, matrix);

app.listen(cfg.PORT, () => {
  console.log(`matrix-sender слушает порт ${cfg.PORT}`);
});
