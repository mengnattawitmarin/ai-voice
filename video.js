/* Gen Medi — Text → Video on the user's Mac (Wan2.1 T2V 1.3B, Apache-2.0). The phone only sends the prompt and polls. */
const GM = window.GM;
const { S, toast, esc, stamp, saveBlob, shareFiles, saveToMac, addHistory } = GM;
const root = document.querySelector('#videoRoot');
const MODES = [['draft', '⚡ ร่างเร็ว', '480×272 · 15 สเต็ป — ลองไอเดียก่อน'], ['standard', '🎬 มาตรฐาน 480p', '832×480 · 16fps · 25 สเต็ป — ยาวได้ถึง 5 วิ · แนะนำคู่กับอัปสเกล 1080p'],
  ['hd720', '💎 HD 720p (ทดลอง)', 'Wan2.2 5B สร้าง 720p ตรง ๆ · ใช้ RAM มาก — Mac 32GB ได้คลิปสั้นมาก (~0.7 วิ) และอาจล้มถ้า RAM ไม่พอ · ปิดแอปอื่นก่อน']];
const UPS = [['none', 'ขนาดเดิม'], ['720', '⬆️ 720p'], ['1080', '⬆️ 1080p']];
const LENS = [[2, '2 วิ'], [3, '3 วิ'], [5, '5 วิ']];
const STYLES = [['none', 'ไม่ระบุ', ''], ['cine', '🎞️ ภาพยนตร์', ', cinematic lighting, film grain, shallow depth of field, smooth camera movement'], ['real', '📷 สมจริง', ', photorealistic, natural light, high detail'], ['anime', '🌸 อนิเมะ', ', anime style, vibrant colors, clean lines'], ['3d', '🧸 3D', ', 3D render, pixar style, soft lighting'], ['drone', '🚁 โดรน', ', aerial drone shot, sweeping camera motion']];
const st = Object.assign({ mode: 'standard', sec: 3, portrait: true, style: 'cine', up: '1080' }, GM.LS.get('vidSet', {}));
let job = null, timer = null;
const saveSt = () => GM.LS.set('vidSet', st);
const fmt = s => s == null ? '?' : s < 60 ? Math.round(s) + ' วินาที' : Math.round(s / 60) + ' นาที';

