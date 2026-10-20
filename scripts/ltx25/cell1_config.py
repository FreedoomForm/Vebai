# Stage 0 - configuration, environment, and the conditioning key scheme.
# T43: MiniMax H3 -> Lightricks LTX-2.5 (22B distilled, video + synchronized
# audio). Same studio pipeline, new model stack:
#   * DiT: GGUF Q4_K_M (13.0 GiB, config-fix baked into the file header) from
#     the PUBLIC unsloth mirror - no gated repos, no HF token needed.
#   * Text encoder: gemma4-12b-with-proj bf16 (24.5 GiB), encoded ONCE per
#     (prompt, keyframe, geometry) into a conditioning blob on a dedicated
#     server (the H3 three-stage split, kept: 31 GiB host RAM cannot hold the
#     encoder and two resident samplers at once).
#   * Two VAEs (video-conv + audio). LTX-2.5 generates BOTH streams in one
#     pass; the AV latent is packed/split with the stock ComfyUI nodes.
# Sampling: distilled 8-step schedule, euler_ancestral, DualCFG 1/1.
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

# --- LTX-2.x Community License ----------------------------------------------
#   https://huggingface.co/Lightricks/LTX-2.5/blob/main/LICENSE
# The weights are gated "auto" upstream; this pipeline consumes the public
# unsloth GGUF mirror, whose NOTICE carries the same license terms.
LTX_COMMUNITY_LICENSE_ACKNOWLEDGED = True

# Compute dtype: the T4 (sm75) has no bf16. GGUF tensors are dequantized to
# fp16 by ComfyUI-GGUF on Turing; the VAEs/encoder are cast to fp16 by comfy.
UNET_DTYPE_FLAGS = {}  # no dtype flag: comfy picks fp16 on sm75 by itself

COMFY_REPO = "https://github.com/Comfy-Org/ComfyUI.git"
COMFY_COMMIT = "b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c"
# ltxv is already in ComfyUI-GGUF's IMG_ARCH_LIST at this commit (verified);
# the H3-era loader patch is therefore gone.
GGUF_REPO = "https://github.com/city96/ComfyUI-GGUF.git"
GGUF_COMMIT = "6ea2651e7df66d7585f6ffee804b20e92fb38b8a"

# --- model sources (all PUBLIC, no HF token) ---------------------------------
MODEL_REPO = "unsloth/LTX-2.5-GGUF"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

def _f(repo, file, size, sha):
    return {"repo": repo, "file": file, "hf_filename": file.split("/", 1)[1],
            "bytes": size, "sha256": sha}

# sizes + sha256 are the HF LFS oids read from the unsloth repo (2026-10-20).
DIT_PRIMARY = _f(MODEL_REPO, "distilled/ltx-2.5-22b-distilled-Q4_K_M.gguf",
                 13584703872, "ba40d53770314e69e88361661e55c6cc3b12a363646ba2ea53c8bcd459b66747")
DIT_FALLBACK = _f(MODEL_REPO, "distilled/ltx-2.5-22b-distilled-Q3_K_M.gguf",
                  11298283904, "09f62757fbf959ff767ac25e7fbe354067e1fe6bbeec8d5d022fe817268efcab")
TEXT_ENCODER_FILE = "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"
TEXT_ENCODER = _f(MODEL_REPO, TEXT_ENCODER_FILE,
                  26263858182, "ef7243612fdae7a75cb4d5cee9433e81380675fb6c213bd98ae74a9cd16561d1")
VIDEO_VAE_FILE = "vae/ltx-2.5-video-vae-conv-bf16.safetensors"
VIDEO_VAE = _f(MODEL_REPO, VIDEO_VAE_FILE,
               1452269922, "685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d")
AUDIO_VAE_FILE = "vae/ltx-2.5-audio-vae-bf16.safetensors"
AUDIO_VAE = _f(MODEL_REPO, AUDIO_VAE_FILE,
               364866540, "c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5")
# The fallback DiT and the 24.5 GiB text encoder are downloaded LAZILY:
# the encoder only when a conditioning blob is missing, the smaller quant
# only when the last retry rung needs it (Kaggle scratch disk is finite).

VAE_FILES = {"video": VIDEO_VAE, "audio": AUDIO_VAE}

# --- sampling configuration ---------------------------------------------------
FPS = 25
NEGATIVE_PROMPT = "pc game, console game, video game, cartoon, childish, ugly"
SIGMAS_8STEP = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
STEPS = len(SIGMAS_8STEP.replace(",", " ").split()) - 1  # 8
SAMPLER_NAME = "euler_ancestral"
VIDEO_CFG = 1.0   # distilled: guidance is baked into the weights
AUDIO_CFG = 1.0
KEYFRAME_STRENGTH = 0.7  # LTXVImgToVideoInplace adherence (official template)
IMG_COMPRESSION = 18     # LTXVPreprocess (official template)

