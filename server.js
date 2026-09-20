'use strict';
/*
 * RO6TF scanner — zero-dependency Node.js server.
 * Sources: Bitget USDT-M futures (default) | Binance spot feed (data-api mirror).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const I = require('./lib/indicators');
const F = I.F;

const PORT = parseInt(process.env.PORT || '8000', 10);
const SCAN_CACHE_MS = 5 * 60_000; // 5 min for V4
const LIST_CACHE_MS = 300_000;
const DETAIL_CACHE_MS = 15_000;
const CONCURRENCY = 6;

/* ================= http helpers ================= */

/* global request throttle (~12 req/s) + 429 backoff */
let __lastReq = 0;
async function __throttle() {
  const wait = __lastReq + 85 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  __lastReq = Date.now();
}

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await __throttle();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ro6tf-scanner/1.0' } });
      clearTimeout(timer);
      if (res.status === 429) throw new Error('http 429');
      if (res.status >= 500) throw new Error('http ' + res.status);
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const is429 = /429/.test(String(e.message || e));
      await new Promise((r) => setTimeout(r, (is429 ? 1200 : 300) * (i + 1)));
    }
  }
  throw lastErr;
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

/* ================= data sources ================= */

const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'AEUR', 'EUR', 'EURI', 'XUSD',
  'USD1', 'USDE', 'BFUSD', 'BUSD', 'PAX', 'PAXG', 'XAUT', 'WBTC', 'WBETH', 'USDS',
]);

const BINANCE = {
  id: 'binance',
  name: 'Binance (فید اسپات — تیکرهای بایننس)',
  base: 'https://data-api.binance.vision',
  async symbolList() {
    const j = await getJson(this.base + '/api/v3/ticker/24hr');
    return j
      .filter((t) => t.symbol.endsWith('USDT') && !STABLE_BASES.has(t.symbol.slice(0, -4)))
      .map((t) => ({ symbol: t.symbol, price: +t.lastPrice, change: +t.priceChangePercent, volume: +t.quoteVolume }))
      .sort((a, b) => b.volume - a.volume);
  },
  async klines(symbol, tf, limit) {
    const iv = { '1H': '1h', '15m': '15m', '5m': '5m', '3m': '3m', '1m': '1m' }[tf];
    const j = await getJson(`${this.base}/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${Math.min(limit, 1000)}`);
    if (!Array.isArray(j)) throw new Error('bad klines');
    return j
      .filter((k) => Array.isArray(k) && k.length >= 6)
      .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .sort((a, b) => a.t - b.t);
  },
};

