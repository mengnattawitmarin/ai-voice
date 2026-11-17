"""Convert Thai VITS (MMS) voices to ONNX for transformers.js and mirror them to the `models` branch.
Runs in GitHub Actions. Output: out/<voice>/{config.json,tokenizer.json,tokenizer_config.json,onnx/model.onnx(.partN)} + out/report.json
"""
import json, os, shutil, traceback
import numpy as np
import torch
import onnxruntime as ort
import soundfile as sf
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer
from transformers import VitsModel, AutoTokenizer

OUT = "out"
SENT = "สวัสดีครับ วันนี้อากาศดีมาก เรามาลองฟังเสียงภาษาไทยกันนะครับ"
CONVERT = [
    ("th-male-v2", "VIZINTZOR/MMS-TTS-THAI-MALEV2"),
    ("th-male-narrator", "VIZINTZOR/MMS-TTS-THAI-MALE-NARRATOR"),
    ("th-male-v1", "VIZINTZOR/MMS-TTS-THAI-MALEV1"),
    ("th-female-v2", "VIZINTZOR/MMS-TTS-THAI-FEMALEV2"),
    ("th-female-v1", "VIZINTZOR/MMS-TTS-THAI-FEMALEV1"),
]
MIRROR = [  # already transformers.js-ready
    ("th-mms", "payam1394/traxlate-mms-tts-tha", SENT),
    ("en-mms", "Xenova/mms-tts-eng", "Hello, this is a test of the English voice."),
]
TOK_SRC = "payam1394/traxlate-mms-tts-tha"
PART = 90 * 1024 * 1024
os.makedirs(f"{OUT}/samples", exist_ok=True)


def f0_median(wav, sr):
    import librosa
    f0, _, _ = librosa.pyin(wav.astype(np.float32), fmin=60, fmax=400, sr=sr)
    f0 = f0[~np.isnan(f0)]
    return round(float(np.median(f0)), 1) if len(f0) else None


def split(path):
    size = os.path.getsize(path)
    if size <= PART:
        return size
    parts = []
    with open(path, "rb") as f:
        i = 0
        while True:
            b = f.read(PART)
            if not b:
                break
            pn = f"model.onnx.part{i}"
            with open(os.path.join(os.path.dirname(path), pn), "wb") as o:
                o.write(b)
            parts.append(pn)
            i += 1
    os.remove(path)
    with open(path + ".manifest.json", "w") as o:
        json.dump({"parts": parts, "size": size}, o)
    return size


def run_onnx(path, tok_json, text):
    sess = ort.InferenceSession(path)
    ids = Tokenizer.from_file(tok_json).encode(text).ids
    a = np.array([ids], dtype=np.int64)
    names = [i.name for i in sess.get_inputs()]
    feed = {"input_ids": a}
    if "attention_mask" in names:
        feed["attention_mask"] = np.ones_like(a)
    return sess.run(None, feed)[0][0], ids


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask):
        return self.m(input_ids=input_ids, attention_mask=attention_mask).waveform


report = {}
tok_files = {fn: hf_hub_download(TOK_SRC, fn) for fn in ["tokenizer.json", "tokenizer_config.json"]}

for name, repo, text in MIRROR:
    r = {"repo": repo, "kind": "mirror"}
    try:
        d = f"{OUT}/{name}"
        os.makedirs(d + "/onnx", exist_ok=True)
        for fn in ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"]:
            shutil.copy(hf_hub_download(repo, fn), f"{d}/{fn}")
        wav, _ = run_onnx(f"{d}/onnx/model.onnx", f"{d}/tokenizer.json", text)
        sr = json.load(open(f"{d}/config.json")).get("sampling_rate", 16000)
        sf.write(f"{OUT}/samples/{name}.wav", wav, sr)
        r.update(sec=round(len(wav) / sr, 2), f0=f0_median(wav, sr), size=split(f"{d}/onnx/model.onnx"), ok=True)
    except Exception:
        r.update(ok=False, error=traceback.format_exc()[-800:])
    report[name] = r
    print(name, r, flush=True)

for name, repo in CONVERT:
    r = {"repo": repo, "kind": "converted"}
    try:
        d = f"{OUT}/{name}"
        os.makedirs(d + "/onnx", exist_ok=True)
        model = VitsModel.from_pretrained(repo).eval()
        tok = AutoTokenizer.from_pretrained(repo)
        model.noise_scale = 0.5
        model.noise_scale_duration = 0.6
        inp = tok(SENT, return_tensors="pt")
        with torch.no_grad():
            ref = model(**inp).waveform[0].numpy()
        torch.onnx.export(Wrap(model), (inp["input_ids"], inp["attention_mask"]), f"{d}/onnx/model.onnx",
                          input_names=["input_ids", "attention_mask"], output_names=["waveform"],
                          dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
                                        "waveform": {0: "batch", 1: "samples"}},
                          opset_version=17, do_constant_folding=True)
        model.config.save_pretrained(d)
        for fn, p in tok_files.items():
            shutil.copy(p, f"{d}/{fn}")
        wav, ids = run_onnx(f"{d}/onnx/model.onnx", f"{d}/tokenizer.json", SENT)
        wav2, _ = run_onnx(f"{d}/onnx/model.onnx", f"{d}/tokenizer.json", "ทดสอบ")
        sr = model.config.sampling_rate
        sf.write(f"{OUT}/samples/{name}.wav", wav, sr)
        r.update(tok_match=ids == inp["input_ids"][0].tolist(), sec=round(len(wav) / sr, 2), torch_sec=round(len(ref) / sr, 2),
                 dynamic_ok=len(wav2) < len(wav) * 0.6, f0=f0_median(wav, sr), size=split(f"{d}/onnx/model.onnx"), ok=True)
    except Exception:
        r.update(ok=False, error=traceback.format_exc()[-800:])
    report[name] = r
    print(name, r, flush=True)

for r in report.values():
    if r.get("f0"):
        r["gender"] = "male" if r["f0"] < 165 else "female"
json.dump(report, open(f"{OUT}/report.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps(report, ensure_ascii=False, indent=1))
