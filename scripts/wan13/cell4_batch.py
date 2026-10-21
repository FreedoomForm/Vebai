# Stages 3-5 (dual-worker batch) -- TWO ComfyUI servers, one per T4.
#
# The parallelism this kernel exists for, unchanged from the H3/LTX eras: one
# worker thread per T4, each owning a ComfyUI process on its own port, pulling
# from a shared shot queue. What changed with Wan 2.1 1.3B:
#   * the sampling graph loads the conditioning pair from blobs (no encoder),
#     samples 30 uni_pc steps through ModelSamplingSD3 shift 8, and then -
#     in the SAME graph - decodes with the wan VAE (tiled) and muxes a silent
#     MP4 through CreateVideo + SaveVideo. No separate decode stage, no audio
#     VAE: Wan 2.1 is video-only.
#   * the retry ladder shrinks the geometry instead of swapping quants: both
#     DiTs fit a T4, so a smaller checkpoint would buy nothing.
import queue as queue_mod
import threading

KAGGLE_WORKING = Path("/kaggle/working") if Path("/kaggle").is_dir() else WORK
OUT_STORE = KAGGLE_WORKING / "out"
STATE_PATH = KAGGLE_WORKING / "state.json"
OUT_STORE.mkdir(parents=True, exist_ok=True)

SESSION_DEADLINE = time.time() + int(8.4 * 3600)   # margin under the 9h GPU cap
WORKER_PORTS = {0: 8188, 1: 8189}
ENCODE_PORT = 8190           # dedicated blob-encode server (samplers are 8188/8189)
INSURANCE_TOKEN = "KGAT_abba3bba83ed8f6a11855f7a819228ea"
JOBS_DS = "freedomform/rmc-studio-jobs"
OUTPUTS_DS = "freedomform/rmc-studio-outputs"
WORKER_POLL_S = 25           # cheap jobs-dataset poll cadence (no GPU cost)
WORKER_IDLE_TIMEOUT_S = 1800  # exit after 30 idle minutes to save GPU quota
import zlib as _zlib

PUSH_LOCK = threading.Lock()
def push_insurance(tag):
    """serialized wrapper: feeder and both workers push the same dataset"""
    with PUSH_LOCK:
        return _push_insurance_impl(tag)

state = (json.loads(STATE_PATH.read_text(encoding="utf-8"))
         if STATE_PATH.exists() else {"shots": {}})
state.setdefault("shots", {})
prog("cell4 runtime init")

def save_state():
    STATE_PATH.write_text(json.dumps(state, indent=1, ensure_ascii=False),
                          encoding="utf-8")

save_state()

# --- per-worker ComfyUI process control ---------------------------------------
WORKER_TABLE = {}

def stop_comfy_port(port, term_timeout_s=15):
    entry = WORKER_TABLE.pop(port, None)
    if entry is None:
        return
    process = entry["process"]
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=term_timeout_s)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
    try:
        entry["log_handle"].close()
    except Exception:
        pass

def spawn_comfy(port, gpu, dtype_flag=None, timeout_s=900):
    """One ComfyUI process pinned to one GPU. dtype_flag is unused for Wan
    (comfy picks fp16 on sm75 by itself); kept for signature compatibility."""
    stop_comfy_port(port)
    log_path = WORK / f"comfy_p{port}.log"
    log_handle = log_path.open("a", encoding="utf-8", buffering=1)
    supported = supported_cli_flags()
    command = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(port),
               "--disable-auto-launch", "--preview-method", "none", "--cache-classic"]
    requested, applied, dropped = [], [], []
    if dtype_flag:
        requested.append(dtype_flag)
    for flag in requested:
        (applied if flag in supported else dropped).append(flag)
        if flag in supported:
            command.append(flag)
    for forbidden in FORBIDDEN_FLAGS:
        if forbidden in command:
            raise RuntimeError(f"{forbidden} is forbidden here.")
    env = scrubbed_child_environment({"CUDA_VISIBLE_DEVICES": str(gpu),
                                      "PYTHONUNBUFFERED": "1"})
    print(f"$ CUDA_VISIBLE_DEVICES={gpu} " + " ".join(command))
    process = subprocess.Popen(command, cwd=COMFY_DIR, env=env, stdout=log_handle,
                               stderr=subprocess.STDOUT, start_new_session=True)
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ComfyUI (port {port}) exited during startup:\n"
                               + log_path.read_text(errors="replace")[-4000:])
        try:
            if requests.get(f"{base}/system_stats", timeout=5).status_code == 200:
                WORKER_TABLE[port] = {"process": process, "log": log_path,
                                      "log_handle": log_handle, "base_url": base}
                return WORKER_TABLE[port]
        except Exception:
            pass
        time.sleep(2)
    stop_comfy_port(port)
    raise RuntimeError(f"ComfyUI startup timeout on port {port}")

def server_log_slice(port, offset):
    entry = WORKER_TABLE.get(port)
    if entry is not None and entry["log_handle"] is not None:
        entry["log_handle"].flush()
    path = WORK / f"comfy_p{port}.log"
    if not path.exists():
        return ""
    with path.open("rb") as reader:
        reader.seek(offset)
        return reader.read().decode("utf-8", errors="replace")

