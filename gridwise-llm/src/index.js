import 'dotenv/config';
import express from 'express';
import healthRouter from './routes/health.js';
import optimizeRouter from './routes/optimize.js';
import logger from './utils/logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// Request timeout (60s to comfortably accommodate LLM retries during high demand)
app.use((req, res, next) => {
  req.setTimeout(60000);
  res.setTimeout(60000);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use(healthRouter);
app.use(optimizeRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler (safe, no stack traces in production) ──────────────
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Internal server error'
  });
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`GridWise LLM server running on port ${PORT}`);
  logger.info(`Health: http://localhost:${PORT}/health`);
  logger.info(`Optimize: POST http://localhost:${PORT}/optimize-energy`);
});

export default app;
