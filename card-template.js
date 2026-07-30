// Renders a self-contained HTML page for a single news card, built entirely
// from the facts extracted by capture.js (title, date, source, category) —
// never a screenshot of the source site. Screenshotted by Playwright in
// capture.js to produce card_N.png. No external fonts / no network calls:
// same constraint as index.html, since this also has to render identically
// in a headless CI runner with no internet.

const CARD_WIDTH = 1000;
const CARD_HEIGHT = 750;

// Per-source accent color + two-letter badge, so cards stay visually
// distinguishable by outlet even without a real photo. Matches the
// "dark room command center" palette already used in index.html.
const SOURCE_STYLE = {
    'Le Canard enchaîné': { accent: '#ffb63c', badge: 'CE' }, // amber
    'CNews':               { accent: '#ff3b3b', badge: 'CN' }, // alert red
    'France Info':         { accent: '#4de3ff', badge: 'FI' }  // cyan
};
const DEFAULT_STYLE = { accent: '#39ff8c', badge: '••' };

function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// data: { title, category, source, date }
function renderCardHtml(data) {
    const style = SOURCE_STYLE[data.source] || DEFAULT_STYLE;
    const title = escapeHtml(data.title || '');
    const category = escapeHtml((data.category || 'À la une').toUpperCase());
    const source = escapeHtml(data.source || '');
    const date = escapeHtml(data.date || '');
    const badge = escapeHtml(style.badge);

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
        width: ${CARD_WIDTH}px;
        height: ${CARD_HEIGHT}px;
        overflow: hidden;
        font-family: ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Consolas,
                     'Liberation Mono', Menlo, monospace;
        background:
            repeating-linear-gradient(0deg, rgba(0,255,140,0.05) 0px, rgba(0,255,140,0.05) 1px, transparent 1px, transparent 28px),
            repeating-linear-gradient(90deg, rgba(0,255,140,0.05) 0px, rgba(0,255,140,0.05) 1px, transparent 1px, transparent 28px),
            linear-gradient(160deg, #061b0f 0%, #020805 100%);
    }
    #wrap {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 56px 60px;
    }
    #accent-bar {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 8px;
        background: ${style.accent};
        box-shadow: 0 0 22px ${style.accent};
    }
    #kicker {
        font-size: 26px;
        font-weight: 700;
        letter-spacing: 4px;
        color: ${style.accent};
        text-transform: uppercase;
    }
    #kicker::before { content: "// "; color: rgba(217,255,233,0.4); }
    #title {
        font-size: 58px;
        font-weight: 700;
        line-height: 1.28;
        color: #d9ffe9;
        text-shadow: 0 0 18px rgba(57,255,140,0.18);
        display: -webkit-box;
        -webkit-line-clamp: 6;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
    #footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-top: 1px solid rgba(57,255,140,0.25);
        padding-top: 26px;
    }
    #source-block { display: flex; align-items: center; gap: 18px; }
    #badge {
        width: 56px; height: 56px;
        border-radius: 50%;
        border: 2px solid ${style.accent};
        color: ${style.accent};
        display: flex; align-items: center; justify-content: center;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 1px;
        flex-shrink: 0;
    }
    #source-name {
        font-size: 30px;
        font-weight: 700;
        color: #4de3ff;
    }
    #date {
        font-size: 24px;
        font-weight: 700;
        color: #ffb63c;
        text-transform: uppercase;
    }
</style>
</head>
<body>
    <div id="wrap">
        <div id="accent-bar"></div>
        <div id="kicker">${category}</div>
        <div id="title">${title}</div>
        <div id="footer">
            <div id="source-block">
                <div id="badge">${badge}</div>
                <div id="source-name">${source}</div>
            </div>
            <div id="date">${date}</div>
        </div>
    </div>
</body>
</html>`;
}

module.exports = { renderCardHtml, CARD_WIDTH, CARD_HEIGHT };
