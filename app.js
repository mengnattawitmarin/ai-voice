/* AI Voice Studio — Text to Speech · Voice Clone · Text to Image
   Runs fully in the browser. Free services used:
   - Device voices: Web Speech API (offline, free)
   - AI voices + images: Pollinations (gen.pollinations.ai / image.pollinations.ai)
   - Voice cloning: a Hugging Face Space running F5-TTS, via @gradio/client
*/
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d){ try{ const v = localStorage.getItem('av.'+k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('av.'+k, JSON.stringify(v)); }catch(e){} }
};

/* ---------------- IndexedDB (clones + history) ---------------- */
const db = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('ai-voice', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('clones', {keyPath:'id'}); d.createObjectStore('history', {keyPath:'id'}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); }); };
  return {
    all: s => run(s, 'readonly', st => st.getAll()).catch(() => []),
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    clear: s => run(s, 'readwrite', st => st.clear()),
  };
})();

/* ---------------- settings ---------------- */
const S = Object.assign({
  polKey:'', hfToken:'', space:'pythonlearnreal/F5-TTS-THAI',
  lang:'th', tone:1, style:'natural', rate:1, vol:1, voice:null,
  imgStyle:'none', imgRatio:'1:1', imgCount:2, imgEnhance:true,
}, LS.get('settings', {}));
const save = () => LS.set('settings', S);

const LANGS = [
  ['th','ไทย','th-TH','สวัสดีค่ะ นี่คือตัวอย่างเสียงที่จะอ่านข้อความของคุณ'],
  ['en','English','en-US','Hello! This is a preview of the voice that will read your text.'],
  ['ja','日本語','ja-JP','こんにちは。これは音声のサンプルです。'],
  ['zh','中文','zh-CN','你好，这是语音示例。'],
  ['ko','한국어','ko-KR','안녕하세요. 음성 샘플입니다.'],
  ['vi','Tiếng Việt','vi-VN','Xin chào, đây là giọng đọc mẫu.'],
  ['id','Bahasa Indonesia','id-ID','Halo, ini contoh suara.'],
  ['lo','ລາວ','lo-LA','ສະບາຍດີ ນີ້ແມ່ນສຽງຕົວຢ່າງ'],
  ['km','ខ្មែរ','km-KH','សួស្តី នេះជាសំឡេងគំរូ'],
  ['my','မြန်မာ','my-MM','မင်္ဂလာပါ'],
  ['fr','Français','fr-FR','Bonjour, ceci est un exemple de voix.'],
  ['de','Deutsch','de-DE','Hallo, das ist eine Stimmprobe.'],
  ['es','Español','es-ES','Hola, esta es una muestra de voz.'],
];
const lang = () => LANGS.find(l => l[0] === S.lang) || LANGS[0];
const TONES = [['ต่ำ',0.75],['ค่อนข้างต่ำ',0.88],['ปกติ',1],['ค่อนข้างสูง',1.15],['สูง',1.3]];
const STYLES = {
  natural:{n:'ธรรมชาติ', d:'จังหวะปกติ ฟังสบาย', mul:1, gap:0},
  news:{n:'อ่านข่าว', d:'กระชับ หนักแน่น', mul:1.08, gap:120},
  story:{n:'เล่านิทาน', d:'ช้าลงเล็กน้อย เว้นจังหวะ', mul:0.92, gap:450},
  clear:{n:'ช้าชัดเจน', d:'เหมาะกับผู้สูงอายุ/ฝึกภาษา', mul:0.8, gap:300},
  fast:{n:'ฟังเร็ว', d:'สรุปไว ประหยัดเวลา', mul:1.35, gap:0},
};
const AI_VOICES = [
  ['nova','เสียงผู้หญิง (คุณภาพสูง)','เป็นธรรมชาติ ฟังสบาย ชัดเจน'],
  ['shimmer','เสียงผู้หญิง นุ่มนวล','อ่อนโยน เหมาะเล่าเรื่อง'],
  ['alloy','เสียงกลาง ๆ','สุภาพ เป็นกลาง'],
  ['echo','เสียงผู้ชาย','นุ่ม อบอุ่น'],
  ['onyx','เสียงผู้ชาย ทุ้ม','หนักแน่น เหมาะอ่านข่าว'],
  ['fable','เสียงนักเล่าเรื่อง','มีสีสัน สำเนียงอังกฤษ'],
];
const LOCAL_VOICES = [
  ['Tanotfin/mms-thai-female-podcast-spk0-stable2-onnx','เสียงผู้หญิงไทย (พอดแคสต์)','th'],
  ['Tanotfin/mms-tts-2081-M-stable-onnx','เสียงไทย MMS (แบบ M)','th'],
  ['Tanotfin/mms-tts-2081-FM-stable-onnx','เสียงไทย MMS (แบบ FM)','th'],
  ['Xenova/mms-tts-eng','English voice (MMS)','en'],
];
const SPACES = [
  ['pythonlearnreal/F5-TTS-THAI','F5-TTS ภาษาไทย','เหมาะกับภาษาไทย'],
  ['mrfakename/E2-F5-TTS','F5-TTS (อังกฤษ/จีน)','Space ต้นฉบับ'],
];
const effRate = () => Math.min(3, Math.max(0.3, S.rate * (STYLES[S.style]||STYLES.natural).mul));

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, err){ const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), err ? 5200 : 2800); }
function status(msg){ $('#status').innerHTML = msg || ''; }
const scrim = $('#scrim'), drawer = $('#drawer'), sheet = $('#sheet');
function closeAll(){ drawer.classList.remove('on'); sheet.classList.remove('on'); scrim.classList.remove('on'); }
scrim.onclick = closeAll;
function openSheet(html, after){
  drawer.classList.remove('on');
  $('#sheetBody').innerHTML = html; sheet.scrollTop = 0;
  sheet.classList.add('on'); scrim.classList.add('on');
  $$('#sheetBody [data-close]').forEach(b => b.onclick = closeAll);
  after && after($('#sheetBody'));
}
const sheetHead = t => `<h3>${t}<button data-close aria-label="ปิด"><svg class="i"><use href="#i-x"/></svg></button></h3>`;
function optionSheet(title, opts, cur, pick){
  openSheet(sheetHead(title) + opts.map((o,i) => `<button class="opt ${o.v===cur?'on':''}" data-i="${i}"><span class="dot"></span><span class="t"><b>${esc(o.n)}</b>${o.d?`<small>${esc(o.d)}</small>`:''}</span></button>`).join(''),
    el => el.querySelectorAll('.opt').forEach(b => b.onclick = () => { pick(opts[+b.dataset.i].v); closeAll(); }));
}
function setRangeFill(r){ const p = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty('--p', p + '%'); }
function saveBlob(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function loadScript(src){ return new Promise((res, rej) => { if ($$('script').some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('โหลดไลบรารีไม่สำเร็จ (ต้องต่ออินเทอร์เน็ต)')); document.head.appendChild(s); }); }
const stamp = () => new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');

/* ---------------- header wave ---------------- */
const wave = (() => {
  const c = $('#wave'), g = c.getContext('2d'); let t = 0, active = false;
  function draw(){
    const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
    if (c.width !== w*dpr){ c.width = w*dpr; c.height = h*dpr; }
    g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
    const cols = Math.floor(w / 5);
    for (let i = 0; i < cols; i++){
      const x = i * 5 + 2, f = i / cols;
      const env = Math.sin(f * Math.PI) ** 1.4;
      const amp = env * (0.35 + 0.65 * Math.abs(Math.sin(i*0.37 + t) * Math.cos(i*0.11 - t*0.7))) * (active ? 1 : 0.6);
      const n = Math.max(1, Math.round(amp * 8));
      const col = `hsl(${200 + f*110},90%,${62 + f*6}%)`;
      g.fillStyle = col;
      for (let k = -n; k <= n; k++){ g.globalAlpha = 1 - Math.abs(k)/(n+1) * 0.7; g.fillRect(x, h/2 + k*2.6, 1.6, 1.6); }
    }
    g.globalAlpha = 1; t += active ? 0.08 : 0.015;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return { set: v => active = v };
})();

/* ---------------- pages & drawer ---------------- */
const PAGES = {
  tts:['Text to Speech','เปลี่ยนข้อความเป็นเสียงพูดคุณภาพสูง'],
  clone:['Voice Clone','สร้างเสียงพูดจากเสียงตัวอย่าง'],
  image:['Text to Image','เปลี่ยนคำบรรยายเป็นภาพด้วย AI ฟรี'],
};
function go(p){
  $$('.page').forEach(s => s.classList.toggle('on', s.dataset.page === p));
  $$('.nav[data-go]').forEach(n => n.classList.toggle('on', n.dataset.go === p));
  $('#pageTitle').textContent = PAGES[p][0]; $('#pageSub').textContent = PAGES[p][1];
  $('#dock').hidden = p !== 'tts'; $('#app').classList.toggle('no-dock', p !== 'tts');
  if (p === 'clone') renderClones();
  closeAll(); scrollTo(0,0);
  if (location.hash.slice(1) !== p) history.replaceState(null, '', p === 'tts' ? location.pathname : '#' + p);
}
$('#btnMenu').onclick = () => { drawer.classList.add('on'); scrim.classList.add('on'); };
$$('.nav[data-go]').forEach(n => n.onclick = () => go(n.dataset.go));
$$('.nav[data-act]').forEach(n => n.onclick = () => ({history:openHistory, settings:openSettings, install:openInstall, about:openAbout})[n.dataset.act]());
$('#btnAvatar').onclick = () => openSettings();
$('#btnPro').onclick = () => openSettings(true);

/* ---------------- source tabs ---------------- */
const ta = $('#text');
const TABT = {text:'พิมพ์ข้อความของคุณ', file:'นำเข้าจากไฟล์', link:'ดึงข้อความจากเว็บไซต์'};
function setTab(t){
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#paneText').hidden = t !== 'text'; $('#paneFile').hidden = t !== 'file'; $('#paneLink').hidden = t !== 'link';
  $('#srcTitle').textContent = TABT[t];
}
$$('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));

ta.value = LS.get('draft', '');
function onText(){
  const n = ta.value.length, mins = n / (800 * effRate());
  $('#count').textContent = n.toLocaleString('th-TH') + ' ตัวอักษร' + (n ? ` · ~${mins < 1 ? '<1' : Math.round(mins)} นาที` : '');
  LS.set('draft', ta.value);
}
ta.addEventListener('input', () => { onText(); if (P.state !== 'idle') stopAll(); });
$('#btnClear').onclick = () => { stopAll(); ta.value = ''; onText(); setTab('text'); ta.focus(); };
$('#btnExpand').onclick = () => { const e = $('#editor'); e.classList.toggle('full'); if (e.classList.contains('full')) ta.focus(); };

function putText(t, from){
  t = t.replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if (!t) { toast('ไม่พบข้อความ', true); return; }
  stopAll(); ta.value = t; onText(); setTab('text');
  toast(`นำเข้า${from} ${t.length.toLocaleString('th-TH')} ตัวอักษรแล้ว กดเริ่มเล่นได้เลย`);
}

/* dictation */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let dict = null;
$('#btnDictate').onclick = () => {
  if (!SR) return toast('เบราว์เซอร์นี้ไม่รองรับการพูดเพื่อพิมพ์ ลองใช้ Chrome หรือ Safari รุ่นใหม่', true);
  if (dict) { dict.stop(); return; }
  stopAll();
  dict = new SR(); dict.lang = lang()[2]; dict.continuous = true; dict.interimResults = true;
  const base = ta.value; let fin = '';
  dict.onresult = e => {
    let inter = '';
    for (let i = e.resultIndex; i < e.results.length; i++){ const r = e.results[i]; if (r.isFinal) fin += r[0].transcript + ' '; else inter += r[0].transcript; }
    ta.value = base + (base && !/\s$/.test(base) ? ' ' : '') + fin + inter; onText();
  };
  dict.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('พูดเพื่อพิมพ์ใช้ไม่ได้: ' + e.error, true); };
  dict.onend = () => { dict = null; $('#btnDictate').classList.remove('live'); };
  try { dict.start(); $('#btnDictate').classList.add('live'); toast('เริ่มฟังแล้ว พูดได้เลย — แตะไมค์อีกครั้งเพื่อหยุด'); } catch(e){ dict = null; }
};

/* file import */
const fileIn = $('#fileIn'), drop = $('#drop');
fileIn.onchange = () => fileIn.files[0] && importFile(fileIn.files[0]);
drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#818cf8'; });
drop.addEventListener('dragleave', () => drop.style.borderColor = '');
drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; e.dataTransfer.files[0] && importFile(e.dataTransfer.files[0]); });
async function importFile(f){
  const hint = m => $('#fileHint').innerHTML = m;
  const name = f.name.toLowerCase();
  hint('กำลังอ่านไฟล์ “' + esc(f.name) + '”…');
  try {
    let text = '';
    if (name.endsWith('.pdf') || f.type === 'application/pdf'){
      const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
      const doc = await pdfjs.getDocument({data: await f.arrayBuffer()}).promise;
      for (let i = 1; i <= doc.numPages; i++){
        hint(`กำลังอ่าน PDF หน้า ${i}/${doc.numPages}`);
        const tc = await (await doc.getPage(i)).getTextContent();
        text += tc.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n\n';
      }
      if (!text.trim()) throw new Error('PDF นี้เป็นภาพสแกน ไม่มีตัวหนังสือ — ลองแคปหน้าจอแล้วนำเข้าเป็นรูปแทน');
    } else if (name.endsWith('.docx')){
      await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js');
      text = (await window.mammoth.extractRawText({arrayBuffer: await f.arrayBuffer()})).value;
    } else if (f.type.startsWith('image/')){
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
      hint('กำลังโหลดโมเดลอ่านตัวหนังสือ (ครั้งแรกใช้เวลาสักครู่)…');
      const r = await window.Tesseract.recognize(f, 'tha+eng', { logger: m => { if (m.status === 'recognizing text') hint(`กำลังอ่านตัวหนังสือจากรูป ${Math.round(m.progress*100)}%`); } });
      text = r.data.text.replace(/([฀-๿]) (?=[฀-๿])/g, '$1');
    } else if (name.endsWith('.srt') || name.endsWith('.vtt')){
      text = (await f.text()).replace(/^WEBVTT.*$/m,'').replace(/^\d+\s*$/gm,'').replace(/^[\d:.,]+\s*-->.*$/gm,'').replace(/<[^>]+>/g,'');
    } else {
      text = await f.text();
    }
    hint(''); putText(text, 'จากไฟล์');
  } catch(e){ hint('<span style="color:var(--err)">อ่านไฟล์ไม่สำเร็จ: ' + esc(e.message || e) + '</span>'); }
  fileIn.value = '';
}

