// storage.js — Persistance via IndexedDB (localforage)
// Gère : articles, états lu/bookmark, préférences utilisateur, cache

const DB_ARTICLES   = localforage.createInstance({ name: 'veilleqc', storeName: 'articles' });
const DB_PREFS      = localforage.createInstance({ name: 'veilleqc', storeName: 'prefs' });

// ── Articles ────────────────────────────────────────────────────────────────

async function saveArticles(articles) {
  // Merge avec les états existants (lu, bookmark) pour ne pas les écraser
  const ops = articles.map(async article => {
    const existing = await DB_ARTICLES.getItem(article.id);
    const merged = {
      ...article,
      isRead:       existing?.isRead       ?? false,
      isBookmarked: existing?.isBookmarked ?? false,
    };
    return DB_ARTICLES.setItem(article.id, merged);
  });
  await Promise.all(ops);
}

async function getAllArticles() {
  const articles = [];
  await DB_ARTICLES.iterate(value => { articles.push(value); });
  return articles;
}

async function getArticle(id) {
  return DB_ARTICLES.getItem(id);
}

async function markAsRead(id) {
  const article = await DB_ARTICLES.getItem(id);
  if (article) {
    article.isRead = true;
    await DB_ARTICLES.setItem(id, article);
  }
}

async function markAllAsRead(ids) {
  await Promise.all(ids.map(id => markAsRead(id)));
}

async function toggleBookmark(id) {
  const article = await DB_ARTICLES.getItem(id);
  if (!article) return false;
  article.isBookmarked = !article.isBookmarked;
  await DB_ARTICLES.setItem(id, article);
  return article.isBookmarked;
}

async function clearOldArticles(olderThanDays = 30) {
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  const toDelete = [];
  await DB_ARTICLES.iterate((value, key) => {
    const ts = new Date(value.fetchedAt).getTime();
    if (ts < cutoff && !value.isBookmarked) toDelete.push(key);
  });
  await Promise.all(toDelete.map(k => DB_ARTICLES.removeItem(k)));
  return toDelete.length;
}

// ── Préférences ─────────────────────────────────────────────────────────────

const PREF_DEFAULTS = {
  theme: 'dark',          // 'dark' | 'light' | 'system'
  lastRefresh: null,
  activeCategory: null,   // null = toutes
  activeSubCategory: null,
  sortBy: 'newest',       // 'newest' | 'oldest' | 'source'
  viewMode: 'comfortable', // 'comfortable' | 'compact'
  hideRead: false,
  showBookmarksOnly: false,
  searchQuery: '',
};

async function getPref(key) {
  const val = await DB_PREFS.getItem(key);
  return val !== null ? val : PREF_DEFAULTS[key];
}

async function setPref(key, value) {
  return DB_PREFS.setItem(key, value);
}

async function getAllPrefs() {
  const prefs = { ...PREF_DEFAULTS };
  await DB_PREFS.iterate((value, key) => {
    if (key in prefs) prefs[key] = value;
  });
  return prefs;
}

// ── Stats rapides ────────────────────────────────────────────────────────────

async function getUnreadCount(category = null) {
  let count = 0;
  await DB_ARTICLES.iterate(a => {
    if (!a.isRead && (category === null || a.category === category)) count++;
  });
  return count;
}

async function getArticleCount() {
  return DB_ARTICLES.length();
}
