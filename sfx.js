/* Gen Medi — sound effects from text + background music generator.
   Everything is synthesised in the browser with the Web Audio API (no samples, no third-party recordings),
   so the output carries no outside copyright. */
const SR = 44100;
const noise = (ctx, sec) => { const b = ctx.createBuffer(1, Math.ceil(sec * ctx.sampleRate), ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; };
function src(ctx, buf){ const s = ctx.createBufferSource(); s.buffer = buf; return s; }
function g(ctx, v = 1){ const n = ctx.createGain(); n.gain.value = v; return n; }
function env(p, t, a, d, peak = 1, end = 0.0001){ p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(peak, t + Math.max(0.002, a)); p.exponentialRampToValueAtTime(end, t + a + d); }
function osc(ctx, type, f){ const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; }
function filt(ctx, type, f, q = 1){ const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }
function tone(ctx, out, t, type, f0, f1, dur, vol = 0.5, a = 0.005){ const o = osc(ctx, type, f0), e = g(ctx, 0); o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur); env(e.gain, t, a, dur, vol); o.connect(e).connect(out); o.start(t); o.stop(t + a + dur + 0.05); }
function burst(ctx, out, t, dur, ftype, f, vol = 0.5, q = 1, a = 0.002){ const s = src(ctx, noise(ctx, dur + 0.1)), fl = filt(ctx, ftype, f, q), e = g(ctx, 0); env(e.gain, t, a, dur, vol); s.connect(fl).connect(e).connect(out); s.start(t); s.stop(t + dur + 0.1); return fl; }

