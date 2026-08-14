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
const QR_TTL_MS = Number(process.env.WA_QR_TTL_MS || 300000);
const DEFAULT_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=Translate,BackForwardCache,InterestFeedContentSuggestions',
  '--disable-sync',
  '--disable-translate',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--metrics-recording-only',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--disable-hang-monitor',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-ipc-flooding-protection',
  '--renderer-process-limit=1',
  '--disable-features=AudioServiceOutOfProcess',
  '--memory-pressure-off',
];
const CHROME_ARGS = (process.env.WA_BROWSER_ARGS || '')
  ? [...DEFAULT_CHROME_ARGS, ...String(process.env.WA_BROWSER_ARGS).split(/\s+/).filter(Boolean)]
  : DEFAULT_CHROME_ARGS;

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
    return null;
  }

  const cleaned = String(userId).trim();
  return cleaned || null;
}

function createSessionState(key) {
  const sessionDir = path.join(SESSION_DIR, key);
  const state = {
    key,
    qrData: null,
    qrGeneratedAt: null,
    isReady: false,
    isAuthenticated: false,
    lastError: null,
    lastConnectedAt: null,
    client: null,
  };

  state.client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
    puppeteer: {
      headless: true,
      executablePath: fs.existsSync(CHROME_BIN) ? CHROME_BIN : undefined,
      args: CHROME_ARGS,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    },
  });

  state.client.on('qr', (qr) => {
    state.qrData = qr;
    state.qrGeneratedAt = Date.now();
    state.isReady = false;
    state.isAuthenticated = false;
    state.lastError = null;
    console.log(`[WA:${key}] QR generated, please scan with WhatsApp mobile app`);
  });

  state.client.on('ready', () => {
    state.qrData = null;
    state.isReady = true;
    state.isAuthenticated = true;
    state.lastError = null;
    state.lastConnectedAt = new Date().toISOString();
    console.log(`[WA:${key}] WhatsApp client is ready`);
  });

  state.client.on('authenticated', () => {
    state.qrData = null;
    state.isReady = false;
    state.isAuthenticated = true;
    state.lastError = null;
    console.log(`[WA:${key}] WhatsApp authentication succeeded, session is connected on the phone`);
  });

  state.client.on('auth_failure', (msg) => {
    state.isReady = false;
    state.isAuthenticated = false;
    state.lastError = msg?.message || 'WhatsApp auth failed';
    console.error(`[WA:${key}] Auth failure:`, state.lastError);
  });

  state.client.on('disconnected', () => {
    state.isReady = false;
    state.isAuthenticated = false;
    state.lastError = 'WhatsApp disconnected';
    console.warn(`[WA:${key}] WhatsApp disconnected`);
  });

  state.client.initialize();
  return state;
}

function getSessionState(userId) {
  const key = normalizeUserKey(userId);
  if (!sessionStates.has(key)) {
    sessionStates.set(key, createSessionState(key));
  }

  return sessionStates.get(key);
}

function rotateStaleQR(userId) {
  const key = normalizeUserKey(userId);
  if (!key) return null;

  const state = getSessionState(key);
  if (!state || state.isReady || state.isAuthenticated) return state;

  const now = Date.now();
  if (!state.qrGeneratedAt || now - state.qrGeneratedAt <= QR_TTL_MS) {
    return state;
  }

  console.log(`[WA:${key}] QR expired after ${QR_TTL_MS}ms, recreating session`);
  return recreateSessionState(key);
}

function recreateSessionState(userId) {
  const key = normalizeUserKey(userId);
  const existing = sessionStates.get(key);

  if (existing && existing.client && typeof existing.client.destroy === 'function') {
    try {
      existing.client.destroy();
    } catch (error) {
      console.warn(`[WA:${key}] destroy failed:`, error.message);
    }
  }

  try {
    fs.rmSync(path.join(SESSION_DIR, key), { recursive: true, force: true });
  } catch (error) {
    console.warn(`[WA:${key}] session cleanup failed:`, error.message);
  }

  const nextState = createSessionState(key);
  sessionStates.set(key, nextState);
  return nextState;
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
  const normalizedUserId = normalizeUserKey(userId);
  if (!normalizedUserId) {
    return res.status(401).json({
      error: 'missing_user_id',
      message: 'X-User-ID header is required to bind the WA session to the authenticated user',
    });
  }

  req.userId = normalizedUserId;
  next();
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'wa-service' });
});

app.get('/api/wa/status', requireToken, (req, res) => {
  const state = rotateStaleQR(req.userId) || getSessionState(req.userId);

  res.json({
    ok: true,
    ready: !!(state?.isReady || state?.isAuthenticated),
    connected: !!(state?.isReady || state?.isAuthenticated),
    qr: state?.qrData || null,
    last_connected_at: state?.lastConnectedAt || null,
    error: state?.lastError || null,
    user_id: req.userId,
  });
});

app.get('/api/wa/qr', requireToken, async (req, res) => {
  const state = rotateStaleQR(req.userId) || getSessionState(req.userId);

  if (!state || !state.qrData) {
    return res.json({ ok: true, qr: null, user_id: req.userId, error: null });
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

    recreateSessionState(req.userId);

    return res.json({ ok: true, user_id: req.userId, message: 'WA session disconnected', refreshed: true });
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