def dropdown_from(info, node_type, input_name):
    inputs = info.get(node_type, {}).get("input", {})
    spec = (inputs.get("required", {}) | inputs.get("optional", {})).get(input_name)
    return spec[0] if spec and isinstance(spec[0], list) else []

# --- the sample+decode graph (per-shot; no text encoder) ------------------------
GUARD_HEARTBEAT_S = 30

def build_sample_graph(shot, gear, seed, latent_key, negative_blob_key):
    """One roundtrip: load blobs -> 30-step uni_pc sample -> tiled VAE decode ->
    silent mp4. The negative blob's latent is ignored on purpose - the sampler
    seeds from the positive blob's zeros/Fun-InP latent (node 2 output 1)."""
    dit_name = shot["dit"]["hf_filename"]
    video_prefix = f"wan13_video/job_{shot['job_id']}/{latent_key}"
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": dit_name,
                                                     "weight_dtype": "default"}},
        "2": {"class_type": "H3LoadConditioning", "inputs": {
            "store_dir": str(CONDITIONING_STORE), "key": shot["keys"][gear]}},
        "3": {"class_type": "H3LoadConditioning", "inputs": {
            "store_dir": str(CONDITIONING_STORE), "key": negative_blob_key}},
        "4": {"class_type": "ModelSamplingSD3", "inputs": {
            "model": ["1", 0], "shift": SHIFT}},
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["2", 0], "negative": ["3", 0],
            "latent_image": ["2", 1], "seed": seed, "steps": STEPS, "cfg": CFG,
            "sampler_name": SAMPLER_NAME, "scheduler": SCHEDULER, "denoise": 1.0}},
        "6": {"class_type": "H3SaveLatent", "inputs": {
            "samples": ["5", 0], "store_dir": str(LATENT_STORE), "key": latent_key}},
        "7": {"class_type": "H3LatentProbe", "inputs": {
            "samples": ["6", 0], "filename_prefix": f"wan13/job_{shot['job_id']}"}},
        "8": {"class_type": "VAELoader", "inputs": {
            "vae_name": Path(VIDEO_VAE["hf_filename"]).name}},
        "9": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["5", 0], "vae": ["8", 0], "tile_size": 512, "overlap": 64,
            "temporal_size": 64, "temporal_overlap": 16}},
        "10": {"class_type": "CreateVideo", "inputs": {
            "images": ["9", 0], "fps": float(FPS)}},
        "11": {"class_type": "SaveVideo", "inputs": {
            "video": ["10", 0], "filename_prefix": video_prefix, "format": "auto"}},
    }

def validate(graph, object_info, port):
    errors = []
    serialized = json.dumps(graph)
    if "CLIPLoader" in serialized:
        errors.append("CLIPLoader present: the 6.27 GiB text encoder must not load here")
    for node_id, spec in graph.items():
        info = object_info.get(spec["class_type"])
        if info is None:
            errors.append(f"{node_id}: unknown class {spec['class_type']}")
            continue
        schema = info.get("input", {})
        allowed = set(schema.get("required", {})) | set(schema.get("optional", {})) \
            | set(schema.get("hidden", {}))
        supplied = set(spec["inputs"])
        if set(schema.get("required", {})) - supplied:
            errors.append(f"{node_id}/{spec['class_type']} missing "
                          f"{sorted(set(schema.get('required', {})) - supplied)}")
        if supplied - allowed:
            errors.append(f"{node_id}/{spec['class_type']} unknown "
                          f"{sorted(supplied - allowed)}")
    if errors:
        raise RuntimeError(f"Sample graph validation failed (port {port}):\n"
                           + "\n".join(errors))

# --- progress parsing and the budget guard -------------------------------------
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
TQDM_RE = re.compile(
    r"(\d+)%\|[^|\n]*\|\s*(\d+)/(\d+)\s*\[([0-9:]+)<([0-9:]+|\?)"
    r"(?:,\s*([0-9.]+)(s/it|it/s))?")

CLIFF_PROBE_WINDOW_S = 120
CLIFF_PROBE_MAX_WINDOWS = 2
CLIFF_PROJECTED_BUDGET_S = 3600
SAMPLER_START_TIMEOUT_S = 1500
VIDEO_INSPECT_EVERY = 8

def parse_clock(value):
    total = 0.0
    for part in value.split(":"):
        total = total * 60 + float(part)
    return total

def latest_progress(text):
    matches = list(TQDM_RE.finditer(ANSI_RE.sub("", text).replace("\r", "\n")))
    if not matches:
        return None
    percent, done, total, elapsed, _remaining, rate, unit = matches[-1].groups()
    done, elapsed_s = int(done), parse_clock(elapsed)
    return {"percent": int(percent), "steps_completed": done,
            "steps_total": int(total), "elapsed_in_loop_s": elapsed_s,
            "observed_s_per_step": (elapsed_s / done) if done else None,
            "reported_s_per_step": (float(rate) if unit == "s/it"
                                    else (1.0 / float(rate) if rate and float(rate) else None))
            if rate else None}

def new_guard_runtime(started):
    return {"started": started, "sampler_started_at": None, "windows_used": 0,
            "last_heartbeat": started, "settled": False, "previous_window": None}

