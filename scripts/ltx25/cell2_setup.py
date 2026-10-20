# Stage 1 - ComfyUI + ComfyUI-GGUF at pinned commits, the studio control nodes,
prog("cell2 comfyui setup begin")
# and an EARLY node-availability check (CPU server, no models): every node the
# LTX-2.5 graphs use must exist in the pinned ComfyUI before anything downloads.
import importlib.metadata as importlib_metadata
import tempfile

setup_started = time.perf_counter()
PROTECTED = {"torch", "torchvision", "torchaudio", "triton"}


def canonical(name):
    return re.sub(r"[-_.]+", "-", str(name)).lower()


def is_protected(name):
    return canonical(name) in PROTECTED or canonical(name).startswith("nvidia-")


def protected_snapshot():
    snapshot = {}
    for distribution in importlib_metadata.distributions():
        raw = distribution.metadata.get("Name")
        if raw and is_protected(raw):
            snapshot[canonical(raw)] = str(distribution.version)
    return dict(sorted(snapshot.items()))


def ensure_checkout(repo, destination, commit, allow_dirty=False):
    destination = Path(destination)
    if not destination.exists():
        run(["git", "clone", "--filter=blob:none", repo, str(destination)])
    if not allow_dirty:
        dirty = subprocess.check_output(
            ["git", "-C", str(destination), "status", "--porcelain", "--untracked-files=no"],
            text=True, env=scrubbed_child_environment()).strip()
        if dirty:
            raise RuntimeError(f"Refusing a dirty checkout: {destination}: {dirty[:1000]}")
    head = subprocess.check_output(["git", "-C", str(destination), "rev-parse", "HEAD"],
                                   text=True, env=scrubbed_child_environment()).strip()
    if head != commit:
        run(["git", "-C", str(destination), "fetch", "origin", commit])
        run(["git", "-C", str(destination), "checkout", "--force", "--detach", commit])
    head = subprocess.check_output(["git", "-C", str(destination), "rev-parse", "HEAD"],
                                   text=True, env=scrubbed_child_environment()).strip()
    if head != commit:
        raise RuntimeError(f"Checkout verification failed: HEAD={head}")


