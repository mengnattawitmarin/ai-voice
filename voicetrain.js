/* Gen Medi — 🎓 train your own Thai voice
   1) record a dataset of your own voice, sentence by sentence (stored on the Mac)
   2) Whisper checks every clip against its sentence
   3) the Mac fine-tunes KhanomTan v1.1 (Apache-2.0) with your voice → a clear native-Thai voice you own */
const GM = window.GM, $ = s => document.querySelector(s);
const DS = 'mine', TARGET = 800, MIN_TRAIN = 300;
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
  <div class="card"><div class="card-h"><h2>🧠 เทรนโมเดล</h2></div><div id="vtTrain"></div></div>`;
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
  renderBad(); renderTrain();
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

function renderTrain(){
  const box = $('#vtTrain'); if (!box) return;
  const c = status?.count || 0, tr = status?.train;
  if (window.GMTrain?.render) return window.GMTrain.render(box, status);   // training UI (next step)
  box.innerHTML = `<p class="hint" style="margin-top:0">${c >= MIN_TRAIN ? 'ข้อมูลพอสำหรับเทรนรอบแรกแล้ว — ระบบเทรนกำลังจะมาในอัปเดตถัดไป อัดต่อไปได้เลย ยิ่งเยอะยิ่งชัด' : `ต้องมีอย่างน้อย ${MIN_TRAIN} ประโยค (ตอนนี้ ${c}) — ระหว่างนี้ระบบเทรนกำลังทำอยู่`}</p>${tr ? `<p class="hint">${GM.esc(tr.msg || '')}</p>` : ''}`;
}

window.addEventListener('gm:page', e => { if (e.detail === 'voicetrain') render(); });
window.GMVoiceTrain = { render };
