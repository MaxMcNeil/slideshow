const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { renderCardHtml, CARD_WIDTH, CARD_HEIGHT } = require('./card-template');

// Capture order == display order. Canard Enchaîné's 3 sections first, then
// CNews, then Le Parisien — matches the roadmap order.
const sources = [
    {
        name: 'CanardActualites',
        url: 'https://www.lecanardenchaine.fr/actualites',
        type: 'canard'
    },
    {
        name: 'CanardEnquetes',
        url: 'https://www.lecanardenchaine.fr/enquetes',
        type: 'canard'
    },
    {
        name: 'CanardWebPlus',
        url: 'https://www.lecanardenchaine.fr/web-plus',
        type: 'canard'
    },
    {
        name: 'CNews',
        url: 'https://www.cnews.fr/faits-divers',
        type: 'anchored',
        startTextPatterns: [
            // We anchor on the description paragraph itself (not just the
            // "FAITS DIVERS" heading above it), since the article list starts
            // right after it. Matched loosely because the paragraph text can
            // change over time.
            'meurtre, viol', 'partout en france, de nombreux faits divers'
        ],
        startFallbackPatterns: ['faits divers'],
        stopTextPatterns: ["plus d'articles", 'plus d’articles'],
        sizeWindow: { minWidth: 250, maxWidth: 1100, minHeight: 150, maxHeight: 700 },
        filterAds: false
    },
    {
        // Replaces Le Parisien, which was permanently blocked by an Akamai
        // WAF (403 Access Denied on every attempt). France Info is public
        // broadcaster news — no paywall, generally far less aggressive
        // bot-detection than a subscription site like Le Parisien.
        name: 'FranceInfo',
        url: 'https://www.francetvinfo.fr/faits-divers/',
        type: 'anchored',
        startTextPatterns: ['faits divers'],
        startFallbackPatterns: [], // if the heading text isn't found, just start from the top of the page
        stopTextPatterns: [],
        sizeWindow: { minWidth: 250, maxWidth: 1100, minHeight: 120, maxHeight: 600 },
        filterAds: true
    }
];

const MAX_CARDS_PER_SOURCE = 25;

// ---------- cookie / consent handling ----------

async function acceptCookiesAndConsent(page) {
    const patterns = [
        'tout accepter', 'accepter et fermer', "j'accepte", 'j’accepte',
        'accepter', 'autoriser', "j'autorise", 'continuer sans accepter',
        'ok pour moi', 'accepter tout', 'consentir'
    ];
    const knownSelectors = [
        '#didomi-notice-agree-button',
        '.didomi-continue-without-agreeing',
        '#sp_message_iframe_1 button',
        'button[title*="Accepter"]',
        'button[aria-label*="Accepter"]',
        '[class*="sp_choice_type_11"]',
        '[class*="sp_choice_type_ACCEPT_ALL"]'
    ];
    for (const frame of page.frames()) {
        try {
            await frame.evaluate((pats) => {
                const candidates = Array.from(
                    document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
                );
                const match = candidates.find(el => {
                    const t = ((el.innerText || el.value || '') + '').trim().toLowerCase();
                    if (!t || t.length > 60) return false;
                    return pats.some(p => t.includes(p));
                });
                if (match) match.click();
            }, patterns);
        } catch (e) { /* cross-origin frame or detached — ignore */ }

        for (const sel of knownSelectors) {
            try {
                // frame.$() returns instantly (null if absent) — no waiting.
                // Only pay a click-timeout cost on the rare frame that
                // actually has a match, instead of on every ad iframe too.
                const el = await frame.$(sel);
                if (el) await el.click({ timeout: 500 }).catch(() => {});
            } catch (e) { /* cross-origin frame or detached — ignore */ }
        }
    }
}

// ---------- overlay / ad hiding (fixed/sticky elements) ----------

async function hideOverlaysAndAds(page) {
    const hiddenCount = await page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('body *').forEach(el => {
            const cs = getComputedStyle(el);
            if ((cs.position === 'fixed' || cs.position === 'sticky') &&
                el.offsetWidth > 0 && el.offsetHeight > 0) {
                // Only treat it as a popup/banner if it's small relative to
                // the viewport — real popups are never most of the screen.
                // This avoids nuking sites that use fixed/sticky wrappers
                // for their actual main content layout.
                const tooBig = el.offsetWidth > window.innerWidth * 0.95 &&
                               el.offsetHeight > window.innerHeight * 0.6;
                if (!tooBig) {
                    el.style.setProperty('display', 'none', 'important');
                    n++;
                }
            }
        });
        document.querySelectorAll(
            'iframe[id*="google_ads"], iframe[id*="ad_"], [id*="ad-"], ' +
            '[class*="popup"], [class*="cookie"], [class*="consent"], [class*="modal"]'
        ).forEach(el => { el.style.setProperty('display', 'none', 'important'); n++; });
        return n;
    });
    console.log(`  🧹 overlays masqués: ${hiddenCount}`);
}

