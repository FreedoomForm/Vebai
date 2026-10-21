# Stage 0 - configuration, environment, and the conditioning key scheme.
# T44: owner request (2026-10-21) - LTX-2.5 is out, the studio runs
# **Wan 2.1 1.3B** (Alibaba's Apache-2.0 text-to-video DiT). Same pipeline
# contract (jobs dataset in, job_<id>.mp4 out, insurance, Telegram mirror,
# cmd/merge terminal modes), new stack - every file PUBLIC in
# Comfy-Org/Wan_2.1_ComfyUI_repackaged, no gates, no GGUF, no custom loaders:
#   * DiT: wan2.1_t2v_1.3B_fp16 (2.64 GiB) - the official ComfyUI example uses
#     exactly this file and says fp16 > bf16 > fp8 on quality.
#   * Keyframe shots: wan2.1_fun_inp_1.3B_bf16 (2.91 GiB) - the Fun-InP variant
#     of the SAME 1.3B that consumes a start image through the vanilla
#     WanFunInpaintToVideo node, so the studio keeps its keyframe UX.
#   * Text encoder: umt5_xxl_fp8_e4m3fn_scaled (6.27 GiB) - 4x lighter than the
#     LTX gemma4 encoder, fits a T4 next to the samplers.
#   * VAE: wan_2.1_vae (0.24 GiB). WAN 2.1 IS SILENT - there is no audio VAE,
#     the mp4 has no audio track (honest regression vs LTX-2.5, owner-decided).
# Sampling (official ComfyUI text_to_video_wan.json): KSampler 30 steps,
# cfg 6.0, uni_pc / simple, ModelSamplingSD3 shift 8.0, EmptyHunyuanLatentVideo
# geometry 832x480, frame counts on the n % 4 == 1 grid at 16 fps.
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import psutil

# Compute dtype: the T4 (sm75) has no bf16 tensor cores; comfy stores fp16
# weights natively and casts the one bf16 file (fun_inp) to fp16 on load.
UNET_DTYPE_FLAGS = {}

COMFY_REPO = "https://github.com/Comfy-Org/ComfyUI.git"
COMFY_COMMIT = "b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c"  # proven on Kaggle in T42/T43

# --- model sources (all PUBLIC, no HF token) ---------------------------------
MODEL_REPO = "Comfy-Org/Wan_2.1_ComfyUI_repackaged"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

def _f(subdir, file, size, sha):
    return {"repo": MODEL_REPO, "file": f"split_files/{subdir}/{file}",
            "hf_filename": file, "bytes": size, "sha256": sha}

# sizes + sha256 are the HF LFS oids read from Comfy-Org/Wan_2.1_ComfyUI_repackaged (2026-10-21).
DIT_T2V = _f("diffusion_models", "wan2.1_t2v_1.3B_fp16.safetensors",
             2838303560, "be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5")
DIT_FUN_INP = _f("diffusion_models", "wan2.1_fun_inp_1.3B_bf16.safetensors",
                 3128957992, "8495d2b1673ffb18abb548a64ff3b0e4bd367734f653096f7a8a3ad46954d511")
TEXT_ENCODER = _f("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
                  6735906897, "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68")
VIDEO_VAE = _f("vae", "wan_2.1_vae.safetensors",
               253815318, "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b")
# All four files download upfront: the whole stack is 9.4 GiB (LTX was 40+),
# so the retry ladder needs no lazy quant - both DiTs fit one T4 side by side.

# --- sampling configuration (official ComfyUI Wan T2V example) ----------------
FPS = 16
NEGATIVE_PROMPT = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，"
                   "最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，"
                   "画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，"
                   "杂乱的背景，三条腿，背景人很多，倒着走")
STEPS = 30
CFG = 6.0
SAMPLER_NAME = "uni_pc"
SCHEDULER = "simple"
SHIFT = 8.0          # official 1.3B guidance: sample_shift 8 (range 8-12)

