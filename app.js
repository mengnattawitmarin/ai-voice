/* Gen Medi — AI media studio: Text to Speech · My Voice · Text to Image · Video Studio · Cover/Live
   No cloud APIs. Everything runs on this phone/browser or on the user's own Mac:
   - Phone: Web Speech voices, on-device VITS voices (transformers.js), voice changer, SFX/music, video export
   - Mac ("Gen Medi for Mac", server/genmedi_server.py): KhanomTan TTS, OpenVoice, FLUX/Segmind-Vega images
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
    const r = indexedDB.open('ai-voice', 2);
    r.onupgradeneeded = () => { const d = r.result; for (const n of ['clones', 'history', 'projects']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, {keyPath:'id'}); };
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
    get: (s, k) => run(s, 'readonly', st => st.get(k)),
  };
})();

/* ---------------- settings ---------------- */
const S = Object.assign({
  lang:'th', tone:1, style:'natural', rate:1, vol:1, voice:null,
  localDev:'auto', serverUrl:'', macToken:'', macImg:'', macSave:true, commercial:true, imgEngine:'mac', imgStyle:'none', imgRatio:'1:1', imgCount:2, imgEnhance:true,
}, LS.get('settings', {}));
const save = () => LS.set('settings', S);
if (!S.fx){ S.fx = {gender:'orig', age:'orig', srcG:'auto', effect:'none', pitch:0, formant:0, rev:0, echo:0}; if (S.tone && S.tone !== 1) S.fx.pitch = Math.round(12 * Math.log2(S.tone)); }

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
const LOCAL_VOICES = [  // mirrored in this repo's "models" branch (ONNX, transformers.js)
  ['th-female-v2','เสียงผู้หญิงไทย 1','th','ผู้หญิง'],
  ['th-female-v1','เสียงผู้หญิงไทย 2','th','ผู้หญิง'],
  ['th-male-v2','เสียงผู้ชายไทย 1','th','ผู้ชาย'],
  ['th-male-v1','เสียงผู้ชายไทย 2','th','ผู้ชาย'],
  ['th-male-narrator','เสียงผู้ชาย นักบรรยาย','th','ผู้ชาย'],
  ['th-mms','เสียงผู้ชาย MMS มาตรฐาน','th','ผู้ชาย'],
  ['en-mms','English voice (MMS, male)','en','ผู้ชาย'],
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
  home:['GEN MEDI','สตูดิโอสร้างสื่อด้วย AI · เสียง ภาพ วิดีโอ'],
  studio:['Video Studio','ตัดต่อ ภาพ + เสียงพากย์ + ซับ → พร้อมลงทุกแพลตฟอร์ม'],
  tts:['Text to Speech','เปลี่ยนข้อความเป็นเสียงพูดคุณภาพสูง'],
  clone:['My Voice','อ่านข้อความเป็นเสียงของคุณเอง (บน Mac)'],
  image:['Text to Image','สร้างภาพบน Mac ของคุณ · ไม่มีลายน้ำ'],
  cover:['Cover / Live','แกะคอร์ด → เล่นใหม่แบบร้านดนตรีสด'],
  video:['Text / Image to Video','สร้างคลิป AI บน GPU ของ Mac'],
  writer:['Script Writer','AI เขียนบท ฮุก แคปชัน บน Mac'],
  stt:['Speech to Subtitle','ถอดเสียงเป็นซับ บน Mac'],
  imgtools:['Image Tools','ลบพื้นหลัง · ขยายภาพด้วย AI'],
  jobs:['Mac Queue','งานที่สั่งให้ Mac ทำ'],
};
function go(p){
  $$('.page').forEach(s => s.classList.toggle('on', s.dataset.page === p));
  $$('.nav[data-go]').forEach(n => n.classList.toggle('on', n.dataset.go === p));
  $('#pageTitleTxt').textContent = PAGES[p][0]; $('#pageSub').textContent = PAGES[p][1]; $('#hdrLogo').hidden = p !== 'home';
  $('#dock').hidden = p !== 'tts'; $('#tabbar').hidden = p === 'tts';
  $('#app').classList.toggle('no-dock', p !== 'tts'); $('#app').classList.toggle('tabbed', p !== 'tts');
  $$('#tabbar [data-tab2]').forEach(b => b.classList.toggle('on', b.dataset.tab2 === p));
  if (p === 'home'){ renderHomeProjects(); renderMacBar(); }
  window.dispatchEvent(new CustomEvent('gm:page', {detail: p}));
  if (p === 'clone') renderClones();
  setTimeout(() => { renderQuota(); renderEst(); });
  closeAll(); scrollTo(0,0);
  if (location.hash.slice(1) !== p) history.replaceState(null, '', p === 'home' ? location.pathname : '#' + p);
}
$('#btnMenu').onclick = () => { drawer.classList.add('on'); scrim.classList.add('on'); };
$$('#tabbar [data-tab2]').forEach(b => b.onclick = () => go(b.dataset.tab2));
$('#pageTitle').onclick = () => go('home');
function homeAction(k){
  const [base, sub] = k.split(':');
  if (sub && base === 'writer'){ go('writer'); setTimeout(() => document.querySelector(`#writerRoot [data-w="${sub}"]`)?.scrollIntoView({block:'center'}), 200); return; }
  if (sub && base === 'video'){ const v = LS.get('vidSet', {}); v.src = 'img'; LS.set('vidSet', v); go('video'); setTimeout(() => window.GMVideo?.setSrc?.('img'), 50); return; }
  if (sub && base === 'imgtools'){ go('imgtools'); return; }
  if (base === 'video'){ const v = LS.get('vidSet', {}); if (v.src === 'img'){ v.src = 'text'; LS.set('vidSet', v); } go('video'); setTimeout(() => window.GMVideo?.setSrc?.('text'), 50); return; }
  if (PAGES[k]) return go(k);
  if (k === 'export'){ go('studio'); setTimeout(() => window.GMStudio?.openExport(), 50); return; }
  if (k === 'sfx') return window.GMStudio?.openSfxMaker();
  if (k === 'vfx'){ go('tts'); setTimeout(() => openVoiceFx(), 50); return; }
  if (k === 'music'){ go('studio'); setTimeout(() => window.GMStudio?.openMusic(), 50); return; }
  ({history:openHistory, proc:openProc, about:openAbout})[k]?.();
}
$$('[data-home]').forEach(b => b.onclick = () => homeAction(b.dataset.home));
$('#homeAuto').onclick = () => { go('studio'); setTimeout(() => window.GMStudio?.openAuto(), 50); };
$('#homeNewProj').onclick = () => { go('studio'); setTimeout(() => window.GMStudio?.newProject(), 50); };
function renderMacBar(){
  const b = $('#macBar'); if (!b) return;
  const i = MAC.info, on = MAC.on && MAC.state === 'on' && i;
  b.innerHTML = on ? `<span class="dotg"></span><b>Mac พร้อม</b><small>${esc((i.chip || '').replace(/^Apple /, ''))}${i.ram_gb ? ' · ' + i.ram_gb + 'GB' : ''}</small><button class="mini" data-home="jobs">🧾 คิวงาน</button>`
    : `<span class="dotg off"></span><b>${MAC.on ? 'ติดต่อ Mac ไม่ได้' : 'ยังไม่ได้เชื่อม Mac'}</b><small>${MAC.on ? 'เปิด Gen Medi บน Mac ค้างไว้' : 'ใช้ได้เฉพาะเครื่องมือในมือถือ'}</small><button class="mini" data-home="proc">เชื่อมต่อ</button>`;
  b.querySelectorAll('[data-home]').forEach(x => x.onclick = () => homeAction(x.dataset.home));
}
async function renderHomeProjects(){
  const list = (await db.all('projects')).sort((a, b) => b.updated - a.updated).slice(0, 6), box = $('#homeProjList');
  if (!list.length) return;
  box.innerHTML = list.map(p => `<button class="proj" data-id="${p.id}">${p.thumb ? `<img src="${URL.createObjectURL(p.thumb)}" alt="">` : '<span class="ph"></span>'}<span class="t"><b>${esc(p.name || 'ไม่มีชื่อ')}</b><small>${(p.scenes || []).length} ฉาก · ${new Date(p.updated).toLocaleString('th-TH', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}</small></span></button>`).join('');
  box.querySelectorAll('.proj').forEach(b => b.onclick = () => { go('studio'); setTimeout(() => window.GMStudio?.openProject(b.dataset.id), 50); });
}
$$('.nav[data-go]').forEach(n => n.onclick = () => go(n.dataset.go));
$$('.nav[data-act]').forEach(n => n.onclick = () => ({history:openHistory, settings:openSettings, install:openInstall, about:openAbout, proc:openProc})[n.dataset.act]());
$('#btnAvatar').onclick = () => openSettings();
$('#btnPro').onclick = () => openProc();

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
  local: {ok:false, t:'ส่วนตัวเท่านั้น — โมเดล MMS/VITS (CC-BY-NC)'},
  mac: {ok:true, t:'เชิงพาณิชย์ได้ — KhanomTan TTS v1.1 (Apache-2.0) บน Mac'},
  clone: {ok:true, t:'เชิงพาณิชย์ได้ — เสียงของคุณเอง + OpenVoice V2 (MIT) บน Mac'},
  'video-mac': {ok:true, t:'เชิงพาณิชย์ได้ — Wan2.1 T2V 1.3B (Apache-2.0) บน Mac'},
  cover: {ok:null, t:'ดนตรีบันทึกใหม่ของคุณ — แต่ทำนอง/เนื้อร้องเป็นลิขสิทธิ์ผู้แต่ง (ต้องขออนุญาตก่อนใช้เชิงพาณิชย์)'},
  'img-mac': {ok:true, t:'เชิงพาณิชย์ได้ — FLUX.1-schnell / Segmind-Vega (Apache-2.0) บน Mac'},
  // keys kept so projects made with earlier versions still show their licence
  gcloud: {ok:true, t:'เชิงพาณิชย์ได้ — Google Cloud TTS'}, azure: {ok:true, t:'เชิงพาณิชย์ได้ — Microsoft Azure TTS'},
  ai: {ok:null, t:'ไม่ยืนยัน — Pollinations'}, 'clone-openvoice': {ok:true, t:'เชิงพาณิชย์ได้ — OpenVoice V2 (MIT)'},
  'clone-hf': {ok:false, t:'ส่วนตัวเท่านั้น — F5-TTS (CC-BY-NC)'}, 'clone-server': {ok:false, t:'ส่วนตัวเท่านั้น — F5-TTS (CC-BY-NC)'},
  'img-flux': {ok:true, t:'เชิงพาณิชย์ได้ — FLUX.1-schnell (Apache 2.0)'}, 'img-server': {ok:true, t:'เชิงพาณิชย์ได้ — Segmind-Vega (Apache 2.0)'}, 'img-pol': {ok:null, t:'ไม่ยืนยัน — Pollinations'},
};
function lic(k){ return LIC[k] || {ok:null, t:'ไม่ยืนยัน'}; }
const licTag = k => { const l = lic(k); return `<span class="tag ${l.ok ? 'ok' : l.ok === false ? 'bad' : 'warn'}">${l.ok ? '💼 เชิงพาณิชย์ได้' : l.ok === false ? '🚫 ส่วนตัว' : '❔ ไม่ยืนยัน'}</span>`; };
const allowed = k => !S.commercial || lic(k).ok === true;
const voiceLicKey = v => v.type;
function enforceCommercial(){ S.imgEngine = 'mac'; }
const genderTh = g => /^m/i.test(g || '') ? 'ผู้ชาย' : /^f/i.test(g || '') ? 'ผู้หญิง' : 'กลาง';
const isUrl = t => /^https?:\/\//.test(t);

