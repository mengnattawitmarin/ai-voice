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
  cloneEngine:'hf', localDev:'auto', serverUrl:'', macSave:true, commercial:true, gKey:'', azKey:'', azRegion:'southeastasia', allowOverFree:false, cloneBase:null, imgEngine:'flux', imgStyle:'none', imgRatio:'1:1', imgCount:2, imgEnhance:true,
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
const LOCAL_VOICES = [  // mirrored in this repo's "models" branch (ONNX, transformers.js)
  ['th-female-v2','เสียงผู้หญิงไทย 1','th','ผู้หญิง'],
  ['th-female-v1','เสียงผู้หญิงไทย 2','th','ผู้หญิง'],
  ['th-male-v2','เสียงผู้ชายไทย 1','th','ผู้ชาย'],
  ['th-male-v1','เสียงผู้ชายไทย 2','th','ผู้ชาย'],
  ['th-male-narrator','เสียงผู้ชาย นักบรรยาย','th','ผู้ชาย'],
  ['th-mms','เสียงผู้ชาย MMS มาตรฐาน','th','ผู้ชาย'],
  ['en-mms','English voice (MMS, male)','en','ผู้ชาย'],
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
  setTimeout(() => { renderQuota(); renderEst(); });
  closeAll(); scrollTo(0,0);
  if (location.hash.slice(1) !== p) history.replaceState(null, '', p === 'tts' ? location.pathname : '#' + p);
}
$('#btnMenu').onclick = () => { drawer.classList.add('on'); scrim.classList.add('on'); };
$$('.nav[data-go]').forEach(n => n.onclick = () => go(n.dataset.go));
$$('.nav[data-act]').forEach(n => n.onclick = () => ({history:openHistory, settings:openSettings, install:openInstall, about:openAbout, proc:openProc})[n.dataset.act]());
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
  if (typeof renderEst === 'function') try { renderEst(); } catch(e){}
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
function loadDevVoices(){ if (synth) { devVoices = synth.getVoices(); setTimeout(renderVoice); } }
if (synth){ loadDevVoices(); synth.onvoiceschanged = loadDevVoices; }
db.all('clones').then(c => { clones = c.sort((a,b) => b.created - a.created); renderVoice(); });

function devForLang(){ return devVoices.filter(v => v.lang.toLowerCase().replace('_','-').startsWith(S.lang)); }
/* ---------------- licences: what can be used commercially ---------------- */
const LIC = {
  device: {ok:null, t:'ไม่ยืนยัน (ขึ้นกับระบบมือถือ) · บันทึกเป็นไฟล์ไม่ได้'},
  local: {ok:false, t:'ส่วนตัวเท่านั้น — โมเดล MMS (CC-BY-NC)'},
  ai: {ok:null, t:'ไม่ยืนยัน — ตรวจเงื่อนไข Pollinations เอง'},
  gcloud: {ok:true, t:'เชิงพาณิชย์ได้ — Google Cloud TTS'},
  azure: {ok:true, t:'เชิงพาณิชย์ได้ — Microsoft Azure TTS'},
  'clone-hf': {ok:false, t:'ส่วนตัวเท่านั้น — F5-TTS (CC-BY-NC)'},
  'clone-server': {ok:false, t:'ส่วนตัวเท่านั้น — F5-TTS (CC-BY-NC)'},
  'clone-openvoice': {ok:true, t:'เชิงพาณิชย์ได้ — OpenVoice V2 (MIT) + เสียงต้นทาง Google/Azure'},
  'img-flux': {ok:true, t:'เชิงพาณิชย์ได้ — FLUX.1-schnell (Apache 2.0)'},
  'img-pol': {ok:null, t:'ไม่ยืนยัน — ตรวจเงื่อนไข Pollinations เอง'},
};
function lic(k){
  if (k === 'img-server'){ const c = SERVER_INFO?.image_commercial; return c === false ? {ok:false, t:'ส่วนตัวเท่านั้น — โมเดลภาพบนคอมไม่อนุญาตเชิงพาณิชย์'} : c == null && SERVER_INFO ? {ok:null, t:'ไม่ยืนยัน — ' + (SERVER_INFO.image_model || '')} : {ok:true, t:'เชิงพาณิชย์ได้ — Segmind-Vega (Apache 2.0)'}; }
  return LIC[k] || {ok:null, t:'ไม่ยืนยัน'};
}
const licTag = k => { const l = lic(k); return `<span class="tag ${l.ok ? 'ok' : l.ok === false ? 'bad' : 'warn'}">${l.ok ? '💼 เชิงพาณิชย์ได้' : l.ok === false ? '🚫 ส่วนตัว' : '❔ ไม่ยืนยัน'}</span>`; };
const allowed = k => !S.commercial || lic(k).ok === true;
const cloneMode = () => S.cloneEngine === 'openvoice' ? 'openvoice' : S.cloneEngine === 'server' ? 'server' : 'hf';
const voiceLicKey = v => v.type === 'clone' ? 'clone-' + cloneMode() : v.type;
function enforceCommercial(){ if (!S.commercial) return; if (!allowed('clone-' + cloneMode())) S.cloneEngine = 'openvoice'; if (!allowed('img-' + S.imgEngine)) S.imgEngine = 'flux'; save(); }

