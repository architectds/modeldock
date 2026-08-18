# ADAPT: edit the CONFIG section (FF, BASE, inputs, narration JSON) before use.
# Build the ModelDock promo film:
#   - 5 inputs: s1/s2/s5 scene PNGs (3840x2160), dashboard-4k PNG, picker-trim.mp4
#   - Ken Burns zoompan on stills + xfade crossfades
#   - narration WAVs delayed to shot starts, mixed
#   - burned-in Chinese subtitles (ASS, Microsoft YaHei)
#   - output: ModelDock-Promo-FINAL.mp4 (1920x1080@25, ~50.3s)
#
# Run from the modeldock dir:  python build_modeldock_film.py

import json, math, os, subprocess

FF = os.environ.get("FFMPEG_PATH") or "ffmpeg"
BASE = os.environ.get("MODELDOCK_FILM_DIR") or os.getcwd()
SHOTS = os.path.join(BASE, "shots")
ASSETS = os.path.join(BASE, "assets")
AUDIO = os.path.join(ASSETS, "audio")
OUT_ZH = os.path.join(BASE, "ModelDock-Promo-FINAL.mp4")

import argparse
_ap = argparse.ArgumentParser()
_ap.add_argument("--lang", choices=["zh", "en"], default="zh")
_args = _ap.parse_args()
EN = _args.lang == "en"

NARR = "narration-en.json" if EN else "narration.json"
AUDIO_DIR = os.path.join(ASSETS, "audio", "en") if EN else AUDIO
S1_CLIP = "s1p2-en-clip.mp4" if EN else "s1p2-clip.mp4"
_SHOTS_EN = os.path.join(BASE, "shots-en")
S2_PNG = os.path.join(_SHOTS_EN if EN else SHOTS, "s2.png")
S5_PNG = os.path.join(_SHOTS_EN if EN else SHOTS, "s5.png")
SUB_PATH = "subs-en.ass" if EN else "subs.ass"
FILTER_PATH = "filter-en.txt" if EN else "filter.txt"
OUT = os.path.join(BASE, "ModelDock-Promo-EN.mp4" if EN else "ModelDock-Promo-FINAL.mp4")

FADE = 1.0
# Breathing room after each narration line before the next shot starts.
PAD = 1.5
# Narration-free endcard time at the very end. The final xfade consumes FADE
# seconds from the last shot, so add FADE on top of the desired 2.2s tail.
TAIL = 3.0
FPS = 25

narration = json.load(open(os.path.join(BASE, NARR), encoding="utf-8"))
durs = [n["dur"] for n in narration]
texts = [n["text"] for n in narration]
N = len(durs)

L = [d + PAD for d in durs]
L[-1] = durs[-1] + TAIL
T = [0.0]
for d in L[:-1]:
    T.append(T[-1] + d - FADE)
total = T[-1] + L[-1] - FADE
print("shot starts", [round(t, 3) for t in T])
print("total", round(total, 3))


def ass_ts(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return "%d:%02d:%05.2f" % (h, m, s)


# ---- ASS subtitles (PlayRes 1920x1080 so Fontsize is true pixels) ----
ass_lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Microsoft YaHei,44,&H00FFFFFF,&H000000FF,&H00101020,&H96000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,64,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]
for i in range(N):
    start = T[i]
    end = T[i] + durs[i]
    ass_lines.append("Dialogue: 0,%s,%s,Default,,0,0,0,,%s" % (ass_ts(start), ass_ts(end), texts[i]))
ass_path = os.path.join(BASE, SUB_PATH)
open(ass_path, "w", encoding="utf-8").write("\n".join(ass_lines))
print("ass written", ass_path)

# ---- audio: delay each narration to its shot start, mix ----
audio_inputs = [os.path.join(AUDIO_DIR, "seg0%d.wav" % (i + 1)) for i in range(N)]
afc = []
mix_in = []
for i in range(N):
    delay = int(round(T[i] * 1000))
    afc.append("[%d:a]adelay=%d:all=1[a%d]" % (5 + i, delay, i))
    mix_in.append("[a%d]" % i)
afc.append("%samix=inputs=%d:normalize=0,aresample=48000[aout]" % ("".join(mix_in), N))

# ---- video: zoompan + xfade ----
# still inputs 0,1,2,4 zoom; input 3 is the picker video (crop to 16:9, keep top)
zoom_exprs = [
    ("min(1.0+0.0005*on,1.14)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),          # S1 cover zoom-in
    ("max(1.14-0.0005*on,1.0)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),          # S2 hub zoom-out
    ("min(1.0+0.0005*on,1.12)", "iw/2-(iw/zoom/2)", "ih*0.61-(ih/zoom*0.61)"),    # S3 dashboard toward cards
    (None, None, None),                                                            # S4 picker video
    ("min(1.0+0.0003*on,1.06)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),          # S5 endcard gentle
]

stills = [
    os.path.join(ASSETS, S1_CLIP),
    S2_PNG,
    os.path.join(ASSETS, "dashboard-4k.png"),
    os.path.join(ASSETS, "s4-clip.mp4"),
    S5_PNG,
]

parts = []
for i in range(N):
    d = L[i]
    frames = max(1, round(d * FPS))
    if i == 0:
        chain = ("[0:v]scale=1920:1080:flags=lanczos,fps=%d,"
                 "trim=duration=%.6f,setpts=PTS-STARTPTS,format=yuv420p" % (FPS, d))
    elif i == 3:
        chain = ("[%d:v]scale=1920:1080:flags=lanczos,fps=%d,"
                 "trim=duration=%.6f,setpts=PTS-STARTPTS,format=yuv420p" % (i, FPS, d))
    else:
        z, x, y = zoom_exprs[i]
        chain = ("[%d:v]zoompan=z='%s':x='%s':y='%s':d=%d:s=1920x1080:fps=%d,"
                 "trim=duration=%.6f,setpts=PTS-STARTPTS,format=yuv420p"
                 % (i, z, x, y, frames, FPS, d))
    parts.append("%s[v%d]" % (chain, i))

xp = []
prev = "v0"
for i in range(1, N):
    out = "x%d" % i
    off = T[i] - FADE
    xp.append("[%s][v%d]xfade=transition=fade:duration=%.3f:offset=%.3f[%s]" % (prev, i, FADE, off, out))
    prev = out
fc = (";".join(parts) + ";" + ";".join(xp) + ";[%s]ass=%s,format=yuv420p[vout]" % (prev, SUB_PATH)
      + ";" + ";".join(afc))

fc_path = os.path.join(BASE, FILTER_PATH)
open(fc_path, "w", encoding="utf-8").write(fc)
print("filtergraph written, len", len(fc))

cmd = [FF]
for img in stills:
    cmd += ["-i", img]
for wav in audio_inputs:
    cmd += ["-i", wav]
cmd += ["-filter_complex_script", fc_path,
        "-map", "[vout]", "-map", "[aout]",
        "-t", str(round(total, 3)),
        "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
        "-y", OUT]
print("running final build...")
r = subprocess.run(cmd, capture_output=True, text=True, cwd=BASE)
print("rc", r.returncode)
if r.returncode != 0:
    print(r.stderr[-3500:])
    raise SystemExit(1)
print("DONE", OUT, round(total, 3), "s")
