# Stage 2 (batch) -- model downloads (lazy) + conditioning blobs for every shot.
prog("cell3 models begin")
#
# Downloads: DiT Q4_K_M + both VAEs always (the samplers and the decode stage
# need them). The 24.5 GiB text encoder downloads ONLY when at least one
# conditioning blob is missing; the Q3_K_M fallback quant downloads only when
# the retry ladder reaches its last rung (cell 4). Kaggle scratch is finite.
#
# Blobs: for every shot the encode server (port 8190, alone on GPU 0) runs the
# LTX-2.5 conditioning graph ONCE per geometry - positive + negative
# conditioning AND the packed AV latent with the keyframe guides - and saves
# both through H3SaveConditioning. The negative prompt is static, so its blob
# is shared across all shots (one key per session).
import requests

def load_shot_manifest():
    candidates = [Path("/kaggle/input/rmc-ltx-t4x2-inputs") / "shots.json",
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
    gears = sorted({entry.get("gear_primary", GEAR), entry.get("gear_fallback", "0.2")})
    geometries = {gear: geometry_for(gear, int(entry["frames"])) for gear in gears}
    frame_sha = hashlib.sha256(frame_path.read_bytes()).hexdigest()
    SHOTS.append({
        "num": int(entry["num"]), "seconds": entry["seconds"],
        "frames": int(entry["frames"]), "prompt": entry["prompt"],
        "frame_path": frame_path,
        "gear_primary": entry.get("gear_primary", GEAR),
        "gear_fallback": entry.get("gear_fallback", "0.2"),
        "geometries": geometries,
        "keys": {gear: conditioning_key_for(entry["prompt"], frame_sha, geometry)
                 for gear, geometry in geometries.items()},
        "seed": 42 + int(entry["num"]) * 7919,
        "blobs": {},
    })
print("prepared shots: " + ", ".join(
    f"{s['num']:02d}/{s['frames']}f" for s in SHOTS))

NEED_KEY = negative_key()


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
NEG_BLOB = resolve_blob(NEED_KEY)
pending = [(shot, gear) for shot in SHOTS for gear in shot["keys"]
           if shot["blobs"].get(gear) is None]
total_blobs = sum(len(s["keys"]) for s in SHOTS)
print(f"conditioning blobs: {total_blobs - len(pending)}/{total_blobs} present, "
      f"{len(pending)} to encode; negative blob {'present' if NEG_BLOB else 'missing'}")


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
        fetched = hf_hub_download(repo_id=expected["repo"], filename=expected["hf_filename"],
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


def gguf_header_check(path):
    """Read the GGUF header: arch must be ltxv and the config KV must exist
    (without it ComfyUI builds an LTX-2.3-shaped model and shape-mismatches)."""
    import struct
    data = Path(path).open("rb").read(24 * 1024 * 1024)
    magic, ver = struct.unpack("<4sI", data[:8])
    if magic != b"GGUF":
        return {"status": "not_gguf"}
    tc, kc = struct.unpack("<QQ", data[8:24])
    off = 24
    found = {}
    sizes = {0: 1, 1: 2, 2: 2, 3: 4, 4: 4, 5: 4, 6: 1, 7: 1, 9: 8, 10: 8}

    def rs(o):
        n = struct.unpack("<Q", data[o:o + 8])[0]
        return data[o + 8:o + 8 + n].decode("utf-8", "replace"), o + 8 + n

    def rv(o, t, depth=0):
        if t == 8:
            return rs(o)
        if t == 11:
            et = struct.unpack("<I", data[o:o + 4])[0]
            cnt = struct.unpack("<Q", data[o + 4:o + 12])[0]
            o2 = o + 12
            vals = []
            for _ in range(min(cnt, 2)):
                v, o2 = rv(o2, et, depth + 1)
                vals.append(v)
            return f"arr{cnt}", o2
        if t in sizes:
            f = {0: "<b", 1: "<h", 2: "<H", 3: "<i", 4: "<I", 5: "<f",
                 6: "<B", 7: "<?", 9: "<q", 10: "<Q"}[t]
            return struct.unpack(f, data[o:o + sizes[t]])[0], o + sizes[t]
        return None, None

    for _ in range(min(kc, 80)):
        key, off = rs(off)
        t = struct.unpack("<I", data[off:off + 4])[0]
        off += 4
        v, off = rv(off, t)
        found[key] = v
        if off is None or off > len(data) - 64:
            break
    return {"status": "OK", "kvs": len(found),
            "architecture": found.get("general.architecture"),
            "config_present": "config" in found,
            "model_version": str(found.get("model_version", ""))[:16]}


models = {}
print("\nDiT Q4_K_M + both VAEs ...")
models["dit"] = fetch_verified(DIT_PRIMARY, "diffusion_models")
models["dit"]["gguf_header"] = gguf_header_check(MODEL_STORE / "diffusion_models" / DIT_PRIMARY["hf_filename"])
header = models["dit"]["gguf_header"]
if header.get("architecture") != "ltxv" or not header.get("config_present"):
    raise RuntimeError(f"DiT GGUF header check failed: {header}. Without arch=ltxv and "
                       "the config KV, ComfyUI-GGUF builds a wrong-shaped model.")
print(f"  gguf header OK: arch={header.get('architecture')!r} "
      f"config={'yes' if header.get('config_present') else 'NO'}")
models["video_vae"] = fetch_verified(VIDEO_VAE, "vae")
models["audio_vae"] = fetch_verified(AUDIO_VAE, "vae")

PROBE["stages"]["models"] = {k: {kk: vv for kk, vv in v.items() if kk != "files"}
                             for k, v in models.items()}
save()
prog("dit+vaes ready")


# --- encode every missing blob in one session, then record models -------------

def encode_graph(shot, gear, key_pos, key_neg, image_name):
    geometry = shot["geometries"][gear]
    return {
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": Path(TEXT_ENCODER["hf_filename"]).name, "type": "ltxv",
            "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": Path(VIDEO_VAE["hf_filename"]).name}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": Path(AUDIO_VAE["hf_filename"]).name}},
        "5": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "6": {"class_type": "LTXVPreprocess", "inputs": {
            "image": ["5", 0], "img_compression": IMG_COMPRESSION}},
        "7": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": geometry["width"], "height": geometry["height"],
            "length": geometry["length"], "batch_size": 1}},
        "8": {"class_type": "LTXVImgToVideoInplace", "inputs": {
            "vae": ["3", 0], "image": ["6", 0], "latent": ["7", 0],
            "strength": KEYFRAME_STRENGTH, "bypass": False}},
        "9": {"class_type": "LTXVEmptyLatentAudio", "inputs": {
            "frames_number": geometry["length"], "frame_rate": FPS,
            "batch_size": 1, "audio_vae": ["4", 0]}},
        "10": {"class_type": "LTXVConcatAVLatent", "inputs": {
            "video_latent": ["8", 0], "audio_latent": ["9", 0]}},
        "11": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": shot["prompt"]}},
        "12": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEGATIVE_PROMPT}},
        "13": {"class_type": "LTXVConditioning", "inputs": {
            "positive": ["11", 0], "negative": ["12", 0], "frame_rate": float(FPS)}},
        "40": {"class_type": "H3SaveConditioning", "inputs": {
            "conditioning": ["13", 0], "samples": ["10", 0],
            "store_dir": str(CONDITIONING_STORE), "key": key_pos}},
        "41": {"class_type": "H3SaveConditioning", "inputs": {
            "conditioning": ["13", 1], "samples": ["10", 0],
            "store_dir": str(CONDITIONING_STORE), "key": key_neg}},
    }


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
    shutil.copy2(shot["frame_path"], COMFY_DIR / "input" / image_name)
    graph = encode_graph(shot, gear, key_pos, key_neg, image_name)
    prompt_id = str(uuid.uuid4())
    response = requests.post(f"{base_url}/prompt", timeout=120, json={
        "prompt": graph, "client_id": str(uuid.uuid4()), "prompt_id": prompt_id})
    response.raise_for_status()
    if response.json().get("node_errors"):
        raise RuntimeError(f"Node errors: {response.json()['node_errors']}")
    return wait_prompt(base_url, prompt_id, f"encode {key_pos[:18]} gear {gear}", 3600)


