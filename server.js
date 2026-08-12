const fs = require('fs');
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

let qrData = null;
let isReady = false;
let lastError = null;
let lastConnectedAt = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    executablePath: fs.existsSync(CHROME_BIN) ? CHROME_BIN : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

function requireToken(req, res, next) {
  const token = req.headers['x-wa-service-token'] || req.headers['x-wa-token'];
  if (SERVICE_TOKEN && SERVICE_TOKEN !== 'change-me' && token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid WA service token' });
  }
  next();
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'wa-service' });
});

app.get('/api/wa/status', (_, res) => {
  res.json({
    ok: true,
    ready: isReady,
    qr: qrData || null,
    last_connected_at: lastConnectedAt,
    error: lastError || null,
  });
});

app.get('/api/wa/qr', async (_, res) => {
  if (!qrData) {
    return res.status(404).json({ error: 'qr_not_ready', message: 'QR not generated yet' });
  }

  try {
    const dataUrl = await qrcode.toDataURL(qrData);
    return res.json({ ok: true, qr: dataUrl });
  } catch (error) {
    return res.status(500).json({ error: 'qr_generation_failed', message: error.message });
  }
});

app.post('/api/wa/send', requireToken, async (req, res) => {
  try {
    const { number, text } = req.body || {};

    if (!number || !text) {
      return res.status(400).json({ error: 'validation_error', message: 'number and text are required' });
    }

    if (!isReady || !client) {
      return res.status(503).json({ error: 'wa_not_ready', message: 'WhatsApp service is not connected yet' });
    }

    const cleanNumber = String(number).replace(/\D/g, '');
    if (!cleanNumber) {
      return res.status(400).json({ error: 'invalid_number', message: 'Invalid phone number' });
    }

    const normalized = cleanNumber.startsWith('62') ? cleanNumber : `62${cleanNumber}`;
    const chatId = `${normalized}@c.us`;

    await client.sendMessage(chatId, String(text));

    return res.json({ ok: true, message: 'Message sent successfully', to: normalized });
  } catch (error) {
    lastError = error.message;
    return res.status(500).json({ error: 'send_failed', message: error.message });
  }
});

client.on('qr', (qr) => {
  qrData = qr;
  isReady = false;
  lastError = null;
  console.log('QR generated, please scan with WhatsApp mobile app');
});

client.on('ready', () => {
  qrData = null;
  isReady = true;
  lastError = null;
  lastConnectedAt = new Date().toISOString();
  console.log('WhatsApp client is ready');
});

client.on('auth_failure', (msg) => {
  isReady = false;
  lastError = msg?.message || 'WhatsApp auth failed';
  console.error('Auth failure:', lastError);
});

client.on('disconnected', () => {
  isReady = false;
  lastError = 'WhatsApp disconnected';
  console.warn('WhatsApp disconnected');
});

client.initialize();

app.listen(PORT, () => {
  console.log(`WA service running on http://localhost:${PORT}`);
});