# The resolution gears (both dimensions divisible by 16, both ~16:9 to match
# the 832x480 keyframe canvas the server ships). Wan 1.3B is trained at
# 832x480 480P; other sizes work but are off-distribution, so the fallback
# gear SHRINKS rather than scales up.
GEAR_TABLE = {
    "0.2": (480, 272),
    "0.3": (704, 400),
    "0.4": (832, 480),
}
GEAR = "0.4"  # @param ["0.2", "0.3", "0.4"]
if "GEAR_OVERRIDE" in globals():
    GEAR = str(globals()["GEAR_OVERRIDE"])
    print(f"GEAR_OVERRIDE active: GEAR = {GEAR} (campaign run)")
CLIP_SECONDS = 5.0  # @param {type:"number"}


def frame_count(seconds):
    """Frames for a duration on the Wan grid at FPS.

    The latent node takes length with step 4 and the sampler wants the
    n % 4 == 1 shape the VAE was trained on (81 f = 5.06 s native window;
    10 s shots ride the 161-frame extrapolation, quality is softer there).
    """
    n = max(9, round(seconds * FPS))
    return n + ((1 - (n % 4)) % 4)


if GEAR not in GEAR_TABLE:
    raise RuntimeError(f"Unknown GEAR {GEAR!r}; pick one of {sorted(GEAR_TABLE)}")
GEOMETRY = {"width": GEAR_TABLE[GEAR][0], "height": GEAR_TABLE[GEAR][1],
            "length": frame_count(CLIP_SECONDS)}

CONTENT = Path("/kaggle/tmp") if Path("/kaggle").is_dir() else Path("/content")
WORK = CONTENT / "wan13_sample_probe"
COMFY_DIR = CONTENT / "ComfyUI"
GGUF_NODE_DIR = COMFY_DIR / "custom_nodes" / "ComfyUI-GGUF"  # NOT installed for Wan
CONTROL_NODE_DIR = COMFY_DIR / "custom_nodes" / "H3BenchmarkControl"  # kept name: shared with the test worker
MODEL_STORE = WORK / "models"
CONDITIONING_STORE = WORK / "conditioning"
LATENT_STORE = WORK / "latents"
OUTPUT_DIR = COMFY_DIR / "output"
COMFY_LOG = WORK / "comfyui.log"
RESULT_PATH = WORK / "sample_probe_results.json"
# /kaggle/working replaces Drive as the persistent store (blob handoff).
DRIVE_CONDITIONING_STORE = Path("/kaggle/working") / "conditioning" \
    if Path("/kaggle/working").is_dir() else WORK / "conditioning_persist"
DRIVE_VIDEO_STORE = Path("/kaggle/working") / "out" \
    if Path("/kaggle/working").is_dir() else WORK / "out"
for directory in (WORK, MODEL_STORE, CONDITIONING_STORE, LATENT_STORE):
    directory.mkdir(parents=True, exist_ok=True)

GIB = 1024 ** 3
BASE_URL = "http://127.0.0.1:8188"
RUN_ID = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

if RESULT_PATH.exists():
    backup = RESULT_PATH.with_suffix(f".json.bak-{time.strftime('%Y%m%dT%H%M%S')}")
    shutil.copy2(RESULT_PATH, backup)
    try:
        PROBE = json.loads(RESULT_PATH.read_text(encoding="utf-8"))
        print(f"Resumed earlier results ({sorted(PROBE.get('stages', {}))}); backup {backup.name}")
    except json.JSONDecodeError:
        PROBE = {"schema_version": 3, "stages": {}}
else:
    PROBE = {"schema_version": 3, "stages": {}}
PROBE.setdefault("stages", {})


def save():
    RESULT_PATH.write_text(json.dumps(PROBE, indent=2, ensure_ascii=False, default=str),
                           encoding="utf-8")


def utc_now():
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).isoformat()


CHILD_ENV_ALLOWLIST = {
    "PATH", "HOME", "LANG", "TMPDIR", "CUDA_HOME", "CUDA_PATH", "CUDA_VISIBLE_DEVICES",
    "CUDA_MODULE_LOADING", "CUDA_LAUNCH_BLOCKING", "LD_LIBRARY_PATH", "PYTHONPATH",
    "PYTHONUNBUFFERED", "PYTORCH_CUDA_ALLOC_CONF", "TRITON_CACHE_DIR", "XDG_CACHE_HOME",
    "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CACHE_DIR",
}
SECRET_NAME_RE = re.compile(r"TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL", re.I)


