/* Gen Medi — 🎓 train your own Thai voice
   1) record a dataset of your own voice, sentence by sentence (stored on the Mac)
   2) Whisper checks every clip against its sentence
   3) the Mac fine-tunes KhanomTan v1.1 (Apache-2.0) with your voice → a clear native-Thai voice you own */
const GM = window.GM, $ = s => document.querySelector(s);
const DS = 'mine', TARGET = 800, MIN_TRAIN = 100, KT_MIN = 300;
const st = Object.assign({custom: [], ai: [], skip: []}, GM.LS.get('vtSet', {}));
const saveSt = () => GM.LS.set('vtSet', st);
let base = [], status = null, cur = null, rec = null, lastKey = null, busy = false;

const norm = t => t.replace(/\s+/g, ' ').trim();
async function keyOf(t){
  const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(norm(t)));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
async function loadBase(){
  if (base.length) return;
  try { base = (await (await fetch('train/sentences-th.txt', {cache: 'no-cache'})).text()).split('\n').map(norm).filter(Boolean); }
  catch(e){ base = []; }
}
async function pool(){
  const all = [...st.custom, ...base, ...st.ai].map(norm).filter(s => s.length >= 4);
  const seen = new Set(), out = [];
  for (const t of all){ if (!seen.has(t)){ seen.add(t); out.push({t, k: await keyOf(t)}); } }
  return out;
}
async function refresh(){
  try { status = await (await GM.MAC.call('/api/ds/' + DS, {}, 20000)).json(); } catch(e){ status = null; throw e; }
}
async function nextSentence(){
  const items = status?.items || {}, p = await pool();
  const todo = p.filter(x => !items[x.k] && !st.skip.includes(x.k));
  return {sentence: todo[0] || null, left: todo.length, total: p.length};
}
const fmtMin = m => m < 60 ? m.toFixed(1) + ' นาที' : (m / 60).toFixed(1) + ' ชม.';