const BITGET = {
  id: 'bitget',
  name: 'Bitget (فیوچرز USDT-M)',
  base: 'https://api.bitget.com',
  async symbolList() {
    const j = await getJson(this.base + '/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    if (j.code !== '00000') throw new Error('bitget tickers: ' + j.msg);
    return (j.data || [])
      .filter((r) => r.symbol.endsWith('USDT') && !STABLE_BASES.has(r.symbol.slice(0, -4)))
      .map((r) => ({ symbol: r.symbol, price: +r.lastPr, change: +r.change24h * 100, volume: +r.quoteVolume }))
      .sort((a, b) => b.volume - a.volume);
  },
  async klines(symbol, tf, limit) {
    const g = { '1H': '1H', '15m': '15m', '5m': '5m', '3m': '3m', '1m': '1m' }[tf];
    const j = await getJson(
      `${this.base}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${g}&limit=${Math.min(limit, 1000)}`
    );
    if (j.code !== '00000') throw new Error('bitget klines: ' + j.msg);
    return (j.data || [])
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .sort((a, b) => a.t - b.t);
  },
};

const SOURCES = { bitget: BITGET, binance: BINANCE };

/* ================= analysis ================= */

const TFS = [
  { tf: '1H', limit: 1000, tfMs: 3600e3 },
  { tf: '15m', limit: 400, tfMs: 900e3 },
  { tf: '5m', limit: 400, tfMs: 300e3 },
  { tf: '3m', limit: 400, tfMs: 180e3 },
  { tf: '1m', limit: 400, tfMs: 60e3 },
];

function dropForming(rows, tfMs) {
  const now = Date.now();
  if (rows.length && rows[rows.length - 1].t + tfMs > now) rows.pop();
  return rows;
}

function toSeries(rows) {
  return {
    t: rows.map((r) => r.t),
    o: rows.map((r) => r.o),
    h: rows.map((r) => r.h),
    l: rows.map((r) => r.l),
    c: rows.map((r) => r.c),
    v: rows.map((r) => r.v),
  };
}

async function fetchSeries(symbol, source) {
  const out = {};
  for (const { tf, limit, tfMs } of TFS) {
    const rows = dropForming(await source.klines(symbol, tf, limit), tfMs);
    out[tf] = toSeries(rows);
  }
  return out;
}

function paText(p) {
  const trTxt = p.trend > 0 ? '🟢 BULL' : p.trend < 0 ? '🔴 BEAR' : '🟡 NEUTRAL';
  const evTxt =
    p.event === 3 ? 'CHoCH+ ↑' : p.event === 2 ? 'CHoCH ↑' : p.event === 1 ? 'BOS ↑'
      : p.event === -3 ? 'CHoCH+ ↓' : p.event === -2 ? 'CHoCH ↓' : p.event === -1 ? 'BOS ↓' : '—';
  const locTxt = p.location === 1 ? 'D' : p.location === 2 ? 'EQ' : p.location === 3 ? 'P' : '—';
  return { text: `${trTxt} | ${evTxt} | ${locTxt}`, trend: p.trend, event: p.event, location: p.location };
}

function nweText(nw) {
  const dirTxt = nw.dir > 0 ? '🟢 صعودی' : nw.dir < 0 ? '🔴 نزولی' : '🟡 رنج';
  const posTxt =
    nw.pos === 3 ? ' | ⚠️ سقف + سیگنال' : nw.pos === 4 ? ' | ⚠️ کف + سیگنال'
      : nw.pos === 1 ? ' | ⚠️ خورده به سقف' : nw.pos === 2 ? ' | ⚠️ خورده به کف' : ' | بدون برخورد';
  return { text: dirTxt + posTxt, dir: nw.dir, pos: nw.pos };
}

function rsiCurveState(rc) {
  if (rc.startUp) return { state: 'start', label: '🟢 START ↑' };
  if (rc.up) return { state: 'curve', label: '🟢 CURVE ↑' };
  if (rc.down) return { state: 'down', label: '🔴 DOWN ↓' };
  return { state: 'flat', label: '— نیست' };
}

/* core analysis from pre-fetched series */
/* ───────── V4 CONFIG ───────── */
const V4 = {
  volThresh: 1.5,
  overbought: 75,
  spaceBlock: 1.0,
  spaceWarn: 1.5,
  adxReady: 23,
  adxMin: 20,
};

function analyzeSymbolFromSeries(symbol, S, btcTrend) {
  const s1h = S['1H'], s15 = S['15m'], s5 = S['5m'], s3 = S['3m'], s1 = S['1m'];

  const ro = {};
  for (const tf of ['1H', '15m', '5m', '3m', '1m']) ro[tf] = I.rangeOsc(S[tf].h, S[tf].l, S[tf].c).state;
  const roCount = ro['1H'] + ro['15m'] + ro['5m'] + ro['3m'] + ro['1m'];

  const rc1h = I.rsiCurve(s1h.c);
  const rc5 = I.rsiCurve(s5.c);
  const rc1 = I.rsiCurve(s1.c);

  const nw1h = I.nwe(s1h.c, s1h.h, s1h.l);
  const nw5 = I.nwe(s5.c, s5.h, s5.l);
  const nw1 = I.nwe(s1.c, s1.h, s1.l);

  const pa1h = I.paStructure(s1h.h, s1h.l, s1h.c);
  const pa15 = I.paStructure(s15.h, s15.l, s15.c);
  const pa5 = I.paStructure(s5.h, s5.l, s5.c);

  const macd5 = I.macd(s5.c);
  const adx5 = I.adx(s5.h, s5.l, s5.c, 14);
  const stoch5 = I.stochRSI(s5.c);
  const q5 = I.quality5(s5, adx5);
  const liq5 = I.liquidity(s5.h, s5.l, s5.c);
  const liq1 = I.liquidity(s1.h, s1.l, s1.c);
  const sr5 = I.paSR(s5.h, s5.l, s5.c);

  let space = null;
  if (F(liq5.resistanceDist)) space = liq5.resistanceDist;
  if (F(liq1.resistanceDist) && (space === null || liq1.resistanceDist < space)) space = liq1.resistanceDist;

  // volume ratio 5m
  const last = s5.v.length - 1;
  const volMaArr = I.sma(s5.v, 20);
  const volMa = volMaArr[last];
  const vol = s5.v[last];
  const volRatio = F(vol) && F(volMa) && volMa > 0 ? vol / volMa : null;

  // ---------- scoring base /10 ----------
  const up1h = rc1h.up || rc1h.startUp;
  const up5 = rc5.up || rc5.startUp;
  const up1 = rc1.up || rc1.startUp;
  const macdGreen = F(macd5.hist) && macd5.hist >= 0;
  const adxV = F(adx5.adx) ? adx5.adx : NaN;
  const liq5Sup = liq5.latestType === 1;
  const liq1Sup = liq1.latestType === 1;

  let score = 0;
  score += up1h ? 2 : 0;
  score += up5 ? 2 : 0;
  score += up1 ? 1 : 0;
  score += macdGreen ? 1.5 : 0;
  score += adxV >= V4.adxReady ? 1.5 : adxV >= V4.adxMin ? 0.75 : 0;
  score += liq5Sup ? 1 : 0;
  score += liq1Sup ? 1 : 0;

  // ---------- verdict V4 ----------
  const missing = [];
  const fails = [];
  const warns = [];

  if (!up1h) {
    if (rc1h.down) fails.push('کمان RSI ۱ساعته رو به پایین است');
    else missing.push('RSI ۱ساعته هنوز کمان صعودی ندارد');
    if (rc1h.rsiAbove === false) missing.push('در ۱ساعته خط صورتی زیر زرد MA است');
  }
  if (!up5) {
    if (rc5.down) missing.push('RSI ۵دقیقه‌ای پولبک');
    else missing.push('RSI ۵دقیقه‌ای کمان ندارد');
  } else if (rc5.rsiAbove === false) {
    missing.push('RSI ۵m هنوز بالای MA نیست');
  }
  if (!up1) missing.push('RSI ۱دقیقه‌ای کمان ندارد');

  if (!macdGreen) {
    if (macd5.rising) missing.push('MACD در حال سبز شدن');
    else fails.push('MACD ۵m سرخ و ریزشی');
  }
  if (adxV >= V4.adxReady) { }
  else if (adxV >= V4.adxMin) missing.push('ADX بین ۲۰ تا ۲۳ (' + adxV.toFixed(1) + ')');
  else fails.push('ADX زیر ۲۰ (' + (F(adxV) ? adxV.toFixed(1) : '—') + ') — روند ضعیف');

  if (!liq5Sup) {
    if (liq5.latestType === 2) fails.push('LIQ ۵m روی مقاومت');
    else missing.push('LIQ ۵m PIVOT حمایتی ندارد');
  }
  if (!liq1Sup) {
    if (liq1.latestType === 2) missing.push('LIQ ۱m روی مقاومت');
    else missing.push('LIQ ۱m PIVOT ندارد');
  }

  // ── V4 filters ──
  // BTC
  if (btcTrend) {
    if (btcTrend.down) {
      fails.push('BTC 5m نزولی - بازار آلت ریسکی');
    } else if (!btcTrend.rsiAbove && !btcTrend.up && !btcTrend.startUp) {
      missing.push('BTC 5m هنوز صعودی نشده');
    }
  }
  // VOL
  if (F(volRatio)) {
    if (volRatio < V4.volThresh) {
      missing.push('حجم ۵m ضعیف (' + volRatio.toFixed(2) + 'x < ' + V4.volThresh + 'x)');
    } else {
      score += 0.5; // bonus
    }
  } else {
    missing.push('حجم دیتا ندارد');
  }
  // Overbought RSI 1m
  if (F(rc1.rsi) && rc1.rsi > V4.overbought) {
    fails.push('RSI 1m Overbought ' + rc1.rsi.toFixed(1) + ' > ' + V4.overbought + ' - بالای قله');
  }
  // SPACE
  if (F(space)) {
    if (space < V4.spaceBlock) {
      fails.push('SPACE ' + space.toFixed(2) + '% < ' + V4.spaceBlock + '% - چسبیده به مقاومت');
      score -= 1.5;
    } else if (space < V4.spaceWarn) {
      missing.push('SPACE ' + space.toFixed(2) + '% کم (<'+V4.spaceWarn+'%) - نزدیک مقاومت');
      score -= 0.75;
    }
  }

  if (nw1h.dir < 0) warns.push('NWE ۱ساعته نزولی');
  if (pa1h.trend < 0) warns.push('ساختار ۱ساعته خرسی');
  if (liq5.latestType === 1 && liq1.latestType === 2) warns.push('تعارض نقدینگی: ۵m حمایت / ۱m مقاومت');
  if (F(space) && space < 0.3) warns.push('مقاومت خیلی نزدیک (' + space.toFixed(2) + '%)');

  score = Math.max(0, Math.min(10, Math.round(score * 4) / 4));

  let level;
  if (adxV < V4.adxMin) level = 'NO';
  else if (fails.length > 0) level = score >= 6.5 ? 'WAIT' : 'NO';
  else if (missing.length > 0) level = 'WAIT';
  else level = 'GO';

  const nweAligned = (nw1h.dir > 0 ? 1 : 0) + (nw5.dir > 0 ? 1 : 0) + (nw1.dir > 0 ? 1 : 0);
  const paAlign = (pa1h.trend > 0 ? 1 : 0) + (pa15.trend > 0 ? 1 : 0) + (pa5.trend > 0 ? 1 : 0);
  const price = s5.c[s5.c.length - 1];

  // exit logic
  const exit = (rc1.down) || (!macdGreen && !macd5.rising) || (liq1.latestType === 2) || (F(rc1.rsi) && rc1.rsi > V4.overbought);
  const exitReasons = [];
  if (rc1.down) exitReasons.push('RSI 1m DOWN');
  if (!macdGreen && !macd5.rising) exitReasons.push('MACD برگشت');
  if (liq1.latestType === 2) exitReasons.push('LIQ 1m RES');
  if (F(rc1.rsi) && rc1.rsi > V4.overbought) exitReasons.push('Overbought');

  return {
    symbol,
    price,
    score,
    level,
    missing,
    fails,
    warns,
    volRatio,
    vol,
    volMa,
    btc: btcTrend ? { rsi: btcTrend.rsi, ma: btcTrend.ma, up: btcTrend.up || btcTrend.startUp, down: btcTrend.down, above: btcTrend.rsiAbove } : null,
    exit,
    exitReasons,
    rsi: {
      '1H': { ...rsiCurveState(rc1h), rsi: rc1h.rsi, ma: rc1h.ma, rsiAbove: rc1h.rsiAbove, up: up1h, down: rc1h.down },
      '5m': { ...rsiCurveState(rc5), rsi: rc5.rsi, ma: rc5.ma, rsiAbove: rc5.rsiAbove, up: up5, down: rc5.down },
      '1m': { ...rsiCurveState(rc1), rsi: rc1.rsi, ma: rc1.ma, rsiAbove: rc1.rsiAbove, up: up1, down: rc1.down },
    },
    macd: { green: macdGreen, rising: macd5.rising, hist: F(macd5.hist) ? macd5.hist : null },
    adx: { value: F(adxV) ? adxV : null, plusDI: F(adx5.plusDI) ? adx5.plusDI : null, minusDI: F(adx5.minusDI) ? adx5.minusDI : null },
    liq: { '5m': liq5.latestType, '1m': liq1.latestType },
    liqDetail: {
      '5m': { type: liq5.latestType, support: liq5.support, supportDist: liq5.supportDist, resistance: liq5.resistance, resistanceDist: liq5.resistanceDist },
      '1m': { type: liq1.latestType, support: liq1.support, supportDist: liq1.supportDist, resistance: liq1.resistance, resistanceDist: liq1.resistanceDist },
    },
    ro,
    roCount,
    nwe: { '1H': nweText(nw1h), '5m': nweText(nw5), '1m': nweText(nw1) },
    pa: { '1H': paText(pa1h), '15m': paText(pa15), '5m': paText(pa5) },
    paSR: sr5,
    stoch5: { k: F(stoch5.k) ? stoch5.k : null, d: F(stoch5.d) ? stoch5.d : null, floor: stoch5.floorHit },
    quality5: q5.text,
    quality5Detail: { adxOK: q5.adxOK, volOK: q5.volOK, candleOK: q5.candleOK, emaOK: q5.emaOK, atrOK: q5.atrOK },
    space: F(space) ? space : null,
    nweAligned,
    paAlign,
  };
}

async function getBtcTrend(source) {
  try {
    const S = await fetchSeries('BTCUSDT', source);
    return I.rsiCurve(S['5m'].c);
  } catch (_) {
    return null;
  }
}

async function analyzeDetail(id, symbol) {
  const key = id + ':' + symbol + ':v4';
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.ts < DETAIL_CACHE_MS) return hit.data;
  const source = SOURCES[id];
  try { await ensureList(id, 800); } catch (_) { /* ignore */ }
  const row = state[id].list ? state[id].list.find((r) => r.symbol === symbol) : null;
  const S = await fetchSeries(symbol, source);
  const btcTrend = await getBtcTrend(source);
  const data = analyzeSymbolFromSeries(symbol, S, btcTrend);
  data.spark = {
    rsi1h: { rsi: I.rsi(S['1H'].c, 14).slice(-150), ma: I.sma(I.rsi(S['1H'].c, 14), 14).slice(-150) },
    rsi5: { rsi: I.rsi(S['5m'].c, 14).slice(-150), ma: I.sma(I.rsi(S['5m'].c, 14), 14).slice(-150) },
    rsi1: { rsi: I.rsi(S['1m'].c, 14).slice(-150), ma: I.sma(I.rsi(S['1m'].c, 14), 14).slice(-150) },
    macdHist: I.macd(S['5m'].c).histSeries,
    price5: {
      close: S['5m'].c.slice(-90),
      ema20: I.ema(S['5m'].c, 20).slice(-90),
      ema50: I.ema(S['5m'].c, 50).slice(-90),
    },
  };
  if (row) { data.change = row.change; data.volume = row.volume; }
  detailCache.set(key, { ts: Date.now(), data });
  return data;
}

