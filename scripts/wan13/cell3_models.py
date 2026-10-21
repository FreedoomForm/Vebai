# Stage 2 (batch) -- model downloads + conditioning blobs for every shot.
prog("cell3 models begin")
#
# Downloads: both DiTs + the VAE always (9.4 GiB total - the whole stack fits
# where the LTX encoder alone did not). The 6.27 GiB text encoder downloads
# ONLY when at least one conditioning blob is missing.
#
# Blobs: for every shot the encode server (port 8190, alone on GPU 0) runs the
# Wan conditioning graph ONCE per geometry - positive + negative conditioning,
# and for keyframe shots the Fun-InP latent (zeros + encoded start image baked
# into the conditioning) - and saves both through H3SaveConditioning. The
# negative prompt is static, so its blob is shared across all shots of a
# variant (one key per session and variant).
import requests

def load_shot_manifest():
    candidates = [Path("/kaggle/input/rmc-studio-jobs") / "shots.json",
                  Path("/kaggle/input/rmc-ltx-t4x2-inputs") / "shots.json",
                  Path("/kaggle/input/rmc-h3-t4x2-inputs") / "shots.json",
                  WORK / "inputs" / "shots.json"]
    try:
        candidates += sorted(Path("/kaggle/input").glob("**/shots.json"))
    except Exception:
        pass
    for candidate in candidates:
        if candidate.is_file():
            shots = json.loads(candidate.read_text(encoding="utf-8"))
            print(f"shot manifest: {candidate} ({len(shots)} shots)")
            return shots, candidate.parent
    listed = sorted(str(p) for p in Path("/kaggle/input").glob("*")) \
        if Path("/kaggle/input").is_dir() else []
    raise RuntimeError("shots.json not found; attach the jobs dataset "
                       f"(/kaggle/input contains: {listed})")


def geometry_for(gear, frames):
    width, height = GEAR_TABLE[gear]
    return {"width": width, "height": height, "length": frames}


def variant_for(entry):
    """fun_inp when the server shipped a REAL user keyframe (frame_real) - the
    video then starts exactly on it. Neutral canvases and manifests from
    servers older than T44 fall back to pure text-to-video."""
    return "fun_inp" if entry.get("frame_real") else "t2v"


def dit_for(variant):
    return DIT_FUN_INP if variant == "fun_inp" else DIT_T2V


# [studio-worker] the feeder owns ALL job intake (single dedup point via
# done_ids.json + SEEN_JOBS); this cell only prepares the FIRST batch.
MANIFEST, SHOT_BASE = [], (WORK / "inputs")
SHOTS = []
for entry in MANIFEST:
    if entry.get("mode") in ("cmd", "merge"):
        continue  # handled by the feeder's handle_special path
    frame_path = SHOT_BASE / entry["frame"]
    if not frame_path.is_file():
        raise RuntimeError(f"keyframe missing: {frame_path}")
    variant = variant_for(entry)
    gears = sorted({entry.get("gear_primary", GEAR), entry.get("gear_fallback", "0.2")})
    geometries = {gear: geometry_for(gear, int(entry["frames"])) for gear in gears}
    frame_sha = hashlib.sha256(frame_path.read_bytes()).hexdigest() if variant == "fun_inp" else None
    SHOTS.append({
        "num": int(entry["num"]), "seconds": entry["seconds"],
        "frames": int(entry["frames"]), "prompt": entry["prompt"],
        "frame_path": frame_path, "has_frame": variant == "fun_inp",
        "variant": variant, "dit": dit_for(variant),
        "gear_primary": entry.get("gear_primary", GEAR),
        "gear_fallback": entry.get("gear_fallback", "0.2"),
        "geometries": geometries,
        "keys": {gear: conditioning_key_for(entry["prompt"], frame_sha, geometry, variant)
                 for gear, geometry in geometries.items()},
        "seed": 42 + int(entry["num"]) * 7919,
        "blobs": {},
    })
print("prepared shots: " + ", ".join(
    f"{s['num']:02d}/{s['frames']}f/{s['variant']}" for s in SHOTS))

NEG_KEYS = {variant: negative_key(variant) for variant in
            sorted({shot["variant"] for shot in SHOTS} | {"t2v", "fun_inp"})}