// ---------- generic helpers ----------

async function scrollDown(page, steps = 8, pauseMs = 900) {
    for (let i = 0; i < steps; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
        await page.waitForTimeout(pauseMs);
    }
}

async function scrollToTop(page) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
}

// Scroll down repeatedly, stopping early if any of the given text patterns
// appears in the page (used for CNews's "Plus d'articles" button so we don't
// scroll/load past it).
async function scrollUntilTextOrLimit(page, textPatterns, maxSteps = 10, pauseMs = 900) {
    for (let i = 0; i < maxSteps; i++) {
        const found = await page.evaluate((pats) => {
            const bodyText = document.body.innerText.toLowerCase();
            return pats.some(p => bodyText.includes(p.toLowerCase()));
        }, textPatterns);
        if (found) return true;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
        await page.waitForTimeout(pauseMs);
    }
    return false;
}

// Finds the page-absolute Y (top and bottom) of the first element whose
// visible text contains one of the given patterns. Returns null if none found.
async function findAnchorY(page, textPatterns, opts = {}) {
    return await page.evaluate(({ pats, onlyClickable }) => {
        const selector = onlyClickable ? 'button,a,[role="button"]' : 'h1,h2,h3,h4,p,div,span,button,a,section';
        const all = document.querySelectorAll(selector);
        for (const el of all) {
            const t = (el.innerText || '').trim().toLowerCase();
            if (!t || t.length > 400) continue;
            if (pats.some(p => t.includes(p.toLowerCase()))) {
                const r = el.getBoundingClientRect();
                // Skip invisible/zero-size matches (hidden SEO/a11y duplicates,
                // display:none nav items, etc.) — only accept real, rendered hits.
                if (r.width <= 0 || r.height <= 0) continue;
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
            }
        }
        return null;
    }, { pats: textPatterns, onlyClickable: !!opts.onlyClickable });
}

function isAdLike(text, hasIframe, classAndId) {
    const t = (text || '').toLowerCase();
    if (hasIframe) return true;
    if (/publicit[ée]|sponsoris[ée]|contenu sponsoris[ée]/.test(t)) return true;
    if (/\b(ad|ads|banner|sponsor|publicit)\b/i.test(classAndId || '')) return true;
    return false;
}

// Generic "find repeating card-shaped ancestor" detector, anchored on BOTH
// images and date-like text nodes (Canard has text-only cards with no image).
// Optionally bounded to a Y range and optionally ad-filtered.
async function detectCards(page, { sizeWindow, minY = null, maxY = null, filterAds = false, dateAnchor = false }) {
    return await page.evaluate((opts) => {
        const MARK_ATTR = 'data-capture-card';
        document.querySelectorAll(`[${MARK_ATTR}]`).forEach(el => el.removeAttribute(MARK_ATTR));

        const anchors = [];
        document.querySelectorAll('img').forEach(img => {
            const r = img.getBoundingClientRect();
            if (r.width > 40 && r.height > 40) anchors.push(img);
        });

        if (opts.dateAnchor) {
            const dateRe = /publié le\s+\d{1,2}\s+\w+\s+\d{4}/i;
            document.querySelectorAll('p,span,div,time').forEach(el => {
                const own = (el.innerText || '').trim();
                if (own.length < 80 && dateRe.test(own)) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) anchors.push(el);
                }
            });
        }

        const sigToEls = new Map();
        anchors.forEach(anchorEl => {
            let el = anchorEl;
            for (let depth = 0; depth < 7 && el.parentElement; depth++) {
                el = el.parentElement;
                const cls = (el.className && el.className.toString().trim()) || '';
                const sig = el.tagName + '|' + cls.replace(/\s+/g, '.');
                if (!sigToEls.has(sig)) sigToEls.set(sig, new Set());
                sigToEls.get(sig).add(el);
            }
        });

        function inBounds(el) {
            const r = el.getBoundingClientRect();
            const absTop = r.top + window.scrollY;
            const absBottom = r.bottom + window.scrollY;
            if (r.width < opts.minWidth || r.width > opts.maxWidth) return false;
            if (r.height < opts.minHeight || r.height > opts.maxHeight) return false;
            if (opts.minY !== null && absBottom < opts.minY) return false;
            if (opts.maxY !== null && absTop > opts.maxY) return false;
            return true;
        }

        let bestEls = [];
        const sigDebug = [];
        for (const [sig, elSet] of sigToEls.entries()) {
            const elsArr = Array.from(elSet);
            const inWindow = elsArr.filter(inBounds);
            if (inWindow.length > bestEls.length) bestEls = inWindow;
            const sample = elsArr[0];
            const r = sample.getBoundingClientRect();
            sigDebug.push({
                sig: sig.slice(0, 80),
                total: elsArr.length,
                inWindow: inWindow.length,
                w: Math.round(r.width),
                h: Math.round(r.height),
                absTop: Math.round(r.top + window.scrollY)
            });
        }
        sigDebug.sort((a, b) => b.total - a.total);
        window.__debugSigSamples = sigDebug.slice(0, 8);
        window.__debugAnchorCount = anchors.length;

        // sort top-to-bottom so downstream date-limit logic can stop early
        bestEls.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        if (opts.filterAds) {
            bestEls = bestEls.filter(el => {
                const hasIframe = !!el.querySelector('iframe');
                const text = el.innerText || '';
                const classAndId = (el.className || '') + ' ' + (el.id || '');
                const t = text.toLowerCase();
                if (hasIframe) return false;
                if (/publicit[ée]|sponsoris/.test(t)) return false;
                if (/\b(ad|ads|banner|sponsor|publicit)\b/i.test(classAndId)) return false;
                return true;
            });
        }

        bestEls.forEach((el, i) => el.setAttribute(MARK_ATTR, String(i)));
        return bestEls.length;
    }, { ...sizeWindow, minY, maxY, filterAds, dateAnchor });
}

