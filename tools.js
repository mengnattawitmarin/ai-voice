/* Gen Medi — Mac-powered tools: AI script writer, speech → subtitles, image tools, job queue.
   Everything runs on the user's Mac (open models, no cloud API); the phone sends work and polls the queue. */
const GM = window.GM;
const { S, toast, esc, stamp, saveBlob, shareFiles, saveToMac, addHistory } = GM;
const $ = s => document.querySelector(s);
const fmt = s => s == null ? '?' : s < 60 ? Math.round(s) + ' วินาที' : Math.round(s / 60) + ' นาที';

/* ---------- shared: submit a job to the Mac and wait for it ---------- */
async function macJob(path, body, onTick){
  const r = body instanceof FormData ? await GM.MAC.call(path, { method: 'POST', body }, 120000) : await GM.MAC.json(path, body, 60000);
  const { job } = await r.json();
  for (;;){
    await new Promise(res => setTimeout(res, 2500));
    const j = await (await GM.MAC.call('/api/jobs/' + job, {}, 20000)).json();
    onTick && onTick(j);
    if (j.state === 'done') return GM.MAC.call('/api/jobs/' + job + '/result', {}, 300000);
    if (j.state === 'error') throw new Error(j.msg || 'งานล้มเหลว');
  }
}
const tickText = j => j.state === 'queued' ? `รอคิวที่ ${j.pos || 1} บน Mac…` : (j.msg || 'กำลังทำงาน…') + (j.total && j.step ? ` · ${j.step}/${j.total}` : '');
function needMac(box){
  if (GM.MAC.on) return false;
  box.innerHTML = `<div class="lim">เครื่องมือนี้ประมวลผลบน Mac ของคุณ <button class="btn sm" style="margin-left:6px" data-mac>เชื่อมต่อ Mac</button></div>`;
  box.querySelector('[data-mac]').onclick = () => GM.openProc();
  return true;
}
const chips = (list, cur, key) => `<div class="chips" data-k="${key}">${list.map(o => `<button class="chip ${o[0] === cur ? 'on' : ''}" data-v="${o[0]}">${o[1]}</button>`).join('')}</div>`;
function bindChips(root, st, save, after){
  root.querySelectorAll('.chips[data-k]').forEach(c => c.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    st[c.dataset.k] = b.dataset.v; save(); c.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); after && after();
  }));
}

