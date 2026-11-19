/* Gen Medi — Cover / Live studio
   Song file → (analyse tempo, beats, key, chords on this device) → re-play it with in-app instruments in a
   "live music bar" style (acoustic, piano bar, full band, ballad, cha-cha) with room sound, crowd and applause.
   The original recording is only used for analysis and as a practice reference — it never goes into the export,
   so the result is a NEW recording you own (the song itself — melody & lyrics — still belongs to its writer).
   Exports: backing track (WAV/MP3), click track, stems, MIDI, chord sheet. All synthesis is procedural. */
const GM = window.GM;
const { S, toast, openSheet, closeAll, sheetHead, esc, stamp, saveBlob, shareFiles, saveToMac, addHistory } = GM;
const $ = s => document.querySelector(s);
const root = $('#coverRoot');
const SR = 44100;
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUAL = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], aug: [0, 4, 8], '6': [0, 4, 7, 9], add9: [0, 4, 7, 14] };
const STYLES = [
  ['acoustic', '🎸 อะคูสติก', 'กีตาร์โปร่ง + คาฮอง + แชกเกอร์ — แบบนักร้องเล่นคนเดียวในร้าน'],
  ['piano', '🎹 เปียโนบาร์', 'เปียโน + เบสอัพไรท์ + กลองแปรง — ลาวด์จ์/โรงแรม'],
  ['band', '🥁 ฟูลแบนด์', 'กลอง เบส คีย์บอร์ด กีตาร์ไฟฟ้า — วงร้านดนตรีสด'],
  ['ballad', '🌙 บัลลาด', 'กีตาร์เกากับเปียโนนุ่ม ๆ กลองเบา ๆ เข้าทีหลัง'],
  ['chacha', '💃 สามช่า', 'จังหวะสามช่า/ลูกทุ่ง — คาวเบล กีโร ออร์แกน'],
];
const BLOCKED = /youtube\.com|youtu\.be|spotify\.com|tiktok\.com|music\.apple\.com|joox|soundcloud\.com|facebook\.com|instagram\.com/i;
let C = null;                         // current cover project
const OPT = { split: 0.05, logc: false, fmax: 1500, h3: 0.4, h5: 0.2, bassW: 0.25, q: 0.65 };
let renderCache = null;               // {key, mix}

