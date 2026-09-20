'use strict';
/*
 * Indicator engine — faithful JS port of the RO6TF Pine Script logic.
 * All series are arrays ordered oldest -> newest; index 0 = oldest.
 */

const F = Number.isFinite;

/* ---------------- basic MAs ---------------- */

// Wilder RMA (Pine ta.rma): alpha = 1/len, SMA seed. NaN-aware.
function rma(src, len) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  if (n < len) return out;
  let f = -1, seed = 0;
  for (let i = len - 1; i < n; i++) {
    let ok = true;
    for (let j = i - len + 1; j <= i; j++) {
      if (!F(src[j])) { ok = false; break; }
      seed += src[j];
    }
    if (ok) { f = i; out[i] = seed / len; break; }
    seed = 0;
  }
  if (f < 0) return out;
  const a = 1 / len;
  for (let i = f + 1; i < n; i++) {
    out[i] = F(src[i]) ? a * src[i] + (1 - a) * out[i - 1] : out[i - 1];
  }
  return out;
}

// NaN-aware (Pine-like): result is NaN while the window contains any NaN
function sma(src, len) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (F(src[i])) { sum += src[i]; cnt++; }
    if (i >= len && F(src[i - len])) { sum -= src[i - len]; cnt--; }
    if (i >= len - 1 && cnt === len) out[i] = sum / len;
  }
  return out;
}

// NaN-aware: seeds with the first full finite window
function ema(src, len) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  if (n < len) return out;
  let f = -1;
  for (let i = len - 1; i < n; i++) {
    let ok = true;
    for (let j = i - len + 1; j <= i; j++) if (!F(src[j])) { ok = false; break; }
    if (ok) { f = i; break; }
  }
  if (f < 0) return out;
  let sum = 0;
  for (let j = f - len + 1; j <= f; j++) sum += src[j];
  let prev = sum / len;
  out[f] = prev;
  const a = 2 / (len + 1);
  for (let i = f + 1; i < n; i++) {
    if (F(src[i])) prev = a * src[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/* ---------------- oscillators ---------------- */

// Wilder RSI (Pine ta.rsi)
function rsi(close, len) {
  const n = close.length;
  const up = new Array(n).fill(0);
  const dn = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const ch = close[i] - close[i - 1];
    up[i] = ch > 0 ? ch : 0;
    dn[i] = ch < 0 ? -ch : 0;
  }
  const uA = rma(up, len);
  const dA = rma(dn, len);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const u = uA[i], d = dA[i];
    if (!F(u) || !F(d)) continue;
    out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  }
  return out;
}

function trueRange(h, l, c) {
  const n = c.length;
  const tr = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = h[i] - l[i];
    else tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return tr;
}

// ATR (Pine ta.atr = RMA of TR)
function atr(h, l, c, len) {
  return rma(trueRange(h, l, c), Math.max(2, len));
}

// RSI smoothing-MA curve — f_rsiCurvePack from the Pine script
function rsiCurve(close, { rsiLen = 14, maLen = 14 } = {}) {
  const r = rsi(close, rsiLen);
  const ma = sma(r, maLen);
  const n = close.length;
  const t = n - 1;
  const res = {
    rsi: r[t], ma: ma[t],
    slope: NaN, slopePrev: NaN,
    up: false, startUp: false, down: false,
    rsiAbove: false,
  };
  if (F(ma[t]) && F(ma[t - 1]) && F(ma[t - 2])) {
    const s = ma[t] - ma[t - 1];
    const s1 = ma[t - 1] - ma[t - 2];
    res.slope = s;
    res.slopePrev = s1;
    res.up = s > 0 && s > s1;            // "CURVE ↑"
    res.startUp = s > 0 && s1 <= 0;      // "START ↑"
    res.down = s < 0;
    res.rsiAbove = F(r[t]) && r[t] > ma[t];
  }
  return res;
}

// MACD (EMA-based, f_ma default)
function macd(close, fast = 12, slow = 26, sig = 9) {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const n = close.length;
  const line = new Array(n).fill(NaN);
  const hist = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (F(f[i]) && F(s[i])) line[i] = f[i] - s[i];
  }
  const sigArr = ema(line, sig);
  for (let i = 0; i < n; i++) {
    if (F(line[i]) && F(sigArr[i])) hist[i] = line[i] - sigArr[i];
  }
  const t = n - 1;
  return {
    hist: hist[t],
    rising: F(hist[t]) && F(hist[t - 1]) ? hist[t] > hist[t - 1] : false,
    histSeries: hist.slice(-90),
    lineSeries: line.slice(-150),
  };
}

