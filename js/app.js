// app.js — Contrôleur principal
// Stratégie de fetch : lazy par catégorie (évite le rate-limit de rss2json)
// Chaque catégorie est fetchée à la demande et mise en cache 30 min.

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Mots-clés hors-sujet filtrés par défaut au premier chargement
const DEFAULT_BLOCKED_KEYWORDS = [
  'deal', 'deals', 'promo', 'offre', 'solde', 'remise', 'rabais',
  'bon plan', 'black friday', 'prime day',
  'voiture', 'vehicle', 'automobile', 'tesla', 'carplay',
  'unboxing', 'giveaway', 'concours',
];

// Compteur de génération : chaque nouveau fetchCategory l'incrémente.
// L'ancien fetch vérifie s'il est toujours courant avant chaque lot.
let _fetchGen = 0;

// ── Mots vides FR + EN pour extraction de mots-clés ────────────────────────
const STOP_WORDS = new Set([
  // FR
  'le','la','les','de','du','des','un','une','et','en','que','qui','dans','sur',
  'par','pour','avec','au','aux','ce','se','est','sont','ont','mais','ou','ne',
  'pas','plus','très','bien','tout','tous','cette','ces','leur','leurs','être',
  'avoir','faire','dire','quel','quelle','quels','quelles','dont','comme','plus',
  'encore','après','avant','sous','entre','vers','selon','depuis','lors','votre',
  'notre','vos','nos','même','aussi','peut','doit','faut','fait','lors','lors',
  // EN
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','do','does','did',
  'will','would','could','should','may','might','this','that','these','those',
  'not','no','new','more','about','how','what','when','where','who','why','its',
  'your','their','our','can','get','set','use','now','after','before','just',
  'also','some','than','then','into','over','here','there','which','while',
]);

function extractKeywords(title) {
  return title
    .toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûüçæœ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 3);
}

// ── App ─────────────────────────────────────────────────────────────────────