def guard_decide(progress, now, runtime, guard_state, steps, budget_s):
    """Times two probe windows of the sampler, projects the total denoise time
    from the observed s/step, and cancels projections that overrun the budget."""
    runtime = dict(runtime)
    messages = []
    waited = now - runtime["started"]
    if waited < 0 or waited > 86400:
        raise RuntimeError(f"Guard clock is inconsistent: waited={waited}.")
    if progress is None:
        if now - runtime["last_heartbeat"] >= GUARD_HEARTBEAT_S:
            runtime["last_heartbeat"] = now
            messages.append(f"[guard] {waited:.0f}s: loading, no sampler progress yet "
                            f"(timeout {SAMPLER_START_TIMEOUT_S}s)")
        if waited > SAMPLER_START_TIMEOUT_S:
            guard_state["seconds_waited_for_sampler"] = round(waited, 1)
            return ({"stop": True, "outcome": "SAMPLER_NEVER_STARTED",
                     "messages": messages}, runtime)
        return ({"stop": False, "outcome": None, "messages": messages}, runtime)
    if runtime["sampler_started_at"] is None:
        runtime["sampler_started_at"] = now - progress["elapsed_in_loop_s"]
        guard_state["sampler_started"] = True
        guard_state["seconds_to_sampler_start"] = round(
            runtime["sampler_started_at"] - runtime["started"], 1)
        messages.append(f"[guard] sampler started after "
                        f"{guard_state['seconds_to_sampler_start']}s")
    if runtime["settled"]:
        return ({"stop": False, "outcome": "WITHIN_BUDGET", "messages": messages}, runtime)
    observed = now - runtime["sampler_started_at"]
    if progress["steps_completed"] <= 0:
        no_step_deadline = max(CLIFF_PROBE_WINDOW_S * CLIFF_PROBE_MAX_WINDOWS,
                               2.0 * budget_s / max(steps, 1))
        guard_state["no_step_deadline_s"] = round(no_step_deadline, 1)
        if observed >= no_step_deadline:
            guard_state["observation_s"] = round(observed, 1)
            guard_state["steps_completed_at_decision"] = 0
            messages.append(f"[guard] {observed:.0f}s observed and not one step has "
                            f"finished (deadline {no_step_deadline:.0f}s)")
            return ({"stop": True, "outcome": "CLIFF_NO_STEP_COMPLETED",
                     "messages": messages}, runtime)
    if observed < CLIFF_PROBE_WINDOW_S * (runtime["windows_used"] + 1):
        return ({"stop": False, "outcome": None, "messages": messages}, runtime)
    runtime["windows_used"] += 1
    marginal = None
    previous = runtime["previous_window"]
    if previous and progress["steps_completed"] > previous["steps_completed"]:
        marginal = ((progress["elapsed_in_loop_s"] - previous["elapsed_in_loop_s"])
                    / (progress["steps_completed"] - previous["steps_completed"]))
    runtime["previous_window"] = {
        "elapsed_in_loop_s": progress["elapsed_in_loop_s"],
        "steps_completed": progress["steps_completed"]}
    guard_state.update({"windows_used": runtime["windows_used"],
                        "observation_s": round(observed, 1),
                        "steps_completed_at_decision": progress["steps_completed"],
                        "observed_s_per_step": progress["observed_s_per_step"],
                        "marginal_s_per_step": round(marginal, 2) if marginal else None})
    if progress["steps_completed"] <= 0:
        messages.append(f"[guard] {observed:.0f}s observed, still 0 steps "
                        f"(cancel at {guard_state.get('no_step_deadline_s')}s)")
        return ({"stop": False, "outcome": None, "messages": messages}, runtime)
    projected = progress["observed_s_per_step"] * steps
    guard_state["projected_denoise_total_s"] = round(projected, 1)
    messages.append(f"[guard] {progress['steps_completed']}/{steps} steps in "
                    f"{observed:.0f}s -> {progress['observed_s_per_step']:.1f} s/step, "
                    f"projected {projected / 60:.1f} min")
    if projected > budget_s:
        return ({"stop": True, "outcome": "CLIFF_PROJECTED_OVER_BUDGET",
                 "messages": messages}, runtime)
    runtime["settled"] = True
    guard_state["outcome"] = "WITHIN_BUDGET"
    return ({"stop": False, "outcome": "WITHIN_BUDGET", "messages": messages}, runtime)

def cancel_prompt(port, prompt_id):
    outcome = {"cancel_requested": False, "drained": False}
    base = f"http://127.0.0.1:{port}"
    try:
        response = requests.post(f"{base}/api/jobs/{prompt_id}/cancel", timeout=30)
        response.raise_for_status()
        outcome["cancel_requested"] = bool(response.json().get("cancelled"))
    except Exception as exc:
        outcome["cancel_error"] = type(exc).__name__
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            queue = requests.get(f"{base}/queue", timeout=30).json()
            active = {item[1] for item in queue.get("queue_running", [])
                      + queue.get("queue_pending", [])
                      if isinstance(item, list) and len(item) > 1}
            if prompt_id not in active:
                outcome["drained"] = True
                return outcome
        except Exception:
            pass
        time.sleep(2)
    return outcome