/* ---------------- commercial cloud voices: Google Cloud TTS + Azure TTS ---------------- */
const G_FALLBACK = [['th-TH-Chirp3-HD-Charon','MALE'],['th-TH-Chirp3-HD-Puck','MALE'],['th-TH-Chirp3-HD-Kore','FEMALE'],['th-TH-Chirp3-HD-Aoede','FEMALE'],['th-TH-Neural2-C','FEMALE'],['th-TH-Standard-A','FEMALE']];
const AZ_FALLBACK = [['th-TH-NiwatNeural','Male'],['th-TH-PremwadeeNeural','Female'],['th-TH-AcharaNeural','Female']];
let gVoices = LS.get('gVoices', null), azVoices = LS.get('azVoices', null);
const genderTh = g => /^m/i.test(g || '') ? 'ผู้ชาย' : /^f/i.test(g || '') ? 'ผู้หญิง' : 'กลาง';
const gList = () => (gVoices && gVoices.length ? gVoices : G_FALLBACK).filter(v => v[0].toLowerCase().startsWith(lang()[2].toLowerCase()));
const azList = () => (azVoices && azVoices.length ? azVoices : AZ_FALLBACK).filter(v => v[0].toLowerCase().startsWith(lang()[2].toLowerCase()));
const gPretty = n => n.replace(/^[a-z]{2,3}-[A-Z]{2}-/, '').replace(/-/g, ' ');
const azPretty = n => n.replace(/^[a-z]{2,3}-[A-Z]{2}-/, '').replace(/Neural$/, '');
const gTier = n => /Chirp|Neural2|Studio|Polyglot|Journey/i.test(n) ? ['gcloud-premium', 1e6] : ['gcloud-std', 4e6];
const ym = () => new Date().toISOString().slice(0, 7);
const usageGet = k => LS.get('use.' + ym(), {})[k] || 0;
function usageAdd(k, n){ const u = LS.get('use.' + ym(), {}); u[k] = (u[k] || 0) + n; LS.set('use.' + ym(), u); }
function secsToNextMonth(){ const d = new Date(); return (new Date(d.getFullYear(), d.getMonth() + 1, 1) - d) / 1000; }
function usageGuard(k, n, limit, qk){
  if (S.allowOverFree || usageGet(k) + n <= limit) return;
  Q.mark(qk, 'free-limit', secsToNextMonth());
  throw new Error(`ครบโควตาฟรีเดือนนี้แล้ว (นับในแอป ${usageGet(k).toLocaleString('th-TH')}/${limit.toLocaleString('th-TH')} ตัวอักษร) — ใช้ต่อจะถูกคิดเงิน · เปิด “ยอมใช้เกินโควตาฟรี” ในตั้งค่าถ้าต้องการ`);
}
async function loadCloudVoices(){
  if (S.gKey) try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(S.gKey)}`); const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    gVoices = (d.voices || []).filter(v => /^(th|en)-/.test(v.name)).map(v => [v.name, v.ssmlGender]); LS.set('gVoices', gVoices);
  } catch(e){ toast('ดึงรายชื่อเสียง Google ไม่ได้: ' + e.message, true); }
  if (S.azKey) try {
    const r = await fetch(`https://${S.azRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {headers:{'Ocp-Apim-Subscription-Key': S.azKey}});
    if (!r.ok) throw new Error(r.status === 401 ? 'คีย์หรือภูมิภาคไม่ถูกต้อง' : 'HTTP ' + r.status);
    azVoices = (await r.json()).filter(v => /^(th|en)-/.test(v.ShortName)).map(v => [v.ShortName, v.Gender]); LS.set('azVoices', azVoices);
  } catch(e){ toast('ดึงรายชื่อเสียง Azure ไม่ได้: ' + e.message, true); }
  renderVoice();
}
async function gcloudTTS(text, name){
  if (!S.gKey) throw new Error('ใส่คีย์ Google Cloud ในตั้งค่าก่อน');
  const [uk, lim] = gTier(name); usageGuard(uk, text.length, lim, 'gcloud');
  let r, d;
  try {
    r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(S.gKey), {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({input:{text}, voice:{languageCode: name.split('-').slice(0, 2).join('-'), name}, audioConfig:{audioEncoding:'MP3'}})});
    d = await r.json().catch(() => ({}));
  } catch(e){ throw new Error('เชื่อมต่อ Google Cloud ไม่ได้ — ตรวจอินเทอร์เน็ต'); }
  if (!r.ok){
    const m = d.error?.message || 'HTTP ' + r.status;
    if (r.status === 429 || /quota|rate limit/i.test(m)){ Q.mark('gcloud', m, 60); throw new Error(quotaText('gcloud')); }
    if (r.status === 403 || /key|billing|disabled/i.test(m)) throw new Error('Google Cloud: ' + m + ' — ตรวจว่าเปิด Cloud Text-to-Speech API + ผูกบัญชีชำระเงิน และคีย์อนุญาตเว็บนี้');
    throw new Error('Google TTS ล้มเหลว: ' + m);
  }
  usageAdd(uk, text.length); Q.clear('gcloud');
  const bin = atob(d.audioContent), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], {type:'audio/mpeg'});
}
const xmlEsc = t => t.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
async function azureTTS(text, name){
  if (!S.azKey) throw new Error('ใส่คีย์ Azure Speech ในตั้งค่าก่อน');
  usageGuard('azure', text.length, 5e5, 'azure');
  const loc = name.split('-').slice(0, 2).join('-');
  let r;
  try {
    r = await fetch(`https://${S.azRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {method:'POST',
      headers:{'Ocp-Apim-Subscription-Key': S.azKey, 'Content-Type':'application/ssml+xml', 'X-Microsoft-OutputFormat':'audio-24khz-48kbitrate-mono-mp3'},
      body: `<speak version='1.0' xml:lang='${loc}'><voice name='${name}'>${xmlEsc(text)}</voice></speak>`});
  } catch(e){ throw new Error('เชื่อมต่อ Azure ไม่ได้ — ตรวจอินเทอร์เน็ต/ภูมิภาค'); }
  if (!r.ok){
    if (r.status === 429 || r.status === 403){ Q.mark('azure', 'quota', +r.headers.get('retry-after') || (r.status === 403 ? secsToNextMonth() : 60)); throw new Error(quotaText('azure')); }
    if (r.status === 401) throw new Error('Azure: คีย์หรือภูมิภาคไม่ถูกต้อง (ตั้งค่า)');
    throw new Error('Azure TTS ล้มเหลว (' + r.status + ')');
  }
  usageAdd('azure', text.length); Q.clear('azure');
  return r.blob();
}
const commercialVoices = () => [...(S.gKey ? gList().map(v => ({type:'gcloud', id:v[0], g:v[1]})) : []), ...(S.azKey ? azList().map(v => ({type:'azure', id:v[0], g:v[1]})) : [])];

function curVoice(){
  let v = S.voice;
  if (!v && S.commercial){ const c = commercialVoices()[0]; if (c) v = {type:c.type, id:c.id}; }
  if (v?.type === 'gcloud'){ const g = (gVoices || G_FALLBACK).find(x => x[0] === v.id); return {type:'gcloud', id:v.id, name: gPretty(v.id) + ' (Google)', desc: genderTh(g?.[1]) + ' · Google Cloud · 💼 เชิงพาณิชย์ได้'}; }
  if (v?.type === 'azure'){ const a = (azVoices || AZ_FALLBACK).find(x => x[0] === v.id); return {type:'azure', id:v.id, name: azPretty(v.id) + ' (Azure)', desc: genderTh(a?.[1]) + ' · Microsoft Azure · 💼 เชิงพาณิชย์ได้'}; }
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
  try { renderEst(); renderQuota(); } catch(e){}
}
$('#btnVoice').onclick = () => {
  const v = curVoice(); const keyOk = !!S.polKey;
  const list = devForLang();
  const row = (k, n, d, on) => `<button class="opt ${on?'on':''}" data-k="${esc(k)}"><span class="dot"></span><span class="t"><b>${n}</b><small>${d}</small></span></button>`;
  let h = sheetHead('เลือกเสียง');
  h += `<label class="switch" style="margin:0 0 6px"><span>💼 โหมดเชิงพาณิชย์ (ทำวิดีโอหารายได้)<br><small style="color:var(--mut)">ดาวน์โหลด/แชร์/บันทึกได้เฉพาะเสียงที่สัญญาอนุญาตเชิงพาณิชย์</small></span><input type="checkbox" id="vComm" ${S.commercial ? 'checked' : ''}></label>`;
  h += `<h4>💼 ใช้หารายได้ได้ — Google Cloud TTS</h4>`;
  h += S.gKey ? gList().map(g => row('gcloud:'+g[0], esc(gPretty(g[0])) + ` <span class="tag">${genderTh(g[1])}</span> ` + licTag('gcloud'), 'คุณภาพสูง · ' + (gTier(g[0])[1] === 1e6 ? 'ฟรี 1 ล้านตัวอักษร/เดือน' : 'ฟรี 4 ล้านตัวอักษร/เดือน'), v.type==='gcloud' && v.id===g[0])).join('')
    : `<button class="opt" data-setc><span class="dot"></span><span class="t"><b>＋ ตั้งค่า Google Cloud TTS</b><small>ไทย ชาย/หญิง · ฟรีสูงสุด 4 ล้านตัวอักษร/เดือน · ใช้เชิงพาณิชย์ได้</small></span></button>`;
  h += `<h4>💼 ใช้หารายได้ได้ — Microsoft Azure TTS</h4>`;
  h += S.azKey ? azList().map(a => row('azure:'+a[0], esc(azPretty(a[0])) + ` <span class="tag">${genderTh(a[1])}</span> ` + licTag('azure'), 'Neural · ฟรี 0.5 ล้านตัวอักษร/เดือน', v.type==='azure' && v.id===a[0])).join('')
    : `<button class="opt" data-setc><span class="dot"></span><span class="t"><b>＋ ตั้งค่า Azure TTS</b><small>เปรมวดี (หญิง) · นิวัฒน์ (ชาย) · อัจฉรา (หญิง) · ฟรี 0.5 ล้านตัวอักษร/เดือน</small></span></button>`;
  const locs = LOCAL_VOICES.filter(l => l[2] === S.lang);
  if (locs.length){
    h += `<h4>เสียง AI ฟรีในเครื่อง ไม่ต้องใช้คีย์ ${licTag('local')}</h4>`;
    h += locs.map(l => row('local:'+l[0], esc(l[1]) + ` <span class="tag">${l[3]}</span>`, 'ฟรี ออฟไลน์หลังโหลดครั้งแรก (~115MB) · ดาวน์โหลดไฟล์ได้', v.type==='local' && v.id===l[0])).join('');
  }
  h += `<h4>เสียง AI Pollinations ${licTag('ai')} ${keyOk ? '<span class="tag ok">พร้อมใช้</span>' : '<span class="tag warn">ต้องมีคีย์ + Pollen</span>'}</h4>`;
  h += AI_VOICES.map(a => row('ai:'+a[0], esc(a[1]) + ` <span class="tag">${a[0]}</span>`, esc(a[2]) + ' · ดาวน์โหลด MP3 ได้', v.type==='ai' && v.id===a[0])).join('');
  if (!keyOk) h += `<p class="hint">เสียง AI ใช้ Pollinations — <a href="#" data-set>ใส่คีย์ฟรีในตั้งค่า</a> (สมัครฟรี) อ่านภาษาไทยได้แต่สำเนียงอาจยังไม่เป๊ะ</p>`;
  h += `<h4>เสียงที่โคลนไว้ ${licTag('clone-' + cloneMode())}</h4>`;
  h += clones.length ? clones.map(c => row('clone:'+c.id, esc(c.name), 'เสียงโคลน · ' + (cloneMode() === 'openvoice' ? 'OpenVoice บนคอม' : 'F5-TTS'), v.type==='clone' && v.id===c.id)).join('') : '';
  h += `<button class="opt" data-gclone><span class="dot"></span><span class="t"><b>＋ โคลนเสียงใหม่</b><small>อัดเสียงตัวเอง 10 วินาที</small></span></button>`;
  h += `<h4>เสียงระบบในเครื่อง (${esc(lang()[1])}) ${licTag('device')}</h4>`;
  h += list.length ? list.map(d => row('device:'+d.voiceURI, esc(prettyDev(d)), d.localService ? 'อยู่ในเครื่อง' : 'ออนไลน์', v.type==='device' && v.id===d.voiceURI)).join('')
    : `<p class="hint">ไม่มีเสียง${esc(lang()[1])}ในเครื่องนี้ — iPhone: ตั้งค่า › การช่วยการเข้าถึง › เนื้อหาที่พูด › เสียง / Android: ตั้งค่า › การแปลงข้อความเป็นเสียง</p>`;
  openSheet(h, el => {
    el.querySelectorAll('.opt[data-k]').forEach(b => b.onclick = () => {
      const [type, ...rest] = b.dataset.k.split(':'); S.voice = {type, id: rest.join(':')}; save(); stopAll(); renderVoice(); closeAll();
      if (type === 'ai' && !S.polKey) toast('อย่าลืมใส่คีย์ Pollinations ในตั้งค่า ถ้าเล่นไม่ได้');
    });
    el.querySelector('[data-gclone]').onclick = () => go('clone');
    el.querySelector('#vComm').onchange = e => { S.commercial = e.target.checked; enforceCommercial(); save(); renderVoice(); renderEngines(); toast(S.commercial ? 'เปิดโหมดเชิงพาณิชย์แล้ว' : 'ปิดโหมดเชิงพาณิชย์แล้ว'); };
    el.querySelectorAll('[data-setc]').forEach(b => b.onclick = () => openSettings());
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
$('#fAdv').onclick = () => openProc();

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
  try { renderEst(); } catch(e){}
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'none';
}
function prepare(v, text){
  const key = v.type + ':' + v.id + '|' + text;
  if (P.key !== key){
    const max = v.type === 'device' ? 180 : (v.type === 'ai' || v.type === 'gcloud' || v.type === 'azure') ? 380 : v.type === 'local' ? 140 : 200;
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
  if (P.kind === 'remote' && S.serverUrl && S.macSave) buildFile(true).then(f => f && saveToMac(f, 'audio', ta.value.trim().slice(0, 40))).catch(() => {});
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
  if (v.type === 'gcloud' || v.type === 'azure'){ const t0 = performance.now(); const b = await (v.type === 'gcloud' ? gcloudTTS(text, v.id) : azureTTS(text, v.id)); SPEED.learn(v.type, (performance.now() - t0) / Math.max(1, text.length)); return b; }
  if (v.type === 'local') return localTTS(text, v.id);
  if (v.type === 'ai'){ const t0 = performance.now(); const b = await pollinationsTTS(text, v.id); SPEED.learn('ai', (performance.now() - t0) / Math.max(1, text.length)); return b; }
  if (v.type === 'clone') return cloneTTS(text, v.rec);
  throw new Error('เสียงในเครื่องสร้างไฟล์เสียงไม่ได้');
}
/* ---------------- quota tracking (API engines) ---------------- */
const QUOTA_NAMES = {
  pollinations: 'เครดิต Pollinations (คีย์ของคุณ)',
  polfree: 'Pollinations โหมดฟรี',
  hf: 'GPU ฟรีของ Hugging Face (โคลนเสียง + FLUX)',
  gcloud: 'Google Cloud TTS (โควตาฟรีรายเดือน)',
  azure: 'Azure TTS (โควตาฟรีรายเดือน)',
};
const Q = {
  all(){ const q = LS.get('quota', {}), now = Date.now(); let ch = false; for (const k in q) if (q[k].until && q[k].until < now){ delete q[k]; ch = true; } if (ch) LS.set('quota', q); return q; },
  hit(k){ return this.all()[k] || null; },
  mark(k, msg, sec, guess){ const q = this.all(); q[k] = {msg, at: Date.now(), until: sec ? Date.now() + sec*1000 : (k === 'pollinations' ? 0 : Date.now() + 30*60000), guess: !sec && k !== 'pollinations'}; LS.set('quota', q); renderQuota(); },
  clear(k){ const q = this.all(); if (q[k]){ delete q[k]; LS.set('quota', q); renderQuota(); } },
};
function fmtDur(sec){
  sec = Math.max(1, sec);
  if (sec < 60) return Math.round(sec) + ' วินาที';
  if (sec < 3600) return Math.round(sec / 60) + ' นาที';
  return (sec / 3600).toFixed(1).replace(/\.0$/, '') + ' ชั่วโมง';
}
function quotaText(k){
  const q = Q.hit(k); if (!q) return '';
  let t = `โควตา ${QUOTA_NAMES[k]} หมดแล้ว`;
  if (k === 'pollinations') t += ' — ต้องเติม Pollen (ซื้อ หรือทำ Quests ที่ enter.pollinations.ai)';
  else if (q.guess) t += ' — ระบบไม่ได้บอกเวลา ลองใหม่ในอีกสักพัก';
  else t += ` — ใช้ได้อีกในประมาณ ${fmtDur((q.until - Date.now()) / 1000)}`;
  return t;
}
function curPage(){ return $$('.page').find(p => p.classList.contains('on'))?.dataset.page || 'tts'; }
function renderQuota(){
  const box = $('#quota'); if (!box) return;
  try { renderEngines(); } catch(e){}
  const page = curPage(), ks = [];
  if (page === 'tts'){ const v = curVoice(); if (v.type === 'ai') ks.push('pollinations'); if (v.type === 'gcloud' || v.type === 'azure') ks.push(v.type); if (v.type === 'clone' && cloneMode() === 'hf') ks.push('hf'); }
  if (page === 'clone' && cloneMode() === 'hf') ks.push('hf');
  if (page === 'image'){ if (S.imgEngine === 'flux') ks.push('hf'); if (S.imgEngine === 'pol') ks.push(S.polKey && !Q.hit('pollinations') ? 'pollinations' : 'polfree'); if (S.imgEngine === 'pol' && S.polKey) ks.push('pollinations'); }
  const hits = [...new Set(ks)].filter(k => Q.hit(k));
  box.innerHTML = hits.map(k => {
    const acts = [];
    if (page === 'tts' && k === 'pollinations') acts.push(['local', 'ใช้เสียง AI ฟรีในเครื่อง']);
    if (page === 'tts' && (k === 'gcloud' || k === 'azure')){ const o = commercialVoices().find(c => c.type !== k); if (o) acts.push(['sw:' + o.type + ':' + o.id, 'สลับไป ' + (o.type === 'gcloud' ? 'Google' : 'Azure')]); }
    if (k === 'hf' && page !== 'image') acts.push(['cloneServer', 'ใช้คอมของฉัน']);
    if (k === 'hf' && page === 'image'){ acts.push(['imgPol', 'ใช้ Pollinations']); acts.push(['imgServer', 'ใช้คอมของฉัน']); }
    if (page === 'image' && k !== 'hf' && !Q.hit('hf')) acts.push(['imgFlux', 'ใช้ FLUX']);
    return `<div class="qbar"><b>⚠️ ${esc(quotaText(k))}</b><div class="row2" style="flex-wrap:wrap;margin-top:8px">${acts.map(a => `<button class="btn sm alt" data-q="${a[0]}">${a[1]}</button>`).join('')}<button class="btn sm alt" data-q="proc">ดูตัวเลือก</button></div></div>`;
  }).join('');
  box.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    const a = b.dataset.q;
    if (a === 'local'){ const l = LOCAL_VOICES.find(x => x[2] === S.lang) || LOCAL_VOICES[0]; S.voice = {type:'local', id:l[0]}; }
    if (a === 'cloneServer' || a === 'imgServer'){ if (!S.serverUrl) return openProc(); if (a === 'cloneServer') S.cloneEngine = 'server'; else S.imgEngine = 'server'; }
    if (a === 'imgPol') S.imgEngine = 'pol';
    if (a.startsWith('sw:')){ const [, t, ...id] = a.split(':'); S.voice = {type:t, id:id.join(':')}; }
    if (a === 'imgFlux') S.imgEngine = 'flux';
    if (a === 'proc') return openProc();
    save(); stopAll(); renderEngines(); renderVoice(); renderQuota(); toast('สลับแล้ว');
  });
}
setInterval(renderQuota, 30000);

/* ---------------- device spec + time estimates ---------------- */
let SPEC = null;
async function getSpec(){
  if (SPEC) return SPEC;
  const ua = navigator.userAgent, mobile = /Android|iPhone|iPad|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) && 'ontouchend' in document);
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) || (mobile && /Macintosh/.test(ua)) ? 'iOS/iPadOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'อื่น ๆ';
  let gpu = null;
  try { if (navigator.gpu){ const ad = await navigator.gpu.requestAdapter(); if (ad){ const i = ad.info || (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : {}); gpu = {vendor: i.vendor || '', arch: i.architecture || '', desc: i.description || ''}; } } } catch(e){}
  const apple = os === 'macOS' && !!gpu && /apple|metal/i.test(gpu.vendor + ' ' + gpu.arch);
  SPEC = {mobile, os, cores: navigator.hardwareConcurrency || 4, mem: navigator.deviceMemory || null, gpu, apple, net: navigator.connection?.downlink || null};
  return SPEC;
}
getSpec().then(() => { renderEst(); });
const SPEED = {
  get(k){ return LS.get('speed', {})[k]; },
  learn(k, v){ if (!isFinite(v) || v <= 0) return; const s = LS.get('speed', {}); s[k] = s[k] ? s[k]*0.6 + v*0.4 : v; LS.set('speed', s); },
};
let SERVER_INFO = LS.get('serverInfo', null);
function localDev(){ return S.localDev === 'wasm' ? 'wasm' : S.localDev === 'webgpu' ? 'webgpu' : (SPEC?.gpu ? 'webgpu' : 'wasm'); }
function engineKey(v){ return v.type === 'local' ? 'local-' + localDev() : (v.type === 'ai' || v.type === 'gcloud' || v.type === 'azure') ? v.type : v.type === 'clone' ? 'clone-' + cloneMode() : 'device'; }
function defMs(k){
  const sp = SPEC || {mobile:true, cores:4};
  const sd = SERVER_INFO?.device;
  switch (k){
    case 'local-webgpu': return sp.mobile ? 18 : sp.apple ? 5 : 7;
    case 'local-wasm': return sp.mobile ? (sp.cores >= 8 ? 70 : 140) : (sp.cores >= 8 ? 20 : 40);
    case 'ai': return 12;
    case 'gcloud': return 6;
    case 'azure': return 6;
    case 'clone-openvoice': return 6 + (sd === 'cuda' ? 5 : 30);
    case 'clone-hf': return 60;
    case 'clone-server': return SERVER_INFO?.tts_ms_per_char || (sd === 'cuda' ? 15 : sd === 'cpu' ? 500 : 110);
    case 'img-flux': return 12000;
    case 'img-pol': return 9000;
    case 'img-server': return SERVER_INFO?.img_ms || (sd === 'cuda' ? 1500 : sd === 'cpu' ? 45000 : 6000);
  }
  return 50;
}
function speedOf(k){ const m = SPEED.get(k); return {v: m || defMs(k), measured: !!m}; }
function whereLabel(k){
  return ({'local-webgpu':'GPU ในเครื่องนี้', 'local-wasm':'CPU ในเครื่องนี้', 'ai':'API Pollinations', 'gcloud':'API Google Cloud', 'azure':'API Azure', 'clone-openvoice':'Google/Azure + OpenVoice บนคอมของฉัน', 'clone-hf':'API Hugging Face', 'clone-server':'คอมของฉัน' + (SERVER_INFO?.chip ? ` (${SERVER_INFO.chip})` : ''),
    'img-flux':'API FLUX (Hugging Face)', 'img-pol':'API Pollinations', 'img-server':'คอมของฉัน' + (SERVER_INFO?.chip ? ` (${SERVER_INFO.chip})` : '')})[k] || k;
}
function estimateVoice(v, chars){
  const listen = chars / 13.3 / effRate();
  if (v.type === 'device') return {first: 0, total: 0, listen, text: `⏱ เริ่มอ่านทันที · ฟังจบประมาณ ${fmtDur(listen)} · เสียงในเครื่อง`};
  const k = engineKey(v), sp = speedOf(k), firstChars = Math.min(chars, v.type === 'local' ? 140 : 300);
  const lt = S.commercial && !allowed(voiceLicKey(v)) ? ' · ⚠️ เสียงนี้ใช้หารายได้ไม่ได้' : '';
  let over = 0, note = '';
  if (v.type === 'local' && !LS.get('dl.' + v.id, false)){ over = 115 * 8 / Math.max(SPEC?.net || 10, 8) + 5; note = ` · ครั้งแรกโหลดโมเดล ~${fmtDur(over)}`; }
  if (k === 'ai' || k === 'gcloud' || k === 'azure') over = 2;
  if (k === 'clone-hf'){ over = 20; note = ' · อาจต้องรอคิวเพิ่ม'; }
  if (k === 'clone-server' && SERVER_INFO && !SERVER_INFO.tts_loaded){ over = 40; note = ' · ครั้งแรกคอมต้องโหลดโมเดล'; }
  const first = over + firstChars * sp.v / 1000, total = over + chars * sp.v / 1000;
  const slow = sp.v > 75 / effRate() ? ' · สร้างช้ากว่าเสียงที่เล่น อาจหยุดรอเป็นช่วง ๆ' : '';
  return {first, total, listen, text: `⏱ เริ่มได้ยินใน ~${fmtDur(first)} · สร้างทั้งหมด ~${fmtDur(total)} · ${whereLabel(k)}${note}${slow} · ${sp.measured ? 'วัดจากเครื่องคุณ' : 'ประมาณจากสเปค'}${lt}`};
}
function estimateImages(n){
  const k = 'img-' + S.imgEngine, sp = speedOf(k);
  let each = sp.v / 1000, extra = 0;
  if (k === 'img-pol' && !S.polKey) extra = (n - 1) * 15;
  if (k === 'img-flux') extra = 10;
  if (k === 'img-server' && SERVER_INFO && !SERVER_INFO.img_loaded) extra = 60;
  return {each, total: each * n + extra, text: `⏱ ประมาณ ${fmtDur(each)}/ภาพ · ${n} ภาพ ~${fmtDur(each * n + extra)} · ${whereLabel(k)} · ${sp.measured ? 'วัดจากเครื่องคุณ' : 'ประมาณจากสเปค'}`};
}
function renderEst(){
  const chars = ta.value.trim().length;
  if ($('#est')) $('#est').textContent = chars && P.state === 'idle' ? estimateVoice(curVoice(), chars).text : '';
  if ($('#imgEst')) $('#imgEst').textContent = estimateImages(S.imgCount).text;
  if ($('#cloneEst')) $('#cloneEst').textContent = `⏱ ประโยคทดสอบ ~${fmtDur((S.cloneEngine === 'server' ? 0 : 20) + 45 * speedOf('clone-' + (S.cloneEngine === 'server' ? 'server' : 'hf')).v / 1000)} · ${whereLabel('clone-' + (S.cloneEngine === 'server' ? 'server' : 'hf'))}`;
}

/* ---------------- free on-device AI voice (transformers.js, WebGPU or CPU) ---------------- */
const TTS_WORKER = `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
// Voice models are mirrored in this app's own GitHub repo (branch "models") so they cannot disappear.
const HOST = 'https://raw.githubusercontent.com/mengnattawitmarin/ai-voice/models/';
const CN = 'aivoice-models-v1';
env.allowLocalModels = false;
env.remoteHost = HOST;
env.remotePathTemplate = '{model}/';
env.useBrowserCache = false;
env.useCustomCache = true;
async function fetchParts(url){
  const m = await fetch(url + '.manifest.json');
  if (!m.ok) return null;
  const man = await m.json(); const bufs = []; let got = 0;
  for (const p of man.parts){
    const res = await fetch(url.replace(/model\.onnx$/, p));
    if (!res.ok) throw new Error('ดาวน์โหลดโมเดลไม่ได้ (' + res.status + ')');
    const rd = res.body.getReader();
    for (;;){ const { done, value } = await rd.read(); if (done) break; bufs.push(value); got += value.length; self.postMessage({ progress: got / man.size * 100 }); }
  }
  return new Response(new Blob(bufs), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(man.size) } });
}
env.customCache = {
  async match(key){
    const url = typeof key === 'string' ? key : key.url;
    const c = await caches.open(CN);
    const hit = await c.match(url); if (hit) return hit;
    if (url.startsWith(HOST) && url.endsWith('/onnx/model.onnx')){
      const r = await fetchParts(url);
      if (r){ await c.put(url, r.clone()); return r; }
    }
    return undefined;
  },
  async put(key, resp){ try { const c = await caches.open(CN); await c.put(typeof key === 'string' ? key : key.url, resp); } catch (e) {} },
};
const pipes = {};
let gpuOk = null, chain = Promise.resolve();
async function hasGpu(){ if (gpuOk !== null) return gpuOk; try { gpuOk = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { gpuOk = false; } return gpuOk; }
function load(model, device){
  const k = model + '|' + device;
  pipes[k] ||= pipeline('text-to-speech', model, { dtype: 'fp32', device,
    progress_callback: p => { if (p.status === 'progress' && /onnx/.test(p.file || '')) self.postMessage({ progress: p.progress }); } })
    .catch(e => { pipes[k] = null; throw e; });
  return pipes[k];
}
async function run(model, device, text){ const tts = await load(model, device); const t0 = performance.now(); const out = await tts(text); return { out, ms: performance.now() - t0 }; }
async function job({ id, model, text, want }){
  let device = want === 'wasm' ? 'wasm' : (await hasGpu()) ? 'webgpu' : 'wasm';
  try {
    let r;
    try { r = await run(model, device, text); }
    catch (err) { if (device !== 'webgpu' || want === 'webgpu') throw err; device = 'wasm'; r = await run(model, device, text); }
    self.postMessage({ id, device, ms: r.ms, audio: r.out.audio, rate: r.out.sampling_rate }, [r.out.audio.buffer]);
  } catch (err) { self.postMessage({ id, device, error: String((err && err.message) || err) }); }
}
self.onmessage = e => { chain = chain.then(() => job(e.data)); };
`;
let ttsWorker = null, ttsSeq = 0; const ttsJobs = {};
function getWorker(){
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker(URL.createObjectURL(new Blob([TTS_WORKER], {type:'text/javascript'})), {type:'module'});
  ttsWorker.onmessage = e => {
    const d = e.data;
    if (d.progress != null){ status(`กำลังดาวน์โหลดโมเดลเสียง ${Math.round(d.progress)}% — ครั้งแรกครั้งเดียว ใช้ Wi-Fi จะเร็วกว่า`); return; }
    const job = ttsJobs[d.id]; if (!job) return; delete ttsJobs[d.id];
    if (d.error) return job.rej(new Error(`เสียง AI ในเครื่อง (${d.device === 'webgpu' ? 'GPU' : 'CPU'}) ล้มเหลว: ` + d.error + (d.device === 'webgpu' ? ' — ลองเปลี่ยนเป็น CPU ในหน้า ประมวลผล' : '')));
    LS.set('dl.' + job.model, true); P.lastDev = d.device;
    if (!job.first) SPEED.learn('local-' + d.device, d.ms / Math.max(1, job.chars));
    job.res(encodeWav([d.audio], d.rate));
  };
  ttsWorker.onerror = e => { Object.values(ttsJobs).forEach(j => j.rej(new Error('โหลดตัวประมวลผลเสียงไม่ได้ — ตรวจอินเทอร์เน็ต หรือเบราว์เซอร์อาจเก่าเกินไป (' + (e.message || 'worker error') + ')'))); for (const k in ttsJobs) delete ttsJobs[k]; ttsWorker = null; };
  return ttsWorker;
}
const warmModels = new Set();
function localTTS(text, model){
  const clean = text.replace(/[“”"«»()[\]{}<>*_#~|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return Promise.resolve(encodeWav([new Float32Array(1600)], 16000));
  const first = !warmModels.has(model + localDev()); warmModels.add(model + localDev());
  return new Promise((res, rej) => { const id = ++ttsSeq; ttsJobs[id] = {res, rej, model, chars: clean.length, first}; getWorker().postMessage({id, model, text: clean, want: S.localDev || 'auto'}); });
}

async function pollinationsTTS(text, voice){
  const k = S.polKey.trim();
  let r, detail = '';
  try {
    r = await fetch(`https://gen.pollinations.ai/audio/${encodeURIComponent(text)}?voice=${voice}` + (k ? `&key=${encodeURIComponent(k)}` : ''));
    if (!r.ok){
      detail = await r.text().catch(() => '');
      if (r.status !== 402 && !/pollen|balance|credit/i.test(detail))
        r = await fetch('https://gen.pollinations.ai/v1/audio/speech', {method:'POST', headers:{'Content-Type':'application/json', ...(k ? {Authorization:'Bearer ' + k} : {})}, body: JSON.stringify({model:'openai/tts-1', input:text, voice})});
    }
  } catch(e){ throw new Error('เชื่อมต่อบริการเสียง AI ไม่ได้ — ตรวจอินเทอร์เน็ต'); }
  if (!r.ok){
    detail = (await r.clone().text().catch(() => '')) || detail;
    if (r.status === 402 || /pollen|balance|credit|insufficient/i.test(detail)){ Q.mark('pollinations', detail.slice(0, 200), 0); throw new Error(quotaText('pollinations') + ' · เลือก “เสียง AI ฟรีในเครื่อง” แทนได้'); }
    if (r.status === 401 || r.status === 403) throw new Error(k ? 'คีย์ Pollinations ไม่ถูกต้อง — ตรวจในตั้งค่า' : 'ต้องใส่คีย์ Pollinations ก่อน — หรือเลือก “เสียง AI ฟรีในเครื่อง” แทน');
    if (r.status === 429){ const ra = +r.headers.get('retry-after') || 60; Q.mark('pollinations', 'rate limit', ra); throw new Error(quotaText('pollinations')); }
    throw new Error(`เสียง AI ล้มเหลว (${r.status}) ${detail.slice(0,120)}`);
  }
  Q.clear('pollinations');
  const b = await r.blob();
  if (b.size < 800) throw new Error('ได้ไฟล์เสียงว่างเปล่า ลองใหม่อีกครั้ง');
  return b.type ? b : new Blob([b], {type:'audio/mpeg'});
}