function shell(root){
  root.innerHTML = `
  <div class="card"><div class="card-h"><h2>🎓 สร้างโมเดลเสียงไทยของฉัน</h2></div>
    <p class="hint" style="margin-top:0">อ่านประโยคทีละประโยค → Mac เก็บเป็นชุดข้อมูล → เทรนโมเดลเสียงไทยชัดๆ ที่เป็นของคุณเอง (ใช้หารายได้ได้เต็มที่)</p>
    <div class="vt-prog"><div class="bar"><i id="vtBar"></i></div><div class="vt-stats" id="vtStats">กำลังโหลด…</div></div>
  </div>
  <div class="card vt-rec">
    <div class="vt-meta" id="vtMeta"></div>
    <div class="vt-sent" id="vtSent">…</div>
    <div class="vt-res" id="vtRes"></div>
    <button class="vt-mic" id="vtMic" aria-label="อัด"><span class="dot"></span><b id="vtMicT">กดเพื่ออัด</b></button>
    <div class="row2" style="margin-top:10px"><button class="btn alt sm" id="vtPlay" disabled>▶ ฟังที่อัด</button><button class="btn alt sm" id="vtRedo" disabled>↺ อัดใหม่</button><button class="btn alt sm" id="vtSkip">⏭ ข้าม</button></div>
    <p class="hint" id="vtTip">ห้องเงียบ · ไมค์เดิม ระยะเดิม (~20 ซม.) · อ่านเป็นธรรมชาติด้วยน้ำเสียงเดิมทุกประโยค · บน Mac กด <b>Space</b> เพื่ออัด/หยุด</p>
  </div>
  <div class="card"><div class="card-h"><h2>⚡ นำเข้าจากไฟล์เสียงเก่า (ไม่ต้องอ่านทีละประโยค)</h2></div>
    <p class="hint" style="margin-top:0">มีคลิป/ไลฟ์/พอดแคสต์ที่คุณพูดเองอยู่แล้ว? อัปโหลดได้เลย — Whisper ถอดเสียง ตัดเป็นประโยค และใส่ชุดข้อมูลให้อัตโนมัติ · ต้องเป็นเสียงคุณคนเดียว ไม่มีเพลงพื้นหลัง ไม่มีคนอื่นพูดแทรก</p>
    <label class="btn alt sm" style="display:block;text-align:center">📁 เลือกไฟล์เสียง/วิดีโอ (ยาวได้หลายชั่วโมง)<input type="file" id="vtImp" accept="audio/*,video/*" multiple hidden></label>
    <p class="hint" id="vtImpSt"></p>
  </div>
  <div class="card"><div class="card-h"><h2>📚 ประโยคสำหรับอ่าน</h2></div>
    <p class="hint" style="margin-top:0" id="vtPoolInfo"></p>
    <button class="btn alt sm" id="vtAi" style="width:100%">✨ ให้ AI บน Mac แต่งประโยคเพิ่ม 60 ประโยค</button>
    <details style="margin-top:10px"><summary class="hint" style="cursor:pointer">➕ ใส่บทของฉันเอง (แนะนำ: บทคลิปจริงที่จะใช้)</summary>
      <textarea id="vtCustom" rows="5" placeholder="วางบท 1 บรรทัด = 1 ประโยค (ยาว 1–2 วินาทีถึง ~15 วินาที)" style="width:100%;margin-top:8px;padding:12px;border-radius:12px;background:#0b1030;color:inherit;border:1px solid #fff2;font:inherit"></textarea>
      <button class="btn sm" id="vtAddCustom" style="margin-top:8px">เพิ่มเข้าคิวอ่าน</button></details>
  </div>
  <div class="card"><div class="card-h"><h2>🔎 ตรวจคุณภาพ</h2></div>
    <p class="hint" style="margin-top:0">Whisper บน Mac ฟังทุกประโยคแล้วเทียบกับข้อความ ประโยคที่อ่านผิด/ไม่ชัดจะให้อัดใหม่</p>
    <button class="btn alt sm" id="vtCheck" style="width:100%">ตรวจประโยคที่ยังไม่ได้ตรวจ</button>
    <div id="vtBad" style="margin-top:10px"></div>
  </div>
  <div class="card"><div class="card-h"><h2>🧠 เทรนโมเดล</h2></div>
    <label class="lbl2" style="margin-top:0">เทรนอัตโนมัติ</label>
    <div class="chips" id="vtAuto"><button class="chip" data-v="off">ปิด</button><button class="chip" data-v="night">🌙 ตอนกลางคืน (เที่ยงคืน–6 โมง)</button><button class="chip" data-v="now">ทันทีเมื่อถึงเกณฑ์</button></div>
    <p class="hint">เทรน VoxCPM2 เองเมื่อครบ 100 ประโยค แล้วเทรนใหม่เองทุกครั้งที่อัดเพิ่มอีก 100 ประโยค (ตอน Mac ว่าง) · ตรวจคุณภาพด้วย Whisper ให้เองทุก 50 ประโยค</p>
    <label class="switch"><span>⚡ โหมดเร็ว<br><small style="color:var(--mut)">ล็อกส่วนอ่านตัวอักษรไทยที่โมเดลรู้แล้ว เทรนเฉพาะเสียงและจังหวะ</small></span><input type="checkbox" id="vtFast"></label>
    <div id="vtTrain" style="margin-top:12px"></div></div>
  <div class="card"><div class="card-h"><h2>📦 สำรอง / ย้ายไปเครื่องอื่น</h2></div>
    <p class="hint" style="margin-top:0">ไฟล์ zip เดียว: โมเดลเสียงที่เทรน · LoRA ภาพ · ชุดข้อมูลเสียง · เสียงโคลน (ไม่รวมโมเดลพื้นฐานที่ดาวน์โหลดใหม่ได้)</p>
    <div class="row2"><button class="btn alt sm" id="vtBak">⬇️ ดาวน์โหลดไฟล์สำรอง</button><label class="btn alt sm" style="text-align:center">⬆️ กู้คืนจากไฟล์<input type="file" id="vtRes2" accept=".zip,application/zip" hidden></label></div>
  </div>`;
}

async function render(){
  const root = $('#vtRoot'); if (!root) return;
  if (!GM.MAC.on){ root.innerHTML = `<div class="card"><div class="lim">การเทรนเสียงทำบน Mac ของคุณ <button class="btn sm" style="margin-left:6px" id="vtConn">เชื่อมต่อ Mac</button></div></div>`; $('#vtConn').onclick = () => GM.openProc(); return; }
  if (!root.dataset.ready){ shell(root); bind(); root.dataset.ready = '1'; }
  await loadBase();
  try { await refresh(); } catch(e){ $('#vtStats').textContent = 'ติดต่อ Mac ไม่ได้: ' + e.message; return; }
  const n = await nextSentence(); cur = n.sentence;
  const c = status.count, pct = Math.min(100, c / TARGET * 100);
  $('#vtBar').style.width = pct + '%';
  $('#vtStats').innerHTML = `<b>${c}</b> / ${TARGET} ประโยค · ${fmtMin(status.minutes || 0)} · ตรวจแล้ว ${status.checked}${status.bad ? ` · <span style="color:#f88">ต้องอัดใหม่ ${status.bad}</span>` : ''}<br><small>${c < MIN_TRAIN ? `อีก ${MIN_TRAIN - c} ประโยคจะเริ่มเทรนรอบแรกได้` : c < TARGET ? 'เทรนได้แล้ว · อัดถึง ' + TARGET + ' จะเป็นธรรมชาติขึ้นอีก' : 'ข้อมูลครบแล้ว 🎉'}</small>`;
  $('#vtMeta').textContent = cur ? `ประโยคถัดไป · เหลือในคิว ${n.left}` : '';
  $('#vtSent').textContent = cur ? cur.t : 'อ่านครบทุกประโยคในคิวแล้ว 🎉 — ให้ AI แต่งเพิ่ม หรือใส่บทของคุณเองด้านล่าง';
  $('#vtMic').disabled = !cur;
  $('#vtPoolInfo').textContent = `ในคิวทั้งหมด ${n.total} ประโยค (พื้นฐาน ${base.length} · ของฉัน ${st.custom.length} · AI ${st.ai.length}) — เป้าหมาย ${TARGET} ประโยค ≈ 1 ชั่วโมง`;
  const se = status.settings || {};
  document.querySelectorAll('#vtAuto .chip').forEach(b => b.classList.toggle('on', b.dataset.v === (se.auto || 'off')));
  $('#vtFast').checked = se.fast !== false;
  renderBad(); renderTrain();
}