# The resolution gears (both dimensions divisible by 32, both 16:9 to match
# the 864x480 keyframe canvas the server ships). Attention is quadratic in
# tokens and LTX packs 32x32x8 pixels per token, so these are LIGHT compared
# to H3: gear 0.4 at 249 frames is ~13k tokens (H3 was ~117k).
GEAR_TABLE = {
    "0.2": (608, 352),
    "0.3": (736, 416),
    "0.4": (864, 480),
    "0.5": (960, 544),
}
GEAR = "0.4"  # @param ["0.2", "0.3", "0.4", "0.5", "1.0"]
if "GEAR_OVERRIDE" in globals():
    GEAR = str(globals()["GEAR_OVERRIDE"])
    print(f"GEAR_OVERRIDE active: GEAR = {GEAR} (campaign run)")
CLIP_SECONDS = 5.0  # @param {type:"number"}


def frame_count(seconds):
    """Frames for a duration on the LTX 8k+1 grid at FPS.

    The model silently rounds an off-grid count, so the geometry that comes
    back would not be the one that was asked for.
    """
    n = max(9, round(seconds * FPS))
    return n + (1 - (n % 8)) % 8


if GEAR not in GEAR_TABLE:
    raise RuntimeError(f"Unknown GEAR {GEAR!r}; pick one of {sorted(GEAR_TABLE)}")
GEOMETRY = {"width": GEAR_TABLE[GEAR][0], "height": GEAR_TABLE[GEAR][1],
            "length": frame_count(CLIP_SECONDS)}

CONTENT = Path("/kaggle/tmp") if Path("/kaggle").is_dir() else Path("/content")
WORK = CONTENT / "ltx25_sample_probe"
COMFY_DIR = CONTENT / "ComfyUI"
GGUF_NODE_DIR = COMFY_DIR / "custom_nodes" / "ComfyUI-GGUF"
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
if (frames - 1) % 8 != 0:
    raise RuntimeError(f"LTX frame count must satisfy n % 8 == 1; got {frames}")
if GEOMETRY["width"] % 32 or GEOMETRY["height"] % 32:
    raise RuntimeError(f"LTX dimensions must be divisible by 32: {GEOMETRY}")
LATENT_T = ((frames - 1) // 8) + 1
EXPECTED_LATENT_SHAPES = [
    [1, 128, LATENT_T, GEOMETRY["height"] // 32, GEOMETRY["width"] // 32],
]


# The blob's identity is its inputs. Recomputing the key here means a name
# match is itself proof that repo, encoder, prompts, geometry and fps agree.
def conditioning_key_for(prompt, frame_sha, geometry):
    payload = {
        "model": MODEL_REPO,
        "te_sha256": TEXT_ENCODER["sha256"][:32],
        "pos_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "neg_sha256": hashlib.sha256(NEGATIVE_PROMPT.encode("utf-8")).hexdigest(),
        "fps": FPS, "strength": KEYFRAME_STRENGTH, "compression": IMG_COMPRESSION,
        **geometry,
    }
    if frame_sha is not None:
        payload["frame_sha256"] = frame_sha
    return "cond-" + hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:32]


def negative_key():
    return "neg-" + hashlib.sha256(json.dumps({
        "model": MODEL_REPO,
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
    "model": "LTX-2.5 22B distilled (video+audio)",
    "dit_primary_gib": round(DIT_PRIMARY["bytes"] / GIB, 3),
    "dit_fallback_gib": round(DIT_FALLBACK["bytes"] / GIB, 3),
    "text_encoder_gib": round(TEXT_ENCODER["bytes"] / GIB, 3),
    "steps": STEPS, "sampler": SAMPLER_NAME,
    "sigmas": SIGMAS_8STEP,
    "fps": FPS, "negative": NEGATIVE_PROMPT,
    "keyframe_strength": KEYFRAME_STRENGTH,
    "gear": GEAR, "geometry": GEOMETRY, "clip_seconds": CLIP_SECONDS,
    "expected_latent_shapes": EXPECTED_LATENT_SHAPES,
}
save()

print(json.dumps(PROBE["stages"]["environment"], indent=2, ensure_ascii=False))
print()
print("=" * 72)
print(f"available RAM      : {virtual_memory.available / GIB:.2f} GiB")
print(f"DiT                : Q4_K_M {DIT_PRIMARY['bytes'] / GIB:.2f} GiB "
      f"(fallback Q3_K_M {DIT_FALLBACK['bytes'] / GIB:.2f} GiB, lazy)")
print(f"text encoder       : {TEXT_ENCODER['bytes'] / GIB:.2f} GiB bf16 (lazy, blob stage)")
print(f"VAEs               : video {VIDEO_VAE['bytes'] / GIB:.2f} + "
      f"audio {AUDIO_VAE['bytes'] / GIB:.3f} GiB")
print(f"schedule           : distilled {STEPS} steps, {SAMPLER_NAME}, DualCFG {VIDEO_CFG}/{AUDIO_CFG}")
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
prog("cell1 config done (LTX-2.5)")