# --- sampling + decoding one attempt --------------------------------------------
def generate_one(port, shot, gear, seed, latent_key, budget_s, record):
    """Runs the whole sample+decode graph in one fresh ComfyUI process and
    returns the produced mp4 path, or None (record explains)."""
    gpu = 0 if port == WORKER_PORTS[0] else 1
    server = spawn_comfy(port, gpu)
    base = server["base_url"]
    log_offset = server["log"].stat().st_size if server["log"].exists() else 0
    try:
        info = requests.get(f"{base}/object_info", timeout=300).json()
        required = {"UNETLoader", "H3LoadConditioning", "ModelSamplingSD3", "KSampler",
                    "H3SaveLatent", "H3LatentProbe", "VAELoader", "VAEDecodeTiled",
                    "CreateVideo", "SaveVideo"}
        missing = sorted(required - set(info))
        if missing:
            raise RuntimeError(f"Missing required nodes: {missing}")
        if shot["dit"]["hf_filename"] not in dropdown_from(info, "UNETLoader", "unet_name"):
            raise RuntimeError(f"DiT {shot['dit']['hf_filename']} not visible to UNETLoader")
        if Path(VIDEO_VAE["hf_filename"]).name not in dropdown_from(info, "VAELoader", "vae_name"):
            raise RuntimeError("wan VAE not visible to VAELoader")
        graph = build_sample_graph(shot, gear, seed, latent_key,
                                   NEG_KEYS[shot["variant"]])
        validate(graph, info, port)
        prompt_id = str(uuid.uuid4())
        response = requests.post(f"{base}/prompt", timeout=120, json={
            "prompt": graph, "client_id": str(uuid.uuid4()), "prompt_id": prompt_id})
        response.raise_for_status()
        queued = response.json()
        if queued.get("node_errors"):
            raise RuntimeError(f"Node errors: {queued['node_errors']}")
        started = time.perf_counter()
        print(f"shot_{shot['num']:02d}: sampling {shot['geometries'][gear]['length']}f "
              f"gear {gear} seed {seed} ({shot['dit']['hf_filename']}) on port {port}")
        shown = log_offset
        guard_runtime = new_guard_runtime(started)
        guard_state = {"outcome": None, "sampler_started": False}
        record_out = None
        deadline = min(SESSION_DEADLINE,
                       time.time() + SAMPLER_START_TIMEOUT_S + budget_s + 1800)
        while time.time() < deadline:
            if server["process"].poll() is not None:
                raise RuntimeError("ComfyUI exited during generation (check for an OOM kill)")
            chunk = server_log_slice(port, shown)
            shown += len(chunk.encode("utf-8"))
            for line in chunk.splitlines():
                if line.strip() and any(t in line for t in (
                        "error", "Error", "out of memory", "Requested to load",
                        "Patched", "lora key")):
                    print("    " + line[:160])
            try:
                history = requests.get(f"{base}/history/{prompt_id}", timeout=60).json()
                if prompt_id in history:
                    status = history[prompt_id].get("status", {})
                    if status.get("completed") is True or status.get("status_str") == "error":
                        record_out = history[prompt_id]
                        break
            except Exception:
                pass
            progress = latest_progress(server_log_slice(port, log_offset))
            now = time.perf_counter()
            decision, guard_runtime = guard_decide(progress, now, guard_runtime,
                                                   guard_state, STEPS, budget_s)
            for message in decision["messages"]:
                print("    " + message)
            if decision["stop"]:
                guard_state["outcome"] = decision["outcome"]
                guard_state["cancellation"] = cancel_prompt(port, prompt_id)
                break
            time.sleep(5)
        elapsed = round(time.perf_counter() - started, 1)
        outcome = guard_state.get("outcome")
        record.update({"generate_elapsed_s": elapsed, "guard_state": guard_state})
        if outcome in ("CLIFF_NO_STEP_COMPLETED", "CLIFF_PROJECTED_OVER_BUDGET",
                       "SAMPLER_NEVER_STARTED"):
            record["sample_status"] = "CLIFF"
            record["failure_class"] = outcome
            return None
        if record_out is None:
            record["sample_status"] = "NO_HISTORY"
            return None
        status = record_out.get("status", {})
        log_text = server_log_slice(port, log_offset)
        record["oom_seen"] = bool(re.search(
            r"CUDA out of memory|torch\.OutOfMemoryError", log_text, re.I))
        if status.get("status_str") != "success":
            record["sample_status"] = "FAILED"
            record["history_status_str"] = status.get("status_str")
            record["history_messages"] = [str(m)[:300] for m in (status.get("messages") or [])][:8]
            return None
        latent_path = LATENT_STORE / f"{latent_key}.pt"
        if not latent_path.is_file():
            record["sample_status"] = "NO_LATENT"
            return None
        summaries = sorted((OUTPUT_DIR / "wan13").glob(
            f"job_{shot['job_id']}*.latent_summary.json"), key=lambda p: p.stat().st_mtime)
        if summaries:
            summary = json.loads(summaries[-1].read_text(encoding="utf-8"))
            record["latent_summary"] = {"shapes": summary.get("shapes"),
                                        "finite": summary.get("finite")}
            finite = (summary.get("finite") or [])
            if finite and not all(finite):
                record["sample_status"] = "NON_FINITE_LATENT"
                return None
        produced = []
        for node_output in (record_out.get("outputs") or {}).values():
            for entry in node_output.get("images", []) + node_output.get("videos", []) \
                    + node_output.get("gifs", []):
                if isinstance(entry, dict) and entry.get("filename"):
                    produced.append(OUTPUT_DIR / entry.get("subfolder", "") / entry["filename"])
        if not produced:
            directory = OUTPUT_DIR / "wan13_video" / shot_num_dir(video_prefix)
            produced = sorted(directory.glob("**/*"), key=lambda p: p.stat().st_mtime) \
                if directory.is_dir() else []
        produced = [p for p in produced if p.is_file() and p.suffix in (".mp4", ".webm", ".mkv")]
        if not produced:
            record["sample_status"] = "NO_FILE"
            return None
        record["sample_status"] = "SUCCESS"
        print(f"shot_{shot['num']:02d}: generated ok in {elapsed}s "
              f"({guard_state.get('observed_s_per_step')} s/step)")
        return produced[-1]
    finally:
        stop_comfy_port(port)

