/* Gen Medi — Video Studio
   Scenes (image + narration + subtitle) → preview → MP4 (WebCodecs + mp4-muxer, fallback MediaRecorder)
   Export presets for TikTok / Reels / Shorts / YouTube / Facebook / Instagram / LINE VOOM / X / Podcast. */
const GM = window.GM;
const { S, db, toast, openSheet, closeAll, sheetHead, esc, sleep, stamp } = GM;
const $ = s => document.querySelector(s);
const root = $('#studioRoot');

const FORMATS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
const RATIO_FOR_IMG = { '9:16': '9:16', '16:9': '16:9', '1:1': '1:1', '4:5': '4:5' };
const MOTIONS = [['zoomin', 'ซูมเข้า'], ['zoomout', 'ซูมออก'], ['panl', 'เลื่อนซ้าย'], ['panr', 'เลื่อนขวา'], ['none', 'นิ่ง']];
const TRANS = 0.4, FPS = 30;
const PLATFORMS = [
  { id: 'tiktok', n: 'TikTok', i: '🎵', f: '9:16', tags: '#fyp #tiktokthailand #GenMedi' },
  { id: 'reels', n: 'Instagram Reels', i: '📸', f: '9:16', tags: '#reels #reelsthailand' },
  { id: 'shorts', n: 'YouTube Shorts', i: '▶️', f: '9:16', tags: '#Shorts' },
  { id: 'fbreels', n: 'Facebook Reels', i: '📘', f: '9:16', tags: '#reels' },
  { id: 'line', n: 'LINE VOOM', i: '💬', f: '9:16', tags: '' },
  { id: 'youtube', n: 'YouTube (แนวนอน)', i: '📺', f: '16:9', thumb: [1280, 720], tags: '' },
  { id: 'feed', n: 'Facebook / Instagram Feed', i: '🖼️', f: '4:5', tags: '' },
  { id: 'igpost', n: 'Instagram Post (สี่เหลี่ยม)', i: '⬛', f: '1:1', tags: '' },
  { id: 'x', n: 'X (Twitter)', i: '✖️', f: '16:9', size: [1280, 720], tags: '' },
  { id: 'podcast', n: 'Podcast / Spotify (MP3)', i: '🎧', audio: 'mp3' },
  { id: 'wav', n: 'ไฟล์เสียง WAV (ไปตัดต่อต่อ)', i: '🎚️', audio: 'wav' },
];

let P = null;               // current project
let dirtyMix = true, mixCache = null;
const bmpCache = new WeakMap(), audCache = new WeakMap();
let player = { playing: false, t: 0, ctx: null, src: null, t0: 0, raf: 0 };

/* ---------------- project model ---------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
function newProj(name){ return { id: 'p' + Date.now(), name: name || 'โปรเจกต์ใหม่', format: '9:16', scenes: [], music: null, musicVol: 0.15, narrVol: 1,
  subs: { on: true, pos: 'bottom', size: 1, style: 'box' }, title: '', watermark: '', created: Date.now(), updated: Date.now() }; }
function newScene(text){ return { id: uid(), text: text || '', img: null, imgLk: null, audio: null, audLk: null, sfx: [], dur: 0, motion: MOTIONS[Math.floor(Math.random() * 4)][0], voice: '' }; }
let saveT = 0;
function touch(mix = true){ if (!P) return; P.updated = Date.now(); if (mix) dirtyMix = true; clearTimeout(saveT); saveT = setTimeout(saveProj, 600); }
async function saveProj(){ if (!P) return; P.thumb = P.scenes.find(s => s.img)?.img || null; try { await db.put('projects', P); LS_last(P.id); } catch(e){ toast('บันทึกโปรเจกต์ไม่สำเร็จ: ' + e.message, true); } }
const LS_last = id => GM.LS.set('lastProject', id);

/* ---------------- media helpers ---------------- */
async function bitmap(blob){ if (!blob) return null; if (bmpCache.has(blob)) return bmpCache.get(blob); const b = await createImageBitmap(blob); bmpCache.set(blob, b); return b; }
async function audioBuf(blob){ if (!blob) return null; if (audCache.has(blob)) return audCache.get(blob); const b = await GM.decode(blob); audCache.set(blob, b); return b; }
function sceneDur(s){ const a = s.audio && audCache.get(s.audio); return a ? a.duration + 0.35 : (s.dur || Math.max(2.5, Math.min(12, s.text.length / 12))); }
async function prepare(){ for (const s of P.scenes){ await bitmap(s.img); if (s.audio) await audioBuf(s.audio); for (const x of s.sfx || []) await audioBuf(x.blob); } }
function timeline(){ let t = 0; const out = P.scenes.map(s => { const d = sceneDur(s), o = { s, start: t, dur: d }; t += d; return o; }); return { items: out, total: t }; }