def find_blob_anywhere(key):
    try:
        return next(iter(Path("/kaggle/input").glob(f"**/{key}.pt")), None)
    except Exception:
        return None


def resolve_blob(key):
    resolved = next((p for p in (
        CONDITIONING_STORE / f"{key}.pt",
        DRIVE_CONDITIONING_STORE / f"{key}.pt") if p.is_file()), None)
    if resolved is None:
        remote = find_blob_anywhere(key)
        if remote is not None:
            CONDITIONING_STORE.mkdir(parents=True, exist_ok=True)
            shutil.copy2(remote, CONDITIONING_STORE / f"{key}.pt")
            resolved = CONDITIONING_STORE / f"{key}.pt"
    if resolved is not None and resolved.parent != CONDITIONING_STORE:
        shutil.copy2(resolved, CONDITIONING_STORE / resolved.name)
        resolved = CONDITIONING_STORE / resolved.name
    return resolved


for shot in SHOTS:
    for gear, key in shot["keys"].items():
        shot["blobs"][gear] = resolve_blob(key)
pending = [(shot, gear) for shot in SHOTS for gear in shot["keys"]
           if shot["blobs"].get(gear) is None]
neg_pending = [v for v, k in NEG_KEYS.items() if resolve_blob(k) is None]
total_blobs = sum(len(s["keys"]) for s in SHOTS)
print(f"conditioning blobs: {total_blobs - len(pending)}/{total_blobs} present, "
      f"{len(pending)} to encode; negative blobs missing: {neg_pending or 'none'}")


# --- shared fetch helper (verbatim semantics from the H3 stage) ---------------
def fetch_verified(expected, subdir):
    """Download one HF file into MODEL_STORE/<subdir>/ with size+sha256 gates."""
    from huggingface_hub import hf_hub_download
    relative_name = f"{subdir}/{expected['hf_filename']}"
    destination = MODEL_STORE / relative_name
    destination.parent.mkdir(parents=True, exist_ok=True)
    record = {"repo": expected["repo"], "file": expected["hf_filename"],
              "expected_bytes": expected["bytes"],
              "expected_gib": round(expected["bytes"] / GIB, 3)}
    if destination.is_file() and destination.stat().st_size == expected["bytes"]:
        record["source"] = "already_on_disk"
        print(f"  reusing {relative_name} ({expected['bytes'] / GIB:.2f} GiB)")
    else:
        free_gib = shutil.disk_usage(str(CONTENT)).free / GIB
        if free_gib < expected["bytes"] / GIB + 3:
            raise RuntimeError(f"Only {free_gib:.1f} GiB free; need "
                               f"{expected['bytes'] / GIB + 3:.1f} GiB for {relative_name}.")
        print(f"  downloading {relative_name} ({expected['bytes'] / GIB:.2f} GiB) ...")
        started = time.perf_counter()
        fetched = hf_hub_download(repo_id=expected["repo"], filename=expected["file"],
                                  local_dir=str(MODEL_STORE / "_hf"), token=False)
        shutil.move(fetched, destination)
        record["source"] = "huggingface"
        record["download_s"] = round(time.perf_counter() - started, 1)
        record["download_mib_per_s"] = round(
            expected["bytes"] / (1024 ** 2) / max(record["download_s"], 1e-6), 1)
        print(f"    {record['download_s']}s ({record['download_mib_per_s']} MiB/s)")
    if destination.stat().st_size != expected["bytes"]:
        raise RuntimeError(
            f"{relative_name} is {destination.stat().st_size} bytes, expected "
            f"{expected['bytes']}. A truncated download surfaces later as a "
            "misleading shape error, so stop here.")
    print("  verifying SHA-256 ...")
    started = time.perf_counter()
    record["sha256"] = sha256_file(destination)
    record["sha256_matches"] = record["sha256"] == expected["sha256"]
    record["verify_s"] = round(time.perf_counter() - started, 1)
    if not record["sha256_matches"]:
        raise RuntimeError(f"{relative_name} SHA-256 mismatch; refusing to continue.")
    print(f"  verified in {record['verify_s']}s")
    link = COMFY_DIR / "models" / relative_name
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if link.resolve() != destination.resolve():
            link.unlink()
            link.symlink_to(destination)
    elif link.exists():
        raise RuntimeError(f"Refusing to replace a non-symlink model path: {link}")
    else:
        link.symlink_to(destination)
    record["linked_at"] = str(link)
    return record