async function backup(){
  GM.toast('Mac กำลังรวมไฟล์สำรอง…');
  try {
    const r = await GM.MAC.call('/api/backup', {}, 30 * 60e3);
    const name = (r.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)/)?.[1] || 'GenMedi-backup.zip';
    GM.saveBlob(await r.blob(), name);
  } catch(e){ GM.toast('สำรองไม่สำเร็จ: ' + e.message, true); }
}
async function restore(file){
  if (!file) return;
  if (!confirm('กู้คืนจาก ' + file.name + '? ไฟล์ชื่อซ้ำบน Mac จะถูกแทนที่')) return;
  try { const r = await (await GM.MAC.form('/api/restore', {file}, 30 * 60e3)).json(); GM.toast(`กู้คืนแล้ว ${r.restored} ไฟล์`); await GM.MAC.refresh(); render(); }
  catch(e){ GM.toast('กู้คืนไม่สำเร็จ: ' + e.message, true); }
}

function renderBad(){
  const box = $('#vtBad'); if (!box) return;
  const bad = Object.entries(status?.items || {}).filter(([, v]) => v.qc && !v.qc.ok);
  const warn = Object.entries(status?.items || {}).filter(([, v]) => !v.qc && v.warn?.length);
  box.innerHTML = [...bad, ...warn].slice(0, 40).map(([k, v]) => `<div class="item" style="display:block" data-k="${k}">
      <div style="font-size:15px">${GM.esc(v.text)}</div>
      <small style="color:#f99">${v.qc ? `Whisper ได้ยิน: “${GM.esc(v.qc.heard || '')}” (ผิด ${Math.round(v.qc.cer * 100)}%)` : GM.esc(v.warn.join(' · '))}</small>
      <div class="row2" style="margin-top:6px"><button class="btn alt sm" data-p>▶ ฟัง</button><button class="btn sm" data-r>🎤 อัดใหม่</button><button class="btn alt sm" data-ok>ใช้ได้</button><button class="btn alt sm" data-d>ลบ</button></div></div>`).join('')
    || (status?.checked ? '<p class="hint">ไม่มีประโยคที่ต้องแก้ 👍</p>' : '');
  box.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k, v = status.items[k];
    el.querySelector('[data-p]').onclick = () => play(k);
    el.querySelector('[data-r]').onclick = () => { cur = {t: v.text, k}; $('#vtSent').textContent = v.text; $('#vtMeta').textContent = 'อัดใหม่'; $('#vtMic').disabled = false; $('#vtSent').scrollIntoView({behavior: 'smooth', block: 'center'}); };
    el.querySelector('[data-d]').onclick = async () => { await GM.MAC.call('/api/ds/' + DS + '/clip/' + k, {method: 'DELETE'}); render(); };
    el.querySelector('[data-ok]').onclick = () => { v.qc = {ok: true, cer: 0}; v.warn = []; el.remove(); };
  });
}

async function play(k){
  try { const b = await (await GM.MAC.call('/api/ds/' + DS + '/clip/' + k, {}, 20000)).blob(); const a = new Audio(URL.createObjectURL(b)); a.play(); }
  catch(e){ GM.toast(e.message, true); }
}

async function toggleRec(){
  if (busy) return;
  if (rec){ rec.stop(); return; }
  if (!cur) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return GM.toast('อุปกรณ์นี้อัดเสียงในเว็บไม่ได้', true);
  try {
    // raw mic: no noise suppression / AGC — their artifacts would be learned by the model
    const s = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}});
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    const parts = [], m = new MediaRecorder(s, mime ? {mimeType: mime, audioBitsPerSecond: 192000} : {}), sent = cur;
    m.ondataavailable = e => e.data.size && parts.push(e.data);
    m.onstop = () => { s.getTracks().forEach(t => t.stop()); rec = null; micUi(false); upload(new Blob(parts, {type: parts[0]?.type || 'audio/webm'}), sent); };
    await new Promise(r => setTimeout(r, 120));   // let the mic settle so the first syllable isn't clipped
    m.start(); rec = m; micUi(true);
  } catch(e){ GM.toast('เปิดไมค์ไม่ได้: ' + (e.message || e), true); }
}
function micUi(on){ $('#vtMic').classList.toggle('on', on); $('#vtMicT').textContent = on ? 'กำลังอัด… กดเพื่อหยุด' : 'กดเพื่ออัด'; }