def scrubbed_child_environment(extra=None):
    merged = {name: value for name, value in os.environ.items()
              if name in CHILD_ENV_ALLOWLIST and not SECRET_NAME_RE.search(name)}
    merged.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    merged.setdefault("HOME", "/root")
    merged["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    merged["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    if extra:
        rejected = [n for n in extra if n not in CHILD_ENV_ALLOWLIST or SECRET_NAME_RE.search(n)]
        if rejected:
            raise RuntimeError(f"Refusing secret-like child environment entries: {rejected}")
        merged.update(extra)
    return merged


def run(command, cwd=None, env=None):
    print("$ " + " ".join(str(part) for part in command))
    return subprocess.run(command, cwd=cwd, env=scrubbed_child_environment(env), check=True)


def sha256_file(path, chunk_bytes=16 * 1024 * 1024):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(chunk_bytes), b""):
            digest.update(block)
    return digest.hexdigest()


import torch  # noqa: E402

frames = GEOMETRY["length"]
if (frames - 1) % 4 != 0:
    raise RuntimeError(f"Wan frame count must satisfy n % 4 == 1; got {frames}")
if GEOMETRY["width"] % 16 or GEOMETRY["height"] % 16:
    raise RuntimeError(f"Wan dimensions must be divisible by 16: {GEOMETRY}")