models = {}
print("\nDiT t2v + DiT fun_inp + VAE ...")
models["dit_t2v"] = fetch_verified(DIT_T2V, "diffusion_models")
models["dit_fun_inp"] = fetch_verified(DIT_FUN_INP, "diffusion_models")
models["vae"] = fetch_verified(VIDEO_VAE, "vae")

PROBE["stages"]["models"] = {k: {kk: vv for kk, vv in v.items() if kk != "files"}
                             for k, v in models.items()}
save()
prog("dits+vae ready")


# --- encode every missing blob in one session, then record models -------------

def encode_graph(shot, gear, key_pos, key_neg, image_name):
    """Two branches, both saving (conditioning, latent) blob pairs.

    t2v:     CLIPTextEncode pos/neg + EmptyHunyuanLatentVideo zeros.
    fun_inp: the same text conditioning runs through WanFunInpaintToVideo with
             the start image - it returns (positive, negative, latent) where
             the conditioning now carries the encoded keyframe and the mask
             that pins frame 0 to it.
    """
    geometry = shot["geometries"][gear]
    graph = {
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": Path(TEXT_ENCODER["hf_filename"]).name, "type": "wan",
            "device": "default"}},
        "11": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": shot["prompt"]}},
        "12": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEGATIVE_PROMPT}},
    }
    if shot.get("has_frame"):
        graph.update({
            "3": {"class_type": "VAELoader", "inputs": {
                "vae_name": Path(VIDEO_VAE["hf_filename"]).name}},
            "5": {"class_type": "LoadImage", "inputs": {"image": image_name}},
            "6": {"class_type": "WanFunInpaintToVideo", "inputs": {
                "positive": ["11", 0], "negative": ["12", 0], "vae": ["3", 0],
                "width": geometry["width"], "height": geometry["height"],
                "length": geometry["length"], "batch_size": 1,
                "start_image": ["5", 0]}},
            "40": {"class_type": "H3SaveConditioning", "inputs": {
                "conditioning": ["6", 0], "samples": ["6", 2],
                "store_dir": str(CONDITIONING_STORE), "key": key_pos}},
            "41": {"class_type": "H3SaveConditioning", "inputs": {
                "conditioning": ["6", 1], "samples": ["6", 2],
                "store_dir": str(CONDITIONING_STORE), "key": key_neg}},
        })
    else:
        graph.update({
            "7": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {
                "width": geometry["width"], "height": geometry["height"],
                "length": geometry["length"], "batch_size": 1}},
            "40": {"class_type": "H3SaveConditioning", "inputs": {
                "conditioning": ["11", 0], "samples": ["7", 0],
                "store_dir": str(CONDITIONING_STORE), "key": key_pos}},
            "41": {"class_type": "H3SaveConditioning", "inputs": {
                "conditioning": ["12", 0], "samples": ["7", 0],
                "store_dir": str(CONDITIONING_STORE), "key": key_neg}},
        })
    return graph


def wait_prompt(base_url, prompt_id, what, timeout_s):
    started = time.perf_counter()
    while time.perf_counter() - started < timeout_s:
        if COMFY_PROCESS is not None and COMFY_PROCESS.poll() is not None:
            raise RuntimeError(f"ComfyUI exited during {what} (check for an OOM kill)")
        try:
            history = requests.get(f"{base_url}/history/{prompt_id}", timeout=60).json()
            if prompt_id in history:
                status = history[prompt_id].get("status", {})
                if status.get("completed") is True or status.get("status_str") == "error":
                    if status.get("status_str") != "success":
                        raise RuntimeError(f"{what} failed: {status}")
                    return round(time.perf_counter() - started, 1)
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(3)
    raise TimeoutError(f"{what} did not finish in {timeout_s}s")