async function upload(blob, sent){
  busy = true; $('#vtRes').innerHTML = '<span class="hint">กำลังส่งให้ Mac…</span>';
  try {
    const f = new File([blob], 'clip.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'), {type: blob.type});
    const r = await (await GM.MAC.form('/api/ds/' + DS + '/clip', {audio: f, text: sent.t}, 60000)).json();
    lastKey = r.key; $('#vtPlay').disabled = $('#vtRedo').disabled = false;
    const ok = !r.warn?.length;
    $('#vtRes').innerHTML = ok ? `<span style="color:#6ee7b7">✓ บันทึกแล้ว ${r.dur} วิ</span>` : `<span style="color:#fbbf24">⚠️ ${GM.esc(r.warn.join(' · '))}</span>`;
    if (ok){ await render(); }   // advance automatically
    else { status.items[r.key] = {text: sent.t, dur: r.dur, warn: r.warn}; cur = sent; }
  } catch(e){ $('#vtRes').innerHTML = `<span style="color:#f88">${GM.esc(e.message)}</span>`; cur = sent; }
  busy = false;
}

function bind(){
  document.querySelectorAll('#vtAuto .chip').forEach(b => b.onclick = async () => {
    try { await GM.MAC.form('/api/ds/' + DS + '/settings', {auto: b.dataset.v}); document.querySelectorAll('#vtAuto .chip').forEach(x => x.classList.toggle('on', x === b)); GM.toast(b.dataset.v === 'off' ? 'ปิดเทรนอัตโนมัติ' : 'เปิดเทรนอัตโนมัติแล้ว'); }
    catch(e){ GM.toast(e.message, true); }
  });
  $('#vtFast').onchange = e => GM.MAC.form('/api/ds/' + DS + '/settings', {fast: e.target.checked ? 1 : 0}).catch(err => GM.toast(err.message, true));
  $('#vtBak').onclick = backup;
  $('#vtRes2').onchange = e => { restore(e.target.files[0]); e.target.value = ''; };
  $('#vtImp').onchange = async e => {
    const files = [...e.target.files]; e.target.value = ''; const stEl = $('#vtImpSt');
    for (const [i, f] of files.entries()){
      try {
        stEl.textContent = `กำลังส่งไฟล์ ${i + 1}/${files.length} ให้ Mac… (${(f.size / 1e6).toFixed(0)} MB)`;
        const fd = new FormData(); fd.append('audio', f, f.name);
        const r = await window.GMTools.macJob('/api/ds/' + DS + '/import', fd, j => { stEl.textContent = `ไฟล์ ${i + 1}/${files.length}: ` + (j.state === 'queued' ? 'รอคิวบน Mac…' : (j.msg || '') + (j.total && j.step ? ` ${j.step}/${j.total}` : '')); });
        const res = await r.json().catch(() => ({}));
        stEl.textContent = `✓ ไฟล์ ${i + 1}: เพิ่ม ${res.added ?? '?'} ประโยค · ข้าม ${res.skipped ?? '?'}`;
      } catch(err){ stEl.textContent = 'ไม่สำเร็จ: ' + err.message; break; }
    }
    render();
  };
  $('#vtMic').onclick = toggleRec;
  $('#vtPlay').onclick = () => lastKey && play(lastKey);
  $('#vtRedo').onclick = () => { const v = lastKey && status?.items?.[lastKey]; if (v){ cur = {t: v.text, k: lastKey}; $('#vtSent').textContent = v.text; $('#vtRes').innerHTML = ''; toggleRec(); } };
  $('#vtSkip').onclick = () => { if (cur){ st.skip.push(cur.k); saveSt(); $('#vtRes').innerHTML = ''; render(); } };
  $('#vtAddCustom').onclick = () => {
    const lines = $('#vtCustom').value.split(/\n+/).map(norm).filter(s => s.length >= 4);
    if (!lines.length) return GM.toast('ยังไม่มีบรรทัด', true);
    st.custom = [...lines, ...st.custom]; saveSt(); $('#vtCustom').value = ''; GM.toast(`เพิ่ม ${lines.length} ประโยคไว้หน้าคิวแล้ว`); render();
  };
  $('#vtAi').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; const t0 = b.textContent;
    try {
      const topics = ['ชีวิตประจำวัน', 'รีวิวสินค้า', 'ท่องเที่ยว', 'อาหาร', 'ข่าวและสาระ', 'นิทานและเรื่องเล่า', 'การเงินและงาน', 'ความรู้สึกและคำพูดในบทสนทนา', 'เทคโนโลยี', 'สุขภาพ'];
      const topic = topics[(st.ai.length / 60 | 0) % topics.length];
      const r = await window.GMTools.macJob('/api/llm', {
        system: 'คุณเป็นนักเขียนภาษาไทย เขียนประโยคภาษาไทยที่ถูกต้อง เป็นธรรมชาติ หลากหลายคำศัพท์และวรรณยุกต์',
        prompt: `แต่งประโยคภาษาไทย 60 ประโยค หัวข้อ "${topic}" สำหรับให้คนอ่านออกเสียงบันทึกเป็นข้อมูลสอน AI เสียงพูด\nกติกา: บรรทัดละ 1 ประโยค ไม่ใส่ลำดับเลข ไม่ใส่เครื่องหมายคำพูด ยาว 6–25 คำ เขียนตัวเลขเป็นคำอ่าน (เช่น สามสิบห้า) ไม่ใช้ภาษาอังกฤษ ไม่ซ้ำกัน`,
        max_tokens: 2400}, j => { b.textContent = j.state === 'queued' ? 'รอคิวบน Mac…' : 'AI กำลังแต่ง… (ครั้งแรกต้องโหลดโมเดล ~4GB)'; });
      const txt = (await r.json()).text || '';
      const lines = txt.split('\n').map(l => norm(l.replace(/^\s*[\d๐-๙]+[.)\-:]\s*/, '').replace(/^[-•*"“”]+|["“”]+$/g, ''))).filter(l => l.length >= 10 && l.length <= 140 && !/[a-zA-Z]{3,}/.test(l));
      st.ai.push(...lines); saveSt(); GM.toast(`ได้ประโยคใหม่ ${lines.length} ประโยค (${topic})`); render();
    } catch(err){ GM.toast('แต่งประโยคไม่สำเร็จ: ' + err.message, true); }
    b.disabled = false; b.textContent = t0;
  };
  $('#vtCheck').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; const t0 = b.textContent;
    try {
      const fd = new FormData(); fd.append('all', '0');
      await window.GMTools.macJob('/api/ds/' + DS + '/check', fd, j => { b.textContent = j.state === 'queued' ? 'รอคิวบน Mac…' : (j.msg || 'กำลังตรวจ…'); });
      GM.toast('ตรวจเสร็จแล้ว'); await render();
    } catch(err){ GM.toast('ตรวจไม่สำเร็จ: ' + err.message, true); }
    b.disabled = false; b.textContent = t0;
  };
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || !document.querySelector('.page.on[data-page="voicetrain"]')) return;
    if (/^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault(); toggleRec();
  });
}

