#!/usr/bin/env python3
"""
Génère le fichier output/slideshow.mp4 à partir de toutes les images du
dossier images/ (JPG, PNG, WEBP...), avec :
 - 15s d'affichage par image (durée réglable via HOLD)
 - transition artistique (pas de fade) entre chaque image
 - bip sonore à chaque transition
 - fond rouge/noir avec effet "sous l'eau" (teinte + scintillement)
 - titre "PÉPITES DU JOUR [N]" (N = nombre d'images), placé pour ne pas
   chevaucher le logo YouTube en direct (coin haut-gauche/haut-droit)
 - barre de progression sous le titre, qui se remplit jusqu'à la dernière image
 - popups d'alerte "mauvaise nouvelle" toutes les 60s (15s d'affichage,
   cycle sur les 5 news de news/news.json), avec un bip différent

Usage:
    python3 generate_slideshow.py

Réglages tout en haut du fichier.
"""
import glob
import json
import math
import os
import subprocess
import sys

# ---------------------------------------------------------------- réglages
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES_DIR = os.path.join(ROOT, "images")
NEWS_FILE = os.path.join(ROOT, "news", "news.json")
AUDIO_DIR = os.path.join(ROOT, "audio")
OUT_DIR = os.path.join(ROOT, "output")
OUT_FILE = os.path.join(OUT_DIR, "slideshow.mp4")

HOLD = 15.0          # durée d'affichage "plein écran" par image (secondes)
TRANS = 1.2           # durée de la transition entre 2 images (secondes)
TRANSITION = "circleopen"   # transition ffmpeg xfade (jamais "fade")
# autres choix sympas: distance, pixelize, hlwind, radial, squeezeh, wipeleft

W, H = 1920, 1080
FPS = 30

TITLE_FONT_SIZE = 64
NEWS_FONT_SIZE = 42

BEEP_TRANSITION = os.path.join(AUDIO_DIR, "beep_transition.mp3")
BEEP_ALERT = os.path.join(AUDIO_DIR, "beep_alert.mp3")

POPUP_PERIOD = 60.0   # une alerte toutes les 60s
POPUP_DURATION = 15.0  # durée d'affichage du popup

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
# ---------------------------------------------------------------------------


def list_images():
    exts = ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp", "*.JPG", "*.JPEG",
            "*.PNG", "*.WEBP")
    files = []
    for e in exts:
        files.extend(glob.glob(os.path.join(IMAGES_DIR, e)))
    files = sorted(set(files))
    if not files:
        sys.exit("Aucune image trouvée dans images/. Ajoute des photos puis relance.")
    return files


def load_news():
    if not os.path.exists(NEWS_FILE):
        return ["Aucune information disponible pour le moment."]
    with open(NEWS_FILE, encoding="utf-8") as f:
        data = json.load(f)
    items = data.get("items", [])
    items = [i.get("text", "") for i in items if i.get("text")]
    return items or ["Aucune information disponible pour le moment."]


def esc(text):
    # échappe le texte pour drawtext (ffmpeg)
    return (text.replace("\\", "\\\\")
                .replace(":", "\\:")
                .replace("'", "\u2019")
                .replace(",", "\\,")
                .replace("%", "\\%"))


