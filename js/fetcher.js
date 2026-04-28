// fetcher.js — Pipeline de récupération des flux RSS/Atom
// Proxy principal : rss2json.com (retourne du JSON propre, fiable, sans clé API)
// Fallback      : parsing XML natif via allorigins.win /get (JSON wrapper)

const RSS2JSON_URL     = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS_URL   = 'https://api.allorigins.win/get?url=';
const FETCH_TIMEOUT_MS = 15000;
const MAX_ARTICLES_PER_SOURCE = 20;

// Délai entre batches pour respecter le rate-limit de rss2json (sans clé API)
const BATCH_DELAY_MS = 1200;

// ── Entrée publique ─────────────────────────────────────────────────────────

/**
 * Récupère et normalise les articles d'une source.
 * @param {Object} source — objet de sources.js
 * @returns {Promise<Article[]>}
 */
async function fetchSource(source) {
  if (!source.feedUrl) return [];

  try {
    // 1. Essai rss2json
    const articles = await fetchViaRss2Json(source);
    if (articles.length > 0) return articles.slice(0, MAX_ARTICLES_PER_SOURCE);
  } catch (e) {
    console.warn(`[Fetcher] rss2json KO pour ${source.name}:`, e.message);
  }

  try {
    // 2. Fallback : allorigins /get → parse XML natif
    const articles = await fetchViaAllorigins(source);
    return articles.slice(0, MAX_ARTICLES_PER_SOURCE);
  } catch (e) {
    console.warn(`[Fetcher] allorigins KO pour ${source.name}:`, e.message);
    return [];
  }
}

/**
 * Récupère toutes les sources actives par petits lots.
 * @param {Source[]} sources
 * @param {function} onProgress — callback(done, total)
 * @returns {Promise<Article[]>}
 */
async function fetchAllSources(sources, onProgress) {
  const active = sources.filter(s => s.active && s.feedUrl);
  const BATCH_SIZE = 4; // conservateur pour ne pas dépasser le rate-limit
  const allArticles = [];

  for (let i = 0; i < active.length; i += BATCH_SIZE) {
    const batch   = active.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => fetchSource(s)));

    results.forEach(r => {
      if (r.status === 'fulfilled') allArticles.push(...r.value);
    });

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, active.length), active.length);

    // Pause entre les lots (sauf pour le dernier)
    if (i + BATCH_SIZE < active.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return deduplicateArticles(allArticles);
}

// ── Proxy 1 : rss2json.com ──────────────────────────────────────────────────
// Retourne du JSON avec items pré-parsés, thumbnails extraits, dates normalisées.

async function fetchViaRss2Json(source) {
  const url  = RSS2JSON_URL + encodeURIComponent(source.feedUrl);
  const text = await fetchWithTimeout(url);
  const data = JSON.parse(text);

  if (data.status !== 'ok') {
    throw new Error(`rss2json status: ${data.status} — ${data.message || ''}`);
  }

  return (data.items || []).map(item => normalizeRss2JsonItem(item, source)).filter(Boolean);
}

function normalizeRss2JsonItem(item, source) {
  try {
    const url = item.link || item.guid;
    if (!url || !item.title?.trim()) return null;

    const description = item.description || item.content || '';
    const cleanExcerpt = stripHTML(description).slice(0, 300);

    return {
      id:           hashString(url),
      title:        decodeHTMLEntities(item.title.trim()),
      url:          url.trim(),
      excerpt:      cleanExcerpt,
      thumbnail:    item.thumbnail || item.enclosure?.link || extractImgFromHtml(description),
      author:       item.author || null,
      publishedAt:  item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      fetchedAt:    new Date().toISOString(),
      source:       source.id,
      sourceName:   source.name,
      category:     source.category,
      subCategory:  source.subCategory,
      language:     source.language,
      readingTime:  estimateReadingTime(cleanExcerpt),
      isRead:       false,
      isBookmarked: false,
    };
  } catch {
    return null;
  }
}

// ── Proxy 2 : allorigins.win /get → XML natif ────────────────────────────────
// /get retourne {"contents": "...", "status": {"http_code": 200, ...}}
// Plus stable que /raw (qui retourne directement le contenu brut).