const R = {
  whoosh: { th: ['วูบ', 'ฟิ้ว', 'ปัด', 'เปลี่ยนฉาก', 'สวิง'], en: ['whoosh', 'swoosh', 'swipe', 'transition'], dur: 0.9, f(c, o, t, k){ const fl = burst(c, o, t, 0.75 * k, 'bandpass', 400, 0.9, 2, 0.25 * k); fl.frequency.setValueAtTime(300, t); fl.frequency.exponentialRampToValueAtTime(3500, t + 0.4 * k); fl.frequency.exponentialRampToValueAtTime(600, t + 0.8 * k); } },
  pop: { th: ['ป๊อป', 'โผล่', 'ปุ๊'], en: ['pop', 'bubble', 'appear'], dur: 0.2, f(c, o, t){ tone(c, o, t, 'sine', 700, 160, 0.12, 0.8); } },
  ding: { th: ['ติ๊ง', 'กริ๊ง', 'ระฆัง', 'แจ้งเตือน', 'ดิง'], en: ['ding', 'bell', 'notification', 'chime'], dur: 1.6, f(c, o, t, k){ [[880, .6], [1760, .25], [2640, .12], [3520, .06]].forEach(([f, v]) => tone(c, o, t, 'sine', f, f, 1.4 * k, v, 0.003)); } },
  click: { th: ['คลิก', 'กด', 'แตะ', 'ติ๊ก'], en: ['click', 'tap', 'button'], dur: 0.08, f(c, o, t){ burst(c, o, t, 0.02, 'highpass', 3000, 0.9); tone(c, o, t, 'square', 1800, 1200, 0.02, 0.15); } },
  coin: { th: ['เหรียญ', 'เงิน', 'รวย', 'ได้เงิน'], en: ['coin', 'money', 'cash'], dur: 0.6, f(c, o, t){ tone(c, o, t, 'square', 988, 988, 0.08, 0.25); tone(c, o, t + 0.08, 'square', 1319, 1319, 0.45, 0.25); } },
  success: { th: ['สำเร็จ', 'ถูกต้อง', 'ชนะ', 'เย้', 'ผ่าน'], en: ['success', 'win', 'correct', 'level up'], dur: 1.1, f(c, o, t){ [523, 659, 784, 1047].forEach((f, i) => tone(c, o, t + i * 0.1, 'triangle', f, f, 0.5, 0.45)); } },
  error: { th: ['ผิด', 'พลาด', 'เออเร่อ', 'ไม่ได้'], en: ['error', 'wrong', 'fail', 'buzz'], dur: 0.7, f(c, o, t){ tone(c, o, t, 'square', 220, 200, 0.22, 0.3); tone(c, o, t + 0.28, 'square', 180, 150, 0.32, 0.3); } },
  boom: { th: ['ระเบิด', 'ตูม', 'บึ้ม', 'กระแทก'], en: ['boom', 'explosion', 'impact', 'hit'], dur: 2.2, f(c, o, t, k){ const fl = burst(c, o, t, 1.8 * k, 'lowpass', 1200, 1, 0.7, 0.005); fl.frequency.setValueAtTime(1500, t); fl.frequency.exponentialRampToValueAtTime(80, t + 1.5 * k); tone(c, o, t, 'sine', 90, 35, 1.4 * k, 1); } },
  thunder: { th: ['ฟ้าร้อง', 'ฟ้าผ่า', 'พายุ'], en: ['thunder', 'storm', 'lightning'], dur: 4, f(c, o, t, k){ burst(c, o, t, 0.25, 'highpass', 2000, 0.6); for (let i = 0; i < 5; i++){ const fl = burst(c, o, t + 0.1 + i * 0.45 * k + Math.random() * 0.2, (1.2 + Math.random()) * k, 'lowpass', 220 + Math.random() * 200, 0.9 - i * 0.12, 0.8, 0.08); } } },
  rain: { th: ['ฝน', 'ฝนตก'], en: ['rain', 'raining'], dur: 6, f(c, o, t, k){ const d = 6 * k, s = src(c, noise(c, d)), hp = filt(c, 'highpass', 900), lp = filt(c, 'lowpass', 7000), e = g(c, 0); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(0.35, t + 0.8); e.gain.setValueAtTime(0.35, t + d - 0.8); e.gain.linearRampToValueAtTime(0.0001, t + d); s.connect(hp).connect(lp).connect(e).connect(o); s.start(t); for (let i = 0; i < 40 * k; i++) burst(c, o, t + Math.random() * d, 0.015, 'bandpass', 2500 + Math.random() * 3000, 0.25, 3); } },
  wind: { th: ['ลม', 'ลมพัด', 'หนาว'], en: ['wind', 'breeze', 'windy'], dur: 6, f(c, o, t, k){ const d = 6 * k, s = src(c, noise(c, d)), bp = filt(c, 'bandpass', 500, 1.5), e = g(c, 0), l = osc(c, 'sine', 0.25), lg = g(c, 350); l.connect(lg).connect(bp.frequency); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(0.6, t + 1.2); e.gain.setValueAtTime(0.6, t + d - 1.2); e.gain.linearRampToValueAtTime(0.0001, t + d); s.connect(bp).connect(e).connect(o); s.start(t); l.start(t); l.stop(t + d); } },
  heartbeat: { th: ['หัวใจ', 'ใจเต้น', 'ตื่นเต้น', 'ระทึก'], en: ['heartbeat', 'heart', 'suspense'], dur: 2.6, f(c, o, t){ for (let i = 0; i < 3; i++){ tone(c, o, t + i * 0.85, 'sine', 70, 45, 0.16, 1); tone(c, o, t + i * 0.85 + 0.22, 'sine', 60, 40, 0.14, 0.7); } } },
  typing: { th: ['พิมพ์', 'คีย์บอร์ด', 'พิมพ์ดีด'], en: ['typing', 'keyboard', 'typewriter'], dur: 2.2, f(c, o, t, k){ let x = t; for (let i = 0; i < 14 * k; i++){ x += 0.07 + Math.random() * 0.1; burst(c, o, x, 0.025, 'bandpass', 2500 + Math.random() * 1500, 0.6, 2); } } },
  laser: { th: ['เลเซอร์', 'ยิง', 'ปืนอวกาศ'], en: ['laser', 'shoot', 'zap'], dur: 0.4, f(c, o, t){ tone(c, o, t, 'square', 1600, 180, 0.3, 0.3); tone(c, o, t, 'sawtooth', 1200, 120, 0.3, 0.15); } },
  riser: { th: ['ไต่ระดับ', 'ลุ้น', 'บิวด์', 'กำลังจะ'], en: ['riser', 'build up', 'rise'], dur: 2.5, f(c, o, t, k){ const d = 2.2 * k; tone(c, o, t, 'sawtooth', 120, 1200, d, 0.18, d * 0.9); const fl = burst(c, o, t, d, 'bandpass', 500, 0.5, 2, d * 0.9); fl.frequency.exponentialRampToValueAtTime(6000, t + d); } },
  drumroll: { th: ['กลองรัว', 'รัวกลอง', 'ประกาศผล'], en: ['drumroll', 'drum roll', 'reveal'], dur: 2.4, f(c, o, t, k){ const d = 1.8 * k; for (let x = 0; x < d; x += 0.045) burst(c, o, t + x, 0.06, 'bandpass', 1800, 0.25 + 0.5 * x / d, 0.8); burst(c, o, t + d, 0.9, 'highpass', 5000, 0.7); tone(c, o, t + d, 'sine', 100, 50, 0.4, 0.9); } },
  glitch: { th: ['กลิตช์', 'ภาพกระตุก', 'สัญญาณเสีย'], en: ['glitch', 'digital', 'error noise'], dur: 0.6, f(c, o, t){ for (let i = 0; i < 10; i++) tone(c, o, t + i * 0.05, 'square', 200 + Math.random() * 2000, 200 + Math.random() * 2000, 0.04, 0.2); } },
  applause: { th: ['ปรบมือ', 'เสียงเชียร์', 'ยินดี'], en: ['applause', 'clap', 'cheer'], dur: 3.5, f(c, o, t, k){ for (let i = 0; i < 220 * k; i++) burst(c, o, t + Math.random() * 3 * k, 0.03, 'bandpass', 1200 + Math.random() * 2500, 0.18 * (1 - Math.random() * 0.5), 1.5); } },
  shutter: { th: ['ชัตเตอร์', 'ถ่ายรูป', 'กล้อง'], en: ['shutter', 'camera', 'photo'], dur: 0.35, f(c, o, t){ burst(c, o, t, 0.03, 'highpass', 2500, 0.9); burst(c, o, t + 0.12, 0.05, 'bandpass', 1500, 0.7, 1.5); } },
  magic: { th: ['เวทมนตร์', 'วิเศษ', 'วิ้ง', 'ประกาย', 'ดาว'], en: ['magic', 'sparkle', 'twinkle', 'shine'], dur: 1.8, f(c, o, t){ [1319, 1568, 1976, 2349, 2637, 3136].forEach((f, i) => tone(c, o, t + i * 0.07, 'sine', f, f, 0.9, 0.22)); for (let i = 0; i < 25; i++) burst(c, o, t + Math.random() * 1.3, 0.02, 'highpass', 8000, 0.15); } },
  tick: { th: ['นาฬิกา', 'ติ๊กต่อก', 'จับเวลา', 'นับถอยหลัง'], en: ['clock', 'tick', 'timer', 'countdown'], dur: 3, f(c, o, t, k){ for (let i = 0; i < 6 * k; i++) burst(c, o, t + i * 0.5, 0.02, 'bandpass', i % 2 ? 2200 : 3000, 0.7, 4); } },
  swish: { th: ['สะบัด', 'ซูม', 'พุ่ง'], en: ['swish', 'zoom', 'dash'], dur: 0.5, f(c, o, t){ const fl = burst(c, o, t, 0.35, 'bandpass', 2000, 0.7, 4, 0.05); fl.frequency.setValueAtTime(5000, t); fl.frequency.exponentialRampToValueAtTime(700, t + 0.35); } },
};
const MODS = { long: ['ยาว', 'นาน', 'long'], short: ['สั้น', 'short'], soft: ['เบา', 'ไกล', 'soft', 'quiet', 'far'], loud: ['ดัง', 'แรง', 'loud'] };
const has = (txt, arr) => arr.some(w => txt.includes(w));