/* ---------------- text layout (Thai-aware) ---------------- */
const seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
function words(t){ return seg ? [...seg.segment(t)].map(x => x.segment) : t.split(/(\s+)/); }
function wrap(ctx, text, maxW){
  const lines = []; let cur = '';
  for (const w of words(text.replace(/\s+/g, ' ').trim())){
    if (ctx.measureText(cur + w).width > maxW && cur.trim()){ lines.push(cur.trim()); cur = w.trimStart(); }
    else cur += w;
    while (ctx.measureText(cur).width > maxW && cur.length > 1){ let k = cur.length - 1; while (k > 1 && ctx.measureText(cur.slice(0, k)).width > maxW) k--; lines.push(cur.slice(0, k)); cur = cur.slice(k); }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
const capCache = new Map();
function subFont(W, H){ return Math.round(Math.min(W, H) * 0.058 * (P.subs.size || 1)); }
function captions(ctx, s, W, H, speechDur){
  const fs = subFont(W, H), key = s.id + '|' + W + 'x' + H + '|' + fs + '|' + s.text + '|' + speechDur.toFixed(2);
  if (capCache.has(key)) return capCache.get(key);
  ctx.font = `700 ${fs}px "Noto Sans Thai", "Prompt", sans-serif`;
  const lines = wrap(ctx, s.text, W * 0.84), caps = [];
  for (let i = 0; i < lines.length; i += 2) caps.push(lines.slice(i, i + 2));
  const total = caps.reduce((a, c) => a + c.join('').length, 0) || 1; let t = 0.1;
  const out = caps.map(c => { const d = speechDur * c.join('').length / total; const o = { lines: c, t0: t, t1: t + d }; t += d; return o; });
  capCache.set(key, out); return out;
}

/* ---------------- drawing ---------------- */
function drawImg(ctx, bmp, W, H, motion, p, idx){
  if (!bmp){
    const g = ctx.createLinearGradient(0, 0, W, H), hues = [[250, 320], [190, 260], [20, 330], [160, 220]][idx % 4];
    g.addColorStop(0, `hsl(${hues[0]},70%,22%)`); g.addColorStop(1, `hsl(${hues[1]},70%,30%)`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); return;
  }
  const s0 = Math.max(W / bmp.width, H / bmp.height); let z = 1, dx = 0;
  if (motion === 'zoomin') z = 1 + 0.12 * p; else if (motion === 'zoomout') z = 1.12 - 0.12 * p;
  else if (motion === 'panl'){ z = 1.14; dx = (0.5 - p) * 0.1; } else if (motion === 'panr'){ z = 1.14; dx = (p - 0.5) * 0.1; }
  const w = bmp.width * s0 * z, h = bmp.height * s0 * z;
  ctx.drawImage(bmp, (W - w) / 2 + dx * W, (H - h) / 2, w, h);
}
function rrect(ctx, x, y, w, h, r){ ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawSubs(ctx, W, H, lines){
  const fs = subFont(W, H), lh = fs * 1.35, st = P.subs.style;
  ctx.font = `700 ${fs}px "Noto Sans Thai", "Prompt", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const yC = P.subs.pos === 'center' ? H * 0.5 : P.subs.pos === 'top' ? H * 0.2 : H * (H > W ? 0.74 : 0.82);
  const y0 = yC - (lines.length - 1) * lh / 2;
  if (st === 'box'){
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + fs * 1.1;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; rrect(ctx, (W - w) / 2, y0 - lh / 2 - fs * 0.2, w, lh * lines.length + fs * 0.4, fs * 0.35); ctx.fill();
  }
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    if (st !== 'box'){ ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.18; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(l, W / 2, y); }
    ctx.fillStyle = st === 'yellow' ? '#ffe14d' : '#ffffff'; ctx.fillText(l, W / 2, y);
  });
}
function drawTitle(ctx, W, H, t, force){
  if (!P.title) return;
  const a = force ? 1 : t < 0.4 ? t / 0.4 : t > 2.6 ? Math.max(0, (3.2 - t) / 0.6) : 1; if (a <= 0) return;
  const fs = Math.round(Math.min(W, H) * (force ? 0.1 : 0.085));
  ctx.save(); ctx.globalAlpha = a; ctx.font = `800 ${fs}px "Prompt", "Noto Sans Thai", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrap(ctx, P.title, W * 0.86).slice(0, 3), lh = fs * 1.2, y0 = H * (force ? 0.42 : 0.2) - (lines.length - 1) * lh / 2;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + fs;
  const g = ctx.createLinearGradient((W - w) / 2, 0, (W + w) / 2, 0); g.addColorStop(0, 'rgba(34,211,238,.92)'); g.addColorStop(.5, 'rgba(124,92,255,.92)'); g.addColorStop(1, 'rgba(236,72,153,.92)');
  ctx.fillStyle = g; rrect(ctx, (W - w) / 2, y0 - lh / 2 - fs * 0.15, w, lh * lines.length + fs * 0.3, fs * 0.3); ctx.fill();
  ctx.fillStyle = '#fff'; lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh)); ctx.restore();
}
function drawWatermark(ctx, W, H){
  if (!P.watermark) return;
  const fs = Math.round(Math.min(W, H) * 0.032); ctx.save(); ctx.globalAlpha = .75; ctx.font = `700 ${fs}px "Prompt", "Noto Sans Thai", sans-serif`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.lineWidth = fs * 0.15; ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.strokeText(P.watermark, W - fs, fs * 1.2); ctx.fillStyle = '#fff'; ctx.fillText(P.watermark, W - fs, fs * 1.2); ctx.restore();
}
function sceneAt(tl, t){ let i = tl.items.findIndex(x => t < x.start + x.dur); if (i < 0) i = tl.items.length - 1; return i; }
function drawFrame(ctx, W, H, t, tl, opts = {}){
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!tl.items.length){ ctx.fillStyle = '#9aa3c7'; ctx.font = `600 ${Math.round(W * 0.04)}px "Noto Sans Thai", sans-serif`; ctx.textAlign = 'center'; ctx.fillText('ยังไม่มีฉาก — กด “บท → วิดีโอ” หรือ “＋ ฉาก”', W / 2, H / 2); return; }
  const i = sceneAt(tl, t), it = tl.items[i], lt = t - it.start, p = Math.min(1, lt / it.dur);
  if (i > 0 && lt < TRANS){ const pv = tl.items[i - 1]; drawImg(ctx, bmpCache.get(pv.s.img), W, H, pv.s.motion, 1, i - 1); ctx.globalAlpha = lt / TRANS; }
  drawImg(ctx, bmpCache.get(it.s.img), W, H, it.s.motion, p, i); ctx.globalAlpha = 1;
  const grad = ctx.createLinearGradient(0, H * 0.55, 0, H); grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.35)'); ctx.fillStyle = grad; ctx.fillRect(0, H * 0.55, W, H * 0.45);
  if (P.subs.on && it.s.text && !opts.noSubs){
    const a = it.s.audio && audCache.get(it.s.audio), speech = a ? a.duration : it.dur - 0.2;
    const c = captions(ctx, it.s, W, H, speech).find(c => lt >= c.t0 && lt < c.t1) || (lt < 0.1 ? captions(ctx, it.s, W, H, speech)[0] : null);
    if (c) drawSubs(ctx, W, H, c.lines);
  }
  drawTitle(ctx, W, H, t, opts.forceTitle); drawWatermark(ctx, W, H);
}

/* ---------------- audio mix ---------------- */
async function mixAudio(sr = 48000){
  await prepare(); const tl = timeline(); const len = Math.max(1, Math.ceil((tl.total + 0.2) * sr));
  const oc = new OfflineAudioContext(2, len, sr);
  const ng = oc.createGain(); ng.gain.value = P.narrVol; ng.connect(oc.destination);
  tl.items.forEach(x => {
    const b = x.s.audio && audCache.get(x.s.audio); if (b){ const s = oc.createBufferSource(); s.buffer = b; s.connect(ng); s.start(x.start + 0.1); }
    (x.s.sfx || []).forEach(f => { const fb = audCache.get(f.blob); if (!fb) return; const s = oc.createBufferSource(), gg = oc.createGain(); s.buffer = fb; gg.gain.value = f.vol ?? 0.8; s.connect(gg).connect(oc.destination); s.start(Math.max(0, x.start + (f.at === 'end' ? Math.max(0, x.dur - fb.duration) : 0))); });
  });
  if (P.music){
    const mb = await audioBuf(P.music); const s = oc.createBufferSource(); s.buffer = mb; s.loop = true;
    const g = oc.createGain(); g.gain.setValueAtTime(P.musicVol, 0); g.gain.setValueAtTime(P.musicVol, Math.max(0, tl.total - 1.5)); g.gain.linearRampToValueAtTime(0, tl.total + 0.2);
    s.connect(g).connect(oc.destination); s.start(0);
  }
  return oc.startRendering();
}
async function getMix(){ if (!dirtyMix && mixCache) return mixCache; mixCache = await mixAudio(48000); dirtyMix = false; return mixCache; }

