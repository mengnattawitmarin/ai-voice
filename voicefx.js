/* Gen Medi — Voice Changer engine (runs fully on the device, free, no API).
   Spectral voice conversion: STFT phase vocoder + cepstral spectral envelope,
   so pitch (how high the voice is) and formants (the size of the "throat" —
   what makes a voice sound male/female/child) can be moved independently.
   On top: robot / whisper resynthesis, vibrato, and a Web Audio effect rack
   (filters, distortion, ring-mod, comb, echo, reverb, bit-crush, noise). */
(() => {
  'use strict';
  const SR = 24000;               // voice output rate (keeps files small, full speech band)
  const TAU = Math.PI * 2;

  /* ---------- FFT (radix-2, in place) ---------- */
  const fftCache = {};
  function fftPlan(N){
    if (fftCache[N]) return fftCache[N];
    const rev = new Uint32Array(N), bits = Math.log2(N);
    for (let i = 0; i < N; i++){ let r = 0; for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1); rev[i] = r; }
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++){ cos[i] = Math.cos(TAU * i / N); sin[i] = Math.sin(TAU * i / N); }
    return (fftCache[N] = {rev, cos, sin});
  }
  function fft(re, im, inv){
    const N = re.length, {rev, cos, sin} = fftPlan(N);
    for (let i = 0; i < N; i++){ const j = rev[i]; if (j > i){ let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1){
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size){
        for (let j = 0, k = 0; j < half; j++, k += step){
          const wr = cos[k], wi = inv ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inv) for (let i = 0; i < N; i++){ re[i] /= N; im[i] /= N; }
  }

  /* ---------- spectral voice conversion ---------- */
  // o: {p: pitch factor, f: formant factor, robot, whisper, vibD, vibR}
  function spectral(x, sr, o){
    const N = sr > 32000 ? 2048 : 1024, H = N / 4, OS = N / H, half = N / 2;
    const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / N);
    const len = x.length, pad = new Float32Array(len + 2 * N); pad.set(x, N);
    const out = new Float32Array(len + 2 * N);
    const re = new Float64Array(N), im = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N);
    const lastPh = new Float64Array(half + 1), sumPh = new Float64Array(half + 1);
    const mag = new Float64Array(half + 1), tb = new Float64Array(half + 1), env = new Float64Array(half + 1);
    const sM = new Float64Array(half + 1), sB = new Float64Array(half + 1);
    const expct = TAU * H / N, L = Math.max(10, Math.floor(sr / 520)), norm = 1 / 1.5;
    const p0 = o.p || 1, f = o.f || 1, vibD = o.vibD || 0, vibR = o.vibR || 5;
    let rnd = 12345; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let pos = 0; pos + N <= pad.length; pos += H){
      for (let i = 0; i < N; i++){ re[i] = pad[pos + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k <= half; k++){
        const m = Math.hypot(re[k], im[k]), ph = Math.atan2(im[k], re[k]);
        let d = ph - lastPh[k]; lastPh[k] = ph; d -= k * expct;
        d -= TAU * Math.round(d / TAU);
        mag[k] = m; tb[k] = k + d * OS / TAU;
      }
      // spectral envelope by cepstral liftering
      for (let k = 0; k < N; k++){ const kk = k <= half ? k : N - k; cr[k] = Math.log(mag[kk] + 1e-7); ci[k] = 0; }
      fft(cr, ci, true);
      for (let n = L; n <= N - L; n++){ cr[n] = 0; ci[n] = 0; }
      fft(cr, ci, false);
      for (let k = 0; k <= half; k++) env[k] = Math.exp(cr[k]);
      // move the fine structure (pitch)
      const t = pos / sr, p = p0 * (1 + vibD * Math.sin(TAU * vibR * t));
      sM.fill(0); sB.fill(0);
      for (let k = 0; k <= half; k++){
        const j = Math.round(k * p); if (j > half) break;
        sM[j] += mag[k] / env[k]; sB[j] = tb[k] * p;
      }
      // re-apply envelope stretched by formant factor, rebuild phase
      for (let k = 0; k <= half; k++){
        const src = k / f, i0 = Math.floor(src), fr = src - i0;
        const e = i0 >= half ? env[half] * 0.05 : env[i0] * (1 - fr) + env[i0 + 1] * fr;
        const M = sM[k] * e;
        let ph;
        if (o.robot) ph = 0;
        else if (o.whisper) ph = rand() * TAU;
        else { sumPh[k] += (sB[k] - k) * TAU / OS + k * expct; ph = sumPh[k]; }
        re[k] = M * Math.cos(ph); im[k] = M * Math.sin(ph);
        if (k > 0 && k < half){ re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      im[0] = 0; im[half] = 0;
      fft(re, im, true);
      for (let i = 0; i < N; i++) out[pos + i] += re[i] * win[i] * norm;
    }
    return out.subarray(N, N + len);
  }

  /* ---------- helpers ---------- */
  async function decodeAt(blob, rate){
    const ab = await blob.arrayBuffer();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, 1, rate);
    const buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); p && p.catch && p.catch(rej); });
    const n = buf.length, out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++){ const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
    return {data: out, rate: buf.sampleRate};
  }
  function wav(x, rate){
    const len = x.length, buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++){ const s = Math.max(-1, Math.min(1, x[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], {type: 'audio/wav'});
  }
  function crush(x, bits, hold){
    const q = Math.pow(2, bits - 1); let h = 0;
    for (let i = 0; i < x.length; i++){ if (i % hold === 0) h = Math.round(x[i] * q) / q; x[i] = h; }
  }
  function impulse(ctx, sec, decay){
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++){ const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay || 2.5); }
    return b;
  }
  function curve(amt){
    const k = amt * 60, n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++){ const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  }

  /* ---------- effect rack (Web Audio, offline) ---------- */
  async function rack(x, rate, e){
    const tail = Math.max(e.rev ? e.rev.sec : 0, e.echo ? e.echo.t * 6 : 0, e.comb ? 0.2 : 0) + 0.05;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, Math.ceil(x.length + tail * rate), rate);
    const b = ctx.createBuffer(1, x.length, rate); b.getChannelData(0).set(x);
    const src = ctx.createBufferSource(); src.buffer = b;
    let node = src;
    const link = n => { node.connect(n); node = n; return n; };
    if (e.ring){
      const dry = ctx.createGain(), wet = ctx.createGain(), mod = ctx.createGain(), sum = ctx.createGain(), osc = ctx.createOscillator();
      dry.gain.value = 1 - e.ring.mix; wet.gain.value = e.ring.mix * 1.4; mod.gain.value = 0;
      osc.frequency.value = e.ring.freq; osc.connect(mod.gain); osc.start();
      node.connect(dry); node.connect(mod); mod.connect(wet); dry.connect(sum); wet.connect(sum); node = sum;
    }
    const filt = [];
    const bq = (type, freq, Q, gain) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (Q != null) f.Q.value = Q; if (gain != null) f.gain.value = gain; filt.push(f); return f; };
    if (e.hp) link(bq('highpass', e.hp, 0.7));
    if (e.bp){ link(bq('highpass', e.bp[0], 0.9)); link(bq('lowpass', e.bp[1], 0.9)); }
    if (e.lp) link(bq('lowpass', e.lp, 0.7));
    if (e.shelf) link(bq('lowshelf', e.shelf[0], null, e.shelf[1]));
    if (e.peak) link(bq('peaking', e.peak[0], e.peak[2] || 1, e.peak[1]));
    if (e.dist){ const ws = ctx.createWaveShaper(); ws.curve = curve(e.dist); ws.oversample = '2x'; link(ws); const g = ctx.createGain(); g.gain.value = 1 / (1 + e.dist * 1.5); link(g); }
    if (e.noise){
      const n = ctx.length, nb = ctx.createBuffer(1, n, rate), d = nb.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * e.noise * (Math.random() < 0.002 ? 6 : 1);
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = e.bp ? e.bp[0] : 300;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = e.bp ? e.bp[1] : 5000;
      ns.connect(hp); hp.connect(lp); lp.connect(node); ns.start();
    }
    if (e.comb){
      const sum = ctx.createGain(), dry = ctx.createGain(), d = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain();
      d.delayTime.value = e.comb.ms / 1000; fb.gain.value = e.comb.fb; wet.gain.value = e.comb.mix; dry.gain.value = 1;
      node.connect(dry); node.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); dry.connect(sum); wet.connect(sum); node = sum;
    }
    const bus = ctx.createGain(); node.connect(bus);
    if (e.echo){
      const d = ctx.createDelay(2), fb = ctx.createGain(), wet = ctx.createGain(), lp = ctx.createBiquadFilter();
      d.delayTime.value = e.echo.t; fb.gain.value = e.echo.fb; wet.gain.value = e.echo.mix; lp.type = 'lowpass'; lp.frequency.value = 3500;
      node.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(bus);
    }
    if (e.rev){
      const cv = ctx.createConvolver(), wet = ctx.createGain();
      cv.buffer = impulse(ctx, e.rev.sec, e.rev.decay); wet.gain.value = e.rev.mix;
      node.connect(cv); cv.connect(wet); wet.connect(bus);
    }
    let last = bus;
    if (e.comp){
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = e.comp === 2 ? -30 : -22; c.ratio.value = e.comp === 2 ? 8 : 4; c.attack.value = 0.004; c.release.value = 0.18; c.knee.value = 8;
      last.connect(c); last = c;
    }
    last.connect(ctx.destination); src.start();
    const r = await ctx.startRendering();
    return r.getChannelData(0);
  }

  /* ---------- presets ---------- */
  const GROUPS = [['char', 'ตัวละคร'], ['device', 'อุปกรณ์ / ลำโพง'], ['place', 'สถานที่ / บรรยากาศ'], ['pro', 'งานพากย์วิดีโอ']];
  const PRESETS = [
    ['none', '⭕', 'ไม่ใส่เอฟเฟกต์', 'char', {}],
    ['chipmunk', '🐿️', 'ชิปมังก์', 'char', {p: 1.75, f: 1.45}],
    ['cartoon', '🐥', 'การ์ตูน', 'char', {p: 1.45, f: 1.28, vibD: 0.012, vibR: 6}],
    ['giant', '🗿', 'ยักษ์ ทุ้มลึก', 'char', {p: 0.6, f: 0.72, shelf: [150, 6], rev: {sec: 1.2, mix: 0.15}}],
    ['robot', '🤖', 'หุ่นยนต์', 'char', {robot: true, comb: {ms: 6, fb: 0.45, mix: 0.5}, ring: {freq: 60, mix: 0.2}}],
    ['cyborg', '🦾', 'ไซบอร์ก', 'char', {p: 0.9, comb: {ms: 3, fb: 0.6, mix: 0.5}, ring: {freq: 30, mix: 0.3}}],
    ['alien', '👽', 'เอเลี่ยน', 'char', {p: 1.3, f: 1.1, ring: {freq: 90, mix: 0.5}, vibD: 0.03, vibR: 7}],
    ['demon', '😈', 'ปีศาจ', 'char', {p: 0.55, f: 0.8, dist: 0.3, rev: {sec: 2, mix: 0.25}}],
    ['ghost', '👻', 'ผี', 'char', {whisper: true, p: 0.95, hp: 250, vibD: 0.02, vibR: 4, rev: {sec: 3, mix: 0.45}}],
    ['whisper', '🤫', 'กระซิบ ASMR', 'char', {whisper: true, hp: 200, lp: 9000}],
    ['game8', '👾', 'เกม 8-bit', 'char', {p: 1.1, crush: [5, 3], lp: 6000}],
    ['witness', '🕵️', 'ปกปิดตัวตน (สัมภาษณ์ลับ)', 'char', {p: 0.78, f: 0.9, lp: 5000}],
    ['megaphone', '📢', 'โทรโข่ง', 'device', {bp: [500, 3500], peak: [1800, 8, 1.2], dist: 0.55, comp: 1}],
    ['pa', '📣', 'ประกาศเสียงตามสาย', 'device', {bp: [350, 4500], peak: [2200, 6, 1], dist: 0.25, echo: {t: 0.28, fb: 0.35, mix: 0.35}, rev: {sec: 1.8, mix: 0.25}}],
    ['station', '🚉', 'ประกาศสถานี / สนามบิน', 'device', {bp: [250, 6000], peak: [3000, 3, 1], rev: {sec: 2.5, mix: 0.35}, comp: 1}],
    ['phone', '☎️', 'โทรศัพท์', 'device', {bp: [300, 3400], dist: 0.15, noise: 0.004}],
    ['walkie', '📟', 'วิทยุสื่อสาร', 'device', {bp: [600, 2800], dist: 0.65, noise: 0.02, comp: 1}],
    ['oldradio', '📻', 'วิทยุเก่า AM', 'device', {bp: [500, 3200], dist: 0.3, noise: 0.012}],
    ['tv', '📺', 'ทีวีเก่า', 'device', {bp: [200, 5000], peak: [1000, 4, 1], noise: 0.006}],
    ['intercom', '🚗', 'อินเตอร์คอม / ไดรฟ์ทรู', 'device', {bp: [400, 3000], dist: 0.4, noise: 0.008}],
    ['dj', '🎙️', 'ดีเจ / วิทยุ FM', 'device', {shelf: [130, 5], peak: [3500, 3, 1], comp: 2}],
    ['hall', '⛪', 'ห้องโถง / โบสถ์', 'place', {rev: {sec: 3.5, mix: 0.4}}],
    ['cave', '🕳️', 'ถ้ำ (เสียงสะท้อน)', 'place', {echo: {t: 0.35, fb: 0.45, mix: 0.4}, rev: {sec: 2.5, mix: 0.3}}],
    ['stadium', '🏟️', 'สนามกีฬา', 'place', {bp: [200, 7000], echo: {t: 0.45, fb: 0.3, mix: 0.3}, rev: {sec: 4, mix: 0.45}}],
    ['bathroom', '🚿', 'ห้องน้ำ', 'place', {peak: [600, 4, 2], rev: {sec: 0.9, mix: 0.35, decay: 1.5}}],
    ['underwater', '🌊', 'ใต้น้ำ', 'place', {lp: 600, vibD: 0.03, vibR: 3, rev: {sec: 1.5, mix: 0.3}}],
    ['space', '🚀', 'นักบินอวกาศ', 'place', {bp: [400, 3500], comb: {ms: 12, fb: 0.3, mix: 0.3}, noise: 0.006}],
    ['dream', '💭', 'ความฝัน / ย้อนอดีต', 'place', {lp: 5000, vibD: 0.01, vibR: 2, rev: {sec: 4, mix: 0.55}}],
    ['enhance', '✨', 'คมชัด (ปรับอัตโนมัติ)', 'pro', {hp: 80, shelf: [180, 2], peak: [3500, 3, 1], comp: 1}],
    ['trailer', '🎬', 'ทุ้มสารคดี / ตัวอย่างหนัง', 'pro', {p: 0.88, f: 0.94, shelf: [120, 5], comp: 2, rev: {sec: 1.2, mix: 0.12}}],
    ['podcast', '☕', 'อบอุ่น พอดแคสต์', 'pro', {shelf: [200, 3], lp: 9000, comp: 1}],
    ['ad', '🌟', 'สดใส โฆษณา', 'pro', {p: 1.06, peak: [5000, 4, 1], comp: 2}],
  ];
  const preset = id => PRESETS.find(p => p[0] === id) || PRESETS[0];

  const GENDERS = [['orig', 'ตามต้นฉบับ'], ['m', 'ผู้ชาย'], ['f', 'ผู้หญิง']];
  const AGES = [['orig', 'ตามต้นฉบับ'], ['child', 'เด็ก'], ['teen', 'วัยรุ่น'], ['adult', 'ผู้ใหญ่'], ['elder', 'ผู้สูงอายุ']];
  const AGE_F = {
    f: {child: {p: 1.3, f: 1.14}, teen: {p: 1.1, f: 1.05}, adult: {p: 1, f: 1}, elder: {p: 0.9, f: 0.97, vibD: 0.025, vibR: 5.5, lp: 7000}},
    m: {child: {p: 1.9, f: 1.25}, teen: {p: 1.18, f: 1.06}, adult: {p: 1, f: 1}, elder: {p: 0.93, f: 0.97, vibD: 0.03, vibR: 5, lp: 6500}},
  };
  const DEF = {gender: 'orig', age: 'orig', srcG: 'auto', effect: 'none', pitch: 0, formant: 0, rev: 0, echo: 0};
  const norm = fx => Object.assign({}, DEF, fx || {});

  // resolve user settings + source gender → processing parameters
  function resolve(fx, srcGender){
    fx = norm(fx);
    const src = fx.srcG !== 'auto' ? fx.srcG : (srcGender || 'f');
    const tg = fx.gender === 'orig' ? src : fx.gender;
    let p = 1, f = 1; const e = Object.assign({}, preset(fx.effect)[4]);
    if (src !== tg){ if (tg === 'm'){ p *= 0.66; f *= 0.85; } else { p *= 1.55; f *= 1.18; } }
    if (fx.age !== 'orig'){
      const a = AGE_F[tg][fx.age];
      p *= a.p; f *= a.f;
      if (a.vibD && !e.vibD){ e.vibD = a.vibD; e.vibR = a.vibR; }
      if (a.lp && !e.lp) e.lp = a.lp;
    }
    p *= (e.p || 1) * Math.pow(2, fx.pitch / 12);
    f *= (e.f || 1) * Math.pow(2, fx.formant / 12);
    e.p = p; e.f = f;
    if (fx.rev > 0) e.rev = {sec: Math.max(e.rev?.sec || 0, 2.2), mix: Math.max(e.rev?.mix || 0, fx.rev)};
    if (fx.echo > 0) e.echo = {t: e.echo?.t || 0.32, fb: Math.max(e.echo?.fb || 0, 0.35), mix: Math.max(e.echo?.mix || 0, fx.echo)};
    return e;
  }
  const active = fx => { fx = norm(fx); return fx.gender !== 'orig' || fx.age !== 'orig' || fx.effect !== 'none' || fx.pitch || fx.formant || fx.rev > 0 || fx.echo > 0; };
  const sig = fx => active(fx) ? JSON.stringify(norm(fx)) : '';

  function normalize(x){
    let pk = 0; for (let i = 0; i < x.length; i++){ const a = Math.abs(x[i]); if (a > pk) pk = a; }
    if (pk > 0){ const g = 0.92 / pk; for (let i = 0; i < x.length; i++) x[i] *= g; }
    return x;
  }
  async function processBuffer(x, rate, e, raw){
    x = Float32Array.from(x);
    const spec = Math.abs(e.p - 1) > 0.005 || Math.abs(e.f - 1) > 0.005 || e.robot || e.whisper || e.vibD;
    if (spec) x = Float32Array.from(spectral(x, rate, e));
    if (e.crush) crush(x, e.crush[0], e.crush[1]);
    const needRack = e.ring || e.hp || e.bp || e.lp || e.shelf || e.peak || e.dist || e.noise || e.comb || e.echo || e.rev || e.comp;
    if (needRack) x = await rack(x, rate, e);
    return raw ? x : normalize(x);
  }
  // main entry: blob in → processed WAV blob out
  async function apply(blob, fx, srcGender){
    if (!active(fx)) return blob;
    const {data, rate} = await decodeAt(blob, SR);
    const out = await processBuffer(data, rate, resolve(fx, srcGender));
    return wav(out, rate);
  }
  // Web Speech voices can't be recorded, so only their pitch can follow the settings
  function devPitch(fx, srcGender){
    fx = norm(fx);
    const e = resolve(Object.assign({}, fx, {effect: 'none', formant: 0}), srcGender);
    const pe = preset(fx.effect)[4].p || 1;
    return Math.max(0.1, Math.min(2, Math.pow(e.p * pe, 0.9)));
  }
  function label(fx){
    fx = norm(fx);
    if (!active(fx)) return 'ปกติ';
    const parts = [];
    if (fx.gender !== 'orig') parts.push(GENDERS.find(g => g[0] === fx.gender)[1]);
    if (fx.age !== 'orig') parts.push(AGES.find(a => a[0] === fx.age)[1]);
    if (fx.effect !== 'none') parts.push(preset(fx.effect)[1] + ' ' + preset(fx.effect)[2]);
    if (fx.pitch) parts.push((fx.pitch > 0 ? '+' : '') + fx.pitch + ' คีย์');
    if (!parts.length) parts.push('ปรับเอง');
    return parts.join(' · ');
  }
  // long files: process in 30 s slices (overlapped + cross-faded) so the UI keeps breathing
  async function applyLong(blob, fx, srcGender, onProg){
    if (!active(fx)) return blob;
    const {data, rate} = await decodeAt(blob, SR);
    const e = resolve(fx, srcGender), core = Object.assign({}, e, {rev: null, echo: null});
    const seg = rate * 30, ov = 4096, out = new Float32Array(data.length);
    for (let o = 0; o < data.length; o += seg){
      const a = Math.max(0, o - ov), b = Math.min(data.length, o + seg + ov);
      const y = await processBuffer(data.subarray(a, b), rate, core, true);
      for (let i = 0; i < y.length && a + i < data.length; i++){
        const n = a + i;
        let w = 1;
        if (o > 0 && n < o + ov) w = Math.max(0, Math.min(1, (n - (o - ov)) / (2 * ov)));
        if (b < data.length && n >= o + seg - ov) w *= Math.max(0, Math.min(1, ((o + seg + ov) - n) / (2 * ov)));
        out[n] += y[i] * w;
      }
      onProg && onProg(Math.min(1, (o + seg) / data.length));
      await new Promise(r => setTimeout(r, 0));
    }
    const fin = (e.rev || e.echo) ? await processBuffer(out, rate, {p: 1, f: 1, rev: e.rev, echo: e.echo}, true) : out;
    return wav(normalize(fin), rate);
  }

  window.VFX = {apply, applyLong, active, sig, resolve, devPitch, label, norm, PRESETS, GROUPS, GENDERS, AGES, DEF, _spectral: spectral, _process: processBuffer, _wav: wav};
})();