/* ========== ✍️ AI script writer (Qwen2.5-7B-Instruct, Apache-2.0, on the Mac) ========== */
const W = Object.assign({ topic: '', platform: 'tiktok', len: '30', tone: 'fun', aud: '', out: '' }, GM.LS.get('writer', {}));
const saveW = () => GM.LS.set('writer', W);
const PLATS = [['tiktok', 'TikTok'], ['reels', 'Reels'], ['shorts', 'Shorts'], ['youtube', 'YouTube ยาว'], ['facebook', 'Facebook']];
const LENS = [['15', '15 วิ'], ['30', '30 วิ'], ['60', '60 วิ'], ['180', '3 นาที']];
const TONES = [['fun', '😄 สนุก'], ['story', '📖 เล่าเรื่อง'], ['edu', '🧠 ให้ความรู้'], ['sell', '🛒 ขายของ'], ['serious', '🎙️ จริงจัง'], ['news', '📰 ข่าว']];
const TONE_TH = { fun: 'สนุก เป็นกันเอง', story: 'เล่าเรื่องชวนติดตาม', edu: 'ให้ความรู้ เข้าใจง่าย', sell: 'ขายของแบบไม่ยัดเยียด มี call to action ชัด', serious: 'จริงจัง น่าเชื่อถือ', news: 'สรุปข่าว กระชับ' };
const SYS = 'คุณคือนักเขียนบทวิดีโอสั้นภาษาไทยมืออาชีพ เขียนภาษาไทยที่เป็นธรรมชาติ อ่านออกเสียงลื่น ไม่ใช้อีโมจิในบทพากย์ ไม่อ้างข้อมูลที่ไม่แน่ใจ ไม่ใช้ชื่อแบรนด์หรือบุคคลจริงถ้าผู้ใช้ไม่ได้ระบุ';
function writerPrompt(kind){
  const p = PLATS.find(x => x[0] === W.platform)[1], sec = +W.len, words = Math.round(sec * 3.2);
  const ctx = `หัวข้อ: ${W.topic}\nแพลตฟอร์ม: ${p}\nความยาว: ประมาณ ${sec} วินาที (ประมาณ ${words} คำพูด)\nโทน: ${TONE_TH[W.tone]}${W.aud ? '\nกลุ่มเป้าหมาย: ' + W.aud : ''}`;
  if (kind === 'hook') return `${ctx}\n\nเขียน "ฮุก" ประโยคเปิด 3 วินาทีแรกที่ทำให้คนหยุดเลื่อน 6 แบบ แต่ละแบบใช้เทคนิคต่างกัน (คำถาม, ตัวเลขน่าตกใจ, ความลับ, ขัดความเชื่อ, ผลลัพธ์ก่อน, ท้าทาย) ตอบเป็นรายการ 1-6 บรรทัดละแบบ ไม่ต้องอธิบาย`;
  if (kind === 'tags') return `${ctx}\n\nเขียนแคปชันโพสต์ 3 แบบ (สั้น กระชับ มีคำชวนคอมเมนต์) และแฮชแท็กที่เกี่ยวข้อง 12 อัน (ไทยผสมอังกฤษ) รูปแบบ:\n### แคปชัน\n1. ...\n2. ...\n3. ...\n### แฮชแท็ก\n#... #...`;
  return `${ctx}\n\nเขียนบทพากย์วิดีโอพร้อมใช้ โดย:\n- ย่อหน้าแรกเป็นฮุก 1 ประโยคที่ดึงคนดูทันที\n- แต่ละย่อหน้าคือ 1 ฉาก ยาว 1-2 ประโยค (เว้นบรรทัดระหว่างย่อหน้า)\n- จบด้วย call to action (กดติดตาม/คอมเมนต์/กดตะกร้า ตามโทน)\n- ใต้บทพากย์ ให้ใส่ส่วนต่อไปนี้:\n### ภาพประกอบแต่ละฉาก (ภาษาอังกฤษ)\n1. ...\n### แคปชัน\n...\n### แฮชแท็ก\n#...\n\nเริ่มด้วยบทพากย์ทันที ไม่ต้องมีหัวข้อหรือคำอธิบายก่อนหน้า`;
}
function splitOut(t){
  const i = t.indexOf('###'), script = (i >= 0 ? t.slice(0, i) : t).replace(/^\s*(บทพากย์|สคริปต์)\s*[:：]?\s*/m, '').trim();
  const sec = name => { const m = t.match(new RegExp('###\\s*' + name + '[^\\n]*\\n([\\s\\S]*?)(?=###|$)')); return m ? m[1].trim() : ''; };
  return { script, prompts: sec('ภาพ'), caption: sec('แคปชัน'), tags: sec('แฮชแท็ก') };
}
function renderWriter(){
  const root = $('#writerRoot'); if (!root) return;
  root.innerHTML = `<div class="card"><div class="card-h"><h2>✍️ ผู้ช่วยเขียนบท</h2></div>
    <p class="hint" style="margin-top:0">บอกหัวข้อ → AI บน Mac เขียนบทพากย์ ฮุก 3 วินาทีแรก แคปชัน และแฮชแท็ก · โมเดล Qwen2.5-7B (Apache-2.0) · ไม่ใช้ API</p>
    <label class="lbl2">หัวข้อ / สินค้า / ไอเดีย</label>
    <textarea class="inp" id="wTopic" style="height:90px;padding:12px" placeholder="เช่น 5 ที่เที่ยวเชียงใหม่หน้าหนาวที่คนไม่ค่อยรู้ / รีวิวพัดลมพกพา / เล่าตำนานแม่นาคแบบสั้น">${esc(W.topic)}</textarea>
    <label class="lbl2">แพลตฟอร์ม</label>${chips(PLATS, W.platform, 'platform')}
    <label class="lbl2">ความยาว</label>${chips(LENS, W.len, 'len')}
    <label class="lbl2">โทน</label>${chips(TONES, W.tone, 'tone')}
    <label class="lbl2">กลุ่มเป้าหมาย (ไม่บังคับ)</label><input class="inp" id="wAud" value="${esc(W.aud)}" placeholder="เช่น วัยทำงาน 25-35 ชอบเที่ยว">
    <div class="row2" style="margin-top:12px;flex-wrap:wrap;gap:8px"><button class="btn" style="flex:2" data-w="script">✍️ เขียนบททั้งหมด</button><button class="btn alt" style="flex:1" data-w="hook">🎣 ฮุก 6 แบบ</button><button class="btn alt" style="flex:1" data-w="tags"># แคปชัน</button></div>
    <div id="wBox" style="margin-top:12px"></div>
    <div id="wOut"></div></div>`;
  bindChips(root, W, saveW);
  root.querySelector('#wTopic').oninput = e => { W.topic = e.target.value; saveW(); };
  root.querySelector('#wAud').oninput = e => { W.aud = e.target.value; saveW(); };
  root.querySelectorAll('[data-w]').forEach(b => b.onclick = () => runWriter(b.dataset.w));
  if (W.out) showWriter(W.out, W.kind || 'script');
}
async function runWriter(kind){
  const box = $('#wBox'); if (needMac(box)) return;
  if (!W.topic.trim()) return toast('ใส่หัวข้อก่อนนะ');
  box.innerHTML = `<div class="prog2"><i style="width:15%"></i></div><p class="hint" id="wMsg">ส่งงานไปที่ Mac…</p>`;
  try {
    const t0 = performance.now();
    const r = await macJob('/api/llm', { system: SYS, prompt: writerPrompt(kind), max_tokens: kind === 'script' && +W.len >= 180 ? 1600 : 900 }, j => { const m = $('#wMsg'); if (m) m.textContent = tickText(j); });
    const { text } = await r.json();
    W.out = text; W.kind = kind; saveW(); box.innerHTML = `<p class="hint">เสร็จใน ${fmt((performance.now() - t0) / 1000)} — แก้ไขข้อความได้ก่อนนำไปใช้</p>`;
    showWriter(text, kind);
  } catch(e){ box.innerHTML = `<p class="lim">${esc(e.message)}</p>`; }
}
function showWriter(text, kind){
  const out = $('#wOut'); if (!out) return;
  const p = kind === 'script' ? splitOut(text) : { script: text };
  out.innerHTML = `<label class="lbl2">${kind === 'script' ? 'บทพากย์ (1 ย่อหน้า = 1 ฉาก)' : kind === 'hook' ? 'ฮุก' : 'แคปชัน & แฮชแท็ก'}</label>
    <textarea class="inp" id="wScript" style="height:220px;padding:12px">${esc(p.script)}</textarea>
    ${p.caption || p.tags ? `<label class="lbl2">แคปชัน + แฮชแท็ก</label><textarea class="inp" id="wCap" style="height:110px;padding:12px">${esc([p.caption, p.tags].filter(Boolean).join('\n\n'))}</textarea>` : ''}
    ${p.prompts ? `<details style="margin-top:8px"><summary class="hint">คำบรรยายภาพแต่ละฉาก (อังกฤษ)</summary><pre class="hint" style="white-space:pre-wrap">${esc(p.prompts)}</pre></details>` : ''}
    <div class="row2" style="margin-top:10px;flex-wrap:wrap;gap:8px">
      ${kind === 'script' ? '<button class="btn" style="flex:2" data-o="auto">⚡ ส่งเข้า บท → วิดีโอ</button><button class="btn alt" style="flex:1" data-o="tts">🎙️ ไปอ่านเป็นเสียง</button>' : ''}
      <button class="btn alt" style="flex:1" data-o="copy">📋 คัดลอก</button></div>`;
  out.querySelectorAll('[data-o]').forEach(b => b.onclick = async () => {
    const sc = out.querySelector('#wScript').value.trim();
    if (b.dataset.o === 'copy'){ try { await navigator.clipboard.writeText(sc + (out.querySelector('#wCap') ? '\n\n' + out.querySelector('#wCap').value : '')); toast('คัดลอกแล้ว'); } catch(e){ toast('คัดลอกไม่ได้', true); } }
    if (b.dataset.o === 'tts'){ GM.ta.value = sc; GM.ta.dispatchEvent(new Event('input')); GM.go('tts'); }
    if (b.dataset.o === 'auto'){ GM.ta.value = sc; GM.ta.dispatchEvent(new Event('input')); GM.go('studio'); setTimeout(() => window.GMStudio?.openAuto(), 300); }
  });
}