/* link import */
$('#btnFetch').onclick = async () => {
  let u = $('#urlIn').value.trim(); if (!u) return toast('วางลิงก์ก่อนนะ');
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  const b = $('#btnFetch'); b.disabled = true; b.textContent = 'กำลังดึง…';
  try {
    const r = await fetch('https://r.jina.ai/' + u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let t = await r.text();
    const i = t.indexOf('Markdown Content:'); if (i >= 0) t = t.slice(i + 17);
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^#{1,6}\s*/gm,'').replace(/[*_`>|]+/g,'').replace(/^[-=]{3,}$/gm,'').replace(/^\s*[-+]\s+/gm,'• ');
    putText(t, 'จากเว็บ');
  } catch(e){ toast('ดึงข้อความไม่ได้ (' + (e.message||e) + ') — บางเว็บกันการดึง ลองคัดลอกข้อความมาวางแทน', true); }
  b.disabled = false; b.textContent = 'ดึงข้อความ';
};

/* ---------------- voices ---------------- */
const synth = window.speechSynthesis;
let devVoices = [], clones = [];
function loadDevVoices(){ if (synth) { devVoices = synth.getVoices(); renderVoice(); } }
if (synth){ loadDevVoices(); synth.onvoiceschanged = loadDevVoices; }
db.all('clones').then(c => { clones = c.sort((a,b) => b.created - a.created); renderVoice(); });

function devForLang(){ return devVoices.filter(v => v.lang.toLowerCase().replace('_','-').startsWith(S.lang)); }
function curVoice(){
  const v = S.voice;
  if (v?.type === 'ai'){ const a = AI_VOICES.find(x => x[0] === v.id) || AI_VOICES[0]; return {type:'ai', id:a[0], name:a[1], desc:a[2] + ' · เสียง AI ดาวน์โหลดได้'}; }
  if (v?.type === 'local'){ const l = LOCAL_VOICES.find(x => x[0] === v.id) || LOCAL_VOICES[0]; return {type:'local', id:l[0], name:l[1], desc:'เสียง AI ฟรี ประมวลผลในเครื่อง · ดาวน์โหลดได้'}; }
  if (v?.type === 'clone'){ const c = clones.find(x => x.id === v.id); if (c) return {type:'clone', id:c.id, name:c.name, desc:'เสียงโคลน · ' + (c.tested ? 'ทดสอบแล้ว' : 'ยังไม่ได้ทดสอบ'), rec:c}; }
  const list = devForLang();
  let d = (v?.type === 'device' && devVoices.find(x => x.voiceURI === v.id)) || null;
  if (!d || !d.lang.toLowerCase().startsWith(S.lang)) d = list.find(x => /premium|enhanced|natural|neural/i.test(x.name)) || list[0] || null;
  if (!d && !v){ const l = LOCAL_VOICES.find(x => x[2] === S.lang); if (l) return {type:'local', id:l[0], name:l[1], desc:'เสียง AI ฟรี ประมวลผลในเครื่อง · ดาวน์โหลดได้'}; }
  if (!d) return {type:'device', id:null, name:'เสียงในเครื่อง', desc:devVoices.length ? `ไม่มีเสียง${lang()[1]}ในเครื่อง — ลองเสียง AI` : 'กำลังโหลดเสียง…'};
  return {type:'device', id:d.voiceURI, obj:d, name:prettyDev(d), desc:'เสียงในเครื่อง · ฟรี ใช้ออฟไลน์ได้'};
}
function prettyDev(d){ return d.name.replace(/\s*\((?:Thai|Thailand)[^)]*\)/i,'').replace(/Microsoft |Google /,'') + ` (${d.lang})`; }
function renderVoice(){
  const v = curVoice(); $('#vName').textContent = v.name; $('#vDesc').textContent = v.desc;
  $('#fLangV').textContent = lang()[1];
  $('#fToneV').textContent = (TONES.find(t => t[1] === S.tone) || TONES[2])[0];
  $('#fStyleV').textContent = (STYLES[S.style]||STYLES.natural).n;
  $('#dkSave').style.opacity = v.type === 'device' ? .55 : 1;
}
$('#btnVoice').onclick = () => {
  const v = curVoice(); const keyOk = !!S.polKey;
  const list = devForLang();
  const row = (k, n, d, on) => `<button class="opt ${on?'on':''}" data-k="${esc(k)}"><span class="dot"></span><span class="t"><b>${n}</b><small>${d}</small></span></button>`;
  let h = sheetHead('เลือกเสียง');
  const locs = LOCAL_VOICES.filter(l => l[2] === S.lang);
  if (locs.length){
    h += `<h4>เสียง AI ฟรี ไม่ต้องใช้คีย์ <span class="tag ok">แนะนำ</span></h4>`;
    h += locs.map(l => row('local:'+l[0], esc(l[1]), 'ประมวลผลในมือถือ · โหลดโมเดลครั้งแรก ~110MB · ดาวน์โหลดไฟล์ได้', v.type==='local' && v.id===l[0])).join('');
  }
  h += `<h4>เสียง AI คุณภาพสูง ${keyOk ? '<span class="tag ok">พร้อมใช้</span>' : '<span class="tag warn">ต้องมีคีย์ + Pollen</span>'}</h4>`;
  h += AI_VOICES.map(a => row('ai:'+a[0], esc(a[1]) + ` <span class="tag">${a[0]}</span>`, esc(a[2]) + ' · ดาวน์โหลด MP3 ได้', v.type==='ai' && v.id===a[0])).join('');
  if (!keyOk) h += `<p class="hint">เสียง AI ใช้ Pollinations — <a href="#" data-set>ใส่คีย์ฟรีในตั้งค่า</a> (สมัครฟรี) อ่านภาษาไทยได้แต่สำเนียงอาจยังไม่เป๊ะ</p>`;
  h += `<h4>เสียงที่โคลนไว้</h4>`;
  h += clones.length ? clones.map(c => row('clone:'+c.id, esc(c.name), 'เสียงโคลน · F5-TTS', v.type==='clone' && v.id===c.id)).join('') : '';
  h += `<button class="opt" data-gclone><span class="dot"></span><span class="t"><b>＋ โคลนเสียงใหม่</b><small>อัดเสียงตัวเอง 10 วินาที</small></span></button>`;
  h += `<h4>เสียงในเครื่อง (${esc(lang()[1])}) · ฟรี ออฟไลน์</h4>`;
  h += list.length ? list.map(d => row('device:'+d.voiceURI, esc(prettyDev(d)), d.localService ? 'อยู่ในเครื่อง' : 'ออนไลน์', v.type==='device' && v.id===d.voiceURI)).join('')
    : `<p class="hint">ไม่มีเสียง${esc(lang()[1])}ในเครื่องนี้ — iPhone: ตั้งค่า › การช่วยการเข้าถึง › เนื้อหาที่พูด › เสียง / Android: ตั้งค่า › การแปลงข้อความเป็นเสียง</p>`;
  openSheet(h, el => {
    el.querySelectorAll('.opt[data-k]').forEach(b => b.onclick = () => {
      const [type, ...rest] = b.dataset.k.split(':'); S.voice = {type, id: rest.join(':')}; save(); stopAll(); renderVoice(); closeAll();
      if (type === 'ai' && !S.polKey) toast('อย่าลืมใส่คีย์ Pollinations ในตั้งค่า ถ้าเล่นไม่ได้');
    });
    el.querySelector('[data-gclone]').onclick = () => go('clone');
    el.querySelector('[data-set]')?.addEventListener('click', e => { e.preventDefault(); openSettings(true); });
  });
};
$('#btnPreview').onclick = async () => {
  stopAll(); const v = curVoice(), sample = lang()[3];
  if (v.type === 'device'){
    if (!v.obj) return toast('ไม่มีเสียงในเครื่องสำหรับภาษานี้', true);
    const u = new SpeechSynthesisUtterance(sample); u.voice = v.obj; u.lang = v.obj.lang; u.rate = effRate(); u.pitch = S.tone; u.volume = Math.min(1, S.vol);
    synth.cancel(); synth.speak(u); return;
  }
  const b = $('#btnPreview'); b.disabled = true; toast('กำลังสร้างตัวอย่างเสียง…');
  try { const blob = await synthesize(v, sample); playOnce(blob); } catch(e){ toast(e.message, true); }
  b.disabled = false;
};
function playOnce(blob){ const a = P.audio; a.src = URL.createObjectURL(blob); a.playbackRate = effRate(); ensureGain(); a.onended = null; a.play().catch(()=>{}); }