def wrap(text, width=48):
    words = text.split()
    lines, cur = [], ""
    for w_ in words:
        if len(cur) + len(w_) + 1 > width:
            lines.append(cur)
            cur = w_
        else:
            cur = (cur + " " + w_).strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def build():
    images = list_images()
    n = len(images)
    os.makedirs(OUT_DIR, exist_ok=True)

    clip_len = HOLD + TRANS  # chaque source est étirée un peu plus longtemps
    # que HOLD pour laisser la place à la transition qui la chevauche.

    inputs = []
    filters = []

    for idx, img in enumerate(images):
        inputs += ["-loop", "1", "-t", f"{clip_len:.3f}", "-i", img]
        # 1) fit/pad dans le cadre  2) teinte rouge/noir "sous l'eau"
        #    3) scintillement (variation de luminosité sinusoïdale)
        #    4) léger zoom lent (respiration) pour renforcer l'effet aquatique
        f = (
            f"[{idx}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps={FPS},"
            f"curves=r='0/0 0.5/0.35 1/0.9':g='0/0 0.5/0.05 1/0.25':b='0/0 0.5/0.15 1/0.55',"
            f"eq=brightness='0.04*sin(2*PI*t/3)':saturation=1.3,"
            f"zoompan=z='min(zoom+0.0006,1.08)':d={int(clip_len*FPS)}:s={W}x{H}:fps={FPS}"
            f"[v{idx}]"
        )
        filters.append(f)

    # -------- chaîne de transitions xfade (jamais "fade") --------
    prev = "v0"
    running_len = clip_len
    for idx in range(1, n):
        offset = idx * HOLD  # instant où démarre la transition idx
        out_lbl = f"x{idx}"
        filters.append(
            f"[{prev}][v{idx}]xfade=transition={TRANSITION}:duration={TRANS}:"
            f"offset={offset:.3f}[{out_lbl}]"
        )
        prev = out_lbl
        running_len = offset + clip_len

    total_len = running_len

    # -------- titre + barre de progression --------
    title = esc(f"PÉPITES DU JOUR [{n}]")
    title_filter = (
        f"drawtext=fontfile={FONT_PATH}:text='{title}':"
        f"fontsize={TITLE_FONT_SIZE}:fontcolor=white:"
        f"borderw=3:bordercolor=black:"
        f"box=1:boxcolor=black@0.45:boxborderw=18:"
        # centré horizontalement, décalé du coin haut-gauche/droit (logo YT)
        f"x=(w-text_w)/2:y=90"
    )

    bar_w = int(W * 0.5)
    bar_x = int((W - bar_w) / 2)
    bar_y = 90 + TITLE_FONT_SIZE + 30
    bar_bg = f"drawbox=x={bar_x}:y={bar_y}:w={bar_w}:h=14:color=white@0.25:t=fill"
    # largeur qui grandit avec t/total_len, remise à zéro à chaque boucle
    prog_w_expr = f"'{bar_w}*min(t/{total_len:.3f}\\,1)'"
    bar_fg = (
        f"drawbox=x={bar_x}:y={bar_y}:w={prog_w_expr}:h=14:"
        f"color=0xE10600@0.95:t=fill"
    )

    overlay_chain = f"[{prev}]{title_filter},{bar_bg},{bar_fg}[base]"
    filters.append(overlay_chain)

    # -------- popups d'alerte (toutes les 60s, 15s d'affichage, cycle 5) --------
    news_items = load_news()
    n_news = len(news_items)
    n_pops = max(1, math.floor(total_len / POPUP_PERIOD))
    last = "base"
    for p in range(n_pops):
        start = (p + 1) * POPUP_PERIOD
        end = start + POPUP_DURATION
        if start >= total_len:
            break
        text = wrap(news_items[p % n_news])
        txt = esc(text)
        lbl = f"pop{p}"
        pop = (
            f"[{last}]"
            f"drawbox=x=0:y=0:w={W}:h={H}:color=black@0.55:t=fill:"
            f"enable='between(t,{start:.2f},{end:.2f})',"
            f"drawtext=fontfile={FONT_PATH}:text='\u26A0 ALERTE FRANCE\u26A0\\n{txt}':"
            f"fontsize={NEWS_FONT_SIZE}:fontcolor=0xFF3B30:borderw=3:bordercolor=black:"
            f"box=1:boxcolor=black@0.6:boxborderw=24:line_spacing=10:"
            f"x=(w-text_w)/2:y=(h-text_h)/2:"
            f"enable='between(t,{start:.2f},{end:.2f})'"
            f"[{lbl}]"
        )
        filters.append(pop)
        last = lbl

    filters.append(f"[{last}]null[vout]")

    # -------- audio : bip de transition + bip d'alerte, mixés dans le temps --------
    audio_inputs = []
    audio_labels = []
    ai = n  # index des inputs audio après les n images
    # silence de base
    audio_inputs += ["-f", "lavfi", "-t", f"{total_len:.3f}", "-i", "anullsrc=r=44100:cl=stereo"]
    base_audio_idx = ai
    ai += 1

    delayed_labels = []
    for idx in range(1, n):
        t_ms = int(idx * HOLD * 1000)
        audio_inputs += ["-i", BEEP_TRANSITION]
        lbl = f"abeep{idx}"
        filters.append(f"[{ai}:a]adelay={t_ms}|{t_ms}[{lbl}]")
        delayed_labels.append(lbl)
        ai += 1

    for p in range(n_pops):
        start = (p + 1) * POPUP_PERIOD
        if start >= total_len:
            break
        t_ms = int(start * 1000)
        audio_inputs += ["-i", BEEP_ALERT]
        lbl = f"aalert{p}"
        filters.append(f"[{ai}:a]adelay={t_ms}|{t_ms}[{lbl}]")
        delayed_labels.append(lbl)
        ai += 1

    mix_inputs = f"[{base_audio_idx}:a]" + "".join(f"[{l}]" for l in delayed_labels)
    filters.append(
        f"{mix_inputs}amix=inputs={1+len(delayed_labels)}:normalize=0[aout]"
    )

    filter_complex = ";".join(filters)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        *audio_inputs,
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-t", f"{total_len:.3f}",
        OUT_FILE,
    ]

    print(f"[+] {n} image(s) trouvée(s), durée totale d'un cycle : {total_len:.1f}s")
    print("[+] Lancement de ffmpeg...")
    subprocess.run(cmd, check=True)
    print(f"[+] Terminé -> {OUT_FILE}")


if __name__ == "__main__":
    build()