/* ---------------- Gen Medi for Mac: the local AI server (no cloud APIs) ---------------- */
// served by the Mac itself (localhost:7861 or its https tunnel) → same origin; otherwise paired by QR (?server=…&t=…)
const SAME_ORIGIN = (location.port === '7861' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) || /\.trycloudflare\.com$/.test(location.hostname);
const MAC_SPK_DEF = [{id:'Linda', name:'ลินดา (หญิง)', gender:'f'}, {id:'Kerstin', name:'เคอร์สติน (หญิง)', gender:'f'}, {id:'Bernard', name:'แบร์นาร์ด (ชาย)', gender:'m'}, {id:'Thorsten', name:'ทอร์สเทน (ชาย)', gender:'m'}];
const MAC = {
  info: LS.get('macInfo', null), state: 'unknown',
  get base(){ return SAME_ORIGIN ? '' : (S.serverUrl || '').replace(/\/+$/, ''); },
  get on(){ return SAME_ORIGIN || !!S.serverUrl; },
  get local(){ return SAME_ORIGIN && location.port === '7861'; },
  async call(path, opt = {}, ms = 900000){
    if (!this.on) throw new Error('ยังไม่ได้เชื่อม Mac — เปิดแอป Gen Medi บน Mac แล้วสแกน QR ด้วยมือถือ (เมนู › เชื่อมต่อ Mac)');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    let r;
    try { r = await fetch(this.base + path, {...opt, signal: ctl.signal, headers: {...(opt.headers || {}), 'X-GM-Token': S.macToken || ''}}); }
    catch(e){ this.state = 'offline'; renderQuota(); throw new Error(e.name === 'AbortError' ? 'Mac ตอบช้าเกินไป ลองใหม่' : 'ติดต่อ Mac ไม่ได้ — ตรวจว่าเปิดแอป Gen Medi บน Mac อยู่ (ถ้าเพิ่งเปิดแอปบน Mac ใหม่ ลิงก์จะเปลี่ยน → สแกน QR ใหม่)'); }
    finally { clearTimeout(t); }
    if (!r.ok){
      let m = 'HTTP ' + r.status; try { const j = await r.json(); m = j.detail || j.error || m; } catch(e){}
      if (r.status === 401){ this.state = 'unpaired'; renderQuota(); m = 'Mac ไม่รับการเชื่อมต่อ — สแกน QR บนหน้าจอ Mac ใหม่'; }
      if (r.status === 503 && /กำลังดาวน์โหลดโมเดล/.test(m) && (opt._dl || 0) < 3){ await this.waitModel(m); return this.call(path, {...opt, _dl: (opt._dl || 0) + 1}, ms); }
      throw new Error(m);
    }
    if (this.state !== 'on'){ this.state = 'on'; renderQuota(); }
    return r;
  },
  // first use of a model: Mac downloads it in the background → wait here with progress, then the caller's request is retried automatically
  async waitModel(msg){
    const t0 = Date.now();
    let key = null;
    while (Date.now() - t0 < 3 * 3600e3){
      let i = null; try { i = await (await this.call('/api/info', {}, 15000)).json(); } catch(e){}
      const ms = (i && i.models) || {};
      if (!key) key = Object.keys(ms).find(k => msg.includes(ms[k].name)) || null;
      const m = key ? ms[key] : null;
      if (m && m.state === 'ready') return;
      if (m && m.state === 'error') throw new Error('ดาวน์โหลดโมเดล ' + m.name + ' ไม่สำเร็จ: ' + (m.error || '') + ' — ตรวจอินเทอร์เน็ตของ Mac แล้วกดใหม่');
      const prog = !m ? '' : m.total ? ` ${m.pct || 0}% (${Math.round((m.mb || 0) / 100) / 10}/${Math.round(m.total / 1e8) / 10} GB)` : m.mb ? ` ${m.mb} MB` : '';
      toast('⬇️ Mac กำลังโหลดโมเดล ' + (m ? m.name : '') + prog + ' — ครั้งแรกครั้งเดียว รอได้เลย แล้วจะทำต่อให้อัตโนมัติ');
      await new Promise(r => setTimeout(r, 2500));
    }
    throw new Error('ดาวน์โหลดโมเดลนานเกินไป ลองใหม่');
  },
  async refresh(){
    if (!this.on){ this.state = 'off'; renderQuota(); return null; }
    try { this.info = await (await this.call('/api/info', {}, 15000)).json(); LS.set('macInfo', this.info); }
    catch(e){ return null; }
    renderQuota(); try { renderVoice(); renderEst(); renderMacBar(); } catch(e){}
    return this.info;
  },
  json(path, body, ms){ return this.call(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})}, ms); },
  form(path, fields, ms){ const fd = new FormData(); for (const [k, v] of Object.entries(fields)){ if (v == null) continue; if (v instanceof Blob) fd.append(k, v, v.name || 'file.' + extOf(v.type)); else fd.append(k, String(v)); } return this.call(path, {method:'POST', body: fd}, ms); },
  async tts(text, speaker, voice){ const t0 = performance.now(); const b = await (await this.json('/api/tts', {text, speaker, voice: voice || undefined, lang: S.lang === 'th' ? 'th-th' : S.lang === 'en' ? 'en' : 'th-th'})).blob(); SPEED.learn(voice ? 'clone' : 'mac', (performance.now() - t0) / Math.max(1, text.length)); return b; },
  async image(prompt, w, h, seed){ const t0 = performance.now(); const r = await this.json('/api/txt2img', {prompt, width:w, height:h, seed, mode: S.macImg && S.macImg !== 'auto' ? S.macImg : undefined}); const blob = await r.blob(); SPEED.learn('img-mac-' + curImgMode(), performance.now() - t0); return {blob, seed: +r.headers.get('X-Seed') || seed}; },
  speakers(){ return this.info?.speakers?.length ? this.info.speakers : MAC_SPK_DEF; },
};
const commercialVoices = () => MAC.on ? MAC.speakers().map(s => ({type:'mac', id:s.id, g:s.gender})) : [];
setTimeout(() => MAC.refresh(), 300);
setInterval(() => { if (MAC.on && document.visibilityState === 'visible') MAC.refresh(); }, 60000);