/* sliders & feature sheets */
const rate = $('#rate'), vol = $('#vol');
rate.value = S.rate; vol.value = S.vol;
function syncSliders(){ $('#rateV').textContent = (+rate.value).toFixed(1) + 'x'; $('#volV').textContent = (+vol.value).toFixed(1); setRangeFill(rate); setRangeFill(vol); }
syncSliders();
rate.oninput = () => { S.rate = +rate.value; syncSliders(); onText(); if (P.audio && P.kind === 'remote') P.audio.playbackRate = effRate(); };
vol.oninput = () => { S.vol = +vol.value; syncSliders(); if (P.gain) P.gain.gain.value = S.vol; else P.audio.volume = Math.min(1, S.vol); };
rate.onchange = vol.onchange = () => { save(); if (P.state === 'playing' && P.kind === 'device') speakDevice(); };

$('#fLang').onclick = () => optionSheet('ภาษา', LANGS.map(l => ({v:l[0], n:l[1], d:`${devVoices.filter(v=>v.lang.toLowerCase().startsWith(l[0])).length} เสียงในเครื่อง`})), S.lang,
  v => { S.lang = v; if (S.voice?.type === 'device') S.voice = null; save(); stopAll(); renderVoice(); });
$('#fTone').onclick = () => optionSheet('โทนเสียง', TONES.map(t => ({v:t[1], n:t[0], d:'ใช้กับเสียงในเครื่อง (เสียง AI/โคลนปรับโทนไม่ได้)'})), S.tone,
  v => { S.tone = v; save(); renderVoice(); if (P.state === 'playing' && P.kind === 'device') speakDevice(); });
$('#fStyle').onclick = () => optionSheet('รูปแบบเสียง', Object.entries(STYLES).map(([k,s]) => ({v:k, n:s.n, d:s.d})), S.style,
  v => { S.style = v; save(); renderVoice(); onText(); });
$('#fAdv').onclick = () => openSettings();

/* ---------------- chunking ---------------- */
function makeChunks(text, MAX){
  const out = [];
  text.replace(/\r/g,'').split(/\n+/).forEach(par => {
    par = par.trim(); if (!par) return;
    const parts = par.match(/[^.!?。？！…]+[.!?。？！…]*\s*/g) || [par];
    let buf = '';
    const push = s => { s = s.trim(); if (s) out.push(s); };
    parts.forEach(p => {
      if (p.length > MAX){
        p.split(/(\s+)/).forEach(w => {
          if ((buf + w).length > MAX){ push(buf); buf = ''; }
          while (w.length > MAX){ push(w.slice(0, MAX)); w = w.slice(MAX); }
          buf += w;
        });
      } else if ((buf + p).length > MAX){ push(buf); buf = p; }
      else buf += p;
    });
    push(buf);
  });
  return out;
}