def shot_num_dir(video_prefix):
    return str(Path(video_prefix).parent.name)

# --- is there actually a picture in it? (PyAV QA, silent mp4 expected) ----------
def inspect_video(mp4, record):
    inspection = {}
    try:
        import av
        with av.open(str(mp4)) as container:
            streams = {s.type: s for s in container.streams}
            inspection["streams"] = sorted(streams)
            vstream = streams.get("video")
            if vstream is not None:
                inspection["video"] = {
                    "codec": vstream.codec_context.name,
                    "width": vstream.codec_context.width,
                    "height": vstream.codec_context.height,
                    "frames": vstream.frames,
                    "avg_rate": float(vstream.average_rate)
                    if vstream.average_rate else None}
            if "audio" in streams:
                inspection["unexpected_audio"] = True
        with av.open(str(mp4)) as container:
            brightness, index = [], 0
            for frame in container.decode(video=0):
                if index % VIDEO_INSPECT_EVERY == 0:
                    plane = frame.to_ndarray(format="gray")
                    brightness.append((index, float(plane.mean()), float(plane.std())))
                index += 1
            inspection["frames_decoded"] = index
            if brightness:
                means = [m for _, m, _ in brightness]
                stds = [s for _, _, s in brightness]
                inspection["mean_luma"] = round(sum(means) / len(means), 2)
                inspection["mean_std"] = round(sum(stds) / len(stds), 2)
                inspection["near_black_frames"] = sum(
                    1 for m, s in zip(means, stds) if m < 4.0 and s < 2.0)
                inspection["frames_sampled"] = len(means)
        record["inspection"] = inspection
    except Exception as exc:
        inspection["error"] = f"{type(exc).__name__}: {exc}"
        record["inspection"] = inspection
    return inspection

# --- insurance: push partial output to a dataset (v3's proven pattern) ----------
def _push_insurance_impl(tag):
    try:
        os.environ["KAGGLE_API_TOKEN"] = INSURANCE_TOKEN
        (OUT_STORE / "state.json").write_text(
            json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
        meta_path = OUT_STORE / "dataset-metadata.json"
        if not meta_path.exists():
            json.dump({"title": "rmc-studio-outputs", "id": "freedomform/rmc-studio-outputs",
                       "licenses": [{"name": "CC0-1.0"}]},
                      open(meta_path, "w"))
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kaggle"],
                       capture_output=True, timeout=300)
        # create first (no-op if it already exists), then push a version --
        # v3's lesson: `datasets version` alone fails while the dataset is absent.
        created = subprocess.run(
            [sys.executable, "-m", "kaggle", "datasets", "create", "-p", str(OUT_STORE),
             "--dir-mode", "zip"], capture_output=True, text=True, timeout=1800)
        blob = (created.stdout or "") + (created.stderr or "")
        if "successfully created" not in blob.lower():
            version = subprocess.run(
                [sys.executable, "-m", "kaggle", "datasets", "version",
                 "-p", str(OUT_STORE), "--dir-mode", "zip",
                 "-m", f"{tag} {time.strftime('%H:%M')}"],
                capture_output=True, text=True, timeout=1800)
            print(f"insurance version rc={version.returncode} "
                  f"{(version.stdout or version.stderr)[-160:]}")
        else:
            print("insurance dataset created (first push done)")
    except Exception as exc:
        print(f"insurance push failed (non-fatal): {type(exc).__name__}: {exc}")

