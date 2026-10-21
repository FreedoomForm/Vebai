**Wan 2.1 1.3B Studio persistent worker.** One long-running session that owns the whole job pipeline: a feeder that polls the jobs dataset, a conditioning-blob stage, and TWO ComfyUI samplers — one per T4 — plus the decode/QA/upload tail.

## Model: Wan 2.1 1.3B (silent text-to-video, owner request 2026-10-21 — T44)

Replaced LTX-2.5 the same day it shipped: the owner picked Alibaba's small Wan. Same studio contract (jobs dataset in, `job_<id>.mp4` out, insurance pushes, Telegram mirror, cmd/merge terminal modes), new stack — every file PUBLIC in `Comfy-Org/Wan_2.1_ComfyUI_repackaged`, vanilla ComfyUI nodes, no GGUF, no custom loaders:

| piece | file | size |
|---|---|---|
| DiT (text-to-video) | `wan2.1_t2v_1.3B_fp16.safetensors` | 2.64 GiB |
| DiT (keyframe shots) | `wan2.1_fun_inp_1.3B_bf16.safetensors` | 2.91 GiB |
| text encoder | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.27 GiB |
| VAE | `wan_2.1_vae.safetensors` | 0.24 GiB |

Honest contract changes vs LTX-2.5: the mp4 is **silent** (Wan 2.1 has no audio stream), **480P at 16 fps**, and durations ride the 81-frame native window (5 s) with 10 s on the 161-frame extrapolation. In exchange the downloads are 4x lighter, the encoder fits a T4, and both DiTs fit VRAM side by side — the retry ladder shrinks geometry instead of swapping quants.

Keyframe shots (manifest `frame_real: true`) run the Fun-InP variant through the vanilla `WanFunInpaintToVideo` node: the video starts exactly on the shipped keyframe. Shots without a real frame run pure text-to-video on the fp16 checkpoint.

## Why the conditioning blob survives the model swap

The three-stage split stays because it is proven, not because Wan needs it: the encode stage still runs ALONE on a dedicated server, encoding each shot's positive/negative conditioning (and, for Fun-InP, the encoded keyframe + mask baked into that conditioning) into small `.pt` blobs; each sampler then loads blobs and runs the official ComfyUI schedule in ONE graph: KSampler 30 steps uni_pc/simple cfg 6 over ModelSamplingSD3 shift 8, then tiled VAE decode and a silent MP4 through CreateVideo + SaveVideo — no separate decode process, no audio VAE.

The frame grid changes with the model: Wan wants `frames % 4 == 1` at 16 fps (LTX wanted `n % 8 == 1` at 25). The server ships 5 s -> 81 frames, 10 s -> 161 frames; gears 0.4/0.3/0.2 map to 832x480 / 704x400 / 480x272.