async function fetchViaAllorigins(source) {
  const proxyUrl = ALLORIGINS_URL + encodeURIComponent(source.feedUrl);
  const text     = await fetchWithTimeout(proxyUrl);
  const data     = JSON.parse(text);

  if (!data.contents) throw new Error('allorigins: pas de contenu');
  if (data.status?.http_code && data.status.http_code !== 200) {
    throw new Error(`allorigins: HTTP ${data.status.http_code}`);
  }

  return parseXML(data.contents, source);
}

// ── Parsing XML natif (RSS 2.0 + Atom) ──────────────────────────────────────

function parseXML(xmlText, source) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  } catch { return []; }

  if (doc.querySelector('parsererror')) return [];

  const isAtom = !!doc.querySelector('feed');
  const items  = isAtom
    ? Array.from(doc.querySelectorAll('feed > entry'))
    : Array.from(doc.querySelectorAll('channel > item'));

  return items.map(item => parseXmlItem(item, source, isAtom)).filter(Boolean);
}

function parseXmlItem(item, source, isAtom) {
  try {
    const title = getXmlText(item, 'title');
    if (!title) return null;

    const link = isAtom
      ? (item.querySelector('link[rel="alternate"]')?.getAttribute('href')
          || item.querySelector('link:not([rel])')?.getAttribute('href')
          || item.querySelector('link')?.getAttribute('href')
          || getXmlText(item, 'id'))
      : (getXmlText(item, 'link') || getXmlText(item, 'guid'));

    if (!link) return null;

    const rawDate   = isAtom
      ? (getXmlText(item, 'updated') || getXmlText(item, 'published'))
      : (getXmlText(item, 'pubDate') || getXmlText(item, 'dc\\:date'));
    const description = isAtom
      ? (getXmlText(item, 'summary') || getXmlText(item, 'content'))
      : getXmlText(item, 'description');

    const author = isAtom
      ? (getXmlText(item, 'author name') || getXmlText(item, 'name'))
      : (getXmlText(item, 'author') || getDcText(item, 'creator'));

    const cleanExcerpt = stripHTML(description || '').slice(0, 300);

    return {
      id:           hashString(link),
      title:        decodeHTMLEntities(title.trim()),
      url:          link.trim(),
      excerpt:      cleanExcerpt,
      thumbnail:    extractXmlThumbnail(item, description),
      author:       author || null,
      publishedAt:  rawDate ? new Date(rawDate).toISOString() : new Date().toISOString(),
      fetchedAt:    new Date().toISOString(),
      source:       source.id,
      sourceName:   source.name,
      category:     source.category,
      subCategory:  source.subCategory,
      language:     source.language,
      readingTime:  estimateReadingTime(cleanExcerpt),
      isRead:       false,
      isBookmarked: false,
    };
  } catch { return null; }
}

// ── Helpers XML ──────────────────────────────────────────────────────────────

function getXmlText(el, selector) {
  try { return el.querySelector(selector)?.textContent?.trim() || ''; }
  catch { return ''; }
}

function getDcText(el, tag) {
  try {
    const found = Array.from(el.children).find(c => c.localName === tag);
    return found?.textContent?.trim() || '';
  } catch { return ''; }
}

function extractXmlThumbnail(item, descHtml) {
  const media = item.querySelector('thumbnail') || item.querySelector('content[medium="image"]');
  if (media?.getAttribute('url')) return media.getAttribute('url');

  const enc = item.querySelector('enclosure[type^="image"]');
  if (enc?.getAttribute('url')) return enc.getAttribute('url');

  return extractImgFromHtml(descHtml || '');
}

function extractImgFromHtml(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// ── Déduplication ────────────────────────────────────────────────────────────

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

// ── Utilitaires ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function stripHTML(html) {
  return String(html || '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHTMLEntities(str) {
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

function estimateReadingTime(text) {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).length / 200));
}

// djb2 hash pour identifiant stable basé sur l'URL
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h & h;
  }
  return (h >>> 0).toString(36);
}