function estimate(){
  const i = GM.MAC.info || {}, md = st.mode;
  if (md === 'hd720') return `⏱ 720p บน Mac ใช้เวลานาน — ผลทดสอบบน Mac 64GB: 41 เฟรมราว 15 นาที · Mac ${i.ram_gb || '?'}GB ของคุณสร้างได้สั้นกว่านี้`;
  const per = i['video_ms_per_step_' + md];
  const steps = md === 'draft' ? 15 : 25, frames = Math.round(st.sec * 4) * 4 + 1;
  const scale = frames / 49 * (md === 'draft' ? 0.35 : 1);
  if (per) return `⏱ ประมาณ ${fmt(per * steps / 1000 * frames / 49 + 20)} (วัดจาก Mac ของคุณ)`;
  const gc = i.gpu_cores || 8, base = 900 * 32 / Math.max(8, gc);    // seconds for 3 s @ 480p on M1/M2 Max-class GPU, rough guess
  return `⏱ ประมาณ ${fmt(base * scale)} บน ${esc((i.chip || 'Mac').replace(/^Apple /, ''))}${i.gpu_cores ? ' (GPU ' + i.gpu_cores + ' คอร์)' : ''} — ตัวเลขคร่าว ๆ ครั้งแรกจะวัดจริงให้`;
}
function chips(list, cur, key){ return `<div class="chips" data-k="${key}">${list.map(o => `<button class="chip ${String(o[0]) === String(cur) ? 'on' : ''}" data-v="${o[0]}">${o[1]}</button>`).join('')}</div>`; }
function render(){
  if (!root) return;
  const mac = GM.MAC, i = mac.info || {};
  const m = i.models?.video;
  root.innerHTML = `
  <div class="card"><div class="card-h"><h2>🎥 ข้อความ → วิดีโอ</h2></div>
    <p class="hint" style="margin-top:0">สร้างคลิปสั้นจากคำบรรยายบน GPU ของ Mac — โมเดล Wan2.1 T2V 1.3B (Apache-2.0 ใช้หารายได้ได้) · ไม่ใช้ API · ไม่มีลายน้ำ</p>
    ${!mac.on ? `<div class="lim">ต้องเชื่อม Mac ก่อน <button class="btn sm" id="vMac" style="margin-left:6px">เชื่อมต่อ Mac</button></div>` : ''}
    ${mac.on && i.video_ok === false ? `<div class="lim">Mac เครื่องนี้มี RAM ${i.ram_gb}GB — วิดีโอต้องใช้ 16GB ขึ้นไป</div>` : ''}
    ${m && m.state !== 'ready' ? `<p class="hint">โมเดลวิดีโอบน Mac: ${m.state === 'downloading' ? 'กำลังดาวน์โหลด ' + (m.pct || 0) + '% (~20GB ครั้งแรกครั้งเดียว)' : m.state === 'error' ? 'ดาวน์โหลดผิดพลาด' : 'ยังไม่ได้ดาวน์โหลด (~20GB) — จะเริ่มโหลดเมื่อกดสร้างครั้งแรก'}</p>` : ''}
    <label class="lbl2">คำบรรยายฉาก (ภาษาอังกฤษได้ผลดีที่สุด)</label>
    <textarea class="inp" id="vPrompt" style="height:110px;padding:12px" placeholder="เช่น A golden retriever running on a beach at sunset, waves splashing, slow motion">${esc(st.prompt || '')}</textarea>
    <label class="lbl2">สไตล์</label>${chips(STYLES, st.style, 'style')}
    <label class="lbl2">คุณภาพ</label>${chips(MODES, st.mode, 'mode')}
    <p class="hint" style="margin-top:4px">${esc(MODES.find(x => x[0] === st.mode)[2])}</p>
    <label class="lbl2">ขยายไฟล์ตอนจบ (อัปสเกล + ทำภาพลื่น 30fps)</label>${chips(UPS, st.up, 'up')}
    <p class="hint" style="margin-top:4px">อัปสเกลช่วยให้ไฟล์ได้ขนาด HD สำหรับ TikTok/YouTube ภาพคมขึ้นเล็กน้อย แต่รายละเอียดไม่เท่าการสร้างที่ความละเอียดนั้นจริง</p>
    <label class="lbl2">ความยาว / สัดส่วน</label>${chips(LENS, st.sec, 'sec')}${chips([[1, '📱 แนวตั้ง 9:16'], [0, '🖥️ แนวนอน 16:9']], st.portrait ? 1 : 0, 'portrait')}
    <p class="hint" id="vEst">${mac.on ? estimate() : ''}</p>
    <button class="cta" id="vGo" style="margin:8px 0 0"><span>🎬 สร้างวิดีโอบน Mac</span></button>
    <div id="vJob" style="margin-top:12px"></div>
    <p class="hint">💡 วิดีโอจาก AI บน Mac ใช้เวลาหลายนาทีต่อคลิป — สั่งแล้วปิดหน้าจอมือถือได้ กลับมาดูทีหลัง (Mac ต้องเปิดค้างไว้) · ต่อหลายคลิปเป็นเรื่องยาวได้ใน “สตูดิโอวิดีโอ” · ติดป้าย “เนื้อหาสร้างด้วย AI” เมื่อโพสต์ YouTube/TikTok ถ้าดูสมจริง</p>
  </div>`;
  root.querySelector('#vMac')?.addEventListener('click', () => GM.openProc());
  root.querySelectorAll('.chips[data-k]').forEach(c => c.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const k = c.dataset.k; let v = b.dataset.v; if (k === 'sec') v = +v; if (k === 'portrait') v = v === '1';
    st[k] = v; saveSt(); c.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
    if (k === 'mode') render(); else { const e = root.querySelector('#vEst'); if (e && mac.on) e.textContent = estimate(); }
  }));
  root.querySelector('#vPrompt').oninput = e => { st.prompt = e.target.value; saveSt(); };
  root.querySelector('#vGo').onclick = start;
  if (job) showJob();
}
async function start(){
  const prompt = (st.prompt || '').trim();
  if (!prompt) return toast('พิมพ์คำบรรยายฉากก่อนนะ');
  if (!GM.MAC.on) return GM.openProc();
  if (job && ['queued', 'loading', 'running'].includes(job.state)) return toast('กำลังสร้างคลิปอยู่ — รอให้เสร็จก่อน');
  const full = prompt + (STYLES.find(s => s[0] === st.style)?.[2] || '');
  const btn = root.querySelector('#vGo'); btn.disabled = true;
  try {
    const r = await (await GM.MAC.json('/api/txt2video', { prompt: full, mode: st.mode, seconds: st.sec, portrait: st.portrait, upscale: st.up === 'none' ? null : st.up }, 60000)).json();
    job = { id: r.job, state: 'queued', prompt }; GM.LS.set('vidJob', job.id);
    poll();
  } catch(e){ toast(e.message, true); GM.MAC.refresh().then(render); }
  btn.disabled = false;
}
async function poll(){
  clearTimeout(timer);
  if (!job) return;
  try { Object.assign(job, await (await GM.MAC.call('/api/jobs/' + job.id, {}, 20000)).json()); }
  catch(e){ job.msg = e.message; if (/ไม่พบงาน/.test(e.message)){ job.state = 'error'; GM.LS.set('vidJob', null); } }
  showJob();
  if (['queued', 'loading', 'running'].includes(job.state)) timer = setTimeout(poll, 4000);
  else if (job.state === 'done' && !job.blob) fetchResult();
}
function showJob(){
  const box = root?.querySelector('#vJob'); if (!box || !job) return;
  if (job.blob){
    const url = job.url || (job.url = URL.createObjectURL(job.blob));
    box.innerHTML = `<video src="${url}" controls playsinline loop style="width:100%;border-radius:14px;background:#000"></video>
      <p class="hint">เสร็จใน ${fmt((job.ms || 0) / 1000)} · seed ${job.seed || '-'}${job.note ? ' · ' + esc(job.note) : ''}</p>
      <div class="row2" style="gap:8px;flex-wrap:wrap"><button class="btn sm" data-a="dl">⬇️ บันทึก MP4</button><button class="btn sm alt" data-a="share">📤 แชร์ / Drive</button><button class="btn sm alt" data-a="again">🔁 สร้างใหม่</button></div>`;
    box.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const f = job.file;
      if (b.dataset.a === 'dl') saveBlob(f, f.name);
      if (b.dataset.a === 'share') shareFiles([f], job.prompt.slice(0, 80)).catch(() => toast('แชร์ไม่สำเร็จ', true));
      if (b.dataset.a === 'again') start();
    });
    return;
  }
  const pct = job.total ? Math.round((job.step || 0) * 100 / job.total) : 0;
  box.innerHTML = job.state === 'error' ? `<p class="lim">สร้างไม่สำเร็จ: ${esc(job.msg || '')}</p>`
    : `<div class="prog2"><i style="width:${Math.max(3, pct)}%"></i></div><p class="hint">${esc(job.msg || '')}${job.state === 'running' ? ` · สเต็ป ${job.step || 0}/${job.total} · เหลือ ~${fmt(job.eta)}` : ''}</p><button class="btn sm alt" id="vCancel">ยกเลิก</button>`;
  box.querySelector('#vCancel')?.addEventListener('click', async () => { try { await GM.MAC.json('/api/jobs/' + job.id + '/cancel'); toast('กำลังยกเลิก…'); } catch(e){} });
}
async function fetchResult(){
  try {
    const b = await (await GM.MAC.call('/api/jobs/' + job.id + '/result', {}, 300000)).blob();
    job.blob = b; job.file = new File([b], `genmedi-video-${stamp()}.mp4`, { type: 'video/mp4' });
    GM.LS.set('vidJob', null);
    addHistory({ kind: 'video', text: job.prompt, blob: job.file, lk: 'video-mac' });
    saveToMac(job.file, 'videos', job.prompt.slice(0, 40));
    showJob(); toast('วิดีโอเสร็จแล้ว 🎬');
  } catch(e){ toast('ดึงไฟล์วิดีโอไม่สำเร็จ: ' + e.message, true); }
}
const pending = GM.LS.get('vidJob', null);
if (pending){ job = { id: pending, state: 'queued', prompt: st.prompt || '' }; setTimeout(poll, 1500); }
render();
setInterval(() => { if (document.querySelector('.page[data-page="video"].on') && (!job || job.state !== 'running')) GM.MAC.refresh().then(() => { if (!job || job.blob || job.state === 'error') render(); }); }, 30000);
window.GMVideo = { render };