function curVoice(){
  let v = S.voice;
  if (!v && S.commercial && MAC.on){ const c = commercialVoices()[0]; if (c) v = {type:c.type, id:c.id}; }
  if (v?.type === 'mac'){ const s = MAC.speakers().find(x => x.id === v.id) || MAC.speakers()[0]; return {type:'mac', id:s.id, g:s.gender, name: s.name + ' · Mac', desc: 'KhanomTan บน Mac · 💼 เชิงพาณิชย์ได้' + (MAC.on ? '' : ' · ⚠️ ยังไม่ได้เชื่อม Mac')}; }
  if (v?.type === 'local'){ const l = LOCAL_VOICES.find(x => x[0] === v.id) || LOCAL_VOICES[0]; return {type:'local', id:l[0], name:l[1], desc:'เสียง AI ฟรี ประมวลผลในเครื่อง · ดาวน์โหลดได้ · 🚫 ส่วนตัว'}; }
  if (v?.type === 'clone'){ const c = clones.find(x => x.id === v.id); if (c) return {type:'clone', id:c.id, name:c.name, desc:'เสียงของฉัน (OpenVoice บน Mac) · 💼 เชิงพาณิชย์ได้' + (MAC.on ? '' : ' · ⚠️ ยังไม่ได้เชื่อม Mac'), rec:c}; }
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
  $('#fToneV').textContent = window.VFX ? VFX.label(S.fx) : 'ปกติ';
  $('#fStyleV').textContent = (STYLES[S.style]||STYLES.natural).n;
  $('#dkSave').style.opacity = v.type === 'device' ? .55 : 1;
  try { renderEst(); renderQuota(); } catch(e){}
}
$('#btnVoice').onclick = () => {
  const v = curVoice();
  const list = devForLang();
  const row = (k, n, d, on) => `<button class="opt ${on?'on':''}" data-k="${esc(k)}"><span class="dot"></span><span class="t"><b>${n}</b><small>${d}</small></span></button>`;
  let h = sheetHead('เลือกเสียง');
  h += `<label class="switch" style="margin:0 0 6px"><span>💼 โหมดเชิงพาณิชย์ (ทำวิดีโอหารายได้)<br><small style="color:var(--mut)">ดาวน์โหลด/แชร์/บันทึกได้เฉพาะเสียงที่สัญญาอนุญาตเชิงพาณิชย์</small></span><input type="checkbox" id="vComm" ${S.commercial ? 'checked' : ''}></label>`;
  h += `<h4>💼 เสียงพากย์บน Mac — KhanomTan ${MAC.on ? (MAC.state === 'on' ? '<span class="tag ok">เชื่อมแล้ว</span>' : '<span class="tag warn">Mac ออฟไลน์?</span>') : ''}</h4>`;
  h += MAC.on ? MAC.speakers().map(s => row('mac:' + s.id, esc(s.name) + ' ' + licTag('mac'), 'อ่านไทยได้ · ประมวลผลบน GPU ของ Mac · ไม่มีโควตา', v.type === 'mac' && v.id === s.id)).join('')
    : `<button class="opt" data-mac><span class="dot"></span><span class="t"><b>＋ เชื่อมต่อ Mac</b><small>เปิดแอป Gen Medi บน Mac แล้วสแกน QR — ได้เสียงพากย์ที่ใช้หารายได้ได้ + สร้างภาพ</small></span></button>`;
  h += `<h4>💼 เสียงของฉัน (โคลนจากเสียงตัวเอง)</h4>`;
  h += clones.map(c => row('clone:' + c.id, esc(c.name) + ' ' + licTag('clone'), 'KhanomTan → แปลงเป็นเสียงคุณด้วย OpenVoice บน Mac', v.type === 'clone' && v.id === c.id)).join('');
  h += `<button class="opt" data-gclone><span class="dot"></span><span class="t"><b>＋ เพิ่มเสียงของฉัน</b><small>อัดเสียงตัวเอง 10 วินาที</small></span></button>`;
  const locs = LOCAL_VOICES.filter(l => l[2] === S.lang);
  if (locs.length){
    h += `<h4>เสียง AI ฟรีในมือถือ ไม่ต้องใช้ Mac ${licTag('local')}</h4>`;
    h += locs.map(l => row('local:'+l[0], esc(l[1]) + ` <span class="tag">${l[3]}</span>`, 'ออฟไลน์หลังโหลดครั้งแรก (~115MB) · ใช้ส่วนตัว/ทดลองบท', v.type==='local' && v.id===l[0])).join('');
  }
  if (S.lang === 'th' && window.VFX){
    const fx = VFX.norm(S.fx);
    h += `<h4>🎭 เสียงแปลงด้วย AI — สร้างจากเสียงในมือถือ ${licTag('local')}</h4>`;
    h += DERIV.map((d, i) => row('dv:' + i, d[3], d[4], v.type === 'local' && v.id === d[0] && fx.gender === d[1] && fx.age === d[2])).join('');
    h += `<button class="opt" data-vfx><span class="dot"></span><span class="t"><b>🎛️ เปลี่ยนเพศ / วัย / เอฟเฟกต์ ของเสียงไหนก็ได้ →</b><small>หุ่นยนต์ โทรโข่ง ประกาศ ชิปมังก์ ผี ฯลฯ — ใช้กับเสียง Mac 💼 ได้ด้วย</small></span></button>`;
  }
  h += `<h4>เสียงระบบในเครื่อง (${esc(lang()[1])}) ${licTag('device')}</h4>`;
  h += list.length ? list.map(d => row('device:'+d.voiceURI, esc(prettyDev(d)), d.localService ? 'อยู่ในเครื่อง' : 'ออนไลน์', v.type==='device' && v.id===d.voiceURI)).join('')
    : `<p class="hint">ไม่มีเสียง${esc(lang()[1])}ในเครื่องนี้ — Android: ตั้งค่า › การแปลงข้อความเป็นเสียง</p>`;
  openSheet(h, el => {
    el.querySelectorAll('.opt[data-k]').forEach(b => b.onclick = () => {
      if (b.dataset.k.startsWith('dv:')){
        const d = DERIV[+b.dataset.k.slice(3)];
        S.voice = {type:'local', id:d[0]}; S.fx = Object.assign(VFX.norm(S.fx), {gender:d[1], age:d[2], srcG:'auto'});
        save(); stopAll(); renderVoice(); closeAll(); toast('ใช้ ' + d[3].replace(/^\S+\s/, '') + ' แล้ว — ปรับต่อได้ที่ “เปลี่ยนเสียง”'); return;
      }
      const [type, ...rest] = b.dataset.k.split(':'); S.voice = {type, id: rest.join(':')}; save(); stopAll(); renderVoice(); closeAll();
    });
    el.querySelector('[data-gclone]').onclick = () => go('clone');
    el.querySelector('[data-vfx]')?.addEventListener('click', () => openVoiceFx());
    el.querySelector('[data-mac]')?.addEventListener('click', () => openProc());
    el.querySelector('#vComm').onchange = e => { S.commercial = e.target.checked; save(); renderVoice(); toast(S.commercial ? 'เปิดโหมดเชิงพาณิชย์แล้ว' : 'ปิดโหมดเชิงพาณิชย์แล้ว'); };
  });
};
$('#btnPreview').onclick = async () => {
  stopAll(); const v = curVoice(), sample = lang()[3];
  if (v.type === 'device'){
    if (!v.obj) return toast('ไม่มีเสียงในเครื่องสำหรับภาษานี้', true);
    const u = new SpeechSynthesisUtterance(sample); u.voice = v.obj; u.lang = v.obj.lang; u.rate = effRate(); u.pitch = devPitchNow(v); u.volume = Math.min(1, S.vol);
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
$('#fTone').onclick = () => openVoiceFx();
$('#fStyle').onclick = () => optionSheet('รูปแบบเสียง', Object.entries(STYLES).map(([k,s]) => ({v:k, n:s.n, d:s.d})), S.style,
  v => { S.style = v; save(); renderVoice(); onText(); });
$('#fAdv').onclick = () => openProc();

/* ---------------- voice changer (gender / age / effects) ---------------- */
const DERIV = [  // [base local voice, gender, age, name, desc]
  ['th-female-v2','m','adult','🧔 ผู้ชาย (แปลงจากเสียงผู้หญิง 1)','เสียงผู้ชายอีกแบบ นุ่มกว่าเสียงผู้ชายเดิม'],
  ['th-male-v2','f','adult','👩 ผู้หญิง (แปลงจากเสียงผู้ชาย 1)','เสียงผู้หญิงโทนต่ำ ๆ'],
  ['th-female-v2','f','child','👧 เด็กหญิง','เสียงใส ๆ แบบเด็ก'],
  ['th-male-v2','m','child','👦 เด็กชาย','เสียงเด็กผู้ชาย'],
  ['th-female-v1','f','teen','👱‍♀️ วัยรุ่นหญิง','สดใสขึ้นเล็กน้อย'],
  ['th-male-narrator','m','teen','🧑 วัยรุ่นชาย','หนุ่มกว่าเสียงบรรยาย'],
  ['th-female-v2','f','elder','👵 คุณยาย','เสียงสั่นนิด ๆ แบบผู้สูงอายุ'],
  ['th-male-v2','m','elder','👴 คุณตา','ทุ้ม สั่นเล็กน้อย'],
];
function srcGenderOf(v){
  if (!v) return null;
  const mf = s => /^f/i.test(s || '') ? 'f' : /^m/i.test(s || '') ? 'm' : null;
  if (v.type === 'local'){ const l = LOCAL_VOICES.find(x => x[0] === v.id); return l ? (l[3] === 'ผู้ชาย' ? 'm' : 'f') : null; }
  if (v.type === 'mac') return v.g || mf((MAC.speakers().find(x => x.id === v.id) || {}).gender);
  if (v.type === 'clone') return v.rec?.gender || null;
  if (v.type === 'device'){ const n = (v.obj?.name || '').toLowerCase(); return /female|woman|kanya|premwadee|achara|narisa/.test(n) ? 'f' : /male|\bman\b|niwat|pattara/.test(n) ? 'm' : null; }
  return null;
}
const devPitchNow = v => window.VFX ? VFX.devPitch(S.fx, srcGenderOf(v)) : 1;
function fxChanged(){
  save(); renderVoice(); P.key = ''; P.lastFile = null;
  if (P.state === 'playing' && P.kind === 'device') speakDevice();
}
function openVoiceFx(){
  if (!window.VFX) return toast('โหลดตัวแปลงเสียงไม่สำเร็จ ลองรีเฟรช', true);
  const v = curVoice(), fx = S.fx = VFX.norm(S.fx), sg = srcGenderOf(v);
  const chips = (key, list) => `<div class="chips" data-g="${key}">${list.map(o => `<button class="chip ${fx[key] === o[0] ? 'on' : ''}" data-v="${o[0]}">${o[1]}</button>`).join('')}</div>`;
  const srcList = [['auto', 'อัตโนมัติ' + (sg ? ` (${sg === 'm' ? 'ชาย' : 'หญิง'})` : '')], ['f', 'หญิง'], ['m', 'ชาย']];
  const rng = (id, label, min, max, step, val, fmt) => `<div class="fxr"><div class="fxl"><span>${label}</span><b id="${id}V">${fmt(val)}</b></div><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
  const fmtSt = x => (x > 0 ? '+' : '') + (+x) + (Math.abs(x) >= 1 || x == 0 ? '' : ''), fmtPct = x => Math.round(x * 100 / 0.6) + '%';
  let h = sheetHead('🎭 เปลี่ยนเสียง & เอฟเฟกต์');
  h += `<p class="hint" style="margin-top:0">ใช้กับ: <b>${esc(v.name)}</b> — ประมวลผลในเครื่อง ฟรี ไม่ใช้ API</p>`;
  if (v.type === 'device') h += `<div class="lim">เสียงระบบในเครื่องเบราว์เซอร์<b>ไม่ให้ดึงเสียงมาแปลง</b> จึงปรับได้แค่ “ระดับเสียง” (เพศ/วัยแบบคร่าว ๆ) — เอฟเฟกต์เต็ม (แปลงเพศจริง หุ่นยนต์ โทรโข่ง ฯลฯ) ต้องใช้เสียง AI<div class="row2" style="margin-top:8px;flex-wrap:wrap"><button class="btn sm" id="fxToLocal">ใช้เสียง AI ในเครื่อง (ฟรี)</button>${commercialVoices()[0] ? '<button class="btn sm alt" id="fxToComm">ใช้เสียง 💼 บน Mac</button>' : ''}</div></div>`;
  h += `<h4>เพศ</h4>${chips('gender', VFX.GENDERS)}`;
  h += `<h4>วัย</h4>${chips('age', VFX.AGES)}`;
  h += `<h4>เสียงต้นฉบับเป็น <small style="color:var(--mut);font-weight:400">ใช้คำนวณการแปลงเพศ</small></h4>${chips('srcG', srcList)}`;
  VFX.GROUPS.forEach(([g, gn]) => {
    h += `<h4>${gn}</h4><div class="fxgrid">` + VFX.PRESETS.filter(p => p[3] === g).map(p => `<button class="fxp ${fx.effect === p[0] ? 'on' : ''}" data-e="${p[0]}"><span>${p[1]}</span><small>${p[2]}</small></button>`).join('') + `</div>`;
  });
  h += `<h4>ปรับละเอียด</h4>`;
  h += rng('fxPitch', 'ระดับเสียง (คีย์)', -12, 12, 1, fx.pitch, fmtSt);
  h += rng('fxForm', 'ขนาดลำคอ — ลบ = ใหญ่/ทุ้ม · บวก = เล็ก/ใส', -6, 6, 0.5, fx.formant, fmtSt);
  h += rng('fxRev', 'เสียงก้อง (reverb)', 0, 0.6, 0.05, fx.rev, fmtPct);
  h += rng('fxEcho', 'เสียงสะท้อน (echo)', 0, 0.6, 0.05, fx.echo, fmtPct);
  h += `<div class="row2" style="margin-top:12px"><button class="btn alt" style="flex:1" id="fxReset">↺ รีเซ็ต</button><button class="btn" style="flex:2" id="fxPlay">▶ ฟังตัวอย่าง</button></div>`;
  h += `<button class="btn alt" style="width:100%;margin-top:8px" id="fxFile">🎧 แปลงไฟล์เสียง / คลิป / อัดเสียงตัวเอง</button>`;
  h += `<p class="hint">วิธีทำงาน: แยก “ระดับเสียง (pitch)” กับ “รูปร่างเสียง/ลำคอ (formant)” ออกจากกันด้วย phase vocoder + spectral envelope แล้วประกอบใหม่ จึงเปลี่ยนเพศ/วัยได้โดยไม่เป็นเสียงชิปมังก์ ตามด้วยชุดเอฟเฟกต์ (ฟิลเตอร์ ดิสทอร์ชัน ก้อง สะท้อน ฯลฯ)<br>ใช้ได้กับเสียง AI ในเครื่อง · Google · Azure · Pollinations · เสียงโคลน และเสียงพากย์ในสตูดิโอวิดีโอ<br>💼 สิทธิ์เชิงพาณิชย์เป็นไปตามเสียงต้นทาง (Google/Azure/เสียงตัวเอง = ใช้หารายได้ได้)</p>`;
  openSheet(h, el => {
    el.querySelectorAll('.chips[data-g]').forEach(c => c.querySelectorAll('.chip').forEach(b => b.onclick = () => {
      fx[c.dataset.g] = b.dataset.v; c.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); fxChanged();
    }));
    el.querySelectorAll('.fxp').forEach(b => b.onclick = () => {
      fx.effect = b.dataset.e; el.querySelectorAll('.fxp').forEach(x => x.classList.toggle('on', x === b)); fxChanged();
      if (v.type === 'device' && fx.effect !== 'none' && !VFX.PRESETS.find(p => p[0] === fx.effect)[4].p) toast('เอฟเฟกต์นี้ต้องใช้เสียง AI — เสียงระบบในเครื่องเปลี่ยนได้แค่ระดับเสียง', true);
    });
    [['fxPitch','pitch',fmtSt],['fxForm','formant',fmtSt],['fxRev','rev',fmtPct],['fxEcho','echo',fmtPct]].forEach(([id, k, f]) => {
      const r = el.querySelector('#' + id); setRangeFill(r);
      r.oninput = () => { fx[k] = +r.value; el.querySelector('#' + id + 'V').textContent = f(+r.value); setRangeFill(r); };
      r.onchange = fxChanged;
    });
    el.querySelector('#fxReset').onclick = () => { S.fx = VFX.norm({}); fxChanged(); openVoiceFx(); };
    el.querySelector('#fxPlay').onclick = async e => {
      const b = e.currentTarget, text = (ta.value.trim().slice(0, 140) || lang()[3]);
      stopAll();
      if (v.type === 'device'){
        if (!v.obj) return toast(v.desc, true);
        const u = new SpeechSynthesisUtterance(text); u.voice = v.obj; u.lang = v.obj.lang; u.rate = effRate(); u.pitch = devPitchNow(v); u.volume = Math.min(1, S.vol);
        synth.cancel(); synth.speak(u); return;
      }
      b.disabled = true; b.textContent = 'กำลังสร้าง + แปลงเสียง…';
      try { playOnce(await synthesize(v, text)); } catch(err){ toast(err.message || String(err), true); }
      b.disabled = false; b.textContent = '▶ ฟังตัวอย่าง';
    };
    el.querySelector('#fxFile').onclick = () => openFxFile();
    el.querySelector('#fxToLocal')?.addEventListener('click', () => {
      const want = fx.gender !== 'orig' ? fx.gender : 'f';
      const l = LOCAL_VOICES.find(x => x[2] === S.lang && (x[3] === 'ผู้ชาย') === (want === 'm')) || LOCAL_VOICES.find(x => x[2] === S.lang) || LOCAL_VOICES[0];
      S.voice = {type:'local', id:l[0]}; fxChanged(); openVoiceFx(); toast('ใช้ ' + l[1] + ' แล้ว');
    });
    el.querySelector('#fxToComm')?.addEventListener('click', () => { const c = commercialVoices()[0]; S.voice = {type:c.type, id:c.id}; fxChanged(); openVoiceFx(); });
  });
}
/* convert any audio/video file or a fresh mic recording with the current voice settings */
function openFxFile(){
  const fx = VFX.norm(S.fx);
  let h = sheetHead('🎧 แปลงไฟล์เสียง / อัดเสียง');
  h += `<p class="hint" style="margin-top:0">ใช้การตั้งค่าปัจจุบัน: <b>${esc(VFX.label(fx))}</b> — ไฟล์เสียงหรือคลิปวิดีโอ (ใช้เฉพาะเสียง) ยาวได้หลายนาที</p>`;
  h += `<h4>เสียงในไฟล์เป็น</h4><div class="chips" id="ffSrc"><button class="chip ${fx.srcG !== 'm' ? 'on' : ''}" data-v="f">หญิง</button><button class="chip ${fx.srcG === 'm' ? 'on' : ''}" data-v="m">ชาย</button></div>`;
  h += `<div class="row2" style="margin-top:12px"><label class="btn" style="flex:1;text-align:center">📁 เลือกไฟล์<input type="file" id="ffIn" accept="audio/*,video/*" hidden></label><button class="btn alt" style="flex:1" id="ffRec">🎤 อัดเสียง</button></div>`;
  h += `<div id="ffOut" style="margin-top:12px"></div>`;
  h += `<p class="hint">💼 แปลงเสียงตัวเอง หรือเสียงที่คุณมีสิทธิ์ใช้ = ใช้หารายได้ได้ · อย่าใช้ปลอมเป็นบุคคลจริงเพื่อหลอกลวง</p>`;
  openSheet(h, el => {
    let src = fx.srcG === 'm' ? 'm' : 'f', mr = null;
    el.querySelectorAll('#ffSrc .chip').forEach(b => b.onclick = () => { src = b.dataset.v; el.querySelectorAll('#ffSrc .chip').forEach(x => x.classList.toggle('on', x === b)); });
    const out = el.querySelector('#ffOut');
    async function run(blob, name){
      out.innerHTML = `<div class="prog2"><i style="width:2%"></i></div><p class="hint">กำลังแปลงเสียง…</p>`;
      try {
        const t0 = performance.now();
        const res = await VFX.applyLong(blob, Object.assign({}, S.fx, {srcG: src}), src, p => { const i = out.querySelector('.prog2 i'); if (i) i.style.width = Math.round(p * 100) + '%'; });
        const f = new File([res], `genmedi-vfx-${(name || 'voice').replace(/\.[^.]+$/, '').slice(0, 30)}-${stamp()}.wav`, {type:'audio/wav'});
        out.innerHTML = `<audio controls src="${URL.createObjectURL(f)}" style="width:100%"></audio><p class="hint">เสร็จใน ${((performance.now() - t0) / 1000).toFixed(1)} วินาที · ${(f.size / 1048576).toFixed(1)} MB</p><div class="row2"><button class="btn" style="flex:1" id="ffSave">⬇️ บันทึก</button><button class="btn alt" style="flex:1" id="ffShare">📤 แชร์ / Drive</button></div>`;
        out.querySelector('#ffSave').onclick = () => { saveBlob(f, f.name); saveToMac(f, 'audio', 'voice-fx'); };
        out.querySelector('#ffShare').onclick = () => shareFiles([f], 'Gen Medi');
        addHistory({kind:'audio', text:'แปลงเสียง: ' + VFX.label(S.fx), voice:'Voice FX', blob:f});
      } catch(e){ out.innerHTML = `<p class="lim">แปลงไม่สำเร็จ: ${esc(e.message || String(e))} — ไฟล์บางชนิดเบราว์เซอร์ถอดเสียงไม่ได้ ลอง MP3/WAV/M4A/MP4</p>`; }
    }
    el.querySelector('#ffIn').onchange = e => { const f = e.target.files[0]; if (f) run(f, f.name); };
    el.querySelector('#ffRec').onclick = async e => {
      const b = e.currentTarget;
      if (mr){ mr.stop(); return; }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('อุปกรณ์นี้อัดเสียงในเว็บไม่ได้ — ใช้ “เลือกไฟล์” แทน', true);
      try {
        const st = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
        const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
        const parts = []; mr = new MediaRecorder(st, mime ? {mimeType:mime} : {});
        mr.ondataavailable = ev => ev.data.size && parts.push(ev.data);
        mr.onstop = () => { st.getTracks().forEach(t => t.stop()); mr = null; b.textContent = '🎤 อัดเสียง'; run(new Blob(parts, {type: parts[0]?.type || 'audio/webm'}), 'mic'); };
        mr.start(); b.textContent = '⏹ หยุดอัด';
      } catch(err){ toast('เปิดไมค์ไม่ได้: ' + (err.message || err), true); }
    };
  });
}

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
const pkey = (v, text) => v.type + ':' + v.id + '|' + (v.type === 'device' ? '' : (window.VFX?.sig(S.fx) || '')) + '|' + text;
function prepare(v, text){
  const key = pkey(v, text);
  if (P.key !== key){
    const max = v.type === 'device' ? 180 : v.type === 'local' ? 140 : 220;
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
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({title: text.slice(0, 60), artist: v.name, album: 'Gen Medi'});
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
  u.rate = effRate(); u.pitch = devPitchNow(v); u.volume = Math.min(1, S.vol);
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
async function synthesize(v, text, fx){
  const b = await synthRaw(v, text);
  fx = fx === undefined ? S.fx : fx;
  if (!window.VFX?.active(fx)) return b;
  try { return await VFX.apply(b, fx, srcGenderOf(v)); }
  catch(e){ console.warn(e); toast('แปลงเสียงไม่สำเร็จ ใช้เสียงต้นฉบับแทน (' + (e.message || e) + ')', true); return b; }
}
async function synthRaw(v, text){
  if (v.type === 'mac') return MAC.tts(text, v.id);
  if (v.type === 'clone') return cloneTTS(text, v.rec);
  if (v.type === 'local') return localTTS(text, v.id);
  throw new Error('เสียงในเครื่องสร้างไฟล์เสียงไม่ได้');
}
/* ---------------- Mac status banner ---------------- */
function fmtDur(sec){
  sec = Math.max(1, sec);
  if (sec < 60) return Math.round(sec) + ' วินาที';
  if (sec < 3600) return Math.round(sec / 60) + ' นาที';
  return (sec / 3600).toFixed(1).replace(/\.0$/, '') + ' ชั่วโมง';
}
function curPage(){ return $$('.page').find(p => p.classList.contains('on'))?.dataset.page || 'tts'; }
function renderQuota(){
  const box = $('#quota'); if (!box) return;
  const page = curPage(), v = page === 'tts' ? curVoice() : null;
  const needMac = page === 'image' || page === 'clone' || (v && (v.type === 'mac' || v.type === 'clone'));
  let msg = '';
  if (needMac && !MAC.on) msg = 'ยังไม่ได้เชื่อม Mac — งานนี้ประมวลผลบน Mac ของคุณ (ไม่ใช้ API ภายนอก)';
  else if (needMac && MAC.state === 'offline') msg = 'ติดต่อ Mac ไม่ได้ — เปิดแอป Gen Medi บน Mac ค้างไว้ (ถ้าเปิดใหม่ ต้องสแกน QR ใหม่)';
  else if (needMac && MAC.state === 'unpaired') msg = 'Mac ไม่รับการเชื่อมต่อ — สแกน QR บนหน้าจอ Mac ใหม่';
  else if (needMac && MAC.info){
    const want = page === 'image' ? [MAC.info.img_engine] : page === 'clone' ? ['voice'] : v?.type === 'clone' ? ['tts', 'voice'] : ['tts'];
    const dl = want.map(k => MAC.info.models?.[k]).filter(m => m && m.state !== 'ready');
    if (dl.length) msg = 'Mac กำลังเตรียมโมเดล: ' + dl.map(m => `${m.name} ${m.state === 'error' ? '(ผิดพลาด)' : (m.pct || 0) + '%'}`).join(' · ') + ' — ครั้งแรกเท่านั้น';
  }
  box.innerHTML = msg ? `<div class="qbar"><b>💻 ${esc(msg)}</b><div class="row2" style="flex-wrap:wrap;margin-top:8px"><button class="btn sm alt" data-q="proc">เชื่อมต่อ Mac</button>${needMac && page === 'tts' && LOCAL_VOICES.some(l => l[2] === S.lang) ? '<button class="btn sm alt" data-q="local">ใช้เสียงฟรีในมือถือ (🚫 ส่วนตัว)</button>' : ''}</div></div>` : '';
  box.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    if (b.dataset.q === 'proc') return openProc();
    const l = LOCAL_VOICES.find(x => x[2] === S.lang) || LOCAL_VOICES[0]; S.voice = {type:'local', id:l[0]}; save(); stopAll(); renderVoice();
  });
}
const renderEngines = () => {};
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
function localDev(){ return S.localDev === 'wasm' ? 'wasm' : S.localDev === 'webgpu' ? 'webgpu' : (SPEC?.gpu ? 'webgpu' : 'wasm'); }
function engineKey(v){ return v.type === 'local' ? 'local-' + localDev() : v.type === 'mac' || v.type === 'clone' ? v.type : 'device'; }
function defMs(k){
  const sp = SPEC || {mobile:true, cores:4}, ram = MAC.info?.ram_gb || 16;
  switch (k){
    case 'local-webgpu': return sp.mobile ? 18 : sp.apple ? 5 : 7;
    case 'local-wasm': return sp.mobile ? (sp.cores >= 8 ? 70 : 140) : (sp.cores >= 8 ? 20 : 40);
    case 'mac': return MAC.info?.tts_ms_per_char || 12;
    case 'clone': return (MAC.info?.tts_ms_per_char || 12) + 25;
    case 'img-mac': { const md = curImgMode(); return MAC.info?.['img_ms_' + md] || Math.round(({fast:16000, balanced:70000, quality:220000})[md] * 8 / Math.max(8, MAC.info?.gpu_cores || 8)); }
  }
  return 50;
}
const IMG_MODE_LABEL = {auto:'อัตโนมัติ', fast:'⚡ เร็ว', balanced:'⚖️ สมดุล', quality:'💎 คมชัดสูง'};
function curImgMode(){ const m = S.macImg && S.macImg !== 'auto' && IMG_MODE_LABEL[S.macImg] ? S.macImg : (MAC.info?.img_mode || 'balanced'); return (MAC.info?.ram_gb || 16) < 14 && m !== 'fast' ? 'fast' : m; }
function speedOf(k){ const m = SPEED.get(k === 'img-mac' ? 'img-mac-' + curImgMode() : k); return {v: m || defMs(k), measured: !!m}; }
function whereLabel(k){
  const mac = 'Mac' + (MAC.info?.chip ? ` (${MAC.info.chip.replace(/^Apple /, '')}${MAC.info.ram_gb ? ' · ' + MAC.info.ram_gb + 'GB' : ''})` : '');
  return ({'local-webgpu':'GPU ในมือถือเครื่องนี้', 'local-wasm':'CPU ในมือถือเครื่องนี้', 'mac': mac, 'clone': mac + ' + OpenVoice', 'img-mac': mac + ' · ' + IMG_MODE_LABEL[curImgMode()] + (curImgMode() === 'fast' ? ' (Segmind-Vega)' : ' (FLUX.1-schnell)')})[k] || k;
}
function estimateVoice(v, chars){
  const listen = chars / 13.3 / effRate();
  if (v.type === 'device') return {first: 0, total: 0, listen, text: `⏱ เริ่มอ่านทันที · ฟังจบประมาณ ${fmtDur(listen)} · เสียงในเครื่อง`};
  const k = engineKey(v), sp = speedOf(k), firstChars = Math.min(chars, v.type === 'local' ? 140 : 300);
  const lt = S.commercial && !allowed(voiceLicKey(v)) ? ' · ⚠️ เสียงนี้ใช้หารายได้ไม่ได้' : '';
  let over = 0, note = '';
  if (v.type === 'local' && !LS.get('dl.' + v.id, false)){ over = 115 * 8 / Math.max(SPEC?.net || 10, 8) + 5; note = ` · ครั้งแรกโหลดโมเดล ~${fmtDur(over)}`; }
  if (k === 'mac' || k === 'clone') over = 1;
  const first = over + firstChars * sp.v / 1000, total = over + chars * sp.v / 1000;
  const slow = sp.v > 75 / effRate() ? ' · สร้างช้ากว่าเสียงที่เล่น อาจหยุดรอเป็นช่วง ๆ' : '';
  return {first, total, listen, text: `⏱ เริ่มได้ยินใน ~${fmtDur(first)} · สร้างทั้งหมด ~${fmtDur(total)} · ${whereLabel(k)}${note}${slow} · ${sp.measured ? 'วัดจากเครื่องคุณ' : 'ประมาณจากสเปค'}${lt}`};
}
function estimateImages(n){
  const sp = speedOf('img-mac'), each = sp.v / 1000;
  return {each, total: each * n, text: `⏱ ประมาณ ${fmtDur(each)}/ภาพ · ${n} ภาพ ~${fmtDur(each * n)} · ${whereLabel('img-mac')} · ${sp.measured ? 'วัดจากเครื่องคุณ' : 'ประมาณจากสเปค'}`};
}
function renderEst(){
  const chars = ta.value.trim().length;
  if ($('#est')) $('#est').textContent = chars && P.state === 'idle' ? estimateVoice(curVoice(), chars).text : '';
  if ($('#imgEst')) $('#imgEst').textContent = estimateImages(S.imgCount).text;
  if ($('#cloneEst')) $('#cloneEst').textContent = `⏱ ประโยคทดสอบ ~${fmtDur(2 + 45 * speedOf('clone').v / 1000)} · ${whereLabel('clone')}`;
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

/* ---------------- my voice: KhanomTan (Apache) → OpenVoice (MIT) with your own recording, all on the Mac ---------------- */
async function macVoiceId(rec){
  if (rec.macVoice && MAC.info?.voices?.includes(rec.macVoice)) return rec.macVoice;
  const r = await (await MAC.form('/api/voices', {audio: new File([rec.blob], 'ref.wav', {type: rec.blob.type || 'audio/wav'}), name: rec.id})).json();
  rec.macVoice = r.id; await db.put('clones', rec);
  if (MAC.info){ MAC.info.voices = [...(MAC.info.voices || []), r.id]; }
  return r.id;
}
async function cloneTTS(text, rec){
  if (!rec) throw new Error('ไม่พบเสียงนี้แล้ว');
  const vid = await macVoiceId(rec);
  const spk = MAC.speakers(), base = spk.find(s => s.gender === (rec.gender || 'm')) || spk[0];
  return MAC.tts(text, base.id, vid);
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
    openSheet(sheetHead('บันทึกเสียงเป็นไฟล์') + `<p class="lim">เสียงในเครื่องเล่นได้อย่างเดียว เบราว์เซอร์<b>ไม่อนุญาตให้อัดเป็นไฟล์</b><br>เปลี่ยนเป็น <b>เสียงพากย์บน Mac 💼</b> หรือ <b>เสียง AI ฟรีในมือถือ</b> เพื่อดาวน์โหลดเป็นไฟล์ได้</p><button class="btn" style="width:100%" id="swAi">${MAC.on ? 'ใช้เสียงพากย์บน Mac' : 'ใช้เสียง AI ฟรีในมือถือ'}</button>`,
      el => el.querySelector('#swAi').onclick = () => { if (MAC.on) S.voice = {type:'mac', id: MAC.speakers()[0].id}; else { const l = LOCAL_VOICES.find(x => x[2] === S.lang) || LOCAL_VOICES[0]; S.voice = {type:'local', id:l[0]}; } save(); renderVoice(); closeAll(); });
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
  if (P.lastFile && P.key === pkey(v, text)) return P.lastFile;
  if (P.state === 'idle') prepare(v, text); else if (P.key !== pkey(v, text)){ stopAll(); prepare(v, text); }
  const n = P.chunks.length;
  for (let i = 0; i < n; i++){
    status(`กำลังสร้างไฟล์เสียง ${i+1}/${n}…`); $('#prog').style.width = (i / n * 100) + '%';
    try { await getChunk(i); } catch(e){ status(''); toast(e.message, true); return null; }
  }
  status('กำลังรวมไฟล์…');
  const blob = await mergeAudio(P.blobs.slice(0, n));
  const ext = blob.type === 'audio/wav' ? 'wav' : 'mp3';
  P.lastFile = new File([blob], `genmedi-voice-${stamp()}.${ext}`, {type: blob.type});
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
      return await shareFiles([f], 'เสียงจาก Gen Medi');
    }
    if (navigator.share) return await navigator.share({title:'Gen Medi', text: text ? text.slice(0, 2000) : 'Gen Medi — สตูดิโอสร้างสื่อด้วย AI', url: location.href.split('#')[0]});
    await navigator.clipboard.writeText(location.href.split('#')[0]); toast('คัดลอกลิงก์แอปแล้ว');
  } catch(e){ if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ', true); }
};

/* ---------------- save to Mac + share (Android share sheet → Google Drive) ---------------- */
const extOf = t => /png/.test(t) ? 'png' : /webp/.test(t) ? 'webp' : /wav/.test(t) ? 'wav' : /mpeg|mp3/.test(t) ? 'mp3' : /jpe?g/.test(t) ? 'jpg' : /mp4/.test(t) ? 'mp4' : /webm/.test(t) ? 'webm' : /midi/.test(t) ? 'mid' : /zip/.test(t) ? 'zip' : /text/.test(t) ? 'txt' : 'bin';
const macSaved = new WeakSet();
async function saveToMac(blob, kind, name){
  if (!MAC.on || !S.macSave || !blob || macSaved.has(blob)) return;
  macSaved.add(blob);
  try {
    const file = blob instanceof File ? blob : new File([blob], `genmedi.${extOf(blob.type)}`, {type: blob.type});
    const r = await (await MAC.form('/api/save', {file, kind, name: (name || '').slice(0, 60)})).json();
    toast('💾 บันทึกลง Mac แล้ว: ' + String(r.path || '').split('/').slice(-3).join('/'));
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
  const ic = {tts:'i-vol', audio:'i-down', image:'i-image', video:'i-image'};
  let h = sheetHead('ประวัติการใช้งาน');
  h += items.length ? items.map(it => `<div class="item" data-id="${it.id}">
      ${it.kind === 'image' ? `<img src="${esc(it.url || (it.blob ? URL.createObjectURL(it.blob) : ''))}" alt="" loading="lazy">` : `<span class="ib"><svg class="i"><use href="#${ic[it.kind]}"/></svg></span>`}
      <div class="t"><b>${esc((it.text || it.prompt || '').slice(0, 80))}</b><small>${when(it.created)} · ${it.kind === 'image' ? 'ภาพ' : it.kind === 'video' ? 'วิดีโอ' : esc(it.voice || '')}${it.kind === 'audio' ? ' · มีไฟล์เสียง' : ''}</small></div>
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
      row.querySelector('[data-dl]')?.addEventListener('click', () => { const f = asFile(it.blob, it.kind === 'image' ? 'genmedi-image' : it.kind === 'video' ? 'genmedi-video' : 'genmedi-voice'); saveBlob(f, f.name); });
      row.querySelector('[data-sh]')?.addEventListener('click', () => shareFiles([asFile(it.blob, it.kind === 'image' ? 'genmedi-image' : it.kind === 'video' ? 'genmedi-video' : 'genmedi-voice')], (it.text || it.prompt || '').slice(0, 80)));
      row.querySelector('[data-del]').onclick = async () => { await db.del('history', it.id); row.remove(); };
    });
    el.querySelector('#hClear')?.addEventListener('click', async () => { await db.clear('history'); openHistory(); });
  });
}