# --- one shot through the ladder -------------------------------------------------
def run_shot(port, shot, record):
    """(primary gear, seed) -> (primary gear, seed+1000) -> (fallback gear,
    seed+1000). Same DiT on every rung: both Wan 1.3B variants fit a T4, so
    there is no quant to fall back to - only geometry and noise change."""
    attempts = [
        (shot["gear_primary"], shot["seed"]),
        (shot["gear_primary"], shot["seed"] + 1000),
        (shot["gear_fallback"], shot["seed"] + 1000),
    ]
    for attempt_index, (gear, seed) in enumerate(attempts):
        key = shot["keys"].get(gear)
        if key is None or not (CONDITIONING_STORE / f"{key}.pt").is_file():
            print(f"shot_{shot['num']:02d}: no blob for gear {gear}, skipping attempt")
            continue
        frames = shot["geometries"][gear]["length"]
        budget_s = int(CLIFF_PROJECTED_BUDGET_S * max(1.0, frames / 81.0) ** 1.6)
        latent_key = f"job_{shot['job_id']}_g{gear.replace('.', '')}_s{seed}"
        record.update({"attempt": attempt_index, "gear": gear, "seed": seed,
                       "dit": shot["dit"]["hf_filename"], "frames": frames,
                       "budget_s": budget_s})
        mp4 = generate_one(port, shot, gear, seed, latent_key, budget_s, record)
        if mp4 is None:
            print(f"shot_{shot['num']:02d}: attempt {attempt_index + 1} -> "
                  f"{record.get('sample_status')}, trying next ladder rung")
            continue
        inspection = inspect_video(mp4, record)
        record["mp4"] = str(mp4)
        return mp4
    return None

# --- the two workers -------------------------------------------------------------
# --- [studio-worker] persistent runtime (feeder owns ALL intake) -----------------
QUEUE = queue_mod.Queue()
QUEUE_LOCK = threading.Lock()
state_lock = threading.Lock()
OK_COUNT = {"n": 0}
ACTIVE = {"n": 0}
LAST_WORK = {"t": time.time()}
SHUTDOWN = threading.Event()
SEEN_JOBS = set()

def estimated_shot_seconds(shot):
    """encode ~150 + sample ~30 steps x ~8 s/step scaled by frames + decode/io."""
    frames = float(shot.get("frames", 81))
    return 150 + 360 * (frames / 81.0) ** 1.6 + 120

def worker(gpu):
    port = WORKER_PORTS[gpu]
    while True:
        with QUEUE_LOCK:
            if QUEUE.empty():
                if SHUTDOWN.is_set() or time.time() - LAST_WORK["t"] > WORKER_IDLE_TIMEOUT_S:
                    return
                time.sleep(5)
                continue
            shot = QUEUE.get()
            LAST_WORK["t"] = time.time()
        try:
            done_state = state["shots"].get(shot["job_id"], {})
            if done_state.get("status") == "done" \
                    and (OUT_STORE / f"job_{shot['job_id']}.mp4").is_file():
                print(f"shot_{shot['num']:02d}: already done, skipping (resume)")
                continue
            remaining = SESSION_DEADLINE - time.time()
            estimate = estimated_shot_seconds(shot)
            if remaining < estimate:
                print(f"shot_{shot['num']:02d}: needs ~{estimate / 60:.0f} min, "
                      f"{remaining / 60:.0f} min left -> skipped_time")
                with state_lock:
                    state["shots"][shot["job_id"]] = {
                        "status": "skipped_time", "gpu": gpu}
                    save_state()
                continue
            ACTIVE["n"] += 1
            record = {"gpu": gpu, "started_at": utc_now(), "variant": shot["variant"]}
            started = time.perf_counter()
            mp4 = run_shot(port, shot, record)
            prog(f"shot {shot['num']} run_shot returned gpu{gpu} "
                 f"status={record.get('sample_status', '?')}")
            record["elapsed_s"] = round(time.perf_counter() - started, 1)
            with state_lock:
                if mp4 is not None:
                    dest = OUT_STORE / f"job_{shot['job_id']}.mp4"
                    shutil.copy2(mp4, dest)
                    record.update({"status": "done", "file": str(dest),
                                   "bytes": dest.stat().st_size})
                    OK_COUNT["n"] += 1
                    # push after EVERY finished job (the site polls the dataset)
                    threading.Thread(target=push_insurance,
                                     args=(f"{OK_COUNT['n']} shots",),
                                     daemon=True).start()
                else:
                    record["status"] = "failed"
                state["shots"][shot["job_id"]] = record
                save_state()
        except Exception as exc:
            with state_lock:
                state["shots"][shot["job_id"]] = {
                    "status": "error", "gpu": gpu,
                    "error": f"{type(exc).__name__}: {exc}"[:600]}
                save_state()
            print(f"shot_{shot['num']:02d}: EXCEPTION {type(exc).__name__}: {exc}")
        finally:
            stop_comfy_port(port)
            ACTIVE["n"] = max(0, ACTIVE["n"] - 1)
            LAST_WORK["t"] = time.time()
            QUEUE.task_done()

# --- [studio-worker] feeder: Kaggle-API intake -> prepare -> encode -> queue -----
def kaggle_cli(*args, timeout=900):
    os.environ["KAGGLE_API_TOKEN"] = INSURANCE_TOKEN
    return subprocess.run([sys.executable, "-m", "kaggle", *args],
                          capture_output=True, text=True, timeout=timeout)

def ensure_kaggle_cli():
    """the preinstalled 1.5.x CLI on Kaggle images cannot authenticate with a
    KAGGLE_API_TOKEN (KGAT_...) -- upgrade to the 1.6+/1.7.x line that can"""
    try:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "kaggle"],
                           capture_output=True, text=True, timeout=600)
        print(f"[cli] kaggle upgrade rc={r.returncode}", flush=True)
    except Exception as exc:
        print(f"[cli] kaggle upgrade failed: {type(exc).__name__}: {exc}", flush=True)