// ADX (Pine ta.dmi with RMA smoothing)
function adx(h, l, c, len = 14) {
  const n = c.length;
  const tr = trueRange(h, l, c);
  const pDM = new Array(n).fill(0);
  const mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upM = h[i] - h[i - 1];
    const dnM = l[i - 1] - l[i];
    pDM[i] = (upM > dnM && upM > 0) ? upM : 0;
    mDM[i] = (dnM > upM && dnM > 0) ? dnM : 0;
  }
  const atrV = rma(tr, len);
  const pD = rma(pDM, len);
  const mD = rma(mDM, len);
  const pDI = new Array(n).fill(NaN);
  const mDI = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (F(atrV[i]) && atrV[i] > 0 && F(pD[i]) && F(mD[i])) {
      pDI[i] = 100 * pD[i] / atrV[i];
      mDI[i] = 100 * mD[i] / atrV[i];
    }
  }
  const dx = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!F(pDI[i]) || !F(mDI[i])) continue;
    const sum = pDI[i] + mDI[i];
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI[i] - mDI[i]) / sum;
  }
  const adxArr = rma(dx, len);
  const t = n - 1;
  return { adx: adxArr[t], plusDI: pDI[t], minusDI: mDI[t] };
}

// Stochastic RSI (Pine ta.stoch over RSI)
function stochRSI(close, { rsiLen = 14, stochLen = 14, kSmooth = 3, dSmooth = 3, floor = 5.0 } = {}) {
  const r = rsi(close, rsiLen);
  const n = close.length;
  const st = new Array(n).fill(NaN);
  for (let i = stochLen - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity, ok = true;
    for (let j = i - stochLen + 1; j <= i; j++) {
      if (!F(r[j])) { ok = false; break; }
      if (r[j] > hi) hi = r[j];
      if (r[j] < lo) lo = r[j];
    }
    if (ok && hi !== lo) st[i] = 100 * (r[i] - lo) / (hi - lo);
  }
  const k = sma(st, kSmooth);
  const d = sma(k, dSmooth);
  const t = n - 1;
  return { k: k[t], d: d[t], floorHit: F(k[t]) ? k[t] <= floor : false };
}

/* ---------------- pivots ---------------- */
// Pine ta.pivothigh / ta.pivotlow: pivot at p, confirmed at p + right.
// Returns Map(confirmedIndex -> pivotIndex)
function pivotHighs(h, left, right) {
  const n = h.length;
  const m = new Map();
  for (let p = left; p + right < n; p++) {
    const v = h[p];
    let ok = true;
    for (let i = 1; i <= left && ok; i++) if (h[p - i] >= v) ok = false;
    for (let i = 1; i <= right && ok; i++) if (h[p + i] >= v) ok = false;
    if (ok) m.set(p + right, p);
  }
  return m;
}

function pivotLows(l, left, right) {
  const n = l.length;
  const m = new Map();
  for (let p = left; p + right < n; p++) {
    const v = l[p];
    let ok = true;
    for (let i = 1; i <= left && ok; i++) if (l[p - i] <= v) ok = false;
    for (let i = 1; i <= right && ok; i++) if (l[p + i] <= v) ok = false;
    if (ok) m.set(p + right, p);
  }
  return m;
}

/* ---------------- liquidity (f_liqPack) ---------------- */
// latestType: 1 = latest pivot is SUPPORT, 2 = RESISTANCE, 0 = none active
function liquidity(h, l, c, left = 5, right = 2) {
  const n = c.length;
  const phs = pivotHighs(h, left, right);
  const pls = pivotLows(l, left, right);
  let support = NaN, resistance = NaN, latestType = 0;
  let supLevel = NaN, resLevel = NaN, supDist = NaN, resDist = NaN;
  let supActive = false, resActive = false;
  for (let t = 0; t < n; t++) {
    const plP = pls.get(t);
    const phP = phs.get(t);
    if (plP !== undefined) { support = l[plP]; latestType = 1; }
    if (phP !== undefined) { resistance = h[phP]; latestType = 2; }
    if (F(support) && l[t] < support) support = NaN;
    if (F(resistance) && h[t] > resistance) resistance = NaN;
    const sA = F(support) && support < c[t];
    const rA = F(resistance) && resistance > c[t];
    if (latestType === 1 && !sA) latestType = rA ? 2 : 0;
    else if (latestType === 2 && !rA) latestType = sA ? 1 : 0;
    else if (latestType === 0) latestType = sA ? 1 : rA ? 2 : 0;
    supActive = sA; resActive = rA;
    supLevel = sA ? support : NaN;
    resLevel = rA ? resistance : NaN;
    supDist = sA ? 100 * (c[t] - support) / c[t] : NaN;
    resDist = rA ? 100 * (resistance - c[t]) / c[t] : NaN;
  }
  return {
    latestType,
    support: supActive ? supLevel : null,
    supportDist: supActive ? supDist : null,
    resistance: resActive ? resLevel : null,
    resistanceDist: resActive ? resDist : null,
  };
}