/* ========== 📝 speech → subtitles (Whisper large-v3-turbo, MIT, on the Mac) ========== */
let sttRes = null, sttFile = null;
const srtTime = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
function toSrt(segs){ return segs.map((g, i) => `${i + 1}\n${srtTime(g.start)} --> ${srtTime(g.end)}\n${g.text.trim()}\n`).join('\n'); }
function renderStt(){
  const root = $('#sttRoot'); if (!root) return;
  const lang = GM.LS.get('sttLang', 'th');
  root.innerHTML = `<div class="card"><div class="card-h"><h2>📝 ถอดเสียงเป็นซับ</h2></div>
    <p class="hint" style="margin-top:0">ใส่คลิปที่ถ่ายเอง/ไฟล์เสียง → Mac ถอดคำพูดพร้อมเวลาทีละคำ (Whisper large-v3-turbo, MIT) → ได้ไฟล์ซับ .srt หรือส่งเข้าสตูดิโอเป็นซับคาราโอเกะ</p>
    <label class="lbl2">ภาษาในคลิป</label>${chips([['th', 'ไทย'], ['en', 'English'], ['auto', 'อัตโนมัติ']], lang, 'lang')}
    <div class="row2" style="margin-top:12px"><label class="btn" style="flex:1;text-align:center">📁 เลือกคลิป / ไฟล์เสียง<input type="file" id="sttIn" accept="video/*,audio/*" hidden></label></div>
    <div id="sttBox" style="margin-top:12px"></div><div id="sttOut"></div></div>`;
  const st = { lang }; bindChips(root, st, () => GM.LS.set('sttLang', st.lang));
  root.querySelector('#sttIn').onchange = e => { const f = e.target.files[0]; if (f) runStt(f, st.lang); };
  if (sttRes) showStt();
}
async function runStt(file, lang){
  const box = $('#sttBox'); if (needMac(box)) return;
  sttFile = file; sttRes = null; $('#sttOut').innerHTML = '';
  box.innerHTML = `<div class="prog2"><i style="width:10%"></i></div><p class="hint" id="sttMsg">กำลังส่งไฟล์ไป Mac (${(file.size / 1048576).toFixed(1)} MB)…</p>`;
  try {
    const fd = new FormData(); fd.append('file', file, file.name || 'clip.mp4'); fd.append('lang', lang);
    const t0 = performance.now();
    const r = await macJob('/api/transcribe', fd, j => { const m = $('#sttMsg'); if (m) m.textContent = tickText(j); });
    sttRes = await r.json();
    box.innerHTML = `<p class="hint">ถอดเสร็จใน ${fmt((performance.now() - t0) / 1000)} · ${sttRes.segments.length} ช่วง — แก้คำผิดได้ในช่องด้านล่าง</p>`;
    showStt();
  } catch(e){ box.innerHTML = `<p class="lim">${esc(e.message)}</p>`; }
}
function showStt(){
  const out = $('#sttOut'); if (!out || !sttRes) return;
  out.innerHTML = `<div class="sttlist">${sttRes.segments.map((g, i) => `<div class="sttrow"><small>${srtTime(g.start).slice(3, 8)}</small><input class="inp" data-i="${i}" value="${esc(g.text)}"></div>`).join('')}</div>
    <div class="row2" style="margin-top:10px;flex-wrap:wrap;gap:8px">
      ${sttFile && /^video/.test(sttFile.type) ? '<button class="btn" style="flex:2" data-s="studio">🎬 เข้าสตูดิโอพร้อมซับคาราโอเกะ</button>' : ''}
      <button class="btn alt" style="flex:1" data-s="srt">⬇️ .srt</button><button class="btn alt" style="flex:1" data-s="txt">⬇️ ข้อความ</button><button class="btn alt" style="flex:1" data-s="tts">🎙️ ใช้เป็นบท</button></div>`;
  out.querySelectorAll('input[data-i]').forEach(inp => inp.oninput = () => { const g = sttRes.segments[+inp.dataset.i]; g.text = inp.value; g.words = []; });
  out.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
    const name = (sttFile?.name || 'subtitle').replace(/\.[^.]+$/, '');
    if (b.dataset.s === 'srt'){ const f = new File([toSrt(sttRes.segments)], name + '.srt', { type: 'text/plain' }); saveBlob(f, f.name); saveToMac(f, 'videos', name); }
    if (b.dataset.s === 'txt'){ const f = new File([sttRes.segments.map(g => g.text).join('\n')], name + '.txt', { type: 'text/plain' }); saveBlob(f, f.name); }
    if (b.dataset.s === 'tts'){ GM.ta.value = sttRes.segments.map(g => g.text).join('\n'); GM.ta.dispatchEvent(new Event('input')); GM.go('tts'); }
    if (b.dataset.s === 'studio'){ GM.go('studio'); setTimeout(() => window.GMStudio?.importClip(sttFile, 'user', sttRes.segments, name), 300); }
  });
}

