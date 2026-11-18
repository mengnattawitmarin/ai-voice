# AI Voice — ตัดต่อวิดีโอ (source)

โค้ดของหน้า `editor/` (React + Tailwind) ไฟล์ที่ build แล้วอยู่ใน `../editor/` และ commit ไว้ในรีโป
จึง deploy ขึ้น GitHub Pages ได้เลยโดยไม่ต้องมีขั้นตอน build

แก้โค้ดแล้ว build ใหม่:

```bash
cd editor-src
npm install
npm run build
```

- `src/lib/engine.ts` — ตัวเรนเดอร์ (canvas + WebAudio) และส่งออกด้วย MediaRecorder
- `src/lib/auto.ts` — โหมด Auto: หาช่วงเด็ด, จับจังหวะเพลง, เทมเพลต
- `src/lib/host.ts` — ต่อกับ AI Voice: ดึงภาพ/เสียงจากประวัติ (IndexedDB `ai-voice`), ดาวน์โหลด/แชร์
- `src/components/` — หน้าจอ
