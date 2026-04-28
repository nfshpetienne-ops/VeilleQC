// storage.js — Persistance via IndexedDB (localforage)
// Gère : articles, états lu/bookmark, préférences, mots-clés bloqués

const DB_ARTICLES = localforage.createInstance({ name: 'veilleqc', storeName: 'articles' });
const DB_PREFS    = localforage.createInstance({ name: 'veilleqc', storeName: 'prefs' });
const DB_KEYWORDS = localforage.createInstance({ name: 'veilleqc', storeName: 'keywords' });

// ── Articles ────────────────────────────────────────────────────────────────

async function saveArticles(articles) {
  const ops = articles.map(async article => {
    const existing = await DB_ARTICLES.getItem(article.id);
    return DB_ARTICLES.setItem(article.id, {
      ...article,
      isRead:       existing?.isRead       ?? false,
      isBookmarked: existing?.isBookmarked ?? false,
    });
  });
  await Promise.all(ops);
}

async function getAllArticles() {
  const articles = [];
  await DB_ARTICLES.iterate(value => { articles.push(value); });
  return articles;
}

async function markAsRead(id) {
  const a = await DB_ARTICLES.getItem(id);
  if (a) { a.isRead = true; await DB_ARTICLES.setItem(id, a); }
}

async function toggleBookmark(id) {
  const a = await DB_ARTICLES.getItem(id);
  if (!a) return false;
  a.isBookmarked = !a.isBookmarked;
  await DB_ARTICLES.setItem(id, a);
  return a.isBookmarked;
}

// ── Préférences ─────────────────────────────────────────────────────────────

const PREF_DEFAULTS = {
  theme:       'dark',
  sortBy:      'newest',
  viewMode:    'comfortable',
  hideRead:    false,
};

async function getPref(key)         { const v = await DB_PREFS.getItem(key); return v !== null ? v : (PREF_DEFAULTS[key] ?? null); }
async function setPref(key, value)  { return DB_PREFS.setItem(key, value); }

async function getAllPrefs() {
  const prefs = { ...PREF_DEFAULTS };
  await DB_PREFS.iterate((v, k) => { prefs[k] = v; });
  return prefs;
}

// ── Timestamps de fetch par catégorie ────────────────────────────────────────
// Clé : "lastFetch_Android", "lastFetch_iOS", etc.

async function getCategoryFetchTime(category) {
  const v = await DB_PREFS.getItem(`lastFetch_${category}`);
  return v ? new Date(v) : null;
}

async function setCategoryFetchTime(category) {
  return DB_PREFS.setItem(`lastFetch_${category}`, new Date().toISOString());
}

async function isCategoryStale(category, maxAgeMs = 30 * 60 * 1000) {
  const last = await getCategoryFetchTime(category);
  if (!last) return true; // jamais fetchée
  return (Date.now() - last.getTime()) > maxAgeMs;
}

// ── Mots-clés bloqués ────────────────────────────────────────────────────────

async function getBlockedKeywords() {
  const kw = await DB_KEYWORDS.getItem('blocked');
  return Array.isArray(kw) ? kw : [];
}

async function addBlockedKeywords(words) {
  const current = await getBlockedKeywords();
  const merged  = [...new Set([...current, ...words.map(w => w.toLowerCase())])];
  await DB_KEYWORDS.setItem('blocked', merged);
  return merged;
}

async function removeBlockedKeyword(word) {
  const current = await getBlockedKeywords();
  const next    = current.filter(w => w !== word.toLowerCase());
  await DB_KEYWORDS.setItem('blocked', next);
  return next;
}

async function clearBlockedKeywords() {
  await DB_KEYWORDS.setItem('blocked', []);
}