/* ---------------- UI ---------------- */
function licOk(lk){ return lk === 'user' || lk === 'gen' || !lk || GM.allowed(lk); }
function licBadge(lk){ if (!lk) return ''; if (lk === 'user') return '<span class="mini ok">ไฟล์ของคุณ</span>'; if (lk === 'gen') return '<span class="mini ok" title="สังเคราะห์ในแอป ไม่มีลิขสิทธิ์ภายนอก">💼</span>'; const l = GM.lic(lk); return `<span class="mini ${l.ok ? 'ok' : 'bad'}" title="${esc(l.t)}">${l.ok ? '💼' : l.ok === false ? '🚫' : '❔'}</span>`; }
const fmtT = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function render(){
  if (!P){ root.innerHTML = '<p class="hint">กำลังโหลด…</p>'; return; }
  const [W, H] = FORMATS[P.format], pw = H > W ? Math.min(300, innerWidth * 0.7) : Math.min(560, innerWidth - 32);
  root.innerHTML = `
  <div class="card">
    <div class="row2"><input class="inp" id="stName" value="${esc(P.name)}" placeholder="ชื่อโปรเจกต์"><button class="btn alt" id="stProjects" title="โปรเจกต์">🗂️</button></div>
    <div class="chips" id="stFmt" style="margin-top:10px">${Object.keys(FORMATS).map(f => `<button class="chip ${P.format === f ? 'on' : ''}" data-f="${f}">${f}${f === '9:16' ? ' · TikTok/Reels' : f === '16:9' ? ' · YouTube' : f === '4:5' ? ' · Feed' : ' · IG'}</button>`).join('')}</div>
  </div>
  <div class="st-prev" style="width:${pw}px;aspect-ratio:${W}/${H}"><canvas id="stCanvas" width="${H > W ? 540 : 960}" height="${Math.round((H > W ? 540 : 960) * H / W)}"></canvas></div>
  <div class="st-bar"><button class="btn sm" id="stPlay">▶</button><input type="range" id="stSeek" min="0" max="1000" value="0"><span class="st-time" id="stTime">0:00 / 0:00</span></div>
  <div class="row2" style="margin-bottom:12px"><button class="btn" style="flex:1" id="stAuto">⚡ บท → วิดีโอ</button><button class="btn alt" style="flex:1" id="stAdd">＋ ฉาก</button></div>
  <div id="stScenes"></div>
  <div class="card" style="margin-top:14px">
    <div class="card-h"><h2>🎛️ ซับ · ชื่อเรื่อง · เพลง</h2></div>
    <label class="switch" style="margin-top:0"><span>ซับไตเติลอัตโนมัติ (จากข้อความแต่ละฉาก)</span><input type="checkbox" id="stSubs" ${P.subs.on ? 'checked' : ''}></label>
    <div class="row2" style="margin-top:10px;flex-wrap:wrap">
      <select class="mini" id="stSubStyle">${[['box', 'กล่องดำ'], ['outline', 'ขอบดำ'], ['yellow', 'เหลือง']].map(o => `<option value="${o[0]}" ${P.subs.style === o[0] ? 'selected' : ''}>สไตล์: ${o[1]}</option>`).join('')}</select>
      <select class="mini" id="stSubPos">${[['bottom', 'ล่าง'], ['center', 'กลาง'], ['top', 'บน']].map(o => `<option value="${o[0]}" ${P.subs.pos === o[0] ? 'selected' : ''}>ตำแหน่ง: ${o[1]}</option>`).join('')}</select>
      <select class="mini" id="stSubSize">${[[0.8, 'เล็ก'], [1, 'กลาง'], [1.25, 'ใหญ่']].map(o => `<option value="${o[0]}" ${P.subs.size == o[0] ? 'selected' : ''}>ขนาด: ${o[1]}</option>`).join('')}</select>
    </div>
    <label class="lbl2">ชื่อเรื่อง (ขึ้น 3 วินาทีแรก + ใช้ทำภาพปก)</label><input class="inp" id="stTitle" value="${esc(P.title)}" placeholder="เช่น 5 เรื่องลับของเชียงใหม่">
    <label class="lbl2">ลายน้ำ / ชื่อช่อง</label><input class="inp" id="stWm" value="${esc(P.watermark)}" placeholder="@ชื่อช่องของคุณ">
    <label class="lbl2">เพลงพื้นหลัง <small style="color:var(--mut)">(ใช้เพลงที่คุณมีสิทธิ์ใช้ เช่น YouTube Audio Library)</small></label>
    <div class="row2"><button class="btn sm" style="flex:1" id="stGenMusic">🎼 สร้างเพลงประกอบ (ฟรี 💼)</button><label class="btn alt sm" style="flex:1">🎵 ไฟล์เพลงของคุณ<input type="file" id="stMusic" accept="audio/*" hidden></label></div>
    ${P.music ? `<div class="row2" style="margin-top:8px"><span class="mini ok" style="flex:1">${P.musicLk === 'gen' ? '🎼 เพลงที่แอปสร้าง (' + esc(P.musicName || '') + ') · ไม่มีลิขสิทธิ์ภายนอก' : P.musicLk === 'cover' ? '🎸 ดนตรีคัฟเวอร์ (' + esc(P.musicName || '') + ') · ทำนองเป็นของผู้แต่ง' : '🎵 ไฟล์เพลงของคุณ'}</span><button class="btn danger sm" id="stMusicDel">ลบเพลง</button></div>` : ''}
    <div class="sl" style="padding:10px 0 0"><div class="sl-h" style="margin-bottom:6px">เสียงเพลง <span class="v" id="stMvV">${Math.round(P.musicVol * 100)}%</span></div><input type="range" id="stMv" min="0" max="0.6" step="0.01" value="${P.musicVol}"></div>
    <div class="sl" style="padding:6px 0 0"><div class="sl-h" style="margin-bottom:6px">เสียงพากย์ <span class="v" id="stNvV">${Math.round(P.narrVol * 100)}%</span></div><input type="range" id="stNv" min="0" max="2" step="0.05" value="${P.narrVol}"></div>
  </div>
  <button class="cta" id="stExport"><span class="bars"><i></i><i></i><i></i><i></i></span>🚀 ส่งออก / ลงแพลตฟอร์ม</button>
  <p class="hint" id="stInfo"></p>`;
  root.querySelectorAll('input[type=range]').forEach(r => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%'));
  bind(); renderScenes(); drawPreview();
}
function renderScenes(){
  const box = $('#stScenes'); if (!box) return;
  const tl = timeline();
  box.innerHTML = P.scenes.map((s, i) => `
  <div class="scene" data-i="${i}">
    ${s.img ? `<img class="th" data-act="img" src="${URL.createObjectURL(s.img)}" alt="">` : `<div class="th" data-act="img">＋ ภาพ</div>`}
    <div class="bd">
      <textarea data-act="text" placeholder="ข้อความ/บทพากย์ของฉาก ${i + 1}">${esc(s.text)}</textarea>
      <div class="meta">
        <span class="mini">#${i + 1} · ${sceneDur(s).toFixed(1)} วิ</span>
        <button class="mini ${s.audio ? 'ok' : ''}" data-act="voice">🔊 ${s.audio ? 'เสียงใหม่' : 'สร้างเสียง'}</button>${licBadge(s.audLk)}
        <button class="mini" data-act="rec">🎤</button>
        <button class="mini ${(s.sfx || []).length ? 'ok' : ''}" data-act="sfx">✨ SFX${(s.sfx || []).length ? ' ' + s.sfx.length : ''}</button>
        <select class="mini" data-act="motion">${MOTIONS.map(m => `<option value="${m[0]}" ${s.motion === m[0] ? 'selected' : ''}>${m[1]}</option>`).join('')}</select>${licBadge(s.imgLk)}
        <button class="mini" data-act="up" ${i ? '' : 'disabled'}>↑</button><button class="mini" data-act="down" ${i < P.scenes.length - 1 ? '' : 'disabled'}>↓</button><button class="mini bad" data-act="del">🗑</button>
      </div>
    </div>
  </div>`).join('') || '<p class="hint">ยังไม่มีฉาก</p>';
  box.querySelectorAll('.scene').forEach(el => {
    const i = +el.dataset.i, s = P.scenes[i];
    el.querySelector('.th').onclick = () => pickImage(i);
    el.querySelector('textarea').oninput = e => { s.text = e.target.value; touch(false); drawPreview(); };
    el.querySelector('textarea').onfocus = () => seek(tl.items[i]?.start || 0);
    el.querySelector('[data-act=voice]').onclick = () => makeVoice(i);
    el.querySelector('[data-act=rec]').onclick = () => recordVoice(i);
    el.querySelector('[data-act=sfx]').onclick = () => openSfx(i);
    el.querySelector('[data-act=motion]').onchange = e => { s.motion = e.target.value; touch(false); drawPreview(); };
    el.querySelector('[data-act=up]').onclick = () => { P.scenes.splice(i - 1, 0, P.scenes.splice(i, 1)[0]); touch(); renderScenes(); drawPreview(); };
    el.querySelector('[data-act=down]').onclick = () => { P.scenes.splice(i + 1, 0, P.scenes.splice(i, 1)[0]); touch(); renderScenes(); drawPreview(); };
    el.querySelector('[data-act=del]').onclick = () => { P.scenes.splice(i, 1); touch(); renderScenes(); drawPreview(); };
  });
  const lic = P.scenes.every(s => licOk(s.imgLk) && licOk(s.audLk)) && licOk(P.musicLk);
  const info = $('#stInfo'); if (info) info.innerHTML = `${P.scenes.length} ฉาก · ยาว ${fmtT(tl.total)} · ${S.commercial ? (lic ? '💼 ทุกฉากใช้เชิงพาณิชย์ได้' : '⚠️ มีฉากที่ใช้เชิงพาณิชย์ไม่ได้ (ดูป้าย 🚫/❔)') : 'โหมดใช้ส่วนตัว'}`;
}
function bind(){
  $('#stName').oninput = e => { P.name = e.target.value; touch(false); };
  $('#stProjects').onclick = openProjects;
  root.querySelectorAll('#stFmt .chip').forEach(b => b.onclick = () => { P.format = b.dataset.f; capCache.clear(); touch(false); render(); });
  $('#stPlay').onclick = () => player.playing ? pause() : play();
  $('#stSeek').oninput = e => { const tl = timeline(); seek(e.target.value / 1000 * tl.total); };
  $('#stAuto').onclick = openAuto;
  $('#stAdd').onclick = () => { P.scenes.push(newScene('')); touch(); renderScenes(); };
  $('#stSubs').onchange = e => { P.subs.on = e.target.checked; touch(false); drawPreview(); };
  $('#stSubStyle').onchange = e => { P.subs.style = e.target.value; touch(false); drawPreview(); };
  $('#stSubPos').onchange = e => { P.subs.pos = e.target.value; touch(false); drawPreview(); };
  $('#stSubSize').onchange = e => { P.subs.size = +e.target.value; capCache.clear(); touch(false); drawPreview(); };
  $('#stTitle').oninput = e => { P.title = e.target.value; touch(false); drawPreview(); };
  $('#stWm').oninput = e => { P.watermark = e.target.value; touch(false); drawPreview(); };
  $('#stGenMusic').onclick = openMusic;
  $('#stMusic').onchange = async e => { const f = e.target.files[0]; if (!f) return; P.music = f; P.musicLk = 'user'; touch(); toast('ใส่เพลงแล้ว — ตรวจให้แน่ใจว่ามีสิทธิ์ใช้เพลงนี้'); render(); };
  $('#stMusicDel')?.addEventListener('click', () => { P.music = null; touch(); render(); });
  $('#stMv').oninput = e => { P.musicVol = +e.target.value; $('#stMvV').textContent = Math.round(P.musicVol * 100) + '%'; e.target.style.setProperty('--p', (P.musicVol / 0.6 * 100) + '%'); touch(); };
  $('#stNv').oninput = e => { P.narrVol = +e.target.value; $('#stNvV').textContent = Math.round(P.narrVol * 100) + '%'; e.target.style.setProperty('--p', (P.narrVol / 2 * 100) + '%'); touch(); };
  $('#stExport').onclick = openExport;
}

/* ---------------- preview player ---------------- */
async function drawPreview(){
  const c = $('#stCanvas'); if (!c || !P) return;
  await prepare(); const tl = timeline();
  drawFrame(c.getContext('2d'), c.width, c.height, Math.min(player.t, Math.max(0, tl.total - 0.01)), tl);
  $('#stTime').textContent = `${fmtT(player.t)} / ${fmtT(tl.total)}`;
  $('#stSeek').value = tl.total ? player.t / tl.total * 1000 : 0;
}
function seek(t){ const was = player.playing; if (was) pause(); player.t = Math.max(0, t); drawPreview(); if (was) play(); }
async function play(){
  if (!P.scenes.length) return toast('ยังไม่มีฉาก');
  const btn = $('#stPlay'); btn.textContent = '…';
  await document.fonts.load('700 40px "Noto Sans Thai"').catch(() => {});
  const mix = await getMix(), tl = timeline();
  if (player.t >= tl.total - 0.05) player.t = 0;
  player.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  await player.ctx.resume();
  player.src = player.ctx.createBufferSource(); player.src.buffer = mix; player.src.connect(player.ctx.destination);
  player.t0 = player.ctx.currentTime - player.t; player.src.start(0, player.t); player.playing = true; btn.textContent = '❚❚';
  const c = $('#stCanvas'), ctx = c.getContext('2d');
  const loop = () => {
    if (!player.playing) return;
    player.t = player.ctx.currentTime - player.t0;
    if (player.t >= tl.total){ pause(); player.t = tl.total; drawPreview(); return; }
    drawFrame(ctx, c.width, c.height, player.t, tl);
    $('#stTime').textContent = `${fmtT(player.t)} / ${fmtT(tl.total)}`; $('#stSeek').value = player.t / tl.total * 1000;
    player.raf = requestAnimationFrame(loop);
  };
  loop();
}
function pause(){ player.playing = false; cancelAnimationFrame(player.raf); try { player.src?.stop(); } catch(e){} const b = $('#stPlay'); if (b) b.textContent = '▶'; }

/* ---------------- scene media ---------------- */
async function makeVoice(i, quiet){
  const s = P.scenes[i]; if (!s.text.trim()) { if (!quiet) toast('พิมพ์ข้อความของฉากก่อน'); return false; }
  const v = GM.curVoice();
  if (v.type === 'device') throw new Error('เสียงระบบในเครื่องสร้างไฟล์ไม่ได้ — เลือกเสียงบน Mac, เสียง AI ฟรี หรือเสียงโคลน');
  const parts = GM.makeChunks(s.text, v.type === 'local' ? 140 : 380), blobs = [];
  for (const t of parts) blobs.push(await GM.synthesize(v, t));
  s.audio = blobs.length === 1 ? blobs[0] : await GM.mergeAudio(blobs); s.audLk = GM.voiceLicKey(v); s.voice = v.name;
  await audioBuf(s.audio); touch(); renderScenes(); drawPreview(); return true;
}
async function recordVoice(i){
  if (!navigator.mediaDevices?.getUserMedia) return toast('อุปกรณ์นี้อัดเสียงไม่ได้', true);
  let mr, stream, parts = [];
  openSheet(sheetHead('🎤 อัดเสียงพากย์ฉาก ' + (i + 1)) + `<p class="lim">${esc(P.scenes[i].text || '(ไม่มีข้อความ)')}</p><button class="btn" id="rcGo" style="width:100%">● เริ่มอัด</button><p class="hint">เสียงของคุณเอง = ใช้เชิงพาณิชย์ได้ 💼</p>`, el => {
    el.querySelector('#rcGo').onclick = async () => {
      const b = el.querySelector('#rcGo');
      if (mr?.state === 'recording'){ mr.stop(); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch(e){ return toast('เปิดไมค์ไม่ได้', true); }
      mr = new MediaRecorder(stream); mr.ondataavailable = e => e.data.size && parts.push(e.data);
      mr.onstop = async () => { stream.getTracks().forEach(t => t.stop()); const s = P.scenes[i]; s.audio = new Blob(parts, { type: mr.mimeType }); s.audLk = 'user'; s.voice = 'เสียงของคุณ'; await audioBuf(s.audio); touch(); closeAll(); renderScenes(); drawPreview(); toast('ใส่เสียงของคุณแล้ว'); };
      mr.start(); b.textContent = '■ หยุดอัด'; b.classList.add('danger');
    };
  });
}
async function pickImage(i){
  const s = P.scenes[i];
  const hist = (await db.all('history')).filter(h => h.kind === 'image' && h.blob).sort((a, b) => b.created - a.created).slice(0, 12);
  openSheet(sheetHead('🖼️ ภาพของฉาก ' + (i + 1)) + `
    <label class="lbl2" style="margin-top:0">สร้างด้วย AI (${esc(GM.lic('img-' + S.imgEngine).t)})</label>
    <textarea class="inp" id="piPrompt" style="height:80px;padding:10px">${esc(s.prompt || s.text)}</textarea>
    <p class="hint">คำอธิบายภาษาอังกฤษได้ภาพตรงกว่า · ห้ามใส่ชื่อตัวการ์ตูน/แบรนด์/คนดัง</p>
    <button class="btn" id="piGen" style="width:100%;margin-top:6px">✨ สร้างภาพ</button>
    <label class="btn alt" style="width:100%;margin-top:8px">📁 ใช้ภาพจากเครื่อง / กล้อง<input type="file" id="piFile" accept="image/*" hidden></label>
    ${hist.length ? `<h4>จากคลังงาน</h4><div class="grid">${hist.map((h, k) => `<img data-k="${k}" src="${URL.createObjectURL(h.blob)}" style="width:100%;border-radius:12px;cursor:pointer">`).join('')}</div>` : ''}
    ${s.img ? '<button class="btn danger sm" id="piDel" style="margin-top:12px">ลบภาพ</button>' : ''}`, el => {
    const setImg = async (blob, lk) => { s.img = blob; s.imgLk = lk; await bitmap(blob); touch(false); closeAll(); renderScenes(); drawPreview(); };
    el.querySelector('#piGen').onclick = async () => {
      const b = el.querySelector('#piGen'); b.disabled = true; b.textContent = 'กำลังสร้างภาพ… (อาจรอคิว)';
      s.prompt = el.querySelector('#piPrompt').value.trim();
      try { const r = await GM.genImage(s.prompt, RATIO_FOR_IMG[P.format]); await setImg(r.blob, r.lk); } catch(e){ toast(e.message, true); b.disabled = false; b.textContent = '✨ สร้างภาพ'; }
    };
    el.querySelector('#piFile').onchange = e => { const f = e.target.files[0]; if (f) setImg(f, 'user'); };
    el.querySelectorAll('[data-k]').forEach(im => im.onclick = () => { const h = hist[+im.dataset.k]; setImg(h.blob, h.lk || 'img-flux'); });
    el.querySelector('#piDel')?.addEventListener('click', () => { s.img = null; s.imgLk = null; touch(false); closeAll(); renderScenes(); drawPreview(); });
  });
}

/* ---------------- sound effects + music (synthesised in-app, no outside copyright) ---------------- */
function sfxChips(){ return window.GMAudio.SFX_LIST.map(x => `<button class="chip" data-w="${esc(x.th)}">${esc(x.th)}</button>`).join(''); }
function openSfx(i){
  const s = P.scenes[i]; s.sfx ||= [];
  openSheet(sheetHead('✨ เสียงประกอบ ฉาก ' + (i + 1)) + `
    <p class="hint" style="margin-top:0">พิมพ์ว่าอยากได้เสียงอะไร เช่น “ฝนตก ฟ้าร้อง ยาว”, “ติ๊ง”, “วูบ เปลี่ยนฉาก”, “ปรบมือ ดัง” — สร้างด้วยการสังเคราะห์ในแอป ไม่มีลิขสิทธิ์ภายนอก 💼</p>
    <div class="row2"><input class="inp" id="sxT" placeholder="เช่น ระเบิด ดัง"><button class="btn" id="sxGo">สร้าง</button></div>
    <div class="chips" style="margin-top:10px" id="sxC">${sfxChips()}</div>
    <label class="lbl2">ตำแหน่งในฉาก</label><div class="chips" id="sxAt"><button class="chip on" data-a="start">ต้นฉาก</button><button class="chip" data-a="end">ท้ายฉาก</button></div>
    <audio id="sxA" controls hidden></audio><button class="btn alt" id="sxAdd" style="width:100%;margin-top:8px" disabled>＋ ใส่ในฉากนี้</button>
    <h4>ในฉากนี้</h4><div id="sxL"></div>`, el => {
    let cur = null, at = 'start';
    const list = () => { el.querySelector('#sxL').innerHTML = s.sfx.length ? s.sfx.map((x, k) => `<div class="item"><div class="t"><b>${esc(x.label)}</b><small>${x.at === 'end' ? 'ท้ายฉาก' : 'ต้นฉาก'}</small></div><button class="ib" data-p="${k}">▶</button><button class="ib" data-d="${k}">🗑</button></div>`).join('') : '<p class="hint">ยังไม่มี</p>';
      el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => new Audio(URL.createObjectURL(s.sfx[+b.dataset.p].blob)).play());
      el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { s.sfx.splice(+b.dataset.d, 1); touch(); list(); renderScenes(); }); };
    const gen = async () => { const t = el.querySelector('#sxT').value.trim(); if (!t) return; try { cur = await window.GMAudio.makeSfx(t); const a = el.querySelector('#sxA'); a.src = URL.createObjectURL(cur.blob); a.hidden = false; a.play().catch(() => {}); el.querySelector('#sxAdd').disabled = false; } catch(e){ toast(e.message, true); } };
    el.querySelector('#sxGo').onclick = gen;
    el.querySelectorAll('#sxC .chip').forEach(b => b.onclick = () => { el.querySelector('#sxT').value = b.dataset.w; gen(); });
    el.querySelectorAll('#sxAt .chip').forEach(b => b.onclick = () => { at = b.dataset.a; el.querySelectorAll('#sxAt .chip').forEach(x => x.classList.toggle('on', x === b)); });
    el.querySelector('#sxAdd').onclick = async () => { if (!cur) return; s.sfx.push({ blob: cur.blob, label: cur.label, at, vol: 0.8 }); await audioBuf(cur.blob); touch(); list(); renderScenes(); toast('ใส่เสียงประกอบแล้ว'); };
    list();
  });
}
function openMusic(){
  const tl = timeline();
  openSheet(sheetHead('🎼 สร้างเพลงประกอบ (ฟรี ไม่มีลิขสิทธิ์ภายนอก)') + `
    <p class="hint" style="margin-top:0">แอปแต่งและสังเคราะห์เพลงบรรเลงให้ใหม่ทุกครั้ง ยาวเท่าวิดีโอ (${fmtT(Math.max(10, tl.total))}) — ใช้หารายได้ได้ 💼</p>
    <div id="muM">${Object.entries(window.GMAudio.MOODS).map(([k, m]) => `<button class="plat" data-m="${k}"><span class="pi">🎵</span><span class="t"><b>${esc(m.n)}</b><small>${m.bpm} BPM</small></span></button>`).join('')}</div>
    <audio id="muA" controls hidden></audio><button class="btn" id="muUse" style="width:100%;margin-top:8px" disabled>ใช้เพลงนี้</button>`, el => {
    let cur = null, name = '';
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
      el.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); b.querySelector('small').textContent = 'กำลังแต่งเพลง…';
      try { cur = await window.GMAudio.makeMusic(b.dataset.m, Math.max(10, tl.total + 1)); name = window.GMAudio.MOODS[b.dataset.m].n; const a = el.querySelector('#muA'); a.src = URL.createObjectURL(cur); a.hidden = false; a.play().catch(() => {}); el.querySelector('#muUse').disabled = false; }
      catch(e){ toast(e.message, true); }
      b.querySelector('small').textContent = window.GMAudio.MOODS[b.dataset.m].bpm + ' BPM';
    });
    el.querySelector('#muUse').onclick = () => { P.music = cur; P.musicLk = 'gen'; P.musicName = name; touch(); closeAll(); render(); toast('ใส่เพลงประกอบแล้ว'); };
  });
}
/* standalone SFX maker (from home) */
function openSfxMaker(){
  openSheet(sheetHead('🔔 สร้างเสียงประกอบจากข้อความ') + `
    <p class="hint" style="margin-top:0">พิมพ์ชื่อเสียง (ไทย/อังกฤษ) ผสมได้หลายเสียง + คำขยาย ยาว/สั้น/เบา/ดัง/ไกล · สังเคราะห์ในแอป ไม่มีลิขสิทธิ์ภายนอก 💼</p>
    <div class="row2"><input class="inp" id="smT" placeholder="เช่น ฝนตก ฟ้าร้อง ยาว"><button class="btn" id="smGo">สร้าง</button></div>
    <div class="chips" style="margin-top:10px" id="smC">${sfxChips()}</div>
    <audio id="smA" controls hidden></audio>
    <div class="row2" style="margin-top:8px"><button class="btn alt sm" id="smDl" disabled>⬇ บันทึก</button><button class="btn alt sm" id="smSh" disabled>📤 แชร์</button><button class="btn alt sm" id="smAdd" disabled>＋ ใส่ฉากล่าสุดในโปรเจกต์</button></div>`, el => {
    let cur = null;
    const gen = async () => { const t = el.querySelector('#smT').value.trim(); if (!t) return; try { cur = await window.GMAudio.makeSfx(t); const a = el.querySelector('#smA'); a.src = URL.createObjectURL(cur.blob); a.hidden = false; a.play().catch(() => {}); el.querySelectorAll('#smDl,#smSh,#smAdd').forEach(b => b.disabled = false); } catch(e){ toast(e.message, true); } };
    el.querySelector('#smGo').onclick = gen;
    el.querySelectorAll('#smC .chip').forEach(b => b.onclick = () => { el.querySelector('#smT').value = b.dataset.w; gen(); });
    const file = () => new File([cur.blob], `genmedi-sfx-${cur.label.replace(/\s+/g, '')}-${stamp()}.wav`, { type: 'audio/wav' });
    el.querySelector('#smDl').onclick = () => { const f = file(); GM.saveBlob(f, f.name); GM.saveToMac(f, 'audio', 'sfx ' + cur.label); };
    el.querySelector('#smSh').onclick = () => GM.shareFiles([file()], cur.label);
    el.querySelector('#smAdd').onclick = async () => { if (!P.scenes.length) P.scenes.push(newScene('')); const sc = P.scenes[P.scenes.length - 1]; (sc.sfx ||= []).push({ blob: cur.blob, label: cur.label, at: 'start', vol: 0.8 }); await audioBuf(cur.blob); touch(); render(); toast('ใส่ในฉากล่าสุดแล้ว'); };
  });
}

