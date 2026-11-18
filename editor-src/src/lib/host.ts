import { useEffect, useState, useSyncExternalStore } from "react";

/* ---------------- toast ---------------- */

let toastMsg: string | null = null;
let toastTimer = 0;
const listeners = new Set<() => void>();

export function toast(msg: string) {
  toastMsg = msg;
  listeners.forEach((l) => l());
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMsg = null;
    listeners.forEach((l) => l());
  }, 2600);
}

export function useToast() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toastMsg,
  );
}

/* ---------------- navigation ---------------- */

/** Back to the AI Voice home screen. */
export function exitEditor() {
  window.location.href = "../";
}

/* ---------------- time ---------------- */

export function formatClock(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---------------- save / share ---------------- */

export function exportFileName(mime: string) {
  const ext = mime.includes("mp4") ? "mp4" : "webm";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `AIVoice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/** Download the file (Android Chrome saves it to Downloads, visible in Files / Gallery). */
export function downloadVideo(blob: Blob, mime: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(mime);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** System share sheet with the video file (TikTok, YouTube, LINE, Google Drive, Photos…). */
export async function shareVideo(blob: Blob, mime: string) {
  const file = new File([blob], exportFileName(mime), { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "AI Voice" });
    } catch {
      /* dismissed */
    }
    return;
  }
  downloadVideo(blob, mime);
  toast("เครื่องนี้แชร์ไฟล์ตรง ๆ ไม่ได้ — ดาวน์โหลดให้แล้ว");
}

/* ---------------- AI Voice history (same origin IndexedDB) ---------------- */

export type HistoryItem = { id: string; kind: "tts" | "audio" | "image"; text?: string; prompt?: string; voice?: string; blob?: Blob; url?: string; created: number };

/** Voices and images made in AI Voice (read from its 'ai-voice' IndexedDB on this device). */
export async function loadAiVoiceHistory(): Promise<HistoryItem[]> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open("ai-voice");
    } catch {
      return resolve([]);
    }
    req.onerror = () => resolve([]);
    req.onupgradeneeded = () => {
      // DB didn't exist yet — don't create a broken one for the main app.
      req.transaction?.abort();
      resolve([]);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("history")) {
        db.close();
        return resolve([]);
      }
      const all = db.transaction("history", "readonly").objectStore("history").getAll();
      all.onsuccess = () => {
        const items = (all.result as HistoryItem[]).filter((it) => it.blob || (it.kind === "image" && it.url)).sort((a, b) => b.created - a.created);
        db.close();
        resolve(items);
      };
      all.onerror = () => {
        db.close();
        resolve([]);
      };
    };
  });
}

/** Turn a history item into a File the editor can load. */
export async function historyFile(it: HistoryItem): Promise<File | null> {
  let blob = it.blob ?? null;
  if (!blob && it.url) {
    try {
      blob = await (await fetch(it.url)).blob();
    } catch {
      return null;
    }
  }
  if (!blob) return null;
  const isImage = it.kind === "image";
  const type = blob.type || (isImage ? "image/png" : "audio/mpeg");
  const ext = type.includes("png") ? "png" : type.includes("jpeg") ? "jpg" : type.includes("wav") ? "wav" : type.includes("webp") ? "webp" : "mp3";
  const name = `${(it.text || it.prompt || (isImage ? "ภาพ AI" : "เสียง AI")).slice(0, 24)}.${ext}`;
  return new File([blob], name, { type });
}

/** Lazily load AI Voice history when `open` becomes true. */
export function useAiVoiceHistory(open: boolean) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    if (open) void loadAiVoiceHistory().then(setItems);
  }, [open]);
  return items;
}