/* ---------------- range oscillator (f_rangePack) ---------------- */
function rangeOsc(h, l, c, { rangeLength = 50, rangeMult = 2.0, atrLen = 2000 } = {}) {
  const n = c.length;
  const atrRaw = atr(h, l, c, Math.min(atrLen, Math.min(200, n - 1)))[n - 1];
  const rangeATR = F(atrRaw) ? atrRaw * rangeMult : NaN;
  const wma = (idx) => {
    let sw = 0, s = 0;
    for (let i = 0; i < rangeLength && idx - i >= 0; i++) {
      const ci = c[idx - i];
      const prev = idx - i - 1 >= 0 ? c[idx - i - 1] : ci;
      const delta = Math.abs(ci - prev);
      const w = prev !== 0 ? delta / prev : 0;
      s += ci * w;
      sw += w;
    }
    return sw !== 0 ? s / sw : NaN;
  };
  const t = n - 1;
  const oscAt = (idx) => {
    const ma = wma(idx);
    return F(ma) && F(rangeATR) && rangeATR !== 0 ? 100 * (c[idx] - ma) / rangeATR : NaN;
  };
  const ma = wma(t);
  const osc = oscAt(t);
  const oscPrev = oscAt(t - 1);
  const breakUp = F(ma) && F(rangeATR) && c[t] > ma + rangeATR;
  const slope = F(osc) && F(oscPrev) ? osc - oscPrev : NaN;
  const greenUp = breakUp && F(osc) && F(oscPrev) && osc > oscPrev;
  return { state: greenUp ? 1 : 0, slope: F(slope) ? slope : 0, osc: F(osc) ? osc : null, atr: F(atrRaw) ? atrRaw : null };
}

/* ---------------- Nadaraya-Watson envelope (f_nweCore) ---------------- */
function nwe(c, h, l, { bandwidth = 8.0, mult = 3.0, length = 499, touchPct = 0.15, flatPct = 0.02 } = {}) {
  const n = c.length;
  const smooth = (t) => {
    let s = 0, sw = 0;
    const lim = Math.min(length - 1, t);
    for (let i = 0; i <= lim; i++) {
      const w = Math.exp(-(i * i) / (bandwidth * bandwidth * 2));
      s += c[t - i] * w;
      sw += w;
    }
    return sw ? s / sw : NaN;
  };
  const maeAt = (t, out) => {
    const lim = Math.min(length - 1, t);
    let a = 0;
    for (let i = 0; i <= lim; i++) a += Math.abs(c[t - i] - out);
    return lim > 0 ? (a / lim) * mult : NaN;
  };
  const t = n - 1;
  const outT = smooth(t), outP = smooth(t - 1);
  if (!F(outT) || !F(outP)) return { code: 0, dir: 0, pos: 0 };
  const maeT = maeAt(t, outT), maeP = maeAt(t - 1, outP);
  const upperT = outT + maeT, lowerT = outT - maeT;
  const upperP = outP + maeP, lowerP = outP - maeP;
  const dir = outT > outP * (1 + flatPct / 100) ? 1 : outT < outP * (1 - flatPct / 100) ? -1 : 0;
  const tolU = Math.abs(upperT) * touchPct / 100;
  const tolL = Math.abs(lowerT) * touchPct / 100;
  const topTouch = h[t] >= upperT - tolU;
  const bottomTouch = l[t] <= lowerT + tolL;
  const topSignal = c[t] > upperT && c[t - 1] < upperP;
  const bottomSignal = c[t] < lowerT && c[t - 1] > lowerP;
  const pos = topSignal ? 3 : bottomSignal ? 4 : topTouch ? 1 : bottomTouch ? 2 : 0;
  return { code: (dir + 1) * 10 + pos, dir, pos, upper: upperT, lower: lowerT, out: outT };
}