/* ================= scan state ================= */

const state = {};
for (const id of Object.keys(SOURCES)) {
  state[id] = {
    list: null, listTs: 0,
    results: null, resultsTs: 0,
    running: false, done: 0, total: 0, n: 0,
    error: null,
  };
}
const detailCache = new Map();

async function ensureList(id, n) {
  const st = state[id];
  if (!st.list || Date.now() - st.listTs > LIST_CACHE_MS) {
    st.list = await SOURCES[id].symbolList();
    st.listTs = Date.now();
  }
  return st.list.slice(0, n);
}

async function pool(items, size, fn, onDone) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        results[i] = { symbol: items[i].symbol, error: true, errMsg: String(e.message || e) };
      }
      if (onDone) onDone();
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function runScan(id, n) {
  const st = state[id];
  if (st.running) return;
  st.running = true;
  st.error = null;
  try {
    const list = await ensureList(id, n);
    st.total = list.length;
    st.done = 0;
    st.n = list.length;
    // BTC trend once per scan
    const btcTrend = await getBtcTrend(SOURCES[id]);
    st.btcTrend = btcTrend;
    const results = await pool(list, CONCURRENCY, async (row) => {
      const S = await fetchSeries(row.symbol, SOURCES[id]);
      const data = analyzeSymbolFromSeries(row.symbol, S, btcTrend);
      data.change = row.change;
      data.volume = row.volume;
      return data;
    }, () => { st.done++; });
    st.results = { updatedAt: Date.now(), source: id, symbols: results, btcTrend };
    st.resultsTs = Date.now();
  } catch (e) {
    st.error = String(e.message || e);
  } finally {
    st.running = false;
  }
}