/* ========== 🪄 image tools: remove background (ISNet via rembg, Apache-2.0) · AI upscale (Real-ESRGAN, BSD-3) ========== */
let imgSrc = null;
function renderImgTools(){
  const root = $('#imgtoolsRoot'); if (!root) return;
  root.innerHTML = `<div class="card"><div class="card-h"><h2>🪄 เครื่องมือภาพ</h2></div>
    <p class="hint" style="margin-top:0">ลบพื้นหลังภาพสินค้า/คน และขยายภาพให้คมด้วย AI บน Mac · ใช้ภาพที่คุณมีสิทธิ์ใช้</p>
    <div class="row2"><label class="btn alt" style="flex:1;text-align:center">📁 เลือกภาพ<input type="file" id="itIn" accept="image/*" hidden></label><button class="btn alt" style="flex:1" id="itLast">🖼️ ภาพล่าสุดในคลัง</button></div>
    <div id="itPrev" style="margin-top:12px">${imgSrc ? '' : '<p class="hint">ยังไม่ได้เลือกภาพ</p>'}</div>
    <div class="row2" style="margin-top:10px;flex-wrap:wrap;gap:8px"><button class="btn" style="flex:1" data-t="rmbg">✂️ ลบพื้นหลัง</button><button class="btn alt" style="flex:1" data-t="2">🔍 ขยาย x2</button><button class="btn alt" style="flex:1" data-t="4">🔍 ขยาย x4</button></div>
    <div id="itBox" style="margin-top:12px"></div><div id="itOut"></div></div>`;
  const prev = () => { if (imgSrc) root.querySelector('#itPrev').innerHTML = `<img src="${URL.createObjectURL(imgSrc)}" style="width:100%;max-height:300px;object-fit:contain;border-radius:14px;background:#111">`; };
  prev();
  root.querySelector('#itIn').onchange = e => { const f = e.target.files[0]; if (f){ imgSrc = f; prev(); } };
  root.querySelector('#itLast').onclick = async () => { const h = (await GM.db.all('history')).filter(x => x.kind === 'image' && x.blob).sort((a, b) => b.created - a.created)[0]; if (!h) return toast('ยังไม่มีภาพในคลังงาน'); imgSrc = h.blob; prev(); };
  root.querySelectorAll('[data-t]').forEach(b => b.onclick = () => runImgTool(b.dataset.t));
}
async function runImgTool(t){
  const box = $('#itBox'); if (needMac(box)) return;
  if (!imgSrc) return toast('เลือกภาพก่อนนะ');
  box.innerHTML = `<div class="prog2"><i style="width:10%"></i></div><p class="hint" id="itMsg">ส่งภาพไป Mac…</p>`; $('#itOut').innerHTML = '';
  try {
    const fd = new FormData(); fd.append('image', imgSrc, imgSrc.name || 'image.png'); if (t !== 'rmbg') fd.append('scale', t);
    const t0 = performance.now();
    const r = await macJob(t === 'rmbg' ? '/api/rmbg' : '/api/upscale_img', fd, j => { const m = $('#itMsg'); if (m) m.textContent = tickText(j); });
    const blob = await r.blob(), f = new File([blob], `genmedi-${t === 'rmbg' ? 'nobg' : 'x' + t}-${stamp()}.png`, { type: 'image/png' });
    const bm = await createImageBitmap(blob).catch(() => null);
    box.innerHTML = `<p class="hint">เสร็จใน ${fmt((performance.now() - t0) / 1000)}${bm ? ` · ${bm.width}×${bm.height}px` : ''}</p>`;
    $('#itOut').innerHTML = `<div class="checker"><img src="${URL.createObjectURL(blob)}" style="width:100%;max-height:420px;object-fit:contain;display:block"></div>
      <div class="row2" style="margin-top:10px;gap:8px"><button class="btn" style="flex:1" data-r="dl">⬇️ บันทึก PNG</button><button class="btn alt" style="flex:1" data-r="sh">📤 แชร์</button><button class="btn alt" style="flex:1" data-r="again">↻ ใช้ต่อ</button></div>`;
    addHistory({ kind: 'image', prompt: t === 'rmbg' ? 'ลบพื้นหลัง' : 'ขยายภาพ x' + t, blob: f, lk: 'user' });
    saveToMac(f, 'images', t === 'rmbg' ? 'nobg' : 'upscale');
    $('#itOut').querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      if (b.dataset.r === 'dl') saveBlob(f, f.name);
      if (b.dataset.r === 'sh') shareFiles([f], 'Gen Medi').catch(() => {});
      if (b.dataset.r === 'again'){ imgSrc = f; renderImgTools(); }
    });
  } catch(e){ box.innerHTML = `<p class="lim">${esc(e.message)}</p>`; }
}