/* ======================= analysis (runs on this device) ======================= */
const fftPlans = {};
function fft(re, im){
  const N = re.length; let p = fftPlans[N];
  if (!p){
    const rev = new Uint32Array(N), b = Math.log2(N);
    for (let i = 0; i < N; i++){ let r = 0; for (let j = 0; j < b; j++) r = (r << 1) | ((i >> j) & 1); rev[i] = r; }
    const cs = new Float64Array(N / 2), sn = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++){ cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = -Math.sin(2 * Math.PI * i / N); }
    p = fftPlans[N] = { rev, cs, sn };
  }
  for (let i = 0; i < N; i++){ const j = p.rev[i]; if (j > i){ let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let s = 2; s <= N; s <<= 1){
    const h = s >> 1, st = N / s;
    for (let i = 0; i < N; i += s) for (let j = 0, k = 0; j < h; j++, k += st){
      const a = i + j, c = a + h, wr = p.cs[k], wi = p.sn[k];
      const tr = re[c] * wr - im[c] * wi, ti = re[c] * wi + im[c] * wr;
      re[c] = re[a] - tr; im[c] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function decodeAt(blob, rate, ch = 1){
  const ab = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(ch, 1, rate);
  return await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); p && p.catch && p.catch(rej); });
}
async function analyse(blob, prog){
  const sr = 22050, buf = await decodeAt(blob, sr);
  const x = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++){ const d = buf.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / buf.numberOfChannels; }
  const N = 4096, H = 512, nF = Math.max(1, Math.floor((x.length - N) / H));
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N), prev = new Float32Array(N / 2);
  const env = new Float32Array(nF), chroma = new Float32Array(nF * 12), bass = new Float32Array(nF * 12);
  const binPc = new Int8Array(N / 2).fill(-1), binBass = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++){
    const f = k * sr / N, pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
    if (f >= 90 && f <= OPT.fmax) binPc[k] = pc;
    if (f >= 40 && f <= 260) binBass[k] = pc;
  }
  for (let fr = 0; fr < nF; fr++){
    const o = fr * H;
    for (let i = 0; i < N; i++){ re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < N / 2; k++){
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]), lm = Math.log1p(m * 4);
      const d = lm - prev[k]; if (d > 0 && k < 1100) flux += d; prev[k] = lm;
      if (binPc[k] >= 0) chroma[fr * 12 + binPc[k]] += OPT.logc ? Math.log1p(m * 2) : m;
      if (binBass[k] >= 0) bass[fr * 12 + binBass[k]] += m;
    }
    env[fr] = flux;
    if (fr % 400 === 0){ prog && prog(0.6 * fr / nF, 'กำลังฟังเพลง…'); await tick(); }
  }
  // onset envelope: remove slow trend, normalise
  const sm = new Float32Array(nF); let acc = 0; const Wn = 16;
  for (let i = 0; i < nF; i++){ acc += env[i]; if (i >= Wn) acc -= env[i - Wn]; sm[i] = acc / Math.min(i + 1, Wn); }
  let mu = 0; for (let i = 0; i < nF; i++){ env[i] = Math.max(0, env[i] - sm[i]); mu += env[i]; } mu /= nF;
  let sd = 0; for (let i = 0; i < nF; i++) sd += (env[i] - mu) ** 2; sd = Math.sqrt(sd / nF) || 1;
  for (let i = 0; i < nF; i++) env[i] = env[i] / sd;
  // tempo by autocorrelation with a soft prior around 110 BPM
  const hop = H / sr, lo = Math.floor(60 / 190 / hop), hi = Math.ceil(60 / 58 / hop), ac = new Float32Array(hi + 2);
  const M = Math.min(nF, Math.floor(90 / hop));
  for (let L = lo; L <= hi + 1; L++){ let s = 0; for (let i = L; i < M; i++) s += env[i] * env[i - L]; ac[L] = s; }
  let best = lo, bs = -1e9;
  for (let L = lo; L <= hi; L++){ const bpm = 60 / (L * hop), w = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.8) ** 2), s = ac[L] * w; if (s > bs){ bs = s; best = L; } }
  const a0 = ac[best - 1] || 0, a1 = ac[best], a2 = ac[best + 1] || 0, den = a0 - 2 * a1 + a2;
  const lag = best + (den ? 0.5 * (a0 - a2) / den : 0);
  let bpm = 60 / (lag * hop);
  prog && prog(0.7, 'กำลังหาจังหวะ…'); await tick();
  // beat tracking — dynamic programming (Ellis 2007)
  const Pd = lag, score = new Float32Array(nF), back = new Int32Array(nF).fill(-1), alpha = 120;
  for (let t = 0; t < nF; t++){
    let bv = 0, bi = -1;
    const a = Math.round(t - 2 * Pd), b = Math.round(t - Pd / 2);
    for (let u = Math.max(0, a); u <= b; u++){ const v = score[u] - alpha * Math.log((t - u) / Pd) ** 2; if (bi < 0 || v > bv){ bv = v; bi = u; } }
    score[t] = env[t] + (bi >= 0 ? Math.max(0, bv) : 0); back[t] = bi >= 0 && bv > 0 ? bi : -1;
  }
  let t = 0, tb = -1e9; for (let i = Math.max(0, nF - Math.round(Pd)); i < nF; i++) if (score[i] > tb){ tb = score[i]; t = i; }
  const beatsF = []; while (t >= 0){ beatsF.push(t); t = back[t]; } beatsF.reverse();
  if (beatsF.length < 8){ beatsF.length = 0; for (let f = 0; f < nF; f += Pd) beatsF.push(Math.round(f)); }
  // beat-synchronous chroma
  prog && prog(0.8, 'กำลังแกะคอร์ด…'); await tick();
  const nb = beatsF.length - 1, bc = [], bb = [];
  for (let i = 0; i < nb; i++){
    // median over the beat's frames keeps sustained notes and drops drum hits (percussive transients)
    const c = new Float32Array(12), d = new Float32Array(12), f0 = beatsF[i], f1 = Math.max(beatsF[i + 1], f0 + 1), tmp = [];
    for (let p = 0; p < 12; p++){
      tmp.length = 0; for (let f = f0; f < f1; f++) tmp.push(chroma[f * 12 + p]); tmp.sort((x, y) => x - y); c[p] = tmp[Math.floor(tmp.length * OPT.q)];
      tmp.length = 0; for (let f = f0; f < f1; f++) tmp.push(bass[f * 12 + p]); tmp.sort((x, y) => x - y); d[p] = tmp[Math.floor(tmp.length * OPT.q)];
    }
    const mx = Math.max(...c) || 1, mb = Math.max(...d) || 1;
    for (let p = 0; p < 12; p++){ c[p] /= mx; d[p] /= mb; }
    bc.push(c); bb.push(d);
  }
  // key (Krumhansl–Schmuckler)
  const KM = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], Km = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const tot = new Float32Array(12); bc.forEach(c => c.forEach((v, p) => tot[p] += v));
  const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++){ n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
  let key = { r: 0, q: '' }, kb = -2;
  for (let r = 0; r < 12; r++){ const rot = Array.from({ length: 12 }, (_, i) => tot[(i + r) % 12]); const a = corr(rot, KM), b = corr(rot, Km); if (a > kb){ kb = a; key = { r, q: '' }; } if (b > kb){ kb = b; key = { r, q: 'm' }; } }
  // chord per beat: 24 triad templates + bass + key prior, smoothed with Viterbi
  const cands = []; for (let r = 0; r < 12; r++) for (const q of ['', 'm']) cands.push({ r, q });
  const diat = new Set((key.q ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map(i => (i + key.r) % 12));
  // chord templates include each tone's harmonics (h1..h6), so overtones don't fool the match (e.g. G heard as D)
  const HARM = [[0, 1], [0, 0.6], [7, OPT.h3], [0, 0.3], [4, OPT.h5], [7, 0.15]];
  const tmpl = cands.map(cd => { const t = new Float32Array(12); QUAL[cd.q].forEach((sft, j) => HARM.forEach(([o, a]) => t[(cd.r + sft + o) % 12] += a * (j === 0 ? 1 : 0.85))); return t; });
  const cos = (a, t) => { let ma = 0, mt = 0; for (let p = 0; p < 12; p++){ ma += a[p]; mt += t[p]; } ma /= 12; mt /= 12; let n = 0, da = 0, dt = 0; for (let p = 0; p < 12; p++){ const x = a[p] - ma, y = t[p] - mt; n += x * y; da += x * x; dt += y * y; } return n / Math.sqrt(da * dt || 1); };
  const sumB = (arr, i, n) => { const o = new Float32Array(12); for (let j = i; j < i + n && j < arr.length; j++) for (let p = 0; p < 12; p++) o[p] += arr[j][p]; const m = Math.max(...o) || 1; for (let p = 0; p < 12; p++) o[p] /= m; return o; };
  const bestC = (i, n) => { const c = sumB(bc, i, n), d = sumB(bb, i, n); let k = 0, sc = -9; cands.forEach((cd, j) => { const v = cos(c, tmpl[j]) + OPT.bassW * d[cd.r] + (diat.has(cd.r) ? 0.06 : -0.04); if (v > sc){ sc = v; k = j; } }); return { k, s: sc }; };
  // downbeat phase = the 4-beat grid whose bars are most harmonically uniform
  let phase = 0, ps = -1e9;
  for (let p = 0; p < 4; p++){ let tot = 0, nbar = 0; for (let i = p; i + 4 <= nb; i += 4){ tot += bestC(i, 4).s; nbar++; } tot /= nbar || 1; if (tot > ps){ ps = tot; phase = p; } }
  const bars = [];
  for (let i = phase; i + 4 <= nb; i += 4){
    const w = bestC(i, 4), h1 = bestC(i, 2), h2 = bestC(i + 2, 2);
    const ch = (h1.k !== h2.k && (h1.s + h2.s) / 2 - w.s > OPT.split) ? [cands[h1.k], cands[h2.k]] : [cands[w.k]];
    bars.push({ chords: ch.map(c => ({ r: c.r, q: c.q })) });
    if (bars.length % 40 === 0) await tick();
  }
  // relative major/minor: trust the tonic chord that is actually played more
  const cnt = (r, q) => bars.reduce((n, b) => n + b.chords.filter(c => c.r === r && c.q === q).length, 0);
  if (key.q === 'm' && cnt((key.r + 3) % 12, '') > cnt(key.r, 'm')) key = { r: (key.r + 3) % 12, q: '' };
  else if (key.q === '' && cnt((key.r + 9) % 12, 'm') > cnt(key.r, '') * 1.3) key = { r: (key.r + 9) % 12, q: 'm' };
  const beatT = beatsF.map(f => f * hop + N / 2 / sr);
  if (beatT.length > 4){ const d = (beatT[beatT.length - 1] - beatT[0]) / (beatT.length - 1); bpm = 60 / d; }
  prog && prog(1, 'เสร็จแล้ว');
  return { bpm: Math.round(bpm), key, bars: trimSilence(bars), firstBeat: beatT[phase] || 0, duration: buf.duration };
}
function maj(a){ const m = {}; let b = a[0], bc = 0; a.forEach(v => { m[v] = (m[v] || 0) + 1; if (m[v] > bc){ bc = m[v]; b = v; } }); return b; }
function trimSilence(bars){ return bars.length ? bars : [{ chords: [{ r: 0, q: '' }] }]; }

/* ======================= arrangement ======================= */
const cname = (c, tr = 0) => NOTE[((c.r + tr) % 12 + 12) % 12] + c.q;
function parseChord(t){
  const m = String(t).trim().match(/^([A-G])([#b]?)(.*)$/i); if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  let q = m[3].replace('min', 'm').replace('M7', 'maj7'); if (!(q in QUAL)) q = q.startsWith('m') ? 'm' : '';
  return { r: (base + 12) % 12, q };
}
const rnd = (a, b) => a + Math.random() * (b - a);
function nearest(pc, center){ let n = pc; while (n < center - 6) n += 12; while (n > center + 5) n -= 12; return n; }
function guitarVoicing(c){
  const open = [40, 45, 50, 55, 59, 64], tones = QUAL[c.q].map(s => (c.r + s) % 12), notes = [];
  let start = 0; for (let s = 0; s < 3; s++){ if ([0, 1, 2, 3, 4].some(f => (open[s] + f) % 12 === c.r)){ start = s; break; } }
  for (let s = start; s < 6; s++){
    const fr = s === start ? [0, 1, 2, 3, 4, 5].find(f => (open[s] + f) % 12 === c.r) : [0, 1, 2, 3, 4].find(f => tones.includes((open[s] + f) % 12));
    if (fr != null) notes.push(open[s] + fr);
  }
  return notes;
}
let lastRH = null;
function pianoVoicing(c){
  const tones = QUAL[c.q].slice(0, 4).map(s => (c.r + s) % 12);
  const opts = [];
  for (let inv = 0; inv < tones.length; inv++){ const ord = tones.slice(inv).concat(tones.slice(0, inv)); let n = nearest(ord[0], 62); const v = [n]; for (let i = 1; i < ord.length; i++){ let m = ord[i]; while (m <= v[v.length - 1]) m += 12; while (m - v[v.length - 1] > 12) m -= 12; v.push(m); } opts.push(v); }
  const cost = v => lastRH ? v.reduce((s, n, i) => s + Math.abs(n - (lastRH[i] ?? lastRH[lastRH.length - 1])), 0) : Math.abs(v[0] - 60);
  const best = opts.sort((a, b) => cost(a) - cost(b))[0]; lastRH = best; return best;
}
// events: {t (sec), inst, m (midi) | d (drum), dur, v (0..1), dir}
function arrange(cv){
  const meter = cv.meter === 3 ? 3 : 4, ev = [], bpm = cv.bpm * cv.tempo, spb = 60 / bpm, bar = meter * spb, tr = cv.transpose, st = cv.style;
  const chordsAt = cv.bars.map(b => b.chords.map(c => ({ r: (c.r + tr + 120) % 12, q: c.q })));
  const N = (inst, m, t, dur, v, extra) => ev.push(Object.assign({ inst, m, t, dur, v }, extra || {}));
  const D = (d, t, v) => ev.push({ inst: 'drums', d, t, v, dur: 0.5 });
  let t0 = 0;
  if (cv.countIn){ for (let i = 0; i < meter; i++) D('sticks', i * spb, i ? 0.7 : 0.9); t0 = bar; }
  const introBars = cv.intro ? Math.min(4, chordsAt.length) : 0;
  const plan = [];
  for (let i = 0; i < introBars; i++) plan.push({ ch: chordsAt[chordsAt.length - introBars + i] || chordsAt[i], part: 'intro' });
  chordsAt.forEach((ch, i) => plan.push({ ch, part: i % 16 < 8 ? 'verse' : 'chorus' }));
  const lastChord = chordsAt[chordsAt.length - 1].slice(-1)[0];
  lastRH = null;
  plan.forEach((p, bi) => {
    const tb = t0 + bi * bar, half = p.ch.length > 1, sw = (beat) => tb + beat * spb + rnd(-0.008, 0.008);
    if (meter === 3){   // waltz feel for every style: bass/strum on 1, chords on 2 and 3
      const c = p.ch[0], intro = p.part === 'intro', soft = st === 'piano' || st === 'ballad';
      if (st === 'piano' || st === 'ballad'){ N('piano', [nearest(c.r, 40)], sw(0), spb * 1.5, 0.7); [1, 2].forEach(b => N('piano', pianoVoicing(c), sw(b), spb * 0.9, 0.42)); }
      else { N(st === 'band' ? 'epiano' : st === 'chacha' ? 'organ' : 'guitar', guitarVoicing(c), sw(0), spb, 0.85, { dir: 'D' }); [1, 2].forEach(b => N(st === 'band' ? 'epiano' : st === 'chacha' ? 'organ' : 'guitar', st === 'band' || st === 'chacha' ? pianoVoicing(c) : guitarVoicing(c).slice(-4), sw(b), spb * 0.5, 0.5, { dir: 'U' })); }
      if (!intro){ N('bass', [nearest(c.r, soft ? 38 : 36)], sw(0), spb * 1.4, 0.8); if (bi % 2) N('bass', [nearest((c.r + 7) % 12, 36)], sw(2), spb * 0.8, 0.5);
        if (st === 'acoustic'){ D('cajonB', sw(0), 0.85); D('cajonS', sw(1), 0.45); D('cajonS', sw(2), 0.45); }
        else if (soft) [0, 1, 2].forEach(b => D('brush', sw(b), b ? 0.35 : 0.55));
        else { D('kick', sw(0), 0.9); D('snare', sw(1), 0.45); D('snare', sw(2), 0.45); [0, 1, 2].forEach(b => D('hat', sw(b), 0.35)); } }
      if (bi % 8 === 0 && bi && !soft) D('crash', tb, 0.6);
      return;
    }
    const chordAt = beat => p.ch[half && beat >= 2 ? 1 : 0];
    const first = bi === 0, intro = p.part === 'intro', big = p.part === 'chorus';
    if (bi % 8 === 0 && (st === 'band' || st === 'chacha') && !first) D('crash', tb, 0.7);
    if (st === 'acoustic'){
      const pat = [[0, 'D', 1], [1, 'D', 0.75], [1.5, 'U', 0.55], [2.5, 'U', 0.6], [3, 'D', 0.8], [3.5, 'U', 0.55]];
      pat.forEach(([b, dir, v]) => N('guitar', guitarVoicing(chordAt(b)), sw(b), spb * (dir === 'D' ? 1 : 0.5), v * (intro ? 0.8 : 1), { dir }));
      if (!intro){ [0, 2.5].forEach(b => D('cajonB', sw(b), 0.9)); [1, 3].forEach(b => D('cajonS', sw(b), 0.8)); [0.75, 1.75, 2.75, 3.25, 3.75].forEach(b => D('cajonG', sw(b), 0.25)); }
      for (let b = 0; b < 4; b += 0.5) D('shaker', sw(b), b % 1 ? 0.5 : 0.3);
    }
    if (st === 'piano' || st === 'ballad'){
      const c0 = chordAt(0), c2 = chordAt(2);
      if (st === 'piano'){
        N('piano', [nearest(c0.r, 40)], sw(0), spb * 2, 0.7); N('piano', [nearest((c2.r + (half ? 0 : 7)) % 12, 43)], sw(2), spb * 2, 0.6);
        N('piano', pianoVoicing(c0), sw(0), spb * (half ? 2 : 4), 0.55); N('piano', pianoVoicing(c2), sw(2.5), spb * 1.5, 0.4);
        if (!intro){ N('bass', [nearest(c0.r, 38)], sw(0), spb * 1.8, 0.75); N('bass', [nearest((c2.r + (half ? 0 : 7)) % 12, 38)], sw(2), spb * 1.8, 0.65); for (let b = 0; b < 4; b++) D('brush', sw(b), b % 2 ? 0.55 : 0.35); }
      } else {
        const arp = [0, 1, 2, 3, 2, 1, 2, 3];
        for (let k = 0; k < 8; k++){ const v = guitarVoicing(chordAt(k / 2)), n = v[Math.min(v.length - 1, arp[k] + (v.length > 4 ? 1 : 0))]; N('guitar', [k === 0 ? v[0] : n], sw(k / 2), spb * 1.5, k === 0 ? 0.75 : 0.5, { dir: 'P' }); }
        N('pad', pianoVoicing(c0), tb, spb * (half ? 2 : 4), 0.3); if (half) N('pad', pianoVoicing(c2), tb + 2 * spb, spb * 2, 0.3);
        if (!intro && bi >= introBars + 8){ D('kick', sw(0), 0.6); D('rim', sw(2), 0.5); for (let b = 0; b < 4; b += 1) D('hat', sw(b), 0.25); N('bass', [nearest(c0.r, 38)], sw(0), spb * 2, 0.6); N('bass', [nearest(c2.r, 38)], sw(2), spb * 2, 0.55); }
      }
    }
    if (st === 'band'){
      const c0 = chordAt(0), c2 = chordAt(2), nxt = (plan[bi + 1]?.ch[0] || lastChord);
      if (!intro || bi === introBars - 1){ D('kick', sw(0), 0.95); D('kick', sw(2), 0.85); if (big) D('kick', sw(2.5), 0.6); D('snare', sw(1), 0.85); D('snare', sw(3), 0.9); }
      for (let b = 0; b < 4; b += 0.5) D(big ? 'ride' : 'hat', sw(b), b % 1 ? 0.35 : 0.55);
      const bl = [[0, c0.r, 0.9], [1.5, c0.r, 0.6], [2, c2.r, 0.85], [3, (c2.r + 7) % 12, 0.65], [3.5, (nxt.r + 11) % 12, 0.55]];
      if (!intro) bl.forEach(([b, pc, v]) => N('bass', [nearest(pc, 36)], sw(b), spb * 0.45, v));
      N('epiano', pianoVoicing(c0), sw(0), spb * (half ? 2 : 3.5), 0.5); if (half) N('epiano', pianoVoicing(c2), sw(2), spb * 2, 0.45);
      if (!intro) [1.5, 3.5].forEach(b => N('eguitar', guitarVoicing(chordAt(b)).slice(-4), sw(b), spb * 0.3, 0.45, { dir: 'D' }));
    }
    if (st === 'chacha'){
      const c0 = chordAt(0), c2 = chordAt(2);
      for (let b = 0; b < 4; b++) D('cowbell', sw(b), b === 0 ? 0.7 : 0.45);
      [0, 2].forEach(b => D('guiro', sw(b), 0.5));
      if (!intro){ D('kick', sw(0), 0.85); D('kick', sw(2), 0.8); [3, 3.5].forEach(b => D('rim', sw(b), 0.75)); D('snare', sw(1), 0.6); }
      const bl = [[0, c0.r], [1.5, (c0.r + 7) % 12], [2, c2.r], [3, (c2.r + 7) % 12], [3.5, c2.r]];
      if (!intro) bl.forEach(([b, pc], k) => N('bass', [nearest(pc, 36)], sw(b), spb * 0.45, k === 0 || k === 2 ? 0.9 : 0.65));
      [0.5, 1.5, 2.5, 3.5].forEach(b => N('organ', pianoVoicing(chordAt(b)), sw(b), spb * 0.35, 0.45));
    }
  });
  // ending: hold the last chord, then applause
  const tEnd = t0 + plan.length * bar;
  const lc = lastChord;
  if (st === 'band' || st === 'chacha'){ D('crash', tEnd, 0.9); D('kick', tEnd, 0.9); }
  N(st === 'acoustic' || st === 'ballad' ? 'guitar' : st === 'band' ? 'epiano' : st === 'chacha' ? 'organ' : 'piano', st === 'acoustic' || st === 'ballad' ? guitarVoicing(lc) : pianoVoicing(lc), tEnd, bar * 1.5, 0.8, { dir: 'D' });
  if (st !== 'acoustic' && st !== 'ballad') N('bass', [nearest(lc.r, 36)], tEnd, bar * 1.2, 0.8);
  return { ev, length: tEnd + bar * 1.6, songStart: t0 + introBars * bar, spb, t0, plan };
}

/* ======================= real instrument samples (FluidR3_GM, MIT) ======================= */
const SAMPLE_BASE = window.GM_SAMPLES || 'https://raw.githubusercontent.com/mengnattawitmarin/ai-voice/samples/samples/';
let sIndex = null; const sBufs = new Map();
const SAMPLE_INST = { guitar: 'guitar', eguitar: 'eguitar', bass: 'bass', piano: 'piano', epiano: 'epiano', organ: 'organ', pad: 'pad' };
const SAMPLE_DRUM = { kick: 'kick', snare: 'snare', hat: 'hat', ride: 'ride', crash: 'crash', rim: 'rim', cowbell: 'cowbell', guiro: 'guiro', shaker: 'shaker', clap: 'clap', sticks: 'sticks' };
async function sampleIndex(){ if (sIndex) return sIndex; const r = await fetch(SAMPLE_BASE + 'index.json'); if (!r.ok) throw new Error('โหลดเสียงเครื่องดนตรีจริงไม่ได้'); return sIndex = await r.json(); }
async function loadSample(path){
  if (sBufs.has(path)) return sBufs.get(path);
  const p = fetch(SAMPLE_BASE + path).then(r => { if (!r.ok) throw new Error(path); return r.arrayBuffer(); })
    .then(ab => new Promise((res, rej) => { const c = new OfflineAudioContext(1, 1, SR); const q = c.decodeAudioData(ab, res, rej); q && q.catch && q.catch(rej); }));
  sBufs.set(path, p); return p;
}
function nearestSample(inst, m){ const n = sIndex.inst[inst]?.notes; if (!n) return null; let best = n[0]; for (const x of n) if (Math.abs(x - m) < Math.abs(best - m)) best = x; return best; }
async function prepareSamples(A, cv, prog){
  await sampleIndex();
  const need = new Set(), styleInst = i => i === 'bass' && cv.style === 'piano' ? 'upright' : i === 'guitar' && cv.style === 'ballad' ? 'nylon' : SAMPLE_INST[i];
  A.ev.forEach(e => {
    if (e.inst === 'drums'){ const d = SAMPLE_DRUM[e.d]; if (d){ need.add(`drums/${d}1.mp3`); need.add(`drums/${d}2.mp3`); } return; }
    const si = styleInst(e.inst); if (!si) return; e.si = si;
    e.m.forEach(m => { const n = nearestSample(si, m); if (n != null) need.add(`${si}/${n}.mp3`); });
  });
  let k = 0; const list = [...need];
  for (let i = 0; i < list.length; i += 8){ await Promise.all(list.slice(i, i + 8).map(loadSample)); k += 8; prog && prog(Math.min(1, k / list.length)); }
}

/* ======================= instruments (procedural, no samples) ======================= */
const noteCache = new Map(), abCache = new WeakMap();
function toAB(data){ let b = abCache.get(data); if (!b){ b = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: SR }); b.copyToChannel(data, 0); abCache.set(data, b); } return b; }
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function cached(key, len, fn){ let b = noteCache.get(key); if (!b){ b = fn(); noteCache.set(key, b); if (noteCache.size > 900) noteCache.delete(noteCache.keys().next().value); } return b; }
function ks(freq, sec, bright, decayT){        // Karplus–Strong plucked string
  const n = Math.floor(sec * SR), y = new Float32Array(n), P = SR / freq, Pi = Math.floor(P), fr = P - Pi;
  let lp = 0; for (let i = 0; i < Math.min(n, Pi + 2); i++){ const w = Math.random() * 2 - 1; lp += bright * (w - lp); y[i] = lp; }
  const g = Math.pow(0.001, 1 / (decayT * freq));
  for (let i = Pi + 2; i < n; i++){ const a = y[i - Pi] * (1 - fr) + y[i - Pi - 1] * fr, b = y[i - Pi - 1] * (1 - fr) + y[i - Pi - 2] * fr; y[i] = g * 0.5 * (a + b); }
  for (let i = 0; i < 40 && i < n; i++) y[i] *= i / 40;
  return y;
}
function piano(m, sec){
  const f = mtof(m), n = Math.floor(sec * SR), y = new Float32Array(n), B = 0.0004, t1 = 3.2 * Math.sqrt(261 / f) + 0.4;
  for (let k = 1; k <= 12; k++){
    const fk = k * f * Math.sqrt(1 + B * k * k); if (fk > SR / 2.2) break;
    const a = Math.pow(k, -1.15) * (k === 1 ? 1 : 0.9), tau = t1 / Math.pow(k, 0.7);
    for (const det of [-0.0005, 0.0005]){
      const w = 2 * Math.PI * fk * (1 + det) / SR, cw = Math.cos(w), sw = Math.sin(w), dec = Math.exp(-1 / (tau * SR));
      let e = a * 0.5, ph = Math.random() * 6.28, c = Math.cos(ph), s = Math.sin(ph);
      for (let i = 0; i < n; i++){ y[i] += e * s; const nc = c * cw - s * sw; s = s * cw + c * sw; c = nc; e *= dec; if (e < 1e-5) break; }
    }
  }
  for (let i = 0; i < Math.min(n, 400); i++) y[i] += (Math.random() * 2 - 1) * 0.05 * (1 - i / 400);
  for (let i = 0; i < 90; i++) y[i] *= i / 90;
  return y;
}
function epiano(m, sec){
  const f = mtof(m), n = Math.floor(sec * SR), y = new Float32Array(n), w = 2 * Math.PI * f / SR, wt = 2 * Math.PI * f * 14 / SR;
  for (let i = 0; i < n; i++){ const t = i / SR, I = 0.3 + 2.2 * Math.exp(-t * 6), e = Math.exp(-t * (1.1 + f / 900)); y[i] = e * Math.sin(w * i + I * Math.sin(w * i)) + 0.12 * Math.exp(-t * 30) * Math.sin(wt * i); }
  for (let i = 0; i < 60; i++) y[i] *= i / 60;
  return y;
}
function organ(m, sec){
  const f = mtof(m), n = Math.floor(sec * SR), y = new Float32Array(n), bars = [[1, 1], [2, 0.7], [3, 0.45], [4, 0.35], [6, 0.2], [8, 0.15]];
  for (const [h, a] of bars){ const w = 2 * Math.PI * f * h / SR; if (f * h > SR / 2.2) continue; for (let i = 0; i < n; i++) y[i] += a * Math.sin(w * i); }
  for (let i = 0; i < n; i++){ const t = i / SR; y[i] *= 0.3 * (1 + 0.12 * Math.sin(2 * Math.PI * 6.2 * t)) * Math.min(1, t / 0.01) * Math.min(1, (sec - t) / 0.04); }
  return y;
}
function pad(m, sec){
  const f = mtof(m), n = Math.floor(sec * SR), y = new Float32Array(n);
  for (const d of [-0.004, 0, 0.005]){ let ph = Math.random(); const inc = f * (1 + d) / SR; for (let i = 0; i < n; i++){ y[i] += (2 * ph - 1) * 0.25; ph += inc; if (ph >= 1) ph -= 1; } }
  let lp = 0; for (let i = 0; i < n; i++){ const t = i / SR; lp += 0.06 * (y[i] - lp); y[i] = lp * Math.min(1, t / 0.35) * Math.min(1, (sec - t) / 0.4); }
  return y;
}
function drum(d){
  const v = Math.floor(Math.random() * 3);
  return cached('d' + d + v, 0, () => {
    const len = { kick: 0.5, snare: 0.35, hat: 0.09, ride: 0.6, crash: 2.2, rim: 0.08, cajonB: 0.35, cajonS: 0.2, cajonG: 0.08, shaker: 0.1, brush: 0.25, cowbell: 0.3, guiro: 0.28, sticks: 0.06, clap: 0.2 }[d] || 0.2;
    const n = Math.floor(len * SR), y = new Float32Array(n); let lp = 0, hp = 0, prev = 0;
    const noise = () => Math.random() * 2 - 1;
    for (let i = 0; i < n; i++){
      const t = i / SR; let s = 0;
      switch (d){
        case 'kick': { const f = 45 + 90 * Math.exp(-t * 30); s = Math.sin(2 * Math.PI * (45 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 7) + (t < 0.004 ? noise() * 0.4 : 0); break; }
        case 'snare': s = 0.55 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 25) + noise() * 0.6 * Math.exp(-t * 14); break;
        case 'hat': { const w = noise(); hp = 0.15 * hp + w - prev; prev = w; s = hp * 0.35 * Math.exp(-t * 55); break; }
        case 'ride': { const w = noise(); hp = 0.2 * hp + w - prev; prev = w; s = hp * 0.18 * Math.exp(-t * 5) + 0.05 * Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t * 4); break; }
        case 'crash': { const w = noise(); hp = 0.25 * hp + w - prev; prev = w; s = hp * 0.3 * Math.exp(-t * 2.2); break; }
        case 'rim': s = (Math.sin(2 * Math.PI * 1700 * t) * 0.6 + noise() * 0.4) * Math.exp(-t * 90); break;
        case 'cajonB': s = Math.sin(2 * Math.PI * (70 + 40 * Math.exp(-t * 40)) * t) * Math.exp(-t * 12) + noise() * 0.15 * Math.exp(-t * 60); break;
        case 'cajonS': { lp += 0.35 * (noise() - lp); s = (lp * 1.2 + 0.3 * Math.sin(2 * Math.PI * 330 * t)) * Math.exp(-t * 28); break; }
        case 'cajonG': { lp += 0.3 * (noise() - lp); s = lp * 0.5 * Math.exp(-t * 60); break; }
        case 'shaker': { const w = noise(); hp = 0.1 * hp + w - prev; prev = w; s = hp * 0.25 * Math.sin(Math.PI * Math.min(1, t / len)); break; }
        case 'brush': { lp += 0.2 * (noise() - lp); s = lp * 0.5 * Math.sin(Math.PI * Math.min(1, t / len)); break; }
        case 'cowbell': s = (Math.sign(Math.sin(2 * Math.PI * 562 * t)) + Math.sign(Math.sin(2 * Math.PI * 845 * t))) * 0.18 * Math.exp(-t * 14); break;
        case 'guiro': { const g = (Math.sin(2 * Math.PI * 32 * t) > 0.2) ? 1 : 0.1; lp += 0.5 * (noise() - lp); s = lp * g * 0.4 * Math.sin(Math.PI * Math.min(1, t / len)); break; }
        case 'sticks': s = (Math.sin(2 * Math.PI * 2500 * t) * 0.5 + noise() * 0.5) * Math.exp(-t * 120); break;
        case 'clap': { lp += 0.4 * (noise() - lp); const bursts = [0, 0.011, 0.022]; s = bursts.reduce((a, b) => a + (t >= b ? Math.exp(-(t - b) * 70) : 0), 0) * lp * 0.6; break; }
      }
      y[i] = s * (0.9 + 0.1 * v);
    }
    return y;
  });
}
function voiceBuf(inst, m, dur){
  const q = Math.max(0.25, Math.round(dur * 4) / 4);
  switch (inst){
    case 'guitar': return cached(`g${m}`, 0, () => ks(mtof(m), 3.2, 0.55, 2.2));
    case 'eguitar': return cached(`eg${m}`, 0, () => ks(mtof(m), 1.2, 0.8, 0.9));
    case 'bass': return cached(`b${m}`, 0, () => { const y = ks(mtof(m), 2.4, 0.22, 2.5); return y; });
    case 'piano': return cached(`p${m}`, 0, () => piano(m, Math.min(3.5, 1.5 + 300 / mtof(m))));
    case 'epiano': return cached(`e${m}${q}`, 0, () => epiano(m, Math.min(4, q + 0.4)));
    case 'organ': return cached(`o${m}${q}`, 0, () => organ(m, q + 0.05));
    case 'pad': return cached(`pd${m}${q}`, 0, () => pad(m, q + 0.4));
  }
}

/* ======================= room, crowd, rendering ======================= */
function impulse(ctx, sec, decay){
  const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++){ const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++){ lp += 0.45 * (Math.random() * 2 - 1 - lp); d[i] = lp * Math.pow(1 - i / n, decay) * (i < 300 ? i / 300 : 1); } }
  return b;
}
function crowdBuf(ctx, sec, level, applauseAt){
  const n = Math.floor(sec * SR), b = ctx.createBuffer(2, n, SR);
  for (let c = 0; c < 2; c++){
    const d = b.getChannelData(c); let lp = 0, lp2 = 0;
    for (let i = 0; i < n; i++){ const w = Math.random() * 2 - 1; lp += 0.08 * (w - lp); lp2 += 0.02 * (lp - lp2); d[i] = (lp - lp2) * level * 0.9 * (1 + 0.4 * Math.sin(i / SR * 0.7 + c)); }
    // murmur: short vowel-like blips
    const blips = Math.floor(sec * 3 * level * 10);
    for (let k = 0; k < blips; k++){
      const t0 = Math.floor(Math.random() * (n - SR)), f = rnd(110, 260), L = Math.floor(rnd(0.08, 0.3) * SR), a = level * rnd(0.02, 0.06), f2 = rnd(500, 1400);
      for (let i = 0; i < L; i++){ const t = i / SR, e = Math.sin(Math.PI * i / L); d[t0 + i] += a * e * (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f2 * t) * 0.25 * Math.sin(2 * Math.PI * f * t)); }
    }
    // glasses
    for (let k = 0; k < sec / 20 * level * 10; k++){ const t0 = Math.floor(Math.random() * (n - SR)), f = rnd(2500, 4200); for (let i = 0; i < SR * 0.4; i++) d[t0 + i] += level * 0.08 * Math.exp(-i / SR * 12) * Math.sin(2 * Math.PI * f * i / SR); }
    if (applauseAt != null){
      const s0 = Math.floor(applauseAt * SR), L = Math.min(n - s0, Math.floor(5 * SR)), clap = drum('clap');
      for (let k = 0; k < 900; k++){
        const pos = Math.floor(Math.pow(Math.random(), 1.6) * L), g = 0.15 * (1 - pos / L) * rnd(0.4, 1);
        for (let i = 0; i < clap.length && s0 + pos + i < n; i++) d[s0 + pos + i] += clap[i] * g;
      }
    }
  }
  return b;
}
const MIX = { guitar: [0.55, -0.15], eguitar: [0.32, 0.35], bass: [0.75, 0], piano: [0.42, 0.05], epiano: [0.32, -0.2], organ: [0.3, 0.25], pad: [0.25, 0], drums: [0.7, 0] };
const DRUMPAN = { hat: 0.3, ride: -0.3, crash: -0.35, shaker: 0.4, cowbell: 0.35, guiro: -0.3, rim: 0.1, brush: 0.15 };
async function render(cv, opt = {}){
  const A = arrange(cv), len = A.length + (cv.applause ? 5 : 0.5);
  let sampled = cv.sampled !== false;
  if (sampled){ try { await prepareSamples(A, cv, opt.prog); } catch(e){ sampled = false; toast('ใช้เสียงสังเคราะห์แทน (โหลดเสียงเครื่องดนตรีจริงไม่ได้ — ต้องต่อเน็ตครั้งแรก)', true); } }
  const ctx = new OfflineAudioContext(2, Math.ceil(len * SR), SR);
  const master = ctx.createGain(); master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
  master.connect(comp); comp.connect(ctx.destination);
  const rev = ctx.createConvolver(); rev.buffer = impulse(ctx, 0.8 + cv.room * 1.6, 3); const revG = ctx.createGain(); revG.gain.value = 0.15 + cv.room * 0.45; rev.connect(revG); revG.connect(master);
  const buses = {};
  const bus = inst => {
    if (buses[inst]) return buses[inst];
    const g = ctx.createGain(), p = ctx.createStereoPanner(), only = !opt.only || opt.only === inst;
    g.gain.value = only ? (MIX[inst] || [0.5])[0] : 0; p.pan.value = (MIX[inst] || [0, 0])[1];
    let last = g;
    if (inst === 'guitar'){ const e = ctx.createBiquadFilter(); e.type = 'peaking'; e.frequency.value = 180; e.gain.value = 4; e.Q.value = 1; const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 3000; hs.gain.value = 3; last.connect(e); e.connect(hs); last = hs; }
    if (inst === 'bass'){ const l = ctx.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = 900; last.connect(l); last = l; }
    if (inst === 'eguitar'){ const l = ctx.createBiquadFilter(); l.type = 'bandpass'; l.frequency.value = 1500; l.Q.value = 0.6; last.connect(l); last = l; }
    last.connect(p); p.connect(master); const s = ctx.createGain(); s.gain.value = inst === 'bass' ? 0.1 : inst === 'drums' ? 0.35 : 0.6; p.connect(s); s.connect(rev);
    return buses[inst] = g;
  };
  const play = (data, t, gain, out, pan, rate) => {
    if (!data || t < 0) return;
    const s = ctx.createBufferSource(); s.buffer = data instanceof AudioBuffer ? data : toAB(data); if (rate) s.playbackRate.value = rate; const g = ctx.createGain(); g.gain.value = gain;
    s.connect(g);
    if (pan != null){ const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(out); } else g.connect(out);
    s.start(t); return { s, g };
  };
  if (sampled) for (const [k, pr] of sBufs) if (!pr.done) pr.done = await pr.catch(() => null);
  for (const e of A.ev){
    if (e.inst === 'drums'){
      const sd = sampled && SAMPLE_DRUM[e.d] && sBufs.get(`drums/${SAMPLE_DRUM[e.d]}${e.v > 0.6 ? 1 : 2}.mp3`);
      if (sd?.done){ const b = sd.done; play(b, e.t, e.v * 0.55 * (e.d === 'sticks' ? 0.8 : 1), bus('drums'), DRUMPAN[e.d] ?? 0); continue; }
      play(drum(e.d), e.t, e.v * (e.d === 'sticks' ? 0.8 : 1), bus('drums'), DRUMPAN[e.d] ?? 0); continue;
    }
    const ms = e.m, out = bus(e.inst);
    ms.forEach((m, i) => {
      const st = e.dir === 'D' ? i * 0.011 : e.dir === 'U' ? (ms.length - 1 - i) * 0.009 : 0;
      if (e.dir === 'U' && i < ms.length - 4) return;
      let n;
      const sn = sampled && e.si && nearestSample(e.si, m), sp = sn != null && sBufs.get(`${e.si}/${sn}.mp3`);
      if (sp && sp.done){ n = play(sp.done, e.t + st, e.v * 0.3 / Math.sqrt(ms.length) * (e.inst === 'bass' ? 1.6 : 1), out, null, Math.pow(2, (m - sn) / 12)); }
      else { const v = voiceBuf(e.inst, m, e.dur); if (!v) return; n = play(v, e.t + st, e.v * 0.35 / Math.sqrt(ms.length) * (e.inst === 'bass' ? 2 : 1), out); }
      const end = e.t + st + e.dur + 0.05;   // damp the note at its length (strings/keys)
      if (!n) return;
      if (e.inst !== 'piano' || e.dur < 2){ const rel = e.inst === 'guitar' ? 0.12 : 0.18; n.g.gain.setValueAtTime(n.g.gain.value, end); n.g.gain.exponentialRampToValueAtTime(0.0008, end + rel); n.s.stop(end + rel + 0.02); }
      else n.s.stop(e.t + st + e.dur + 1.2);
    });
  }
  if (!opt.only && cv.crowd > 0){ const cb = crowdBuf(ctx, len, cv.crowd, cv.applause ? A.length - 0.6 : null); const s = ctx.createBufferSource(); s.buffer = cb; s.connect(master); s.start(0); }
  else if (!opt.only && cv.applause){ const cb = crowdBuf(ctx, len, 0.05, A.length - 0.6); const s = ctx.createBufferSource(); s.buffer = cb; s.connect(master); s.start(0); }
  const out = await ctx.startRendering();
  // normalise to -1 dBFS
  let pk = 0; for (let c = 0; c < 2; c++){ const d = out.getChannelData(c); for (let i = 0; i < d.length; i++){ const a = Math.abs(d[i]); if (a > pk) pk = a; } }
  if (pk > 0){ const g = 0.89 / pk; for (let c = 0; c < 2; c++){ const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; } }
  return { buf: out, A };
}
async function clickTrack(cv){
  const A = arrange(cv), ctx = new OfflineAudioContext(1, Math.ceil(A.length * SR), SR);
  const beats = Math.floor((A.length - A.spb) / A.spb);
  for (let i = 0; i < beats; i++){
    const t = i * A.spb, o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = i % (cv.meter === 3 ? 3 : 4) ? 1000 : 1600;
    g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.06);
  }
  return ctx.startRendering();
}

