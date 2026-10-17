# SKILL: Медиа (ffmpeg) — аудио/видео на сервере

## Сначала всегда пробуй файл

```bash
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=nw=1 файл
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=p=0 файл
```

## Готовые рецепты (выход — только в /tmp/ws!)

```bash
# видео -> аудио mp3
ffmpeg -y -i in.mp4 -vn -b:a 192k /tmp/ws/audio.mp3

# вырезать фрагмент (без перекодирования — быстро)
ffmpeg -y -ss 00:01:00 -to 00:02:30 -i in.mp4 -c copy /tmp/ws/fraig.mp4

# сжать видео (в 3-10 раз меньше)
ffmpeg -y -i in.mp4 -c:v libx264 -crf 28 -preset fast -c:a aac -b:a 128k /tmp/ws/small.mp4

# GIF из видео (12 fps, ширина 640)
ffmpeg -y -ss 1 -t 5 -i in.mp4 -vf "fps=12,scale=640:-1:flags=lanczos" /tmp/ws/anim.gif

# превью-кадр (thumbnail)
ffmpeg -y -ss 2 -i in.mp4 -frames:v 1 -q:v 3 /tmp/ws/kadr.jpg

# склеить ролики (файл list.txt со строками file '/tmp/ws/1.mp4')
ffmpeg -y -f concat -safe 0 -i list.txt -c copy /tmp/ws/full.mp4

# нормализация громкости аудио
ffmpeg -y -i in.wav -af loudnorm -ar 44100 /tmp/ws/out.mp3

# видео из последовательности картинок (png%03d.png)
ffmpeg -y -framerate 30 -i png%03d.png -c:v libx264 -pix_fmt yuv420p /tmp/ws/video.mp4

# аудиокнига/озвучка из текста НЕ через ffmpeg — используй нейросеть? Нет:
# бесплатного TTS API нет; если попросили озвучку — сделай mp3 через espeak-ng
# (apt-get install -y espeak-ng; espeak-ng -v ru -w out.wav "текст") и предупреди в финале, что голос роботизированный.
```

## Правила

- `-y` чтобы не зависеть на вопросе; stdin закрыт.
- После каждой операции — `ffprobe` выходного файла (длительность/размер).
- CRF: 23 = качество, 28 = сильное сжатие. Превью — 28, финал — 23.
- mp4: добавляй `-pix_fmt yuv420p` (совместимость с плеерами/Telegram).