/* ---------------- price action (f_paPack) ---------------- */
function paStructure(h, l, c, { swingLen = 50, internalLen = 4, discountMax = 0.35, premiumMin = 0.65 } = {}) {
  const n = c.length;
  const phs = pivotHighs(h, swingLen, internalLen);
  const pls = pivotLows(l, swingLen, internalLen);
  let lastHigh = NaN, prevHigh = NaN, lastLow = NaN, prevLow = NaN;
  let trend = 0, event = 0;
  for (let t = 0; t < n; t++) {
    event = 0;
    const phP = phs.get(t);
    const plP = pls.get(t);
    if (phP !== undefined) { prevHigh = lastHigh; lastHigh = h[phP]; }
    if (plP !== undefined) { prevLow = lastLow; lastLow = l[plP]; }
    const bullCross = F(lastHigh) && c[t] > lastHigh && c[t - 1] <= lastHigh;
    const bearCross = F(lastLow) && c[t] < lastLow && c[t - 1] >= lastLow;
    if (bullCross) {
      event = trend < 0 ? (F(prevLow) && F(lastLow) && lastLow > prevLow ? 3 : 2) : 1;
      trend = 1;
    } else if (bearCross) {
      event = trend > 0 ? (F(prevHigh) && F(lastHigh) && lastHigh < prevHigh ? -3 : -2) : -1;
      trend = -1;
    }
  }
  let location = 0;
  if (F(lastHigh) && F(lastLow) && lastHigh > lastLow) {
    const pos = (c[n - 1] - lastLow) / (lastHigh - lastLow);
    location = pos <= discountMax ? 1 : pos >= premiumMin ? 3 : 2;
  }
  return { trend, event, location, lastHigh: F(lastHigh) ? lastHigh : null, lastLow: F(lastLow) ? lastLow : null };
}

/* ---------------- PA S/R (f_paSRPack, 5M) ---------------- */
function paSR(h, l, c, { swingLen = 50, internalLen = 4, tolPct = 0.2, lookback = 120 } = {}) {
  const n = c.length;
  const phs = pivotHighs(h, swingLen, internalLen);
  const pls = pivotLows(l, swingLen, internalLen);
  let lastLow = NaN, lastHigh = NaN, supWidth = NaN, resWidth = NaN;
  let supConf = -1, resConf = -1;
  for (let t = 0; t < n; t++) {
    const phP = phs.get(t);
    const plP = pls.get(t);
    if (phP !== undefined) {
      lastHigh = h[phP];
      resWidth = Math.max(h[phP] - l[phP], 1e-12);
      resConf = t;
    }
    if (plP !== undefined) {
      lastLow = l[plP];
      supWidth = Math.max(h[plP] - l[plP], 1e-12);
      supConf = t;
    }
  }
  const build = (level, width, conf, isSup) => {
    if (!F(level)) return { level: null, width: null, touches: 0, strength: null, distPct: null, age: null };
    const tol = level * tolPct / 100;
    let touches = 0;
    const from = Math.max(0, n - lookback);
    for (let i = from; i < n; i++) {
      if (Math.abs(c[i] - level) <= tol) touches++;
    }
    const age = conf >= 0 ? n - 1 - conf : null;
    const strength = Math.min(100, 20 + Math.min(60, touches * 10) + Math.max(0, 20 - (age || 100) * 0.2));
    const distPct = c[n - 1] !== 0 ? Math.abs(c[n - 1] - level) / c[n - 1] * 100 : NaN;
    return { level, width: width, touches, strength, distPct, age };
  };
  return {
    sup: build(lastLow, supWidth, supConf, true),
    res: build(lastHigh, resWidth, resConf, false),
  };
}

/* ---------------- 5M quality bits (f_detail5) ---------------- */
function quality5(s, adxRes, { minADX = 20.0, volLen = 20, minVolRatio = 1.2, emaFast = 20, emaSlow = 50, atrLen = 14, minATRPercent = 0.05 } = {}) {
  const n = s.c.length;
  const t = n - 1;
  const volAvg = sma(s.v, volLen)[t];
  const volOK = F(volAvg) && volAvg !== 0 ? s.v[t] / volAvg >= minVolRatio : false;
  const adxOK = F(adxRes.adx) && adxRes.adx >= minADX;
  const candleOK = s.c[t] > s.o[t] && s.c[t] > s.h[t - 1];
  const eF = ema(s.c, emaFast);
  const eS = ema(s.c, emaSlow);
  const emaOK = F(eF[t]) && F(eS[t]) ? s.c[t] > eF[t] && eF[t] > eS[t] : false;
  const a = atr(s.h, s.l, s.c, atrLen)[t];
  const atrOK = F(a) && s.c[t] !== 0 ? 100 * a / s.c[t] >= minATRPercent : false;
  const mask = (adxOK ? 1 : 0) + (volOK ? 2 : 0) + (candleOK ? 4 : 0) + (emaOK ? 8 : 0) + (atrOK ? 16 : 0);
  const txt =
    (adxOK ? 'A' : '-') + (volOK ? 'V' : '-') + (candleOK ? 'C' : '-') + (emaOK ? 'E' : '-') + (atrOK ? 'T' : '-');
  return {
    mask, text: txt, adxOK, volOK, candleOK, emaOK, atrOK,
    emaFastSeries: eF.slice(-90),
    emaSlowSeries: eS.slice(-90),
  };
}

module.exports = {
  F, rma, sma, ema, rsi, atr, rsiCurve, macd, adx, stochRSI,
  pivotHighs, pivotLows, liquidity, rangeOsc, nwe, paStructure, paSR, quality5,
};