/* ---------------- player ---------------- */
const P = { state:'idle', kind:null, chunks:[], idx:0, token:0, blobs:[], pending:[], key:'', voice:null, audio:new Audio(), ctx:null, gain:null, resolveCur:null, lastFile:null, keep:null };
P.audio.preload = 'auto';
function ensureGain(){
  if (P.gain){ P.gain.gain.value = S.vol; if (P.ctx.state === 'suspended') P.ctx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext; P.ctx = new AC();
    const src = P.ctx.createMediaElementSource(P.audio); P.gain = P.ctx.createGain();
    src.connect(P.gain).connect(P.ctx.destination); P.gain.gain.value = S.vol;
  } catch(e){ P.audio.volume = Math.min(1, S.vol); }
}
const reader = $('#reader');
let spans = [];
function buildReader(){
  reader.innerHTML = ''; spans = P.chunks.map((c, i) => { const s = document.createElement('span'); s.textContent = c + ' '; s.onclick = () => jump(i); reader.appendChild(s); return s; });
}
function mark(){
  spans.forEach((s, i) => s.className = i < P.idx ? 'done' : i === P.idx ? 'now' : '');
  spans[P.idx]?.scrollIntoView({block:'nearest', behavior:'smooth'});
  $('#prog').style.width = (P.chunks.length ? P.idx / P.chunks.length * 100 : 0) + '%';
}
function ui(){
  const st = P.state;
  $('#ctaTxt').textContent = st === 'playing' ? 'หยุดชั่วคราว' : st === 'paused' ? 'เล่นต่อ' : 'เริ่มเล่นเสียง';
  $('#btnStart').classList.toggle('busy', st === 'playing');
  $('#dkPlayIc').innerHTML = `<use href="#i-${st === 'playing' ? 'pause' : 'play'}"/>`;
  $('#vic').classList.toggle('speaking', st === 'playing');
  $('#editor').classList.toggle('reading', st !== 'idle');
  wave.set(st === 'playing');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'none';
}
function prepare(v, text){
  const key = v.type + ':' + v.id + '|' + text;
  if (P.key !== key){
    const max = v.type === 'device' ? 180 : v.type === 'ai' ? 380 : v.type === 'local' ? 140 : 200;
    P.chunks = makeChunks(text, max); P.blobs = []; P.pending = []; P.key = key; P.lastFile = null;
  }
  P.voice = v;
}
function start(){
  const text = ta.value.trim();
  if (!text){ toast('ใส่ข้อความก่อนนะ'); setTab('text'); ta.focus(); return; }
  const v = curVoice();
  if (v.type === 'device' && !v.obj){ toast(v.desc, true); return; }
  if (dict) dict.stop();
  prepare(v, text); P.idx = 0; P.kind = v.type === 'device' ? 'device' : 'remote';
  buildReader(); P.state = 'playing'; ui();
  addHistory({kind:'tts', text: text.slice(0, 4000), voice: v.name});
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({title: text.slice(0, 60), artist: v.name, album: 'AI Voice'});
  P.kind === 'device' ? speakDevice() : playRemote();
}
function pause(){
  if (P.state !== 'playing') return;
  P.state = 'paused';
  if (P.kind === 'device'){ P.token++; synth.cancel(); } else P.audio.pause();
  ui(); status('หยุดชั่วคราว — กดเล่นต่อได้');
}
function resume(){
  if (P.state !== 'paused') return;
  P.state = 'playing'; ui();
  if (P.kind === 'device') speakDevice();
  else if (P.audio.src && !P.audio.ended && P.resolveCur) { ensureGain(); P.audio.play().catch(()=>{}); status(`กำลังเล่น ${P.idx+1}/${P.chunks.length}`); }
  else playRemote();
}
function stopAll(){
  P.token++; if (synth) synth.cancel(); P.audio.pause(); const r = P.resolveCur; P.resolveCur = null; r && r();
  clearInterval(P.keep); P.state = 'idle'; ui(); status(''); $('#prog').style.width = '0';
}
function finish(){
  clearInterval(P.keep); P.state = 'idle'; ui();
  $('#prog').style.width = '100%'; status('<b style="color:var(--ok)">อ่านจบแล้ว ✓</b>' + (P.kind === 'remote' ? ' — กด “บันทึกเสียง” เพื่อดาวน์โหลดไฟล์' : ''));
}
function jump(i){
  P.idx = i; if (P.state === 'idle') P.state = 'playing';
  P.state = 'playing'; ui();
  if (P.kind === 'device') speakDevice();
  else { P.token++; P.audio.pause(); const r = P.resolveCur; P.resolveCur = null; r && r(); playRemote(); }
}
$('#btnStart').onclick = $('#dkPlay').onclick = () => P.state === 'idle' ? start() : P.state === 'playing' ? pause() : resume();
$('#dkStop').onclick = () => { stopAll(); };
if ('mediaSession' in navigator){
  try { navigator.mediaSession.setActionHandler('play', resume); navigator.mediaSession.setActionHandler('pause', pause); navigator.mediaSession.setActionHandler('stop', stopAll); } catch(e){}
}

/* device voice (Web Speech) */
function speakDevice(){
  synth.cancel(); const my = ++P.token;
  if (P.idx >= P.chunks.length) return finish();
  const v = P.voice, u = new SpeechSynthesisUtterance(P.chunks[P.idx]);
  if (v.obj){ u.voice = v.obj; u.lang = v.obj.lang; } else u.lang = lang()[2];
  u.rate = effRate(); u.pitch = S.tone; u.volume = Math.min(1, S.vol);
  const next = () => { if (my !== P.token || P.state !== 'playing') return; P.idx++; const g = (STYLES[S.style]||STYLES.natural).gap; g ? setTimeout(() => my === P.token && speakDevice(), g) : speakDevice(); };
  u.onend = next;
  u.onerror = e => { if (my !== P.token || e.error === 'interrupted' || e.error === 'canceled') return; next(); };
  mark(); status(`กำลังอ่าน ${P.idx+1}/${P.chunks.length}`);
  setTimeout(() => { if (my === P.token) synth.speak(u); }, 60);
  clearInterval(P.keep);
  if (!/android|iphone|ipad/i.test(navigator.userAgent)) P.keep = setInterval(() => { if (P.state === 'playing' && synth.speaking){ synth.pause(); synth.resume(); } }, 10000);
}

/* remote voice (AI / clone) — generate chunk by chunk, prefetch next while playing */
function getChunk(i){
  if (i >= P.chunks.length) return Promise.resolve(null);
  if (P.blobs[i]) return Promise.resolve(P.blobs[i]);
  return P.pending[i] ||= synthesize(P.voice, P.chunks[i]).then(b => (P.blobs[i] = b)).catch(e => { P.pending[i] = null; throw e; });
}
async function playRemote(){
  const my = ++P.token, n = P.chunks.length;
  while (P.idx < n){
    if (my !== P.token) return;
    const i = P.idx; mark();
    status(P.blobs[i] ? `กำลังเล่น ${i+1}/${n}` : `<span class="spin" style="display:inline-block;width:14px;height:14px;border-width:2px;vertical-align:-2px;margin:0 6px 0 0"></span>กำลังสร้างเสียงช่วงที่ ${i+1}/${n}…`);
    let blob;
    try { blob = await getChunk(i); } catch(e){ if (my !== P.token) return; P.state = 'paused'; ui(); status(''); toast(e.message || String(e), true); return; }
    if (my !== P.token) return;
    status(`กำลังเล่น ${i+1}/${n}`);
    getChunk(i + 1).catch(() => {});
    await new Promise(res => {
      const a = P.audio; if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      a.src = URL.createObjectURL(blob); a.playbackRate = effRate(); a.preservesPitch = true;
      P.resolveCur = res; a.onended = () => { P.resolveCur = null; res(); }; a.onerror = () => { P.resolveCur = null; res(); };
      ensureGain();
      if (P.state === 'playing') a.play().catch(() => { P.state = 'paused'; ui(); status('แตะปุ่มเล่นเพื่อฟังต่อ'); });
    });
    if (my !== P.token) return;
    const g = (STYLES[S.style]||STYLES.natural).gap; if (g) await sleep(g);
    P.idx++;
  }
  if (my === P.token) finish();
}

