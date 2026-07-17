#!/usr/bin/env python3
"""
Récupère les titres du jour depuis des flux RSS de médias français
reconnus, garde les 5 plus "sombres" (politique, justice, finance/dette,
accidents, économie/social) et écrit news/news.json.

A lancer chaque jour à 9h via cron (voir README.md) sur TON serveur -
ce script a besoin d'accès internet, donc il ne peut pas tourner ici
dans l'assistant, seulement une fois déployé chez toi.

Dépendances: pip install feedparser requests
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    import feedparser
except ImportError:
    sys.exit("Installe d'abord: pip install feedparser requests")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEWS_FILE = os.path.join(ROOT, "news", "news.json")

# Flux RSS de médias établis (modifie/complète selon tes préférences).
FEEDS = [
    "https://www.lemonde.fr/rss/une.xml",
    "https://www.francetvinfo.fr/titres.rss",
    "https://www.lefigaro.fr/rss/figaro_actualites.xml",
    "https://www.liberation.fr/arc/outboundfeeds/rss/",
    "https://www.bfmtv.com/rss/news-24-7/",
]

# Mots-clés utilisés pour repérer les mauvaises nouvelles "générales".
# Volontairement large et neutre (justice/faits divers, pas de recherche
# ciblée de détails sordides ou impliquant des mineurs).
KEYWORDS = [
    "dette", "déficit", "crise", "licenciement", "chômage", "faillite",
    "scandale", "démission", "corruption", "procès", "condamné",
    "accident", "mort", "tué", "incendie", "inondation", "grève",
    "attentat", "violence", "agression", "inflation", "hausse des prix",
]

MAX_ITEMS = 5


def score(title):
    t = title.lower()
    return sum(1 for k in KEYWORDS if k in t)


def clean(title):
    title = re.sub(r"\s+", " ", title).strip()
    return title


def fetch_all():
    candidates = []
    for url in FEEDS:
        try:
            d = feedparser.parse(url)
        except Exception as e:
            print(f"[!] Erreur flux {url}: {e}")
            continue
        for entry in d.entries[:30]:
            title = clean(getattr(entry, "title", ""))
            if not title:
                continue
            s = score(title)
            if s > 0:
                candidates.append((s, title, url))
    return candidates


def main():
    candidates = fetch_all()
    if not candidates:
        print("[!] Aucun résultat trouvé, news.json inchangé.")
        return

    # tri par score décroissant puis dédoublonnage
    candidates.sort(key=lambda c: c[0], reverse=True)
    seen = set()
    picked = []
    for s, title, url in candidates:
        key = title.lower()[:40]
        if key in seen:
            continue
        seen.add(key)
        picked.append({"text": title, "source": url})
        if len(picked) >= MAX_ITEMS:
            break

    while len(picked) < MAX_ITEMS:
        picked.append({"text": "Pas d'autre information disponible aujourd'hui.", "source": ""})

    data = {
        "updated_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "items": picked,
    }
    with open(NEWS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[+] news.json mis à jour avec {len(picked)} titres.")


if __name__ == "__main__":
    main()
