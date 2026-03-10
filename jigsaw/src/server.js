import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';
import { seedBuiltinImages } from './seedImages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
});
app.use(sessionMiddleware);

import { setupAuth } from './auth.js';
setupAuth(app);

// Static files
app.use(express.static(join(__dirname, '..', 'public')));

// Serve puzzle images
app.use('/puzzle-images', express.static(join(__dirname, '..', 'puzzle images')));
app.use('/uploads', express.static(join(__dirname, '..', 'uploads')));

// Seed built-in images
seedBuiltinImages();

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

server.listen(PORT, () => {
  console.log(`Jigsaw server running on port ${PORT}`);
});

export { app, server, wss, sessionMiddleware };