/* ---------------- engines ---------------- */
async function synthesize(v, text){
  if (v.type === 'local') return localTTS(text, v.id);
  if (v.type === 'ai') return pollinationsTTS(text, v.id);
  if (v.type === 'clone') return cloneTTS(text, v.rec);
  throw new Error('เสียงในเครื่องสร้างไฟล์เสียงไม่ได้');
}
/* free on-device AI voice: MMS/VITS models via transformers.js in a Web Worker */
const TTS_WORKER = `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
env.allowLocalModels = false;
const pipes = {};
self.onmessage = async e => {
  const { id, model, text } = e.data;
  try {
    pipes[model] ||= pipeline('text-to-speech', model, { dtype: 'fp32', device: 'wasm',
      progress_callback: p => { if (p.status === 'progress' && /onnx/.test(p.file || '')) self.postMessage({ id, progress: p.progress }); } });
    const tts = await pipes[model];
    const out = await tts(text);
    self.postMessage({ id, audio: out.audio, rate: out.sampling_rate }, [out.audio.buffer]);
  } catch (err) { pipes[model] = null; self.postMessage({ id, error: String((err && err.message) || err) }); }
};`;
let ttsWorker = null, ttsSeq = 0; const ttsJobs = {};
function getWorker(){
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker(URL.createObjectURL(new Blob([TTS_WORKER], {type:'text/javascript'})), {type:'module'});
  ttsWorker.onmessage = e => {
    const d = e.data, job = ttsJobs[d.id]; if (!job) return;
    if (d.progress != null){ status(`กำลังดาวน์โหลดโมเดลเสียง ${Math.round(d.progress)}% — ครั้งแรกครั้งเดียว ใช้ Wi-Fi จะเร็วกว่า`); return; }
    delete ttsJobs[d.id];
    d.error ? job.rej(new Error('เสียง AI ในเครื่องล้มเหลว: ' + d.error)) : job.res(encodeWav([d.audio], d.rate));
  };
  ttsWorker.onerror = e => { Object.values(ttsJobs).forEach(j => j.rej(new Error('โหลดตัวประมวลผลเสียงไม่ได้ — ตรวจอินเทอร์เน็ต หรือเบราว์เซอร์อาจเก่าเกินไป (' + (e.message || 'worker error') + ')'))); for (const k in ttsJobs) delete ttsJobs[k]; ttsWorker = null; };
  return ttsWorker;
}
function localTTS(text, model){
  const clean = text.replace(/[“”"«»()[\]{}<>*_#~|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return Promise.resolve(encodeWav([new Float32Array(1600)], 16000));
  return new Promise((res, rej) => { const id = ++ttsSeq; ttsJobs[id] = {res, rej}; getWorker().postMessage({id, model, text: clean}); });
}

async function pollinationsTTS(text, voice){
  const k = S.polKey.trim();
  let r, detail = '';
  try {
    r = await fetch(`https://gen.pollinations.ai/audio/${encodeURIComponent(text)}?voice=${voice}` + (k ? `&key=${encodeURIComponent(k)}` : ''));
    if (!r.ok){
      detail = await r.text().catch(() => '');
      r = await fetch('https://gen.pollinations.ai/v1/audio/speech', {method:'POST', headers:{'Content-Type':'application/json', ...(k ? {Authorization:'Bearer ' + k} : {})}, body: JSON.stringify({model:'openai/tts-1', input:text, voice})});
    }
  } catch(e){ throw new Error('เชื่อมต่อบริการเสียง AI ไม่ได้ — ตรวจอินเทอร์เน็ต'); }
  if (!r.ok){
    detail = (await r.text().catch(() => '')) || detail;
    if (r.status === 401 || r.status === 403 || (!k && /key|auth/i.test(detail))) throw new Error(/pollen|balance|credit/i.test(detail) ? 'Pollen ในบัญชี Pollinations หมด — เลือก “เสียง AI ฟรี ไม่ต้องใช้คีย์” แทนได้เลย' : 'ต้องใส่คีย์ Pollinations ก่อน — หรือเลือก “เสียง AI ฟรี ไม่ต้องใช้คีย์” แทน');
    if (r.status === 402 || /pollen|balance|credit/i.test(detail)) throw new Error('Pollen ในบัญชี Pollinations หมด — เลือก “เสียง AI ฟรี ไม่ต้องใช้คีย์” แทนได้เลย');
    if (r.status === 429) throw new Error('เรียกถี่เกินไป รอสักครู่แล้วลองใหม่');
    throw new Error(`เสียง AI ล้มเหลว (${r.status}) ${detail.slice(0,120)}`);
  }
  const b = await r.blob();
  if (b.size < 800) throw new Error('ได้ไฟล์เสียงว่างเปล่า ลองใหม่อีกครั้ง');
  return b.type ? b : new Blob([b], {type:'audio/mpeg'});
}

/* voice cloning via Hugging Face Space (F5-TTS) */
let gradio = null, gClient = null, gSpace = '', gPlan = null;
const plabel = p => ((p.label || '') + ' ' + (p.parameter_name || '')).toLowerCase();
async function getClient(){
  const space = S.space.trim();
  if (gClient && gSpace === space + S.hfToken) return gClient;
  gradio ||= await import('https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js');
  try { gClient = await gradio.Client.connect(space, S.hfToken ? {hf_token: S.hfToken.trim()} : {}); }
  catch(e){ throw new Error(`เชื่อมต่อ Space “${space}” ไม่ได้ — อาจกำลังหลับ/ปิดอยู่ ลองใหม่ใน 1–2 นาที หรือเปลี่ยน Space ในตั้งค่า (${e.message || e})`); }
  gSpace = space + S.hfToken; gPlan = null; return gClient;
}
function planFromApi(api){
  let best = null, bs = -1e9;
  for (const [name, ep] of Object.entries(api.named_endpoints || {})){
    const ps = ep.parameters || [];
    const au = ps.filter(p => /audio|file/i.test(p.component || ''));
    const tx = ps.filter(p => /textbox/i.test(p.component || ''));
    const ra = (ep.returns || []).some(r => /audio/i.test(r.component || ''));
    if (au.length !== 1 || !tx.length || !ra) continue;
    let s = 0;
    if (/tts|infer|synth|generat|clone|predict/i.test(name)) s += 3;
    if (/basic/i.test(name)) s += 2;
    if (/multi|podcast|chat|style|emotion|switch|load|update|transcri|speech_type|add/i.test(name)) s -= 6;
    s -= ps.length * 0.1;
    if (s > bs){ bs = s; best = {name, ps}; }
  }
  if (!best) return null;
  const texts = best.ps.filter(p => /textbox/i.test(p.component));
  let ref = texts.find(p => /ref|reference|prompt.?text|ต้นแบบ|อ้างอิง|transcri/.test(plabel(p)));
  let gen = texts.find(p => p !== ref && /gen|generat|target|synth|text to|ข้อความ|input|^text/.test(plabel(p)));
  if (!gen) gen = texts.find(p => p !== ref) || texts[0];
  if (!ref && texts.length > 1) ref = texts.find(p => p !== gen);
  return {name: best.name, ps: best.ps, ref, gen};
}
async function cloneTTS(text, rec){
  if (!rec) throw new Error('ไม่พบเสียงโคลนนี้แล้ว');
  const c = await getClient();
  if (!gPlan){ gPlan = planFromApi(await c.view_api()); if (!gPlan) throw new Error('Space นี้ไม่มีช่อง “เสียงต้นแบบ + ข้อความ → เสียง” ให้เรียกใช้'); }
  const args = gPlan.ps.map(p => {
    if (/audio|file/i.test(p.component)) return gradio.handle_file(rec.blob);
    if (p === gPlan.gen) return text;
    if (p === gPlan.ref) return rec.refText || '';
    if (/speed/.test(plabel(p)) && /slider|number/i.test(p.component)) return 1;
    if (p.parameter_has_default) return p.parameter_default;
    if (p.example_input !== undefined) return p.example_input;
    if (/checkbox/i.test(p.component)) return false;
    return null;
  });
  let res;
  try { res = await c.predict(gPlan.name, args); }
  catch(e){
    const m = String(e?.message || e?.title || JSON.stringify(e));
    if (/quota|ZeroGPU|GPU/i.test(m)) throw new Error('โควตา GPU ฟรีของ Hugging Face หมดชั่วคราว — รอสักพัก หรือใส่ HF token ในตั้งค่าเพื่อได้โควตาเพิ่ม');
    throw new Error('โคลนเสียงล้มเหลว: ' + m.slice(0, 160));
  }
  const out = (res.data || []).find(x => x && (typeof x === 'string' || x.url || x.path));
  const url = typeof out === 'string' ? out : (out?.url || (out?.path && `${c.config?.root || ''}/file=${out.path}`));
  if (!url) throw new Error('Space ไม่ได้ส่งไฟล์เสียงกลับมา');
  const r = await fetch(url, S.hfToken ? {headers:{Authorization:'Bearer ' + S.hfToken.trim()}} : {});
  if (!r.ok) throw new Error('ดาวน์โหลดเสียงจาก Space ไม่ได้ (' + r.status + ')');
  return r.blob();
}

/* ---------------- audio utils ---------------- */
async function decode(blob){
  const ab = await blob.arrayBuffer();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, 44100);
  return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); p && p.catch && p.catch(rej); });
}
function encodeWav(chans, rate){
  const len = chans[0].length, buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0,'RIFF'); v.setUint32(4, 36 + len*2, true); w(8,'WAVE'); w(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24, rate, true); v.setUint32(28, rate*2, true); v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,'data'); v.setUint32(40, len*2, true);
  for (let i = 0; i < len; i++){ let s = 0; for (const c of chans) s += c[i]; s /= chans.length; s = Math.max(-1, Math.min(1, s)); v.setInt16(44 + i*2, s < 0 ? s*0x8000 : s*0x7fff, true); }
  return new Blob([buf], {type:'audio/wav'});
}
function mono(ab, maxSec){
  const n = Math.min(ab.length, maxSec ? Math.floor(maxSec * ab.sampleRate) : ab.length);
  const out = new Float32Array(n);
  for (let ch = 0; ch < ab.numberOfChannels; ch++){ const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels; }
  return out;
}
async function mergeAudio(blobs){
  if (blobs.every(b => /mpeg|mp3/.test(b.type))) return new Blob(blobs, {type:'audio/mpeg'});
  const parts = []; let rate = 44100, total = 0;
  for (const b of blobs){ const ab = await decode(b); rate = ab.sampleRate; const m = mono(ab); parts.push(m); total += m.length; }
  const gap = Math.floor(rate * 0.15), all = new Float32Array(total + gap * parts.length); let o = 0;
  parts.forEach(p => { all.set(p, o); o += p.length + gap; });
  return encodeWav([all], rate);
}

