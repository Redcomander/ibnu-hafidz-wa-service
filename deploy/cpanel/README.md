# Deploy WA Service ke cPanel

## Folder tujuan

Gunakan subdomain atau folder berikut:

- `wa.ibnuhafidz.ponpes.id`
- folder publik: `~/wa.ibnuhafidz.ponpes.id`

Atau kalau repo diterapkan di folder lain, sesuaikan `DEPLOY_DIR` / path repo cPanel.

## Jalankan deploy

```bash
cd ~/wa.ibnuhafidz.ponpes.id
export PATH=/opt/cpanel/ea-nodejs22/bin:$PATH
npm ci --omit=dev || npm install --omit=dev
npx pm2 restart wa-service || npx pm2 start server.js --name wa-service
npx pm2 save
curl -fsS http://localhost:3001/health
```

## Environment

Pastikan file `.env` ada, minimal:

```env
PORT=3001
WA_SERVICE_TOKEN=your_secure_token
WA_SESSION_DIR=.wwebjs
WA_BROWSER_PATH=/usr/bin/chromium
```

Jika cPanel tidak punya Chromium, install package atau gunakan path browser yang tersedia.

## Reverse proxy / subdomain

Untuk subdomain `wa.ibnuhafidz.ponpes.id`, arahkan ke folder aplikasi dan aktifkan node/PM2 process service. Jika perlu, gunakan proxy upstream ke `http://127.0.0.1:3001` di cPanel/Apache.