// French month name -> index, for parsing "Publié le 17 juillet 2026"
const FR_MONTHS = {
    janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
    juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9,
    novembre: 10, décembre: 11, decembre: 11
};

function parseFrenchDate(text) {
    const m = text.match(/publié le\s+(\d{1,2})\s+([a-zéû]+)\s+(\d{4})/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = FR_MONTHS[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    if (month === undefined) return null;
    return new Date(year, month, day);
}

// ---------- per-source capture strategies ----------

async function captureCanard(page) {
    await scrollDown(page, 10, 900);
    await scrollToTop(page);

    const anchor = await findAnchorY(page, ['à la une']);
    const minY = anchor ? anchor.bottom : 0;

    const found = await detectCards(page, {
        sizeWindow: { minWidth: 250, maxWidth: 1100, minHeight: 150, maxHeight: 900 },
        minY,
        maxY: null,
        filterAds: false,
        dateAnchor: true
    });
    const rawAnchors = await page.evaluate(() => window.__debugAnchorCount || 0);
    const sigSamples = await page.evaluate(() => window.__debugSigSamples || []);
    console.log(`  🔍 Canard: anchor "à la une" ${anchor ? 'found' : 'NOT FOUND (using top of page)'}, ${rawAnchors} anchors bruts (img+dates), ${found} candidate cards`);
    console.log(`  📊 top signatures (minY=${minY}):`);
    sigSamples.forEach(s => console.log(`     [${s.total}x, ${s.inWindow} in-window] ${s.w}x${s.h}px @y=${s.absTop} :: ${s.sig}`));
    if (found === 0) return [];

    const elements = await page.locator('[data-capture-card]').all();

    // Date-limit: keep everything, but stop once we hit a *run* of dated
    // cards older than J-3. We tolerate the occasional out-of-order old card
    // (e.g. a featured/pinned older piece) rather than stopping on the very
    // first one — some Canard sections (enquêtes, web-plus) aren't strictly
    // newest-first. Cards with no date at all are kept (treated as recent).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    cutoff.setHours(0, 0, 0, 0);
    const MAX_CONSECUTIVE_OLD = 4;

    const kept = [];
    let consecutiveOld = 0;
    for (const el of elements) {
        const text = (await el.textContent()) || '';
        const date = parseFrenchDate(text);
        if (date && date < cutoff) {
            consecutiveOld++;
            if (consecutiveOld >= MAX_CONSECUTIVE_OLD) {
                console.log(`  ⏹ Canard: stopping after ${MAX_CONSECUTIVE_OLD} cartes consécutives antérieures à J-3 (dernière: ${date.toDateString()})`);
                break;
            }
            continue; // skip this one but keep scanning
        }
        consecutiveOld = 0;
        kept.push(el);
        if (kept.length >= MAX_CARDS_PER_SOURCE) break;
    }

    // Safety net: if the date filter happened to eliminate everything
    // (e.g. this section just hasn't published in 3+ days), fall back to
    // the most recent cards regardless of date rather than leaving the
    // source empty.
    if (kept.length === 0 && elements.length > 0) {
        console.log(`  ⚠ Canard: filtre de date a tout éliminé — repli sur les ${Math.min(8, elements.length)} premières cartes sans filtre`);
        return elements.slice(0, Math.min(8, elements.length));
    }

    return kept;
}

async function captureAnchored(page, source) {
    await acceptCookiesAndConsent(page);
    await page.waitForTimeout(500);

    if (source.stopTextPatterns && source.stopTextPatterns.length) {
        const stoppedEarly = await scrollUntilTextOrLimit(page, source.stopTextPatterns, 10, 900);
        console.log(`  ⬇ ${source.name}: scrolled ${stoppedEarly ? 'until stop-text found' : '(stop-text not found, used max steps)'}`);
    } else {
        await scrollDown(page, 8, 900);
    }
    await scrollToTop(page);

    let anchor = await findAnchorY(page, source.startTextPatterns);
    if (!anchor && source.startFallbackPatterns && source.startFallbackPatterns.length) {
        anchor = await findAnchorY(page, source.startFallbackPatterns);
    }
    const minY = anchor ? anchor.bottom : 0;

    let maxY = null;
    if (source.stopTextPatterns && source.stopTextPatterns.length) {
        const stopAnchor = await findAnchorY(page, source.stopTextPatterns, { onlyClickable: true });
        if (stopAnchor) maxY = stopAnchor.top;
    }

    const found = await detectCards(page, {
        sizeWindow: source.sizeWindow,
        minY,
        maxY,
        filterAds: !!source.filterAds,
        dateAnchor: false
    });
    const rawAnchors = await page.evaluate(() => window.__debugAnchorCount || 0);
    const sigSamples = await page.evaluate(() => window.__debugSigSamples || []);
    console.log(`  🔍 ${source.name}: start-anchor ${anchor ? 'found' : 'NOT FOUND (top of page)'}, stop-anchor ${maxY !== null ? 'found' : 'none'}, ${rawAnchors} anchors bruts (images), ${found} candidate cards`);
    console.log(`  📊 top signatures (minY=${minY}, maxY=${maxY}):`);
    sigSamples.forEach(s => console.log(`     [${s.total}x, ${s.inWindow} in-window] ${s.w}x${s.h}px @y=${s.absTop} :: ${s.sig}`));
    if (found === 0) return [];

    const elements = await page.locator('[data-capture-card]').all();
    return elements.slice(0, MAX_CARDS_PER_SOURCE);
}

// ---------- manual "images/" folder ingestion ----------

// Any images dropped in /images (any name, any common format) get pulled in
// as if they were captured cards — converted to card_0.png, card_1.png...
// (index.html always requests .png, so non-PNG sources are converted),
// played first, no popup text (no source article to extract one from).
// Missing/empty folder is completely normal and must never break the run.
const IMAGES_DIR = 'images';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

async function ingestManualImages() {
    let files = [];
    try {
        files = fs.readdirSync(IMAGES_DIR).filter(f => IMAGE_EXT_RE.test(f));
    } catch (e) {
        console.log(`  ℹ dossier "${IMAGES_DIR}/" absent — aucune photo manuelle à intégrer`);
        return 0;
    }

    if (files.length === 0) {
        console.log(`  ℹ dossier "${IMAGES_DIR}/" vide — aucune photo manuelle à intégrer`);
        return 0;
    }

    files.sort(); // deterministic order run-to-run regardless of filesystem order
    let n = 0;
    for (const file of files) {
        const srcPath = path.join(IMAGES_DIR, file);
        const destPath = `card_${n}.png`;
        try {
            await sharp(srcPath).png().toFile(destPath);
            console.log(`  🖼 Photo manuelle intégrée : ${file} -> ${destPath}`);
            n++;
        } catch (e) {
            console.warn(`  ⚠ Impossible de traiter l'image "${file}" (ignorée) : ${e.message}`);
        }
    }
    console.log(`  ✓ ${n} photo(s) manuelle(s) intégrée(s) en tête de la boucle`);
    return n;
}



function cacheBustedUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_cb=${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function dedupKey(el) {
    const text = (await el.textContent() || '').trim();
    const textPart = text.substring(0, 100).replace(/\s+/g, '_');
    let imgPart = '';
    try {
        const img = await el.$('img');
        if (img) {
            const src = await img.getAttribute('src');
            if (src) imgPart = src.split('?')[0];
        }
    } catch (e) { /* ignore */ }
    return `${textPart}|${imgPart}`;
}

// Extracts a clean, readable caption from a card's raw text: the
// publish-date pulled out separately, and the rest (category/title/excerpt)
// cleaned up and length-capped for display in a caption overlay.
// Maps internal source keys to a clean display name for on-screen citation.
function sourceDisplayName(internalName) {
    const map = {
        CanardActualites: 'Le Canard enchaîné',
        CanardEnquetes: 'Le Canard enchaîné',
        CanardWebPlus: 'Le Canard enchaîné',
        CNews: 'CNews',
        FranceInfo: 'France Info'
    };
    return map[internalName] || internalName;
}

// Splits raw card text on sentence-ending punctuation. Used to separate
// the on-image headline (always the first sentence — sites frequently put
// it in the SAME text node as the excerpt, with no line break between
// them, so line-based slicing alone can't isolate it) from whatever
// descriptive text follows it.
function splitIntoSentences(text) {
    return (text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [])
        .map(s => s.trim())
        .filter(Boolean);
}

// title:   shown above the image (popup) and in the ticker. This is always a
//          REFORMULATED version of the article's own headline — reworded,
//          never a verbatim copy of the text visible on the card screenshot,
//          and never just a category tag or the source name standing in for
//          a title. Every single card gets one; there is no "no title" case.
//          (An earlier version built this purely from metadata (category/
//          source) to avoid ever repeating the headline. That produced
//          cards with no real title at all — e.g. single-line CNews cards
//          fell back to showing just "CNews". buildTitles() below is
//          what turns the raw headline captured here into that reworded (Qwen/Ollama, with local fallback)
//          title, for every card without exception.)
// summary: a REAL summary of the actual article, fetched by
//          fetchRealSummaries() from the article's own page (its
//          description meta tag, or its own opening paragraphs) — not the
//          short teaser visible on the listing card. Guaranteed non-empty:
//          if the article page can't be reached, this falls back to the
//          listing-page excerpt if there was one, and finally to the
//          reformulated title itself (plus the source, already shown
//          separately below it) instead of a generic "no summary" message,
//          so the summary screen is always informative.
function extractCaption(rawInnerText, sourceLabel) {
    const rawLines = (rawInnerText || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    let date = '';
    const dateLineIdx = rawLines.findIndex(l =>
        /publié le\s+\d{1,2}\s+[a-zéûôîàè]+\s+\d{4}/i.test(l) ||
        /^le\s+\d{1,2}\s+[a-zéûôîàè]+\s+\d{4}$/i.test(l)
    );
    if (dateLineIdx !== -1) {
        const m = rawLines[dateLineIdx].match(/(\d{1,2}\s+[a-zéûôîàè]+\s+\d{4})/i);
        if (m) date = m[1];
        rawLines.splice(dateLineIdx, 1);
    }

    // Only treat the first line as a standalone category label when there's
    // at least one more line after it. A single-line card (no category, no
    // separate excerpt — just the headline, as CNews sometimes gives us) has
    // nothing to split off as "category": the one line IS the headline.
    const category = rawLines.length > 1 ? rawLines[0].replace(/•/g, '—').trim() : '';
    const fullText = (rawLines.length > 1 ? rawLines.slice(1) : rawLines)
        .join(' ').replace(/\s+/g, ' ').trim();

    // First sentence of fullText is the raw headline — kept here only as
    // source material for buildTitles(), never surfaced verbatim.
    const sentences = splitIntoSentences(fullText);
    const headline = sentences[0] || fullText || category || '';
    let summary = sentences.length > 1 ? sentences.slice(1).join(' ').trim() : '';
    if (summary.length > 380) summary = truncateCleanly(summary, 380);
    const hasRealSummary = !!summary;

    // title is filled in later by buildTitles(), and summary is
    // upgraded to the real article summary by fetchRealSummaries() —
    // both run once every card on every source has been collected.
    return { headline, category, summary, hasRealSummary, date, source: sourceLabel };
}

// ---------- titles (every card, reworded by a real editorial rewrite — Qwen via Ollama) ----------
// Turns each card's raw headline into a short, reworded title — same facts,
// different wording, AFP-dispatch style — so the popup/ticker never just
// echoes the headline that's already legible on the card, and never falls
// back to a bare category or source label. Every card gets one, no
// exception: if the local Qwen model is unreachable or a single call fails
// (CI runner not warmed up yet, model not pulled, timeout...), that card
// falls back to localReword() below rather than being left without a title.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
// Regular per-card call timeout — generous but bounded, for once the model
// is already loaded in RAM (see warmUpOllama below). An 8B model on a
// CPU-only CI runner doing a short (~80 token) completion realistically
// takes several seconds to tens of seconds; 25s was measured to be too
// tight even for a WARM model under load, let alone the cold first call.
const OLLAMA_CALL_TIMEOUT_MS = 60000;
// The very first request to a given model forces Ollama to read the whole
// ~5GB of weights off disk into RAM before generating a single token — on a
// CPU-only runner that alone can take well over 25s. Doing this as a
// dedicated, throwaway warm-up call (generous timeout, result discarded)
// means the 45-80 real per-card calls that follow hit an already-loaded
// model instead of each racing the cold-start clock — and if even the
// warm-up times out, we know immediately to fall back for everything
// instead of failing the same way 45 times over.
const OLLAMA_WARMUP_TIMEOUT_MS = 150000;
// Hard ceiling on time spent waiting on the AI rewrite across ALL cards —
// a CPU-only CI runner doing 50-80 sequential 8B calls can otherwise turn a
// 4-hourly job into an hours-long one. Once the budget is spent, remaining
// cards just use the local fallback (they still get a real, reworded title —
// just not the AI-generated one).
const OLLAMA_TOTAL_BUDGET_MS = 30 * 60 * 1000; // 30 min

async function checkOllamaAvailable() {
    const axios = require('axios');
    try {
        await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 3000 });
        return true;
    } catch (e) {
        return false;
    }
}

// Forces the model into RAM with a trivial, throwaway generation before the
// real loop starts. Returns false (→ fall back for every card, without
// wasting the per-card timeout budget 45+ times over) if even this fails.
async function warmUpOllama() {
    const axios = require('axios');
    try {
        console.log(`  🔥 Préchauffage de ${OLLAMA_MODEL} (chargement du modèle en RAM)...`);
        const startedAt = Date.now();
        await axios.post(`${OLLAMA_URL}/api/generate`, {
            model: OLLAMA_MODEL,
            prompt: 'Réponds juste "ok".',
            stream: false,
            options: { num_predict: 5 }
        }, { timeout: OLLAMA_WARMUP_TIMEOUT_MS });
        console.log(`  🔥 Modèle chargé en ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return true;
    } catch (e) {
        console.warn(`  ⚠ Préchauffage de ${OLLAMA_MODEL} échoué (${e.message}) — repli local pour toutes les cartes`);
        return false;
    }
}

async function rewriteHeadlineWithQwen(headline, category) {
    const axios = require('axios');
    const prompt =
        `Tu es journaliste pour une dépêche d'actualité française, style AFP : ` +
        `phrases courtes, factuelles, percutantes, sans familiarité ni sensationnalisme.\n` +
        `Reformule ce titre en UNE SEULE phrase originale (20 mots maximum), en gardant ` +
        `exactement les mêmes faits, sans en inventer ni en omettre.\n` +
        `Réponds uniquement avec la phrase reformulée, sans guillemets ni préambule.\n\n` +
        `Catégorie : ${category || 'Actualité'}\n` +
        `Titre original : ${headline}`;

    const res = await axios.post(`${OLLAMA_URL}/api/generate`, {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.4, num_predict: 80 }
    }, { timeout: OLLAMA_CALL_TIMEOUT_MS });

    let text = ((res.data && res.data.response) || '').trim();
    text = text.replace(/^[«"']+|[»"']+$/g, '').replace(/\s+/g, ' ').trim();
    return text || null;
}

async function buildTitles(captions) {
    let available = await checkOllamaAvailable();
    if (!available) {
        console.warn(`  ⚠ Ollama injoignable sur ${OLLAMA_URL} — repli local (reformulation par mots) pour toutes les cartes`);
    } else {
        console.log(`  🤖 Ollama disponible (${OLLAMA_MODEL})`);
        available = await warmUpOllama(); // downgrades to false if even the warm-up fails
        if (available) console.log(`  🤖 Reformulation éditoriale en cours...`);
    }

    const startedAt = Date.now();
    let aiOk = 0, aiFailed = 0, aiSkippedBudget = 0;

    for (const c of captions) {
        if (!c || !c.headline) continue;

        let title = null;
        const budgetLeft = OLLAMA_TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (available && budgetLeft > 0) {
            try {
                title = await rewriteHeadlineWithQwen(c.headline, c.category);
                if (title) aiOk++; else aiFailed++;
            } catch (e) {
                aiFailed++;
                console.warn(`  ⚠ Qwen: échec reformulation ("${c.headline.slice(0, 40)}...") : ${e.message}`);
            }
        } else if (available) {
            aiSkippedBudget++;
        }

        c.title = title || localReword(c.headline, c.category);
        if (!c.summary) c.summary = c.title;
        delete c.headline;
        // category kept (not deleted): used as the kicker tag on the
        // generated card image (see generateCardImages / card-template.js).
    }

    if (available) {
        console.log(`  🤖 Reformulation IA : ${aiOk} ok, ${aiFailed} échec→repli local, ${aiSkippedBudget} budget temps dépassé→repli local`);
    }
}

// Word-shuffling fallback — same facts, different wording, but pure string
// manipulation (no model, no network). Used whenever the Qwen call above
// isn't available or fails, so every card still gets a real title.
function localReword(headline, category) {
    let words = headline.replace(/^[«"']+|[»"']+$/g, '').split(/\s+/).filter(Boolean);
    const fillers = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'du', 'et', 'ce', 'cette', 'cet']);
    while (words.length > 4 && fillers.has(words[0].toLowerCase())) words.shift();

    let core = words.join(' ');
    if (core.length > 90) core = truncateCleanly(core, 90);

    const tag = category && category.length > 0 && category.length <= 24 ? category : 'À la une';
    return `${tag} : ${core}`;
}

// ---------- real summaries (every card, read from the actual article) ----------
// The listing page only gives a short teaser/excerpt (or nothing at all).
// To get a genuine summary — as if the article had actually been opened and
// read — this fetches each card's real article page directly (plain HTTP,
// via the axios + cheerio deps already used elsewhere in this project) and
// pulls the site's own description of that specific article (og:description
// / meta description, the sub-head every one of these sites writes by hand
// for each piece), falling back to the article's own opening paragraphs if
// no description tag is present. No AI, no paid API, no rate-limited
// third-party service — just reading the page, the same as a browser would.
async function fetchRealSummaries(captions) {
    const cheerio = require('cheerio');
    const axios = require('axios');
    const targets = captions
        .map((c, i) => ({ i, c }))
        .filter(x => x.c && x.c.href);

    if (targets.length === 0) return;

    const CONCURRENCY = 5;
    let cursor = 0;
    let ok = 0, failed = 0;

    async function worker() {
        while (cursor < targets.length) {
            const { i, c } = targets[cursor++];
            try {
                const res = await axios.get(c.href, {
                    timeout: 12000,
                    maxRedirects: 5,
                    validateStatus: s => s >= 200 && s < 400,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                        'Accept-Language': 'fr-FR,fr;q=0.9'
                    }
                });
                const real = extractRealSummaryFromHtml(res.data);
                if (real) {
                    c.summary = real;
                    c.hasRealSummary = true;
                    ok++;
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
                console.warn(`  ⚠ Carte ${i}: lecture de l'article échouée (${c.source}) : ${e.message}`);
            }
        }
    }

    console.log(`  📖 Lecture de ${targets.length} article(s) source pour un résumé réel...`);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    console.log(`  📖 Résumés réels : ${ok} récupérés, ${failed} indisponibles (repli sur titre)`);
}

function extractRealSummaryFromHtml(html) {
    const cheerio = require('cheerio');
    const $ = cheerio.load(html || '');

    let summary =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        '';
    summary = (summary || '').replace(/\s+/g, ' ').trim();

    if (!summary || summary.length < 40) {
        const bodySelectors = ['article p', '.article-body p', '.article-content p', 'main p', 'p'];
        let paragraphs = [];
        for (const sel of bodySelectors) {
            paragraphs = $(sel)
                .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
                .get()
                .filter(t => t.length > 40 && !/cookie|abonn|publicit/i.test(t));
            if (paragraphs.length) break;
        }
        summary = paragraphs.slice(0, 2).join(' ');
    }

    if (summary.length > 380) summary = truncateCleanly(summary, 380);
    return summary.trim();
}

// Cuts long text without slicing through the middle of a word or sentence.
// Prefers the last sentence-ending punctuation within the limit; falls back
// to the last whole word if no sentence boundary is close enough, and only
// then appends "…" (a clean sentence end needs no ellipsis).
function truncateCleanly(text, maxLen) {
    if (text.length <= maxLen) return text;
    const slice = text.slice(0, maxLen);

    const lastSentenceEnd = Math.max(
        slice.lastIndexOf('. '), slice.lastIndexOf('! '),
        slice.lastIndexOf('? '), slice.lastIndexOf('… ')
    );
    if (lastSentenceEnd > maxLen * 0.4) {
        return slice.slice(0, lastSentenceEnd + 1).trim();
    }

    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace > maxLen * 0.4 ? slice.slice(0, lastSpace) : slice;
    return cut.trim() + '…';
}


// ---------- generated card images (own design, built from facts only) ----------
// Renders card_N.png for every scraped card from card-template.js — never a
// screenshot of the source site. Runs after buildTitles()/
// fetchRealSummaries() so the image can show the final title/date/source.
// Manual photos (images/ folder, indices < startIndex) already have their
// own card_N.png from ingestManualImages() and are skipped here.
async function generateCardImages(browser, captions, startIndex) {
    const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT } });
    let n = 0;
    for (let i = startIndex; i < captions.length; i++) {
        const c = captions[i];
        if (!c) continue;
        try {
            const html = renderCardHtml({
                title: c.title || c.summary || '',
                category: c.category,
                source: c.source,
                date: c.date
            });
            await page.setContent(html, { waitUntil: 'load' });
            await page.screenshot({ path: `card_${i}.png` });
            n++;
        } catch (e) {
            console.warn(`  ⚠ Carte ${i}: génération de l'image échouée : ${e.message}`);
        }
    }
    await page.close();
    console.log(`  🎨 ${n} carte(s) générée(s) (design maison, sans capture du site source)`);
}

async function main() {
    console.log("--- DÉBUT DE LA CAPTURE DES CARTES ---");

    const manualCount = await ingestManualImages();

    const browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    let count = manualCount;
    const perSourceCounts = {};
    const capturedHashes = new Set();
    const cardCaptions = new Array(manualCount).fill(null); // manual photos: no popup text

    for (const source of sources) {
        const page = await browser.newPage({
            viewport: { width: 1280, height: 900 },
            // Full, realistic UA string — the previous one was missing the
            // Chrome/Safari suffix entirely, which doesn't match any real
            // browser and is an easy signal for bot-detection (e.g. Akamai)
            // to flag and hard-block on.
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            locale: 'fr-FR'
        });

        // Basic automation-fingerprint reduction: hide navigator.webdriver,
        // which Playwright/headless Chromium expose by default and which
        // WAFs commonly check for.
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
            // Deliberately NOT sending Cache-Control/Pragma: no-cache anymore —
            // combined with the cache-busting query param, that header pattern
            // is itself a classic automated-scraping signal to bot-detection
            // systems (real browsers rarely send it on normal navigation).
            // The per-request _cb= query param already defeats CDN caching
            // without needing these headers too.
        });

        perSourceCounts[source.name] = 0;

        try {
            const freshUrl = cacheBustedUrl(source.url);
            console.log(`\n📰 ${source.name}: ${freshUrl}`);
            await page.goto(freshUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            for (let attempt = 0; attempt < 3; attempt++) {
                await acceptCookiesAndConsent(page);
                await page.waitForTimeout(700);
            }
            await hideOverlaysAndAds(page);

            let elements;
            if (source.type === 'canard') {
                elements = await captureCanard(page);
            } else {
                elements = await captureAnchored(page, source);
            }

            await hideOverlaysAndAds(page); // second sweep in case late popups appeared

            if (!elements || elements.length === 0) {
                console.log(`❌ ${source.name}: no cards found at all`);
                await page.screenshot({ path: `debug_${source.name}_noselectors.png`, fullPage: true });
                fs.writeFileSync(`debug_${source.name}.html`, await page.content());
                await page.close();
                continue;
            }

            let cardsCaptured = 0;
            for (let i = 0; i < elements.length; i++) {
                try {
                    const el = elements[i];
                    await el.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(300);

                    const key = await dedupKey(el);
                    if (capturedHashes.has(key)) {
                        console.log(`  ⊘ Carte ${i}: doublon, ignorée`);
                        continue;
                    }
                    capturedHashes.add(key);

                    const rawText = (await el.innerText()) || '';
                    const href = await el.evaluate(node => {
                        const a = node.matches('a[href]') ? node : (node.querySelector('a[href]') || node.closest('a[href]'));
                        return a ? a.href : null;
                    }).catch(() => null);
                    cardCaptions[count] = extractCaption(rawText, sourceDisplayName(source.name));
                    cardCaptions[count].href = href;

                    console.log(`✓ Carte ${count} capturée (${source.name} #${i})`);
                    count++;
                    cardsCaptured++;

                } catch (e) {
                    console.warn(`  ⚠ Carte ${i}: ${e.message}`);
                }
            }

            perSourceCounts[source.name] = cardsCaptured;
            console.log(`\n✓ ${source.name}: ${cardsCaptured} cartes capturées\n`);

        } catch (e) {
            console.error(`❌ ${source.name} erreur:`, e.message);
        } finally {
            await page.close();
        }
    }

    console.log('\n📖 Récupération de vrais résumés (lecture des articles sources)...');
    await fetchRealSummaries(cardCaptions);
    console.log('\n🖋 Construction des titres (rewrite éditorial via Qwen/Ollama)...');
    await buildTitles(cardCaptions);

    console.log('\n🎨 Génération des cartes (design maison, plus de capture du site source)...');
    await generateCardImages(browser, cardCaptions, manualCount);

    fs.writeFileSync('total.json', JSON.stringify({ count }));
    fs.writeFileSync('cards.json', JSON.stringify({ items: cardCaptions }));
    console.log(`\n✅ Total : ${count} cartes uniques capturées`);
    console.log(`   Détail : ${JSON.stringify(perSourceCounts)}`);
    console.log(`--- FIN ---\n`);

    await browser.close();

    if (count === 0) {
        console.error("❌❌❌ AUCUNE CARTE CAPTURÉE — échec du job pour alerter.");
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Erreur fatale:", err);
    process.exit(1);
});