/* ================= server ================= */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/health') {
      return send(res, 200, { ok: true, ts: Date.now() });
    }
    if (u.pathname === '/api/scan') {
      const id = u.searchParams.get('source') === 'binance' ? 'binance' : 'bitget';
      const n = Math.max(10, Math.min(200, parseInt(u.searchParams.get('n') || '60', 10) || 60));
      const st = state[id];
      if (st.results && Date.now() - st.resultsTs < SCAN_CACHE_MS) {
        return send(res, 200, st.results);
      }
      if (!st.running) runScan(id, n);
      return send(res, 202, {
        running: st.running,
        done: st.done,
        total: st.total,
        error: st.error,
        source: id,
        updatedAt: st.results ? st.results.updatedAt : null,
      });
    }
    if (u.pathname === '/api/scan/progress') {
      const id = u.searchParams.get('source') === 'binance' ? 'binance' : 'bitget';
      const st = state[id];
      return send(res, 200, {
        running: st.running,
        done: st.done,
        total: st.total,
        error: st.error,
        updatedAt: st.results ? st.results.updatedAt : null,
        fresh: st.results ? Date.now() - st.resultsTs < SCAN_CACHE_MS : false,
      });
    }
    if (u.pathname === '/api/detail') {
      const id = u.searchParams.get('source') === 'binance' ? 'binance' : 'bitget';
      const symbol = (u.searchParams.get('symbol') || '').toUpperCase().trim();
      if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return send(res, 400, { error: 'invalid symbol' });
      const data = await analyzeDetail(id, symbol);
      return send(res, 200, data);
    }
    if (u.pathname === '/api/sources') {
      return send(res, 200, { sources: Object.values(SOURCES).map((s) => ({ id: s.id, name: s.name })) });
    }
    if (u.pathname === '/api/top6') {
      const id = u.searchParams.get('source') === 'binance' ? 'binance' : 'bitget';
      const n = Math.max(20, Math.min(200, parseInt(u.searchParams.get('n') || '80', 10) || 80));
      const st = state[id];
      if (!st.results) {
        if (!st.running) runScan(id, n);
        return send(res, 202, { running: st.running, done: st.done, total: st.total, message: 'اسکن در حال اجراست، ۱۰ ثانیه دیگر دوباره بزن' });
      }
      // if cache old but we have results, still return them (don't block)
      if (Date.now() - st.resultsTs > SCAN_CACHE_MS && !st.running) {
        runScan(id, n); // refresh in background
      }
      const all = st.results.symbols.filter(s => !s.error);
      // sort by score desc, then volume, then GO first
      const sorted = all.slice().sort((a,b) => {
        const lvA = a.level === 'GO' ? 2 : a.level === 'WAIT' ? 1 : 0;
        const lvB = b.level === 'GO' ? 2 : b.level === 'WAIT' ? 1 : 0;
        if (lvB !== lvA) return lvB - lvA;
        if (b.score !== a.score) return b.score - a.score;
        return (b.volume||0) - (a.volume||0);
      });
      const top6 = sorted.slice(0,6);
      const pineInputs = top6.map((s,i) => `sym${i+1} = input.string("${s.symbol}.P", "Symbol ${i+1}", group=groupSym) // ${s.score}/10 ${s.level} VOL ${s.volRatio? s.volRatio.toFixed(2)+'x':''}`).join('\n');
      const copyText = top6.map(s => s.symbol.replace('USDT','') + 'USDT.P').join(', ');
      const binanceSyms = top6.map(s => 'BINANCE:' + s.symbol.replace('.P','') + '.P').join(', ');
      return send(res, 200, {
        updatedAt: st.results.updatedAt,
        source: id,
        btcTrend: st.results.btcTrend || st.btcTrend,
        top6: top6.map(s => ({ symbol: s.symbol, price: s.price, score: s.score, level: s.level, volRatio: s.volRatio, change: s.change, space: s.space, adx: s.adx?.value, fails: s.fails, missing: s.missing })),
        pineInputs,
        copyText,
        binanceSyms,
        instruction: 'این ۶ تا رو کپی کن ببر تو تنظیمات TradingView واچ‌لیست (⚙️ → WATCHLIST)'
      });
    }
    // static files
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(__dirname, 'public', path.normalize(p).replace(/^([.][.][/\\])*/, ''));
    if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, { error: 'forbidden' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('RO6TF scanner listening on :' + PORT);
});
