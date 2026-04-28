// ui.js — Fonctions de rendu DOM

const CAT_META = {
  'Android':             { cls: 'cat-android', dot: 'dot-android', emoji: '🤖' },
  'iOS':                 { cls: 'cat-ios',     dot: 'dot-ios',     emoji: '🍎' },
  'QA / QC Mobile':      { cls: 'cat-qa',      dot: 'dot-qa',      emoji: '🔬' },
  'IA & Automatisation': { cls: 'cat-ai',      dot: 'dot-ai',      emoji: '🧠' },
  'Privacy & Légal':     { cls: 'cat-privacy', dot: 'dot-privacy',  emoji: '🔒' },
};

function catClass(cat) { return CAT_META[cat]?.cls  || 'cat-android'; }
function catEmoji(cat) { return CAT_META[cat]?.emoji || '📰'; }

// ── Temps relatif ─────────────────────────────────────────────────────────

function relativeTime(isoDate) {
  const s = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (s < 60)     return "à l'instant";
  if (s < 3600)   return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400)  return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 604800) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(isoDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// ── Échappement HTML ──────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(text, query) {
  if (!query || !text) return esc(text || '');
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

// ── Carte article ─────────────────────────────────────────────────────────

function renderArticleCard(article, searchQuery = '') {
  const cls          = catClass(article.category);
  const bookmarkCls  = article.isBookmarked ? ' bookmarked' : '';
  const readCls      = article.isRead ? ' read' : '';
  const safeTitle    = esc(article.title);
  const safeId       = esc(article.id);

  const thumb = article.thumbnail
    ? `<img class="article-thumbnail" src="${esc(article.thumbnail)}" alt="" loading="lazy"
           onerror="this.replaceWith(makePlaceholderThumb('${catEmoji(article.category)}'))">`
    : `<div class="article-thumbnail placeholder">${catEmoji(article.category)}</div>`;

  return `
    <div class="article-card${readCls}" data-id="${safeId}" data-url="${esc(article.url)}">

      ${!article.isRead ? '<div class="unread-dot"></div>' : '<div style="width:7px;flex-shrink:0"></div>'}

      ${thumb}

      <div class="article-body">
        <div class="article-source-row">
          <span class="source-name">${esc(article.sourceName)}</span>
          <span class="cat-pill ${cls}">${esc(article.subCategory)}</span>
        </div>
        <div class="article-title">${highlight(article.title, searchQuery)}</div>
        ${article.excerpt
          ? `<div class="article-excerpt">${highlight(article.excerpt, searchQuery)}</div>`
          : ''}
        <div class="article-meta">
          <span>${relativeTime(article.publishedAt)}</span>
          <span>·</span>
          <span>${article.readingTime} min</span>
          ${article.author ? `<span>·</span><span>${esc(article.author)}</span>` : ''}
        </div>
      </div>

      <div class="article-actions">
        <button class="action-btn not-interested-btn"
                title="Pas intéressé — bloquer ce sujet"
                data-id="${safeId}"
                data-title="${safeTitle}"
                onclick="event.stopPropagation(); App.notInterested(this.dataset.id, this.dataset.title)">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </button>
        <button class="action-btn bookmark-btn${bookmarkCls}"
                title="${article.isBookmarked ? 'Retirer le signet' : 'Sauvegarder'}"
                onclick="event.stopPropagation(); App.toggleBookmark('${safeId}')">
          ${article.isBookmarked ? '★' : '☆'}
        </button>
        <a class="action-btn" href="${esc(article.url)}" target="_blank" rel="noopener"
           title="Ouvrir l'article" onclick="event.stopPropagation()">↗</a>
      </div>
    </div>`;
}

function makePlaceholderThumb(emoji) {
  const div = document.createElement('div');
  div.className = 'article-thumbnail placeholder';
  div.textContent = emoji;
  return div;
}

// ── Skeletons ─────────────────────────────────────────────────────────────

function renderSkeletons(count = 6) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton" style="width:7px;height:7px;border-radius:50%;margin-top:5px;flex-shrink:0"></div>
      <div class="skeleton" style="width:64px;height:48px;border-radius:6px;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:6px">
          <div class="skeleton" style="width:80px;height:10px;border-radius:3px"></div>
          <div class="skeleton" style="width:50px;height:10px;border-radius:3px"></div>
        </div>
        <div class="skeleton" style="width:90%;height:14px;border-radius:3px"></div>
        <div class="skeleton" style="width:70%;height:14px;border-radius:3px"></div>
        <div style="display:flex;gap:6px">
          <div class="skeleton" style="width:60px;height:9px;border-radius:3px"></div>
          <div class="skeleton" style="width:40px;height:9px;border-radius:3px"></div>
        </div>
      </div>
    </div>`).join('');
}

// ── État vide / erreur ────────────────────────────────────────────────────

function renderEmptyState(type = 'empty') {
  const cfgs = {
    empty: {
      icon: `<svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>`,
      title: 'Aucun article',
      desc: 'Lance un rafraîchissement pour récupérer les derniers articles.',
      action: 'Rafraîchir', onclick: 'App.refresh()',
    },
    no_results: {
      icon: `<svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
      title: 'Aucun résultat',
      desc: 'Essaie d\'autres mots-clés, modifie tes filtres ou débloque des sujets.',
      action: 'Effacer les filtres', onclick: 'App.clearFilters()',
    },
    error: {
      icon: `<svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
      title: 'Erreur de chargement',
      desc: 'Impossible de récupérer les flux. Vérifie ta connexion.',
      action: 'Réessayer', onclick: 'App.refresh()',
    },
  };
  const cfg = cfgs[type] || cfgs.empty;
  return `<div class="list-state">${cfg.icon}<p><strong>${cfg.title}</strong></p><p>${cfg.desc}</p><button class="state-action" onclick="${cfg.onclick}">${cfg.action}</button></div>`;
}

// ── Sidebar catégories ────────────────────────────────────────────────────

function renderSidebarCategories(categories, activeCategory, unreadCounts) {
  const allCount = Object.values(unreadCounts).reduce((a, b) => a + b, 0);

  const allItem = `
    <div class="sidebar-item ${activeCategory === null ? 'active' : ''}" onclick="App.setCategory(null)">
      <svg class="item-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M3 12h18M3 6h18M3 18h18"/>
      </svg>
      <span class="item-label">Toutes les sources</span>
      ${allCount > 0 ? `<span class="unread-badge">${allCount}</span>` : ''}
    </div>`;

  const catItems = categories.map(cat => {
    const meta  = CAT_META[cat] || {};
    const count = unreadCounts[cat] || 0;
    return `
      <div class="sidebar-item ${activeCategory === cat ? 'active' : ''}"
           onclick="App.setCategory('${esc(cat)}')">
        <div class="cat-dot ${meta.dot || ''}"></div>
        <span class="item-label">${esc(cat)}</span>
        ${count > 0 ? `<span class="unread-badge">${count}</span>` : ''}
      </div>`;
  }).join('');

  return allItem + catItems;
}

// ── Toast ────────────────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Barre de progression ──────────────────────────────────────────────────

function setRefreshProgress(done, total) {
  const bar = document.getElementById('refresh-progress');
  if (!bar) return;
  if (done === 0 && total > 0) {
    bar.style.display = 'block';
    bar.style.width   = '5%';
  } else if (done >= total) {
    bar.style.width = '100%';
    setTimeout(() => { bar.style.display = 'none'; bar.style.width = '0'; }, 400);
  } else {
    bar.style.width = `${Math.round((done / total) * 95) + 5}%`;
  }
}