def jobs_line():
    try:
        r = kaggle_cli("datasets", "list", "--mine", "--search", JOBS_DS, timeout=120)
        for line in r.stdout.splitlines():
            if line.startswith(JOBS_DS):
                return line
        print(f"[list] no match rc={r.returncode} out={r.stdout[:200]!r} "
              f"err={r.stderr[:300]!r}", flush=True)
    except Exception as exc:
        print(f"[feeder] jobs_line failed: {type(exc).__name__}: {exc}", flush=True)
    return ""

def wait_jobs_ready(timeout_s=420):
    """tolerant ready-gate -- a just-pushed version takes a while to process"""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            r = kaggle_cli("datasets", "status", JOBS_DS, timeout=120)
            out = (r.stdout or "").strip().split("\n")[0].strip().lower()
            print(f"[feeder/status] rc={r.returncode} out={out[:60]!r}", flush=True)
            if "processing" not in out and "pending" not in out \
                    and "queued" not in out:
                return True
        except Exception as exc:
            print(f"[feeder/status] error {type(exc).__name__}: {exc}", flush=True)
        time.sleep(20)
    return False

def download_jobs(dest):
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        kaggle_cli("datasets", "download", JOBS_DS, "-p", str(dest), "--unzip")
    except Exception as exc:
        print(f"[feeder] jobs download failed: {type(exc).__name__}: {exc}")
        return None
    found = sorted(dest.glob("**/shots.json"))
    return found[0].parent if found else None

def prepare_and_encode(entry, base_dir):
    """the cell-3 SHOTS construction + blob encode, for post-startup arrivals."""
    frame_path = base_dir / entry["frame"]
    if not frame_path.is_file():
        raise RuntimeError(f"keyframe missing: {frame_path}")
    variant = variant_for(entry)
    gears = sorted({entry.get("gear_primary", GEAR), entry.get("gear_fallback", "0.2")})
    geometries = {g: geometry_for(g, int(entry["frames"])) for g in gears}
    jid = str(entry["job_id"])
    frame_sha = hashlib.sha256(frame_path.read_bytes()).hexdigest() \
        if variant == "fun_inp" else None
    shot = {
        "num": int(entry["num"]), "job_id": jid, "seconds": entry["seconds"],
        "frames": int(entry["frames"]), "prompt": entry["prompt"],
        "frame_path": frame_path, "has_frame": variant == "fun_inp",
        "variant": variant, "dit": dit_for(variant),
        "gear_primary": entry.get("gear_primary", GEAR),
        "gear_fallback": entry.get("gear_fallback", "0.2"),
        "geometries": geometries,
        "keys": {g: conditioning_key_for(entry["prompt"], frame_sha, gm, variant)
                 for g, gm in geometries.items()},
        "seed": 42 + _zlib.crc32(jid.encode("utf-8")) % 100000,
        "blobs": {},
    }
    for g, key in shot["keys"].items():
        shot["blobs"][g] = resolve_blob(key)
    todo = [(g, k) for g, k in shot["keys"].items() if shot["blobs"].get(g) is None]
    neg_missing = resolve_blob(NEG_KEYS[variant]) is None
    if todo or neg_missing:
        if not (MODEL_STORE / "text_encoders" / TEXT_ENCODER["hf_filename"]).is_file():
            print("[worker] downloading text encoder (one-time 6.27 GiB) ...")
            fetch_verified(TEXT_ENCODER, "text_encoders")
        server = spawn_comfy(ENCODE_PORT, 0)   # encode holds no DiT
        prog("encode server boot")
        try:
            if neg_missing:
                stub = {"prompt": NEGATIVE_PROMPT, "has_frame": False,
                        "geometries": {GEAR: GEOMETRY}}
                encode_one(server["base_url"], stub, GEAR,
                           NEG_KEYS[variant], NEG_KEYS[variant])
            for g, key in todo:
                shot["blobs"][g] = CONDITIONING_STORE / f"{key}.pt"
                encode_one(server["base_url"], shot, g, key, NEG_KEYS[variant])
                prog(f"shot {shot['num']} gear {g} encoded")
        finally:
            stop_comfy_port(ENCODE_PORT)
    return shot

def render_test_stub(entry, base_dir):
    """cheap placeholder clip for test batches (no GPU work at all; silent
    832x480@16 like the real Wan output)."""
    jid = str(entry["job_id"])
    sec = int(entry["seconds"])
    dest = OUT_STORE / f"job_{jid}.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "lavfi", "-i", f"color=c=0x1f2937:s=832x480:r=16:d={sec}",
           "-vf", ("drawtext=text='TEST {jid}':fontcolor=white@0.85:"
                   "x=(w-tw)/2:y=(h-th)/2:fontsize=28"),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
           "-movflags", "+faststart",
           str(dest)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, f"ffmpeg failed for job {jid}: {r.stderr[-500:]}"
    return dest