function parse(text){
  const t = text.toLowerCase(), ids = [];
  for (const [id, r] of Object.entries(R)) if (has(t, r.th) || has(t, r.en)) ids.push(id);
  return { ids, k: has(t, MODS.long) ? 1.8 : has(t, MODS.short) ? 0.6 : 1, vol: has(t, MODS.soft) ? 0.45 : has(t, MODS.loud) ? 1 : 0.8, far: has(t, ['ไกล', 'far']) };
}
async function makeSfx(text){
  const p = parse(text);
  if (!p.ids.length) throw new Error('ไม่รู้จักเสียงนี้ — ลองคำเช่น: ' + Object.values(R).slice(0, 10).map(r => r.th[0]).join(', '));
  const dur = Math.max(...p.ids.map(id => R[id].dur)) * p.k + 0.3;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  const comp = ctx.createDynamicsCompressor(), master = g(ctx, p.vol);
  let out = master; if (p.far){ const lp = filt(ctx, 'lowpass', 1500); master.connect(lp); lp.connect(comp); } else master.connect(comp);
  comp.connect(ctx.destination);
  p.ids.forEach(id => R[id].f(ctx, out, 0.02, p.k));
  const buf = await ctx.startRendering();
  return { blob: window.GM.encodeWav([buf.getChannelData(0), buf.getChannelData(1)], SR), label: p.ids.map(id => R[id].th[0]).join(' + '), dur };
}