/* ---------------- script → video (auto) ---------------- */
function splitScript(text){
  const out = [];
  text.replace(/\r/g, '').split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean).forEach(p => {
    if (p.length <= 170) return out.push(p);
    let buf = '';
    for (const w of words(p)){ if ((buf + w).length > 150 && /[\s.!?。、ๆ]$/.test(buf + '') ){ out.push(buf.trim()); buf = ''; } buf += w; if (buf.length > 220){ out.push(buf.trim()); buf = ''; } }
    if (buf.trim()) out.push(buf.trim());
  });
  return out;
}
function openAuto(){
  const v = GM.curVoice(), pre = GM.ta.value.trim();
  openSheet(sheetHead('⚡ บท → วิดีโออัตโนมัติ') + `
    <textarea class="inp" id="auScript" style="height:160px;padding:12px" placeholder="วางบทพากย์ที่นี่ — 1 ย่อหน้า = 1 ฉาก">${esc(pre)}</textarea>
    <label class="lbl2">ชื่อเรื่อง (ไม่บังคับ)</label><input class="inp" id="auTitle" value="${esc(P?.title || '')}" placeholder="ขึ้นต้นวิดีโอ + ภาพปก">
    <label class="lbl2">สัดส่วน</label><div class="chips" id="auFmt">${Object.keys(FORMATS).map(f => `<button class="chip ${(P?.format || '9:16') === f ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}</div>
    <label class="lbl2">เสียงพากย์</label>
    <div class="row2"><div class="inp" style="display:flex;align-items:center;overflow:hidden;white-space:nowrap">${esc(v.name)}</div><button class="btn alt" id="auVoice">เปลี่ยน</button></div>
    <label class="switch"><span>สร้างภาพประกอบด้วย AI ทุกฉาก<br><small style="color:var(--mut)">${esc(GM.lic('img-' + S.imgEngine).t)}</small></span><input type="checkbox" id="auImg" checked></label>
    <label class="lbl2">สไตล์ภาพ</label><div class="chips" id="auStyle">${GM.IMG_STYLES.map(s => `<button class="chip ${S.imgStyle === s[0] ? 'on' : ''}" data-v="${s[0]}">${s[1]}</button>`).join('')}</div>
    <label class="switch"><span>ต่อท้ายโปรเจกต์เดิม (ไม่สร้างใหม่)</span><input type="checkbox" id="auAppend"></label>
    <button class="cta" id="auGo" style="margin-top:14px"><span class="bars"><i></i><i></i><i></i><i></i></span>สร้างวิดีโอ</button>
    <div class="prog2"><i id="auProg"></i></div><ol class="step-list" id="auSteps"></ol>`, el => {
    let fmt = P?.format || '9:16';
    el.querySelectorAll('#auFmt .chip').forEach(b => b.onclick = () => { fmt = b.dataset.f; el.querySelectorAll('#auFmt .chip').forEach(x => x.classList.toggle('on', x === b)); });
    el.querySelectorAll('#auStyle .chip').forEach(b => b.onclick = () => { S.imgStyle = b.dataset.v; GM.save(); el.querySelectorAll('#auStyle .chip').forEach(x => x.classList.toggle('on', x === b)); });
    el.querySelector('#auVoice').onclick = () => { closeAll(); setTimeout(() => document.querySelector('#btnVoice').click(), 250); };
    el.querySelector('#auGo').onclick = async () => {
      const text = el.querySelector('#auScript').value.trim(); if (!text) return toast('วางบทก่อนนะ');
      const vv = GM.curVoice(); if (vv.type === 'device') return toast('เลือกเสียงที่สร้างไฟล์ได้ (เสียงบน Mac/เสียง AI ฟรี/โคลน) ก่อน', true);
      const parts = splitScript(text); if (parts.length > 40 && !confirmLong(parts.length)) return;
      if (!el.querySelector('#auAppend').checked || !P){ P = newProj(el.querySelector('#auTitle').value.trim() || parts[0].slice(0, 40)); }
      P.format = fmt; P.title = el.querySelector('#auTitle').value.trim();
      const start = P.scenes.length; parts.forEach(t => P.scenes.push(newScene(t))); touch(); render();
      const steps = el.querySelector('#auSteps'), prog = el.querySelector('#auProg'), go = el.querySelector('#auGo'); go.disabled = true; go.classList.add('busy');
      const withImg = el.querySelector('#auImg').checked, total = parts.length * (withImg ? 2 : 1); let done = 0, fails = 0;
      const step = (msg, cls) => { const li = document.createElement('li'); li.className = cls || 'run'; li.textContent = msg; steps.appendChild(li); li.scrollIntoView({ block: 'nearest' }); return li; };
      for (let k = 0; k < parts.length; k++){
        const i = start + k;
        let li = step(`ฉาก ${k + 1}: สร้างเสียงพากย์…`);
        try { await makeVoice(i, true); li.className = 'done'; li.textContent = `ฉาก ${k + 1}: เสียง ✓ (${sceneDur(P.scenes[i]).toFixed(1)} วิ)`; } catch(e){ li.className = 'err'; li.textContent = `ฉาก ${k + 1}: เสียงล้มเหลว — ${e.message}`; fails++; }
        prog.style.width = (++done / total * 100) + '%';
        if (withImg){
          li = step(`ฉาก ${k + 1}: สร้างภาพ…`);
          try { const r = await GM.genImage(P.scenes[i].text, RATIO_FOR_IMG[P.format]); P.scenes[i].img = r.blob; P.scenes[i].imgLk = r.lk; await bitmap(r.blob); touch(false); renderScenes(); drawPreview(); li.className = 'done'; li.textContent = `ฉาก ${k + 1}: ภาพ ✓`; }
          catch(e){ li.className = 'err'; li.textContent = `ฉาก ${k + 1}: ภาพล้มเหลว — ${e.message} (เปลี่ยนภาพเองได้ภายหลัง)`; fails++; }
          prog.style.width = (++done / total * 100) + '%';
        }
      }
      await saveProj(); go.disabled = false; go.classList.remove('busy');
      step(fails ? `เสร็จแล้ว (มี ${fails} รายการที่ต้องแก้ — แตะฉากนั้นเพื่อทำใหม่)` : 'เสร็จแล้ว ✓ กดเล่นพรีวิว หรือส่งออกได้เลย', fails ? 'err' : 'done');
      toast('สร้างวิดีโอเสร็จแล้ว — ปิดหน้าต่างนี้เพื่อดูพรีวิว');
    };
  });
}
function confirmLong(n){ toast(`บทนี้แบ่งได้ ${n} ฉาก — อาจใช้เวลานานและโควตามาก`, true); return true; }

/* ---------------- export ---------------- */
async function renderVideo(W, H, onProg){
  await prepare(); await document.fonts.load(`700 ${Math.round(W * 0.06)}px "Noto Sans Thai"`).catch(() => {});
  await document.fonts.load(`800 ${Math.round(W * 0.08)}px "Prompt"`).catch(() => {});
  const tl = timeline(), N = Math.ceil(tl.total * FPS), mix = await mixAudio(48000);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  if ('VideoEncoder' in window && 'VideoFrame' in window){
    try { return await encodeWebCodecs(cv, ctx, W, H, tl, N, mix, onProg); }
    catch(e){ console.warn('WebCodecs failed', e); toast('ตัวเข้ารหัสหลักใช้ไม่ได้ (' + e.message + ') — ใช้โหมดสำรอง (เรนเดอร์แบบเรียลไทม์)', true); }
  }
  return encodeRecorder(cv, ctx, W, H, tl, mix, onProg);
}
async function encodeWebCodecs(cv, ctx, W, H, tl, N, mix, onProg){
  let Mp4; try { Mp4 = await import('./vendor/mp4-muxer.mjs'); } catch(e){ Mp4 = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm'); }
  const big = W * H > 1280 * 720;
  let vcfg = null;
  for (const codec of big ? ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'] : ['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f']){
    const cfg = { codec, width: W, height: H, bitrate: big ? 8_000_000 : 4_000_000, framerate: FPS };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported){ vcfg = cfg; break; } } catch(e){}
  }
  let vcodec = 'avc';
  if (!vcfg) for (const codec of ['vp09.00.40.08', 'vp09.00.10.08']){
    const cfg = { codec, width: W, height: H, bitrate: big ? 8_000_000 : 4_000_000, framerate: FPS };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported){ vcfg = cfg; vcodec = 'vp9'; break; } } catch(e){}
  }
  if (!vcfg) throw new Error('เครื่องนี้ไม่รองรับการเข้ารหัสวิดีโอ');
  let acodec = null;
  if ('AudioEncoder' in window) for (const codec of ['mp4a.40.2', 'opus']){
    try { if ((await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported){ acodec = codec; break; } } catch(e){}
  }
  const muxer = new Mp4.Muxer({ target: new Mp4.ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: vcodec, width: W, height: H }, audio: acodec ? { codec: acodec === 'opus' ? 'opus' : 'aac', sampleRate: 48000, numberOfChannels: 2 } : undefined });
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => err = e });
  venc.configure(vcfg);
  for (let i = 0; i < N; i++){
    if (err) throw err;
    drawFrame(ctx, W, H, i / FPS, tl);
    const fr = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(fr, { keyFrame: i % (FPS * 2) === 0 }); fr.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
    if (i % 10 === 0){ onProg(i / N * 0.9, `เรนเดอร์ภาพ ${i}/${N} เฟรม`); await new Promise(r => setTimeout(r, 0)); }
  }
  await venc.flush(); venc.close();
  if (acodec){
    onProg(0.92, 'เข้ารหัสเสียง…');
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e });
    aenc.configure({ codec: acodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
    const L = mix.getChannelData(0), R = mix.getChannelData(1), F = 4096, len = Math.min(L.length, Math.ceil(tl.total * 48000));
    for (let off = 0; off < len; off += F){
      const n = Math.min(F, len - off), data = new Float32Array(n * 2); data.set(L.subarray(off, off + n), 0); data.set(R.subarray(off, off + n), n);
      aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(off * 1e6 / 48000), data }));
    }
    await aenc.flush(); aenc.close(); if (err) throw err;
  }
  muxer.finalize();
  const notes = [];
  if (vcodec !== 'avc') notes.push('วิดีโอเป็น VP9 (เครื่องนี้ไม่มี H.264)');
  if (acodec === 'opus') notes.push('เสียงเป็น Opus');
  if (!acodec) notes.push('ไม่มีเสียง (เบราว์เซอร์นี้เข้ารหัสเสียงไม่ได้)');
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', audio: acodec, vcodec, note: notes.length ? notes.join(' · ') + ' — บางแพลตฟอร์มอาจไม่รับ แนะนำแปลงผ่าน Mac (Gen Medi for Mac) หรือใช้ Chrome บน Android/Mac' : '' };
}
async function encodeRecorder(cv, ctx, W, H, tl, mix, onProg){
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mime = types.find(t => window.MediaRecorder?.isTypeSupported?.(t));
  if (!mime) throw new Error('เบราว์เซอร์นี้สร้างวิดีโอไม่ได้ — ลอง Chrome รุ่นใหม่');
  const ac = new AudioContext(); const dest = ac.createMediaStreamDestination(); const src = ac.createBufferSource(); src.buffer = mix; src.connect(dest);
  const stream = new MediaStream([...cv.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: W * H > 1e6 ? 8e6 : 4e6 }), parts = [];
  rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  rec.start(500); await ac.resume(); const t0 = ac.currentTime + 0.05; src.start(t0);
  await new Promise(res => { const step = () => { const t = ac.currentTime - t0; if (t >= tl.total){ res(); return; } drawFrame(ctx, W, H, Math.max(0, t), tl); onProg(t / tl.total * 0.98, `กำลังบันทึกแบบเรียลไทม์ ${fmtT(t)} / ${fmtT(tl.total)} — อย่าสลับแอป`); requestAnimationFrame(step); }; step(); });
  rec.stop(); await done; ac.close();
  const ext = mime.includes('mp4') ? 'mp4' : 'webm', avc = mime.includes('avc1');
  return { blob: new Blob(parts, { type: mime.split(';')[0] }), ext, vcodec: avc ? 'avc' : 'other', audio: avc ? 'mp4a.40.2' : 'opus',
    note: avc ? '' : (ext === 'webm' ? 'ได้ไฟล์ WebM' : 'ไฟล์ MP4 แต่ codec ไม่ใช่ H.264') + ' — TikTok/IG บางครั้งไม่รับ แนะนำแปลงผ่าน Mac (Gen Medi for Mac)' };
}
function buildSrt(){
  const tl = timeline(), cv = document.createElement('canvas').getContext('2d'), [W, H] = FORMATS[P.format]; let n = 0;
  const ts = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return tl.items.flatMap(x => { if (!x.s.text) return []; const a = x.s.audio && audCache.get(x.s.audio); return captions(cv, x.s, W, H, a ? a.duration : x.dur - 0.2).map(c => `${++n}\n${ts(x.start + c.t0)} --> ${ts(x.start + c.t1)}\n${c.lines.join('\n')}\n`); }).join('\n');
}
async function thumbnail(W, H){
  await prepare(); await document.fonts.load('800 60px "Prompt"').catch(() => {});
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const tl = timeline();
  drawFrame(cv.getContext('2d'), W, H, Math.min(1.2, tl.total / 2), tl, { noSubs: true, forceTitle: true });
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
}
async function audioExport(kind){
  const mix = await mixAudio(44100);
  if (kind === 'wav') return { blob: GM.encodeWav([mix.getChannelData(0), mix.getChannelData(1)], 44100), ext: 'wav' };
  await new Promise((res, rej) => { if (window.lamejs) return res(); const s = document.createElement('script'); s.src = 'vendor/lame.min.js'; s.onload = res; s.onerror = () => { s.remove(); const c = document.createElement('script'); c.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js'; c.onload = res; c.onerror = () => rej(new Error('โหลดตัวเข้ารหัส MP3 ไม่ได้')); document.head.appendChild(c); }; document.head.appendChild(s); });
  const enc = new lamejs.Mp3Encoder(2, 44100, 160), L = mix.getChannelData(0), R = mix.getChannelData(1), out = [], B = 1152;
  const to16 = (a, o, n) => { const r = new Int16Array(n); for (let i = 0; i < n; i++){ const v = Math.max(-1, Math.min(1, a[o + i])); r[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return r; };
  for (let o = 0; o < L.length; o += B){ const n = Math.min(B, L.length - o); const b = enc.encodeBuffer(to16(L, o, n), to16(R, o, n)); if (b.length) out.push(b); }
  out.push(enc.flush()); return { blob: new Blob(out, { type: 'audio/mpeg' }), ext: 'mp3' };
}
async function transcodeOnMac(blob){
  const r = await GM.MAC.form('/api/transcode', { file: new File([blob], 'in.' + (blob.type.includes('webm') ? 'webm' : 'mp4'), { type: blob.type }) });
  return r.blob();
}
function openExport(){
  if (!P || !P.scenes.length) return toast('ยังไม่มีฉาก — สร้างวิดีโอก่อน', true);
  const tl = timeline(), bad = P.scenes.map((s, i) => (!licOk(s.imgLk) || !licOk(s.audLk)) ? i + 1 : 0).filter(Boolean);
  let sel = PLATFORMS.find(p => p.f === P.format) || PLATFORMS[0], q = GM.LS.get('expQ', '1080');
  const cap = () => `${P.title || P.name}\n\n${(P.scenes[0]?.text || '').slice(0, 140)}${sel.tags ? '\n\n' + sel.tags : ''}`;
  openSheet(sheetHead('🚀 ส่งออก / ลงแพลตฟอร์ม') + `
    <p class="hint" style="margin-top:0">ยาว ${fmtT(tl.total)} · ${P.scenes.length} ฉาก · เรนเดอร์ในเครื่องนี้ ${S.commercial ? '· 💼 โหมดเชิงพาณิชย์' : ''}</p>
    ${S.commercial && bad.length ? `<div class="qbar" style="margin:0 0 10px">⚠️ ฉาก ${bad.join(', ')} ใช้ภาพ/เสียงที่สัญญาไม่อนุญาตเชิงพาณิชย์ — แก้ฉากเหล่านั้น หรือปิดโหมดเชิงพาณิชย์ (ใช้ส่วนตัว)</div>` : ''}
    <div id="exPlats">${PLATFORMS.map(p => `<button class="plat ${p.id === sel.id ? 'on' : ''}" data-id="${p.id}"><span class="pi">${p.i}</span><span class="t"><b>${p.n}</b><small>${p.audio ? (p.audio === 'mp3' ? 'MP3 160kbps · เสียงล้วน' : 'WAV 44.1kHz') : `${p.f} · ${(p.size || FORMATS[p.f]).join('×')} · MP4 H.264 30fps${p.f !== P.format ? ' · ครอปภาพให้พอดี' : ''}`}</small></span></button>`).join('')}</div>
    <label class="lbl2">คุณภาพวิดีโอ</label><div class="chips" id="exQ"><button class="chip ${q === '1080' ? 'on' : ''}" data-q="1080">1080p (คมชัด)</button><button class="chip ${q === '720' ? 'on' : ''}" data-q="720">720p (เร็ว · เครื่องรุ่นเก่า)</button></div>
    <label class="lbl2">คำบรรยายโพสต์ (คัดลอกไปวางตอนโพสต์)</label><textarea class="inp" id="exCap" style="height:100px;padding:10px">${esc(cap())}</textarea>
    <div class="row2" style="margin-top:6px"><button class="btn alt sm" id="exCopy">📋 คัดลอกคำบรรยาย</button><button class="btn alt sm" id="exSrt">📝 ไฟล์ซับ .srt</button><button class="btn alt sm" id="exThumb">🖼️ ภาพปก</button></div>
    <button class="cta" id="exGo" style="margin-top:14px"><span class="bars"><i></i><i></i><i></i><i></i></span>เรนเดอร์ไฟล์</button>
    <div class="prog2"><i id="exProg"></i></div><p class="hint" id="exMsg"></p><div id="exOut"></div>`, el => {
    el.querySelectorAll('.plat').forEach(b => b.onclick = () => { sel = PLATFORMS.find(p => p.id === b.dataset.id); el.querySelectorAll('.plat').forEach(x => x.classList.toggle('on', x === b)); el.querySelector('#exCap').value = cap(); });
    el.querySelectorAll('#exQ .chip').forEach(b => b.onclick = () => { q = b.dataset.q; GM.LS.set('expQ', q); el.querySelectorAll('#exQ .chip').forEach(x => x.classList.toggle('on', x === b)); });
    el.querySelector('#exCopy').onclick = async () => { try { await navigator.clipboard.writeText(el.querySelector('#exCap').value); toast('คัดลอกแล้ว'); } catch(e){ toast('คัดลอกไม่ได้ — กดค้างที่ข้อความแล้วคัดลอกเอง', true); } };
    el.querySelector('#exSrt').onclick = async () => { await prepare(); GM.saveBlob(new Blob([buildSrt()], { type: 'text/plain' }), `genmedi-${stamp()}.srt`); };
    el.querySelector('#exThumb').onclick = async () => {
      const [W, H] = sel.thumb || sel.size || FORMATS[sel.f || P.format]; const b = await thumbnail(W, H); const f = new File([b], `genmedi-cover-${stamp()}.jpg`, { type: 'image/jpeg' });
      GM.saveBlob(f, f.name); if (S.commercial === false || bad.length === 0) GM.saveToMac(f, 'images', 'cover ' + (P.title || P.name));
    };
    el.querySelector('#exGo').onclick = async () => {
      if (S.commercial && bad.length) return toast('โหมดเชิงพาณิชย์: แก้ฉาก ' + bad.join(', ') + ' ก่อน หรือปิดโหมด', true);
      const go = el.querySelector('#exGo'), prog = el.querySelector('#exProg'), msg = el.querySelector('#exMsg'), out = el.querySelector('#exOut');
      go.disabled = true; go.classList.add('busy'); out.innerHTML = ''; pause();
      const t0 = performance.now();
      try {
        let r;
        if (sel.audio){ msg.textContent = 'กำลังรวมเสียง…'; r = await audioExport(sel.audio); }
        else {
          let [W, H] = sel.size || FORMATS[sel.f]; if (q === '720'){ const k = 720 / Math.min(W, H); W = Math.round(W * k / 2) * 2; H = Math.round(H * k / 2) * 2; }
          r = await renderVideo(W, H, (p, m) => { prog.style.width = (p * 100) + '%'; msg.textContent = m; });
          if ((r.ext === 'webm' || r.audio === 'opus' || (r.vcodec && r.vcodec !== 'avc')) && GM.MAC.on){
            msg.textContent = 'กำลังแปลงเป็น MP4 (H.264 + AAC) บน Mac…';
            try { r = { blob: await transcodeOnMac(r.blob), ext: 'mp4', note: '' }; } catch(e){ r.note += ' (แปลงบน Mac ไม่สำเร็จ: ' + e.message + ')'; }
          }
        }
        prog.style.width = '100%';
        const f = new File([r.blob], `genmedi-${sel.id}-${stamp()}.${r.ext}`, { type: r.blob.type });
        msg.innerHTML = `✅ เสร็จใน ${GM.fmtDur((performance.now() - t0) / 1000)} · ${(f.size / 1048576).toFixed(1)} MB ${r.note ? '<br>⚠️ ' + esc(r.note) : ''}`;
        const url = URL.createObjectURL(f);
        out.innerHTML = `${sel.audio ? `<audio controls src="${url}"></audio>` : `<video controls playsinline src="${url}" style="width:100%;max-height:50vh;border-radius:14px;background:#000;margin-top:8px"></video>`}
          <div class="row2" style="margin-top:10px"><button class="btn" style="flex:1" id="exSave">⬇ บันทึก</button><button class="btn alt" style="flex:1" id="exShare">📤 แชร์ไป ${esc(sel.n.split(' ')[0])}</button></div>
          <p class="hint">กด “แชร์” แล้วเลือกแอป ${esc(sel.n)} หรือ Google Drive ได้ทันที · ถ้าไม่มีในรายการ ให้บันทึกแล้วอัปโหลดจากในแอปนั้น</p>`;
        out.querySelector('#exSave').onclick = () => GM.saveBlob(f, f.name);
        out.querySelector('#exShare').onclick = async () => { try { await navigator.clipboard.writeText(el.querySelector('#exCap').value); toast('คัดลอกคำบรรยายไว้แล้ว — วางตอนโพสต์ได้เลย'); } catch(e){} GM.shareFiles([f], P.title || P.name); };
        GM.saveToMac(f, sel.audio ? 'audio' : 'videos', `${sel.id} ${P.title || P.name}`);
        GM.addHistory({ kind: 'audio', text: `[${sel.n}] ${P.title || P.name}`, voice: 'วิดีโอ/เสียงจาก Studio', blob: f });
      } catch(e){ msg.innerHTML = `<span style="color:var(--err)">ส่งออกไม่สำเร็จ: ${esc(e.message)}</span>`; }
      go.disabled = false; go.classList.remove('busy');
    };
  });
}

/* ---------------- projects ---------------- */
async function openProjects(){
  const list = (await db.all('projects')).sort((a, b) => b.updated - a.updated);
  openSheet(sheetHead('🗂️ โปรเจกต์') + `<button class="btn" id="pjNew" style="width:100%">＋ โปรเจกต์ใหม่</button>` + list.map(p => `<div class="proj" data-id="${p.id}">${p.thumb ? `<img src="${URL.createObjectURL(p.thumb)}">` : '<span class="ph"></span>'}<span class="t"><b>${esc(p.name)}</b><small>${p.scenes.length} ฉาก · ${p.format}</small></span><button class="mini bad" data-del>🗑</button></div>`).join(''), el => {
    el.querySelector('#pjNew').onclick = () => { newProject(); closeAll(); };
    el.querySelectorAll('.proj').forEach(r => {
      r.onclick = e => { if (e.target.closest('[data-del]')) return; openProject(r.dataset.id); closeAll(); };
      r.querySelector('[data-del]').onclick = async () => { await db.del('projects', r.dataset.id); r.remove(); if (P?.id === r.dataset.id){ P = null; newProject(); } };
    });
  });
}
async function openProject(id){ const p = await db.get('projects', id); if (!p) return toast('ไม่พบโปรเจกต์', true); pause(); P = p; dirtyMix = true; player.t = 0; capCache.clear(); render(); }
function newProject(){ pause(); P = newProj(); dirtyMix = true; player.t = 0; render(); saveProj(); }

/* ---------------- boot ---------------- */
async function init(){
  const last = GM.LS.get('lastProject', null);
  if (last){ const p = await db.get('projects', last).catch(() => null); if (p) P = p; }
  if (!P) P = newProj();
  render();
}
window.addEventListener('gm:page', e => { if (e.detail !== 'studio') pause(); else drawPreview(); });
function setMusic(file, lk, name){ if (!P){ P = newProj(name); } P.music = file; P.musicLk = lk; P.musicName = name; touch(); render(); toast(lk === 'cover' ? 'ใส่ดนตรีคัฟเวอร์แล้ว — โหมดเชิงพาณิชย์จะเตือน เพราะทำนอง/เนื้อร้องเป็นของผู้แต่ง' : 'ใส่เพลงแล้ว'); }
window.GMStudio = { openAuto: () => { if (!P) P = newProj(); openAuto(); }, openExport, newProject, openProject, openSfxMaker, setMusic, openMusic: () => { if (!P) P = newProj(); openMusic(); } };
init();
