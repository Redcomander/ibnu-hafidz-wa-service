const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SERVICE_TOKEN = process.env.WA_SERVICE_TOKEN || 'change-me';
const SESSION_DIR = process.env.WA_SESSION_DIR || '.wwebjs';
const CHROME_BIN = process.env.WA_BROWSER_PATH || '/usr/bin/chromium';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const sessionStates = new Map();

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUserKey(userId) {
  if (userId === undefined || userId === null || userId === '') {
    return 'shared';
  }
  return String(userId).trim();
}

function getSessionState(userId) {
  const key = normalizeUserKey(userId);
  if (!sessionStates.has(key)) {
    const sessionDir = path.join(SESSION_DIR, key);
    const state = {
      key,
      qrData: null,
      isReady: false,
      lastError: null,
      lastConnectedAt: null,
      client: null,
    };

    state.client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: {
        headless: true,
        executablePath: fs.existsSync(CHROME_BIN) ? CHROME_BIN : undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    state.client.on('qr', (qr) => {
      state.qrData = qr;
      state.isReady = false;
      state.lastError = null;
      console.log(`[WA:${key}] QR generated, please scan with WhatsApp mobile app`);
    });

    state.client.on('ready', () => {
      state.qrData = null;
      state.isReady = true;
      state.lastError = null;
      state.lastConnectedAt = new Date().toISOString();
      console.log(`[WA:${key}] WhatsApp client is ready`);
    });

    state.client.on('auth_failure', (msg) => {
      state.isReady = false;
      state.lastError = msg?.message || 'WhatsApp auth failed';
      console.error(`[WA:${key}] Auth failure:`, state.lastError);
    });

    state.client.on('disconnected', () => {
      state.isReady = false;
      state.lastError = 'WhatsApp disconnected';
      console.warn(`[WA:${key}] WhatsApp disconnected`);
    });

    state.client.initialize();
    sessionStates.set(key, state);
  }

  return sessionStates.get(key);
}

async function simulateTyping(chat, text) {
  if (!chat || !text || !String(text).trim()) return;

  const safeText = String(text);
  const chars = safeText.length;
  const typingDuration = Math.min(8000, Math.max(1200, chars * 45 + randomBetween(500, 1500)));

  try {
    if (typeof chat.sendStateTyping === 'function') {
      chat.sendStateTyping();
    }

    await sleep(Math.max(400, typingDuration * 0.25));

    for (let i = 0; i < safeText.length; i += 1) {
      const charDelay = Math.max(35, randomBetween(35, 120));
      await sleep(charDelay);
      if (i % Math.max(1, Math.floor(safeText.length / 8)) === 0) {
        await sleep(randomBetween(20, 60));
      }
    }

    if (typeof chat.clearState === 'function') {
      chat.clearState();
    }
  } catch (error) {
    console.warn('Typing simulation failed:', error.message);
  }
}

function requireToken(req, res, next) {
  const token = req.headers['x-wa-service-token'] || req.headers['x-wa-token'];
  if (SERVICE_TOKEN && SERVICE_TOKEN !== 'change-me' && token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid WA service token' });
  }

  const userId = req.headers['x-user-id'] || req.headers['x-user'];
  req.userId = normalizeUserKey(userId);
  next();
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'wa-service' });
});

app.get('/api/wa/status', requireToken, (req, res) => {
  const state = getSessionState(req.userId);
  res.json({
    ok: true,
    ready: state.isReady,
    qr: state.qrData || null,
    last_connected_at: state.lastConnectedAt,
    error: state.lastError || null,
    user_id: req.userId,
  });
});

app.get('/api/wa/qr', requireToken, async (req, res) => {
  const state = getSessionState(req.userId);
  if (!state.qrData) {
    return res.status(404).json({ error: 'qr_not_ready', message: 'QR not generated yet' });
  }

  try {
    const dataUrl = await qrcode.toDataURL(state.qrData);
    return res.json({ ok: true, qr: dataUrl, user_id: req.userId });
  } catch (error) {
    return res.status(500).json({ error: 'qr_generation_failed', message: error.message });
  }
});

app.post('/api/wa/session/disconnect', requireToken, async (req, res) => {
  const state = getSessionState(req.userId);

  try {
    state.qrData = null;
    state.isReady = false;
    state.lastError = null;
    state.lastConnectedAt = null;

    if (state.client && typeof state.client.logout === 'function') {
      await state.client.logout();
    }

    return res.json({ ok: true, user_id: req.userId, message: 'WA session disconnected' });
  } catch (error) {
    return res.status(500).json({ error: 'disconnect_failed', message: error.message });
  }
});

app.post('/api/wa/send', requireToken, async (req, res) => {
  try {
    const { number, text } = req.body || {};
    const state = getSessionState(req.userId);

    if (!number || !text) {
      return res.status(400).json({ error: 'validation_error', message: 'number and text are required' });
    }

    if (!state.isReady || !state.client) {
      return res.status(503).json({ error: 'wa_not_ready', message: 'WhatsApp service is not connected yet' });
    }

    const cleanNumber = String(number).replace(/\D/g, '');
    if (!cleanNumber) {
      return res.status(400).json({ error: 'invalid_number', message: 'Invalid phone number' });
    }

    const normalized = cleanNumber.startsWith('62') ? cleanNumber : `62${cleanNumber}`;
    const chatId = `${normalized}@c.us`;

    const chat = await state.client.getChatById(chatId).catch(() => null);
    await simulateTyping(chat, String(text));
    await state.client.sendMessage(chatId, String(text));

    return res.json({ ok: true, message: 'Message sent successfully', to: normalized, user_id: req.userId });
  } catch (error) {
    const state = getSessionState(req.userId);
    state.lastError = error.message;
    return res.status(500).json({ error: 'send_failed', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`WA service running on http://localhost:${PORT}`);
});