/* ---------------- settings / install / about ---------------- */
function openSettings(){
  openSheet(sheetHead('ตั้งค่า') + `
    <label class="switch"><span>💼 โหมดเชิงพาณิชย์<br><small style="color:var(--mut)">ดาวน์โหลด/แชร์ได้เฉพาะงานที่สัญญาอนุญาตให้ใช้หารายได้</small></span><input type="checkbox" id="sComm" ${S.commercial ? 'checked' : ''}></label>
    <p class="hint">แอปนี้<b>ไม่ใช้ API ภายนอก</b> — ประมวลผลบนมือถือเครื่องนี้ หรือบน Mac ของคุณเท่านั้น ไม่มีคีย์ ไม่มีโควตา ไม่มีค่าใช้จ่าย</p>
    <button class="btn alt" style="width:100%;margin-top:8px" id="sMac">💻 เชื่อมต่อ Mac & ประมวลผล</button>
    <h4>ข้อมูลในเครื่อง</h4>
    <div class="row2"><button class="btn danger sm" id="kClrH">ล้างประวัติ</button><button class="btn danger sm" id="kClrC">ลบเสียงของฉันทั้งหมด</button></div>`,
  el => {
    el.querySelector('#sComm').onchange = e => { S.commercial = e.target.checked; save(); renderVoice(); };
    el.querySelector('#sMac').onclick = () => openProc();
    el.querySelector('#kClrH').onclick = async () => { await db.clear('history'); toast('ล้างประวัติแล้ว'); };
    el.querySelector('#kClrC').onclick = async () => { await db.clear('clones'); clones = []; if (S.voice?.type === 'clone') S.voice = null; save(); renderVoice(); toast('ลบเสียงของฉันแล้ว'); };
  });
}
/* ---------------- processing: this phone · this Mac · phone → Mac ---------------- */
const MAC_DMG = 'https://github.com/mengnattawitmarin/ai-voice/releases/download/mac/GenMedi-mac.dmg';
function pairFrom(text){
  text = (text || '').trim(); if (!text) return null;
  try {
    const u = new URL(isUrl(text) ? text : 'https://' + text);
    const sv = u.searchParams.get('server'), t = u.searchParams.get('t');
    if (sv) return {server: sv.replace(/\/+$/, ''), token: t || ''};
    return {server: u.origin, token: u.searchParams.get('t') || S.macToken || ''};
  } catch(e){ return null; }
}
async function openProc(){
  const sp = await getSpec();
  await MAC.refresh();
  const i = MAC.info, on = MAC.state === 'on' && i;
  const est = (k, chars) => { const v = speedOf(k); return `~${fmtDur(chars * v.v / 1000)}${v.measured ? ' (วัดจริง)' : ''}`; };
  const opt = (grp, val, cur, title, sub, dis) => `<button class="opt ${val === cur ? 'on' : ''}" data-g="${grp}" data-v="${val}" ${dis ? 'disabled style="opacity:.45"' : ''}><span class="dot"></span><span class="t"><b>${title}</b><small>${sub}</small></span></button>`;
  const models = on ? Object.entries(i.models || {}).map(([k, m]) => `<div class="item" style="display:flex;gap:8px;align-items:center"><span style="flex:1">${esc(m.name)}</span><span class="tag ${m.state === 'ready' ? 'ok' : m.state === 'error' ? 'bad' : 'warn'}">${m.state === 'ready' ? 'พร้อม' : m.state === 'downloading' ? 'กำลังโหลด ' + (m.pct || 0) + '%' : m.state === 'error' ? 'ผิดพลาด' : 'ยังไม่โหลด'}</span></div>`).join('') : '';
  let h = sheetHead('💻 เชื่อมต่อ Mac & ประมวลผล');
  h += `<p class="hint" style="margin-top:0">ใช้ได้ 3 แบบ: <b>มือถืออย่างเดียว</b> · <b>Mac อย่างเดียว</b> · <b>มือถือสั่ง Mac</b> — ทุกอย่างประมวลผลบนเครื่องของคุณเอง ไม่ใช้ API ภายนอก</p>`;
  if (MAC.local){
    h += `<h4>📱 สั่งงานจากมือถือ</h4>
      <div style="display:grid;place-items:center;background:#fff;border-radius:16px;padding:12px;margin:6px 0"><img id="pQr" src="/api/qr.svg?${Date.now()}" alt="QR" style="width:220px;height:220px"></div>
      <p class="hint" id="pQrMsg">${i?.tunnel ? 'สแกนด้วยกล้องมือถือ (หรือแอป Gen Medi) — ใช้ได้ทั้งในบ้านและนอกบ้าน' : 'กำลังสร้างลิงก์ปลอดภัย (https)… รอสักครู่'}</p>
      ${i?.pair ? `<input class="inp" readonly value="${esc(i.pair)}" onclick="this.select()">` : ''}
      <p class="hint">ลิงก์จะเปลี่ยนทุกครั้งที่เปิดแอปบน Mac ใหม่ — ต้องสแกนใหม่ · <a href="#" id="pReset">ยกเลิกการจับคู่ทุกเครื่อง</a></p>`;
  } else {
    h += `<h4>Mac ของฉัน</h4>`;
    h += on ? `<div class="item" style="display:block"><b>✓ เชื่อมแล้ว: ${esc(i.chip || 'Mac')}</b><small style="display:block;color:var(--mut);margin-top:4px">RAM ${i.ram_gb || '?'} GB · ${i.cores || '?'} คอร์ · Gen Medi ${esc(i.version || '')}</small></div>`
      : `<ol class="lim" style="padding-left:18px;font-size:14px"><li>ดาวน์โหลด <a href="${MAC_DMG}" target="_blank" rel="noopener"><b>Gen Medi for Mac (.dmg)</b></a> บน Mac</li><li>เปิดไฟล์ → ลากไอคอนไปที่ <b>Applications</b> → เปิดแอป (ครั้งแรก: ตั้งค่าระบบ › ความเป็นส่วนตัวและความปลอดภัย › <b>เปิดต่อไป</b>)</li><li>รอติดตั้งครั้งแรก แล้ว<b>สแกน QR</b> ที่ขึ้นบนหน้าจอ Mac ด้วยกล้องมือถือ</li></ol>`;
    h += `<div class="row2"><input class="inp" id="srvUrl" placeholder="หรือวางลิงก์จับคู่จาก Mac" value="${esc(S.serverUrl || '')}" autocomplete="off"><button class="btn" id="srvTest">เชื่อม</button></div><p class="hint" id="srvMsg">${MAC.on && !on ? 'ติดต่อ Mac ไม่ได้ — เปิดแอปบน Mac และสแกน QR ใหม่' : ''}</p>`;
    if (S.serverUrl) h += `<button class="btn alt sm" id="srvOff">ยกเลิกการเชื่อม Mac</button>`;
  }
  if (on){
    h += `<h4>โมเดลบน Mac</h4>${models}<button class="btn alt sm" id="pDl" style="margin-top:8px">ดาวน์โหลดโมเดลทั้งหมดตอนนี้</button>`;
    const small = (i.ram_gb || 16) < 14, gc = i.gpu_cores ? ` · GPU ${i.gpu_cores} คอร์` : '';
    const mEst = md => { const keep = S.macImg; S.macImg = md; const v = fmtDur(speedOf('img-mac').v / 1000); S.macImg = keep; return '~' + v + '/ภาพ'; };
    h += `<h4>โหมดสร้างภาพบน Mac${gc}</h4>
      ${opt('macImg','auto',IMG_MODE_LABEL[S.macImg] ? S.macImg : 'auto','อัตโนมัติ ' + licTag('img-mac'), 'เลือกให้ตามสเปค → ' + esc(IMG_MODE_LABEL[i.img_auto] || '') + ' · ' + mEst(i.img_auto || 'balanced'))}
      ${opt('macImg','fast',S.macImg,'⚡ เร็ว — Segmind-Vega', 'ใช้ได้ทุก Mac รวม M1 8GB · ' + mEst('fast'))}
      ${opt('macImg','balanced',S.macImg,'⚖️ สมดุล — FLUX.1-schnell 768px', small ? 'ต้องใช้ RAM 16GB ขึ้นไป' : 'คมกว่ามาก · ' + mEst('balanced'), small)}
      ${opt('macImg','quality',S.macImg,'💎 คมชัดสูง — FLUX.1-schnell 1024px', small ? 'ต้องใช้ RAM 16GB ขึ้นไป' : 'เหมาะกับ M1/M2 Pro·Max · ' + mEst('quality'), small)}`;
    h += `<label class="switch" style="margin-top:12px"><span>บันทึกงานลง Mac อัตโนมัติ<br><small style="color:var(--mut)" id="macDir">โฟลเดอร์: ${esc(i.save_dir || '?')}</small></span><input type="checkbox" id="macSave" ${S.macSave ? 'checked' : ''}></label>
      <div class="row2" style="margin-top:10px"><button class="btn alt sm" id="macPick">เปลี่ยนโฟลเดอร์ (เลือกบน Mac)</button>${MAC.local ? '<button class="btn alt sm" id="macOpen">เปิดโฟลเดอร์</button>' : ''}</div>
      <p class="hint">จัดเก็บเป็น <code>โฟลเดอร์/images|audio|videos|music/วันที่</code></p>`;
  }
  h += `<h4>เสียง AI ฟรีในมือถือ (ไม่ต้องใช้ Mac) — ประมวลผลบน</h4>
    ${opt('localDev','auto',S.localDev || 'auto','อัตโนมัติ (แนะนำ)', 'ใช้ GPU ถ้ามี ไม่งั้นใช้ CPU · 1,000 ตัวอักษร ' + est('local-' + (sp.gpu ? 'webgpu' : 'wasm'), 1000))}
    ${opt('localDev','webgpu',S.localDev,'GPU (WebGPU)', sp.gpu ? 'เร็วที่สุด · ' + est('local-webgpu', 1000) : 'เบราว์เซอร์นี้ไม่รองรับ', !sp.gpu)}
    ${opt('localDev','wasm',S.localDev,'CPU', 'ช้ากว่าแต่เสถียร · ' + est('local-wasm', 1000))}
    <p class="hint">เครื่องนี้: ${esc(sp.os)} · CPU ${sp.cores} คอร์${sp.mem ? ' · RAM ~' + sp.mem + ' GB' : ''} · GPU ${sp.gpu ? 'มี' : 'ไม่รองรับ'}</p>`;
  openSheet(h, el => {
    el.querySelectorAll('.opt[data-g]').forEach(b => b.onclick = async () => {
      if (b.disabled) return;
      const g = b.dataset.g, v = b.dataset.v; S[g] = v; save();
      el.querySelectorAll(`.opt[data-g="${g}"]`).forEach(x => x.classList.toggle('on', x === b));
      if (g === 'macImg') try { await MAC.json('/api/settings', {img_mode: v}); MAC.refresh(); } catch(e){ toast(e.message, true); }
      renderVoice(); renderEst(); renderImgEngine();
    });
    el.querySelector('#srvTest')?.addEventListener('click', async () => {
      const m = el.querySelector('#srvMsg'), p = pairFrom(el.querySelector('#srvUrl').value);
      if (!p){ S.serverUrl = ''; save(); m.textContent = ''; return; }
      S.serverUrl = p.server; if (p.token) S.macToken = p.token; save(); m.textContent = 'กำลังเชื่อมต่อ…';
      const r = await MAC.refresh();
      if (r){ toast('เชื่อม Mac แล้ว ✓'); openProc(); } else m.innerHTML = '<span style="color:var(--err)">เชื่อมไม่ได้ — ตรวจว่าแอปบน Mac เปิดอยู่ และใช้ลิงก์ล่าสุด</span>';
    });
    el.querySelector('#srvOff')?.addEventListener('click', () => { S.serverUrl = ''; S.macToken = ''; save(); MAC.info = null; MAC.state = 'off'; renderVoice(); renderQuota(); openProc(); });
    el.querySelector('#pDl')?.addEventListener('click', async () => { try { await MAC.form('/api/models/download', {keys: 'tts,voice,' + (curImgMode() === 'fast' ? 'vega' : 'flux')}); toast('เริ่มดาวน์โหลดบน Mac แล้ว'); setTimeout(openProc, 3000); } catch(e){ toast(e.message, true); } });
    el.querySelector('#macSave')?.addEventListener('change', e => { S.macSave = e.target.checked; save(); });
    el.querySelector('#macOpen')?.addEventListener('click', () => MAC.json('/api/open_folder'));
    el.querySelector('#macPick')?.addEventListener('click', async () => {
      const d = el.querySelector('#macDir'); d.textContent = 'ไปที่หน้าจอ Mac แล้วเลือกโฟลเดอร์ในหน้าต่างที่เด้งขึ้น…';
      try { const r = await (await MAC.json('/api/choose_folder')).json(); d.textContent = 'โฟลเดอร์: ' + r.path; MAC.refresh(); }
      catch(e){ d.textContent = 'เปลี่ยนโฟลเดอร์ไม่สำเร็จ: ' + (e.message || e); }
    });
    el.querySelector('#pReset')?.addEventListener('click', async e => { e.preventDefault(); await MAC.json('/api/token/reset'); toast('ยกเลิกแล้ว — มือถือทุกเครื่องต้องสแกน QR ใหม่'); setTimeout(openProc, 500); });
    const qr = el.querySelector('#pQr');
    if (qr && !i?.tunnel){ const t = setInterval(async () => { if (!document.body.contains(qr)){ clearInterval(t); return; } const r = await MAC.refresh(); if (r?.tunnel){ clearInterval(t); openProc(); } }, 3000); }
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
    <li class="y">✓ <b>ไม่ใช้ API ภายนอก</b> — ประมวลผลบนมือถือ หรือบน Mac ของคุณ (ไม่มีคีย์ ไม่มีโควตา ไม่มีค่าใช้จ่าย)</li>
    <li class="y">✓ 3 แบบ: มือถืออย่างเดียว · Mac อย่างเดียว (แอป Gen Medi for Mac) · มือถือสั่ง Mac ผ่าน QR (ใช้ได้นอกบ้าน)</li>
    <li class="y">✓ 💼 เสียงพากย์ KhanomTan v1.1 (Apache-2.0) บน Mac · เสียงของฉันด้วย OpenVoice V2 (MIT)</li>
    <li class="y">✓ 💼 ภาพ FLUX.1-schnell / Segmind-Vega (Apache-2.0) บน GPU ของ Mac บันทึกลงโฟลเดอร์ที่เลือก</li>
    <li class="y">✓ เปลี่ยนเสียง (เพศ/วัย/เอฟเฟกต์ 32 แบบ) · SFX · เพลงประกอบ · สตูดิโอวิดีโอ · โหมดคัฟเวอร์/ไลฟ์ — ทำในมือถือได้</li>
    <li class="m">△ KhanomTan v1.1 ใช้ผู้พูดจากชุดข้อมูลสาธารณะ (ยุโรป) อ่านภาษาไทย — สำเนียงยังไม่เป็นธรรมชาติเท่าบริการคลาวด์ แนะนำใช้ “เสียงของฉัน” เพื่อให้เสียงเป็นคนไทย</li>
    <li class="m">△ เสียง AI ฟรีในมือถือ (MMS/VITS) เป็น CC-BY-NC — ใช้ส่วนตัว/ทดลองบทเท่านั้น</li>
    <li class="m">△ สร้างภาพบนมือถืออย่างเดียวยังไม่ได้ (โมเดลใหญ่เกิน) ต้องเชื่อม Mac</li>
    <li class="m">△ Mac ต้องเปิดแอปค้างไว้ตอนใช้ · ลิงก์จับคู่เปลี่ยนทุกครั้งที่เปิดแอปบน Mac ใหม่ (สแกน QR ใหม่)</li>
    <li class="m">△ “ใช้หารายได้ได้” หมายถึงสัญญาอนุญาตของโมเดลอนุญาต — ยังต้องทำตามนโยบายแพลตฟอร์มและกฎหมาย ไม่ใช่คำปรึกษากฎหมาย</li>
    <li class="n">✗ โคลน “เสียงใครก็ได้” โดยไม่ได้รับอนุญาต — ใช้เฉพาะเสียงตัวเองหรือที่เจ้าของยินยอม</li>
    <li class="n">✗ ดึงเพลงจาก YouTube/Spotify — โหมดคัฟเวอร์รับไฟล์ที่คุณมีสิทธิ์ใช้เท่านั้น</li></ul>
    <p class="hint">ไลบรารีที่ใช้: transformers.js · Coqui TTS · OpenVoice · MFLUX · diffusers · pdf.js · mammoth · tesseract.js · mp4-muxer · lamejs · Cloudflare quick tunnel</p>`);
}
/* ---------------- clone page ---------------- */
let mr = null, recBlob = null, recTimer = null;
const recBtn = $('#btnRec'), recState = $('#recState');
$$('#cloneGender .chip').forEach(b => b.onclick = () => $$('#cloneGender .chip').forEach(x => x.classList.toggle('on', x === b)));
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
$('#btnCloneSave').onclick = async () => {
  if (!recBlob) return toast('อัดหรืออัปโหลดเสียงต้นแบบก่อน', true);
  if (!$('#cloneConsent').checked) return toast('ต้องยืนยันว่าเป็นเสียงของคุณหรือได้รับอนุญาตแล้ว', true);
  const name = $('#cloneName').value.trim() || 'เสียงของฉัน';
  const gender = $('#cloneGender .chip.on')?.dataset.v || 'm';
  const rec = {id: 'c' + Date.now(), name, refText: '', gender, blob: recBlob, created: Date.now(), tested: false};
  await db.put('clones', rec); clones.unshift(rec); renderClones(); renderVoice();
  testClone(rec);
};
async function testClone(rec){
  const b = $('#btnCloneSave'), hint = $('#cloneHint'), out = $('#cloneOut');
  if (!MAC.on){ hint.innerHTML = 'บันทึกเสียงไว้แล้ว — <a href="#" id="cMac">เชื่อม Mac</a> เพื่อทดสอบและใช้งาน (OpenVoice รันบน Mac)'; $('#cMac').onclick = e => { e.preventDefault(); openProc(); }; return; }
  b.disabled = true; hint.innerHTML = '<span class="spin" style="display:inline-block;width:14px;height:14px;border-width:2px;vertical-align:-2px;margin-right:6px"></span>กำลังสร้างเสียงทดสอบบน Mac…';
  const sample = S.lang === 'en' ? 'Hello, this is my voice made on my own computer. Does it sound like me?' : 'สวัสดีครับ นี่คือเสียงที่สร้างจากตัวอย่างของฉันบนเครื่องของฉันเอง ฟังดูเหมือนไหม';
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
    <div class="t"><b>${esc(c.name)} ${c.tested ? '<span class="tag ok">ใช้ได้</span>' : '<span class="tag warn">ยังไม่ทดสอบ</span>'}</b><small>${c.gender === 'f' ? 'เสียงผู้หญิง' : 'เสียงผู้ชาย'} · ${new Date(c.created).toLocaleDateString('th-TH')}</small></div>
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
$('#imgPrompt').value = LS.get('imgPrompt', '');
$('#imgPrompt').oninput = e => LS.set('imgPrompt', e.target.value);
$('#btnImgFromText').onclick = () => { const t = ta.value.trim(); if (!t) return toast('หน้าแปลงเสียงยังไม่มีข้อความ'); $('#imgPrompt').value = t.slice(0, 600); LS.set('imgPrompt', t.slice(0, 600)); toast('นำข้อความมาใช้แล้ว'); };
function imgPrompt(prompt){ const st = IMG_STYLES.find(s => s[0] === S.imgStyle)?.[2]; return prompt + (st ? ', ' + st : ''); }
function renderImgEngine(){
  const box = $('#imgEngine'); if (!box) return;
  const cur = IMG_MODE_LABEL[S.macImg] ? S.macImg : 'auto';
  chips(box, Object.entries(IMG_MODE_LABEL).map(([k, n]) => [k, k === 'auto' && MAC.info?.img_auto ? n + ' (' + IMG_MODE_LABEL[MAC.info.img_auto].replace(/^\S+ /, '') + ')' : n]), cur, async v => { S.macImg = v; save(); renderEst(); try { await MAC.json('/api/settings', {img_mode: v}); MAC.refresh(); } catch(e){} });
}
renderImgEngine();
let imgBusy = false;
function loadImg(url, ms = 120000){
  return new Promise((res, rej) => { const im = new Image(); const t = setTimeout(() => { im.src = ''; rej(new Error('หมดเวลา')); }, ms);
    im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); rej(new Error('สร้างภาพไม่สำเร็จ')); }; im.src = url; });
}
async function shotFile(div, url){
  if (div._file) return div._file;
  const b = await (await fetch(url)).blob();
  return div._file = asFile(b, 'genmedi-image');
}
function shotActions(div, url, prompt){
  div.querySelector('[data-dl]').onclick = async () => { try { const f = await shotFile(div, url); saveBlob(f, f.name); } catch(e){ window.open(url, '_blank'); } };
  div.querySelector('[data-sh]').onclick = async () => { try { await shareFiles([await shotFile(div, url)], prompt.slice(0, 80)); } catch(e){ toast('แชร์ไม่สำเร็จ', true); } };
  div.querySelector('[data-re]').onclick = () => renderShot(div, prompt, Math.floor(Math.random() * 1e9));
}
function showShot(div, im, url, prompt, note){
  im.alt = prompt;
  div.innerHTML = `<div class="acts"><button data-re aria-label="วาดใหม่"><svg class="i"><use href="#i-refresh"/></svg></button><button data-sh aria-label="แชร์"><svg class="i"><use href="#i-share"/></svg></button><button data-dl aria-label="ดาวน์โหลด"><svg class="i"><use href="#i-download"/></svg></button></div>${note ? `<span class="note">${esc(note)}</span>` : ''}`;
  div.prepend(im); div._file = null; shotActions(div, url, prompt);
  if (MAC.on && S.macSave) shotFile(div, url).then(f => saveToMac(f, 'images', prompt.slice(0, 40))).catch(() => {});
}
async function renderShot(div, prompt, seed){
  div.innerHTML = `<div class="ld"><div class="spin"></div>กำลังวาดบน Mac…</div>`;
  try {
    const [, w, h] = RATIOS.find(r => r[0] === S.imgRatio) || RATIOS[0];
    const r = await MAC.image(imgPrompt(prompt), w, h, seed);
    const url = URL.createObjectURL(r.blob);
    showShot(div, await loadImg(url), url, prompt);
    addHistory({kind:'image', prompt, blob: r.blob, lk: 'img-mac'});
  } catch(e){
    div.innerHTML = `<div class="ld">${esc(e.message)}<br><button class="btn sm alt" style="margin-top:8px">ลองใหม่</button></div>`;
    div.querySelector('button').onclick = () => renderShot(div, prompt, seed);
  }
}
$('#btnImg').onclick = async () => {
  const prompt = $('#imgPrompt').value.trim(); if (!prompt) return toast('พิมพ์คำอธิบายภาพก่อนนะ');
  if (!MAC.on) return openProc();
  if (imgBusy) return; imgBusy = true;
  const btn = $('#btnImg'); btn.classList.add('busy'); btn.disabled = true;
  const grid = $('#imgGrid'); grid.innerHTML = ''; grid.classList.toggle('one', S.imgCount === 1);
  const shots = Array.from({length: S.imgCount}, () => { const d = document.createElement('div'); d.className = 'shot'; d.innerHTML = '<div class="ld">รอคิว…</div>'; grid.appendChild(d); return d; });
  const seeds = shots.map(() => Math.floor(Math.random() * 1e9));
  for (let i = 0; i < shots.length; i++){
    $('#imgStatus').textContent = `กำลังวาดภาพที่ ${i+1}/${shots.length} บน Mac`;
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
  const qs = new URLSearchParams(location.search), sv = qs.get('server'), tk = qs.get('t');
  if (tk) S.macToken = tk;
  if (sv && isUrl(sv)){ S.serverUrl = sv.replace(/\/+$/, ''); S.imgEngine = 'mac'; if (!S.voice || S.voice.type === 'device') S.voice = {type:'mac', id:'Linda'}; }
  if (sv || tk){
    save(); history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => { toast('เชื่อม Mac แล้ว — เสียงพากย์ 💼 และสร้างภาพจะประมวลผลบน Mac'); MAC.refresh(); }, 500);
  }
  if (SAME_ORIGIN && (!S.voice || S.voice.type === 'device')){ S.voice = {type:'mac', id:'Linda'}; save(); }
  if (MAC.local && !LS.get('macIntro', false)){ LS.set('macIntro', true); setTimeout(openProc, 1500); }
} catch(e){}
enforceCommercial();
onText(); renderVoice(); ui(); renderQuota();
/* image generation helper for the studio: returns {blob, lk} — always on the Mac */
async function genImage(prompt, ratio){
  const [, w, h] = RATIOS.find(r => r[0] === (ratio || S.imgRatio)) || RATIOS[0];
  const r = await MAC.image(imgPrompt(prompt), w, h, Math.floor(Math.random() * 1e9));
  addHistory({kind:'image', prompt, blob: r.blob, lk: 'img-mac'});
  return {blob: r.blob, lk: 'img-mac'};
}
/* public API used by studio.js */
window.GM = { srcGenderOf, openVoiceFx, S, LS, db, save, toast, openSheet, closeAll, sheetHead, esc, sleep, stamp, saveBlob, shareFiles, saveToMac, asFile, addHistory,
  curVoice, synthesize, makeChunks, mergeAudio, decode, encodeWav, genImage, allowed, lic, licTag, voiceLicKey, go, status, effRate,
  RATIOS, IMG_STYLES, openSettings, openProc, setRangeFill, renderEst, isUrl, getSpec, fmtDur, SPEED, MAC, ta };
window.dispatchEvent(new Event('gm:ready'));
const h0 = location.hash.slice(1); go(PAGES[h0] ? h0 : 'home');
addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES[h]) go(h); });
addEventListener('keydown', e => { if (e.key === 'Escape'){ closeAll(); $('#editor').classList.remove('full'); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