/* ========== 🧾 job queue on the Mac ========== */
const KIND = { video: '🎥 วิดีโอ', llm: '✍️ เขียนบท', transcribe: '📝 ถอดเสียง', rmbg: '✂️ ลบพื้นหลัง', upscale: '🔍 ขยายภาพ' };
let jobsT = 0;
async function renderJobs(){
  const root = $('#jobsRoot'); if (!root) return;
  clearTimeout(jobsT);
  if (!GM.MAC.on){ root.innerHTML = '<div class="card"><div id="jbx"></div></div>'; needMac(root.querySelector('#jbx')); return; }
  let list = [];
  try { list = await (await GM.MAC.call('/api/jobs', {}, 15000)).json(); } catch(e){ root.innerHTML = `<div class="card"><p class="lim">${esc(e.message)}</p></div>`; return; }
  root.innerHTML = `<div class="card"><div class="card-h"><h2>🧾 คิวงานบน Mac</h2><button class="ghost" id="jbR">↻</button></div>
    <p class="hint" style="margin-top:0">สั่งงานไว้หลายอย่างได้ Mac จะทำต่อกันไปเองตามลำดับ · เปิดหน้านี้ทีหลังเพื่อดาวน์โหลดผลงาน</p>
    ${list.length ? list.map(j => `<div class="item jrow"><div style="flex:1;min-width:0"><b>${KIND[j.kind] || j.kind}</b><small style="display:block;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(j.prompt || '')}</small>
      <small style="display:block">${j.state === 'done' ? '✅ เสร็จแล้ว' : j.state === 'error' ? '⚠️ ' + esc(j.msg || '') : j.state === 'queued' ? `⏳ รอคิวที่ ${j.pos}` : '⚙️ ' + esc(j.msg || '') + (j.total ? ` · ${j.step || 0}/${j.total}` : '') + (j.eta ? ` · เหลือ ~${fmt(j.eta)}` : '')}</small></div>
      ${j.state === 'done' && ['video', 'rmbg', 'upscale'].includes(j.kind) ? `<button class="btn sm" data-get="${j.id}" data-kind="${j.kind}">⬇️</button>` : ''}
      ${['queued', 'loading', 'running'].includes(j.state) ? `<button class="btn sm alt" data-cx="${j.id}">ยกเลิก</button>` : ''}</div>`).join('') : '<p class="hint">ยังไม่มีงาน</p>'}</div>`;
  root.querySelector('#jbR').onclick = renderJobs;
  root.querySelectorAll('[data-cx]').forEach(b => b.onclick = async () => { await GM.MAC.json('/api/jobs/' + b.dataset.cx + '/cancel'); renderJobs(); });
  root.querySelectorAll('[data-get]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = '…';
    try { const blob = await (await GM.MAC.call('/api/jobs/' + b.dataset.get + '/result', {}, 300000)).blob(); const ext = b.dataset.kind === 'video' ? 'mp4' : 'png'; const f = new File([blob], `genmedi-${b.dataset.kind}-${stamp()}.${ext}`, { type: blob.type }); addHistory({ kind: ext === 'mp4' ? 'video' : 'image', text: 'จากคิวงาน', prompt: 'จากคิวงาน', blob: f, lk: ext === 'mp4' ? 'video-mac' : 'user' }); saveBlob(f, f.name); }
    catch(e){ toast(e.message, true); }
    b.disabled = false; b.textContent = '⬇️';
  });
  if (list.some(j => ['queued', 'loading', 'running'].includes(j.state)) && document.querySelector('.page[data-page="jobs"].on')) jobsT = setTimeout(renderJobs, 5000);
}

/* render when a page opens */
function onPage(p){
  p = p || document.querySelector('.page.on')?.dataset.page;
  if (p === 'writer') renderWriter(); if (p === 'stt') renderStt(); if (p === 'imgtools') renderImgTools(); if (p === 'jobs') renderJobs();
}
window.addEventListener('gm:page', e => onPage(e.detail));
renderWriter(); renderStt(); renderImgTools(); onPage();
window.GMTools = { macJob, renderWriter, renderStt, renderImgTools, renderJobs };