let pollT = null;
const fmtEta = s => s > 3600 ? (s / 3600).toFixed(1) + ' ชม.' : Math.max(1, Math.round(s / 60)) + ' นาที';
function renderTrain(){
  const box = $('#vtTrain'); if (!box) return;
  const c = status?.count || 0, good = c - (status?.bad || 0), tr = status?.train, md = status?.model;
  const running = tr && (tr.state === 'running' || tr.state === 'starting');
  let h = '', vx = '';
  if (c >= 3) vx += `<div class="item" style="display:block;margin-bottom:10px"><b>⚡ ใช้เสียงคุณได้เลย ไม่ต้องรอเทรน (VoxCPM2)</b><br><small>VoxCPM2 โคลนเสียงจากประโยคที่คุณอัดไว้ · ไทยชัด · ครั้งแรก Mac โหลดโมเดล ~5GB</small>
      <textarea id="vxTry" rows="2" style="width:100%;margin-top:8px;padding:10px;border-radius:10px;background:#0b1030;color:inherit;border:1px solid #fff2;font:inherit">สวัสดีครับ วันนี้ผมจะมาเล่าเรื่องที่น่าสนใจให้ฟังกัน ฟังเสียงนี้แล้วเหมือนผมไหมครับ</textarea>
      <div class="row2" style="margin-top:8px"><button class="btn sm" id="vxListen">▶ ฟังเสียงฉัน (VoxCPM2)</button><button class="btn alt sm" id="vxUse">ใช้เป็นเสียงพากย์</button></div></div>`;
  if (md) h += `<div class="item" style="display:block"><b>${GM.esc(md.label)}</b><br><small>ใช้อยู่${md.step ? ' · ขั้นที่ ' + md.step : ''}${md.score ? ` · ชัด ${Math.round((1 - md.score.cer) * 100)}% · เหมือนเสียงคุณ ${Math.round(md.score.sim * 100)}%` : ''} · ${new Date(md.t * 1000).toLocaleString('th-TH')}</small>
      <textarea id="vtTry" rows="2" style="width:100%;margin-top:8px;padding:10px;border-radius:10px;background:#0b1030;color:inherit;border:1px solid #fff2;font:inherit">สวัสดีครับ นี่คือเสียงไทยที่ผมเทรนขึ้นมาเอง ฟังชัดไหมครับ</textarea>
      <div class="row2" style="margin-top:8px"><button class="btn sm" id="vtListen">▶ ฟังเสียงโมเดล</button><button class="btn alt sm" id="vtUse">ใช้เป็นเสียงพากย์</button></div></div>`;
  if (running){
    const pct = tr.total ? Math.min(100, (tr.step || 0) / tr.total * 100) : 0;
    h += `<div class="vt-prog" style="margin-top:10px"><div class="bar"><i style="width:${pct}%"></i></div></div>
      <p class="hint">${GM.esc(tr.msg || '')}${tr.device ? ' · ' + tr.device : ''}${tr.eta ? ' · เหลือประมาณ ' + fmtEta(tr.eta) : ''}${tr.loss ? ' · loss ' + tr.loss.toFixed(2) : ''}</p>
      <p class="hint">เทรนอยู่เบื้องหลังบน Mac — ปิดแอปได้ (Mac จะไม่หลับเองระหว่างเทรน) แต่ห้ามปิด Terminal / ห้ามพับฝาจอ · ทุก 500 ขั้น AI จะให้คะแนนและเปลี่ยนไปใช้ตัวที่ดีที่สุดให้เอง และหยุดเองเมื่อคะแนนไม่ดีขึ้น</p>
      <div class="row2"><button class="btn alt sm" id="vtExport">ใช้โมเดลล่าสุด (ลองฟัง)</button><button class="btn alt sm" id="vtStop">หยุดเทรน</button></div>`;
  } else {
    if (tr?.state === 'error') h += `<p class="lim">${GM.esc(tr.msg || '')}</p>${tr.tail ? `<details><summary class="hint">รายละเอียด</summary><pre style="white-space:pre-wrap;font-size:11px">${GM.esc(tr.tail.join('\n'))}</pre></details>` : ''}`;
    else if (tr?.state === 'done' || tr?.state === 'stopped') h += `<p class="hint">${GM.esc(tr.msg || '')}</p>`;
    const ok = good >= KT_MIN;
    h += `<p class="hint" style="margin-top:${md ? 10 : 0}px">${ok ? `ใช้ ${good} ประโยค (ไม่นับที่ Whisper ตีตก) · เทรนบน Mac ของคุณเอง ใช้เวลาหลายชั่วโมง` : `ต้องมีอย่างน้อย ${KT_MIN} ประโยค (ตอนนี้ ${good}) — อัดต่อได้เลย`}</p>
      <div class="chips" id="vtSteps">${[[3000, 'ลองเร็ว 3,000 ขั้น'], [8000, 'มาตรฐาน 8,000'], [15000, 'ละเอียด 15,000']].map(([v, n]) => `<button class="chip ${v === (st.steps || 8000) ? 'on' : ''}" data-v="${v}">${n}</button>`).join('')}</div>
      <div class="row2" style="margin-top:10px"><button class="btn" id="vtStart" ${ok ? '' : 'disabled'}>🧠 เริ่มเทรน</button>${md ? '<button class="btn alt" id="vtResume">เทรนต่อจากเดิม</button>' : ''}</div>
      <p class="hint">แนะนำ: กด “ตรวจคุณภาพ” ก่อนเทรน · ยิ่งข้อมูลเยอะ/สะอาด เสียงยิ่งชัด · เทรนต่อเพิ่มได้ภายหลังเมื่ออัดเพิ่ม</p>`;
  }
  // 🤖 supervisor: scores of every checkpoint + weak sentences
  if (tr?.evals?.length || tr?.judge){
    const ev = tr.evals || [], best = tr.best;
    h += `<div class="item" style="display:block;margin-top:10px"><b>🤖 AI ผู้คุมการเทรน</b><br><small>${GM.esc(tr.judge || '')}</small>
      ${ev.length ? `<div style="display:flex;gap:3px;align-items:flex-end;height:54px;margin-top:8px">${ev.map(e => `<div title="ขั้น ${e.step}: ชัด ${Math.round((1 - e.cer) * 100)}% · เหมือน ${Math.round(e.sim * 100)}%" style="flex:1;max-width:22px;height:${Math.max(6, e.score * 54)}px;border-radius:4px 4px 0 0;background:${e.step === best ? 'linear-gradient(#fbbf24,#f59e0b)' : 'linear-gradient(#22d3ee,#3b82f6)'}"></div>`).join('')}</div><small class="hint">แท่ง = คะแนนแต่ละ checkpoint · สีทอง = ตัวที่ใช้อยู่</small>` : ''}</div>`;
  }
  const weak = tr?.weak || [];
  if (weak.length) h += `<div class="item" style="display:block;margin-top:8px"><b>🎯 จุดที่ยังพูดไม่ชัด</b>${weak.map(w => `<div style="margin-top:6px;font-size:14px">${GM.esc(w.text)}<br><small style="color:#f99">AI ฟังได้: “${GM.esc(w.heard)}”</small></div>`).join('')}
      <button class="btn sm" id="vtWeak" style="width:100%;margin-top:8px">✨ แต่งประโยคฝึกจุดนี้ 30 ประโยค</button></div>`;
  // 🧠 VoxCPM2 LoRA (main)
  const vt = status?.voxtrain, vl = status?.voxlora, vrun = vt && (vt.state === 'running' || vt.state === 'starting');
  vx += `<div class="item" style="display:block;margin-bottom:10px"><b>🧠 เทรนเสียงฉันด้วย VoxCPM2 (LoRA)</b><br><small>ทำให้เสียงนิ่ง เหมือนคุณทุกประโยค และได้จังหวะการพูดแบบคุณ · ใช้ชุดข้อมูลที่อัดไว้ · ขั้นต่ำ ${MIN_TRAIN} ประโยค</small>`;
  if (vl) vx += `<div style="margin-top:8px"><small>✅ มีโมเดลแล้ว · ขั้นที่ ${vl.step} · ${new Date(vl.t * 1000).toLocaleString('th-TH')}</small><div class="row2" style="margin-top:6px"><button class="btn sm" id="vlListen">▶ ฟังเสียงที่เทรนแล้ว</button><button class="btn alt sm" id="vlUse">ใช้เป็นเสียงพากย์</button></div></div>`;
  if (vrun){
    const pct = vt.total ? Math.min(100, (vt.step || 0) / vt.total * 100) : 0;
    vx += `<div class="vt-prog" style="margin-top:10px"><div class="bar"><i style="width:${pct}%"></i></div></div><p class="hint">${GM.esc(vt.msg || '')}${vt.eta ? ' · เหลือประมาณ ' + fmtEta(vt.eta) : ''}${vt.loss ? ' · loss ' + vt.loss.toFixed(3) : ''}</p><button class="btn alt sm" id="vlStop">หยุดเทรน (เก็บผลล่าสุดไว้)</button>`;
  } else {
    if (vt?.state === 'error') vx += `<p class="lim">${GM.esc(vt.msg || '')}</p>${vt.tail ? `<details><summary class="hint">รายละเอียด (ส่งให้ผู้พัฒนา)</summary><pre style="white-space:pre-wrap;font-size:11px">${GM.esc(vt.tail.join('\n'))}</pre></details>` : ''}`;
    else if (vt) vx += `<p class="hint">${GM.esc(vt.msg || '')}</p>`;
    vx += `<button class="btn" id="vlStart" style="width:100%;margin-top:8px" ${good >= MIN_TRAIN ? '' : 'disabled'}>🧠 ${vl ? 'เทรนใหม่ด้วยข้อมูลล่าสุด' : 'เริ่มเทรน'} (${good} ประโยค)</button>${good < MIN_TRAIN ? `<p class="hint">อัดอีก ${MIN_TRAIN - good} ประโยค</p>` : '<p class="hint">ประมาณ 3 รอบของข้อมูล · เวลาขึ้นกับจำนวนประโยค · ระหว่างเทรนเสียง VoxCPM2 จะช้าลง</p>'}`;
  }
  vx += `</div>`;
  box.innerHTML = vx + `<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">ขั้นสูง: เทรน KhanomTan (แบบเดิม — ไม่แนะนำแล้ว)</summary>${h}</details>`;
  box.querySelector('#vlStart')?.addEventListener('click', async () => { try { await GM.MAC.form('/api/ds/' + DS + '/voxtrain', {steps: 0}); GM.toast('เริ่มเทรนบน Mac แล้ว — ปิดหน้านี้ได้'); await render(); } catch(e){ GM.toast(e.message, true); } });
  box.querySelector('#vlStop')?.addEventListener('click', async () => { if (!confirm('หยุดเทรน? ผลล่าสุดจะถูกเก็บไว้ใช้')) return; await GM.MAC.call('/api/ds/' + DS + '/voxtrain/stop', {method: 'POST'}); setTimeout(render, 3000); });
  box.querySelector('#vlListen')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'กำลังสร้างเสียง…';
    try { const blob = await GM.MAC.tts($('#vxTry')?.value.trim() || 'สวัสดีครับ', 'vox:lora:' + DS); new Audio(URL.createObjectURL(blob)).play(); } catch(err){ GM.toast(err.message, true); }
    b.disabled = false; b.textContent = '▶ ฟังเสียงที่เทรนแล้ว';
  });
  box.querySelector('#vlUse')?.addEventListener('click', async () => { await GM.MAC.refresh(); GM.S.voice = {type: 'mac', id: 'vox:lora:' + DS}; GM.save(); try { GM.renderVoice(); } catch(e){} GM.toast('ตั้งเป็นเสียงพากย์แล้ว'); });
  box.querySelector('#vxListen')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'กำลังสร้างเสียง… (ครั้งแรกนานหน่อย)';
    try { const blob = await GM.MAC.tts($('#vxTry').value.trim() || 'สวัสดีครับ', 'vox:ds:' + DS); new Audio(URL.createObjectURL(blob)).play(); }
    catch(err){ GM.toast(err.message, true); }
    b.disabled = false; b.textContent = '▶ ฟังเสียงฉัน (VoxCPM2)';
  });
  box.querySelector('#vxUse')?.addEventListener('click', async () => { await GM.MAC.refresh(); GM.S.voice = {type: 'mac', id: 'vox:ds:' + DS}; GM.save(); try { GM.renderVoice(); } catch(e){} GM.toast('ตั้งเป็นเสียงพากย์แล้ว'); });
  box.querySelector('#vtWeak')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await window.GMTools.macJob('/api/llm', {
        system: 'คุณเป็นครูสอนออกเสียงภาษาไทย เขียนประโยคภาษาไทยที่ถูกต้องและเป็นธรรมชาติ',
        prompt: `โมเดลเสียงยังออกเสียงประโยคเหล่านี้ไม่ชัด:\n${weak.map(w => '- ' + w.text).join('\n')}\nแต่งประโยคใหม่ 30 ประโยคที่ใช้คำ พยางค์ และวรรณยุกต์แบบเดียวกับประโยคข้างบนบ่อยๆ เพื่อให้คนอ่านบันทึกเสียงไปฝึกโมเดล\nกติกา: บรรทัดละ 1 ประโยค ไม่ใส่เลขลำดับ ไม่ใส่เครื่องหมายคำพูด ยาว 6–20 คำ เขียนตัวเลขเป็นคำอ่าน ไม่ใช้ภาษาอังกฤษ`,
        max_tokens: 1500}, j => { b.textContent = j.state === 'queued' ? 'รอคิวบน Mac…' : 'AI กำลังแต่ง…'; });
      const lines = ((await r.json()).text || '').split('\n').map(l => norm(l.replace(/^\s*[\d๐-๙]+[.)\-:]\s*/, '').replace(/^[-•*"“”]+|["“”]+$/g, ''))).filter(l => l.length >= 8 && l.length <= 140 && !/[a-zA-Z]{3,}/.test(l));
      st.custom = [...lines, ...st.custom]; saveSt(); GM.toast(`เพิ่ม ${lines.length} ประโยคไว้หน้าคิวแล้ว — อัดได้เลย`); render(); $('#vtSent')?.scrollIntoView({behavior: 'smooth', block: 'center'});
    } catch(err){ GM.toast(err.message, true); b.disabled = false; b.textContent = 'ลองอีกครั้ง'; }
  });
  box.querySelectorAll('#vtSteps .chip').forEach(b => b.onclick = () => { st.steps = +b.dataset.v; saveSt(); box.querySelectorAll('#vtSteps .chip').forEach(x => x.classList.toggle('on', x === b)); });
  const start = async resume => {
    try { await GM.MAC.form('/api/ds/' + DS + '/train', {steps: st.steps || 8000, resume: resume ? 1 : 0}); GM.toast('เริ่มเทรนบน Mac แล้ว'); await render(); }
    catch(e){ GM.toast(e.message, true); }
  };
  box.querySelector('#vtStart')?.addEventListener('click', () => start(false));
  box.querySelector('#vtResume')?.addEventListener('click', () => start(true));
  box.querySelector('#vtStop')?.addEventListener('click', async () => { if (!confirm('หยุดเทรน? (โมเดลที่บันทึกไว้ล่าสุดยังใช้ได้)')) return; await GM.MAC.call('/api/ds/' + DS + '/train/stop', {method: 'POST'}); setTimeout(render, 2000); });
  box.querySelector('#vtExport')?.addEventListener('click', async () => { try { await GM.MAC.call('/api/ds/' + DS + '/export', {method: 'POST'}); await GM.MAC.refresh(); GM.toast('อัปเดตโมเดลแล้ว — กดฟังได้เลย'); render(); } catch(e){ GM.toast(e.message, true); } });
  box.querySelector('#vtListen')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'กำลังสร้างเสียง…';
    try { const blob = await GM.MAC.tts($('#vtTry').value.trim() || 'สวัสดีครับ', 'my:' + DS); new Audio(URL.createObjectURL(blob)).play(); }
    catch(err){ GM.toast(err.message, true); }
    b.disabled = false; b.textContent = '▶ ฟังเสียงโมเดล';
  });
  box.querySelector('#vtUse')?.addEventListener('click', async () => { await GM.MAC.refresh(); GM.S.voice = {type: 'mac', id: 'my:' + DS}; GM.save(); try { GM.renderVoice(); } catch(e){} GM.toast('ตั้งเป็นเสียงพากย์แล้ว'); });
  clearTimeout(pollT);
  if (running || vrun) pollT = setTimeout(() => { if (document.querySelector('.page.on[data-page="voicetrain"]')) render(); }, 8000);
}

window.addEventListener('gm:page', e => { if (e.detail === 'voicetrain') render(); });
window.GMVoiceTrain = { render, backup, restore };