if pending or NEG_BLOB is None:
    print(f"\nDownloading text encoder ({TEXT_ENCODER['bytes'] / GIB:.2f} GiB, one-time) ...")
    models["text_encoder"] = fetch_verified(TEXT_ENCODER, "text_encoders")
    server = start_comfy(port=8190, timeout_s=1200)
    prog("encode server boot")
    try:
        encode_info = requests.get(f"{server}/object_info", timeout=300).json()
        for node in ("CLIPLoader", "VAELoader", "LoadImage", "LTXVPreprocess",
                     "LTXVImgToVideoInplace", "EmptyLTXVLatentVideo",
                     "LTXVEmptyLatentAudio", "LTXVConcatAVLatent",
                     "LTXVConditioning", "H3SaveConditioning"):
            if node not in encode_info:
                raise RuntimeError(f"{node} is missing; cannot encode")
        done = 0
        for shot, gear in pending:
            key_pos = shot["keys"][gear]
            seconds = encode_one(server, shot, gear, key_pos, NEED_KEY)
            shot["blobs"][gear] = CONDITIONING_STORE / f"{key_pos}.pt"
            done += 1
            print(f"  [{done}/{len(pending)}] shot_{shot['num']:02d} gear {gear} "
                  f"encoded (+negative blob) in {seconds}s")
            try:
                DRIVE_CONDITIONING_STORE.mkdir(parents=True, exist_ok=True)
                for key in (key_pos, NEED_KEY):
                    source = CONDITIONING_STORE / f"{key}.pt"
                    if source.is_file():
                        shutil.copy2(source, DRIVE_CONDITIONING_STORE / source.name)
            except Exception as exc:
                print(f"  persist failed (non-fatal): {type(exc).__name__}: {exc}")
        NEG_BLOB = CONDITIONING_STORE / f"{NEED_KEY}.pt"
    finally:
        stop_comfy()
        print("encode session stopped; sampling starts from a clean process")
else:
    print("all conditioning blobs already present")
    models["text_encoder"] = {"status": "SKIPPED_BLOBS_CACHED"}

PROBE["stages"]["models"] = {k: {kk: vv for kk, vv in v.items() if kk != "files"}
                             for k, v in models.items()}
save()
prog("cell3 done (dit+vae ready, blobs encoded)")
