**LTX-2.5 Studio persistent worker.** One long-running session that owns the whole job pipeline: a feeder that polls the jobs dataset, a conditioning-blob stage, and TWO ComfyUI samplers — one per T4 — plus the decode/QA/upload tail.

## Model: Lightricks LTX-2.5 (22B distilled, video + synchronized audio)

Replaced MiniMax H3 on 2026-10-20 (T43). Same studio contract (jobs dataset in, `job_<id>.mp4` out, insurance pushes, Telegram mirror, cmd/merge terminal modes), new stack:

| piece | file (all PUBLIC, `unsloth/LTX-2.5-GGUF`) | size |
|---|---|---|
| DiT (primary) | `distilled/ltx-2.5-22b-distilled-Q4_K_M.gguf` | 13.0 GiB |
| DiT (retry rung) | `distilled/ltx-2.5-22b-distilled-Q3_K_M.gguf` | 10.5 GiB |
| text encoder | `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors` | 24.5 GiB |
| video VAE | `vae/ltx-2.5-video-vae-conv-bf16.safetensors` | 1.4 GiB |
| audio VAE | `vae/ltx-2.5-audio-vae-bf16.safetensors` | 0.34 GiB |

The GGUF files carry the full transformer config as a header KV (`config`), so the stock `UnetLoaderGGUF` builds the right LTX-2.5 shape (verified in the file headers; the H3-era loader patch is gone — `ltxv` is already in ComfyUI-GGUF's allowlist).

## Why the conditioning blob survives the model swap

The three-stage split was designed for RAM, not for H3 specifics: 31.3 GiB of host RAM cannot hold the 24.5 GiB text encoder and two resident samplers at once. So the encode stage still runs ALONE on a dedicated server, encoding each shot's positive/negative conditioning AND the packed audio-video latent (with the keyframe guides baked in) into small `.pt` blobs; the samplers then load blobs, run the distilled 8-step schedule (euler_ancestral, DualCFG 1/1) on the GGUF DiT, and a fresh decode process splits the AV latent, decodes video (tiled) + audio, and muxes one MP4.

The frame grid changes with the model: LTX wants `frames % 8 == 1` at 25 fps (H3 wanted `n % 17 == 5` at 24). The server ships 5 s -> 129 frames, 10 s -> 249 frames. Tokens per clip are ~10x lighter than H3 (32x32x8 pixel packing), so gear 0.4 (864x480) fits comfortably in one T4's fp16.
