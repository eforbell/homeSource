'use strict';

(async function () {
  const activePage = document.body.dataset.navPage || 'dashboard';
  let navRole = document.body.dataset.navRole || 'parent';
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) {
      const me = await res.json();
      if (me?.role === 'kid' || me?.role === 'parent') {
        navRole = me.role;
        document.body.dataset.navRole = me.role;
      }
    }
  } catch {}

  const icons = {
    home: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10L10 3l7 7"/><path d="M5 8.5V16a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V8.5"/></svg>',
    folder: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a2 2 0 012-2h3.5l2 2H16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V5z"/></svg>',
    upload: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14V4M6 8l4-4 4 4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>',
    spark: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8L10 2z"/></svg>',
    search: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M14 14l4 4"/></svg>',
    shield: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L3 6v4c0 4.4 3 8.5 7 10 4-1.5 7-5.6 7-10V6l-7-4z"/></svg>',
    gear: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 1.5v2M10 16.5v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M1.5 10h2M16.5 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4"/></svg>'
  };

  const parentItems = [
    { id: 'dashboard',  label: 'Dashboard',  icon: 'home',   href: './' },
    { id: 'documents',  label: 'Documents',  icon: 'folder', href: 'documents.html' },
    { id: 'upload',     label: 'Upload',     icon: 'upload', href: 'upload.html' },
    { id: 'insights',   label: 'Insights',   icon: 'spark',  href: 'insights.html' },
    { id: 'search',     label: 'Search',     icon: 'search', href: 'search.html' },
    { id: 'import',     label: 'Import',     icon: 'upload', href: 'import.html' },
    { id: 'backup',     label: 'Backup',     icon: 'shield', href: 'backup.html' },
    { id: 'settings',   label: 'Settings',   icon: 'gear',   href: 'settings.html' }
  ];

  const kidItems = [
    { id: 'dashboard',  label: 'Dashboard',  icon: 'home',   href: './' },
    { id: 'documents',  label: 'My Docs',    icon: 'folder', href: 'documents.html' },
    { id: 'search',     label: 'Search',     icon: 'search', href: 'search.html' },
    { id: 'settings',   label: 'Settings',   icon: 'gear',   href: 'settings.html' }
  ];

  const allItems = navRole === 'kid' ? kidItems : parentItems;
  const mobileItems = allItems.slice(0, 4);
  const moreItems = allItems.slice(4);

  const sidebar = document.createElement('nav');
  sidebar.className = 'app-sidebar';
  sidebar.setAttribute('aria-label', 'Main navigation');

  const logoHTML = `<a href="./" class="nav-logo"><span class="nav-logo-icon">📁</span><span>Source</span></a>`;

  const sidebarItemsHTML = allItems.map((item, i) => {
    const active = item.id === activePage ? ' active' : '';
    return `<a href="${item.href}" class="nav-item${active}" data-nav="${item.id}">
      <span class="nav-icon">${icons[item.icon]}</span>
      <span class="nav-label">${item.label}</span>
    </a>`;
  }).join('');

  sidebar.innerHTML = logoHTML + '<div class="nav-items">' + sidebarItemsHTML + '</div>';

  const bottomBar = document.createElement('nav');
  bottomBar.className = 'app-bottom-bar';
  bottomBar.setAttribute('aria-label', 'Mobile navigation');

  const mobileHTML = mobileItems.map(item => {
    const active = item.id === activePage ? ' active' : '';
    return `<a href="${item.href}" class="nav-item${active}" data-nav="${item.id}">
      <span class="nav-icon">${icons[item.icon]}</span>
      <span class="nav-label">${item.label}</span>
    </a>`;
  }).join('');

  const moreSheet = document.createElement('div');
  moreSheet.className = 'more-sheet hidden';

  if (moreItems.length > 0) {
    const moreActive = moreItems.some(m => m.id === activePage) ? ' active' : '';
    const moreBtn = `<button class="nav-item nav-brand-mobile${moreActive}" id="more-nav-btn" aria-label="More">
      <span class="nav-brand-mark">📁</span>
      <span class="nav-label">More</span>
    </button>`;
    bottomBar.innerHTML = mobileHTML + moreBtn;

    moreSheet.innerHTML = `
      <div class="more-sheet-backdrop"></div>
      <div class="more-sheet-panel">
        <div class="more-sheet-brand">
          <span style="font-size:2rem">📁</span>
          <div>
            <div class="more-sheet-brand-title">Home Source</div>
            <div class="more-sheet-brand-copy">Insights, import, backup, settings</div>
          </div>
        </div>
        ${moreItems.map(item => {
          const active = item.id === activePage ? ' active' : '';
          return `<a href="${item.href}" class="more-sheet-item${active}">
            <span class="nav-icon">${icons[item.icon]}</span>
            <span>${item.label}</span>
          </a>`;
        }).join('')}
      </div>`;
  } else {
    bottomBar.innerHTML = mobileHTML;
  }

  document.body.insertBefore(sidebar, document.body.firstChild);
  document.body.appendChild(bottomBar);
  document.body.appendChild(moreSheet);
  document.body.classList.add('app-has-nav');

  const moreBtnEl = document.getElementById('more-nav-btn');
  if (moreBtnEl) {
    moreBtnEl.addEventListener('click', () => moreSheet.classList.toggle('hidden'));
    moreSheet.querySelector('.more-sheet-backdrop')?.addEventListener('click', () => moreSheet.classList.add('hidden'));
  }
})();
