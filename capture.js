const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');

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
        name: 'LeParisien',
        url: 'https://www.leparisien.fr/faits-divers/',
        type: 'anchored',
        startTextPatterns: ['faits divers'],
        startFallbackPatterns: [],
        stopTextPatterns: [],
        sizeWindow: { minWidth: 250, maxWidth: 1100, minHeight: 120, maxHeight: 500 },
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

// ---------- shared capture pipeline ----------

async function saveTrimmedScreenshot(el, outPath) {
    const buffer = await el.screenshot();
    try {
        await sharp(buffer).trim({ background: '#ffffff', threshold: 12 }).toFile(outPath);
    } catch (e) {
        console.warn(`  ⚠ trim failed for ${outPath}, saving untrimmed: ${e.message}`);
        fs.writeFileSync(outPath, buffer);
    }
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

async function main() {
    console.log("--- DÉBUT DE LA CAPTURE DES CARTES ---");
    const browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    let count = 0;
    const perSourceCounts = {};
    const capturedHashes = new Set();

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

                    await saveTrimmedScreenshot(el, `card_${count}.png`);
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

    fs.writeFileSync('total.json', JSON.stringify({ count }));
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