/* ======================= exporters ======================= */
function wavOf(buf){
  const ch = buf.numberOfChannels, n = buf.length, b = new ArrayBuffer(44 + n * ch * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++){ const s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([b], { type: 'audio/wav' });
}
async function mp3Of(buf){
  if (!window.lamejs){ await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/lame.min.js'; s.onload = res; s.onerror = () => { s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js'; s.onload = res; s.onerror = rej; }; document.head.appendChild(s); }); }
  const enc = new lamejs.Mp3Encoder(2, buf.sampleRate, 192), L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), out = [], B = 1152;
  const to16 = (a, o, n) => { const r = new Int16Array(n); for (let i = 0; i < n; i++){ const x = Math.max(-1, Math.min(1, a[o + i])); r[i] = x < 0 ? x * 0x8000 : x * 0x7fff; } return r; };
  for (let o = 0; o < L.length; o += B){ const n = Math.min(B, L.length - o); const b = enc.encodeBuffer(to16(L, o, n), to16(R, o, n)); if (b.length) out.push(b); if (o % (B * 400) === 0) await tick(); }
  out.push(enc.flush()); return new Blob(out, { type: 'audio/mpeg' });
}
const GMDRUM = { kick: 36, snare: 38, hat: 42, ride: 51, crash: 49, rim: 37, cajonB: 35, cajonS: 40, cajonG: 39, shaker: 70, brush: 38, cowbell: 56, guiro: 73, sticks: 31, clap: 39 };
const GMPROG = { guitar: 25, eguitar: 27, bass: 32, piano: 0, epiano: 4, organ: 16, pad: 48 };
function midiOf(cv){
  const A = arrange(cv), tpq = 480, spb = A.spb, toTick = t => Math.max(0, Math.round(t / spb * tpq));
  const vlq = n => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const tracks = [], insts = [...new Set(A.ev.map(e => e.inst))];
  const tempo = Math.round(spb * 1e6);
  tracks.push([0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0, 0xff, 0x58, 4, cv.meter === 3 ? 3 : 4, 2, 24, 8, 0, 0xff, 0x2f, 0]);
  insts.forEach((inst, ti) => {
    const ch = inst === 'drums' ? 9 : Math.min(8, ti), evs = [];
    A.ev.filter(e => e.inst === inst).forEach(e => {
      const ns = inst === 'drums' ? [GMDRUM[e.d] || 38] : e.m, vel = Math.max(1, Math.min(127, Math.round(e.v * 110)));
      ns.forEach(n => { evs.push([toTick(e.t), 0x90 | ch, n, vel]); evs.push([toTick(e.t + (inst === 'drums' ? 0.1 : e.dur)), 0x80 | ch, n, 0]); });
    });
    evs.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0));
    const name = [...new TextEncoder().encode(inst)];
    const bytes = [0, 0xff, 0x03, name.length, ...name];
    if (inst !== 'drums') bytes.push(0, 0xc0 | ch, GMPROG[inst] || 0);
    let last = 0; evs.forEach(e => { bytes.push(...vlq(e[0] - last), e[1], e[2], e[3]); last = e[0]; });
    bytes.push(0, 0xff, 0x2f, 0); tracks.push(bytes);
  });
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (tpq >> 8) & 255, tpq & 255];
  const parts = [new Uint8Array(hdr)];
  tracks.forEach(t => { const L = t.length; parts.push(new Uint8Array([0x4d, 0x54, 0x72, 0x6b, (L >>> 24) & 255, (L >> 16) & 255, (L >> 8) & 255, L & 255]), new Uint8Array(t)); });
  return new Blob(parts, { type: 'audio/midi' });
}
function chordSheet(cv){
  const tr = cv.transpose, k = { r: (cv.key.r + tr + 120) % 12, q: cv.key.q };
  let s = `${cv.name || 'Cover'}\nคีย์: ${cname(k)}${tr ? ` (ต้นฉบับ ${cname(cv.key)}, ${tr > 0 ? '+' : ''}${tr})` : ''} · ${Math.round(cv.bpm * cv.tempo)} BPM · ${cv.meter === 3 ? '3/4' : '4/4'} · สไตล์: ${STYLES.find(x => x[0] === cv.style)[1]}\n`;
  s += cv.countIn ? 'นับเข้า 1 ห้อง (ไม้กลอง 4 ครั้ง)\n' : '';
  s += cv.intro ? `อินโทร ${Math.min(4, cv.bars.length)} ห้อง\n` : '';
  s += '\n';
  cv.bars.forEach((b, i) => { if (i % 4 === 0) s += (i ? ' |\n' : '') + String(i + 1).padStart(3, ' ') + ' '; s += '| ' + b.chords.map(c => cname(c, tr)).join(' ').padEnd(9, ' '); });
  s += ' |\n\nทำในแอป Gen Medi — ดนตรีบันทึกใหม่ด้วยเครื่องดนตรีสังเคราะห์ในแอป\nทำนองและเนื้อร้องเป็นลิขสิทธิ์ของผู้แต่ง — ก่อนเผยแพร่เชิงพาณิชย์ ตรวจสิทธิ์/ขออนุญาตก่อน\n';
  return new Blob([s], { type: 'text/plain;charset=utf-8' });
}