def pip_install_without_touching_torch(requirements_path, label):
    """Resolve first, refuse the plan if it would move torch, then install exactly."""
    before = protected_snapshot()
    handle, name = tempfile.mkstemp(prefix=f"ltx-{label}-", suffix=".json")
    os.close(handle)
    report_path = Path(name)
    try:
        run([sys.executable, "-m", "pip", "install", "-q", "--dry-run",
             "--report", str(report_path), "-r", str(requirements_path)])
        plan = json.loads(report_path.read_text(encoding="utf-8"))
    finally:
        report_path.unlink(missing_ok=True)
    actions = []
    for item in plan.get("install", []):
        metadata = item.get("metadata", {})
        pkg, version = canonical(metadata.get("name", "")), str(metadata.get("version", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", pkg) or not version:
            raise RuntimeError(f"Unsafe package in {label} plan: {pkg!r} {version!r}")
        actions.append({"name": pkg, "spec": f"{pkg}=={version}"})
    blocked = [a for a in actions if is_protected(a["name"])]
    if blocked:
        raise RuntimeError(
            f"Refusing the {label} plan: it would mutate protected runtime distributions "
            f"{[a['spec'] for a in blocked]}. Every measurement in this project assumes "
            "the stock torch/triton stack.")
    if actions:
        run([sys.executable, "-m", "pip", "install", "-q", "--no-deps",
             *[a["spec"] for a in actions]])
    after = protected_snapshot()
    if before != after:
        raise RuntimeError(f"Protected distributions changed during {label}: {before} -> {after}")
    return {"installed": [a["spec"] for a in actions], "protected_unchanged": True}


ensure_checkout(COMFY_REPO, COMFY_DIR, COMFY_COMMIT)
comfy_install = pip_install_without_touching_torch(COMFY_DIR / "requirements.txt", "comfyui")

ensure_checkout(GGUF_REPO, GGUF_NODE_DIR, GGUF_COMMIT)
gguf_install = pip_install_without_touching_torch(GGUF_NODE_DIR / "requirements.txt", "gguf")
print(f"installed comfyui:{len(comfy_install['installed'])} gguf:{len(gguf_install['installed'])} "
      "packages, torch untouched")

# --- architecture allowlist check (replaces the H3-era loader patch) ---------
# ComfyUI-GGUF validates a UNET GGUF's general.architecture against a hardcoded
# set. The LTX-2.5 GGUFs declare "ltxv" and carry the 61-key config blob in a
# KV named "config" (verified in the unsloth files' headers on 2026-10-20), so
# the stock loader works: assert both facts instead of patching anything.
loader_path = GGUF_NODE_DIR / "loader.py"
loader_text = loader_path.read_text(encoding="utf-8")
m = re.search(r"IMG_ARCH_LIST\s*=\s*\{([^}]*)\}", loader_text)
if not m or "ltxv" not in m.group(1):
    raise RuntimeError("ComfyUI-GGUF IMG_ARCH_LIST does not contain 'ltxv' at the pinned "
                       "commit - the LTX-2.5 GGUF would be rejected. Inspect loader.py.")
PROBE["stages"]["gguf_arch"] = {"img_arch_list": m.group(1).strip()[:200], "ltxv_ok": True}
print("gguf arch check: ltxv present, no patch needed")

custom_nodes = COMFY_DIR / "custom_nodes"
allowed = {"ComfyUI-GGUF", "H3BenchmarkControl", "__pycache__",
           "example_node.py.example", "websocket_image_save.py"}
unexpected = [p.name for p in custom_nodes.iterdir() if p.name not in allowed]
if unexpected:
    raise RuntimeError(f"Unexpected custom nodes in a controlled runtime: {unexpected}")

CONTROL_NODE_DIR.mkdir(parents=True, exist_ok=True)
# Slim studio control nodes: blob + latent save/load (plain torch.save of the
# LTX AV latent dict - plain tensors, no nested-tensor restore dance) and a
# finite-check latent probe.
(CONTROL_NODE_DIR / "__init__.py").write_text(r'''
import json
import logging
from pathlib import Path

import torch


def _detach_to_cpu(obj):
    if isinstance(obj, torch.Tensor):
        return obj.detach().cpu()
    if isinstance(obj, dict):
        return {key: _detach_to_cpu(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(_detach_to_cpu(value) for value in obj)
    return obj


class H3SaveConditioning:
    """Persist {conditioning, samples} so later runs never load the encoder.

    For LTX-2.5 the CONDITIONING is the LTXVConditioning output (a list of
    [embeddings, options] pairs) and samples is the packed AV latent with the
    keyframe guides - both plain python/torch containers.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "conditioning": ("CONDITIONING",), "samples": ("LATENT",),
            "store_dir": ("STRING", {"default": ""}),
            "key": ("STRING", {"default": "conditioning"})}}
    RETURN_TYPES = ()
    FUNCTION = "save"
    CATEGORY = "H3 benchmark/control"
    OUTPUT_NODE = True

    def save(self, conditioning, samples, store_dir, key):
        directory = Path(store_dir)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {"schema_version": 2,
                   "conditioning": _detach_to_cpu(conditioning),
                   "samples": _detach_to_cpu(samples)}
        destination = directory / f"{key}.pt"
        staged = destination.with_suffix(".pt.tmp")
        torch.save(payload, staged)
        staged.replace(destination)
        logging.info("LTX_SAVE_CONDITIONING %s", json.dumps(
            {"key": key, "bytes": destination.stat().st_size}, separators=(",", ":")))
        return {}


class H3LoadConditioning:
    """Return a precomputed (CONDITIONING, LATENT) pair without a CLIPLoader."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "store_dir": ("STRING", {"default": ""}),
            "key": ("STRING", {"default": "conditioning"}),
        }}
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("conditioning", "samples")
    FUNCTION = "load"
    CATEGORY = "H3 benchmark/control"

    def load(self, store_dir, key):
        source = Path(store_dir) / f"{key}.pt"
        if not source.is_file():
            raise RuntimeError(f"Precomputed conditioning is missing: {source}")
        payload = torch.load(source, map_location="cpu", weights_only=False)
        if payload.get("schema_version") != 2:
            raise RuntimeError(f"Unsupported schema: {payload.get('schema_version')}")
        logging.info("LTX_LOAD_CONDITIONING %s", json.dumps(
            {"key": key, "bytes": source.stat().st_size}, separators=(",", ":")))
        return (payload["conditioning"], payload["samples"])


class H3SaveLatent:
    """Persist a LATENT dict (the packed AV latent) between stages."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "samples": ("LATENT",),
            "store_dir": ("STRING", {"default": ""}),
            "key": ("STRING", {"default": "latent"})}}
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "save"
    CATEGORY = "H3 benchmark/control"
    OUTPUT_NODE = True

    def save(self, samples, store_dir, key):
        directory = Path(store_dir)
        directory.mkdir(parents=True, exist_ok=True)
        payload = _detach_to_cpu(dict(samples))
        destination = directory / f"{key}.pt"
        staged = destination.with_suffix(".pt.tmp")
        torch.save(payload, staged)
        staged.replace(destination)
        logging.info("LTX_SAVE_LATENT %s", json.dumps(
            {"key": key, "bytes": destination.stat().st_size}, separators=(",", ":")))
        return (samples,)


class H3LoadLatent:
    """Load a LATENT dict saved by H3SaveLatent."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "store_dir": ("STRING", {"default": ""}),
            "key": ("STRING", {"default": "latent"}),
        }}
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "load"
    CATEGORY = "H3 benchmark/control"

    def load(self, store_dir, key):
        source = Path(store_dir) / f"{key}.pt"
        if not source.is_file():
            raise RuntimeError(f"Persisted latent is missing: {source}")
        payload = torch.load(source, map_location="cpu", weights_only=False)
        if not isinstance(payload, dict) or "samples" not in payload:
            raise RuntimeError(f"Persisted latent is malformed: {source}")
        return (payload,)


class H3LatentProbe:
    """Record the sampled AV latent and refuse non-finite values.

    A finite latent can still decode to black - the decode QA covers that -
    but a NaN here means the whole session is misconfigured, so fail fast.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "samples": ("LATENT",),
            "filename_prefix": ("STRING", {"default": "ltx25/probe"}),
        }}
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "save_summary"
    CATEGORY = "H3 benchmark/control"
    OUTPUT_NODE = True

    def save_summary(self, samples, filename_prefix):
        import folder_paths
        packed = samples.get("samples")
        entries = []
        if isinstance(packed, torch.Tensor):
            entries.append(packed)
        elif isinstance(packed, (list, tuple)):
            entries += [p for p in packed if isinstance(p, torch.Tensor)]
        finite = [bool(torch.isfinite(p).all().item()) for p in entries]
        output_path = Path(folder_paths.get_output_directory()) / f"{filename_prefix}.latent_summary.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"shapes": [list(p.shape) for p in entries],
                   "dtypes": [str(p.dtype) for p in entries],
                   "finite": finite,
                   "keys": sorted(samples.keys())}
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        logging.info("LTX_LATENT_PROBE %s", json.dumps(payload["shapes"], separators=(",", ":")))
        if finite and not all(finite):
            raise RuntimeError(f"Sampled latent contains non-finite values: {payload}")
        return (samples,)


NODE_CLASS_MAPPINGS = {
    "H3SaveConditioning": H3SaveConditioning,
    "H3LoadConditioning": H3LoadConditioning,
    "H3SaveLatent": H3SaveLatent,
    "H3LoadLatent": H3LoadLatent,
    "H3LatentProbe": H3LatentProbe,
}
''')
print("studio control nodes written (slim LTX variant)")

FORBIDDEN_FLAGS = ("--use-sage-attention", "--highvram")


def supported_cli_flags():
    path = COMFY_DIR / "comfy" / "cli_args.py"
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    return set(re.findall(r'"(--[a-z0-9][a-z0-9-]*)"', text)) | \
        set(re.findall(r"'(--[a-z0-9][a-z0-9-]*)'", text))


# --- single-port server control (used by the verify pass and the blob stage;
# the two persistent SAMPLER servers in cell 4 have their own spawn_comfy) ----
COMFY_PROCESS = None
COMFY_LOG_HANDLE = None


def stop_comfy(term_timeout_s=15):
    global COMFY_PROCESS, COMFY_LOG_HANDLE
    if COMFY_PROCESS is not None and COMFY_PROCESS.poll() is None:
        os.killpg(COMFY_PROCESS.pid, signal.SIGTERM)
        try:
            COMFY_PROCESS.wait(timeout=term_timeout_s)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(COMFY_PROCESS.pid, signal.SIGKILL)
                COMFY_PROCESS.wait(timeout=15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
    COMFY_PROCESS = None
    if COMFY_LOG_HANDLE is not None:
        COMFY_LOG_HANDLE.close()
        COMFY_LOG_HANDLE = None


def start_comfy(timeout_s=900, quiet=False, port=8188, cpu=False, extra_flags=()):
    """Start one ComfyUI server. cpu=True forces CPU mode (node verification
    must not touch the GPUs; the blob stage leaves them to the samplers)."""
    global COMFY_PROCESS, COMFY_LOG_HANDLE
    stop_comfy()
    log_path = WORK / f"comfy_p{port}.log"
    COMFY_LOG_HANDLE = log_path.open("a", encoding="utf-8", buffering=1)
    supported = supported_cli_flags()
    command = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(port),
               "--disable-auto-launch", "--preview-method", "none", "--cache-classic"]
    for flag in list(extra_flags) + (["--cpu"] if cpu and "--cpu" in supported else []):
        if flag in supported:
            command.append(flag)
    for forbidden in FORBIDDEN_FLAGS:
        if forbidden in command:
            raise RuntimeError(f"{forbidden} is forbidden here.")
    print("$ " + " ".join(command))
    env = {"CUDA_VISIBLE_DEVICES": ""} if cpu else {}
    COMFY_PROCESS = subprocess.Popen(
        command, cwd=COMFY_DIR, env=scrubbed_child_environment({"PYTHONUNBUFFERED": "1", **env}),
        stdout=COMFY_LOG_HANDLE, stderr=subprocess.STDOUT, start_new_session=True)
    import requests
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if COMFY_PROCESS.poll() is not None:
            raise RuntimeError("ComfyUI exited during startup:\n"
                               + log_path.read_text(errors="replace")[-8000:])
        try:
            if requests.get(f"http://127.0.0.1:{port}/system_stats", timeout=5).status_code == 200:
                return f"http://127.0.0.1:{port}"
        except Exception:
            pass
        time.sleep(2)
    stop_comfy()
    raise RuntimeError(f"ComfyUI startup timeout on port {port}")


# --- EARLY node verification (CPU, no models) ---------------------------------
REQUIRED_NODES = {
    # loaders + samplers
    "UnetLoaderGGUF", "CLIPLoader", "CLIPTextEncode", "VAELoader", "LoadImage",
    "RandomNoise", "ManualSigmas", "KSamplerSelect", "SamplerCustomAdvanced",
    # LTX-2.5 graph
    "LTXVPreprocess", "LTXVImgToVideoInplace", "EmptyLTXVLatentVideo",
    "LTXVEmptyLatentAudio", "LTXVConcatAVLatent", "LTXVSeparateAVLatent",
    "LTXVConditioning", "LTXVDualCFGGuider",
    # decode
    "VAEDecodeTiled", "LTXVAudioVAEDecode", "CreateVideo", "SaveVideo",
    # studio control
    "H3SaveConditioning", "H3LoadConditioning", "H3SaveLatent", "H3LoadLatent",
    "H3LatentProbe",
}

import requests  # noqa: E402
verify_base = start_comfy(port=8199, cpu=True, timeout_s=1200)
try:
    info = requests.get(f"{verify_base}/object_info", timeout=600).json()
    missing = sorted(REQUIRED_NODES - set(info))
    if missing:
        raise RuntimeError(f"Pinned ComfyUI is missing required nodes: {missing}")
    PROBE["stages"]["node_check"] = {"verified": len(REQUIRED_NODES), "missing": []}
    print(f"node check: all {len(REQUIRED_NODES)} required nodes present")
finally:
    stop_comfy()
    print("verification server stopped")
save()
prog("cell2 done (comfy+gguf+nodes verified)")
