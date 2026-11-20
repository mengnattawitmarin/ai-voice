# พรอมต์เตรียมชุดข้อมูล LoRA สำหรับ Gen Medi

คัดลอกทั้งหมดในกรอบด้านล่างไปวางในแพลตฟอร์ม AI ที่อ่านรูปได้และสร้างไฟล์ zip ได้ แล้วแนบรูปของคุณไปด้วย
ได้ zip แล้ว → Gen Medi › สร้างภาพ › ＋ สอนโมเดลด้วยภาพของฉัน › 📦 นำเข้า zip

```text
You are a dataset engineer preparing a LoRA training dataset for an image model (Z-Image Turbo, trained with mflux on a Mac).
I will attach my own photos of ONE subject. Build the best possible dataset and give me a single ZIP file.

=== 0. Ask me first (one short message), then wait ===
1. What is the subject? (a product / a character or mascot / a person = me or someone who gave consent / an art style)
2. A short name for it (e.g. "our green mug").
3. Anything that must ALWAYS stay the same (logo position, colors, proportions, face details, outfit)?
4. Anything that should be FREE to change (background, lighting, pose, outfit, camera angle)?

=== 1. Check every image (quality control) ===
Reject or flag an image when it is: blurry or motion-blurred, too dark or blown out, heavily filtered, a near-duplicate
(same angle + same background), the subject is tiny or cut off, other people/products dominate the frame,
it has watermarks, borders, UI overlays or burned-in text, or it is a screenshot of someone else's work.
For a PERSON: only photos of me or of someone who consented. For a PRODUCT/STYLE: only things I own or made.
Report: how many images kept, which were removed and why, and what kinds of shots are MISSING.

=== 2. Coverage targets (tell me what to shoot more of) ===
Aim for 20–40 kept images with variety:
- Angles: front, 3/4 left, 3/4 right, side, back (if relevant), top-down, low angle, close-up detail, wide shot.
- Light: daylight, warm indoor, soft studio, dramatic side light, night/neon (a few).
- Backgrounds: plain, home, outdoors, café/street, textured surfaces — never the same background in more than ~25% of images.
- For a person: different expressions, outfits, hairstyles if they vary, distances (face close-up, half body, full body).
- For a style: many DIFFERENT subjects (people, animals, objects, places) all in the same style.

=== 3. Prepare the images ===
- Keep the original aspect ratio; crop only to remove distractions and to keep the subject clearly visible (subject ≈ 30–70% of the frame).
- Long side 1024 px (minimum 768 px). Format PNG or high-quality JPG. No upscaling artifacts, no added filters.
- Rename to 001.png, 002.png, … (no spaces).

=== 4. Write one caption per image (MOST IMPORTANT) ===
Use the literal trigger word [TRIGGER] for the subject (the app replaces it with its own trigger word).
Rules:
- Start with: "[TRIGGER], " then a short subject phrase:
  product → "[TRIGGER] <generic noun>"   e.g. "[TRIGGER] ceramic mug"
  character → "[TRIGGER] character"
  person → "[TRIGGER] person" (add man/woman only if I tell you)
  style → do NOT describe the style; describe the scene content, and start with "[TRIGGER] style, "
- Then describe EVERYTHING that should stay CHANGEABLE: background, setting, lighting, time of day, camera angle,
  framing/shot type, pose/action, expression, clothing (if not fixed), other objects, colors of the surroundings, photo type.
- Do NOT describe what must always stay the same about the subject (its logo, fixed colors, face shape, signature design):
  the trigger word must learn those by itself. Describing them in every caption weakens the LoRA.
- Plain English, one line, 20–60 words, comma-separated phrases, concrete and literal — no poetry, no opinions
  ("beautiful", "amazing"), no guesses about brand names, no text that isn't visible.
- If visible text is part of the subject (e.g. a logo word), do not spell it out.
- Vary wording naturally between captions; keep the trigger + subject phrase identical in all.
Example (product): "[TRIGGER], [TRIGGER] ceramic mug, on a wooden café table, morning window light from the left, shallow depth of field, a croissant and a laptop in the soft-focus background, three-quarter view, close-up product photo"
Example (person): "[TRIGGER], [TRIGGER] person, smiling, wearing a denim jacket, standing on a busy Bangkok street at golden hour, half-body shot, 50mm lens, warm backlight"
Example (style): "[TRIGGER] style, an old fisherman repairing a net on a wooden boat at dawn, mist over the river, wide shot"

=== 5. dataset.json ===
{
  "label": "<short Thai or English name I gave>",
  "kind": "product | character | person | style",
  "description": "<one English sentence describing the subject's fixed look, max 25 words>",
  "trigger_placeholder": "[TRIGGER]",
  "always_same": ["..."],
  "free_to_change": ["..."],
  "images": <number of images>,
  "removed": [{"file": "original name", "reason": "..."}],
  "missing_shots": ["..."],
  "test_prompts": ["10 prompts using [TRIGGER] in new situations NOT seen in the dataset, to test the LoRA after training"]
}

=== 6. ZIP layout (exactly this, files at the root of the zip) ===
001.png
001.txt   ← caption for 001.png (same name, .txt, UTF-8, one line)
002.png
002.txt
...
dataset.json
README.txt   ← short summary in Thai: kept/removed counts, missing shots to take next, how to test

Before making the ZIP, show me 3 sample captions and the kept/removed list so I can correct them. Then create the ZIP.
```

## เคล็ดลับ
- ภาพจริงของคุณสำคัญที่สุด อย่าใช้ภาพที่ AI ตัวอื่นวาดหรือภาพจากเน็ตมาเทรน (เรื่องสิทธิ์ และคุณภาพจะเพี้ยน)
- ภาพคน: เฉพาะตัวคุณเองหรือคนที่อนุญาตแล้วเท่านั้น
- เทรนเสร็จ ให้ลอง `test_prompts` ใน dataset.json — ถ้าภาพเหมือนแต่ "ติดฉากเดิม" ให้เพิ่มภาพฉากหลากหลายขึ้น ถ้า "ไม่ค่อยเหมือน" ให้เพิ่มภาพมุมใกล้/รายละเอียดสำคัญ