/* ======================= UI ======================= */
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function newCover(name){ return { meter: 4, sampled: true, name: name || 'Cover', bpm: 100, key: { r: 0, q: '' }, bars: [], transpose: 0, tempo: 1, style: 'acoustic', room: 0.45, crowd: 0.25, applause: true, countIn: true, intro: true, rights: false }; }
function renderUI(){
  if (!root) return;
  if (!C){
    root.innerHTML = `
      <div class="card"><div class="card-h"><h2>🎸 คัฟเวอร์ / ไลฟ์ (ดนตรี)</h2></div>
        <p class="hint" style="margin-top:0">ใส่ไฟล์เพลง → แอปแกะ<b>จังหวะ คีย์ คอร์ด</b> → เล่นใหม่ด้วยเครื่องดนตรีในแอปเป็นสไตล์ร้านดนตรีสด แล้วคุณไปอัดร้องเองได้ · ประมวลผลในเครื่องนี้ ไม่ใช้ API</p>
        <div class="row2" style="margin-top:10px"><label class="btn" style="flex:1;text-align:center">📁 เลือกไฟล์เพลง<input type="file" id="cvFile" accept="audio/*,video/*" hidden></label><button class="btn alt" style="flex:1" id="cvBlank">✍️ ใส่คอร์ดเอง</button></div>
        <div class="row2" style="margin-top:8px"><input class="inp" id="cvUrl" placeholder="หรือวางลิงก์ไฟล์เสียงโดยตรง (.mp3/.wav)"><button class="btn alt" id="cvGo">ดึง</button></div>
        <div id="cvProg"></div>
        <div class="lim" style="margin-top:12px;font-size:13.5px">⚖️ <b>เรื่องลิขสิทธิ์</b> — ไฟล์ต้นฉบับใช้แค่<b>วิเคราะห์และฟังซ้อม</b> ไม่ถูกใส่ลงในไฟล์ที่ส่งออก ผลลัพธ์จึงเป็นการบันทึกเสียงใหม่ของคุณ แต่ <b>ทำนองและเนื้อร้องยังเป็นของผู้แต่ง</b>: บน YouTube คลิปคัฟเวอร์มักถูก Content ID เคลมและแบ่งรายได้กับเจ้าของเพลง · ถ้าจะเก็บรายได้เต็ม ต้องเป็นเพลงที่คุณแต่งเอง เพลงหมดลิขสิทธิ์ หรือได้รับอนุญาตแล้ว · ไม่รองรับลิงก์ YouTube/Spotify/TikTok</div>
      </div>`;
    root.querySelector('#cvFile').onchange = e => { const f = e.target.files[0]; if (f) loadSong(f, f.name.replace(/\.[^.]+$/, '')); };
    root.querySelector('#cvBlank').onclick = () => { C = newCover('เพลงของฉัน'); C.bars = 'C G Am F C G F G'.split(' ').map(t => ({ chords: [parseChord(t)] })); renderUI(); };
    root.querySelector('#cvGo').onclick = async () => {
      const u = root.querySelector('#cvUrl').value.trim(); if (!u) return;
      if (BLOCKED.test(u)) return toast('ลิงก์จากแพลตฟอร์มสตรีมมิ่งดึงไฟล์ไม่ได้ (ผิดเงื่อนไขการใช้งาน) — ใช้ไฟล์เพลงที่คุณมีสิทธิ์ใช้', true);
      try { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); loadSong(await r.blob(), decodeURIComponent(u.split('/').pop().split('?')[0]).replace(/\.[^.]+$/, '') || 'Cover'); }
      catch(e){ toast('ดึงไฟล์ไม่ได้ (' + e.message + ') — เว็บต้นทางอาจไม่อนุญาต ให้ดาวน์โหลดไฟล์ก่อนแล้วเลือกไฟล์แทน', true); }
    };
    return;
  }
  const tr = C.transpose, k = { r: (C.key.r + tr + 120) % 12, q: C.key.q }, bpm = Math.round(C.bpm * C.tempo);
  const dur = (C.bars.length + (C.intro ? Math.min(4, C.bars.length) : 0) + (C.countIn ? 1 : 0) + 1.6) * 4 * 60 / bpm;
  root.innerHTML = `
    <div class="card"><div class="card-h"><h2>🎸 ${esc(C.name)}</h2><button class="ghost" id="cvNew">＋ เพลงใหม่</button></div>
      <div class="row2" style="flex-wrap:wrap;gap:8px"><span class="tag ok">คีย์ ${cname(k)}</span><span class="tag">${bpm} BPM</span><span class="tag">${C.bars.length} ห้อง</span><span class="tag">~${fmt(dur)}</span></div>
      ${C.src ? `<label class="lbl2">ต้นฉบับ (ฟังซ้อมเท่านั้น — ไม่ถูกส่งออก)</label><audio controls src="${C.srcUrl}" style="width:100%"></audio>` : ''}
    </div>
    <div class="card"><div class="card-h"><h2>🎼 สไตล์วง</h2></div>
      <div class="fxgrid" id="cvStyles">${STYLES.map(s => `<button class="fxp ${C.style === s[0] ? 'on' : ''}" data-s="${s[0]}"><span>${s[1].split(' ')[0]}</span><small>${s[1].split(' ').slice(1).join(' ')}</small></button>`).join('')}</div>
      <p class="hint" id="cvStyleD">${esc(STYLES.find(s => s[0] === C.style)[2])}</p>
      <div class="row2" style="gap:8px;flex-wrap:wrap"><div class="chips" id="cvMeter">${[[4, '4/4 ทั่วไป'], [3, '3/4 วอลทซ์']].map(o => `<button class="chip ${(C.meter || 4) === o[0] ? 'on' : ''}" data-m="${o[0]}">${o[1]}</button>`).join('')}</div>
      <div class="chips" id="cvSamp">${[[1, '🎻 เสียงเครื่องจริง'], [0, '🎛️ สังเคราะห์']].map(o => `<button class="chip ${(C.sampled !== false ? 1 : 0) === o[0] ? 'on' : ''}" data-v="${o[0]}">${o[1]}</button>`).join('')}</div></div>
      <p class="hint" style="margin-top:4px">เสียงเครื่องจริงมาจาก FluidR3 GM soundfont (MIT ใช้เชิงพาณิชย์ได้) โหลดครั้งแรกประมาณ 2–4MB</p>
      <div class="fxr"><div class="fxl"><span>เปลี่ยนคีย์ (ให้เข้ากับเสียงร้อง)</span><b id="cvTrV">${tr > 0 ? '+' : ''}${tr}</b></div><input type="range" id="cvTr" min="-7" max="7" step="1" value="${tr}"></div>
      <div class="fxr"><div class="fxl"><span>ความเร็ว</span><b id="cvTpV">${bpm} BPM</b></div><input type="range" id="cvTp" min="0.7" max="1.3" step="0.01" value="${C.tempo}"></div>
      <div class="fxr"><div class="fxl"><span>เสียงห้อง / ความก้องในร้าน</span><b id="cvRmV">${Math.round(C.room * 100)}%</b></div><input type="range" id="cvRm" min="0" max="1" step="0.05" value="${C.room}"></div>
      <div class="fxr"><div class="fxl"><span>เสียงคนในร้าน (บรรยากาศ)</span><b id="cvCrV">${Math.round(C.crowd * 100)}%</b></div><input type="range" id="cvCr" min="0" max="0.8" step="0.05" value="${C.crowd}"></div>
      <label class="check"><input type="checkbox" id="cvCount" ${C.countIn ? 'checked' : ''}><span>นับเข้าด้วยไม้กลอง (1-2-3-4)</span></label>
      <label class="check"><input type="checkbox" id="cvIntro" ${C.intro ? 'checked' : ''}><span>ใส่อินโทร 4 ห้อง</span></label>
      <label class="check"><input type="checkbox" id="cvApp" ${C.applause ? 'checked' : ''}><span>เสียงปรบมือตอนจบ</span></label>
    </div>
    <div class="card"><div class="card-h"><h2>🎹 คอร์ด (แตะเพื่อแก้)</h2><button class="ghost" id="cvAddBar">＋ ห้อง</button></div>
      <p class="hint" style="margin-top:0">AI แกะคอร์ดได้ใกล้เคียง แต่ไม่แม่น 100% — ฟังต้นฉบับแล้วแก้ให้ตรงได้ · พิมพ์ทั้งเพลงได้ที่ “แก้แบบข้อความ”</p>
      <div class="cvbars" id="cvBars">${C.bars.map((b, i) => `<button class="cvbar" data-i="${i}"><small>${i + 1}</small>${b.chords.map(c => cname(c, tr)).join(' ')}</button>`).join('')}</div>
      <button class="btn alt sm" id="cvText" style="margin-top:10px">✍️ แก้แบบข้อความ</button>
    </div>
    <div class="card"><div class="card-h"><h2>🎧 สร้างดนตรี</h2></div>
      <button class="cta" id="cvRender" style="margin:0"><span class="bars"><i></i><i></i><i></i><i></i></span><span>สร้างดนตรีแบบไลฟ์</span></button>
      <div id="cvOut" style="margin-top:12px"></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="cvRights" ${C.rights ? 'checked' : ''}><span>เพลงนี้ฉันแต่งเอง / หมดลิขสิทธิ์แล้ว / ได้รับอนุญาตแล้ว (ให้ใช้ในสตูดิโอวิดีโอโหมดเชิงพาณิชย์ได้)</span></label>
      <p class="hint">💡 แนะนำ: ส่งออก “แยกเครื่องดนตรี + MIDI + คลิก” แล้วอัดร้องใน BandLab/GarageBand ฟรี หรือใช้ “สตูดิโอวิดีโอ” ของแอปนี้ ใส่วิดีโอที่ถ่ายตอนร้อง ใส่เนื้อร้องเป็นซับ</p>
    </div>`;
  const re = () => { renderCache = null; };
  root.querySelector('#cvNew').onclick = () => { if (C.srcUrl) URL.revokeObjectURL(C.srcUrl); C = null; renderCache = null; renderUI(); };
  root.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { C.style = b.dataset.s; re(); renderUI(); });
  root.querySelectorAll('#cvMeter [data-m]').forEach(b => b.onclick = () => { C.meter = +b.dataset.m; re(); renderUI(); });
  root.querySelectorAll('#cvSamp [data-v]').forEach(b => b.onclick = () => { C.sampled = b.dataset.v === '1'; re(); renderUI(); });
  const slider = (id, key, fmtv, after) => { const r = root.querySelector('#' + id); GM.setRangeFill?.(r); r.oninput = () => { C[key] = +r.value; root.querySelector('#' + id + 'V').textContent = fmtv(+r.value); GM.setRangeFill?.(r); re(); }; r.onchange = () => after && after(); };
  slider('cvTr', 'transpose', v => (v > 0 ? '+' : '') + v, renderUI);
  slider('cvTp', 'tempo', v => Math.round(C.bpm * v) + ' BPM', renderUI);
  slider('cvRm', 'room', v => Math.round(v * 100) + '%');
  slider('cvCr', 'crowd', v => Math.round(v * 100) + '%');
  [['cvCount', 'countIn'], ['cvIntro', 'intro'], ['cvApp', 'applause'], ['cvRights', 'rights']].forEach(([id, k2]) => root.querySelector('#' + id).onchange = e => { C[k2] = e.target.checked; if (k2 !== 'rights') re(); save(); });
  root.querySelectorAll('.cvbar').forEach(b => b.onclick = () => editBar(+b.dataset.i));
  root.querySelector('#cvAddBar').onclick = () => { C.bars.push({ chords: [{ ...(C.bars[C.bars.length - 1]?.chords[0] || { r: 0, q: '' }) }] }); re(); renderUI(); };
  root.querySelector('#cvText').onclick = editText;
  root.querySelector('#cvRender').onclick = doRender;
  save();
}
function save(){ if (C) try { GM.LS.set('cover', { ...C, src: null, srcUrl: null }); } catch(e){} }
function editBar(i){
  const b = C.bars[i], tr = C.transpose;
  const h = sheetHead(`ห้องที่ ${i + 1}`) + `<p class="hint" style="margin-top:0">พิมพ์คอร์ด (ใส่ 2 คอร์ดได้ เช่น <code>Am G</code>) — แสดงตามคีย์ที่เปลี่ยนแล้ว</p>
    <input class="inp" id="ebTxt" value="${esc(b.chords.map(c => cname(c, tr)).join(' '))}">
    <div class="chips" style="margin-top:10px">${NOTE.map(n => `<button class="chip" data-n="${n}">${n}</button>`).join('')}</div>
    <div class="chips" style="margin-top:8px">${Object.keys(QUAL).map(q => `<button class="chip" data-q="${q}">${q || 'major'}</button>`).join('')}</div>
    <div class="row2" style="margin-top:12px"><button class="btn danger sm" id="ebDel">ลบห้องนี้</button><button class="btn alt sm" id="ebDup">ทำซ้ำ</button><button class="btn" style="flex:1" id="ebOk">ตกลง</button></div>`;
  openSheet(h, el => {
    const inp = el.querySelector('#ebTxt');
    let root2 = null;
    el.querySelectorAll('[data-n]').forEach(x => x.onclick = () => { root2 = x.dataset.n; const parts = inp.value.trim().split(/\s+/).filter(Boolean); parts[parts.length ? parts.length - 1 : 0] = root2; inp.value = parts.join(' '); });
    el.querySelectorAll('[data-q]').forEach(x => x.onclick = () => { const parts = inp.value.trim().split(/\s+/).filter(Boolean); if (!parts.length) return; const c = parseChord(parts[parts.length - 1]); if (c) parts[parts.length - 1] = NOTE[c.r] + x.dataset.q; inp.value = parts.join(' '); });
    el.querySelector('#ebOk').onclick = () => {
      const cs = inp.value.trim().split(/\s+/).map(parseChord).filter(Boolean).slice(0, 2).map(c => ({ r: (c.r - tr + 120) % 12, q: c.q }));
      if (cs.length) C.bars[i] = { chords: cs }; renderCache = null; closeAll(); renderUI();
    };
    el.querySelector('#ebDel').onclick = () => { if (C.bars.length > 1) C.bars.splice(i, 1); renderCache = null; closeAll(); renderUI(); };
    el.querySelector('#ebDup').onclick = () => { C.bars.splice(i + 1, 0, JSON.parse(JSON.stringify(C.bars[i]))); renderCache = null; closeAll(); renderUI(); };
  });
}
function editText(){
  const tr = C.transpose, txt = C.bars.map(b => b.chords.map(c => cname(c, tr)).join(' ')).reduce((s, b, i) => s + (i && i % 4 === 0 ? '\n' : i ? ' | ' : '') + b, '');
  openSheet(sheetHead('แก้คอร์ดแบบข้อความ') + `<p class="hint" style="margin-top:0">คั่นห้องด้วย <code>|</code> หรือขึ้นบรรทัดใหม่ · ห้องเดียวใส่ 2 คอร์ดได้ เช่น <code>C G | Am | F G</code></p>
    <textarea class="inp" id="etT" style="height:220px;padding:12px;font-family:monospace">${esc(txt)}</textarea><button class="btn" style="width:100%;margin-top:10px" id="etOk">ตกลง</button>`,
  el => el.querySelector('#etOk').onclick = () => {
    const bars = el.querySelector('#etT').value.split(/\||\n/).map(s => s.trim()).filter(Boolean).map(s => ({ chords: s.split(/\s+/).map(parseChord).filter(Boolean).slice(0, 2).map(c => ({ r: (c.r - tr + 120) % 12, q: c.q })) })).filter(b => b.chords.length);
    if (bars.length){ C.bars = bars; renderCache = null; } closeAll(); renderUI();
  });
}
async function loadSong(blob, name){
  const box = root.querySelector('#cvProg');
  box.innerHTML = `<div class="prog2"><i style="width:3%"></i></div><p class="hint" id="cvMsg">กำลังเปิดไฟล์…</p>`;
  try {
    const t0 = performance.now();
    const r = await analyse(blob, (p, m) => { const i = box.querySelector('.prog2 i'); if (i) i.style.width = Math.round(p * 100) + '%'; const mm = box.querySelector('#cvMsg'); if (mm) mm.textContent = m; });
    C = Object.assign(newCover(name), { bpm: r.bpm, key: r.key, bars: r.bars, src: blob, srcUrl: URL.createObjectURL(blob), duration: r.duration });
    renderCache = null; renderUI();
    toast(`แกะเพลงเสร็จใน ${((performance.now() - t0) / 1000).toFixed(1)} วินาที — ${r.bpm} BPM คีย์ ${cname(r.key)}`);
  } catch(e){ box.innerHTML = `<p class="lim">อ่านไฟล์ไม่ได้: ${esc(e.message || String(e))} — ลอง MP3/WAV/M4A</p>`; }
}
async function doRender(){
  const out = root.querySelector('#cvOut'), btn = root.querySelector('#cvRender');
  btn.disabled = true; btn.classList.add('busy');
  out.innerHTML = `<p class="hint">กำลังเล่นดนตรีและมิกซ์… (เพลง 4 นาทีใช้เวลาประมาณ 10–40 วินาที)</p>`;
  await tick();
  try {
    const t0 = performance.now();
    const key = JSON.stringify({ ...C, src: null, srcUrl: null, rights: null });
    if (!renderCache || renderCache.key !== key) renderCache = { key, ...(await render(C, { prog: p => { const h = out.querySelector('.hint'); if (h) h.textContent = `กำลังโหลดเสียงเครื่องดนตรีจริง ${Math.round(p * 100)}%…`; } })) };
    const wav = wavOf(renderCache.buf), url = URL.createObjectURL(wav);
    const base = `${(C.name || 'cover').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 40)} (${STYLES.find(s => s[0] === C.style)[1].split(' ')[1]} cover)`;
    out.innerHTML = `<audio controls src="${url}" style="width:100%"></audio>
      <p class="hint">เสร็จใน ${((performance.now() - t0) / 1000).toFixed(1)} วินาที · ${fmt(renderCache.buf.duration)} · ร้องเริ่มที่ ${fmt(renderCache.A.songStart)}</p>
      <div class="row2" style="flex-wrap:wrap;gap:8px"><button class="btn sm" data-x="mp3">⬇️ MP3</button><button class="btn sm alt" data-x="wav">⬇️ WAV</button><button class="btn sm alt" data-x="share">📤 แชร์ / Drive</button></div>
      <div class="row2" style="flex-wrap:wrap;gap:8px;margin-top:8px"><button class="btn sm alt" data-x="stems">🎚️ แยกเครื่องดนตรี</button><button class="btn sm alt" data-x="click">⏱ คลิก</button><button class="btn sm alt" data-x="midi">🎹 MIDI</button><button class="btn sm alt" data-x="sheet">📄 คอร์ดชีท</button></div>
      <button class="btn alt" style="width:100%;margin-top:8px" data-x="studio">🎬 ใช้เป็นเพลงในสตูดิโอวิดีโอ</button>
      <div class="vocbox"><h4 style="margin:14px 0 6px">🎤 อัดร้องทับในแอป</h4>
        <p class="hint" style="margin-top:0">ใส่หูฟังก่อน (กันเสียงดนตรีเข้าไมค์) → กดอัด แล้วร้องตามดนตรี · หรือนำเข้าไฟล์ร้องที่อัดจากแอปอื่น (ต้องเริ่มพร้อมดนตรี)</p>
        <div class="row2" style="gap:8px"><button class="btn" style="flex:1" id="vcRec">⏺ อัดร้อง</button><label class="btn alt" style="flex:1;text-align:center">📁 นำเข้าไฟล์ร้อง<input type="file" id="vcFile" accept="audio/*,video/*" hidden></label></div>
        <div id="vcOut"></div></div>`;
    bindVocal(out, fileOf, deliver);
    const fileOf = (blob, ext, suffix = '') => new File([blob], `${base}${suffix} ${stamp()}.${ext}`, { type: blob.type });
    const deliver = (f, kind = 'music') => { saveBlob(f, f.name); saveToMac(f, kind, f.name.replace(/\.[^.]+$/, '')); };
    out.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      const x = b.dataset.x, keep = b.textContent; b.disabled = true; b.textContent = '…';
      try {
        if (x === 'wav') deliver(fileOf(wav, 'wav'));
        if (x === 'mp3') deliver(fileOf(await mp3Of(renderCache.buf), 'mp3'));
        if (x === 'share') await shareFiles([fileOf(await mp3Of(renderCache.buf), 'mp3')], C.name);
        if (x === 'click') deliver(fileOf(wavOf(await clickTrack(C)), 'wav', ' - click'));
        if (x === 'midi') deliver(fileOf(midiOf(C), 'mid'));
        if (x === 'sheet') deliver(fileOf(chordSheet(C), 'txt', ' - chords'));
        if (x === 'stems'){
          const insts = [...new Set(renderCache.A.ev.map(e => e.inst))], files = [];
          for (const inst of insts){ b.textContent = inst + '…'; const r = await render(C, { only: inst }); files.push(fileOf(wavOf(r.buf), 'wav', ' - ' + inst)); }
          if (navigator.canShare?.({ files })) await shareFiles(files, C.name + ' stems'); else files.forEach(f => deliver(f));
        }
        if (x === 'studio'){
          const f = fileOf(await mp3Of(renderCache.buf), 'mp3');
          addHistory({ kind: 'audio', text: 'คัฟเวอร์: ' + C.name, voice: 'Cover/Live', blob: f });
          GM.go('studio');
          setTimeout(() => window.GMStudio?.setMusic ? window.GMStudio.setMusic(f, C.rights ? 'user' : 'cover', C.name) : toast('เปิดสตูดิโอแล้ว — ใส่ไฟล์ MP3 นี้เป็นเพลงประกอบ (ดาวน์โหลดไว้ในคลังงาน)'), 200);
        }
      } catch(e){ toast('ส่งออกไม่สำเร็จ: ' + (e.message || e), true); }
      b.disabled = false; b.textContent = keep;
    });
  } catch(e){ out.innerHTML = `<p class="lim">สร้างไม่สำเร็จ: ${esc(e.message || String(e))}</p>`; }
  btn.disabled = false; btn.classList.remove('busy');
}
/* ======================= vocals: record over the backing, then mix ======================= */
let vocal = null;   // {buf, offset}
const VX = Object.assign({ vol: 1, rev: 0.25, lat: 0 }, GM.LS.get('coverVocal', {}));
function bindVocal(out, fileOf, deliver){
  const box = out.querySelector('#vcOut'), recBtn = out.querySelector('#vcRec');
  let rec = null, stream = null, ac = null, src = null;
  const show = () => {
    if (!vocal){ box.innerHTML = ''; return; }
    box.innerHTML = `<p class="hint">ได้เสียงร้อง ${fmt(vocal.buf.duration)} — ปรับแล้วกด “มิกซ์”</p>
      <div class="fxr"><div class="fxl"><span>ความดังเสียงร้อง</span><b id="vxVolV">${Math.round(VX.vol * 100)}%</b></div><input type="range" id="vxVol" min="0.3" max="2" step="0.05" value="${VX.vol}"></div>
      <div class="fxr"><div class="fxl"><span>เสียงก้องบนเสียงร้อง</span><b id="vxRevV">${Math.round(VX.rev * 100)}%</b></div><input type="range" id="vxRev" min="0" max="0.7" step="0.05" value="${VX.rev}"></div>
      <div class="fxr"><div class="fxl"><span>เลื่อนเวลาเสียงร้อง (แก้ร้องช้า/เร็วกว่าดนตรี)</span><b id="vxLatV">${VX.lat} ms</b></div><input type="range" id="vxLat" min="-400" max="400" step="10" value="${VX.lat}"></div>
      <div class="row2" style="gap:8px;flex-wrap:wrap"><button class="btn" style="flex:2" id="vxMix">🎚️ มิกซ์ + ฟัง</button><button class="btn alt sm" id="vxDel">ลบเสียงร้อง</button></div><div id="vxRes"></div>`;
    [['vxVol', 'vol', v => Math.round(v * 100) + '%'], ['vxRev', 'rev', v => Math.round(v * 100) + '%'], ['vxLat', 'lat', v => v + ' ms']].forEach(([id, k, f]) => {
      const r = box.querySelector('#' + id); GM.setRangeFill?.(r); r.oninput = () => { VX[k] = +r.value; box.querySelector('#' + id + 'V').textContent = f(+r.value); GM.setRangeFill?.(r); GM.LS.set('coverVocal', VX); };
    });
    box.querySelector('#vxDel').onclick = () => { vocal = null; show(); };
    box.querySelector('#vxMix').onclick = async e => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'กำลังมิกซ์…';
      try {
        const mix = await mixVocal(renderCache.buf, vocal, VX), wav = wavOf(mix);
        const res = box.querySelector('#vxRes');
        res.innerHTML = `<audio controls src="${URL.createObjectURL(wav)}" style="width:100%;margin-top:10px"></audio><div class="row2" style="gap:8px;flex-wrap:wrap"><button class="btn sm" data-y="mp3">⬇️ MP3 (เพลงเต็ม)</button><button class="btn sm alt" data-y="wav">⬇️ WAV</button><button class="btn sm alt" data-y="voc">⬇️ เสียงร้องอย่างเดียว</button><button class="btn sm alt" data-y="studio">🎬 ใส่ในสตูดิโอ</button></div>`;
        res.querySelectorAll('[data-y]').forEach(x => x.onclick = async () => {
          if (x.dataset.y === 'wav') deliver(fileOf(wav, 'wav', ' - live mix'));
          if (x.dataset.y === 'mp3') deliver(fileOf(await mp3Of(mix), 'mp3', ' - live mix'));
          if (x.dataset.y === 'voc') deliver(fileOf(wavOf(vocal.buf), 'wav', ' - vocal'));
          if (x.dataset.y === 'studio'){ const f = fileOf(await mp3Of(mix), 'mp3', ' - live mix'); addHistory({ kind: 'audio', text: 'คัฟเวอร์+ร้อง: ' + C.name, voice: 'Cover/Live', blob: f }); GM.go('studio'); setTimeout(() => window.GMStudio?.setMusic?.(f, C.rights ? 'user' : 'cover', C.name), 200); }
        });
      } catch(err){ toast('มิกซ์ไม่สำเร็จ: ' + (err.message || err), true); }
      b.disabled = false; b.textContent = '🎚️ มิกซ์ + ฟัง';
    };
  };
  show();
  out.querySelector('#vcFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { vocal = { buf: await decodeAt(f, SR, 1), offset: 0 }; show(); } catch(err){ toast('อ่านไฟล์ไม่ได้', true); } };
  recBtn.onclick = async () => {
    if (rec){ rec.stop(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch(err){ return toast('เปิดไมค์ไม่ได้: ' + (err.message || err), true); }
    ac = new AudioContext(); await ac.resume();
    src = ac.createBufferSource(); src.buffer = renderCache.buf; src.connect(ac.destination);
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    const parts = []; rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    rec.ondataavailable = ev => ev.data.size && parts.push(ev.data);
    let recStart = 0;
    rec.onstart = () => { recStart = ac.currentTime; };
    const t0 = ac.currentTime + 0.3;
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); try { src.stop(); } catch(e){}
      const lat = (ac.outputLatency || 0) + (ac.baseLatency || 0);
      ac.close(); rec = null; recBtn.textContent = '⏺ อัดร้อง';
      try { const buf = await decodeAt(new Blob(parts, { type: parts[0]?.type || 'audio/webm' }), SR, 1); vocal = { buf, offset: (t0 - recStart) + lat }; show(); toast('อัดเสร็จ — กด “มิกซ์ + ฟัง”'); }
      catch(err){ toast('ถอดรหัสเสียงที่อัดไม่ได้', true); }
    };
    rec.start(); src.start(t0); src.onended = () => rec && rec.state === 'recording' && rec.stop();
    recBtn.textContent = '⏹ หยุดอัด';
  };
}
async function mixVocal(back, voc, vx){
  const len = back.length, ctx = new OfflineAudioContext(2, len, SR);
  const b = ctx.createBufferSource(); b.buffer = back; b.connect(ctx.destination); b.start(0);
  const v = ctx.createBufferSource(); v.buffer = voc.buf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.gain.value = 2.5;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.15;
  const g = ctx.createGain(); g.gain.value = vx.vol * 1.4;
  v.connect(hp); hp.connect(pres); pres.connect(comp); comp.connect(g); g.connect(ctx.destination);
  if (vx.rev > 0){ const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 1.6, 3); const rg = ctx.createGain(); rg.gain.value = vx.rev; g.connect(cv); cv.connect(rg); rg.connect(ctx.destination); }
  // offset > 0 means the singer's audio starts later than the music: shift it earlier
  const off = (voc.offset || 0) + vx.lat / 1000;
  if (off >= 0) v.start(0, Math.min(off, voc.buf.duration - 0.01)); else v.start(-off);
  const outb = await ctx.startRendering();
  let pk = 0; for (let c = 0; c < 2; c++){ const d = outb.getChannelData(c); for (let i = 0; i < d.length; i++){ const a = Math.abs(d[i]); if (a > pk) pk = a; } }
  if (pk > 0.98){ const k = 0.95 / pk; for (let c = 0; c < 2; c++){ const d = outb.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
  return outb;
}
try { const saved = GM.LS.get('cover', null); if (saved && saved.bars?.length) C = Object.assign(newCover(), saved); } catch(e){}
renderUI();
window.GMCover = { OPT, analyse, render, arrange, midiOf, chordSheet, get C(){ return C; }, set C(v){ C = v; renderUI(); }, renderUI, wavOf };
