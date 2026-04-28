// app.js — Contrôleur principal de l'application

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const App = (() => {
  // ── État ─────────────────────────────────────────────────────────────────

  let state = {
    articles:       [],       // tous les articles en mémoire
    filtered:       [],       // articles après filtre/tri/recherche
    activeCategory: null,
    sortBy:         'newest',
    viewMode:       'comfortable',
    hideRead:       false,
    showBookmarks:  false,
    searchQuery:    '',
    isRefreshing:   false,
    lastRefresh:    null,
  };

  // ── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    await applyTheme();
    await loadPrefs();
    renderSidebar();
    await loadFromStorage();

    if (state.articles.length === 0) {
      // Premier lancement : refresh automatique
      await refresh();
    } else {
      applyFilters();
      renderArticleList();

      // Refresh en arrière-plan si le dernier refresh date de plus de 30 min
      const prefs = await getAllPrefs();
      const lastRefresh = prefs.lastRefresh ? new Date(prefs.lastRefresh) : null;
      if (!lastRefresh || (Date.now() - lastRefresh.getTime()) > REFRESH_INTERVAL_MS) {
        refresh(true); // silencieux
      }
    }

    // Refresh automatique toutes les 30 min
    setInterval(() => refresh(true), REFRESH_INTERVAL_MS);

    // Raccourcis clavier
    document.addEventListener('keydown', handleKeyboard);

    // Recherche (debounce)
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', e => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          state.searchQuery = e.target.value.trim();
          applyFilters();
          renderArticleList();
        }, 250);
      });
    }
  }

  // ── Chargement depuis storage ─────────────────────────────────────────────

  async function loadFromStorage() {
    try {
      state.articles = await getAllArticles();
    } catch {
      state.articles = [];
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function refresh(silent = false) {
    if (state.isRefreshing) return;
    state.isRefreshing = true;

    const btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('loading');

    if (!silent) {
      document.getElementById('article-list').innerHTML = renderSkeletons(8);
    }

    setRefreshProgress(0, SOURCES.length);

    try {
      const articles = await fetchAllSources(SOURCES, (done, total) => {
        setRefreshProgress(done, total);
      });

      if (articles.length > 0) {
        await saveArticles(articles);
        await loadFromStorage();

        state.lastRefresh = new Date().toISOString();
        await setPref('lastRefresh', state.lastRefresh);

        applyFilters();
        renderArticleList();
        renderSidebar();

        if (!silent) {
          showToast(`${articles.length} articles récupérés`, 'success');
        }
      } else if (!silent) {
        showToast('Aucun article récupéré — vérifiez votre connexion', 'error');
        document.getElementById('article-list').innerHTML = renderEmptyState('error');
      }
    } catch (err) {
      console.error('[App] Erreur refresh:', err);
      if (!silent) {
        showToast('Erreur lors du rafraîchissement', 'error');
        document.getElementById('article-list').innerHTML = renderEmptyState('error');
      }
    } finally {
      state.isRefreshing = false;
      if (btn) btn.classList.remove('loading');
      setRefreshProgress(SOURCES.length, SOURCES.length);
    }
  }

  // ── Filtres et tri ────────────────────────────────────────────────────────

  function applyFilters() {
    let articles = [...state.articles];

    // Filtre catégorie
    if (state.activeCategory) {
      articles = articles.filter(a => a.category === state.activeCategory);
    }

    // Masquer lus
    if (state.hideRead) {
      articles = articles.filter(a => !a.isRead);
    }

    // Bookmarks uniquement
    if (state.showBookmarks) {
      articles = articles.filter(a => a.isBookmarked);
    }

    // Recherche
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      articles = articles.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.excerpt && a.excerpt.toLowerCase().includes(q)) ||
        a.sourceName.toLowerCase().includes(q)
      );
    }

    // Tri
    articles.sort((a, b) => {
      switch (state.sortBy) {
        case 'oldest':
          return new Date(a.publishedAt) - new Date(b.publishedAt);
        case 'source':
          return a.sourceName.localeCompare(b.sourceName, 'fr');
        case 'newest':
        default:
          return new Date(b.publishedAt) - new Date(a.publishedAt);
      }
    });

    state.filtered = articles;
  }

  // ── Rendu articles ────────────────────────────────────────────────────────

  function renderArticleList() {
    const list = document.getElementById('article-list');
    if (!list) return;

    if (state.filtered.length === 0) {
      const type = state.articles.length === 0 ? 'empty'
                 : (state.searchQuery || state.activeCategory) ? 'no_results'
                 : 'empty';
      list.innerHTML = renderEmptyState(type);
      return;
    }

    list.innerHTML = state.filtered
      .map(a => renderArticleCard(a, state.searchQuery))
      .join('');

    // Attacher les click handlers
    list.querySelectorAll('.article-card').forEach(card => {
      card.addEventListener('click', () => {
        const id  = card.dataset.id;
        const url = card.dataset.url;
        openArticle(id, url);
      });
    });
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────

  async function renderSidebar() {
    const container = document.getElementById('sidebar-categories');
    if (!container) return;

    // Calcul des compteurs non-lus par catégorie
    const unreadCounts = {};
    for (const cat of getAllCategories()) {
      unreadCounts[cat] = state.articles.filter(
        a => a.category === cat && !a.isRead
      ).length;
    }

    container.innerHTML = renderSidebarCategories(
      getAllCategories(),
      state.activeCategory,
      unreadCounts
    );

    // Stats
    const statsEl = document.getElementById('sidebar-stats');
    if (statsEl) {
      const total  = state.articles.length;
      const unread = state.articles.filter(a => !a.isRead).length;
      statsEl.textContent = `${total} articles · ${unread} non lus`;
    }

    // Dernière mise à jour
    const refreshEl = document.getElementById('last-refresh');
    if (refreshEl && state.lastRefresh) {
      refreshEl.textContent = `Màj ${relativeTime(state.lastRefresh)}`;
    }
  }

  // ── Actions utilisateur ───────────────────────────────────────────────────

  async function openArticle(id, url) {
    // Marquer comme lu
    await markAsRead(id);
    const article = state.articles.find(a => a.id === id);
    if (article) {
      article.isRead = true;
      applyFilters();
      renderArticleList();
      renderSidebar();
    }
    window.open(url, '_blank', 'noopener');
  }

  async function toggleBookmark(id) {
    const isNow = await toggleBookmarkStorage(id);
    const article = state.articles.find(a => a.id === id);
    if (article) {
      article.isBookmarked = isNow;
      applyFilters();
      renderArticleList();
    }
    showToast(isNow ? '★ Article sauvegardé' : 'Signet retiré', 'info', 2000);
  }

  function setCategory(category) {
    state.activeCategory = category;
    applyFilters();
    renderArticleList();
    renderSidebar();
  }

  function clearFilters() {
    state.activeCategory = null;
    state.hideRead = false;
    state.showBookmarks = false;
    state.searchQuery = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    applyFilters();
    renderArticleList();
    renderSidebar();
    updateToolbar();
  }

  function setSortBy(sort) {
    state.sortBy = sort;
    applyFilters();
    renderArticleList();
  }

  function toggleHideRead() {
    state.hideRead = !state.hideRead;
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
      const filter = chip.dataset.filter;
      if (filter === 'hideRead')  chip.classList.toggle('active', state.hideRead);
      if (filter === 'bookmarks') chip.classList.toggle('active', state.showBookmarks);
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
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await setPref('theme', next);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = next === 'dark' ? iconMoon() : iconSun();
  }

  // ── Prefs ─────────────────────────────────────────────────────────────────

  async function loadPrefs() {
    const prefs = await getAllPrefs();
    state.sortBy   = prefs.sortBy   || 'newest';
    state.viewMode = prefs.viewMode || 'comfortable';
    state.hideRead = prefs.hideRead || false;
    state.lastRefresh = prefs.lastRefresh;

    document.body.classList.toggle('view-compact', state.viewMode === 'compact');

    const sortEl = document.getElementById('sort-select');
    if (sortEl) sortEl.value = state.sortBy;
  }

  // ── Raccourcis clavier ────────────────────────────────────────────────────

  function handleKeyboard(e) {
    // Ignorer si focus dans un input
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    switch (e.key) {
      case 'r':
      case 'R':
        refresh();
        break;
      case 't':
      case 'T':
        toggleTheme();
        break;
      case '/':
        e.preventDefault();
        document.getElementById('search-input')?.focus();
        break;
      case 'Escape':
        document.getElementById('search-input')?.blur();
        clearFilters();
        break;
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
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebar-overlay');
    const isOpen   = sidebar.classList.contains('open');
    sidebar.classList.toggle('open', !isOpen);
    overlay.classList.toggle('show', !isOpen);
  }

  // ── Icons SVG inline ──────────────────────────────────────────────────────

  function iconMoon() {
    return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
    </svg>`;
  }

  function iconSun() {
    return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>`;
  }

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    init,
    refresh,
    setCategory,
    clearFilters,
    setSortBy,
    toggleHideRead,
    toggleBookmarksOnly,
    toggleBookmark,
    toggleTheme,
    toggleSidebar,
    setViewMode,
  };
})();

// Alias storage pour ne pas shadower
async function toggleBookmarkStorage(id) { return toggleBookmark(id); }

document.addEventListener('DOMContentLoaded', () => App.init());
