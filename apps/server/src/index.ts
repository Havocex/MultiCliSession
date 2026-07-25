import 'dotenv/config';
import express from 'express';
import { chatRouter } from './chat-router.js';
import { libraryRouter } from './library-router.js';
import { productivityRouter } from './productivity-router.js';
import {
  exposeSessionToken,
  requireSessionToken,
  secureLocalApi,
} from './security.js';

const app = express();
app.disable('x-powered-by');
app.use(secureLocalApi);
app.use(express.json({ limit: '32mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/session', exposeSessionToken);
app.use('/api', requireSessionToken);
app.use('/api/chat', chatRouter);
app.use('/api/library', libraryRouter);
app.use('/api/productivity', productivityRouter);

const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`[chat-server] http://127.0.0.1:${port}`);
});

const shutdown = (signal: string) => {
  console.log(`[chat-server] ${signal}; finishing active connections.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