def encode_one(base_url, shot, gear, key_pos, key_neg):
    image_name = f"cond_{key_pos}.jpg"
    (COMFY_DIR / "input").mkdir(parents=True, exist_ok=True)
    if shot.get("has_frame"):
        shutil.copy2(shot["frame_path"], COMFY_DIR / "input" / image_name)
    graph = encode_graph(shot, gear, key_pos, key_neg, image_name)
    prompt_id = str(uuid.uuid4())
    response = requests.post(f"{base_url}/prompt", timeout=120, json={
        "prompt": graph, "client_id": str(uuid.uuid4()), "prompt_id": prompt_id})
    response.raise_for_status()
    if response.json().get("node_errors"):
        raise RuntimeError(f"Node errors: {response.json()['node_errors']}")
    return wait_prompt(base_url, prompt_id, f"encode {key_pos[:18]} gear {gear}", 3600)


if pending or neg_pending:
    print(f"\nDownloading text encoder ({TEXT_ENCODER['bytes'] / GIB:.2f} GiB, one-time) ...")
    models["text_encoder"] = fetch_verified(TEXT_ENCODER, "text_encoders")
    server = start_comfy(port=8190, timeout_s=1200)
    prog("encode server boot")
    try:
        encode_info = requests.get(f"{server}/object_info", timeout=300).json()
        for node in ("CLIPLoader", "CLIPTextEncode", "VAELoader", "LoadImage",
                     "WanFunInpaintToVideo", "EmptyHunyuanLatentVideo",
                     "H3SaveConditioning"):
            if node not in encode_info:
                raise RuntimeError(f"{node} is missing; cannot encode")
        # negative blobs first (shared across shots of the variant), then shots
        plan = []
        for variant in neg_pending:
            plan.append(("negative", variant, NEG_KEYS[variant]))
        for shot, gear in pending:
            plan.append(("shot", shot, gear))
        done = 0
        for kind, obj, arg in plan:
            if kind == "negative":
                variant, key = obj, arg
                stub = {"prompt": NEGATIVE_PROMPT, "has_frame": False,
                        "geometries": {GEAR: GEOMETRY}}
                seconds = encode_one(server, stub, GEAR, key, key)
                CONDITIONING_STORE.mkdir(parents=True, exist_ok=True)
                if not (CONDITIONING_STORE / f"{key}.pt").is_file():
                    raise RuntimeError(f"negative blob {key} was not saved")
                neg_pending = [v for v in neg_pending if v != variant]
                print(f"  negative blob for {variant} saved in {seconds}s")
            else:
                shot, gear = obj, arg
                key_pos = shot["keys"][gear]
                neg = NEG_KEYS[shot["variant"]]
                seconds = encode_one(server, shot, gear, key_pos, neg)
                shot["blobs"][gear] = CONDITIONING_STORE / f"{key_pos}.pt"
                print(f"  [{sum(1 for k, o, a in plan[:done] if k == 'shot') + 1}"
                      f"/{len(pending)}] shot_{shot['num']:02d} gear {gear} "
                      f"({shot['variant']}) encoded in {seconds}s")
            done += 1
            try:
                DRIVE_CONDITIONING_STORE.mkdir(parents=True, exist_ok=True)
                saved_keys = [NEG_KEYS[v] for v in NEG_KEYS
                              if (CONDITIONING_STORE / f"{NEG_KEYS[v]}.pt").is_file()] \
                    + [s["keys"][g] for s in SHOTS for g in s["keys"]
                       if (CONDITIONING_STORE / f"{s['keys'][g]}.pt").is_file()]
                for key in set(saved_keys):
                    source = CONDITIONING_STORE / f"{key}.pt"
                    if source.is_file():
                        shutil.copy2(source, DRIVE_CONDITIONING_STORE / source.name)
            except Exception as exc:
                print(f"  persist failed (non-fatal): {type(exc).__name__}: {exc}")
    finally:
        stop_comfy()
        print("encode session stopped; sampling starts from a clean process")
else:
    print("all conditioning blobs already present")
    models["text_encoder"] = {"status": "SKIPPED_BLOBS_CACHED"}

PROBE["stages"]["models"] = {k: {kk: vv for kk, vv in v.items() if kk != "files"}
                             for k, v in models.items()}
save()
prog("cell3 done (dits+vae ready, blobs encoded)")