LATENT_T = ((frames - 1) // 4) + 1
EXPECTED_LATENT_SHAPES = [
    [1, 16, LATENT_T, GEOMETRY["height"] // 8, GEOMETRY["width"] // 8],
]


# The blob's identity is its inputs. Recomputing the key here means a name
# match is itself proof that repo, variant, encoder, prompts, geometry and
# fps agree. variant = "t2v" | "fun_inp" - the Fun-InP conditioning carries
# the encoded keyframe, so its blob must never satisfy a t2v request.
def conditioning_key_for(prompt, frame_sha, geometry, variant):
    payload = {
        "model": f"Wan2.1-1.3B-{variant}",
        "te_sha256": TEXT_ENCODER["sha256"][:32],
        "pos_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "neg_sha256": hashlib.sha256(NEGATIVE_PROMPT.encode("utf-8")).hexdigest(),
        "fps": FPS, "shift": SHIFT,
        **geometry,
    }
    if frame_sha is not None:
        payload["frame_sha256"] = frame_sha
    return "cond-" + hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:32]


def negative_key(variant):
    return "neg-" + hashlib.sha256(json.dumps({
        "model": f"Wan2.1-1.3B-{variant}",
        "te_sha256": TEXT_ENCODER["sha256"][:32],
        "neg_sha256": hashlib.sha256(NEGATIVE_PROMPT.encode("utf-8")).hexdigest(),
        "fps": FPS,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:32]


virtual_memory = psutil.virtual_memory()
disk = shutil.disk_usage(str(CONTENT))
PROBE["stages"]["environment"] = {
    "measured_at": utc_now(),
    "run_id": RUN_ID,
    "host_ram_total_gib": round(virtual_memory.total / GIB, 3),
    "host_ram_available_gib": round(virtual_memory.available / GIB, 3),
    "cpu_count": os.cpu_count(),
    "disk_free_gib": round(disk.free / GIB, 3),
    "python": sys.version.split()[0],
    "torch": str(torch.__version__),
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "compute_capability": ".".join(str(x) for x in torch.cuda.get_device_capability(0))
    if torch.cuda.is_available() else None,
    "vram_total_mib": round(torch.cuda.get_device_properties(0).total_memory / 1024 ** 2, 1)
    if torch.cuda.is_available() else None,
    "model": "Wan 2.1 1.3B (silent, no audio track)",
    "dit_t2v_gib": round(DIT_T2V["bytes"] / GIB, 3),
    "dit_fun_inp_gib": round(DIT_FUN_INP["bytes"] / GIB, 3),
    "text_encoder_gib": round(TEXT_ENCODER["bytes"] / GIB, 3),
    "vae_gib": round(VIDEO_VAE["bytes"] / GIB, 3),
    "steps": STEPS, "cfg": CFG, "sampler": SAMPLER_NAME, "scheduler": SCHEDULER,
    "shift": SHIFT,
    "fps": FPS, "negative": NEGATIVE_PROMPT[:40] + "...",
    "gear": GEAR, "geometry": GEOMETRY, "clip_seconds": CLIP_SECONDS,
    "expected_latent_shapes": EXPECTED_LATENT_SHAPES,
}
save()

print(json.dumps(PROBE["stages"]["environment"], indent=2, ensure_ascii=False))
print()
print("=" * 72)
print(f"available RAM      : {virtual_memory.available / GIB:.2f} GiB")
print(f"DiT t2v            : {DIT_T2V['bytes'] / GIB:.2f} GiB fp16 "
      f"(fun_inp keyframe variant {DIT_FUN_INP['bytes'] / GIB:.2f} GiB)")
print(f"text encoder       : {TEXT_ENCODER['bytes'] / GIB:.2f} GiB fp8-scaled")
print(f"VAE                : {VIDEO_VAE['bytes'] / GIB:.2f} GiB")
print(f"schedule           : {STEPS} steps, {SAMPLER_NAME}/{SCHEDULER}, "
      f"cfg {CFG}, shift {SHIFT}")
print(f"geometry / fps     : {GEOMETRY['width']}x{GEOMETRY['height']} / "
      f"{frames} frames @ {FPS} ({CLIP_SECONDS} s)")
print(f"disk free          : {disk.free / GIB:.1f} GiB")
print("=" * 72)

# --- [studio-telemetry] live phase markers -> outputs dataset (progress.json) --
import threading as _tth
_TEL_LOCK = _tth.Lock()
_TEL_LAST = {"t": 0.0}
_TPROG_T0 = time.time()
PROG_EVENTS = []
def _tel_body(tag):
    try:
        out_dir = Path("/kaggle/working/out")
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "progress.json").write_text(json.dumps(
            {"events": PROG_EVENTS[-80:]}, ensure_ascii=False, indent=1), encoding="utf-8")
        meta = out_dir / "dataset-metadata.json"
        if not meta.exists():
            json.dump({"title": "rmc-studio-outputs", "id": "freedomform/rmc-studio-outputs",
                       "licenses": [{"name": "CC0-1.0"}]}, open(meta, "w"))
        os.environ["KAGGLE_API_TOKEN"] = "KGAT_abba3bba83ed8f6a11855f7a819228ea"
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kaggle"],
                       capture_output=True, timeout=300)
        created = subprocess.run(
            [sys.executable, "-m", "kaggle", "datasets", "create", "-p", str(out_dir),
             "--dir-mode", "zip"], capture_output=True, text=True, timeout=1200)
        if "successfully created" not in (created.stdout or "").lower():
            version = subprocess.run(
                [sys.executable, "-m", "kaggle", "datasets", "version",
                 "-p", str(out_dir), "--dir-mode", "zip",
                 "-m", f"prog {tag} {time.strftime('%H:%M')}"],
                capture_output=True, text=True, timeout=1200)
            print(f"[tel] push rc={version.returncode}", flush=True)
    except Exception as exc:
        print(f"[tel] push failed: {type(exc).__name__}: {exc}", flush=True)
def prog(tag):
    ev = {"s": round(time.time() - _TPROG_T0, 1), "tag": tag}
    PROG_EVENTS.append(ev)
    print(f"[tel] +{ev['s']}s {tag}", flush=True)
    with _TEL_LOCK:
        if time.time() - _TEL_LAST["t"] < 120:
            return
        _TEL_LAST["t"] = time.time()
    def _go():
        lk = globals().get("PUSH_LOCK")
        if lk is not None:
            with lk:
                _tel_body(tag)
        else:
            _tel_body(tag)
    _tth.Thread(target=_go, daemon=True).start()
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "kaggle"],
               capture_output=True, timeout=600)
prog("cell1 config done (Wan 2.1 1.3B)")