/* ---------------- background music generator ---------------- */
const MOODS = {
  chill: { n: 'ชิล Lo-fi', bpm: 78, root: 57, prog: [[0, 3, 7, 10], [-4, 0, 3, 7], [3, 7, 10, 14], [-2, 2, 5, 7]], drums: 'lofi', pluck: true, pad: 0.12 },
  bright: { n: 'สดใส Pop', bpm: 112, root: 60, prog: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], drums: 'pop', pluck: true, pad: 0.1 },
  warm: { n: 'อบอุ่น เล่าเรื่อง', bpm: 92, root: 55, prog: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], drums: 'soft', pluck: true, pad: 0.12 },
  epic: { n: 'ตื่นเต้น มันส์', bpm: 128, root: 52, prog: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], drums: 'drive', pluck: false, pad: 0.13, bass8: true },
  mystery: { n: 'ลึกลับ สืบสวน', bpm: 70, root: 50, prog: [[0, 3, 7], [-4, 0, 3], [-7, -3, 0], [-5, -1, 2]], drums: 'pulse', pluck: false, pad: 0.16 },
  calm: { n: 'สงบ ผ่อนคลาย', bpm: 60, root: 53, prog: [[0, 4, 7, 11], [5, 9, 12, 16], [2, 5, 9, 12], [7, 11, 14, 17]], drums: '', pluck: true, pad: 0.14 },
};
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
async function makeMusic(mood, seconds){
  const M = MOODS[mood] || MOODS.chill, sr = 32000, len = Math.max(8, Math.min(600, seconds));
  const ctx = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
  const master = g(ctx, 0.0001); master.gain.setValueAtTime(0.0001, 0); master.gain.linearRampToValueAtTime(0.7, 1.5); master.gain.setValueAtTime(0.7, Math.max(1.6, len - 2.5)); master.gain.linearRampToValueAtTime(0.0001, len);
  master.connect(comp).connect(ctx.destination);
  const beat = 60 / M.bpm, bar = beat * 4, nBars = Math.ceil(len / bar);
  const padBus = g(ctx, M.pad), lp = filt(ctx, 'lowpass', 1100, 0.5); padBus.connect(lp).connect(master);
  const nz = noise(ctx, 0.5);
  const hit = (t, type, f, d, v, q = 1) => { const s = src(ctx, nz), fl = filt(ctx, type, f, q), e = g(ctx, 0); env(e.gain, t, 0.002, d, v); s.connect(fl).connect(e).connect(master); s.start(t); s.stop(t + d + 0.05); };
  const kick = (t, v = 0.9) => { const o = osc(ctx, 'sine', 140), e = g(ctx, 0); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); env(e.gain, t, 0.003, 0.28, v); o.connect(e).connect(master); o.start(t); o.stop(t + 0.35); };
  for (let b = 0; b < nBars; b++){
    const t0 = b * bar; if (t0 >= len) break;
    const ch = M.prog[b % M.prog.length].map(x => M.root + x);
    ch.forEach(n => [-6, 6].forEach(dt => { const o = osc(ctx, 'sawtooth', mtof(n)); o.detune.value = dt; const e = g(ctx, 0); e.gain.setValueAtTime(0.0001, t0); e.gain.linearRampToValueAtTime(0.25, t0 + 0.4); e.gain.setValueAtTime(0.25, t0 + bar - 0.3); e.gain.linearRampToValueAtTime(0.0001, t0 + bar + 0.1); o.connect(e).connect(padBus); o.start(t0); o.stop(t0 + bar + 0.15); }));
    const bassN = mtof(ch[0] - 12);
    const bassHits = M.bass8 ? [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 2, 2.5];
    if (M.drums) bassHits.forEach(x => { const o = osc(ctx, 'sine', bassN), e = g(ctx, 0); env(e.gain, t0 + x * beat, 0.01, beat * (M.bass8 ? 0.45 : 0.9), 0.35); o.connect(e).connect(master); o.start(t0 + x * beat); o.stop(t0 + x * beat + beat); });
    if (M.pluck) for (let s = 0; s < 8; s++){ const n = ch[[0, 1, 2, 1, 3 % ch.length, 2, 1, 2][s] % ch.length] + 12; const t = t0 + s * beat / 2; const o = osc(ctx, 'triangle', mtof(n)), e = g(ctx, 0); env(e.gain, t, 0.005, beat * 0.9, 0.12); o.connect(e).connect(master); o.start(t); o.stop(t + beat); }
    for (let q = 0; q < 4; q++){
      const t = t0 + q * beat, sw = M.drums === 'lofi' ? beat * 0.08 : 0;
      if (M.drums === 'pop' || M.drums === 'drive'){ kick(t); if (q % 2) hit(t, 'bandpass', 1800, 0.16, 0.45, 0.8); hit(t + beat / 2, 'highpass', 7000, 0.05, 0.25); if (M.drums === 'drive') hit(t + beat / 4, 'highpass', 8000, 0.03, 0.15); }
      else if (M.drums === 'lofi'){ if (q === 0 || q === 2) kick(t, 0.7); if (q % 2) hit(t, 'bandpass', 1500, 0.14, 0.25, 0.7); hit(t, 'highpass', 6500, 0.04, 0.12); hit(t + beat / 2 + sw, 'highpass', 6500, 0.04, 0.08); }
      else if (M.drums === 'soft'){ if (q === 0) kick(t, 0.5); hit(t + beat / 2, 'highpass', 5000, 0.06, 0.1); }
      else if (M.drums === 'pulse'){ if (q === 0 || q === 2) kick(t, 0.45); }
    }
  }
  const buf = await ctx.startRendering();
  return window.GM.encodeWav([buf.getChannelData(0)], sr);
}

window.GMAudio = { makeSfx, makeMusic, MOODS, SFX_LIST: Object.entries(R).map(([id, r]) => ({ id, th: r.th[0], en: r.en[0] })) };