const App = (() => {
  let state = {
    articles:        [],
    filtered:        [],
    blockedKeywords: [],
    activeCategory:  null,
    sortBy:          'newest',
    viewMode:        'comfortable',
    hideRead:        false,
    showBookmarks:   false,
    searchQuery:     '',
    isRefreshing:    false,
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    await applyTheme();
    await loadPrefs();

    // Charger le cache IndexedDB
    state.articles        = await getAllArticles().catch(() => []);
    state.blockedKeywords = await getBlockedKeywords().catch(() => []);

    // Seeder les mots-clés hors-sujet par défaut au premier lancement
    const seeded = await getPref('defaultKeywordsSeeded').catch(() => false);
    if (!seeded) {
      state.blockedKeywords = await addBlockedKeywords(DEFAULT_BLOCKED_KEYWORDS);
      await setPref('defaultKeywordsSeeded', true);
    }

    applyFilters();
    await renderSidebar();
    renderArticleList();

    // Si aucune donnée : lancer le fetch de la première catégorie (Android)
    if (state.articles.length === 0) {
      await fetchCategory(getAllCategories()[0]);
    } else {
      // Refresh silencieux de la catégorie active si le cache est périmé
      const cat = state.activeCategory || getAllCategories()[0];
      if (await isCategoryStale(cat, CACHE_TTL_MS)) {
        fetchCategory(cat, true);
      }
    }

    document.addEventListener('keydown', handleKeyboard);

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', e => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          state.searchQuery = e.target.value.trim();
          applyFilters();
          renderArticleList();
        }, 250);
      });
    }
  }

  // ── Fetch par catégorie ───────────────────────────────────────────────────
  // Seules les sources de la catégorie demandée sont fetchées.
  // Ça divise par ~5 le nombre de requêtes envoyées à rss2json d'un coup.

  async function fetchCategory(category, silent = false) {
    // Incrémenter la génération : tout fetch précédent s'abandonnera au prochain lot
    const myGen = ++_fetchGen;

    const sources = category
      ? SOURCES.filter(s => s.active && s.feedUrl && s.category === category)
      : SOURCES.filter(s => s.active && s.feedUrl);

    const btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('loading');

    if (!silent) {
      document.getElementById('article-list').innerHTML = renderSkeletons(6);
    }

    setRefreshProgress(0, sources.length);

    try {
      const fresh = await fetchAllSources(
        sources,
        (done, total) => { if (myGen === _fetchGen) setRefreshProgress(done, total); },
        () => myGen !== _fetchGen   // shouldAbort : une génération plus récente a démarré
      );

      // Si une autre catégorie a pris le relais, on abandonne sans toucher l'UI
      if (myGen !== _fetchGen) return;

      if (fresh.length > 0) {
        await saveArticles(fresh);
        await setCategoryFetchTime(category || '__all__');
        state.articles = await getAllArticles();

        applyFilters();
        renderArticleList();
        await renderSidebar();

        if (!silent) showToast(`${fresh.length} articles récupérés`, 'success');
      } else if (!silent) {
        document.getElementById('article-list').innerHTML = renderEmptyState('error');
        showToast('Aucun article récupéré — vérifie ta connexion', 'error');
      }
    } catch (err) {
      if (myGen !== _fetchGen) return;
      console.error('[App] fetchCategory error:', err);
      if (!silent) document.getElementById('article-list').innerHTML = renderEmptyState('error');
    } finally {
      if (myGen === _fetchGen) {
        if (btn) btn.classList.remove('loading');
        setRefreshProgress(sources.length, sources.length);
      }
    }
  }

  // Bouton "Rafraîchir" : refresh la catégorie active uniquement
  async function refresh() {
    const cat = state.activeCategory;
    await fetchCategory(cat, false);
  }

  // ── Filtres ───────────────────────────────────────────────────────────────

  function applyFilters() {
    let articles = [...state.articles];

    // Filtre mots-clés bloqués
    if (state.blockedKeywords.length > 0) {
      articles = articles.filter(a => {
        const title = a.title.toLowerCase();
        return !state.blockedKeywords.some(kw => title.includes(kw));
      });
    }

    if (state.activeCategory) {
      articles = articles.filter(a => a.category === state.activeCategory);
    }

    if (state.hideRead) {
      articles = articles.filter(a => !a.isRead);
    }

    if (state.showBookmarks) {
      articles = articles.filter(a => a.isBookmarked);
    }

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      articles = articles.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.excerpt && a.excerpt.toLowerCase().includes(q)) ||
        a.sourceName.toLowerCase().includes(q)
      );
    }

    articles.sort((a, b) => {
      switch (state.sortBy) {
        case 'oldest': return new Date(a.publishedAt) - new Date(b.publishedAt);
        case 'source': return a.sourceName.localeCompare(b.sourceName, 'fr');
        default:       return new Date(b.publishedAt) - new Date(a.publishedAt);
      }
    });

    state.filtered = articles;
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────

  function renderArticleList() {
    const list = document.getElementById('article-list');
    if (!list) return;

    if (state.filtered.length === 0) {
      const type = state.articles.length === 0 ? 'empty'
                 : (state.searchQuery || state.activeCategory || state.blockedKeywords.length > 0)
                   ? 'no_results' : 'empty';
      list.innerHTML = renderEmptyState(type);
      return;
    }

    list.innerHTML = state.filtered
      .map(a => renderArticleCard(a, state.searchQuery))
      .join('');

    list.querySelectorAll('.article-card').forEach(card => {
      card.addEventListener('click', () => openArticle(card.dataset.id, card.dataset.url));
    });
  }

  async function renderSidebar() {
    const container = document.getElementById('sidebar-categories');
    if (!container) return;

    const unreadCounts = {};
    for (const cat of getAllCategories()) {
      unreadCounts[cat] = state.articles.filter(
        a => a.category === cat && !a.isRead &&
             !state.blockedKeywords.some(kw => a.title.toLowerCase().includes(kw))
      ).length;
    }

    container.innerHTML = renderSidebarCategories(
      getAllCategories(), state.activeCategory, unreadCounts
    );

    // Compteur global
    const statsEl = document.getElementById('sidebar-stats');
    if (statsEl) {
      const unread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
      statsEl.textContent = `${state.filtered.length || state.articles.length} articles · ${unread} non lus`;
    }

    // Mots-clés bloqués
    renderBlockedKeywords();
  }

  function renderBlockedKeywords() {
    const container = document.getElementById('blocked-keywords-section');
    if (!container) return;

    if (state.blockedKeywords.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="sidebar-divider"></div>
      <div class="sidebar-section">
        <div class="sidebar-section-title" style="display:flex;align-items:center;justify-content:space-between">
          Sujets filtrés
          <button onclick="App.clearAllBlockedKeywords()"
                  style="font-size:.65rem;color:var(--text-tertiary);cursor:pointer;text-transform:none;letter-spacing:0"
                  title="Tout supprimer">Effacer tout</button>
        </div>
        <div style="padding:4px 16px 8px;display:flex;flex-wrap:wrap;gap:5px">
          ${state.blockedKeywords.map(kw => `
            <span class="blocked-kw-chip" title="Cliquer pour débloquer"
                  onclick="App.unblockKeyword('${esc(kw)}')">
              ${esc(kw)} ×
            </span>`).join('')}
        </div>
      </div>`;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function openArticle(id, url) {
    await markAsRead(id);
    const a = state.articles.find(a => a.id === id);
    if (a) { a.isRead = true; applyFilters(); renderArticleList(); await renderSidebar(); }
    window.open(url, '_blank', 'noopener');
  }

  async function toggleBookmark(id) {
    const isNow = await toggleBookmark_storage(id);
    const a = state.articles.find(a => a.id === id);
    if (a) { a.isBookmarked = isNow; applyFilters(); renderArticleList(); }
    showToast(isNow ? '★ Sauvegardé' : 'Signet retiré', 'info', 2000);
  }

  // ── Pertinence ────────────────────────────────────────────────────────────

  async function notInterested(id, title) {
    const keywords = extractKeywords(title);
    if (keywords.length === 0) {
      showToast('Pas de mot-clé pertinent trouvé', 'info', 2000);
      return;
    }

    state.blockedKeywords = await addBlockedKeywords(keywords);
    applyFilters();
    renderArticleList();
    await renderSidebar();

    showToast(`🚫 Sujets bloqués : ${keywords.join(', ')}`, 'info', 4000);
  }

  async function unblockKeyword(word) {
    state.blockedKeywords = await removeBlockedKeyword(word);
    applyFilters();
    renderArticleList();
    await renderSidebar();
    showToast(`✓ "${word}" débloqué`, 'success', 2000);
  }

  async function clearAllBlockedKeywords() {
    await clearBlockedKeywords();
    state.blockedKeywords = [];
    applyFilters();
    renderArticleList();
    await renderSidebar();
    showToast('Tous les filtres de sujets supprimés', 'success', 2000);
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async function setCategory(category) {
    state.activeCategory = category;
    applyFilters();
    renderArticleList();
    await renderSidebar();

    // Fetch si aucun article pour cette catégorie ou cache périmé.
    // Le système de génération annule un éventuel fetch en cours proprement.
    const hasCategoryArticles = category === null
      ? state.articles.length > 0
      : state.articles.some(a => a.category === category);

    const isStale = await isCategoryStale(category || '__all__', CACHE_TTL_MS);

    if (!hasCategoryArticles || isStale) {
      // silent = true si on a déjà des articles à afficher (refresh en arrière-plan)
      fetchCategory(category, hasCategoryArticles);
    }
  }

  function clearFilters() {
    state.activeCategory = null;
    state.hideRead       = false;
    state.showBookmarks  = false;
    state.searchQuery    = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    applyFilters();
    renderArticleList();
    renderSidebar();
    updateToolbar();
  }

  function setSortBy(sort) {
    state.sortBy = sort;
    setPref('sortBy', sort);
    applyFilters();
    renderArticleList();
  }

  function toggleHideRead() {
    state.hideRead = !state.hideRead;
    setPref('hideRead', state.hideRead);
    applyFilters();
    renderArticleList();
    updateToolbar();
  }

  function toggleBookmarksOnly() {
    state.showBookmarks = !state.showBookmarks;
    applyFilters();
    renderArticleList();
    updateToolbar();
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    document.body.classList.toggle('view-compact', mode === 'compact');
    setPref('viewMode', mode);
    updateToolbar();
  }

  function updateToolbar() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
      if (chip.dataset.filter === 'hideRead')  chip.classList.toggle('active', state.hideRead);
      if (chip.dataset.filter === 'bookmarks') chip.classList.toggle('active', state.showBookmarks);
    });
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === state.viewMode);
    });
  }

  // ── Thème ─────────────────────────────────────────────────────────────────

  async function applyTheme() {
    const saved = await getPref('theme');
    const theme = saved === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : (saved || 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  }

  async function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await setPref('theme', next);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = next === 'dark' ? iconMoon() : iconSun();
  }

  // ── Prefs ─────────────────────────────────────────────────────────────────

  async function loadPrefs() {
    const prefs = await getAllPrefs().catch(() => ({}));
    state.sortBy   = prefs.sortBy   || 'newest';
    state.viewMode = prefs.viewMode || 'comfortable';
    state.hideRead = prefs.hideRead || false;

    document.body.classList.toggle('view-compact', state.viewMode === 'compact');

    const sortEl = document.getElementById('sort-select');
    if (sortEl) sortEl.value = state.sortBy;
  }

  // ── Raccourcis clavier ────────────────────────────────────────────────────

  function handleKeyboard(e) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    switch (e.key) {
      case 'r': case 'R': refresh(); break;
      case 't': case 'T': toggleTheme(); break;
      case '/': e.preventDefault(); document.getElementById('search-input')?.focus(); break;
      case 'Escape': document.getElementById('search-input')?.blur(); clearFilters(); break;
      case '1': setCategory(getAllCategories()[0]); break;
      case '2': setCategory(getAllCategories()[1]); break;
      case '3': setCategory(getAllCategories()[2]); break;
      case '4': setCategory(getAllCategories()[3]); break;
      case '5': setCategory(getAllCategories()[4]); break;
      case '0': setCategory(null); break;
    }
  }

  // ── Sidebar mobile ────────────────────────────────────────────────────────

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const isOpen  = sidebar.classList.contains('open');
    sidebar.classList.toggle('open', !isOpen);
    overlay.classList.toggle('show', !isOpen);
  }

  // ── SVG icons ─────────────────────────────────────────────────────────────

  function iconMoon() {
    return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
  }
  function iconSun() {
    return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  }

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    init, refresh, setCategory, clearFilters,
    setSortBy, toggleHideRead, toggleBookmarksOnly,
    toggleBookmark, toggleTheme, toggleSidebar, setViewMode,
    notInterested, unblockKeyword, clearAllBlockedKeywords,
  };
})();

// Alias pour éviter le conflit de nom avec storage.js
async function toggleBookmark_storage(id) { return toggleBookmark(id); }

document.addEventListener('DOMContentLoaded', () => App.init());
