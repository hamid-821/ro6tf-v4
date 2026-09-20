# RO6TF V4 — دیپلوی رایگان (لینک دائمی برای کروم)

## گزینه 1: Render.com (پیشنهادی - 2 دقیقه، بدون کارت)
1. برو https://render.com → Sign up با GitHub
2. New + → Web Service → Connect کن همین پوشه `ro6tf` رو از GitHub
   - اگر هنوز رو GitHub نیست: تو همین پوشه `git init`, `git add .`, `git commit`, بعد Push به GitHub
3. تنظیمات:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
4. Create → بعد 1 دقیقه لینک میده مثلا `https://ro6tf-v4.onrender.com`
5. اون لینک رو تو کروم بوکمارک کن → همیشه کار میکنه
   - `/api/top6?source=bitget&n=80` هم همونجا کار میکنه بدون ارور توکن

## گزینه 2: Vercel (سریع‌تر ولی نیاز به vercel.json)
1. برو https://vercel.com → Import Project → همین ریپو رو انتخاب کن
2. Deploy → لینک میده `https://ro6tf-v4.vercel.app`
3. نکته: Vercel Serverlessه، اولین درخواست 3-4 ثانیه طول میکشه (Cold Start) طبیعیه

## گزینه 3: Railway / Fly.io / Koyeb
همه‌شون `npm start` رو میشناسن، کافیه ریپو رو وصل کنی.

## فایل‌های آماده
- `package.json` → برای همه هاست‌ها
- `server.js` → الان از `process.env.PORT` استفاده میکنه (برای هاست رایگان لازمه)
- `public/index.html` → فرانت V4 با دکمه 6 تا برتر
- `vercel.json` + `render.yaml` → کانفیگ آماده

## بعد از دیپلوی
لینک اصلی: `https://YOUR-APP.onrender.com`
لینک 6 تا برتر: `https://YOUR-APP.onrender.com/api/top6?source=bitget&n=60`

اینو ببر بذار تو TradingView؟ نه، فقط برای دیدن لیست. برای TradingView باید کد Pine داخل همون صفحه رو کپی کنی.

## اگر خواستی من برات دیپلوی کنم
کافیه GitHub Repo بسازی و لینکشو بهم بدی، من همینجا Push میکنم و Render رو کانکت میکنم.
