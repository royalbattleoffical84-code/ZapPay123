# ZapPay Backend — Render par host karne ka guide

## Kya badla hai (Vercel se Render ke liye)
- `server.js`: ab Render par server khud port par listen karta hai (pehle production me listen nahi karta tha).
- `utils/checkoutUrlBuilder.js`: checkout ka domain ab `STORE_URL` env variable se aata hai, code me domain badalne ki zaroorat nahi.
- `vercel.json` hata diya, `render.yaml` jod diya.

## Steps
1. Is poore folder ko ek GitHub repo me daalo (package.json repo ke root me ho).
2. render.com → New → **Web Service** → apna repo choose karo.
3. Settings:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
4. **Environment** me ye variables daalo (`.env.example` dekho):
   - `NODE_ENV` = production
   - `FRONTEND_URL` = panel ka URL (e.g. https://panel.tumhara-domain.com)
   - `STORE_URL` = main domain (e.g. https://tumhara-domain.com)
   - `JWT_SECRET` = koi lamba random string
   - `ENCRYPTION_KEY` = **exactly 32 characters**
   - `ADMIN_SECRET` = wahi jo admin.html me `CHANGE_ME_ADMIN_SECRET` ki jagah daaloge
   - `CRON_SECRET` = koi random string
   - Saare `FIREBASE_*` (private key ko poora paste karo, `\n` ke saath)
   - `SMTP_*`
5. Deploy karo. URL milega jaise `https://zappay-backend.onrender.com`.
6. Test: browser me `https://tumhara-url.onrender.com/api/health` kholo, `{"status":"ok"...}` aana chahiye.
7. Ab frontend files me ye URL daalo (admin.html, check*.html, link/, store/, support/, main/, zappay-pay.js).

## Cron job (Vercel ka cron Render par nahi chalta)
Paytm pending orders verify karne ke liye roz ek baar ye URL hit karna hai:

`https://tumhara-url.onrender.com/api/cron/verify-paytm-orders?secret=TUMHARA_CRON_SECRET`

Free tarika: cron-job.org par free account banao, upar wala URL daalo, schedule = daily.

## Free plan ki limit
Render ka free web service 15 minute idle rehne par so jata hai, pehli request par 30-60 second lagte hain.
Payment gateway ke liye ye theek nahi hai. Paid plan lo ya cron-job.org se `/api/health` har 10 minute par ping karo.

## Security
- `.env` ko kabhi GitHub par mat daalo (.gitignore me hai).
- `ENCRYPTION_KEY` aur `JWT_SECRET` zaroor set karo, code me weak default hain.
