// fetcher.js — Pipeline de récupération et parsing des flux RSS/Atom
// Utilise allorigins.win comme proxy CORS (gratuit, sans clé API)
// Fallback : corsproxy.io

const PROXY_PRIMARY  = 'https://api.allorigins.win/raw?url=';
const PROXY_FALLBACK = 'https://corsproxy.io/?';
const FETCH_TIMEOUT_MS = 12000;
const MAX_ARTICLES_PER_SOURCE = 30;

// ── Entrée publique ─────────────────────────────────────────────────────────

/**
 * Récupère et parse un flux RSS/Atom pour une source donnée.
 * Retourne un tableau d'articles normalisés ou [] en cas d'échec.
 * @param {Object} source — objet issu de sources.js
 * @returns {Promise<Article[]>}
 */
async function fetchSource(source) {
  if (!source.feedUrl) return [];

  try {
    const xml = await fetchWithProxy(source.feedUrl);
    const articles = parseXML(xml, source);
    return articles.slice(0, MAX_ARTICLES_PER_SOURCE);
  } catch (err) {
    console.warn(`[Fetcher] Échec pour ${source.name}:`, err.message);
    return [];
  }
}

/**
 * Récupère toutes les sources actives en parallèle (par lots pour ne pas tout
 * écraser le proxy en même temps).
 * @param {Source[]} sources
 * @param {function(progress)} onProgress — callback(done, total)
 * @returns {Promise<Article[]>}
 */
async function fetchAllSources(sources, onProgress) {
  const active = sources.filter(s => s.active && s.feedUrl);
  const BATCH_SIZE = 5;
  const allArticles = [];

  for (let i = 0; i < active.length; i += BATCH_SIZE) {
    const batch = active.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => fetchSource(s)));

    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        allArticles.push(...r.value);
      } else {
        console.warn(`[Fetcher] Rejeté: ${batch[idx].name}`);
      }
    });

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, active.length), active.length);
  }

  return deduplicateArticles(allArticles);
}

// ── Fetch via proxy ─────────────────────────────────────────────────────────

async function fetchWithProxy(feedUrl) {
  // Essai avec le proxy principal
  try {
    return await fetchRaw(PROXY_PRIMARY + encodeURIComponent(feedUrl));
  } catch (_) {
    // Fallback
    return await fetchRaw(PROXY_FALLBACK + encodeURIComponent(feedUrl));
  }
}

async function fetchRaw(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Parsing XML (RSS 2.0 + Atom 1.0) ───────────────────────────────────────

function parseXML(xmlText, source) {
  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(xmlText, 'text/xml');
  } catch {
    return [];
  }

  // Détecte les erreurs de parsing
  if (doc.querySelector('parsererror')) {
    console.warn(`[Fetcher] Erreur XML pour ${source.name}`);
    return [];
  }

  // Atom si balise <feed> présente
  const isAtom = !!doc.querySelector('feed');
  const items  = isAtom
    ? Array.from(doc.querySelectorAll('feed > entry'))
    : Array.from(doc.querySelectorAll('channel > item'));

  return items.map(item => parseItem(item, source, isAtom)).filter(Boolean);
}

function parseItem(item, source, isAtom) {
  try {
    const title = getText(item, isAtom ? 'title' : 'title') || '';
    if (!title.trim()) return null;

    const link = isAtom
      ? (item.querySelector('link[rel="alternate"]')?.getAttribute('href')
          || item.querySelector('link:not([rel])')?.getAttribute('href')
          || item.querySelector('link')?.getAttribute('href')
          || getText(item, 'id'))
      : (getText(item, 'link') || getText(item, 'guid'));

    if (!link) return null;

    const rawDate = isAtom
      ? (getText(item, 'updated') || getText(item, 'published'))
      : (getText(item, 'pubDate') || getText(item, 'dc\\:date'));

    const description = isAtom
      ? (getText(item, 'summary') || getText(item, 'content'))
      : getText(item, 'description');

    const author = isAtom
      ? (getText(item, 'author name') || getText(item, 'name'))
      : (getText(item, 'author') || getTextNS(item, 'dc', 'creator'));

    const thumbnail = extractThumbnail(item, description);
    const cleanExcerpt = stripHTML(description || '').slice(0, 300);
    const publishedAt = rawDate ? new Date(rawDate).toISOString() : new Date().toISOString();

    return {
      // Identifiant stable basé sur l'URL
      id: hashString(link),
      title: decodeHTMLEntities(title.trim()),
      url: link.trim(),
      excerpt: cleanExcerpt,
      thumbnail,
      author: author || null,
      publishedAt,
      fetchedAt: new Date().toISOString(),
      source: source.id,
      sourceName: source.name,
      category: source.category,
      subCategory: source.subCategory,
      language: source.language,
      readingTime: estimateReadingTime(cleanExcerpt),
      isRead: false,
      isBookmarked: false,
    };
  } catch {
    return null;
  }
}

// ── Helpers DOM ─────────────────────────────────────────────────────────────

function getText(el, selector) {
  try {
    return el.querySelector(selector)?.textContent?.trim() || '';
  } catch {
    return '';
  }
}

function getTextNS(el, ns, tag) {
  try {
    const found = Array.from(el.children).find(
      c => c.localName === tag && (c.prefix === ns || c.namespaceURI?.includes(ns))
    );
    return found?.textContent?.trim() || '';
  } catch {
    return '';
  }
}

function extractThumbnail(item, descriptionHTML) {
  // 1. media:thumbnail ou media:content
  const mediaThumbnail = item.querySelector('thumbnail') || item.querySelector('content[medium="image"]');
  if (mediaThumbnail?.getAttribute('url')) return mediaThumbnail.getAttribute('url');

  // 2. enclosure image
  const enclosure = item.querySelector('enclosure[type^="image"]');
  if (enclosure?.getAttribute('url')) return enclosure.getAttribute('url');

  // 3. Première <img> dans le contenu HTML
  if (descriptionHTML) {
    const match = descriptionHTML.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }

  return null;
}

// ── Déduplication ───────────────────────────────────────────────────────────

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

// ── Utilitaires ─────────────────────────────────────────────────────────────

function stripHTML(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHTMLEntities(str) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = str;
  return textarea.value;
}

function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).length;
  const minutes = Math.ceil(words / 200);
  return Math.max(1, minutes);
}

// djb2 hash — simple, rapide, pas besoin de crypto
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit int
  }
  return (hash >>> 0).toString(36);
}