/* ---------------- Gradio connections: Hugging Face Spaces or "my computer" server ---------------- */
let gradio = null; const GC = {};
const plabel = p => ((p.label || '') + ' ' + (p.parameter_name || '')).toLowerCase();
const isUrl = t => /^https?:\/\//.test(t);
async function gconnect(target){
  if (!target) throw new Error('ยังไม่ได้ตั้งค่า “คอมของฉัน” — ไปที่ ขั้นสูง › ประมวลผล');
  const key = target + '|' + (isUrl(target) ? '' : S.hfToken);
  if (GC[key]) return GC[key];
  try { gradio ||= await import('https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js'); }
  catch(e){ throw new Error('โหลดตัวเชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ต'); }
  try {
    const client = await gradio.Client.connect(target, (!isUrl(target) && S.hfToken) ? {hf_token: S.hfToken.trim()} : {});
    return GC[key] = {client, plans: {}};
  } catch(e){
    throw new Error(isUrl(target) ? `เชื่อมต่อคอมของฉันไม่ได้ — ตรวจว่าเปิดเซิร์ฟเวอร์อยู่ และลิงก์ยังไม่หมดอายุ (${e.message || e})` : `เชื่อมต่อ ${target} ไม่ได้ — Space อาจกำลังหลับ ลองใหม่ใน 1–2 นาที (${e.message || e})`);
  }
}
function gradioErr(e, target, what){
  const m = String(e?.message || e?.title || (typeof e === 'object' ? JSON.stringify(e) : e));
  if (!isUrl(target) && /quota|ZeroGPU|exceeded|GPU (task|duration)/i.test(m)){
    const t = m.match(/(\d+):(\d{2}):(\d{2})/), s2 = m.match(/(\d+)\s*s(?:ec|econds?)?\b.*(?:left|retry|again)/i);
    const sec = t ? (+t[1])*3600 + (+t[2])*60 + (+t[3]) : null;
    Q.mark('hf', m.slice(0, 200), sec);
    return new Error(quotaText('hf') + ' · สลับไปใช้คอมของฉัน หรือใส่ HF token ในตั้งค่าเพื่อได้โควตาเพิ่ม');
  }
  return new Error(what + 'ล้มเหลว: ' + m.slice(0, 160));
}
async function serverInfo(){
  const g = await gconnect(S.serverUrl);
  const r = await g.client.predict('/info', []);
  SERVER_INFO = JSON.parse(r.data[0]); LS.set('serverInfo', SERVER_INFO); return SERVER_INFO;
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
    if (/basic|clone_tts/i.test(name)) s += 2;
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
const cloneTarget = () => S.cloneEngine === 'server' ? S.serverUrl : S.space.trim();
function cloneBaseVoice(){
  const list = commercialVoices();
  return list.find(c => S.cloneBase && c.type === S.cloneBase.type && c.id === S.cloneBase.id) || list.find(c => /^m/i.test(c.g)) || list[0] || null;
}
async function openVoiceTTS(text, rec){
  if (!S.serverUrl) throw new Error('OpenVoice รันบน “คอมของฉัน” — เชื่อมต่อคอมก่อน (ขั้นสูง › ประมวลผล)');
  const base = cloneBaseVoice();
  if (!base) throw new Error('ต้องตั้งค่า Google Cloud หรือ Azure ก่อน (ใช้เป็นเสียงต้นทางที่ถูกลิขสิทธิ์)');
  const src = await synthesize(base, text);
  const g = await gconnect(S.serverUrl);
  const t0 = performance.now();
  let res;
  try { res = await g.client.predict('/convert_voice', [gradio.handle_file(new File([src], 'src.mp3', {type: src.type})), gradio.handle_file(new File([rec.blob], 'ref.wav', {type: rec.blob.type || 'audio/wav'})), 0.3]); }
  catch(e){ throw gradioErr(e, S.serverUrl, 'OpenVoice '); }
  SPEED.learn('clone-openvoice', (performance.now() - t0) / Math.max(1, text.length));
  const out = (res.data || []).find(x => x && (typeof x === 'string' || x.url));
  const url = typeof out === 'string' ? out : out?.url;
  if (!url) throw new Error('คอมไม่ได้ส่งเสียงกลับมา (อัปเดตเซิร์ฟเวอร์: git pull)');
  const r = await fetch(url); if (!r.ok) throw new Error('ดาวน์โหลดเสียงไม่ได้ (' + r.status + ')');
  return r.blob();
}
async function cloneTTS(text, rec){
  if (!rec) throw new Error('ไม่พบเสียงโคลนนี้แล้ว');
  if (cloneMode() === 'openvoice') return openVoiceTTS(text, rec);
  const target = cloneTarget();
  if (!isUrl(target) && Q.hit('hf')) throw new Error(quotaText('hf'));
  const g = await gconnect(target), c = g.client;
  if (!g.plans.clone){ g.plans.clone = planFromApi(await c.view_api()); if (!g.plans.clone) throw new Error('ปลายทางนี้ไม่มีช่อง “เสียงต้นแบบ + ข้อความ → เสียง” ให้เรียกใช้'); }
  const plan = g.plans.clone;
  const args = plan.ps.map(p => {
    if (/audio|file/i.test(p.component)) return gradio.handle_file(rec.blob);
    if (p === plan.gen) return text;
    if (p === plan.ref) return rec.refText || '';
    if (/speed/.test(plabel(p)) && /slider|number/i.test(p.component)) return 1;
    if (p.parameter_has_default) return p.parameter_default;
    if (p.example_input !== undefined) return p.example_input;
    if (/checkbox/i.test(p.component)) return false;
    return null;
  });
  const t0 = performance.now();
  let res;
  try { res = await c.predict(plan.name, args); } catch(e){ throw gradioErr(e, target, 'โคลนเสียง'); }
  if (!isUrl(target)) Q.clear('hf');
  SPEED.learn(isUrl(target) ? 'clone-server' : 'clone-hf', (performance.now() - t0) / Math.max(1, text.length));
  const out = (res.data || []).find(x => x && (typeof x === 'string' || x.url || x.path));
  const url = typeof out === 'string' ? out : (out?.url || (out?.path && `${c.config?.root || ''}/file=${out.path}`));
  if (!url) throw new Error('ปลายทางไม่ได้ส่งไฟล์เสียงกลับมา');
  const r = await fetch(url, (!isUrl(target) && S.hfToken) ? {headers:{Authorization:'Bearer ' + S.hfToken.trim()}} : {});
  if (!r.ok) throw new Error('ดาวน์โหลดเสียงไม่ได้ (' + r.status + ')');
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
async function buildFile(quiet){
  const text = ta.value.trim(); if (!text) { toast('ใส่ข้อความก่อนนะ'); return null; }
  const v = curVoice();
  if (v.type === 'device'){
    if (quiet) return null;
    openSheet(sheetHead('บันทึกเสียงเป็นไฟล์') + `<p class="lim">เสียงในเครื่องเล่นได้อย่างเดียว เบราว์เซอร์<b>ไม่อนุญาตให้อัดเป็นไฟล์</b><br>เปลี่ยนเป็น <b>เสียง AI</b> หรือ <b>เสียงโคลน</b> เพื่อดาวน์โหลดเป็น MP3/WAV ได้</p><button class="btn" style="width:100%" id="swAi">ใช้เสียง AI (Nova)</button>`,
      el => el.querySelector('#swAi').onclick = () => { S.voice = {type:'ai', id:'nova'}; save(); renderVoice(); closeAll(); if (!S.polKey) openSettings(true); });
    return null;
  }
  if (S.commercial && !allowed(voiceLicKey(v))){
    if (quiet) return null;
    openSheet(sheetHead('💼 โหมดเชิงพาณิชย์') + `<p class="lim">เสียง “${esc(v.name)}” — ${esc(lic(voiceLicKey(v)).t)}<br>จึง<b>ไม่ให้ดาวน์โหลด/แชร์/บันทึก</b>เพื่อป้องกันการนำไปใช้หารายได้โดยผิดสัญญาอนุญาต</p>
      <button class="btn" style="width:100%" id="cmPick">เลือกเสียง 💼 (Google / Azure)</button><button class="btn alt" style="width:100%;margin-top:8px" id="cmOff">ปิดโหมดเชิงพาณิชย์ (ใช้ส่วนตัว)</button>`, el => {
      el.querySelector('#cmPick').onclick = () => { closeAll(); setTimeout(() => $('#btnVoice').click(), 250); };
      el.querySelector('#cmOff').onclick = () => { S.commercial = false; save(); renderEngines(); renderVoice(); closeAll(); toast('ปิดโหมดเชิงพาณิชย์แล้ว — ลองกดอีกครั้ง'); };
    });
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
$('#dkSave').onclick = async () => { const f = await buildFile(); if (f) { saveBlob(f, f.name); toast('ดาวน์โหลดแล้ว: ' + f.name); saveToMac(f, 'audio', ta.value.trim().slice(0, 40)); } };
$('#dkShare').onclick = async () => {
  const text = ta.value.trim();
  try {
    if (curVoice().type !== 'device'){
      const f = await buildFile(); if (!f) return;
      saveToMac(f, 'audio', text.slice(0, 40));
      return await shareFiles([f], 'เสียงจาก AI Voice');
    }
    if (navigator.share) return await navigator.share({title:'AI Voice', text: text ? text.slice(0, 2000) : 'แอปแปลงข้อความเป็นเสียง', url: location.href.split('#')[0]});
    await navigator.clipboard.writeText(location.href.split('#')[0]); toast('คัดลอกลิงก์แอปแล้ว');
  } catch(e){ if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ', true); }
};

/* ---------------- save to Mac + share (Android share sheet → Google Drive) ---------------- */
const extOf = t => /png/.test(t) ? 'png' : /webp/.test(t) ? 'webp' : /wav/.test(t) ? 'wav' : /mpeg|mp3/.test(t) ? 'mp3' : /jpe?g/.test(t) ? 'jpg' : 'bin';
const macSaved = new WeakSet();
async function saveToMac(blob, kind, name){
  if (!S.serverUrl || !S.macSave || !blob || macSaved.has(blob)) return;
  macSaved.add(blob);
  try {
    const g = await gconnect(S.serverUrl);
    const file = blob instanceof File ? blob : new File([blob], `ai-voice.${extOf(blob.type)}`, {type: blob.type});
    const r = await g.client.predict('/save_file', [gradio.handle_file(file), kind, (name || '').slice(0, 60)]);
    const path = String(r.data?.[0] || '');
    toast('💾 บันทึกลง Mac แล้ว: ' + path.split('/').slice(-3).join('/'));
  } catch(e){ macSaved.delete(blob); toast('บันทึกลง Mac ไม่สำเร็จ: ' + (e.message || e), true); }
}
let driveTipShown = LS.get('driveTip', false);
async function shareFiles(files, title){
  files = files.filter(Boolean);
  if (!files.length) return;
  if (navigator.canShare?.({files})){
    if (!driveTipShown && /Android/i.test(navigator.userAgent)){ driveTipShown = true; LS.set('driveTip', true); toast('เลือก “ไดรฟ์” (Google Drive) ในหน้าแชร์ เพื่อบันทึกขึ้น Drive', false); await sleep(900); }
    try { await navigator.share({files, title}); } catch(e){ if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ: ' + e.message, true); }
    return;
  }
  files.forEach(f => saveBlob(f, f.name));
  toast('อุปกรณ์/เบราว์เซอร์นี้แชร์ไฟล์ตรงไม่ได้ จึงดาวน์โหลดให้แทน — อัปโหลดขึ้น Drive จากแอป Files ได้');
}
const asFile = (blob, base) => blob instanceof File ? blob : new File([blob], `${base}-${stamp()}.${extOf(blob.type)}`, {type: blob.type || 'application/octet-stream'});

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
      ${it.kind === 'image' ? `<img src="${esc(it.url || (it.blob ? URL.createObjectURL(it.blob) : ''))}" alt="" loading="lazy">` : `<span class="ib"><svg class="i"><use href="#${ic[it.kind]}"/></svg></span>`}
      <div class="t"><b>${esc((it.text || it.prompt || '').slice(0, 80))}</b><small>${when(it.created)} · ${it.kind === 'image' ? 'ภาพ' : esc(it.voice || '')}${it.kind === 'audio' ? ' · มีไฟล์เสียง' : ''}</small></div>
      ${it.blob ? `<button class="ib" data-sh aria-label="แชร์ / Google Drive"><svg class="i"><use href="#i-share"/></svg></button><button class="ib" data-dl aria-label="ดาวน์โหลด"><svg class="i"><use href="#i-down"/></svg></button>` : ''}
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
      row.querySelector('[data-dl]')?.addEventListener('click', () => { const f = asFile(it.blob, it.kind === 'image' ? 'ai-image' : 'ai-voice'); saveBlob(f, f.name); });
      row.querySelector('[data-sh]')?.addEventListener('click', () => shareFiles([asFile(it.blob, it.kind === 'image' ? 'ai-image' : 'ai-voice')], (it.text || it.prompt || '').slice(0, 80)));
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
    <h4>💼 Google Cloud Text-to-Speech (เชิงพาณิชย์ได้)</h4>
    <input class="inp" id="kG" placeholder="API key (AIza…)" value="${esc(S.gKey)}" autocomplete="off">
    <p class="hint">ฟรีทุกเดือน: Standard/WaveNet 4 ล้าน · Chirp3 HD/Neural2 1 ล้านตัวอักษร (ต้องผูกบัตร คิดเงินเฉพาะส่วนเกิน) — ใช้ไปเดือนนี้ (นับในเครื่องนี้): Standard ${usageGet('gcloud-std').toLocaleString('th-TH')} · พรีเมียม ${usageGet('gcloud-premium').toLocaleString('th-TH')}<br>วิธีสมัคร: <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" target="_blank" rel="noopener">เปิด Cloud Text-to-Speech API</a> → APIs &amp; Services › Credentials › Create API key → จำกัดคีย์ให้ใช้ได้เฉพาะ Text-to-Speech API และเว็บ mengnattawitmarin.github.io</p>
    <h4>💼 Microsoft Azure Speech (เชิงพาณิชย์ได้)</h4>
    <div class="row2"><input class="inp" id="kAz" placeholder="Speech key" value="${esc(S.azKey)}" autocomplete="off"><select class="inp" id="kAzR" style="max-width:150px">${['southeastasia','eastasia','japaneast','eastus','westeurope'].map(r => `<option ${S.azRegion === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
    <p class="hint">ระดับฟรี (F0): 0.5 ล้านตัวอักษร/เดือน ไม่คิดเงิน — ใช้ไปเดือนนี้: ${usageGet('azure').toLocaleString('th-TH')} · วิธีสมัคร: <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" target="_blank" rel="noopener">สร้าง Speech resource</a> (Pricing tier: Free F0, Region: Southeast Asia) → Keys and Endpoint</p>
    <label class="check"><input type="checkbox" id="kOver" ${S.allowOverFree ? 'checked' : ''}><span>ยอมใช้เกินโควตาฟรี (Google จะคิดเงินส่วนที่เกิน) — ปกติแอปจะหยุดให้เองเมื่อครบ</span></label>
    <h4>เสียง AI + สร้างภาพ — Pollinations ❔</h4>
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
    const apply = () => { S.gKey = el.querySelector('#kG').value.trim(); S.azKey = el.querySelector('#kAz').value.trim(); S.azRegion = el.querySelector('#kAzR').value; S.allowOverFree = el.querySelector('#kOver').checked; S.polKey = el.querySelector('#kPol').value.trim(); S.hfToken = el.querySelector('#kHf').value.trim(); S.space = (sp.value === '__custom' ? spc.value : sp.value).trim() || SPACES[0][0]; save(); };
    el.querySelector('#kSave').onclick = () => { apply(); renderVoice(); renderEngines(); closeAll(); toast('บันทึกแล้ว'); loadCloudVoices(); };
    el.querySelector('#kTest').onclick = async () => {
      apply(); const m = el.querySelector('#kMsg'); m.textContent = 'กำลังเชื่อมต่อ ' + S.space + '…';
      try { const g = await gconnect(S.space.trim()); const plan = g.plans.clone = planFromApi(await g.client.view_api());
        m.innerHTML = plan ? `<span style="color:var(--ok)">เชื่อมต่อได้ ✓ ใช้ endpoint ${esc(plan.name)}</span>` : '<span style="color:var(--err)">เชื่อมต่อได้ แต่ไม่พบช่องโคลนเสียง</span>';
      } catch(e){ m.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`; }
    };
    el.querySelector('#kClrH').onclick = async () => { await db.clear('history'); toast('ล้างประวัติแล้ว'); };
    el.querySelector('#kClrC').onclick = async () => { await db.clear('clones'); clones = []; if (S.voice?.type === 'clone') S.voice = null; save(); renderVoice(); toast('ลบเสียงโคลนแล้ว'); };
  });
}
/* ---------------- processing: API vs this device vs my computer ---------------- */
const licIcon = k => { const l = lic(k); return l.ok ? '💼 ' : l.ok === false ? '🚫 ' : '❔ '; };
function renderEngines(){
  const hfOut = Q.hit('hf') ? ' · โควตาหมด' : '';
  const gate = (k, fn) => v => { if (!allowed(k(v))){ toast('โหมดเชิงพาณิชย์: ' + lic(k(v)).t + ' — ปิดโหมดได้ที่การ์ดเลือกเสียง', true); renderEngines(); return; } fn(v); };
  chips($('#imgEngine'), [['flux', licIcon('img-flux') + 'FLUX · ไม่มีลายน้ำ' + hfOut],['pol', licIcon('img-pol') + 'Pollinations' + (Q.hit(S.polKey ? 'pollinations' : 'polfree') ? ' · โควตาหมด' : '')],['server', licIcon('img-server') + 'คอมของฉัน']], S.imgEngine,
    gate(v => 'img-' + v, v => { S.imgEngine = v; if (v === 'server' && !S.serverUrl) openProc(); renderEst(); renderQuota(); }));
  chips($('#cloneEngine'), [['openvoice', licIcon('clone-openvoice') + 'OpenVoice (คอมของฉัน)'],['hf', licIcon('clone-hf') + 'F5 · API Hugging Face' + hfOut],['server', licIcon('clone-server') + 'F5 · คอมของฉัน']], S.cloneEngine,
    gate(v => 'clone-' + v, v => { S.cloneEngine = v; if (v !== 'hf' && !S.serverUrl) openProc(); renderEst(); renderQuota(); renderVoice(); renderCloneBase(); }));
  renderCloneBase();
}
function renderCloneBase(){
  const sel = $('#cloneBase'); if (!sel) return;
  const box = $('#cloneBaseBox'); box.hidden = cloneMode() !== 'openvoice';
  const list = commercialVoices(), cur = cloneBaseVoice();
  sel.innerHTML = list.length ? list.map(c => `<option value="${c.type}:${esc(c.id)}" ${cur && cur.type === c.type && cur.id === c.id ? 'selected' : ''}>${c.type === 'gcloud' ? 'Google · ' + esc(gPretty(c.id)) : 'Azure · ' + esc(azPretty(c.id))} (${genderTh(c.g)})</option>`).join('') : '<option value="">— ตั้งค่า Google Cloud หรือ Azure ก่อน —</option>';
  sel.onchange = () => { const [t, ...id] = sel.value.split(':'); S.cloneBase = t ? {type:t, id:id.join(':')} : null; save(); };
}
async function openProc(){
  const sp = await getSpec();
  const gpuTxt = sp.gpu ? `มี (WebGPU${sp.gpu.vendor ? ' · ' + esc(sp.gpu.vendor) : ''}${sp.gpu.arch ? ' ' + esc(sp.gpu.arch) : ''})` : 'ไม่รองรับในเบราว์เซอร์นี้ (ใช้ CPU แทน)';
  const est = (k, chars) => { const v = speedOf(k); return `~${fmtDur(chars * v.v / 1000)}${v.measured ? ' (วัดจริง)' : ''}`; };
  const imgE = k => { const v = speedOf(k); return `~${fmtDur(v.v / 1000)}/ภาพ${v.measured ? ' (วัดจริง)' : ''}`; };
  const opt = (grp, val, cur, title, sub, dis) => `<button class="opt ${val === cur ? 'on' : ''}" data-g="${grp}" data-v="${val}" ${dis ? 'disabled style="opacity:.45"' : ''}><span class="dot"></span><span class="t"><b>${title}</b><small>${sub}</small></span></button>`;
  const qtag = k => Q.hit(k) ? ` <span class="tag warn">โควตาหมด</span>` : '';
  openSheet(sheetHead('ประมวลผล & สเปคเครื่อง') + `
    <div class="item" style="display:block"><b>เครื่องนี้: ${esc(sp.os)}${sp.mobile ? ' (มือถือ/แท็บเล็ต)' : ''}</b>
      <small style="display:block;color:var(--mut);margin-top:4px;line-height:1.7">CPU ${sp.cores} คอร์ · RAM ${sp.mem ? '~' + sp.mem + ' GB' : 'ไม่ทราบ (เบราว์เซอร์ไม่บอก)'}<br>GPU: ${gpuTxt}${sp.net ? '<br>เน็ตประมาณ ' + sp.net + ' Mbps' : ''}</small></div>
    <p class="hint">เวลาด้านล่างคิดจากข้อความ 1,000 ตัวอักษร (ฟังประมาณ 1.3 นาที) — เป็นค่าประมาณจากสเปค และจะแม่นขึ้นเองหลังใช้งานจริง</p>
    <h4>เสียง AI ฟรีในเครื่อง — ประมวลผลบน</h4>
    ${opt('localDev','auto',S.localDev || 'auto','อัตโนมัติ (แนะนำ)', 'ใช้ GPU ถ้ามี ไม่งั้นใช้ CPU · ' + est('local-' + (sp.gpu ? 'webgpu' : 'wasm'), 1000))}
    ${opt('localDev','webgpu',S.localDev,'GPU (WebGPU)', sp.gpu ? 'เร็วที่สุด · ' + est('local-webgpu', 1000) : 'เบราว์เซอร์นี้ไม่รองรับ', !sp.gpu)}
    ${opt('localDev','wasm',S.localDev,'CPU', 'ช้ากว่าแต่เสถียร ใช้ได้ทุกเครื่อง · ' + est('local-wasm', 1000))}
    <p class="hint">เสียง AI แบบ API (Pollinations): ${est('ai', 1000)}${qtag('pollinations')}</p>
    <label class="switch" style="margin:14px 0 4px"><span>💼 โหมดเชิงพาณิชย์<br><small style="color:var(--mut)">อนุญาตเฉพาะตัวเลือกที่ใช้หารายได้ได้</small></span><input type="checkbox" id="pComm" ${S.commercial ? 'checked' : ''}></label>
    <h4>โคลนเสียง — ใช้</h4>
    ${opt('cloneEngine','openvoice',S.cloneEngine,'OpenVoice บนคอมของฉัน ' + licTag('clone-openvoice'), 'เสียงต้นทาง Google/Azure → แปลงเป็นเสียงของคุณ · ' + (S.serverUrl ? est('clone-openvoice', 1000) : 'ต้องเปิดเซิร์ฟเวอร์บนคอมก่อน'), !allowed('clone-openvoice'))}
    ${opt('cloneEngine','hf',S.cloneEngine,'F5 · API Hugging Face ' + licTag('clone-hf') + qtag('hf'), est('clone-hf', 1000) + ' + รอคิว · ' + (Q.hit('hf') ? esc(quotaText('hf')) : 'ไม่ต้องติดตั้งอะไร'), !allowed('clone-hf'))}
    ${opt('cloneEngine','server',S.cloneEngine,'F5 · คอมของฉัน ' + licTag('clone-server'), S.serverUrl ? est('clone-server', 1000) + ' · ไม่มีโควตา' : 'ต้องเปิดเซิร์ฟเวอร์บนคอมก่อน (ดูด้านล่าง)', !allowed('clone-server'))}
    <p class="hint">โคลนเสียงรันในมือถือ/เบราว์เซอร์ไม่ได้ เพราะโมเดลใหญ่หลาย GB</p>
    <h4>สร้างภาพ — ใช้</h4>
    ${opt('imgEngine','flux',S.imgEngine,'API FLUX (ไม่มีลายน้ำ) ' + licTag('img-flux') + qtag('hf'), imgE('img-flux') + ' + รอคิว', !allowed('img-flux'))}
    ${opt('imgEngine','pol',S.imgEngine,'API Pollinations ' + licTag('img-pol') + qtag(S.polKey ? 'pollinations' : 'polfree'), imgE('img-pol') + (S.polKey ? '' : ' · ไม่มีคีย์: รอ 15 วิ/ภาพ อาจมีลายน้ำ'), !allowed('img-pol'))}
    ${opt('imgEngine','server',S.imgEngine,'คอมของฉัน (Segmind-Vega, ไม่มีลายน้ำ) ' + licTag('img-server'), S.serverUrl ? imgE('img-server') + ' · ไม่มีโควตา' : 'ต้องเปิดเซิร์ฟเวอร์บนคอมก่อน', !allowed('img-server'))}
    <h4>คอมของฉัน (Mac / PC)</h4>
    <div class="row2"><input class="inp" id="srvUrl" placeholder="https://xxxx.gradio.live" value="${esc(S.serverUrl)}" autocomplete="off"><button class="btn" id="srvTest">เชื่อม</button></div>
    <p class="hint" id="srvMsg">${SERVER_INFO && S.serverUrl ? `ล่าสุด: ${esc(SERVER_INFO.chip || '')} · ${esc(SERVER_INFO.device)} · RAM ${SERVER_INFO.ram_gb || '?'} GB` : ''}</p>
    <ol class="lim" style="padding-left:18px;font-size:13.5px">
      <li>บน Mac: ติดตั้ง <b>Homebrew</b> แล้วรัน <code>brew install python@3.11 ffmpeg git</code></li>
      <li><code>git clone https://github.com/mengnattawitmarin/ai-voice</code></li>
      <li><code>cd ai-voice/server && ./start-mac.sh</code> (ครั้งแรกติดตั้ง+โหลดโมเดลหลาย GB)</li>
      <li>สแกน QR ที่ขึ้นในหน้าต่าง Terminal ด้วยมือถือ หรือคัดลอกลิงก์ <code>https://…gradio.live</code> มาวางด้านบน</li>
    </ol>
    <label class="switch" style="margin-top:4px"><span>บันทึกภาพและเสียงลง Mac อัตโนมัติ<br><small style="color:var(--mut)" id="macDir">${SERVER_INFO?.save_dir ? 'โฟลเดอร์: ' + esc(SERVER_INFO.save_dir) : 'เชื่อมต่อเพื่อดูโฟลเดอร์'}</small></span><input type="checkbox" id="macSave" ${S.macSave ? 'checked' : ''}></label>
    <button class="btn alt sm" id="macPick" style="margin-top:10px">เปลี่ยนโฟลเดอร์ (เลือกบนหน้าจอ Mac)</button>
    <p class="hint">ไฟล์จะถูกจัดเป็น <code>โฟลเดอร์ที่เลือก/images/วันที่</code> และ <code>/audio/วันที่</code></p>
    <p class="hint">Mac รุ่น M1/M2/M3 ใช้ GPU ผ่าน Metal อัตโนมัติ · ลิงก์ gradio.live เปลี่ยนทุกครั้งที่เปิดเซิร์ฟเวอร์ใหม่ (สแกน QR ใหม่) · ต้องเปิดคอมค้างไว้ตอนใช้</p>
    <button class="btn alt sm" id="toKeys" style="margin-top:6px">ตั้งค่าคีย์ API…</button>`,
  el => {
    el.querySelectorAll('.opt[data-g]').forEach(b => b.onclick = () => {
      if (b.disabled) return;
      const g = b.dataset.g, v = b.dataset.v;
      if (v === 'server' && !S.serverUrl){ toast('วางลิงก์คอมของฉันด้านล่างก่อน'); el.querySelector('#srvUrl').focus(); }
      S[g] = v; save();
      el.querySelectorAll(`.opt[data-g="${g}"]`).forEach(x => x.classList.toggle('on', x === b));
      renderEngines(); renderVoice(); renderQuota();
    });
    el.querySelector('#srvTest').onclick = async () => {
      const m = el.querySelector('#srvMsg'); let u = el.querySelector('#srvUrl').value.trim().replace(/\/+$/, '');
      if (u && !isUrl(u)) u = 'https://' + u;
      S.serverUrl = u; save(); if (!u){ m.textContent = ''; return; }
      m.textContent = 'กำลังเชื่อมต่อ…';
      try { const i = await serverInfo(); el.querySelector('#macDir').textContent = 'โฟลเดอร์: ' + (i.save_dir || '?'); m.innerHTML = `<span style="color:var(--ok)">เชื่อมต่อได้ ✓ ${esc(i.chip || '')} · ${esc(i.device === 'mps' ? 'GPU Apple (Metal)' : i.device === 'cuda' ? 'GPU NVIDIA' : 'CPU')} · RAM ${i.ram_gb || '?'} GB</span>`; renderEst(); }
      catch(e){ m.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`; }
    };
    el.querySelector('#toKeys').onclick = () => openSettings();
    el.querySelector('#pComm').onchange = e => { S.commercial = e.target.checked; enforceCommercial(); save(); renderEngines(); renderVoice(); openProc(); };
    el.querySelector('#macSave').onchange = e => { S.macSave = e.target.checked; save(); };
    el.querySelector('#macPick').onclick = async () => {
      if (!S.serverUrl) return toast('เชื่อมต่อคอมของฉันก่อน', true);
      const d = el.querySelector('#macDir'); d.textContent = 'ไปที่หน้าจอ Mac แล้วเลือกโฟลเดอร์ในหน้าต่างที่เด้งขึ้น…';
      try { const g = await gconnect(S.serverUrl); const r = await g.client.predict('/choose_folder', []); const path = String(r.data?.[0] || '');
        if (SERVER_INFO) { SERVER_INFO.save_dir = path; LS.set('serverInfo', SERVER_INFO); }
        d.textContent = 'โฟลเดอร์: ' + path; toast('ตั้งโฟลเดอร์เก็บงานบน Mac แล้ว');
      } catch(e){ d.textContent = 'เปลี่ยนโฟลเดอร์ไม่สำเร็จ: ' + (e.message || e); }
    };
  });
}
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
function openInstall(){
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openSheet(sheetHead('ติดตั้งเป็นแอป (Android / Mac)') + (standalone ? '<p class="lim">ติดตั้งแล้ว ✓ เปิดจากไอคอนบนหน้าจอได้เลย</p>' : `
    ${installEvt ? '<button class="btn" style="width:100%" id="doInstall">ติดตั้งแอป</button>' : ''}
    <ol class="lim"><li><b>Android (Chrome):</b> แตะ ⋮ มุมขวาบน → <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b></li>
    <li><b>MacBook (Chrome):</b> ⋮ → <b>แคสต์ บันทึก และแชร์</b> → <b>ติดตั้งหน้าเว็บเป็นแอป</b> (หรือไอคอนติดตั้งท้ายช่อง URL)</li>
    <li><b>MacBook (Safari, macOS 14+):</b> เมนู <b>ไฟล์</b> → <b>เพิ่มไปยัง Dock</b></li>
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
    <li class="m">△ เสียง AI ฟรีในเครื่อง (หญิง 2 · ชาย 4): โหลดโมเดล ~115MB ต่อเสียงครั้งแรก แล้วใช้ออฟไลน์ได้ · โมเดล MMS เป็นสัญญาอนุญาต CC-BY-NC (ห้ามใช้เชิงพาณิชย์) มือถือรุ่นเก่าอาจช้า ตัวเลข/คำอังกฤษในข้อความไทยอาจอ่านไม่ถูก</li>
    <li class="y">✓ โคลนเสียงจากคลิป 6–15 วินาที ผ่าน F5-TTS บน Hugging Face (ฟรี)</li>
    <li class="y">✓ สร้างภาพจากข้อความ 8 สไตล์ 4 สัดส่วน ดาวน์โหลด/แชร์ได้</li>
    <li class="y">✓ ประวัติการใช้งาน · ติดตั้งเป็นแอปบนมือถือ (PWA)</li>
    <li class="m">△ เสียงในเครื่อง: ฟรี/ออฟไลน์ แต่<b>บันทึกเป็นไฟล์ไม่ได้</b> คุณภาพขึ้นกับรุ่นมือถือ</li>
    <li class="m">△ เสียง AI อ่านไทยได้ แต่สำเนียงยังไม่เหมือนคนไทย 100% · เครดิตฟรีมีจำกัดต่อวัน</li>
    <li class="m">△ โคลนเสียง: ช้า (รอคิว GPU ฟรี) โควตาจำกัด Space อาจปิด/เปลี่ยนได้ทุกเมื่อ คุณภาพภาษาไทยยังไม่สมบูรณ์ ข้อความยาวจะใช้เวลานานมาก</li>
    <li class="y">✓ สร้างภาพด้วย FLUX บน Hugging Face: ฟรี ไม่มีลายน้ำ (ใช้โควตา GPU ฟรี ถ้าหมดจะสลับไป Pollinations ให้เอง)</li>
    <li class="m">△ Pollinations โหมดฟรี: 1 ภาพ/~15 วินาที อาจมีลายน้ำ · คำสั่งภาษาไทยได้ผลน้อยกว่าอังกฤษ (FLUX ยิ่งต้องใช้อังกฤษ)</li>
    <li class="y">✓ โหมดเชิงพาณิชย์ 💼: เสียง Google Cloud / Azure (ไทย ชาย-หญิง), โคลนด้วย OpenVoice (MIT), ภาพ FLUX (Apache 2.0) / Segmind-Vega (Apache 2.0)</li>
    <li class="m">△ “ใช้หารายได้ได้” หมายถึงสัญญาอนุญาตของโมเดล/บริการอนุญาต — ยังต้องทำตามเงื่อนไขบริการ นโยบายแพลตฟอร์ม (YouTube/TikTok) และกฎหมาย ไม่ใช่คำปรึกษากฎหมาย</li>
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
renderEngines();
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
async function shotFile(div, url){
  if (div._file) return div._file;
  const b = await (await fetch(url)).blob();
  return div._file = asFile(b, 'ai-image');
}
function shotActions(div, url, prompt){
  div.querySelector('[data-dl]').onclick = async () => {
    try { const f = await shotFile(div, url); saveBlob(f, f.name); } catch(e){ window.open(url, '_blank'); }
  };
  div.querySelector('[data-sh]').onclick = async () => {
    try { await shareFiles([await shotFile(div, url)], prompt.slice(0, 80)); } catch(e){ toast('แชร์ไม่สำเร็จ', true); }
  };
  div.querySelector('[data-re]').onclick = () => renderShot(div, prompt, Math.floor(Math.random() * 1e9));
}
/* image via Gradio: FLUX.1-schnell on Hugging Face (free, no watermark) or "my computer" (SD-Turbo) */
const FLUX_SPACE = 'black-forest-labs/FLUX.1-schnell';
async function gradioImage(target, prompt, seed){
  const g = await gconnect(target), c = g.client;
  if (!g.plans.img){
    const api = await c.view_api();
    const eps = Object.entries(api.named_endpoints || {}).filter(([n, ep]) => (ep.returns || []).some(r => /image/i.test(r.component || '')));
    const hit = eps.find(([n]) => /infer|txt2img/i.test(n)) || eps[0];
    if (!hit) throw new Error('ปลายทางนี้ไม่มีช่องสร้างภาพ');
    g.plans.img = {name: hit[0], ps: hit[1].parameters || []};
  }
  const plan = g.plans.img;
  const st = IMG_STYLES.find(x => x[0] === S.imgStyle)?.[2], [, w, h] = RATIOS.find(r => r[0] === S.imgRatio) || RATIOS[0];
  const full = prompt + (st ? ', ' + st : '');
  const args = plan.ps.map(p => {
    const n = plabel(p);
    if (/prompt/.test(n) && !/neg/.test(n)) return full;
    if (/randomize/.test(n)) return false;
    if (/seed/.test(n)) return seed % 2147483647;
    if (/width/.test(n)) return w;
    if (/height/.test(n)) return h;
    if (/steps/.test(n)) return isUrl(target) ? 2 : 4;
    if (p.parameter_has_default) return p.parameter_default;
    return p.example_input ?? null;
  });
  let res;
  try { res = await c.predict(plan.name, args); } catch(e){ throw gradioErr(e, target, 'สร้างภาพ'); }
  if (!isUrl(target)) Q.clear('hf');
  const out = (res.data || []).find(x => x && (typeof x === 'string' || x.url || x.path));
  const url = typeof out === 'string' ? out : out?.url;
  if (!url) throw new Error('ปลายทางไม่ได้ส่งภาพกลับมา');
  const r = await fetch(url); if (!r.ok) throw new Error('ดาวน์โหลดภาพไม่ได้ (' + r.status + ')');
  return r.blob();
}
/* Pollinations image: fetch so we can read quota errors; fall back to <img> if CORS blocks */
async function polImage(prompt, seed, msg){
  const tryUrl = async (url, k) => {
    let r; const ac = new AbortController(), t = setTimeout(() => ac.abort(), 120000);
    try { r = await fetch(url, {signal: ac.signal}); } catch(e){ clearTimeout(t); if (e.name === 'AbortError') throw new Error('หมดเวลา'); const im = await loadImg(url); return {im, url}; }
    clearTimeout(t);
    if (!r.ok){
      const d = await r.text().catch(() => '');
      if (k === 'pollinations' && (r.status === 402 || /pollen|balance|credit|insufficient/i.test(d))) Q.mark('pollinations', d.slice(0, 200), 0);
      else if (r.status === 429) Q.mark(k, 'rate limit', +r.headers.get('retry-after') || 60);
      const e = new Error(r.status === 429 ? quotaText(k) : 'สร้างภาพไม่สำเร็จ (' + r.status + ')'); e.status = r.status; throw e;
    }
    Q.clear(k);
    const blob = await r.blob(), u = URL.createObjectURL(blob);
    return {im: await loadImg(u), url: u, blob};
  };
  if (S.polKey && !Q.hit('pollinations')){
    try { return await tryUrl(imgUrl(prompt, seed), 'pollinations'); }
    catch(e){ msg('คีย์ใช้ไม่ได้ (Pollen หมด?) กำลังวาดด้วยโหมดฟรี…'); }
  }
  return tryUrl(imgUrl(prompt, seed, true), 'polfree');
}
function showShot(div, im, url, prompt, note){
  im.alt = prompt;
  div.innerHTML = `<div class="acts"><button data-re aria-label="วาดใหม่"><svg class="i"><use href="#i-refresh"/></svg></button><button data-sh aria-label="แชร์"><svg class="i"><use href="#i-share"/></svg></button><button data-dl aria-label="ดาวน์โหลด"><svg class="i"><use href="#i-down"/></svg></button></div>` + (note ? `<div class="ld" style="position:absolute;left:8px;top:8px;padding:3px 8px;background:rgba(6,10,32,.75);border-radius:8px;font-size:11px">${note}</div>` : '');
  div.prepend(im); div._file = null; shotActions(div, url, prompt);
  if (S.serverUrl && S.macSave) shotFile(div, url).then(f => saveToMac(f, 'images', prompt.slice(0, 40))).catch(() => {});
}
async function renderShot(div, prompt, seed){
  div.innerHTML = `<div class="ld"><div class="spin"></div>กำลังวาด…</div>`;
  const msg = t => { const l = div.querySelector('.ld'); if (l) l.lastChild.textContent = t; };
  const eng = S.imgEngine, t0 = performance.now();
  try {
    if (eng === 'flux' || eng === 'server'){
      const target = eng === 'server' ? S.serverUrl : FLUX_SPACE;
      try {
        if (eng === 'flux' && Q.hit('hf')) throw new Error(quotaText('hf'));
        msg(eng === 'server' ? 'กำลังวาดบนคอมของฉัน…' : 'กำลังวาดด้วย FLUX (รอคิว GPU ฟรี)…');
        const blob = await gradioImage(target, prompt, seed);
        SPEED.learn('img-' + eng, performance.now() - t0);
        const url = URL.createObjectURL(blob);
        showShot(div, await loadImg(url), url, prompt);
        addHistory({kind:'image', prompt, blob});
        return;
      } catch(e){
        if (S.commercial) throw new Error(e.message + ' — โหมดเชิงพาณิชย์จะไม่สลับไป Pollinations (ลองใหม่ หรือใช้คอมของฉัน)');
        toast(e.message + ' — ใช้ Pollinations แทน (อาจมีลายน้ำ)', true);
        msg('ใช้ตัวสำรอง Pollinations…');
      }
    }
    const r = await polImage(prompt, seed, msg);
    if (eng === 'pol') SPEED.learn('img-pol', performance.now() - t0);
    showShot(div, r.im, r.url, prompt, eng !== 'pol' ? 'ตัวสำรอง' : '');
    addHistory(r.blob ? {kind:'image', prompt, blob: r.blob} : {kind:'image', prompt, url: r.url});
  } catch(e){
    div.innerHTML = `<div class="ld">${esc(e.message)}<br><button class="btn sm alt" style="margin-top:8px">ลองใหม่</button></div>`;
    div.querySelector('button').onclick = () => renderShot(div, prompt, seed);
  }
}
$('#btnImg').onclick = async () => {
  const prompt = $('#imgPrompt').value.trim(); if (!prompt) return toast('พิมพ์คำอธิบายภาพก่อนนะ');
  if (!allowed('img-' + S.imgEngine)) return toast('โหมดเชิงพาณิชย์: ' + lic('img-' + S.imgEngine).t + ' — เลือก FLUX หรือคอมของฉัน', true);
  if (imgBusy) return; imgBusy = true;
  const btn = $('#btnImg'); btn.classList.add('busy'); btn.disabled = true;
  const grid = $('#imgGrid'); grid.innerHTML = ''; grid.classList.toggle('one', S.imgCount === 1);
  const shots = Array.from({length: S.imgCount}, () => { const d = document.createElement('div'); d.className = 'shot'; d.innerHTML = '<div class="ld">รอคิว…</div>'; grid.appendChild(d); return d; });
  const seeds = shots.map(() => Math.floor(Math.random() * 1e9));
  if (S.imgEngine === 'pol' && S.polKey && !Q.hit('pollinations')) await Promise.all(shots.map((d, i) => renderShot(d, prompt, seeds[i])));
  else for (let i = 0; i < shots.length; i++){
    if (i && S.imgEngine === 'pol' && (!S.polKey || Q.hit('pollinations'))){ for (let s = 15; s > 0; s--){ $('#imgStatus').textContent = `โหมดฟรีไม่มีคีย์: รอ ${s} วินาทีก่อนภาพถัดไป`; await sleep(1000); } }
    $('#imgStatus').textContent = `กำลังวาดภาพที่ ${i+1}/${shots.length}`;
    await renderShot(shots[i], prompt, seeds[i]);
  }
  $('#imgStatus').textContent = ''; renderEst(); renderQuota();
  btn.classList.remove('busy'); btn.disabled = false; imgBusy = false;
  const ok = shots.filter(d => d.querySelector('img'));
  if (ok.length > 1){
    const b = document.createElement('button'); b.className = 'btn alt'; b.style.cssText = 'width:100%;margin-top:12px;grid-column:1/-1';
    b.innerHTML = '<svg class="i"><use href="#i-share"/></svg>แชร์ทั้งหมด / บันทึกลง Google Drive';
    b.onclick = async () => { try { await shareFiles(await Promise.all(ok.map(d => shotFile(d, d.querySelector('img').src))), prompt.slice(0, 80)); } catch(e){ toast('แชร์ไม่สำเร็จ', true); } };
    grid.appendChild(b);
  }
};

/* ---------------- boot ---------------- */
try {
  const qs = new URLSearchParams(location.search), sv = qs.get('server');
  if (sv && isUrl(sv)){
    S.serverUrl = sv.replace(/\/+$/, ''); if (S.cloneEngine !== 'server') S.cloneEngine = 'server'; S.imgEngine = 'server'; save();
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => { toast('เชื่อมกับคอมของฉันแล้ว — โคลนเสียงและสร้างภาพจะใช้คอมเครื่องนั้น'); serverInfo().then(renderEst).catch(e => toast(e.message, true)); }, 600);
  }
} catch(e){}
enforceCommercial();
onText(); renderVoice(); ui(); renderEngines(); renderQuota();
if ((S.gKey && !gVoices) || (S.azKey && !azVoices)) loadCloudVoices();
const h0 = location.hash.slice(1); if (PAGES[h0]) go(h0);
addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES[h]) go(h); });
addEventListener('keydown', e => { if (e.key === 'Escape'){ closeAll(); $('#editor').classList.remove('full'); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