def feeder():
    ensure_kaggle_cli()
    last_mark = ""
    stale = 0
    prog("feeder start")
    while not SHUTDOWN.is_set():
        line = jobs_line()
        if not line:
            time.sleep(WORKER_POLL_S)
            continue
        mark = line.split("|")[-1].strip() if "|" in line else line
        if mark == last_mark:
            stale += 1
            time.sleep(WORKER_POLL_S)
            continue
        wait_jobs_ready()
        base = download_jobs(WORK / "inputs_dl")
        if base is None:
            time.sleep(WORKER_POLL_S)
            continue
        manifest = json.loads((base / "shots.json").read_text(encoding="utf-8"))
        test_batch = (base / "test_mode.txt").is_file()
        fresh = [e for e in manifest if str(e.get("job_id")) not in SEEN_JOBS]
        prog(f"manifest: {len(fresh)} fresh of {len(manifest)}")
        if not fresh:
            stale += 1
            if stale >= 8:                 # snapshot never advanced; accept marker
                last_mark = mark
                stale = 0
            time.sleep(WORKER_POLL_S)
            continue
        stale = 0
        # encodes want the GPUs idle (the text encoder shares GPU 0 with a
        # resident sampling DiT, so never overlap the two)
        while (ACTIVE["n"] > 0 or not QUEUE.empty()) and not SHUTDOWN.is_set():
            time.sleep(10)
        if SHUTDOWN.is_set():
            return
        accepted = False
        for e in fresh:
            jid = str(e.get("job_id") or f"n{e.get('num')}")
            if test_batch:
                try:
                    dest = render_test_stub(e, base)
                    with state_lock:
                        state["shots"][jid] = {
                            "status": "done", "file": str(dest),
                            "bytes": dest.stat().st_size, "test_stub": True}
                        save_state()
                    SEEN_JOBS.add(jid)
                    accepted = True
                    LAST_WORK["t"] = time.time()
                    push_insurance(f"stub {jid}")
                    print(f"[feeder] test stub {jid} rendered + pushed", flush=True)
                except Exception as exc:
                    with state_lock:
                        state["shots"][jid] = {
                            "status": "failed",
                            "error": f"stub render: {type(exc).__name__}: {exc}"[:600]}
                        save_state()
                    SEEN_JOBS.add(jid)
                    push_insurance(f"stub failed {jid}")
                    print(f"[feeder] stub {jid} FAILED: {exc}", flush=True)
                continue
            remaining = SESSION_DEADLINE - time.time()
            est = estimated_shot_seconds({"frames": int(e["frames"])})
            if remaining < est + 1200:
                print(f"[feeder] job {jid} needs ~{est / 60:.0f} min, "
                      f"{remaining / 60:.0f} min left -> refused_time", flush=True)
                with state_lock:
                    state["shots"][jid] = {"status": "refused_time"}
                    save_state()
                SEEN_JOBS.add(jid)
                push_insurance(f"refused {jid}")
                continue
            try:
                shot = prepare_and_encode(e, base)
                prog(f"prep shot {e['num']} start")
            except Exception as exc:
                print(f"[feeder] prep failed for {jid}: "
                      f"{type(exc).__name__}: {exc}", flush=True)
                with state_lock:
                    state["shots"][jid] = {
                        "status": "prep_failed",
                        "error": f"{type(exc).__name__}: {exc}"[:600]}
                    save_state()
                SEEN_JOBS.add(jid)
                push_insurance(f"prep failed {jid}")
                continue
            SEEN_JOBS.add(jid)
            QUEUE.put(shot)
            prog(f"shot {e['num']} queued")
            LAST_WORK["t"] = time.time()
            accepted = True
            print(f"[feeder] queued job {jid} ({e['seconds']}s, "
                  f"{int(e['frames'])}f, {shot['variant']}) -- "
                  f"queue depth {QUEUE.qsize()}", flush=True)
        if accepted or all(str(e.get("job_id")) in SEEN_JOBS for e in fresh):
            last_mark = mark
    print("[feeder] exit", flush=True)

print(f"launching 2 workers on ports {WORKER_PORTS[0]}/{WORKER_PORTS[1]} "
      f"(deadline in {(SESSION_DEADLINE - time.time()) / 3600:.1f} h)")
threads = [threading.Thread(target=worker, args=(gpu,), daemon=True)
           for gpu in (0, 1)]
feeder_thread = threading.Thread(target=feeder, daemon=True)
for thread in threads + [feeder_thread]:
    thread.start()

# --- [studio-telemetry] heartbeat so silent phases stay observable ---------------
def _heartbeat():
    while not SHUTDOWN.is_set():
        try:
            elapsed = int(8.4 * 3600 - (SESSION_DEADLINE - time.time()))
            prog(f"heartbeat queue={QUEUE.qsize()} active={ACTIVE['n']} elapsed={elapsed}s")
        except Exception as exc:
            print(f"[tel] heartbeat error: {type(exc).__name__}: {exc}", flush=True)
            return
        time.sleep(600)
threading.Thread(target=_heartbeat, daemon=True).start()
while any(t.is_alive() for t in threads):
    time.sleep(5)
SHUTDOWN.set()
feeder_thread.join(timeout=60)
stop_comfy_port(WORKER_PORTS[0])
stop_comfy_port(WORKER_PORTS[1])
done_jobs = sorted(k for k, v in state["shots"].items() if v.get("status") == "done")
print(f"worker session finished: {len(done_jobs)} job(s) done -> {done_jobs}")
save_state()
push_insurance(f"final {len(done_jobs)} jobs")
