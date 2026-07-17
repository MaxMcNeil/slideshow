# Pépites du jour — slideshow live YouTube

Génère un diaporama vidéo à partir de tes photos (nombre et dimensions
variables) avec transitions artistiques, bips, thème rouge/noir "sous
l'eau", titre dynamique, barre de progression, et popups d'alerte
"mauvaises nouvelles du jour" qui se mettent à jour automatiquement.

## ⚠️ À savoir avant de commencer (important)

- **GitHub ne fait pas tourner de live 24/7.** Ce dépôt contient le code,
  mais la diffusion en boucle infinie vers YouTube doit tourner sur un
  serveur/VPS à toi (une petite VM Linux à quelques euros/mois suffit),
  pas sur GitHub Actions (limité en durée, pas fait pour un process
  permanent).
- **Le script `fetch_news.py` a besoin d'internet** pour aller chercher
  les titres — il doit donc tourner sur ce même serveur, pas ici.
- J'ai volontairement gardé les mots-clés de sélection des "mauvaises
  nouvelles" assez généraux (dette, chômage, scandale, accident,
  violence, procès...) plutôt que de cibler spécifiquement des
  catégories sensibles (ex. affaires impliquant des mineurs). Si tu
  affiches ce type d'info en direct, pense à éviter tout élément
  identifiant une victime ou un mineur, et à rester sur des faits
  confirmés par des médias établis (présomption d'innocence, risques de
  diffamation).

## Structure

```
slideshow/
  images/                 <- dépose ici tes photos (jpg, png, webp, peu importe la taille)
  news/news.json          <- les 5 "mauvaises nouvelles" du jour (généré ou modifiable à la main)
  audio/beep_transition.mp3  audio/beep_alert.mp3  <- fournis, remplaçables
  scripts/generate_slideshow.py   <- construit output/slideshow.mp4
  scripts/fetch_news.py           <- met à jour news.json (à lancer sur ton serveur)
  scripts/stream_to_youtube.sh    <- diffuse la vidéo en boucle vers YouTube
  scripts/slideshow-stream.service.example  <- service systemd (redémarrage auto)
  scripts/crontab.example                    <- automatisation 9h/jour
```

## Ce que fait `generate_slideshow.py`

- Lit **toutes** les images de `images/` (n'importe quel format/format
  de dimension), les recadre proprement en 1920×1080.
- Applique une teinte rouge/noir + un scintillement (variation de
  luminosité sinusoïdale) + un léger zoom lent : effet "vu à travers
  l'eau".
- 15 secondes d'affichage par image, transition `circleopen` (pas de
  fade) entre chaque image, avec un bip à chaque transition.
- Titre **"PÉPITES DU JOUR [N]"** (N = nombre d'images détecté
  automatiquement), centré en haut avec une marge de 90px pour ne pas
  chevaucher le logo YouTube (coins haut-gauche/haut-droit).
- Barre de progression rouge sous le titre qui se remplit jusqu'à la
  dernière image du cycle.
- Toutes les 60 secondes (temps du fichier), un popup semi-transparent
  affiche une des 5 news de `news.json` pendant 15 secondes, avec un
  bip différent, en boucle sur les 5.
- Exporte `output/slideshow.mp4`. **La boucle infinie** se fait au
  moment de la diffusion (`-stream_loop -1`), pas dans le fichier
  lui-même — donc le popup "minute 1, 2, 3..." se répète à chaque tour
  du fichier, pas selon l'horloge murale réelle.

Réglages modifiables en haut du fichier : `HOLD` (durée par image),
`TRANS` (durée transition), `TRANSITION` (nom du filtre xfade —
`circleopen`, `pixelize`, `distance`, `hlwind`, `radial`... la liste
complète est dans la doc ffmpeg `xfade`), résolution, tailles de
police, etc.

## Installation (sur ton serveur)

```bash
sudo apt install ffmpeg
pip install -r requirements.txt
```

1. Mets tes photos dans `images/`.
2. (Optionnel) édite `news/news.json` à la main, ou lance
   `python3 scripts/fetch_news.py` pour le remplir automatiquement.
3. Génère la vidéo :
   ```bash
   python3 scripts/generate_slideshow.py
   ```
4. Teste-la en local avant de streamer :
   ```bash
   ffplay output/slideshow.mp4
   ```
5. Récupère ta clé de stream sur YouTube Studio > Créer un direct >
   Diffuser en direct via un logiciel, puis lance :
   ```bash
   chmod +x scripts/stream_to_youtube.sh
   ./scripts/stream_to_youtube.sh rtmp://a.rtmp.youtube.com/live2 TA_CLE_STREAM
   ```

## Automatisation complète (mise à jour tous les jours à 9h)

1. Copie `scripts/slideshow-stream.service.example` vers
   `/etc/systemd/system/slideshow-stream.service`, adapte les chemins
   et la clé de stream, puis :
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now slideshow-stream.service
   ```
2. Installe le cron d'exemple (`scripts/crontab.example`) avec
   `crontab -e` — il relance `fetch_news.py`, régénère la vidéo, puis
   redémarre le service systemd chaque jour à 9h. Adapte le fuseau
   horaire de ton serveur si besoin (`timedatectl set-timezone
   Europe/Paris`).

## Limites connues

- `fetch_news.py` utilise des flux RSS publics de médias français ; la
  liste peut être complétée dans le script. Aucune garantie que 5
  résultats "négatifs" soient toujours trouvés — dans ce cas des
  messages par défaut s'affichent.
- Le redémarrage quotidien du stream coupe le direct une poignée de
  secondes (le temps de relancer ffmpeg) — c'est le compromis le plus
  simple pour un contenu qui change chaque jour.