/* build full audio file (for download / share) */
async function buildFile(){
  const text = ta.value.trim(); if (!text) { toast('ใส่ข้อความก่อนนะ'); return null; }
  const v = curVoice();
  if (v.type === 'device'){
    openSheet(sheetHead('บันทึกเสียงเป็นไฟล์') + `<p class="lim">เสียงในเครื่องเล่นได้อย่างเดียว เบราว์เซอร์<b>ไม่อนุญาตให้อัดเป็นไฟล์</b><br>เปลี่ยนเป็น <b>เสียง AI</b> หรือ <b>เสียงโคลน</b> เพื่อดาวน์โหลดเป็น MP3/WAV ได้</p><button class="btn" style="width:100%" id="swAi">ใช้เสียง AI (Nova)</button>`,
      el => el.querySelector('#swAi').onclick = () => { S.voice = {type:'ai', id:'nova'}; save(); renderVoice(); closeAll(); if (!S.polKey) openSettings(true); });
    return null;
  }
  if (P.lastFile && P.key === v.type + ':' + v.id + '|' + text) return P.lastFile;
  if (P.state === 'idle') prepare(v, text); else if (P.key !== v.type + ':' + v.id + '|' + text){ stopAll(); prepare(v, text); }
  const n = P.chunks.length;
  for (let i = 0; i < n; i++){
    status(`กำลังสร้างไฟล์เสียง ${i+1}/${n}…`); $('#prog').style.width = (i / n * 100) + '%';
    try { await getChunk(i); } catch(e){ status(''); toast(e.message, true); return null; }
  }
  status('กำลังรวมไฟล์…');
  const blob = await mergeAudio(P.blobs.slice(0, n));
  const ext = blob.type === 'audio/wav' ? 'wav' : 'mp3';
  P.lastFile = new File([blob], `ai-voice-${stamp()}.${ext}`, {type: blob.type});
  status(`ไฟล์เสียงพร้อมแล้ว (${(blob.size/1048576).toFixed(1)} MB)`); if (P.state === 'idle') $('#prog').style.width = '0';
  addHistory({kind:'audio', text: text.slice(0, 4000), voice: v.name, blob: P.lastFile});
  return P.lastFile;
}
$('#dkSave').onclick = async () => { const f = await buildFile(); if (f) { saveBlob(f, f.name); toast('ดาวน์โหลดแล้ว: ' + f.name); } };
$('#dkShare').onclick = async () => {
  const text = ta.value.trim();
  try {
    if (curVoice().type !== 'device'){
      const f = await buildFile(); if (!f) return;
      if (navigator.canShare?.({files:[f]})) return await navigator.share({files:[f], title:'เสียงจาก AI Voice'});
      saveBlob(f, f.name); return toast('อุปกรณ์นี้แชร์ไฟล์ตรงไม่ได้ จึงดาวน์โหลดให้แทน');
    }
    if (navigator.share) return await navigator.share({title:'AI Voice', text: text ? text.slice(0, 2000) : 'แอปแปลงข้อความเป็นเสียง', url: location.href.split('#')[0]});
    await navigator.clipboard.writeText(location.href.split('#')[0]); toast('คัดลอกลิงก์แอปแล้ว');
  } catch(e){ if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ', true); }
};

/* ---------------- history ---------------- */
async function addHistory(item){
  item.id = Date.now() + Math.random().toString(36).slice(2, 6); item.created = Date.now();
  try {
    await db.put('history', item);
    const all = (await db.all('history')).sort((a, b) => b.created - a.created);
    for (const old of all.slice(60)) await db.del('history', old.id);
  } catch(e){}
}
$('#dkHist').onclick = () => openHistory();
async function openHistory(){
  const items = (await db.all('history')).sort((a, b) => b.created - a.created);
  const when = t => new Date(t).toLocaleString('th-TH', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
  const ic = {tts:'i-vol', audio:'i-down', image:'i-image'};
  let h = sheetHead('ประวัติการใช้งาน');
  h += items.length ? items.map(it => `<div class="item" data-id="${it.id}">
      ${it.kind === 'image' ? `<img src="${esc(it.url)}" alt="" loading="lazy">` : `<span class="ib"><svg class="i"><use href="#${ic[it.kind]}"/></svg></span>`}
      <div class="t"><b>${esc((it.text || it.prompt || '').slice(0, 80))}</b><small>${when(it.created)} · ${it.kind === 'image' ? 'ภาพ' : esc(it.voice || '')}${it.kind === 'audio' ? ' · มีไฟล์เสียง' : ''}</small></div>
      ${it.kind === 'audio' ? `<button class="ib" data-dl aria-label="ดาวน์โหลด"><svg class="i"><use href="#i-down"/></svg></button>` : ''}
      <button class="ib" data-open aria-label="เปิด"><svg class="i"><use href="#i-refresh"/></svg></button>
      <button class="ib" data-del aria-label="ลบ"><svg class="i"><use href="#i-trash"/></svg></button></div>`).join('') + `<button class="btn danger sm" style="margin-top:14px" id="hClear">ล้างประวัติทั้งหมด</button>`
    : '<p class="hint">ยังไม่มีประวัติ</p>';
  openSheet(h, el => {
    el.querySelectorAll('.item').forEach(row => {
      const it = items.find(x => x.id === row.dataset.id);
      row.querySelector('[data-open]').onclick = () => {
        if (it.kind === 'image'){ $('#imgPrompt').value = it.prompt; go('image'); }
        else { go('tts'); putText(it.text, ''); }
      };
      row.querySelector('[data-dl]')?.addEventListener('click', () => saveBlob(it.blob, it.blob.name || 'ai-voice.mp3'));
      row.querySelector('[data-del]').onclick = async () => { await db.del('history', it.id); row.remove(); };
    });
    el.querySelector('#hClear')?.addEventListener('click', async () => { await db.clear('history'); openHistory(); });
  });
}

/* ---------------- settings / install / about ---------------- */
function openSettings(pro){
  const spaceOpts = SPACES.map(s => `<option value="${s[0]}" ${S.space === s[0] ? 'selected' : ''}>${s[1]} — ${s[0]}</option>`).join('') + `<option value="__custom" ${SPACES.some(s => s[0] === S.space) ? '' : 'selected'}>กำหนดเอง…</option>`;
  openSheet(sheetHead(pro ? 'ปลดล็อกฟีเจอร์ AI (ฟรี)' : 'ตั้งค่า & คีย์ API') + `
    ${pro ? `<p class="lim">แอปนี้<b>ไม่มีค่าใช้จ่ายและไม่มีระบบจ่ายเงิน</b> — “โปร” คือการใส่คีย์ฟรีของบริการ AI เอง คีย์จะเก็บไว้ในเครื่องนี้เท่านั้น</p>` : ''}
    <h4>เสียง AI + สร้างภาพ — Pollinations</h4>
    <input class="inp" id="kPol" placeholder="pk_… (Publishable key)" value="${esc(S.polKey)}" autocomplete="off">
    <p class="hint">สมัครฟรีที่ <a href="https://enter.pollinations.ai" target="_blank" rel="noopener">enter.pollinations.ai</a> → สร้างคีย์ชนิด <b>Publishable (pk_)</b> แล้ววางที่นี่ ไม่ต้องใส่ก็สร้างภาพได้ แต่ช้ากว่า (1 ภาพ/15 วินาที) และเสียง AI ต้องใช้คีย์</p>
    <h4>โคลนเสียง — Hugging Face Space</h4>
    <select class="inp" id="kSpace">${spaceOpts}</select>
    <input class="inp" id="kSpaceC" style="margin-top:8px" placeholder="ชื่อผู้ใช้/ชื่อ-space" value="${esc(S.space)}" ${SPACES.some(s => s[0] === S.space) ? 'hidden' : ''}>
    <input class="inp" id="kHf" style="margin-top:8px" placeholder="hf_… (ไม่บังคับ)" value="${esc(S.hfToken)}" autocomplete="off">
    <p class="hint">HF token (ฟรี) ช่วยเพิ่มโควตา GPU — สร้างที่ <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a> แบบ Read ก็พอ</p>
    <div class="row2" style="margin-top:12px"><button class="btn" id="kSave" style="flex:1">บันทึก</button><button class="btn alt" id="kTest">ทดสอบ Space</button></div>
    <p class="hint" id="kMsg"></p>
    <h4>ข้อมูลในเครื่อง</h4>
    <div class="row2"><button class="btn danger sm" id="kClrH">ล้างประวัติ</button><button class="btn danger sm" id="kClrC">ลบเสียงโคลนทั้งหมด</button></div>`,
  el => {
    const sp = el.querySelector('#kSpace'), spc = el.querySelector('#kSpaceC');
    sp.onchange = () => { spc.hidden = sp.value !== '__custom'; if (!spc.hidden) spc.focus(); };
    const apply = () => { S.polKey = el.querySelector('#kPol').value.trim(); S.hfToken = el.querySelector('#kHf').value.trim(); S.space = (sp.value === '__custom' ? spc.value : sp.value).trim() || SPACES[0][0]; save(); };
    el.querySelector('#kSave').onclick = () => { apply(); renderVoice(); closeAll(); toast('บันทึกแล้ว'); };
    el.querySelector('#kTest').onclick = async () => {
      apply(); const m = el.querySelector('#kMsg'); m.textContent = 'กำลังเชื่อมต่อ ' + S.space + '…';
      try { const c = await getClient(); gPlan = planFromApi(await c.view_api());
        m.innerHTML = gPlan ? `<span style="color:var(--ok)">เชื่อมต่อได้ ✓ ใช้ endpoint ${esc(gPlan.name)}</span>` : '<span style="color:var(--err)">เชื่อมต่อได้ แต่ไม่พบช่องโคลนเสียง</span>';
      } catch(e){ m.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`; }
    };
    el.querySelector('#kClrH').onclick = async () => { await db.clear('history'); toast('ล้างประวัติแล้ว'); };
    el.querySelector('#kClrC').onclick = async () => { await db.clear('clones'); clones = []; if (S.voice?.type === 'clone') S.voice = null; save(); renderVoice(); toast('ลบเสียงโคลนแล้ว'); };
  });
}
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
function openInstall(){
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openSheet(sheetHead('ติดตั้งลงหน้าจอโทรศัพท์') + (standalone ? '<p class="lim">ติดตั้งแล้ว ✓ เปิดจากไอคอนบนหน้าจอได้เลย</p>' : `
    ${installEvt ? '<button class="btn" style="width:100%" id="doInstall">ติดตั้งแอป</button>' : ''}
    <ol class="lim"><li><b>Android (Chrome):</b> แตะ ⋮ มุมขวาบน → <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b></li>
    <li><b>iPhone (Safari):</b> แตะปุ่มแชร์ <span style="font-size:18px">⎋</span> → <b>เพิ่มไปยังหน้าจอโฮม</b></li></ol>
    <p class="hint">หลังติดตั้งจะเปิดเต็มจอเหมือนแอปทั่วไป และหน้าแอปเปิดได้แม้ออฟไลน์ (เสียงในเครื่องใช้ออฟไลน์ได้ ส่วนเสียง AI/รูปภาพต้องมีเน็ต)</p>`),
  el => el.querySelector('#doInstall')?.addEventListener('click', async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; closeAll(); }));
}
function openAbout(){
  openSheet(sheetHead('ทำอะไรได้ / ข้อจำกัด') + `<ul class="lim" style="padding-left:18px">
    <li class="y">✓ อ่านข้อความยาวไม่จำกัด แบ่งช่วงอัตโนมัติ แตะประโยคเพื่อข้ามไปได้</li>
    <li class="y">✓ นำเข้า .txt .pdf .docx .srt รูปถ่าย (OCR ไทย/อังกฤษ) และลิงก์เว็บ</li>
    <li class="y">✓ พูดเพื่อพิมพ์ (ไมค์) · ปรับความเร็ว ระดับเสียง โทน รูปแบบการอ่าน · 13 ภาษา</li>
    <li class="y">✓ เสียง AI ไทยฟรี ไม่ต้องใช้คีย์ (ประมวลผลในมือถือ) ดาวน์โหลด WAV ได้</li>
    <li class="y">✓ เสียง AI 6 แบบของ Pollinations ดาวน์โหลด MP3 (ต้องมีคีย์ + Pollen)</li>
    <li class="m">△ เสียง AI ฟรีในเครื่อง: โหลดโมเดล ~110MB ครั้งแรก มือถือรุ่นเก่าอาจช้า ตัวเลข/คำอังกฤษในข้อความไทยอาจอ่านไม่ถูก</li>
    <li class="y">✓ โคลนเสียงจากคลิป 6–15 วินาที ผ่าน F5-TTS บน Hugging Face (ฟรี)</li>
    <li class="y">✓ สร้างภาพจากข้อความ 8 สไตล์ 4 สัดส่วน ดาวน์โหลด/แชร์ได้</li>
    <li class="y">✓ ประวัติการใช้งาน · ติดตั้งเป็นแอปบนมือถือ (PWA)</li>
    <li class="m">△ เสียงในเครื่อง: ฟรี/ออฟไลน์ แต่<b>บันทึกเป็นไฟล์ไม่ได้</b> คุณภาพขึ้นกับรุ่นมือถือ</li>
    <li class="m">△ เสียง AI อ่านไทยได้ แต่สำเนียงยังไม่เหมือนคนไทย 100% · เครดิตฟรีมีจำกัดต่อวัน</li>
    <li class="m">△ โคลนเสียง: ช้า (รอคิว GPU ฟรี) โควตาจำกัด Space อาจปิด/เปลี่ยนได้ทุกเมื่อ คุณภาพภาษาไทยยังไม่สมบูรณ์ ข้อความยาวจะใช้เวลานานมาก</li>
    <li class="m">△ สร้างภาพแบบไม่มีคีย์ได้ 1 ภาพต่อ ~15 วินาที อาจมีลายน้ำ คำสั่งภาษาไทยเข้าใจได้น้อยกว่าอังกฤษ</li>
    <li class="n">✗ โคลน “เสียงใครก็ได้” โดยไม่ได้รับอนุญาต — แอปให้ใช้เฉพาะเสียงตัวเองหรือที่เจ้าของยินยอม</li>
    <li class="n">✗ ระบบสมาชิก/จ่ายเงินจริง (ปุ่มโปร = ใส่คีย์ฟรี) · ซิงก์ข้ามเครื่อง (ข้อมูลอยู่ในเครื่องนี้)</li>
    <li class="n">✗ เล่นต่อตอนล็อกจอได้ไม่เสถียร โดยเฉพาะ iPhone</li></ul>
    <p class="hint">บริการภายนอก: Pollinations.ai · Hugging Face Spaces · r.jina.ai · pdf.js · mammoth · tesseract.js</p>`);
}

/* ---------------- clone page ---------------- */
let mr = null, recBlob = null, recTimer = null;
const recBtn = $('#btnRec'), recState = $('#recState');
async function setCloneSource(blob){
  try { const ab = await decode(blob); recBlob = encodeWav([mono(ab, 15)], ab.sampleRate); const d = Math.min(15, ab.duration);
    recState.textContent = `ได้คลิป ${d.toFixed(1)} วินาที ✓` + (ab.duration > 15 ? ' (ตัดเหลือ 15 วิ)' : d < 4 ? ' — สั้นไป ควร 6 วิขึ้นไป' : '');
  } catch(e){ recBlob = blob; recState.textContent = 'ได้คลิปแล้ว ✓'; }
  const a = $('#clonePreview'); a.src = URL.createObjectURL(recBlob); a.hidden = false;
}
recBtn.onclick = async () => {
  if (mr && mr.state === 'recording'){ mr.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('อุปกรณ์นี้อัดเสียงในเว็บไม่ได้ — ใช้ปุ่ม “ไฟล์” อัปโหลดคลิปแทน', true);
  try {
    const st = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    mr = new MediaRecorder(st, mime ? {mimeType: mime} : {}); const parts = [];
    mr.ondataavailable = e => e.data.size && parts.push(e.data);
    mr.onstop = () => { st.getTracks().forEach(t => t.stop()); clearInterval(recTimer); recBtn.classList.remove('live'); setCloneSource(new Blob(parts, {type: mr.mimeType || 'audio/webm'})); };
    mr.start(); recBtn.classList.add('live'); const t0 = Date.now();
    recTimer = setInterval(() => { const s = (Date.now() - t0) / 1000; recState.textContent = `กำลังอัด ${s.toFixed(0)} วิ — แตะเพื่อหยุด`; if (s >= 15) mr.stop(); }, 200);
  } catch(e){ toast('เปิดไมโครโฟนไม่ได้ — อนุญาตการใช้ไมค์ในเบราว์เซอร์ หรืออัปโหลดไฟล์แทน', true); }
};
$('#cloneFile').onchange = e => { const f = e.target.files[0]; if (f) setCloneSource(f); e.target.value = ''; };
$('#cloneRef').value = '';
$('#sayBox').onclick = () => { if (!$('#cloneRef').value) $('#cloneRef').value = $('#sayText').textContent; };
$('#btnCloneSave').onclick = async () => {
  if (!recBlob) return toast('อัดหรืออัปโหลดเสียงต้นแบบก่อน', true);
  if (!$('#cloneConsent').checked) return toast('ต้องยืนยันว่าเป็นเสียงของคุณหรือได้รับอนุญาตแล้ว', true);
  const name = $('#cloneName').value.trim() || 'เสียงของฉัน';
  const ref = $('#cloneRef').value.trim();
  if (!ref) toast('แนะนำให้พิมพ์ข้อความที่พูดในคลิป เสียงจะเหมือนขึ้นมาก');
  const rec = {id: 'c' + Date.now(), name, refText: ref, blob: recBlob, created: Date.now(), tested: false};
  await db.put('clones', rec); clones.unshift(rec); renderClones(); renderVoice();
  testClone(rec);
};
async function testClone(rec){
  const b = $('#btnCloneSave'), hint = $('#cloneHint'), out = $('#cloneOut');
  b.disabled = true; hint.innerHTML = '<span class="spin" style="display:inline-block;width:14px;height:14px;border-width:2px;vertical-align:-2px;margin-right:6px"></span>กำลังสร้างเสียงทดสอบบน Hugging Face… (อาจรอคิวหลายนาที)';
  const sample = /[฀-๿]/.test(rec.refText || 'ไทย') ? 'สวัสดีค่ะ นี่คือเสียงที่สร้างจากตัวอย่างของฉัน ฟังดูเหมือนไหม' : 'Hello, this is my cloned voice. Does it sound like me?';
  try {
    const blob = await cloneTTS(sample, rec);
    out.src = URL.createObjectURL(blob); out.hidden = false; out.play().catch(()=>{});
    rec.tested = true; await db.put('clones', rec); renderClones();
    hint.innerHTML = `<span style="color:var(--ok)">สำเร็จ ✓</span> — <a href="#" id="useNow">ใช้เสียง “${esc(rec.name)}” อ่านข้อความ</a>`;
    $('#useNow').onclick = e => { e.preventDefault(); S.voice = {type:'clone', id: rec.id}; save(); renderVoice(); go('tts'); };
  } catch(e){ hint.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span><br>บันทึกเสียงไว้แล้ว ลองทดสอบใหม่ภายหลังได้`; }
  b.disabled = false;
}
function renderClones(){
  const box = $('#cloneList');
  box.innerHTML = clones.length ? clones.map(c => `<div class="item" data-id="${c.id}"><span class="ib"><svg class="i"><use href="#i-mic"/></svg></span>
    <div class="t"><b>${esc(c.name)} ${c.tested ? '<span class="tag ok">ใช้ได้</span>' : '<span class="tag warn">ยังไม่ทดสอบ</span>'}</b><small>${esc(c.refText || 'ไม่มีข้อความอ้างอิง')}</small></div>
    <button class="ib" data-play aria-label="ฟังต้นแบบ"><svg class="i"><use href="#i-play"/></svg></button>
    <button class="ib" data-test aria-label="ทดสอบ"><svg class="i"><use href="#i-refresh"/></svg></button>
    <button class="ib" data-use aria-label="ใช้เสียงนี้"><svg class="i"><use href="#i-vol"/></svg></button>
    <button class="ib" data-del aria-label="ลบ"><svg class="i"><use href="#i-trash"/></svg></button></div>`).join('') : '<p class="hint">ยังไม่มี</p>';
  box.querySelectorAll('.item').forEach(row => {
    const c = clones.find(x => x.id === row.dataset.id);
    row.querySelector('[data-play]').onclick = () => { const a = new Audio(URL.createObjectURL(c.blob)); a.play(); };
    row.querySelector('[data-test]').onclick = () => testClone(c);
    row.querySelector('[data-use]').onclick = () => { S.voice = {type:'clone', id: c.id}; save(); renderVoice(); go('tts'); toast('ใช้เสียง “' + c.name + '” แล้ว'); };
    row.querySelector('[data-del]').onclick = async () => { await db.del('clones', c.id); clones = clones.filter(x => x !== c); if (S.voice?.id === c.id) { S.voice = null; save(); } renderClones(); renderVoice(); };
  });
}

/* ---------------- text to image ---------------- */
const IMG_STYLES = [
  ['none','ไม่กำหนด',''], ['photo','ภาพถ่ายสมจริง','photorealistic, highly detailed, natural lighting, 35mm photo'],
  ['anime','อนิเมะ','anime style illustration, vibrant colors, detailed'], ['3d','3D การ์ตูน','cute 3D cartoon render, soft lighting, octane'],
  ['water','สีน้ำ','watercolor painting, soft pastel colors, paper texture'], ['cyber','ไซเบอร์พังก์','cyberpunk, neon lights, cinematic, night city'],
  ['thai','ลายไทย','traditional Thai art style, intricate gold Thai patterns, temple mural'], ['logo','โลโก้/ไอคอน','minimal flat vector logo, clean solid background, simple shapes'],
];
const RATIOS = [['1:1',1024,1024],['9:16',768,1344],['16:9',1344,768],['4:5',896,1120]];
function chips(box, opts, cur, onPick){
  box.innerHTML = opts.map(o => `<button class="chip ${o[0] == cur ? 'on' : ''}" data-v="${o[0]}">${o[1]}</button>`).join('');
  box.querySelectorAll('.chip').forEach(b => b.onclick = () => { box.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); onPick(b.dataset.v); save(); });
}
chips($('#imgStyle'), IMG_STYLES, S.imgStyle, v => S.imgStyle = v);
chips($('#imgRatio'), RATIOS.map(r => [r[0], r[0]]), S.imgRatio, v => S.imgRatio = v);
chips($('#imgCount'), [[1,'1 ภาพ'],[2,'2 ภาพ'],[3,'3 ภาพ'],[4,'4 ภาพ']], S.imgCount, v => { S.imgCount = +v; $('#imgGrid').classList.toggle('one', S.imgCount === 1); });
$('#imgEnhance').checked = S.imgEnhance; $('#imgEnhance').onchange = e => { S.imgEnhance = e.target.checked; save(); };
$('#imgPrompt').value = LS.get('imgPrompt', '');
$('#imgPrompt').oninput = e => LS.set('imgPrompt', e.target.value);
$('#btnImgFromText').onclick = () => { const t = ta.value.trim(); if (!t) return toast('หน้าแปลงเสียงยังไม่มีข้อความ'); $('#imgPrompt').value = t.slice(0, 600); LS.set('imgPrompt', t.slice(0, 600)); toast('นำข้อความมาใช้แล้ว'); };
function imgUrl(prompt, seed, free){
  const st = IMG_STYLES.find(s => s[0] === S.imgStyle)?.[2], [, w, h] = RATIOS.find(r => r[0] === S.imgRatio) || RATIOS[0];
  const p = encodeURIComponent(prompt + (st ? ', ' + st : ''));
  const q = `width=${w}&height=${h}&seed=${seed}&model=flux&nologo=true` + (S.imgEnhance ? '&enhance=true' : '');
  return (S.polKey && !free) ? `https://gen.pollinations.ai/image/${p}?${q}&key=${encodeURIComponent(S.polKey)}` : `https://image.pollinations.ai/prompt/${p}?${q}`;
}
let imgBusy = false;
function loadImg(url, ms = 120000){
  return new Promise((res, rej) => { const im = new Image(); const t = setTimeout(() => { im.src = ''; rej(new Error('หมดเวลา')); }, ms);
    im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); rej(new Error('สร้างภาพไม่สำเร็จ')); }; im.src = url; });
}
function shotActions(div, url, prompt){
  div.querySelector('[data-dl]').onclick = async () => {
    try { const b = await (await fetch(url)).blob(); saveBlob(b, `ai-image-${stamp()}.jpg`); } catch(e){ window.open(url, '_blank'); }
  };
  div.querySelector('[data-sh]').onclick = async () => {
    try { const b = await (await fetch(url)).blob(); const f = new File([b], `ai-image-${stamp()}.jpg`, {type: b.type || 'image/jpeg'});
      if (navigator.canShare?.({files:[f]})) await navigator.share({files:[f], title: prompt.slice(0, 80)}); else saveBlob(f, f.name);
    } catch(e){ if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ', true); }
  };
  div.querySelector('[data-re]').onclick = () => renderShot(div, prompt, Math.floor(Math.random() * 1e9));
}
async function renderShot(div, prompt, seed){
  let url = imgUrl(prompt, seed);
  div.innerHTML = `<div class="ld"><div class="spin"></div>กำลังวาด…</div>`;
  try {
    let im;
    try { im = await loadImg(url); }
    catch(e){ if (!S.polKey) throw e; url = imgUrl(prompt, seed, true); div.querySelector('.ld').lastChild.textContent = 'คีย์ใช้ไม่ได้ (Pollen หมด?) กำลังวาดด้วยโหมดฟรี…'; im = await loadImg(url); }
    im.alt = prompt;
    div.innerHTML = `<div class="acts"><button data-re aria-label="วาดใหม่"><svg class="i"><use href="#i-refresh"/></svg></button><button data-sh aria-label="แชร์"><svg class="i"><use href="#i-share"/></svg></button><button data-dl aria-label="ดาวน์โหลด"><svg class="i"><use href="#i-down"/></svg></button></div>`;
    div.prepend(im); shotActions(div, url, prompt);
    addHistory({kind:'image', prompt, url});
  } catch(e){
    div.innerHTML = `<div class="ld">${esc(e.message)}<br><button class="btn sm alt" style="margin-top:8px">ลองใหม่</button></div>`;
    div.querySelector('button').onclick = () => renderShot(div, prompt, seed);
  }
}
$('#btnImg').onclick = async () => {
  const prompt = $('#imgPrompt').value.trim(); if (!prompt) return toast('พิมพ์คำอธิบายภาพก่อนนะ');
  if (imgBusy) return; imgBusy = true;
  const btn = $('#btnImg'); btn.classList.add('busy'); btn.disabled = true;
  const grid = $('#imgGrid'); grid.innerHTML = ''; grid.classList.toggle('one', S.imgCount === 1);
  const shots = Array.from({length: S.imgCount}, () => { const d = document.createElement('div'); d.className = 'shot'; d.innerHTML = '<div class="ld">รอคิว…</div>'; grid.appendChild(d); return d; });
  if (S.polKey) await Promise.all(shots.map(d => renderShot(d, prompt, Math.floor(Math.random() * 1e9))));
  else for (let i = 0; i < shots.length; i++){
    if (i){ for (let s = 15; s > 0; s--){ $('#imgStatus').textContent = `โหมดฟรีไม่มีคีย์: รอ ${s} วินาทีก่อนภาพถัดไป`; await sleep(1000); } }
    $('#imgStatus').textContent = `กำลังวาดภาพที่ ${i+1}/${shots.length}`;
    await renderShot(shots[i], prompt, Math.floor(Math.random() * 1e9));
  }
  $('#imgStatus').textContent = S.polKey ? '' : 'ใส่คีย์ Pollinations ฟรีในตั้งค่า เพื่อสร้างหลายภาพพร้อมกันและไม่มีลายน้ำ';
  btn.classList.remove('busy'); btn.disabled = false; imgBusy = false;
};

/* ---------------- boot ---------------- */
onText(); renderVoice(); ui();
const h0 = location.hash.slice(1); if (PAGES[h0]) go(h0);
addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES[h]) go(h); });
addEventListener('keydown', e => { if (e.key === 'Escape'){ closeAll(); $('#editor').classList.remove('full'); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
