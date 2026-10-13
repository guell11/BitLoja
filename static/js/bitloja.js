(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const idOf = value => Math.max(0, Math.trunc(num(value)));
  const dateText = value => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString('pt-BR') : '—';
  };
  const short = (value, length = 18) => {
    const text = String(value || '');
    return text.length > length ? `${text.slice(0, Math.ceil(length / 2))}…${text.slice(-Math.floor(length / 2))}` : text;
  };
  const productPhotos = {
    headset: '/static/assets/products/headset.webp',
    keyboard: '/static/assets/products/keyboard.webp',
    ssd: '/static/assets/products/ssd.webp',
    watch: '/static/assets/products/watch.webp',
    backpack: '/static/assets/products/backpack.webp',
    lamp: '/static/assets/products/lamp.webp',
    bottle: '/static/assets/products/bottle.webp',
    organizer: '/static/assets/products/organizer.webp'
  };
  const statusLabels = {
    awaiting_payment: 'Aguardando pagamento', partial: 'Pagamento parcial', paid: 'Pago',
    processing: 'Em preparação', shipped: 'Enviado', completed: 'Concluído',
    cancelled: 'Cancelado', refunded: 'Reembolsado', under_review: 'Em disputa',
    resolved: 'Resolvida', draft: 'Rascunho', awaiting_signature: 'Assinatura pendente',
    partially_signed: 'Parcialmente assinada', ready_to_broadcast: 'Pronta para transmissão',
    broadcast: 'Transmitida', signed: 'Assinada', demo: 'Demonstração', offline: 'Offline',
    unconfigured: 'Não configurada'
  };
  const state = {
    csrf: '', user: null, products: [], stores: [], cartCount: 0, cart: null,
    admin: null, seller: null, sellerTab: 'overview', adminTab: 'overview',
    activeView: 'home', currentProduct: null, notifications: [], unreadCount: 0,
    wallet: null, custody: null, searchOpen: false, mobileMenuOpen: false,
    authRole: 'buyer', modalReturnFocus: null,
    checkoutDraft: null, checkoutOrders: [], checkoutPending: false, checkoutStep: 'delivery', checkoutRequest: 0,
    accountOrders: [], accountSearch: '', accountStatus: 'all', accountRequest: 0, productRequest: 0, sessionVersion: 0,
    notificationsFilter: 'all', notificationsLoading: false, notificationsWriting: false, notificationsHasMore: false,
    notificationsCursor: 0, notificationsReturn: null, notificationsRequest: 0,
    treasuryFilter: 'all', treasurySearch: ''
  };
  const config = {
    btcMode: document.body.dataset.btcMode || 'demo',
    btcNetwork: document.body.dataset.btcNetwork || 'testnet',
    custodyMode: 'demo', lightningMode: 'off', commissionSigningMode: 'offline'
  };

  function productImage(product) {
    const text = String(product?.name || '').trim().toLocaleLowerCase('pt-BR');
    const key = {
      'headset gamer orbit x': 'headset', 'teclado mecânico neon 75%': 'keyboard',
      'ssd nvme 1 tb': 'ssd', 'smartwatch pulse pro': 'watch', 'mochila urbana vault': 'backpack',
      'luminária halo desk': 'lamp', 'garrafa térmica block 750': 'bottle', 'organizador modular grid': 'organizer'
    }[text];
    const fallback = productPhotos[key] || '';
    return safeImage(product?.image_url) || fallback;
  }

  async function api(path, options = {}) {
    const sessionVersion = state.sessionVersion;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('X-CSRF-Token', state.csrf);
      if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
    const response = await fetch(path, { credentials: 'same-origin', ...options, method, headers });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
    if (sessionVersion !== state.sessionVersion) throw new Error('Sessão atualizada. Consulte dados novamente.');
    if (!response.ok) {
      const message = typeof data === 'object' && data ? data.error || data.message : data;
      throw new Error(message || `Erro ${response.status}`);
    }
    return data;
  }

  async function download(path, fallbackName) {
    const sessionVersion = state.sessionVersion;
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'X-CSRF-Token': state.csrf } });
    if (sessionVersion !== state.sessionVersion) throw new Error('Sessão atualizada. Consulte dados novamente.');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (sessionVersion !== state.sessionVersion) throw new Error('Sessão atualizada. Consulte dados novamente.');
      throw new Error(body.error || `Erro ${response.status}`);
    }
    const disposition = response.headers.get('content-disposition') || '';
    const matchedName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const blob = await response.blob();
    if (sessionVersion !== state.sessionVersion) throw new Error('Sessão atualizada. Consulte dados novamente.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = matchedName || fallbackName || 'arquivo.psbt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadText(text, filename) {
    if (!text) { toast('PSBT indisponível.', 'error'); return; }
    const blob = new Blob([String(text)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'arquivo.psbt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function toast(message, type = 'success') {
    const stack = $('#toastStack');
    const item = document.createElement('div');
    item.className = `toast ${type === 'error' ? 'error' : 'success'}`;
    const heading = document.createElement('strong');
    heading.textContent = type === 'error' ? 'Erro' : 'Concluído';
    const body = document.createElement('div');
    body.textContent = String(message || '');
    item.append(heading, body);
    stack.append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  function setLoading(element, message = 'Carregando…') {
    if (element) element.innerHTML = `<div class="empty"><i class="bi bi-arrow-repeat" aria-hidden="true"></i><p>${esc(message)}</p></div>`;
  }

  function statusTag(status) {
    const normalized = String(status || '');
    return `<span class="status ${esc(normalized)}">${esc(statusLabels[normalized] || normalized || '—')}</span>`;
  }

  function stars(rating) {
    const count = Math.max(0, Math.min(5, Math.round(num(rating))));
    return `<span class="stars" aria-label="Nota ${esc(rating || 0)} de 5">${Array.from({ length: 5 }, (_, i) => `<i class="bi ${i < count ? 'bi-star-fill' : 'bi-star'}" aria-hidden="true"></i>`).join('')}</span>`;
  }

  function syncFinancialShell(view) {
    const page = $(`#${view}View`);
    if (!page) return false;
    const role = state.user?.role || 'buyer';
    const dashboardRole = ['seller', 'admin'].includes(role);
    page.classList.toggle('dashboard-page', dashboardRole);
    page.classList.toggle('financial-page--dashboard', dashboardRole);
    page.classList.toggle('financial-page--buyer', !dashboardRole);
    $$('[data-financial-role]', page).forEach(group => {
      group.classList.toggle('hidden', group.dataset.financialRole !== role);
    });
    $$('[data-financial-name]', page).forEach(element => { element.textContent = state.user?.name || 'Conta'; });
    $$('[data-financial-email]', page).forEach(element => { element.textContent = state.user?.email || ''; });
    const context = $('[data-financial-context]', page);
    if (context) context.textContent = view === 'wallet' ? 'Carteira Bitcoin' : 'Pagamentos Bitcoin';
    const kicker = $('[data-financial-kicker]', page);
    if (kicker) kicker.textContent = role === 'admin' ? 'Administração · controle' : role === 'seller' ? 'Painel do vendedor' : '';
    const nav = $('[data-financial-nav]', page);
    nav?.setAttribute('aria-label', role === 'admin' ? 'Navegação administrativa' : role === 'seller' ? 'Navegação do vendedor' : 'Navegação financeira');
    $$('.dashboard-nav-link', page).forEach(link => {
      const active = link.dataset.view === view
        || (view === 'seller' && role === 'seller' && link.dataset.sellerTab === state.sellerTab)
        || (view === 'admin' && role === 'admin' && link.dataset.adminTab === state.adminTab);
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    return dashboardRole;
  }

  function showView(name, { scroll = true } = {}) {
    const target = $(`#${name}View`);
    if (!target) return;
    if (['account', 'wallet', 'custody', 'seller', 'admin', 'checkout', 'notifications'].includes(name) && !state.user) {
      openAuth('login');
      return;
    }
    if (name === 'seller' && state.user?.role !== 'seller') {
      sellAction();
      return;
    }
    if (name === 'admin' && state.user?.role !== 'admin') {
      toast('Painel disponível para a conta administrativa.', 'error');
      showView('home');
      return;
    }
    $$('#main > .page').forEach(page => page.classList.toggle('hidden', page !== target));
    state.activeView = name;
    const isFinancialView = ['wallet', 'custody'].includes(name);
    const financialDashboard = isFinancialView ? syncFinancialShell(name) : false;
    const isDashboard = ['seller', 'admin'].includes(name) || financialDashboard;
    $('#siteHeader').classList.toggle('hidden', isDashboard);
    $$('.nav-link[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === name));
    $$('.dashboard-nav-link[data-view]').forEach(link => {
      const active = link.dataset.view === name;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('#siteFooter').classList.toggle('hidden', isDashboard);
    closeMobileMenu();
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
    if (name === 'catalog') loadProducts();
    if (name === 'reviews') loadReviews();
    if (name === 'account') loadAccount();
    if (name === 'cart') loadCart();
    if (name === 'wallet') loadWallet();
    if (name === 'custody') loadCustody();
    if (name === 'seller') loadSeller();
    if (name === 'admin') loadAdmin();
  }

  function renderSession() {
    const label = $('#accountLabel');
    const accountName = String(state.user?.name || 'Conta').trim() || 'Conta';
    label.textContent = state.user ? accountName.split(/\s+/)[0] : 'Entrar';
    $$('[data-action="account-menu"]').forEach(button => {
      button.setAttribute('aria-label', state.user ? `Abrir conta de ${accountName}` : 'Entrar');
      button.setAttribute('aria-haspopup', 'dialog');
    });
    $('#cartBadge').textContent = String(state.cartCount || 0);
    $('#cartBtn').classList.toggle('hidden', !state.user);
    $('#notificationsBtn').classList.toggle('hidden', !state.user);
    const shop = $('#headerShopBtn');
    shop.textContent = state.user?.role === 'seller' ? 'Minha loja' : state.user?.role === 'admin' ? 'Painel admin' : 'Abrir minha loja';
    const badge = $('#notificationBadge');
    badge.classList.toggle('hidden', !state.unreadCount);
    badge.textContent = state.unreadCount ? String(state.unreadCount) : '';
    badge.setAttribute('aria-label', `${state.unreadCount} notificações não lidas`);
    $('#sellerTopLabel').textContent = state.user?.name || 'Conta';
    $('#adminTopLabel').textContent = state.user?.name || 'Conta';
    $('#sellerIdentity').innerHTML = state.user ? `<strong>${esc(state.user.name)}</strong><small>${esc(state.user.email)}</small>` : '';
    $('#adminIdentity').innerHTML = state.user ? `<strong>${esc(state.user.name)}</strong><small>${esc(state.user.email)}</small>` : '';
  }

  function renderNetwork() {
    const mode = config.btcMode || 'demo';
    const network = config.btcNetwork || 'testnet';
    const heroRuntime = $('#heroRuntime');
    if (heroRuntime) heroRuntime.textContent = `REDE ${network} · ${mode}`;
    const lightningStatus = $('#howLightningStatus');
    if (lightningStatus) lightningStatus.textContent = config.lightningMode === 'off' ? 'Lightning está desativado neste servidor.' : `Modo atual: ${config.lightningMode}.`;
  }

  function resetPrivateState() {
    state.sessionVersion += 1;
    state.checkoutRequest += 1;
    state.notificationsRequest += 1;
    state.accountRequest += 1;
    state.checkoutDraft = null;
    state.checkoutOrders = [];
    state.checkoutPending = false;
    state.checkoutStep = 'delivery';
    state.accountOrders = [];
    state.accountSearch = '';
    state.accountStatus = 'all';
    state.notifications = [];
    state.notificationsFilter = 'all';
    state.notificationsLoading = false;
    state.notificationsWriting = false;
    state.notificationsHasMore = false;
    state.notificationsCursor = 0;
    state.notificationsReturn = null;
    state.unreadCount = 0;
    state.cart = null;
    state.cartCount = 0;
    state.wallet = null;
    state.custody = null;
    state.seller = null;
    state.admin = null;
    state.sellerTab = 'overview';
    state.adminTab = 'overview';
    state.treasurySearch = '';
    state.treasuryFilter = 'all';
    ['accountContent', 'checkoutContent', 'notificationsContent', 'walletContent', 'custodyContent', 'sellerContent', 'adminContent', 'cartLines', 'cartSummary'].forEach(id => $(`#${id}`)?.replaceChildren());
    $$('[data-financial-name]').forEach(element => { element.textContent = 'Conta'; });
    $$('[data-financial-email]').forEach(element => { element.textContent = ''; });
  }

  async function bootstrap() {
    try {
      const data = await api('/api/bootstrap');
      state.csrf = data.csrf_token || '';
      if (idOf(state.user?.id) !== idOf(data.user?.id)) resetPrivateState();
      state.user = data.user || null;
      state.cartCount = idOf(data.cart_count);
      config.btcMode = data.btc_mode || config.btcMode;
      config.btcNetwork = data.btc_network || data.network || config.btcNetwork;
      config.custodyMode = data.custody_mode || 'demo';
      config.lightningMode = data.lightning_mode || 'off';
      config.commissionSigningMode = data.commission_signing_mode || 'offline';
      renderSession();
      renderNetwork();
      await Promise.all([loadProducts(), loadStores()]);
      if (state.user) refreshNotificationBadge();
    } catch (error) {
      renderSession();
      toast(error.message, 'error');
      await Promise.all([loadProducts(), loadStores()]);
    }
  }

  function renderProductCard(product) {
    const id = idOf(product.id);
    const image = productImage(product);
    const fallback = productImage({ ...product, image_url: '' });
    const stock = num(product.stock);
    const reviewCount = idOf(product.review_count);
    const rating = num(product.rating);
    const compare = num(product.compare_at_sats) > num(product.price_sats);
    const imageMarkup = image
      ? `<img class="product-image" data-image-context="card" src="${esc(image)}"${fallback && fallback !== image ? ` data-fallback="${esc(fallback)}"` : ''} alt="${esc(product.name)}" loading="lazy">`
      : `<img class="product-image is-missing" data-image-context="card" alt="${esc(product.name)}" loading="lazy">`;
    return `<article class="product-card" data-product-card="${id}">
      <div class="product-media"><button class="product-open" type="button" data-action="open-product" data-id="${id}" aria-label="Ver ${esc(product.name)}">${imageMarkup}</button></div>
      <div class="product-info"><span class="product-store">${esc(product.store_name || 'Loja')}</span><strong class="product-name">${esc(product.name)}</strong>
        ${reviewCount ? `<span class="product-rating">${stars(rating)} <span>${rating.toFixed(1)} · ${reviewCount}</span></span>` : '<span class="product-rating empty-rating">Sem avaliações</span>'}
        <div class="product-bottom"><span>${compare ? `<span class="old-price">₿ ${esc(product.compare_at_btc)}</span>` : ''}<strong class="product-price">₿ ${esc(product.price_btc)}</strong><span class="product-stock ${stock < 1 ? 'out' : ''}">${stock > 0 ? `${stock} em estoque` : 'Indisponível'}</span></span><button class="product-add" type="button" data-action="add-cart" data-id="${id}" aria-label="Adicionar ${esc(product.name)} ao carrinho" ${stock < 1 ? 'disabled' : ''}><i class="bi bi-bag-plus" aria-hidden="true"></i></button></div>
      </div>
    </article>`;
  }

  function filterProducts(products) {
    const min = $('#priceMin')?.value === '' ? null : num($('#priceMin')?.value);
    const max = $('#priceMax')?.value === '' ? null : num($('#priceMax')?.value);
    const availableOnly = $('#inStockFilter')?.checked;
    return products.filter(product => {
      const price = num(product.price_btc);
      if (min !== null && price < min) return false;
      if (max !== null && price > max) return false;
      if (availableOnly && num(product.stock) < 1) return false;
      return true;
    });
  }

  function renderProducts() {
    const filtered = filterProducts(state.products);
    const featured = filtered.slice(0, 4);
    $('#productGrid').innerHTML = featured.length ? featured.map(renderProductCard).join('') : '<div class="empty">Nenhum produto cadastrado.</div>';
    $('#catalogGrid').innerHTML = filtered.length ? filtered.map(renderProductCard).join('') : '<div class="empty">Nenhum produto corresponde aos filtros.</div>';
    $('#catalogResultCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'produto' : 'produtos'}`;
  }

  async function loadProducts() {
    const focusRoot = [$('#catalogGrid'), $('#productGrid')].find(isVisibleFocusTarget) || $('#catalogGrid') || $('#productGrid');
    const previousFocus = captureFocusTarget();
    const search = String($('#searchInput')?.value || '').trim();
    const category = String($('#categoryFilter')?.value || '');
    const sort = String($('#sortFilter')?.value || 'featured');
    if ($('#productGrid')) setLoading($('#productGrid'), 'Carregando produtos');
    if ($('#catalogGrid')) setLoading($('#catalogGrid'), 'Carregando produtos');
    try {
      const query = new URLSearchParams({ q: search, category, sort });
      const data = await api(`/api/products?${query}`);
      state.products = Array.isArray(data.products) ? data.products : [];
      const select = $('#categoryFilter');
      if (select) {
        const selected = category;
        select.innerHTML = '<option value="">Todas as categorias</option>' + (data.categories || []).map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
        select.value = selected;
        const categoryNav = $('#categoryNav');
        if (categoryNav) categoryNav.innerHTML = `<button class="category-link ${selected ? '' : 'active'}" type="button" data-category="">Todos os produtos</button>` + (data.categories || []).map(value => `<button class="category-link ${selected === value ? 'active' : ''}" type="button" data-category="${esc(value)}">${esc(value)}</button>`).join('');
      }
      renderProducts();
    } catch (error) {
      for (const id of ['productGrid', 'catalogGrid']) {
        const grid = $(`#${id}`);
        if (grid) grid.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`;
      }
    } finally {
      focusUpdatedContent(focusRoot, previousFocus);
    }
  }

  function renderStoreCard(store) {
    const id = idOf(store.id);
    const logo = safeImage(store.logo_url);
    const banner = safeImage(store.banner_url);
    return `<article class="store-card" data-store-card="${id}">
      <button class="store-open" type="button" data-action="open-store" data-id="${id}" aria-label="Abrir loja ${esc(store.name)}">
        <span class="store-cover" ${banner ? `style="background-image:url('${esc(banner)}')"` : ''}></span>
        <span class="store-logo">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : `<span>${esc(String(store.name || 'L').slice(0, 1).toUpperCase())}</span>`}</span>
        <span class="store-card-copy"><strong>${esc(store.name)}</strong><span>${esc(store.description || 'Loja do marketplace')}</span>
        <span class="store-meta">${num(store.review_count) ? `${stars(store.rating)} ${num(store.rating).toFixed(1)} · ${idOf(store.review_count)} avaliações` : 'Sem avaliações registradas'}</span></span>
      </button>
    </article>`;
  }

  function safeImage(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    if (candidate.startsWith('/static/')) return candidate;
    try {
      const url = new URL(candidate, location.origin);
      return url.protocol === 'https:' || url.origin === location.origin ? url.href : '';
    } catch (_) { return ''; }
  }

  function markProductImageMissing(image) {
    const context = image.dataset.imageContext;
    const label = image.dataset.imageLabel || image.alt || '';
    image.removeAttribute('src');
    image.removeAttribute('data-fallback');
    image.removeAttribute('data-fallback-attempted');
    if (context === 'card' || image.closest('.product-media')) {
      image.classList.add('is-missing');
      return;
    }
    const icon = document.createElement('i');
    icon.className = context === 'stock' ? 'bi bi-box-seam' : 'bi bi-image';
    icon.setAttribute('aria-hidden', 'true');
    if (context === 'detail') {
      const placeholder = document.createElement('div');
      placeholder.className = 'product-image-empty';
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', `Imagem não cadastrada${label ? ` para ${label}` : ''}`);
      const caption = document.createElement('span');
      caption.textContent = 'Imagem não cadastrada';
      placeholder.append(icon, caption);
      image.replaceWith(placeholder);
      return;
    }
    const container = context === 'cart' ? image.closest('.cart-thumb') : context === 'stock' ? image.closest('.stock-thumb') : null;
    if (container) {
      container.setAttribute('role', 'img');
      container.setAttribute('aria-label', `Imagem não cadastrada${label ? ` para ${label}` : ''}`);
      if (context === 'cart') container.classList.add('cart-thumb-empty');
      if (context === 'stock') container.classList.add('stock-thumb-empty');
      image.replaceWith(icon);
      return;
    }
    image.classList.add('is-missing');
  }

  async function loadStores() {
    const root = $('#storeGrid');
    const previousFocus = captureFocusTarget();
    if (root) setLoading(root, 'Carregando lojas');
    try {
      const data = await api('/api/stores');
      state.stores = Array.isArray(data.stores) ? data.stores : [];
      if (root) root.innerHTML = state.stores.length ? state.stores.map(renderStoreCard).join('') : '<div class="empty">Nenhuma loja cadastrada.</div>';
    } catch (error) {
      if (root) root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`;
    } finally {
      focusUpdatedContent(root, previousFocus);
    }
  }

  function openModal(title, body, wide = false) {
    const root = $('#modalRoot');
    if (!root.querySelector('.modal')) {
      state.modalReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    }
    root.innerHTML = `<div class="modal-wrap"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="activeModalTitle" tabindex="-1"><header class="modal-head"><h2 id="activeModalTitle">${esc(title)}</h2><button class="modal-close" type="button" data-action="close-modal" aria-label="Fechar"><i class="bi bi-x-lg" aria-hidden="true"></i></button></header><div class="modal-body">${body}</div></section></div>`;
    const wrap = $('.modal-wrap', root);
    wrap.addEventListener('click', event => { if (event.target === wrap) closeModal(); });
    const first = $('input:not([type="hidden"]), select, textarea, button, a[href]', wrap);
    (first || $('.modal', wrap)).focus();
  }

  function closeModal({ restoreFocus = true } = {}) {
    const returnFocus = state.modalReturnFocus;
    $('#modalRoot').replaceChildren();
    state.modalReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  }

  function openAuth(tab = 'login', role = 'buyer') {
    state.authRole = role === 'seller' ? 'seller' : 'buyer';
    const body = `<div class="auth-layout">
      <aside class="auth-visual" aria-label="Acesso à BitLoja">
        <a class="auth-brand" href="/" data-action="auth-home" aria-label="BitLoja — início"><span class="brand-mark" aria-hidden="true"><i class="bi bi-box-seam"></i></span><span>BitLoja</span></a>
        <div class="auth-visual-copy"><p class="auth-kicker">ACESSO AO MARKETPLACE</p><h2>Sua conta.<br>Seus pedidos.</h2><p>${tab === 'register' ? 'Compre, acompanhe suas entregas ou abra sua loja.' : 'Acompanhe pagamentos, mensagens e entregas.'}</p></div>
        <img class="auth-art" src="/static/assets/bitcoin-bag.webp" alt="" aria-hidden="true">
        <button class="auth-back" type="button" data-action="close-modal"><i class="bi bi-arrow-left" aria-hidden="true"></i> Voltar à loja</button>
      </aside>
      <div class="auth-content">
        <div class="auth-tabs" role="tablist" aria-label="Acesso à conta">
          <button id="authLoginTab" class="auth-tab ${tab === 'login' ? 'active' : ''}" type="button" data-auth-tab="login" role="tab" aria-controls="authBody" aria-selected="${tab === 'login'}" tabindex="${tab === 'login' ? '0' : '-1'}">Entrar</button>
          <button id="authRegisterTab" class="auth-tab ${tab === 'register' ? 'active' : ''}" type="button" data-auth-tab="register" role="tab" aria-controls="authBody" aria-selected="${tab === 'register'}" tabindex="${tab === 'register' ? '0' : '-1'}">Criar conta</button>
        </div>
        <div id="authBody" class="auth-body" role="tabpanel" aria-labelledby="${tab === 'login' ? 'authLoginTab' : 'authRegisterTab'}">${tab === 'login' ? loginFormHtml() : registerFormHtml(state.authRole)}</div>
      </div>
    </div>`;
    openModal('Conta BitLoja', body, true);
    $('.modal-wrap', $('#modalRoot')).classList.add('auth-wrap');
    $('.modal', $('#modalRoot')).classList.add('auth-modal');
    $(tab === 'login' ? '#loginEmail' : '#registerName')?.focus();
  }

  function loginFormHtml() {
    return `<div class="auth-form-heading"><p class="auth-form-kicker">BEM-VINDO DE VOLTA</p><h2>Entre na BitLoja</h2><p>Acesse seus pedidos e acompanhe cada etapa.</p></div><form class="auth-form" id="loginForm"><div class="field"><label for="loginEmail">E-mail</label><input class="input" id="loginEmail" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" required></div><div class="field"><label for="loginPassword">Senha</label><div class="auth-password-field"><input class="input" id="loginPassword" name="password" type="password" autocomplete="current-password" required><button class="auth-password-toggle" type="button" data-action="toggle-password" data-password-target="loginPassword" aria-controls="loginPassword" aria-pressed="false">Mostrar</button></div></div><p class="auth-feedback" id="authFeedback" role="status" aria-live="polite"></p><button class="button button-primary auth-submit" type="submit" data-idle-label="Entrar" data-pending-label="Entrando…">Entrar</button></form>`;
  }

  function registerFormHtml(role = 'buyer') {
    return `<div class="auth-form-heading"><p class="auth-form-kicker">NOVA CONTA</p><h2>Crie sua conta</h2><p>Escolha perfil comprador ou vendedor. Seu acesso segue o perfil cadastrado.</p></div><form class="auth-form" id="registerForm"><div class="field"><label for="registerName">Nome</label><input class="input" id="registerName" name="name" autocomplete="name" required></div><div class="field"><label for="registerEmail">E-mail</label><input class="input" id="registerEmail" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required></div><div class="field"><label for="registerPassword">Senha</label><div class="auth-password-field"><input class="input" id="registerPassword" name="password" type="password" autocomplete="new-password" minlength="8" required><button class="auth-password-toggle" type="button" data-action="toggle-password" data-password-target="registerPassword" aria-controls="registerPassword" aria-pressed="false">Mostrar</button></div><small class="auth-help">Use pelo menos 8 caracteres.</small></div><div class="field"><label for="registerRole">Tipo de conta</label><select class="input" id="registerRole" name="role"><option value="buyer" ${role === 'buyer' ? 'selected' : ''}>Comprador</option><option value="seller" ${role === 'seller' ? 'selected' : ''}>Vendedor</option></select></div><p class="auth-feedback" id="authFeedback" role="status" aria-live="polite"></p><button class="button button-primary auth-submit" type="submit" data-idle-label="Criar conta" data-pending-label="Criando…">Criar conta</button></form>`;
  }

  function setAuthFeedback(form, message = '', isError = false) {
    const feedback = $('#authFeedback', form);
    if (!feedback) return;
    feedback.textContent = String(message || '');
    feedback.classList.toggle('error', isError && Boolean(message));
  }

  function setAuthPending(form, pending) {
    form.setAttribute('aria-busy', String(pending));
    $$('input, select, button', form).forEach(control => { control.disabled = pending; });
    $$('#modalRoot [data-auth-tab]').forEach(tab => { tab.disabled = pending; });
    const submit = $('button[type="submit"]', form);
    if (submit) submit.textContent = pending ? submit.dataset.pendingLabel : submit.dataset.idleLabel;
  }

  function isVisibleFocusTarget(element) {
    return element instanceof HTMLElement && element.isConnected && !element.closest('.hidden, [hidden]');
  }

  function captureFocusTarget() {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && isVisibleFocusTarget(active) ? active : null;
  }

  function focusIfVisible(element) {
    if (!isVisibleFocusTarget(element)) return false;
    if (!element.matches('a[href], button, input, select, textarea, [tabindex]')) element.tabIndex = -1;
    element.focus({ preventScroll: true });
    return true;
  }

  function restoreFocusTarget(previousFocus, fallback) {
    if (focusIfVisible(previousFocus)) return;
    focusIfVisible(fallback);
  }

  function focusViewDestination(view, previousFocus = null) {
    if (view === 'how') { focusIfVisible($('#howItWorksTitle')); return; }
    restoreFocusTarget(previousFocus, $(`#${view}Content`) || $(`#${view}View`));
  }

  function focusUpdatedContent(root, previousFocus) {
    const fallback = root?.querySelector('[data-dashboard-title], h1, h2, .notice, .empty') || root;
    restoreFocusTarget(previousFocus, fallback);
  }

  function focusDashboardTab(role, tab, previousFocus) {
    const tabSelector = role === 'seller' ? 'data-seller-tab' : 'data-admin-tab';
    const dashboardView = $(`#${role}View`);
    if (!dashboardView) {
      restoreFocusTarget(previousFocus, null);
      return;
    }
    const visibleInRole = element => element instanceof HTMLElement
      && dashboardView.contains(element)
      && isVisibleFocusTarget(element)
      && element.getClientRects().length > 0;
    const candidates = $$(`.dashboard-nav-link[${tabSelector}="${CSS.escape(tab)}"]`, dashboardView);
    const fallback = [
      ...candidates,
      $(`#${role}Content [data-dashboard-title]`, dashboardView),
      $(`#${role}Content`, dashboardView)
    ].find(visibleInRole);
    restoreFocusTarget(visibleInRole(previousFocus) ? previousFocus : null, fallback);
  }

  async function doLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
    setAuthFeedback(form);
    setAuthPending(form, true);
    try {
      const data = await api('/api/login', { method: 'POST', body: payload });
      resetPrivateState();
      state.user = data.user || null;
      state.csrf = data.csrf_token || state.csrf;
      closeModal({ restoreFocus: false });
      renderSession();
      toast(data.message || 'Sessão iniciada.');
      const nextView = state.user?.role === 'admin' ? 'admin' : state.user?.role === 'seller' ? 'seller' : 'account';
      showView(nextView);
      focusViewDestination(nextView);
    } catch (error) {
      setAuthFeedback(form, error.message, true);
    } finally {
      if (form.isConnected) setAuthPending(form, false);
    }
  }

  async function doRegister(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
    setAuthFeedback(form);
    setAuthPending(form, true);
    try {
      const data = await api('/api/register', { method: 'POST', body: payload });
      resetPrivateState();
      state.user = data.user || null;
      state.csrf = data.csrf_token || state.csrf;
      closeModal({ restoreFocus: false });
      renderSession();
      toast(data.message || 'Conta criada.');
      const nextView = state.user?.role === 'seller' ? 'seller' : 'account';
      showView(nextView);
      focusViewDestination(nextView);
    } catch (error) {
      setAuthFeedback(form, error.message, true);
    } finally {
      if (form.isConnected) setAuthPending(form, false);
    }
  }

  async function logout() {
    try {
      const data = await api('/api/logout', { method: 'POST', body: '{}' });
      resetPrivateState();
      state.user = null;
      state.cartCount = 0;
      state.unreadCount = 0;
      state.csrf = data.csrf_token || state.csrf;
      closeModal({ restoreFocus: false });
      renderSession();
      showView('home');
      focusViewDestination('home');
      toast(data.message || 'Sessão encerrada.');
    } catch (error) { toast(error.message, 'error'); }
  }

  function accountMenu() {
    if (!state.user) { openAuth('login'); return; }
    const links = `<div class="account-menu-user"><strong>${esc(state.user.name)}</strong><span>${esc(state.user.email)}</span><small>${esc(state.user.role)}</small></div>
      <div class="account-menu-actions"><button class="btn btn-secondary" type="button" data-action="go-view" data-view-name="account"><i class="bi bi-receipt" aria-hidden="true"></i> Meus pedidos</button>
      <button class="btn btn-secondary" type="button" data-action="go-view" data-view-name="wallet"><i class="bi bi-wallet2" aria-hidden="true"></i> Carteira</button>
      <button class="btn btn-secondary" type="button" data-action="go-view" data-view-name="custody"><i class="bi bi-shield-lock" aria-hidden="true"></i> Pagamentos Bitcoin</button>
      ${state.user.role === 'seller' ? '<button class="btn btn-secondary" type="button" data-action="go-view" data-view-name="seller"><i class="bi bi-shop" aria-hidden="true"></i> Minha loja</button>' : ''}
      ${state.user.role === 'admin' ? '<button class="btn btn-secondary" type="button" data-action="go-view" data-view-name="admin"><i class="bi bi-grid-1x2" aria-hidden="true"></i> Administração</button>' : ''}
      <button class="btn btn-danger" type="button" data-action="logout"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Sair</button></div>`;
    openModal('Sua conta', links);
  }

  function sellAction() {
    if (!state.user) {
      openAuth('register', 'seller');
      return;
    }
    if (state.user.role === 'seller') { showView('seller'); return; }
    if (state.user.role === 'admin') { showView('admin'); return; }
    openModal('Abrir uma loja', `<div class="notice notice-info">Sua conta atual é de comprador. Uma conta de vendedor precisa ser cadastrada com outro e-mail.</div><div class="account-menu-actions"><button class="btn btn-primary" type="button" data-action="logout-then-seller">Sair e criar conta de vendedor</button><button class="btn btn-secondary" type="button" data-action="close-modal">Voltar</button></div>`);
  }

  async function openProduct(id) {
    showView('product');
    const root = $('#productContent');
    const request = ++state.productRequest;
    setLoading(root, 'Carregando produto');
    try {
      const data = await api(`/api/products/${idOf(id)}`);
      if (request !== state.productRequest) return;
      state.currentProduct = data.product;
      const p = data.product;
      const store = data.store || {};
      const reviewItems = Array.isArray(data.reviews) ? data.reviews : [];
      const similar = Array.isArray(data.related) ? data.related : [];
      const image = productImage(p);
      const fallback = productImage({ ...p, image_url: '' });
      const imageMarkup = image
        ? `<img class="product-image" data-image-context="detail" data-image-label="${esc(p.name)}" src="${esc(image)}"${fallback && fallback !== image ? ` data-fallback="${esc(fallback)}"` : ''} alt="${esc(p.name)}">`
        : `<div class="product-image-empty" role="img" aria-label="Imagem não cadastrada para ${esc(p.name)}"><i class="bi bi-image" aria-hidden="true"></i><span>Imagem não cadastrada</span></div>`;
      root.innerHTML = `<nav class="crumbs" aria-label="Caminho do produto"><button class="nav-link" type="button" data-view="home">Início</button><i class="bi bi-chevron-right" aria-hidden="true"></i><button class="nav-link" type="button" data-view="catalog">Produtos</button><i class="bi bi-chevron-right" aria-hidden="true"></i><span>${esc(p.category || 'Produto')}</span></nav>
        <article class="product-detail-v2 product-detail-grid"><div class="product-gallery"><div class="product-gallery-frame product-detail-visual">${imageMarkup}</div><p class="product-gallery-caption"><i class="bi bi-image" aria-hidden="true"></i> ${image ? 'Imagem do produto' : 'Vendedor não cadastrou imagem disponível'}</p><div class="product-specs"><dl><div><dt>Categoria</dt><dd>${esc(p.category || 'Não informada')}</dd></div><div><dt>Referência</dt><dd>#${idOf(p.id)}</dd></div><div><dt>Estoque</dt><dd>${idOf(p.stock)} ${idOf(p.stock) === 1 ? 'unidade' : 'unidades'}</dd></div><div><dt>Pagamento</dt><dd>Bitcoin · ${esc(config.btcNetwork)}</dd></div></dl></div></div>
        <div class="product-purchase product-buy-box"><p class="product-store">${esc(store.name || p.store_name || 'Loja')}</p><h1 tabindex="-1">${esc(p.name)}</h1><div class="detail-rating">${num(p.review_count) ? `${stars(p.rating)} <span>${num(p.rating).toFixed(1)} · ${idOf(p.review_count)} avaliações</span>` : '<span>Sem avaliações registradas</span>'}</div><p class="lead">${esc(p.short_description || p.description || 'Veja informações do vendedor abaixo.')}</p><div class="product-price-block">${num(p.compare_at_sats) > num(p.price_sats) ? `<span class="old-price">₿ ${esc(p.compare_at_btc)}</span>` : ''}<strong class="big-price">₿ ${esc(p.price_btc)}</strong><span class="product-sats">${idOf(p.price_sats).toLocaleString('pt-BR')} sats</span></div><p class="product-stock ${num(p.stock) < 1 ? 'out' : ''}"><i class="bi ${num(p.stock) > 0 ? 'bi-check-circle' : 'bi-dash-circle'}" aria-hidden="true"></i> ${num(p.stock) > 0 ? `${idOf(p.stock)} unidades disponíveis` : 'Produto indisponível'}</p>
        <div class="quantity-row"><div class="field"><label for="productQty">Quantidade</label><div class="qty-control"><button type="button" data-action="product-qty" data-delta="-1" aria-label="Diminuir quantidade" ${num(p.stock) < 1 ? 'disabled' : ''}>−</button><input class="input" id="productQty" type="number" min="1" max="${Math.max(1, idOf(p.stock))}" step="1" value="1" ${num(p.stock) < 1 ? 'disabled' : ''}><button type="button" data-action="product-qty" data-delta="1" aria-label="Aumentar quantidade" ${num(p.stock) < 1 ? 'disabled' : ''}>+</button></div></div></div><div class="product-purchase-actions"><button class="btn btn-primary" type="button" data-action="add-current-product" data-id="${idOf(p.id)}" ${num(p.stock) < 1 ? 'disabled' : ''}><i class="bi bi-bag-plus" aria-hidden="true"></i> Adicionar ao carrinho</button><button class="btn btn-secondary" type="button" data-action="buy-current-product" data-id="${idOf(p.id)}" ${num(p.stock) < 1 ? 'disabled' : ''}>Comprar agora <i class="bi bi-arrow-right" aria-hidden="true"></i></button></div>
        <p class="product-payment-note"><i class="bi bi-currency-bitcoin" aria-hidden="true"></i> Escrow on-chain 2-de-3${config.lightningMode !== 'off' ? ' ou Lightning custodial' : ''}. Confirme opção no checkout.</p><div class="seller-box"><span><small>Vendido por</small><strong>${esc(store.name || p.store_name || 'Loja')}</strong>${num(store.review_count) ? `<small>${num(store.rating).toFixed(1)} · ${idOf(store.review_count)} avaliações da loja</small>` : ''}</span><button class="btn btn-secondary btn-sm" type="button" data-action="open-store" data-id="${idOf(store.id || p.store_id)}">Ver loja</button></div></div></article>
        <nav class="product-detail-tabs" aria-label="Informações do produto"><button class="text-link" type="button" data-product-section="productDescriptionSection">Descrição</button><button class="text-link" type="button" data-product-section="productStoreSection">Vendedor</button><button class="text-link" type="button" data-product-section="productReviewsSection">Avaliações (${reviewItems.length})</button></nav>
        <div class="detail-lower"><section class="panel product-detail-section" id="productDescriptionSection" tabindex="-1"><p class="eyebrow">INFORMAÇÕES DO VENDEDOR</p><h2>Descrição</h2><p class="preserve-lines">${esc(p.description || p.short_description || 'Sem descrição cadastrada.')}</p></section><section class="panel product-detail-section" id="productStoreSection" tabindex="-1"><p class="eyebrow">QUEM VENDE</p><h2>${esc(store.name || p.store_name || 'Loja')}</h2><p>${esc(store.description || 'Sem descrição cadastrada.')}</p><div class="store-details">${num(store.review_count) ? `${stars(store.rating)} ${num(store.rating).toFixed(1)} · ${idOf(store.review_count)} avaliações` : 'Sem avaliações registradas'}${store.tier ? ` · ${esc(store.tier)}` : ''}</div></section></div>
        <section class="section product-detail-section" id="productReviewsSection" tabindex="-1"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Compras concluídas</p><h2>Avaliações do produto</h2></div></div><div class="product-review-list">${reviewItems.length ? reviewItems.map(reviewCard).join('') : '<div class="empty">Este produto ainda não possui avaliações. Compradores podem avaliar após concluir o pedido.</div>'}</div></section>
        ${similar.length ? `<section class="section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Catálogo</p><h2>Produtos relacionados</h2></div><button class="text-link" type="button" data-view="catalog">Ver catálogo</button></div><div class="product-grid">${similar.map(renderProductCard).join('')}</div></section>` : ''}`;
      focusUpdatedContent(root, null);
    } catch (error) { if (request === state.productRequest) root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div><button class="btn btn-secondary" type="button" data-action="open-product" data-id="${idOf(id)}">Tentar novamente</button>`; }
  }

  function reviewCard(review) {
    return `<article class="review-card"><div class="review-meta"><strong>${esc(review.buyer_name || 'Comprador')}</strong><time>${esc(dateText(review.created_at))}</time></div>${stars(review.rating)}${review.title ? `<h3>${esc(review.title)}</h3>` : ''}<p>${esc(review.comment || review.body || '')}</p>${review.product_name ? `<small>${esc(review.product_name)}</small>` : ''}</article>`;
  }

  async function openStore(id) {
    showView('store');
    const root = $('#storeContent');
    setLoading(root, 'Carregando loja');
    try {
      const data = await api(`/api/stores/${idOf(id)}`);
      const store = data.store || {};
      const products = Array.isArray(data.products) ? data.products : [];
      const banner = safeImage(store.banner_url);
      const logo = safeImage(store.logo_url);
      root.innerHTML = `<div class="store-detail-banner" ${banner ? `style="background-image:url('${esc(banner)}')"` : ''}><div class="store-detail-logo">${logo ? `<img src="${esc(logo)}" alt="">` : `<span>${esc(String(store.name || 'L').slice(0, 1))}</span>`}</div><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Loja do marketplace</p><h1>${esc(store.name)}</h1></div></div><div class="store-detail-copy"><p>${esc(store.description || 'Sem descrição cadastrada.')}</p><span>${num(store.review_count) ? `${stars(store.rating)} ${num(store.rating).toFixed(1)} · ${idOf(store.review_count)} avaliações` : 'Sem avaliações registradas'}</span></div><section class="section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Catálogo</p><h2>Produtos da loja</h2></div></div><div class="product-grid">${products.length ? products.map(renderProductCard).join('') : '<div class="empty">Esta loja ainda não tem produtos ativos.</div>'}</div></section>`;
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
  }

  async function addToCart(productId, quantity = 1) {
    if (!state.user) { openAuth('login'); return false; }
    try {
      const data = await api('/api/cart/add', { method: 'POST', body: JSON.stringify({ product_id: idOf(productId), quantity: Math.max(1, idOf(quantity)) }) });
      if (data.count !== undefined) state.cartCount = idOf(data.count); else state.cartCount += Math.max(1, idOf(quantity));
      renderSession();
      toast(data.message || 'Produto adicionado ao carrinho.');
      return true;
    } catch (error) { toast(error.message, 'error'); return false; }
  }

  async function addCurrentProduct(button, checkout = false) {
    const quantity = $('#productQty');
    if (!quantity?.reportValidity() || button.disabled || quantity.dataset.pending === 'true') return;
    quantity.dataset.pending = 'true';
    const controls = $$('.product-purchase-actions button');
    controls.forEach(control => { control.disabled = true; });
    try {
      if (await addToCart(button.dataset.id, quantity.value)) {
        if (checkout) await openCheckout();
      }
    } finally {
      quantity.dataset.pending = 'false';
      controls.forEach(control => { if (control.isConnected) control.disabled = false; });
    }
  }

  function groupCartItems(items) {
    const groups = new Map();
    items.forEach(item => {
      const store = String(item.store_name || 'Loja');
      if (!groups.has(store)) groups.set(store, []);
      groups.get(store).push(item);
    });
    return groups;
  }

  function renderCart(data) {
    state.cart = data;
    const items = Array.isArray(data.items) ? data.items : [];
    state.cartCount = idOf(data.count ?? items.reduce((sum, item) => sum + idOf(item.quantity), 0));
    renderSession();
    const lines = $('#cartLines');
    const summary = $('#cartSummary');
    if (!items.length) {
      lines.innerHTML = '<div class="cart-empty"><i class="bi bi-bag" aria-hidden="true"></i><h2>Carrinho vazio</h2><p>Adicione produtos para continuar.</p><button class="btn btn-primary" type="button" data-action="catalog">Explorar produtos</button></div>';
      summary.innerHTML = '<div class="cart-summary-inner"><p class="summary-label">Resumo</p><h2>₿ 0.00000000</h2><p>O total será confirmado pelo servidor no checkout.</p></div>';
      return;
    }
    const grouped = groupCartItems(items);
    lines.innerHTML = Array.from(grouped.entries()).map(([storeName, group]) => `<section class="cart-store-group"><header class="cart-store-heading"><i class="bi bi-shop" aria-hidden="true"></i><h2>${esc(storeName)}</h2><span>${group.length} ${group.length === 1 ? 'item' : 'itens'}</span></header>${group.map(item => {
      const image = productImage(item);
      const fallback = productImage({ ...item, image_url: '' });
      const imageMarkup = image
        ? `<span class="cart-thumb"><img data-image-context="cart" data-image-label="${esc(item.name)}" src="${esc(image)}"${fallback && fallback !== image ? ` data-fallback="${esc(fallback)}"` : ''} alt="${esc(item.name)}" loading="lazy"></span>`
        : `<span class="cart-thumb cart-thumb-empty" role="img" aria-label="Imagem não cadastrada para ${esc(item.name)}"><i class="bi bi-image" aria-hidden="true"></i></span>`;
      return `<article class="cart-item">${imageMarkup}<div class="cart-item-info"><strong>${esc(item.name)}</strong><span>₿ ${esc(item.price_btc || item.unit_price_btc || '')} cada</span></div><div class="cart-line-total"><small>Total do item</small><strong class="cart-item-price">₿ ${esc(item.line_total_btc)}</strong></div><div class="qty-control"><button type="button" data-action="cart-qty" data-id="${idOf(item.id)}" data-delta="-1" aria-label="Diminuir quantidade de ${esc(item.name)}">−</button><label class="sr-only" for="cartQty${idOf(item.id)}">Quantidade de ${esc(item.name)}</label><input id="cartQty${idOf(item.id)}" type="number" min="0" max="${Math.max(0, num(item.stock))}" value="${idOf(item.quantity)}" data-cart-qty="${idOf(item.id)}"><button type="button" data-action="cart-qty" data-id="${idOf(item.id)}" data-delta="1" aria-label="Aumentar quantidade de ${esc(item.name)}">+</button></div><button class="remove-item" type="button" data-action="cart-remove" data-id="${idOf(item.id)}" aria-label="Remover ${esc(item.name)}"><i class="bi bi-trash3" aria-hidden="true"></i></button></article>`;
    }).join('')}</section>`).join('');
    summary.innerHTML = `<div class="cart-summary-inner"><p class="summary-label">Resumo do carrinho</p><div class="summary-row"><span>Itens</span><strong>${state.cartCount}</strong></div><div class="summary-total"><span>Total</span><strong>₿ ${esc(data.total_btc)}</strong></div><p>O checkout cria um pedido separado para cada loja.</p><button class="btn btn-primary" type="button" data-action="checkout"><i class="bi bi-lock" aria-hidden="true"></i> Continuar para checkout</button><small>Preço e estoque são confirmados pelo servidor ao finalizar.</small></div>`;
  }

  async function loadCart() {
    if (!state.user) { openAuth('login'); showView('home'); return; }
    const root = $('#cartLines');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando carrinho');
    try { renderCart(await api('/api/cart')); }
    catch (error) { if (root) root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  async function updateCart(productId, quantity) {
    try {
      const data = await api('/api/cart/update', { method: 'POST', body: JSON.stringify({ product_id: idOf(productId), quantity: Math.max(0, idOf(quantity)) }) });
      renderCart(await api('/api/cart'));
      toast(data.message || 'Carrinho atualizado.');
    } catch (error) { toast(error.message, 'error'); }
  }

  function saveCheckoutDraft() {
    const form = $('#checkoutForm');
    if (form && !state.checkoutPending) state.checkoutDraft = Object.fromEntries(new FormData(form));
    return state.checkoutDraft || {};
  }

  function checkoutSummary(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const stores = groupCartItems(items);
    return `<p class="summary-label">Resumo da compra</p><h2>${items.reduce((total, item) => total + idOf(item.quantity), 0)} itens · ${stores.size} ${stores.size === 1 ? 'loja' : 'lojas'}</h2>
      <div class="checkout-summary-items">${items.map(item => `<div class="summary-line"><span>${esc(item.name)}<small>${idOf(item.quantity)} × ₿ ${esc(item.price_btc || item.unit_price_btc)}</small></span><strong>₿ ${esc(item.line_total_btc)}</strong></div>`).join('')}</div>
      <div class="summary-total"><span>Total em Bitcoin</span><strong>₿ ${esc(data.total_btc)}</strong></div><p>Um pedido por loja. Preços e estoque são validados ao criar os pedidos.</p><small>Rede ${esc(config.btcNetwork)} · modo ${esc(config.btcMode)}. Taxas de rede são definidas pela carteira no pagamento.</small>`;
  }

  function checkoutReviewHtml(draft) {
    return `<div class="checkout-line"><span>Destinatário</span><strong>${esc(draft.shipping_name || 'Não informado')}</strong></div>
      <div class="checkout-line"><span>Entrega</span><strong>${esc([draft.shipping_address, draft.shipping_city, draft.shipping_state, draft.shipping_zip].filter(Boolean).join(', ') || 'Não informada')}</strong></div>
      <div class="checkout-line"><span>Pagamento</span><strong>${draft.payment_method === 'lightning' ? 'Lightning · custodial' : 'Escrow on-chain · 2 de 3'}</strong></div>
      <div class="checkout-line"><span>Reembolso</span><code>${esc(draft.buyer_refund_address || 'Não informado')}</code></div>
      <p>O próximo passo cria os pedidos e apresenta os endereços ou invoices. Criar pedidos não confirma pagamento.</p>`;
  }

  function renderCheckout(data) {
    const root = $('#checkoutContent');
    const draft = state.checkoutDraft || {
      payment_method: 'onchain_multisig', buyer_pubkey: state.user.bitcoin_pubkey || '', shipping_name: state.user.name || ''
    };
    if (draft.payment_method === 'lightning' && config.lightningMode === 'off') draft.payment_method = 'onchain_multisig';
    const field = (id, name, label, autocomplete, maxLength) => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" name="${name}" autocomplete="${autocomplete}" maxlength="${maxLength}" value="${esc(draft[name] || '')}" required></div>`;
    root.innerHTML = `<div class="checkout-layout"><div class="checkout-main"><form id="checkoutForm" novalidate>
      <ol class="checkout-steps" aria-label="Etapas do checkout"><li data-checkout-step="delivery"><span>1</span>Entrega</li><li data-checkout-step="payment"><span>2</span>Pagamento</li><li data-checkout-step="review"><span>3</span>Revisão</li></ol>
      <section class="panel checkout-panel" data-checkout-panel="delivery" aria-labelledby="checkoutDeliveryTitle"><p class="eyebrow">01 / ENTREGA</p><h2 id="checkoutDeliveryTitle" tabindex="-1">Para onde vai seu pedido?</h2><p>O endereço acompanha todos os pedidos desta compra.</p><div class="checkout-field-grid grid-2">${field('shippingName', 'shipping_name', 'Nome do destinatário', 'name', 120)}${field('shippingZip', 'shipping_zip', 'CEP', 'postal-code', 20)}</div>${field('shippingAddress', 'shipping_address', 'Endereço completo', 'street-address', 220)}<div class="checkout-field-grid grid-2">${field('shippingCity', 'shipping_city', 'Cidade', 'address-level2', 100)}${field('shippingState', 'shipping_state', 'Estado', 'address-level1', 40)}</div><button class="btn btn-primary" type="button" data-action="checkout-step" data-step="payment">Escolher pagamento <i class="bi bi-arrow-right" aria-hidden="true"></i></button></section>
      <section class="panel checkout-panel hidden" data-checkout-panel="payment" aria-labelledby="checkoutPaymentTitle"><p class="eyebrow">02 / BITCOIN</p><h2 id="checkoutPaymentTitle" tabindex="-1">Escolha caminho de pagamento</h2><fieldset class="field"><legend>Meio de pagamento</legend><label class="method-card"><input type="radio" name="payment_method" value="onchain_multisig" ${draft.payment_method !== 'lightning' ? 'checked' : ''}><span><strong>Escrow on-chain 2-de-3</strong><small>Comprador, vendedor e mediador. Liberação ou devolução exige duas assinaturas.</small></span></label><label class="method-card"><input type="radio" name="payment_method" value="lightning" ${draft.payment_method === 'lightning' ? 'checked' : ''} ${config.lightningMode === 'off' ? 'disabled' : ''}><span><strong>Lightning</strong><small>${config.lightningMode === 'off' ? 'Desativado neste servidor.' : `Custodial pelo nó da plataforma · modo ${esc(config.lightningMode)}.`}</small></span></label></fieldset>
      <div id="multisigCheckoutFields" class="${draft.payment_method === 'lightning' ? 'hidden' : ''}"><div class="field"><label for="buyerPubkey">Sua chave pública Bitcoin comprimida</label><input class="input" id="buyerPubkey" name="buyer_pubkey" value="${esc(draft.buyer_pubkey || '')}" pattern="(02|03)[0-9a-fA-F]{64}" maxlength="66" placeholder="02/03 + 64 caracteres hex" spellcheck="false" autocomplete="off"><small>Informe chave pública ou use carteira watch-only já configurada. A chave privada fica na sua carteira.</small></div></div>
      <div class="field"><label for="refundAddress">Endereço BTC para reembolso</label><input class="input" id="refundAddress" name="buyer_refund_address" value="${esc(draft.buyer_refund_address || '')}" maxlength="160" placeholder="Endereço compatível com ${esc(config.btcNetwork)}" spellcheck="false" autocomplete="off"><small>Usado em propostas de devolução e pagamentos excedentes.</small></div><div class="actions"><button class="btn btn-secondary" type="button" data-action="checkout-step" data-step="delivery">Voltar à entrega</button><button class="btn btn-primary" type="button" data-action="checkout-step" data-step="review">Revisar pedidos <i class="bi bi-arrow-right" aria-hidden="true"></i></button></div></section>
      <section class="panel checkout-panel checkout-review hidden" data-checkout-panel="review" aria-labelledby="checkoutReviewTitle"><p class="eyebrow">03 / REVISÃO</p><h2 id="checkoutReviewTitle" tabindex="-1">Confira antes de criar</h2><div id="checkoutReview">${checkoutReviewHtml(draft)}</div><div class="actions"><button class="btn btn-secondary" type="button" data-action="checkout-step" data-step="payment">Editar pagamento</button><button class="btn btn-primary" type="submit"><i class="bi bi-lock" aria-hidden="true"></i> Criar pedidos em Bitcoin</button></div></section>
      <p class="checkout-feedback" id="checkoutFeedback" role="status" aria-live="polite"></p></form></div><aside class="panel checkout-summary" aria-label="Resumo do checkout">${checkoutSummary(data)}</aside></div>`;
    setCheckoutStep(state.checkoutStep, false);
  }

  function setCheckoutStep(step, focus = true) {
    const steps = ['delivery', 'payment', 'review'];
    if (!steps.includes(step) || state.checkoutPending) return;
    const form = $('#checkoutForm');
    if (!form) return;
    const draft = saveCheckoutDraft();
    if (focus && steps.indexOf(step) > steps.indexOf(state.checkoutStep) && !validateCheckoutPanel(state.checkoutStep)) return;
    state.checkoutStep = step;
    $$('[data-checkout-panel]', form).forEach(panel => panel.classList.toggle('hidden', panel.dataset.checkoutPanel !== step));
    $$('[data-checkout-step]', form).forEach(item => {
      const current = item.dataset.checkoutStep === step;
      item.classList.toggle('current', current);
      item.classList.toggle('is-complete', steps.indexOf(item.dataset.checkoutStep) < steps.indexOf(step));
      if (current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    $('#checkoutReview').innerHTML = checkoutReviewHtml(draft);
    if (focus) focusIfVisible($(`[data-checkout-panel="${step}"] h2`, form));
  }

  function validateCheckoutPanel(step) {
    const panel = $(`[data-checkout-panel="${step}"]`, $('#checkoutForm'));
    const controls = panel ? $$('input, select, textarea', panel) : [];
    const lightning = $('#checkoutForm input[name="payment_method"]:checked')?.value === 'lightning';
    const invalid = controls.find(input => !(input.id === 'buyerPubkey' && lightning) && !input.disabled && !input.checkValidity());
    if (!invalid) return true;
    setCheckoutStep(step, false);
    invalid.reportValidity();
    invalid.focus();
    return false;
  }

  async function openCheckout() {
    if (!state.user) { openAuth('login'); return; }
    if (state.checkoutPending) { showView('checkout'); return; }
    saveCheckoutDraft();
    closeModal({ restoreFocus: false });
    showView('checkout');
    const root = $('#checkoutContent');
    const request = ++state.checkoutRequest;
    const sessionVersion = state.sessionVersion;
    setLoading(root, 'Confirmando itens do carrinho');
    try {
      const data = await api('/api/cart');
      if (request !== state.checkoutRequest || sessionVersion !== state.sessionVersion || !state.user) return;
      state.cart = data;
      state.cartCount = idOf(data.count);
      renderSession();
      if (!Array.isArray(data.items) || !data.items.length) {
        root.innerHTML = '<div class="cart-empty"><i class="bi bi-bag" aria-hidden="true"></i><h2>Carrinho vazio</h2><p>Adicione produtos antes de iniciar checkout.</p><button class="btn btn-primary" type="button" data-action="catalog">Explorar produtos</button></div>';
      } else renderCheckout(data);
      focusUpdatedContent(root, null);
    } catch (error) {
      if (request !== state.checkoutRequest || sessionVersion !== state.sessionVersion) return;
      root.innerHTML = `<div class="notice notice-danger" role="alert">${esc(error.message)}</div><button class="btn btn-secondary" type="button" data-action="checkout">Tentar novamente</button>`;
      focusUpdatedContent(root, null);
    }
  }

  function renderCheckoutOrders(message = 'Pedidos criados. O pagamento ainda precisa ser confirmado.') {
    const cards = state.checkoutOrders.map(order => {
      const lightning = order.payment_method === 'lightning';
      const value = lightning ? order.lightning_invoice : order.payment_address;
      return `<article class="panel checkout-payment"><div class="checkout-order-head"><div><small>${esc(order.store_name || 'Pedido')}</small><h2>${esc(order.reference)}</h2></div>${statusTag(order.status || 'awaiting_payment')}</div><strong class="big-price">₿ ${esc(order.total_btc)}</strong><span class="mode-tag">${lightning ? 'Lightning · custodial' : 'Escrow on-chain · 2 de 3'}</span><p>${lightning ? 'Pague invoice com carteira Lightning compatível.' : `Envie valor para endereço deste pedido na rede ${esc(config.btcNetwork)}.`}</p><div class="keybox">${esc(value || 'Dados de pagamento não retornados pelo servidor. Abra seus pedidos para consultar.')}</div><div class="actions">${value ? `<button class="btn btn-primary" type="button" data-action="copy" data-value="${esc(value)}">Copiar ${lightning ? 'invoice' : 'endereço escrow'}</button>` : ''}<button class="btn btn-secondary" type="button" data-action="checkout-sync" data-id="${idOf(order.id)}" ${state.checkoutPending ? 'disabled' : ''}>Consultar pagamento</button></div>${order.txid ? `<p class="order-txid">TXID ${esc(order.txid)}</p>` : ''}</article>`;
    }).join('');
    $('#checkoutContent').innerHTML = `<div class="checkout-complete"><div class="notice notice-info" role="status">${esc(message)}</div><ol class="checkout-steps" aria-label="Estado da compra"><li class="is-complete"><span>1</span>Dados revisados</li><li class="is-complete"><span>2</span>Pedidos criados</li><li class="current" aria-current="step"><span>3</span>Pagamento por pedido</li></ol>${cards || '<div class="empty">Consulte seus pedidos para ver dados de pagamento.</div>'}<p>Confirmação de pagamento vem do servidor. Acompanhe entrega, PSBTs e avaliações em seus pedidos.</p><div class="actions"><button class="btn btn-secondary" type="button" data-action="catalog">Continuar comprando</button><button class="btn btn-primary" type="button" data-action="checkout-orders">Acompanhar pedidos</button></div></div>`;
  }

  async function submitCheckout(event) {
    event.preventDefault();
    if (state.checkoutPending) return;
    const form = event.currentTarget;
    const sessionVersion = state.sessionVersion;
    saveCheckoutDraft();
    if (!validateCheckoutPanel('delivery') || !validateCheckoutPanel('payment')) return;
    if (state.checkoutStep !== 'review') { setCheckoutStep('review'); return; }
    const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
    state.checkoutPending = true;
    form.setAttribute('aria-busy', 'true');
    $$('button', form).forEach(button => { button.disabled = true; });
    $('#checkoutFeedback').textContent = 'Criando pedidos. Aguarde resposta do servidor.';
    try {
      const data = await api('/api/checkout', { method: 'POST', body: payload });
      if (sessionVersion !== state.sessionVersion) return;
      state.cartCount = 0;
      state.cart = null;
      state.checkoutDraft = null;
      state.checkoutStep = 'delivery';
      state.checkoutOrders = Array.isArray(data.orders) ? data.orders : [];
      renderSession();
      state.checkoutPending = false;
      renderCheckoutOrders(data.message || 'Pedidos criados. Aguarde confirmação do pagamento.');
      focusUpdatedContent($('#checkoutContent'), null);
    } catch (error) {
      if (form.isConnected && sessionVersion === state.sessionVersion) {
        const feedback = $('#checkoutFeedback');
        feedback.textContent = error.message;
        feedback.classList.add('error');
        focusIfVisible(feedback);
      }
    } finally {
      if (sessionVersion === state.sessionVersion) state.checkoutPending = false;
      if (form.isConnected && sessionVersion === state.sessionVersion) {
        form.setAttribute('aria-busy', 'false');
        $$('button', form).forEach(button => { button.disabled = false; });
      }
    }
  }

  async function syncCheckoutOrder(id) {
    if (state.checkoutPending) return;
    state.checkoutPending = true;
    const sessionVersion = state.sessionVersion;
    renderCheckoutOrders('Consultando pagamento no servidor…');
    try {
      await api(`/api/orders/${idOf(id)}/sync`, { method: 'POST', body: '{}' });
      const data = await api(`/api/orders/${idOf(id)}`);
      if (sessionVersion !== state.sessionVersion) return;
      state.checkoutOrders = state.checkoutOrders.map(order => idOf(order.id) === idOf(id) ? { ...order, ...data.order } : order);
      state.checkoutPending = false;
      renderCheckoutOrders('Consulta concluída. Status exibido corresponde à resposta do servidor.');
    } catch (error) {
      if (sessionVersion !== state.sessionVersion) return;
      state.checkoutPending = false;
      renderCheckoutOrders(error.message);
    }
  }

  function orderTable(orders, seller = false) {
    if (!orders?.length) return '<div class="empty">Nenhum pedido registrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>${seller ? 'Comprador' : 'Loja'}</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${esc(order.reference)}</strong><br><small>${esc(dateText(order.created_at))}</small></td><td>${esc(seller ? order.buyer_name || '' : order.store_name || '')}</td><td>₿ ${esc(order.total_btc)}</td><td>${statusTag(order.status)}</td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="open-order" data-id="${idOf(order.id)}">Detalhes</button>${seller ? `<button class="btn btn-secondary btn-sm" type="button" data-action="tracking" data-id="${idOf(order.id)}">Rastreio</button>${!['awaiting_payment', 'partial', 'cancelled', 'refunded'].includes(order.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="open-dispute" data-id="${idOf(order.id)}">Disputa</button>` : ''}` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  async function loadAccount() {
    if (!state.user) { openAuth('login'); showView('home'); return; }
    const root = $('#accountContent');
    const sessionVersion = state.sessionVersion;
    const request = ++state.accountRequest;
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando pedidos');
    try {
      const data = await api('/api/orders/my');
      if (sessionVersion !== state.sessionVersion || request !== state.accountRequest) return;
      state.accountOrders = Array.isArray(data.orders) ? data.orders : [];
      renderAccount();
    } catch (error) { if (sessionVersion === state.sessionVersion && request === state.accountRequest) root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div><button class="btn btn-secondary" type="button" data-action="refresh-account">Tentar novamente</button>`; }
    finally { if (sessionVersion === state.sessionVersion && request === state.accountRequest) focusUpdatedContent(root, previousFocus); }
  }

  function accountOrderCard(order) {
    const path = ['awaiting_payment', 'paid', 'processing', 'shipped', 'completed'];
    const progress = order.status === 'partial' ? 0 : path.indexOf(order.status);
    const exceptional = ['cancelled', 'refunded', 'under_review'].includes(order.status);
    const awaiting = ['awaiting_payment', 'partial'].includes(order.status);
    const next = {
      awaiting_payment: 'Efetue pagamento e consulte confirmação.', partial: 'Pagamento parcial. Consulte valor recebido e restante.',
      paid: 'Pagamento recebido. Aguarde preparação.', processing: 'Vendedor prepara envio.', shipped: 'Consulte rastreio e histórico de entrega.',
      completed: 'Pedido concluído. Avaliações disponíveis nos detalhes.', cancelled: 'Pedido cancelado. Consulte histórico.',
      refunded: 'Reembolso registrado. Consulte transação nos detalhes.', under_review: 'Pedido em disputa. Consulte conversa e decisão.'
    }[order.status] || 'Consulte detalhes do pedido.';
    return `<article class="order-card"><header class="order-card-head"><div><small>${esc(order.store_name || 'Loja')}</small><strong>${esc(order.reference || `#${idOf(order.id)}`)}</strong><time datetime="${esc(order.created_at || '')}">${esc(dateText(order.created_at))}</time></div>${statusTag(order.status)}</header>
      <div class="order-card-items"><span class="order-card-symbol"><i class="bi ${awaiting ? 'bi-currency-bitcoin' : order.status === 'shipped' ? 'bi-truck' : 'bi-box-seam'}" aria-hidden="true"></i></span><div><strong>${esc(next)}</strong><small>${order.shipping_name ? `Entrega para ${esc(order.shipping_name)}` : 'Itens e endereço disponíveis nos detalhes.'}</small></div><div class="order-card-total"><small>Total do pedido</small><strong>₿ ${esc(order.total_btc)}</strong>${num(order.paid_sats) > 0 ? `<small>Recebido ₿ ${esc(order.paid_btc)}</small>` : ''}</div></div>
      ${exceptional ? '' : `<ol class="order-progress" aria-label="Etapas do pedido">${['Pagamento', 'Pago', 'Preparação', 'Enviado', 'Concluído'].map((label, index) => `<li class="${index < progress ? 'is-complete' : index === progress ? 'is-current' : ''}"${index === progress ? ' aria-current="step"' : ''}><span></span>${label}</li>`).join('')}</ol>`}
      <footer class="order-card-foot"><span class="mode-tag">${order.payment_method === 'lightning' ? 'Lightning · custodial' : 'Escrow on-chain · 2 de 3'}</span><button class="btn btn-secondary btn-sm" type="button" data-action="open-order" data-id="${idOf(order.id)}">${awaiting ? 'Ver pagamento' : order.status === 'completed' ? 'Detalhes e avaliações' : 'Acompanhar pedido'} <i class="bi bi-arrow-right" aria-hidden="true"></i></button></footer></article>`;
  }

  function renderAccountOrders() {
    const root = $('#accountOrders');
    if (!root) return;
    const search = state.accountSearch.trim().toLocaleLowerCase('pt-BR');
    const orders = state.accountOrders.filter(order => {
      const matchesStatus = state.accountStatus === 'all' || (state.accountStatus === 'awaiting' ? ['awaiting_payment', 'partial'].includes(order.status) : state.accountStatus === 'active' ? ['paid', 'processing', 'shipped'].includes(order.status) : order.status === state.accountStatus);
      return matchesStatus && `${order.reference || ''} ${order.store_name || ''} ${order.shipping_name || ''}`.toLocaleLowerCase('pt-BR').includes(search);
    });
    $('#accountResultCount').textContent = `${orders.length} ${orders.length === 1 ? 'pedido' : 'pedidos'}`;
    root.innerHTML = orders.length ? orders.map(accountOrderCard).join('') : state.accountOrders.length
      ? '<div class="empty"><i class="bi bi-search" aria-hidden="true"></i><h3>Nenhum pedido encontrado</h3><p>Altere busca ou status.</p><button class="btn btn-secondary" type="button" data-action="reset-account-filters">Limpar filtros</button></div>'
      : '<div class="empty"><i class="bi bi-bag" aria-hidden="true"></i><h3>Nenhum pedido registrado</h3><p>Pedidos aparecem aqui após checkout.</p><button class="btn btn-primary" type="button" data-action="catalog">Explorar produtos</button></div>';
  }

  function renderAccount() {
    const orders = state.accountOrders;
    const role = state.user?.role || 'buyer';
    const awaiting = orders.filter(order => ['awaiting_payment', 'partial'].includes(order.status)).length;
    const active = orders.filter(order => ['paid', 'processing', 'shipped'].includes(order.status)).length;
    const completed = orders.filter(order => order.status === 'completed').length;
    $('#accountTitle').textContent = role === 'admin' ? 'Pedidos do marketplace.' : role === 'seller' ? 'Pedidos da loja.' : 'Seus pedidos.';
    $('#accountDescription').textContent = role === 'admin' ? 'Últimos pedidos retornados pela API administrativa.' : role === 'seller' ? 'Pagamento, preparação e entrega dos pedidos da sua loja.' : 'Acompanhe pagamentos, entrega, avaliações e disputas.';
    $('#accountContent').innerHTML = `<div class="account-metrics metrics"><article class="metric-card"><small>Pedidos</small><strong>${orders.length}</strong></article><article class="metric-card"><small>Aguardando BTC</small><strong>${awaiting}</strong></article><article class="metric-card"><small>Em andamento</small><strong>${active}</strong></article><article class="metric-card"><small>Concluídos</small><strong>${completed}</strong></article></div>
      <section class="section"><div class="section-heading"><div><p class="eyebrow">HISTÓRICO</p><h2>${role === 'buyer' ? 'Compras e entregas' : 'Pedidos e entregas'}</h2></div><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="notifications"><i class="bi bi-bell" aria-hidden="true"></i> Notificações</button><button class="btn btn-secondary btn-sm" type="button" data-action="refresh-account"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Atualizar</button>${role !== 'buyer' ? `<button class="btn btn-secondary btn-sm" type="button" data-view="${role}">Voltar ao painel</button>` : ''}</div></div>
      <div class="account-toolbar"><div class="field"><label for="accountOrderSearch">Buscar pedido, loja ou destinatário</label><input class="input" id="accountOrderSearch" type="search" value="${esc(state.accountSearch)}" placeholder="Referência do pedido ou nome"></div><div class="field"><label for="accountOrderStatus">Status</label><select class="input" id="accountOrderStatus">${[['all', 'Todos os status'], ['awaiting', 'Aguardando pagamento'], ['active', 'Em andamento'], ['completed', 'Concluídos'], ['under_review', 'Em disputa'], ['cancelled', 'Cancelados'], ['refunded', 'Reembolsados']].map(([value, label]) => `<option value="${value}" ${state.accountStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><p id="accountResultCount" role="status" aria-live="polite"></p></div><div id="accountOrders" class="account-orders"></div></section>`;
    renderAccountOrders();
  }

  async function loadReviews() {
    const root = $('#reviewsList');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Buscando avaliações publicadas');
    try {
      const products = state.products.length ? state.products : (await api('/api/products')).products || [];
      const reviewProducts = products.filter(product => num(product.review_count) > 0);
      const details = await Promise.all(reviewProducts.map(product => api(`/api/products/${idOf(product.id)}`).catch(() => null)));
      const reviews = details.flatMap(detail => (detail?.reviews || []).map(review => ({ ...review, product_name: review.product_name || detail.product?.name })));
      reviews.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      root.innerHTML = reviews.length ? reviews.map(reviewCard).join('') : '<div class="empty">Nenhuma avaliação de produto publicada.</div>';
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  async function openOrder(id) {
    const orderId = idOf(id);
    openModal(`Pedido #${orderId}`, '<div class="empty">Carregando pedido e rastreio…</div>', true);
    try {
      const [data, trackingData] = await Promise.all([
        api(`/api/orders/${orderId}`),
        api(`/api/orders/${orderId}/tracking`).catch(error => ({ tracking: {}, events: [], trackingError: error.message }))
      ]);
      const order = data.order || {};
      const tracking = trackingData.tracking || {};
      const events = trackingData.events || [];
      const disputes = data.disputes || [];
      const onchain = order.payment_method === 'onchain_multisig';
      const payValue = onchain ? order.payment_address : order.lightning_invoice;
      const canTrack = ['seller', 'admin'].includes(state.user?.role);
      const timeline = events.length ? `<ol class="tracking-timeline">${events.map(event => `<li><span class="timeline-dot"></span><div><strong>${esc(statusLabels[event.status] || event.status)}</strong><small>${esc(dateText(event.created_at))} · ${esc(event.actor_name || 'Conta')}</small>${event.note ? `<p>${esc(event.note)}</p>` : ''}</div></li>`).join('')}</ol>` : '<div class="empty">Nenhuma atualização de rastreio registrada.</div>';
      const items = (order.items || []).map(item => `<div class="order-item-row"><span><strong>${esc(item.product_name)}</strong><small>Quantidade ${idOf(item.quantity)}</small></span><span>₿ ${esc(item.unit_price_btc)}</span></div>`).join('');
      const disputeButton = disputes.length ? `<button class="btn btn-secondary btn-sm" type="button" data-action="open-dispute-thread" data-id="${idOf(disputes[0].id)}">Abrir conversa da disputa</button>` : state.user?.role === 'buyer' && ['paid', 'processing', 'shipped'].includes(order.status) ? `<button class="btn btn-danger btn-sm" type="button" data-action="dispute-form" data-id="${orderId}">Abrir disputa</button>` : '';
      const reviewButtons = order.status === 'completed' && state.user?.role === 'buyer' ? (order.items || []).map(item => `<button class="btn btn-secondary btn-sm" type="button" data-action="review-form" data-order="${orderId}" data-product="${idOf(item.product_id)}" data-name="${esc(item.product_name)}">Avaliar ${esc(item.product_name)}</button>`).join('') : '';
      const actionPanel = `<div class="actions order-actions">${['awaiting_payment', 'partial'].includes(order.status) ? `<button class="btn btn-secondary" type="button" data-action="sync-order" data-id="${orderId}">Sincronizar pagamento</button>` : ''}${onchain && !['awaiting_payment', 'cancelled', 'refunded'].includes(order.status) ? `<button class="btn btn-primary" type="button" data-action="manage-psbt" data-id="${orderId}">Gerenciar PSBT</button>` : ''}${state.user?.role === 'admin' && order.payment_method === 'lightning' && config.lightningMode === 'demo' && order.status !== 'completed' ? `<button class="btn btn-secondary" type="button" data-action="demo-settle" data-id="${orderId}">Liquidar pagamento demo</button>` : ''}${disputeButton}${reviewButtons}</div>`;
      const shipping = [order.shipping_address, order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).map(esc).join(', ');
      const sellerAndAdminFields = canTrack ? trackingFormHtml(order, tracking) : '';
      const body = `<div class="order-detail-grid"><section class="panel"><p class="summary-label">Status do pedido</p>${statusTag(order.status)}<strong class="big-price">₿ ${esc(order.total_btc)}</strong><p>Recebido: ₿ ${esc(order.paid_btc)}</p><span class="mode-tag">${onchain ? 'Escrow 2-de-3' : 'Lightning custodial'}</span></section><section class="panel"><p class="summary-label">${onchain ? 'Endereço escrow' : 'Invoice Lightning'}</p><div class="keybox">${esc(payValue || 'Não informado')}</div><button class="btn btn-secondary btn-sm" type="button" data-action="copy" data-value="${esc(payValue || '')}">Copiar</button>${order.txid ? `<p class="order-txid">TXID ${esc(order.txid)}</p>` : ''}</section></div>
        ${onchain ? `<section class="panel section"><h3>Participantes do escrow</h3><div class="key-grid"><div><small>Comprador</small><code>${esc(order.buyer_pubkey || '—')}</code></div><div><small>Vendedor</small><code>${esc(order.seller_pubkey || '—')}</code></div><div><small>Mediador</small><code>${esc(order.platform_pubkey || '—')}</code></div></div></section>` : ''}
        <section class="panel section"><h3>Itens</h3>${items || '<div class="empty">Sem itens no pedido.</div>'}</section><section class="panel section"><h3>Entrega</h3><p>${esc(order.shipping_name || '')}<br>${shipping || 'Endereço não informado'}</p><div class="tracking-current"><span><small>Transportadora</small><strong>${esc(tracking.carrier || '—')}</strong></span><span><small>Código</small><strong>${esc(tracking.tracking_code || '—')}</strong></span></div><h3>Atualizações</h3>${timeline}${sellerAndAdminFields}</section>${actionPanel}`;
      openModal(`Pedido ${order.reference || `#${orderId}`}`, body, true);
    } catch (error) { openModal(`Pedido #${orderId}`, `<div class="notice notice-danger">${esc(error.message)}</div>`); }
  }

  function trackingFormHtml(order, tracking) {
    const transitions = { paid: 'processing', processing: 'shipped', shipped: 'completed' };
    const nextStatus = transitions[order.status] || (order.status === 'awaiting_payment' && num(order.paid_sats) === 0 && !order.paid_at && !order.refund_txid ? 'cancelled' : '');
    if (!nextStatus) return '<div class="notice notice-info">Não há transição de status disponível neste estado.</div>';
    const options = `<option value="${nextStatus}">${esc(statusLabels[nextStatus])}</option>`;
    return `<form class="tracking-form" id="trackingForm" data-order-id="${idOf(order.id)}"><h3>Atualizar pedido</h3><div class="grid-2"><div class="field"><label for="trackingStatus">Próximo status</label><select class="input" id="trackingStatus" name="status" required>${options}</select></div><div class="field"><label for="trackingCarrier">Transportadora</label><input class="input" id="trackingCarrier" name="carrier" value="${esc(tracking.carrier || '')}" maxlength="120"></div></div><div class="field"><label for="trackingCode">Código de rastreio</label><input class="input" id="trackingCode" name="tracking_code" value="${esc(tracking.tracking_code || '')}" maxlength="160" ${nextStatus === 'shipped' ? 'required' : ''}></div><div class="field"><label for="trackingNote">Nota para o histórico</label><textarea class="input" id="trackingNote" name="note" maxlength="1000"></textarea></div><button class="btn btn-primary" type="submit">Salvar atualização</button></form>`;
  }

  async function submitTracking(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = idOf(form.dataset.orderId);
    try {
      const data = await api(`/api/orders/${orderId}/tracking`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      toast(data.message || 'Rastreio atualizado.');
      const refreshView = { seller: loadSeller, admin: loadAdmin, account: loadAccount }[state.activeView];
      if (refreshView) await refreshView();
      await openOrder(orderId);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function syncOrder(id) {
    try { const data = await api(`/api/orders/${idOf(id)}/sync`, { method: 'POST', body: '{}' }); toast(data.message || 'Pedido sincronizado.'); await openOrder(id); }
    catch (error) { toast(error.message, 'error'); }
  }

  function openReviewForm(orderId, productId, name) {
    openModal('Avaliar produto', `<div class="notice notice-info">Avaliação vinculada ao pedido concluído.</div><form id="reviewForm"><input type="hidden" name="order_id" value="${idOf(orderId)}"><input type="hidden" name="product_id" value="${idOf(productId)}"><div class="field"><label for="reviewRating">Nota</label><select class="input" id="reviewRating" name="rating"><option value="5">5 — Excelente</option><option value="4">4 — Muito bom</option><option value="3">3 — Bom</option><option value="2">2 — Ruim</option><option value="1">1 — Péssimo</option></select></div><div class="field"><label for="reviewTitle">Título</label><input class="input" id="reviewTitle" name="title" maxlength="120"></div><div class="field"><label for="reviewComment">Comentário</label><textarea class="input" id="reviewComment" name="comment" required maxlength="2000"></textarea></div><button class="btn btn-primary" type="submit">Publicar avaliação</button></form>`);
  }

  function openDisputeForm(orderId) {
    openModal('Abrir disputa', `<div class="notice notice-warning">Uma disputa bloqueia a liquidação automática deste pedido até a decisão administrativa.</div><form id="disputeForm"><input type="hidden" name="order_id" value="${idOf(orderId)}"><div class="field"><label for="disputeReason">Motivo</label><select class="input" id="disputeReason" name="reason"><option>Produto não recebido</option><option>Produto diferente do anúncio</option><option>Produto danificado</option><option>Problema com vendedor</option><option>Outro</option></select></div><div class="field"><label for="disputeDescription">Descrição</label><textarea class="input" id="disputeDescription" name="description" required maxlength="3000"></textarea></div><button class="btn btn-danger" type="submit">Abrir disputa</button></form>`);
  }

  async function openDispute(id) {
    try {
      const data = await api(`/api/disputes/${idOf(id)}`);
      const dispute = data.dispute || {};
      const messages = data.messages || [];
      const body = `<div class="notice ${dispute.status === 'resolved' ? 'notice-success' : 'notice-warning'}"><strong>${esc(dispute.reason)}</strong><br>${esc(statusLabels[dispute.status] || dispute.status)}${dispute.resolution ? ` · ${esc(dispute.resolution)}` : ''}</div><div class="dispute-messages">${messages.length ? messages.map(message => `<article class="review-card"><div class="review-meta"><strong>${esc(message.user_name)} · ${esc(message.user_role)}</strong><time>${esc(dateText(message.created_at))}</time></div><p>${esc(message.message)}</p></article>`).join('') : '<div class="empty">Nenhuma mensagem nesta disputa.</div>'}</div>${dispute.status !== 'resolved' ? `<form id="messageForm" data-dispute-id="${idOf(id)}"><div class="field"><label for="disputeMessage">Mensagem</label><textarea class="input" id="disputeMessage" name="message" required maxlength="3000"></textarea></div><button class="btn btn-primary" type="submit">Enviar mensagem</button></form>` : ''}`;
      openModal(`Disputa #${idOf(id)}`, body, true);
    } catch (error) { toast(error.message, 'error'); }
  }

  function openResolveDispute(id) {
    openModal('Resolver disputa', `<form id="resolveForm" data-dispute-id="${idOf(id)}"><div class="field"><label for="resolution">Decisão</label><select class="input" id="resolution" name="resolution"><option value="release_seller">Liberar vendedor</option><option value="refund_buyer">Reembolsar comprador</option><option value="partial_refund">Reembolso parcial</option><option value="agreement">Acordo entre as partes</option><option value="closed_no_action">Encerrar sem ação</option></select></div><div class="field"><label for="adminNote">Fundamentação</label><textarea class="input" id="adminNote" name="admin_note" required maxlength="3000"></textarea></div><div class="notice notice-warning">A decisão não transmite BTC. Liquidação ou devolução exige fluxo PSBT próprio.</div><button class="btn btn-primary" type="submit">Registrar decisão</button></form>`);
  }

  async function loadSeller() {
    if (state.user?.role !== 'seller') { showView('home'); return; }
    const root = $('#sellerContent');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando painel da loja');
    try {
      state.seller = await api('/api/seller/dashboard');
      renderSeller();
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  function metricText(value) {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function dashMetric(label, value, bitcoin = false) {
    const text = value === null || value === undefined || value === '' ? '—' : `${bitcoin ? '₿ ' : ''}${esc(value)}`;
    return `<article class="dash-hero-metric"><small>${esc(label)}</small><strong>${text}</strong></article>`;
  }

  function sellerBanner(store, tab, metrics, products) {
    const sectionName = { overview: 'Visão geral', products: 'Produtos', orders: 'Pedidos', store: 'Minha loja' }[tab] || 'Painel';
    const tabKey = ['overview', 'products', 'orders', 'store'].includes(tab) ? tab : 'overview';
    const metricStrip = store ? `<div class="dash-hero-metrics">${dashMetric('Score da loja', store.score)}${dashMetric('Produtos ativos', metrics.products ?? products.length)}${dashMetric('Vendas (BTC)', metrics.sales_btc, true)}${dashMetric('A receber (BTC)', metrics.pending_btc, true)}</div>` : '<div class="dash-hero-metrics dash-hero-empty">Cadastre os dados da loja para começar a acompanhar pedidos e estoque.</div>';
    const subline = store ? 'Pedidos, produtos e repasses em um só lugar.' : 'Cadastre sua loja para publicar produtos.';
    const heading = tabKey === 'overview' ? 'SUA LOJA. <span>SUAS REGRAS.</span>' : `<span>${esc(sectionName)}</span>`;
    const titleLabel = tabKey === 'overview' ? 'SUA LOJA. / SUAS REGRAS.' : sectionName;
    return `<header class="dash-hero seller-dash-hero seller-tab-${tabKey}"><div class="dash-hero-copy"><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Painel do vendedor · ${esc(sectionName)}</p><h1 tabindex="-1" data-dashboard-title aria-label="${esc(titleLabel)}">${heading}</h1><p>${subline}</p></div><img class="dash-hero-art" src="/static/assets/seller-parcel.webp" alt="" aria-hidden="true"><img class="dash-hero-product dash-hero-keyboard" src="/static/assets/products/keyboard.webp" alt="" aria-hidden="true"><img class="dash-hero-product dash-hero-watch" src="/static/assets/products/watch.webp" alt="" aria-hidden="true">${metricStrip}</header>`;
  }

  function sellerStockPanel(products) {
    const stockItems = products.filter(product => product.active !== false).slice().sort((first, second) => num(first.stock) - num(second.stock)).slice(0, 4);
    const rows = stockItems.length ? stockItems.map(product => {
      const fallback = productImage({ ...product, image_url: '' });
      const source = productImage(product);
      const thumb = source
        ? `<img data-image-context="stock" src="${esc(source)}"${fallback && fallback !== source ? ` data-fallback="${esc(fallback)}"` : ''} alt="" loading="lazy">`
        : '<i class="bi bi-box-seam" aria-hidden="true"></i>';
      return `<button class="stock-row" type="button" data-action="edit-product" data-id="${idOf(product.id)}"><span class="stock-thumb ${source ? '' : 'stock-thumb-empty'}">${thumb}</span><span class="stock-copy"><strong>${esc(product.name)}</strong><small>${esc(product.category || 'Produto')}</small></span><span class="stock-quantity"><strong>${idOf(product.stock)}</strong><small>un.</small></span></button>`;
    }).join('') : '<div class="empty">Nenhum produto ativo no estoque.</div>';
    return `<section class="panel stock-panel"><div class="section-heading"><div><p class="eyebrow">INVENTÁRIO</p><h2>Menor estoque</h2></div><button class="btn btn-secondary btn-sm" type="button" data-seller-tab="products">Ver produtos</button></div><div class="stock-list">${rows}</div></section>`;
  }

  function sellerDisputesPanel(disputes) {
    const open = disputes.filter(dispute => dispute.status !== 'resolved');
    return `<section class="panel"><div class="section-heading"><div><p class="eyebrow">ATENDIMENTO</p><h2>Disputas em aberto</h2></div><button class="btn btn-secondary btn-sm" type="button" data-seller-tab="orders">Ver pedidos</button></div>${open.length ? disputesTable(open.slice(0, 3), false) : '<div class="empty">Nenhuma disputa em aberto.</div>'}</section>`;
  }

  function sellerActionCards() {
    return `<div class="dashboard-action-cards" aria-label="Atalhos da loja"><button class="dashboard-action-card" type="button" data-seller-tab="products"><i class="bi bi-plus-square" aria-hidden="true"></i><span><strong>Adicionar produto</strong><small>Cadastro e estoque</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button><button class="dashboard-action-card" type="button" data-seller-tab="orders"><i class="bi bi-receipt" aria-hidden="true"></i><span><strong>Acompanhar pedidos</strong><small>Pagamento e entrega</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button><button class="dashboard-action-card" type="button" data-seller-tab="store"><i class="bi bi-shop" aria-hidden="true"></i><span><strong>Editar minha loja</strong><small>Dados e repasse</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button></div>`;
  }

  function renderSeller() {
    const data = state.seller || {};
    const store = data.store || null;
    const metrics = data.metrics || {};
    const products = data.products || [];
    const orders = data.orders || [];
    const disputes = data.disputes || [];
    $$('.dashboard-nav-link[data-seller-tab]').forEach(button => {
      const active = button.dataset.sellerTab === state.sellerTab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const banner = sellerBanner(store, state.sellerTab, metrics, products);
    let content = '';
    if (state.sellerTab === 'overview') {
      content = store
        ? `${banner}<div class="notice notice-info payout-note"><span>Regra de repasse</span><strong>${esc(metricText(store.payout_rule))}</strong></div><div class="seller-overview-grid"><div class="dashboard-panel-stack"><section class="panel"><div class="section-heading"><div><p class="eyebrow">ATIVIDADE</p><h2>Pedidos recentes</h2></div><button class="btn btn-secondary btn-sm" type="button" data-seller-tab="orders">Ver todos</button></div>${orderTable(orders.slice(0, 5), true)}</section>${sellerActionCards()}</div><div class="dashboard-panel-stack">${sellerStockPanel(products)}${sellerDisputesPanel(disputes)}</div></div>`
        : `${banner}<section class="panel section"><div class="section-heading"><div><p class="eyebrow">PRIMEIRO PASSO</p><h2>Cadastre sua loja</h2></div></div><p>Informe nome, dados de contato e destino de repasse para começar.</p>${storeFormHtml(null)}</section>`;
    } else if (state.sellerTab === 'products') {
      content = `${banner}<div class="grid-2 seller-forms"><section class="panel"><h2 id="productFormTitle">Novo produto</h2>${productFormHtml()}</section><section class="panel"><h2>Produtos cadastrados</h2>${sellerProductsTable(products)}</section></div>`;
    } else if (state.sellerTab === 'orders') {
      content = `${banner}<section class="panel section"><div class="section-heading"><div><p class="eyebrow">OPERAÇÃO</p><h2>Pedidos da loja</h2></div></div>${orderTable(orders, true)}</section><section class="panel section"><div class="section-heading"><div><p class="eyebrow">ATENDIMENTO</p><h2>Disputas</h2></div></div>${disputesTable(disputes, false)}</section>`;
    } else {
      content = `${banner}<section class="panel section"><div class="section-heading"><div><p class="eyebrow">IDENTIDADE E REPASSE</p><h2>${store ? 'Dados da loja' : 'Criar loja'}</h2></div></div>${storeFormHtml(store)}</section>`;
    }
    $('#sellerContent').innerHTML = content;
  }

  function storeFormHtml(store) {
    return `<form id="storeForm"><div class="field"><label for="storeName">Nome</label><input class="input" id="storeName" name="name" required value="${esc(store?.name || '')}"></div><div class="field"><label for="storeDescription">Descrição</label><textarea class="input" id="storeDescription" name="description" maxlength="2000">${esc(store?.description || '')}</textarea></div><div class="grid-2"><div class="field"><label for="storeLogo">URL do logo</label><input class="input" id="storeLogo" name="logo_url" type="url" value="${esc(store?.logo_url || '')}"></div><div class="field"><label for="storeBanner">URL do banner</label><input class="input" id="storeBanner" name="banner_url" type="url" value="${esc(store?.banner_url || '')}"></div></div><div class="field"><label for="storePayout">Endereço Bitcoin de repasse</label><input class="input" id="storePayout" name="payout_address" value="${esc(store?.payout_address || '')}"><small>Destino indicado nas propostas de liquidação.</small></div><div class="field"><label for="storePubkey">Chave pública escrow da loja</label><input class="input" id="storePubkey" name="escrow_pubkey" value="${esc(store?.escrow_pubkey || '')}" placeholder="Chave pública comprimida"><small>Informe chave pública. Não envie seed ou chave privada.</small></div><button class="btn btn-primary" type="submit">Salvar loja</button></form>`;
  }

  function productFormHtml(product = null) {
    return `<form id="productForm"><input type="hidden" name="id" value="${idOf(product?.id)}"><div class="field"><label for="productName">Nome</label><input class="input" id="productName" name="name" required value="${esc(product?.name || '')}"></div><div class="field"><label for="productSummary">Resumo</label><input class="input" id="productSummary" name="short_description" maxlength="300" value="${esc(product?.short_description || '')}"></div><div class="grid-2"><div class="field"><label for="productPrice">Preço BTC</label><input class="input" id="productPrice" name="price_btc" type="number" min="0.00000001" step="0.00000001" required value="${esc(product?.price_btc || '')}"></div><div class="field"><label for="productCompare">Preço anterior BTC</label><input class="input" id="productCompare" name="compare_at_btc" type="number" min="0" step="0.00000001" value="${esc(product?.compare_at_btc || '')}"></div></div><div class="grid-2"><div class="field"><label for="productStock">Estoque</label><input class="input" id="productStock" name="stock" type="number" min="0" step="1" required value="${esc(product?.stock ?? '')}"></div><div class="field"><label for="productCategory">Categoria</label><input class="input" id="productCategory" name="category" value="${esc(product?.category || 'Outros')}"></div></div><div class="field"><label for="productImage">URL da imagem</label><input class="input" id="productImage" name="image_url" type="url" value="${esc(product?.image_url || '')}"></div><div class="field"><label for="productDescription">Descrição</label><textarea class="input" id="productDescription" name="description" maxlength="4000">${esc(product?.description || '')}</textarea></div><div class="actions"><button class="btn btn-primary" type="submit">Salvar produto</button><button class="btn btn-secondary ${product ? '' : 'hidden'}" type="button" data-action="reset-product">Cancelar edição</button></div></form>`;
  }

  function sellerProductsTable(products) {
    if (!products.length) return '<div class="empty">Nenhum produto cadastrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Preço</th><th>Estoque</th><th>Status</th><th>Ações</th></tr></thead><tbody>${products.map(product => `<tr><td><strong>${esc(product.name)}</strong><br><small>${esc(product.category)}</small></td><td>₿ ${esc(product.price_btc)}</td><td>${idOf(product.stock)}</td><td><span class="status ${product.active ? 'active' : 'cancelled'}">${product.active ? 'Ativo' : 'Desativado'}</span></td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="edit-product" data-id="${idOf(product.id)}">Editar</button>${product.active ? `<button class="btn btn-danger btn-sm" type="button" data-action="disable-product" data-id="${idOf(product.id)}">Desativar</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function disputesTable(disputes, isAdmin = true) {
    if (!disputes?.length) return '<div class="empty">Nenhuma disputa registrada.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Motivo</th><th>Loja</th><th>Status</th><th>Ações</th></tr></thead><tbody>${disputes.map(dispute => `<tr><td>${esc(dispute.order_reference)}</td><td>${esc(dispute.reason)}<br><small>${esc(dispute.opened_by_name || '')}</small></td><td>${esc(dispute.store_name || (isAdmin ? '—' : 'Esta loja'))}</td><td>${statusTag(dispute.status)}</td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="open-dispute-thread" data-id="${idOf(dispute.id)}">Conversa</button>${isAdmin && dispute.status !== 'resolved' ? `<button class="btn btn-primary btn-sm" type="button" data-action="resolve-dispute" data-id="${idOf(dispute.id)}">Resolver</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  async function saveStore(event) {
    event.preventDefault();
    try {
      const data = await api('/api/store', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      toast(data.message || 'Loja salva.');
      await loadSeller();
      await loadStores();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function saveProduct(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const productId = idOf(values.id);
    delete values.id;
    try {
      const data = await api(productId ? `/api/products/${productId}` : '/api/products', { method: productId ? 'PUT' : 'POST', body: JSON.stringify(values) });
      toast(data.message || 'Produto salvo.');
      await loadSeller();
      await loadProducts();
    } catch (error) { toast(error.message, 'error'); }
  }

  function editProduct(id) {
    const product = state.seller?.products?.find(item => idOf(item.id) === idOf(id));
    if (!product) return;
    state.sellerTab = 'products';
    renderSeller();
    const oldForm = $('#productForm');
    const newForm = document.createElement('div');
    newForm.innerHTML = productFormHtml(product);
    oldForm.replaceWith(newForm.firstElementChild);
    $('#productFormTitle').textContent = 'Editar produto';
    $('#productName')?.focus();
    $('#productForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetProduct() {
    state.sellerTab = 'products';
    renderSeller();
    $('#productName')?.focus();
  }

  async function disableProduct(id) {
    if (!window.confirm('Desativar este produto?')) return;
    try {
      const data = await api(`/api/products/${idOf(id)}`, { method: 'DELETE', body: '{}' });
      toast(data.message || 'Produto desativado.');
      await loadSeller();
      await loadProducts();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function loadAdmin() {
    if (state.user?.role !== 'admin') { showView('home'); return; }
    const root = $('#adminContent');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando painel administrativo');
    try {
      state.admin = await api('/api/admin/dashboard');
      renderAdmin();
    } catch (error) { if (root) root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  function adminOverview(data, openDisputes) {
    const orders = data.orders || [];
    const batches = data.batches || [];
    const actionCards = `<div class="dashboard-action-cards" aria-label="Atalhos administrativos"><button class="dashboard-action-card" type="button" data-admin-tab="settlements"><i class="bi bi-arrow-left-right" aria-hidden="true"></i><span><strong>Liquidações</strong><small>Revisar lotes e saldos</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button><button class="dashboard-action-card" type="button" data-admin-tab="treasury"><i class="bi bi-safe2" aria-hidden="true"></i><span><strong>Tesouraria</strong><small>Destinos e reservas</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button><button class="dashboard-action-card" type="button" data-admin-tab="disputes"><i class="bi bi-shield-exclamation" aria-hidden="true"></i><span><strong>Disputas</strong><small>Conversa e decisão</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button><button class="dashboard-action-card" type="button" data-admin-tab="users"><i class="bi bi-people" aria-hidden="true"></i><span><strong>Usuários e lojas</strong><small>Contas e operação</small></span><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button></div>`;
    return `<div class="admin-overview-grid"><div class="dashboard-panel-stack"><section class="panel"><div class="section-heading"><div><p class="eyebrow">ATIVIDADE</p><h2>Pedidos recentes</h2></div>${config.btcMode === 'rpc' ? '<button class="btn btn-secondary btn-sm" type="button" data-action="sync-all">Sincronizar pagamentos</button>' : ''}</div>${adminOrdersTable(orders.slice(0, 5))}</section>${actionCards}</div><div class="dashboard-panel-stack"><section class="panel"><div class="section-heading"><div><p class="eyebrow">MEDIAÇÃO</p><h2>Disputas em aberto</h2></div><button class="btn btn-secondary btn-sm" type="button" data-admin-tab="disputes">Ver todas</button></div>${openDisputes.length ? disputesTable(openDisputes.slice(0, 4), true) : '<div class="empty">Nenhuma disputa em aberto.</div>'}</section><section class="panel"><div class="section-heading"><div><p class="eyebrow">LIQUIDAÇÕES</p><h2>Lotes recentes</h2></div><button class="btn btn-secondary btn-sm" type="button" data-admin-tab="settlements">Ver lotes</button></div>${batchesTable(batches.slice(0, 3))}</section></div></div>`;
  }

  function renderAdmin() {
    const data = state.admin || {};
    const metrics = data.metrics || {};
    const wallet = data.wallet || {};
    const orders = data.orders || [];
    const disputes = data.disputes || [];
    const openDisputes = disputes.filter(dispute => dispute.status !== 'resolved');
    $$('.dashboard-nav-link[data-admin-tab]').forEach(button => {
      const active = button.dataset.adminTab === state.adminTab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const labels = { overview: 'Visão geral', settlements: 'Liquidações', treasury: 'Tesouraria', disputes: 'Disputas', users: 'Usuários e lojas', audit: 'Auditoria' };
    const walletStatus = `${metricText(wallet.mode)} · ${metricText(wallet.network || config.btcNetwork)} · ${metricText(statusLabels[wallet.status] || wallet.status)}`;
    const metricStrip = `<div class="dash-hero-metrics">${dashMetric('Recebido (BTC)', metrics.paid_btc, true)}${dashMetric('Pedidos', metrics.orders ?? orders.length)}${dashMetric('Disputas em aberto', metrics.disputes ?? openDisputes.length)}${dashMetric('UTXOs', wallet.utxos)}</div>`;
    const tabKey = labels[state.adminTab] ? state.adminTab : 'overview';
    const heading = tabKey === 'overview' ? 'CENTRO <span>DE CONTROLE</span>' : `<span>${esc(labels[tabKey])}</span>`;
    const titleLabel = tabKey === 'overview' ? 'CENTRO / DE CONTROLE' : labels[tabKey];
    const banner = `<header class="dash-hero admin-dash-hero admin-tab-${tabKey}"><div class="dash-hero-copy"><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> BitLoja · Administração · ${esc(labels[tabKey] || 'Painel')}</p><h1 tabindex="-1" data-dashboard-title aria-label="${esc(titleLabel)}">${heading}</h1><p>Carteira ${esc(walletStatus)}${wallet.error ? ` · ${esc(wallet.error)}` : ''}</p></div><img class="dash-hero-art" src="/static/assets/bitcoin-crystal.webp" alt="" aria-hidden="true">${metricStrip}</header>`;
    $('#adminContent').innerHTML = `${banner}<div id="adminTabContent">${adminTabContent(data, openDisputes)}</div>`;
  }

  function adminTabContent(data, openDisputes = []) {
    if (state.adminTab === 'settlements') return settlementsSection(data);
    if (state.adminTab === 'treasury') return treasurySection(data);
    if (state.adminTab === 'disputes') return `<section class="panel section"><div class="section-heading"><div><p class="eyebrow">MEDIAÇÃO</p><h2>Central de disputas</h2></div></div>${disputesTable(data.disputes || [], true)}</section>`;
    if (state.adminTab === 'users') return usersSection(data);
    if (state.adminTab === 'audit') return auditSection(data);
    return adminOverview(data, openDisputes);
  }

  function adminOrdersTable(orders) {
    if (!orders.length) return '<div class="empty">Nenhum pedido registrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Comprador</th><th>Loja</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${esc(order.reference)}</strong></td><td>${esc(order.buyer_name || '')}</td><td>${esc(order.store_name || '')}</td><td>₿ ${esc(order.total_btc)}</td><td>${statusTag(order.status)}</td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="open-order" data-id="${idOf(order.id)}">Detalhes</button>${config.btcMode === 'demo' && order.status === 'awaiting_payment' ? `<button class="btn btn-secondary btn-sm" type="button" data-action="mock-credit" data-id="${idOf(order.id)}">Crédito demo</button>` : ''}${['awaiting_payment', 'partial'].includes(order.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="sync-order" data-id="${idOf(order.id)}">Sincronizar</button>` : ''}${num(order.paid_sats) > 0 && !['refunded', 'cancelled'].includes(order.status) ? `<button class="btn btn-danger btn-sm" type="button" data-action="admin-refund" data-id="${idOf(order.id)}">Reembolsar</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function settlementsSection(data) {
    return `<div class="grid-2 section"><section class="panel"><h2>Novo ciclo de liquidação</h2><p>O cálculo usa pedidos elegíveis, endereço de repasse, score e disputas abertas.</p><button class="btn btn-primary" type="button" data-action="preview-settlement"><i class="bi bi-calculator" aria-hidden="true"></i> Calcular saldos elegíveis</button></section><section class="panel"><h2>Regra de repasse</h2><p>Os critérios exibidos são calculados no servidor para cada loja e pedido.</p></section></div><section class="panel section"><h2>Lotes de liquidação</h2>${batchesTable(data.batches || [])}</section>`;
  }

  function batchesTable(batches) {
    if (!batches.length) return '<div class="empty">Nenhum lote criado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Lote</th><th>Destinos</th><th>Total</th><th>Status</th><th>Ação</th></tr></thead><tbody>${batches.map(batch => `<tr><td><strong>${esc(batch.reference)}</strong><br><small>${esc(dateText(batch.created_at))}</small></td><td>${esc(batch.destination_count ?? batch.store_count ?? batch.items_count ?? '—')}</td><td>₿ ${esc(batch.total_btc)}</td><td>${statusTag(batch.status)}</td><td><button class="btn btn-secondary btn-sm" type="button" data-action="open-batch" data-id="${idOf(batch.id)}">Detalhes</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function treasurySection(data) {
    const destinations = data.destinations || [];
    const active = destinations.filter(item => item.active);
    const wallet = data.wallet || {};
    const rpc = config.btcMode === 'rpc';
    const direct = rpc && config.commissionSigningMode === 'hot';
    return `<section class="panel treasury-workflow section" aria-labelledby="treasuryWorkflowTitle"><div class="section-heading"><div><p class="eyebrow">RESERVAS E COMISSÕES</p><h2 id="treasuryWorkflowTitle">Escolha operação pelo destino</h2></div><button class="btn btn-secondary btn-sm" type="button" data-action="refresh-treasury"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Atualizar dados</button></div><p>Escrows on-chain são liberados por PSBT de cada pedido. Estas operações usam carteira de comissão e reservas.</p>
      <svg class="treasury-flow-svg" viewBox="0 0 760 150" role="img" aria-labelledby="treasurySvgTitle treasurySvgDesc"><title id="treasurySvgTitle">Fluxo das reservas Bitcoin</title><desc id="treasurySvgDesc">Endereço de recebimento, carteira de comissão e destinos aprovados. Consolidação reúne UTXOs; distribuição usa pesos.</desc><path class="flow-link" d="M150 65H318M442 65H610" fill="none"/><circle class="flow-pulse" cx="230" cy="65" r="5"/><circle class="flow-pulse" cx="530" cy="65" r="5"/><rect class="flow-node" x="12" y="20" width="138" height="90" rx="18"/><rect class="flow-node" x="318" y="20" width="124" height="90" rx="18"/><rect class="flow-node" x="610" y="20" width="138" height="90" rx="18"/><text class="flow-label" x="81" y="57" text-anchor="middle">Recebimento</text><text class="flow-caption" x="81" y="81" text-anchor="middle">Endereço Core</text><text class="flow-label" x="380" y="57" text-anchor="middle">Comissões</text><text class="flow-caption" x="380" y="81" text-anchor="middle">UTXOs da carteira</text><text class="flow-label" x="679" y="57" text-anchor="middle">Reservas</text><text class="flow-caption" x="679" y="81" text-anchor="middle">Destinos + pesos</text><text class="flow-caption" x="233" y="132" text-anchor="middle">Consolidar quando necessário</text><text class="flow-caption" x="527" y="132" text-anchor="middle">Revisar antes de distribuir</text></svg>
      <div class="treasury-route" aria-label="Atalhos das operações">${[['treasuryReceive', '01', 'Receber'], ['treasuryConsolidate', '02', 'Consolidar'], ['treasuryDistribute', '03', 'Distribuir'], ['treasuryDestinations', '04', 'Destinos']].map(([section, step, label]) => `<button class="btn btn-secondary" type="button" data-action="treasury-section" data-section="${section}"><small>${step}</small> ${label}</button>`).join('')}</div><div class="notice notice-info">Rede ${esc(wallet.network || config.btcNetwork)} · Bitcoin ${esc(config.btcMode)} · assinatura ${esc(config.commissionSigningMode)}. ${direct ? 'Envio direto habilitado; confirmação administrativa continua obrigatória.' : rpc ? 'Envio direto desativado. Use PSBT de comissão para assinatura externa.' : 'Modo sem operações de rede. Prévia local e consulta permanecem disponíveis.'}</div></section>
      <div class="grid-2 treasury-operation-grid section"><section class="panel" id="treasuryReceive" tabindex="-1"><p class="eyebrow">01 / RECEBER</p><h2>Endereço de comissão</h2><p>Crie endereço rotulado na carteira de comissão do Bitcoin Core. Saldo só muda após recebimento e confirmação.</p><dl class="treasury-wallet-status"><div><dt>Estado do Core</dt><dd>${esc(statusLabels[wallet.status] || wallet.status || 'Não informado')}</dd></div><div><dt>UTXOs retornados</dt><dd>${esc(wallet.utxos ?? '—')}</dd></div></dl><button class="btn btn-primary" type="button" data-action="new-settlement-address" ${rpc ? '' : 'disabled'}><i class="bi bi-qr-code" aria-hidden="true"></i> Criar endereço</button>${!rpc ? '<small>Geração requer Bitcoin Core no modo RPC.</small>' : ''}</section>
      <section class="panel" id="treasuryConsolidate" tabindex="-1"><p class="eyebrow">02 / CONSOLIDAR</p><h2>Reunir UTXOs</h2><p>Consolidação transfere UTXOs da carteira para endereço único e consome taxa de rede. Não libera escrows de compradores.</p><div class="field"><label for="consolidateDestination">Destino da consolidação (opcional)</label><input class="input" id="consolidateDestination" maxlength="160" spellcheck="false" autocomplete="off"><small>Vazio: servidor gera destino na carteira de comissão.</small></div><button class="btn btn-danger" type="button" data-action="consolidate" ${direct ? '' : 'disabled'}>Centralizar UTXOs</button>${!direct ? '<p class="treasury-capability-note">Requer RPC e assinatura hot habilitada no servidor.</p>' : ''}</section></div>
      <section class="panel section" id="treasuryDistribute" tabindex="-1"><div class="section-heading"><div><p class="eyebrow">03 / DISTRIBUIR</p><h2>Simule divisão antes do envio</h2></div><span class="mode-tag">Prévia local · sem movimentação</span></div><p>Selecione destinos ativos. Peso define proporção; último destino recebe resto de satoshis do arredondamento.</p><div class="grid-2"><div><div class="field"><label for="reserveAmount">Valor BTC</label><input class="input" id="reserveAmount" type="number" min="0.00000001" step="0.00000001" inputmode="decimal"><small>Até 8 casas decimais, sem notação científica.</small></div><div id="destinationChecks">${active.length ? active.map(item => `<label class="check-row"><input type="checkbox" value="${idOf(item.id)}" data-reserve-dest><span><strong>${esc(item.label)}</strong><small>Peso ${esc(item.weight)} · ${esc(short(item.address, 28))}</small></span></label>`).join('') : '<div class="empty">Cadastre e ative destino para usar prévia.</div>'}</div><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="select-reserve-destinations" ${active.length ? '' : 'disabled'}>Selecionar todos</button><button class="btn btn-secondary btn-sm" type="button" data-action="clear-reserve-destinations" ${active.length ? '' : 'disabled'}>Limpar seleção</button></div></div><div class="treasury-preview" id="reservePreview" role="status" aria-live="polite"><p>Informe valor e selecione destinos para visualizar divisão.</p></div></div><p class="treasury-preview-note">Prévia local — servidor confirma divisão e taxas. Taxa de rede não está incluída. Destinos repetidos por endereço são agrupados pelo servidor.</p><div class="actions"><button class="btn btn-primary" type="button" data-action="distribute-reserves" ${direct && active.length ? '' : 'disabled'}>Revisar e distribuir reservas</button>${!direct ? '<button class="btn btn-secondary" type="button" data-view="custody">Abrir PSBT de comissão <i class="bi bi-arrow-up-right" aria-hidden="true"></i></button>' : ''}</div></section>
      <div class="grid-2 section treasury-destinations" id="treasuryDestinations" tabindex="-1"><section class="panel"><p class="eyebrow">04 / DESTINOS</p><h2>Novo destino aprovado</h2><p>Cadastro define endereço e peso. Ativação não envia Bitcoin.</p><form id="destinationForm"><div class="field"><label for="destinationLabel">Rótulo</label><input class="input" id="destinationLabel" name="label" required maxlength="120"></div><div class="field"><label for="destinationAddress">Endereço Bitcoin</label><input class="input" id="destinationAddress" name="address" required maxlength="160" spellcheck="false" autocomplete="off"></div><div class="field"><label for="destinationWeight">Peso</label><input class="input" id="destinationWeight" name="weight" type="number" min="1" max="100" value="1" required></div><button class="btn btn-primary" type="submit">Cadastrar destino</button></form></section><section class="panel"><div class="section-heading"><div><h2>Destinos cadastrados</h2><p>${destinations.length} no cadastro · ${active.length} ativos</p></div><button class="btn btn-secondary btn-sm" type="button" data-action="export-destinations"><i class="bi bi-download" aria-hidden="true"></i> Exportar CSV</button></div><div class="field"><label for="treasuryDestinationSearch">Buscar rótulo ou endereço</label><input class="input" id="treasuryDestinationSearch" type="search" value="${esc(state.treasurySearch)}"></div><div class="field"><label for="treasuryDestinationFilter">Estado do destino</label><select class="input" id="treasuryDestinationFilter">${[['all', 'Todos'], ['active', 'Ativos'], ['inactive', 'Inativos']].map(([value, label]) => `<option value="${value}" ${state.treasuryFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div id="treasuryDestinationResults">${destinationsTable(filteredDestinations(destinations))}</div></section></div>
      <div class="actions treasury-shortcuts"><button class="btn btn-secondary" type="button" data-admin-tab="settlements">Liquidações elegíveis</button><button class="btn btn-secondary" type="button" data-admin-tab="audit">Auditoria</button><button class="btn btn-secondary" type="button" data-view="custody">Comissões e PSBTs</button></div>`;
  }

  function btcStringToSats(value) {
    const match = String(value || '').trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
    if (!match) return null;
    return BigInt(match[1]) * 100000000n + BigInt((match[2] || '').padEnd(8, '0'));
  }

  function satsToBtcText(sats) {
    const text = BigInt(sats).toString().padStart(9, '0');
    return `${text.slice(0, -8)}.${text.slice(-8)}`;
  }

  function calculateReserveAllocation(amount, destinations) {
    const sats = btcStringToSats(amount);
    if (sats === null || sats <= 0n || !destinations.length) return [];
    const sorted = destinations.slice().sort((first, second) => idOf(first.id) - idOf(second.id));
    const weight = sorted.reduce((total, destination) => total + BigInt(Math.max(1, idOf(destination.weight))), 0n);
    let remaining = sats;
    return sorted.map((destination, index) => {
      const share = index === sorted.length - 1 ? remaining : sats * BigInt(Math.max(1, idOf(destination.weight))) / weight;
      remaining -= share;
      return { ...destination, sats: share };
    });
  }

  function updateReservePreview() {
    const root = $('#reservePreview');
    if (!root) return [];
    const ids = new Set($$('[data-reserve-dest]:checked').map(input => idOf(input.value)));
    const selected = (state.admin?.destinations || []).filter(item => item.active && ids.has(idOf(item.id)));
    const allocation = calculateReserveAllocation($('#reserveAmount')?.value, selected);
    root.innerHTML = allocation.length ? `<h3>Divisão estimada</h3>${allocation.map(item => `<div class="summary-line"><span>${esc(item.label)}<small>Peso ${idOf(item.weight)}</small></span><strong>₿ ${satsToBtcText(item.sats)}<small>${item.sats.toLocaleString('pt-BR')} sats</small></strong></div>`).join('')}<div class="summary-total"><span>Total alocado</span><strong>₿ ${satsToBtcText(allocation.reduce((total, item) => total + item.sats, 0n))}</strong></div>` : '<p>Informe valor positivo com até 8 casas decimais e selecione destinos ativos.</p>';
    return allocation;
  }

  function filteredDestinations(destinations = state.admin?.destinations || []) {
    const search = state.treasurySearch.trim().toLocaleLowerCase('pt-BR');
    return destinations.filter(item => (state.treasuryFilter === 'all' || (state.treasuryFilter === 'active' ? Boolean(item.active) : !item.active)) && `${item.label} ${item.address}`.toLocaleLowerCase('pt-BR').includes(search));
  }

  function exportDestinations() {
    const cell = value => `"${String(value ?? '').replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
    const rows = filteredDestinations().map(item => [item.id, item.label, item.address, item.weight, item.active ? 'Ativo' : 'Inativo', item.created_at]);
    downloadText([['ID', 'Rótulo', 'Endereço', 'Peso', 'Status', 'Criado em'], ...rows].map(row => row.map(cell).join(';')).join('\r\n'), 'bitloja-destinos.csv');
  }

  function destinationsTable(destinations) {
    if (!destinations.length) return '<div class="empty">Nenhum destino cadastrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Destino</th><th>Peso</th><th>Status</th><th>Ações</th></tr></thead><tbody>${destinations.map(item => `<tr><td><strong>${esc(item.label)}</strong><br><code title="${esc(item.address)}">${esc(short(item.address, 30))}</code></td><td>${esc(item.weight)}</td><td>${item.active ? 'Ativo' : 'Inativo'}</td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="copy" data-value="${esc(item.address)}" aria-label="Copiar endereço de ${esc(item.label)}">Copiar</button><button class="btn btn-secondary btn-sm" type="button" data-action="toggle-destination" data-id="${idOf(item.id)}">${item.active ? 'Desativar' : 'Ativar'}</button></div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function usersSection(data) {
    const users = data.users || [];
    const stores = data.stores || [];
    return `<div class="grid-2 section"><section class="panel"><h2>Usuários</h2>${users.length ? `<div class="table-wrap"><table><thead><tr><th>Conta</th><th>Perfil</th><th>Ação</th></tr></thead><tbody>${users.map(user => `<tr><td>${esc(user.name)}<br><small>${esc(user.email)}</small></td><td>${esc(user.role)}</td><td>${idOf(user.id) === idOf(state.user?.id) ? 'Conta atual' : `<button class="btn ${user.active ? 'btn-danger' : 'btn-success'} btn-sm" type="button" data-action="toggle-user" data-id="${idOf(user.id)}">${user.active ? 'Desativar' : 'Ativar'}</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhum usuário.</div>'}</section><section class="panel"><h2>Lojas e score</h2>${stores.length ? `<div class="table-wrap"><table><thead><tr><th>Loja</th><th>Score</th><th>Ação</th></tr></thead><tbody>${stores.map(store => `<tr><td>${esc(store.name)}<br><small>${esc(store.tier || '')}</small></td><td>${esc(store.score)}</td><td><button class="btn ${store.active ? 'btn-danger' : 'btn-success'} btn-sm" type="button" data-action="toggle-store" data-id="${idOf(store.id)}">${store.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhuma loja.</div>'}</section></div>`;
  }

  function auditSection(data) {
    const logs = data.logs || [];
    return `<section class="panel section"><h2>Registro de auditoria</h2>${logs.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead><tbody>${logs.map(log => `<tr><td>${esc(dateText(log.created_at))}</td><td>${esc(log.user_name || 'Sistema')}</td><td>${esc(log.action)}</td><td>${esc(log.target_type)} ${esc(log.target_id)}</td><td>${esc(log.details)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhum evento de auditoria.</div>'}</section>`;
  }

  async function promptCritical(phrase) {
    const actionKey = window.prompt('Informe ADMIN_ACTION_KEY:');
    if (actionKey === null) return null;
    const confirmText = window.prompt(`Digite exatamente: ${phrase}`);
    if (confirmText === null) return null;
    return { action_key: actionKey, confirm: confirmText };
  }

  async function syncAll() {
    try { const data = await api('/api/admin/sync-payments', { method: 'POST', body: '{}' }); toast(data.message || 'Pagamentos sincronizados.'); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function mockCredit(id) {
    if (!window.confirm('Simular crédito integral deste pedido no modo demo?')) return;
    try { const data = await api(`/api/admin/mock-credit/${idOf(id)}`, { method: 'POST', body: '{}' }); toast(data.message || 'Crédito demo registrado.'); closeModal(); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function openSettlementPreview() {
    try {
      const data = await api('/api/admin/settlements/preview');
      const stores = data.stores || [];
      const body = stores.length ? `<div class="notice notice-info">Selecione lojas com pedidos elegíveis para criar lote.</div><form id="createBatchForm">${stores.map(store => `<label class="settlement-choice"><input type="checkbox" name="store_id" value="${idOf(store.store_id)}" ${store.eligible_order_ids?.length ? 'checked' : 'disabled'}><span><strong>${esc(store.store_name)}</strong><small>Score ${esc(store.score)} · ${esc(store.tier)} · ${idOf(store.eligible_order_ids?.length)} pedidos elegíveis · ${idOf(store.blocked_count)} bloqueados</small></span><strong>₿ ${esc(store.eligible_btc)}</strong></label>`).join('')}<div class="field"><label for="batchNotes">Notas do lote</label><input class="input" id="batchNotes" name="notes" maxlength="500"></div><button class="btn btn-primary" type="submit">Criar lote</button></form>` : '<div class="empty">Nenhum saldo elegível. Verifique critérios de status, score, endereço e disputas no servidor.</div>';
      openModal('Saldos elegíveis', body, true);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function createBatch(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const storeIds = $$('input[name="store_id"]:checked', form).map(input => idOf(input.value));
    try {
      const data = await api('/api/admin/settlements', { method: 'POST', body: JSON.stringify({ store_ids: storeIds, notes: form.elements.notes.value }) });
      closeModal();
      toast(`${data.message || 'Lote criado.'} ${data.reference || ''}`);
      await loadAdmin();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function openBatch(id) {
    try {
      const data = await api(`/api/admin/settlements/${idOf(id)}`);
      const batch = data.batch || {};
      const items = data.items || [];
      state.activeBatchPsbt = batch.psbt_base64 || '';
      const controls = `${batch.status === 'draft' ? '<button class="btn btn-primary" type="button" data-action="batch-create-psbt">Criar PSBT</button><button class="btn btn-danger" type="button" data-action="batch-cancel">Cancelar lote</button>' : ''}${['awaiting_signature', 'partially_signed'].includes(batch.status) ? '<button class="btn btn-secondary" type="button" data-action="batch-upload-psbt">Enviar PSBT assinada</button>' : ''}${batch.psbt_base64 ? '<button class="btn btn-secondary" type="button" data-action="batch-download-psbt">Baixar PSBT</button>' : ''}${batch.status === 'ready_to_broadcast' ? '<button class="btn btn-success" type="button" data-action="batch-broadcast">Transmitir lote</button>' : ''}`;
      openModal(`Lote ${batch.reference || id}`, `<div class="metrics"><article class="metric-card"><small>Total</small><strong>₿ ${esc(batch.total_btc)}</strong></article><article class="metric-card"><small>Status</small><strong>${esc(statusLabels[batch.status] || batch.status)}</strong></article></div><div class="notice notice-info">A PSBT é assinada fora do servidor. A transmissão só aparece quando o lote fica pronto.</div><section class="panel"><h3>Destinos</h3>${items.length ? items.map(item => `<div class="order-item-row"><span><strong>${esc(item.store_name)}</strong><small>${esc(item.payout_address)} · pedidos ${esc((item.order_ids || []).join(', '))}</small></span><strong>₿ ${esc(item.amount_btc)}</strong></div>`).join('') : '<div class="empty">Nenhum item no lote.</div>'}</section>${batch.txid ? `<p class="order-txid">TXID ${esc(batch.txid)}</p>` : ''}<div class="actions batch-actions" data-batch-id="${idOf(id)}">${controls}</div>`, true);
      state.activeBatchId = idOf(id);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function createBatchPsbt() {
    const critical = await promptCritical('CRIAR PSBT DO LOTE');
    if (!critical) return;
    try { const data = await api(`/api/admin/settlements/${state.activeBatchId}/psbt`, { method: 'POST', body: JSON.stringify(critical) }); toast(data.message || 'PSBT criada.'); await openBatch(state.activeBatchId); }
    catch (error) { toast(error.message, 'error'); }
  }

  function openPsbtUpload(title, onSubmit) {
    openModal(title, `<form id="psbtUploadForm"><div class="field"><label for="signedPsbt">PSBT assinada</label><textarea class="input mono-textarea" id="signedPsbt" name="psbt" required maxlength="1500000" spellcheck="false" autocomplete="off"></textarea></div><button class="btn btn-primary" type="submit">Enviar assinatura</button></form>`);
    $('#psbtUploadForm').addEventListener('submit', async event => {
      event.preventDefault();
      try { await onSubmit(event.currentTarget.elements.psbt.value.trim()); }
      catch (error) { toast(error.message, 'error'); }
    });
  }

  async function uploadBatchSigned() {
    const id = state.activeBatchId;
    openPsbtUpload('Enviar PSBT assinada', async psbt => {
      const data = await api(`/api/admin/settlements/${id}/signed`, { method: 'POST', body: JSON.stringify({ psbt }) });
      toast(data.message || 'Assinatura recebida.');
      await openBatch(id);
    });
  }

  async function broadcastBatch() {
    const id = state.activeBatchId;
    const critical = await promptCritical('TRANSMITIR LOTE');
    if (!critical) return;
    try { const data = await api(`/api/admin/settlements/${id}/broadcast-psbt`, { method: 'POST', body: JSON.stringify(critical) }); toast(`${data.message || 'Lote transmitido.'} ${short(data.txid)}`); closeModal(); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function cancelBatch() {
    if (!window.confirm('Cancelar lote e liberar pedidos?')) return;
    try { const data = await api(`/api/admin/settlements/${state.activeBatchId}/cancel`, { method: 'POST', body: '{}' }); toast(data.message || 'Lote cancelado.'); closeModal(); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function createSettlementAddress() {
    const critical = await promptCritical('CRIAR CARTEIRA DE LIQUIDACAO');
    if (!critical) return;
    try {
      const data = await api('/api/admin/treasury/new-settlement-address', { method: 'POST', body: JSON.stringify(critical) });
      openModal('Endereço de liquidação', `<div class="address">${esc(data.address)}</div><button class="btn btn-secondary" type="button" data-action="copy" data-value="${esc(data.address)}">Copiar endereço</button>`);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function consolidateTreasury() {
    if (config.btcMode !== 'rpc' || config.commissionSigningMode !== 'hot') return;
    const critical = await promptCritical('CENTRALIZAR TESOURARIA');
    if (!critical) return;
    try { const data = await api('/api/admin/treasury/consolidate', { method: 'POST', body: JSON.stringify({ ...critical, destination: String($('#consolidateDestination')?.value || '').trim() }) }); toast(`${data.message || 'Consolidação enviada.'} TX ${short(data.txid)}`); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function distributeReserves() {
    if (config.btcMode !== 'rpc' || config.commissionSigningMode !== 'hot') return;
    const allocation = updateReservePreview();
    if (!allocation.length) { focusIfVisible($('#reserveAmount')); return; }
    const critical = await promptCritical('DISTRIBUIR RESERVAS');
    if (!critical) return;
    const destinationIds = $$('[data-reserve-dest]:checked').map(input => idOf(input.value));
    try { const data = await api('/api/admin/treasury/distribute', { method: 'POST', body: JSON.stringify({ ...critical, amount_btc: $('#reserveAmount')?.value, destination_ids: destinationIds }) }); toast(`${data.message || 'Distribuição enviada.'} TX ${short(data.txid)}`); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function addDestination(event) {
    event.preventDefault();
    try { const data = await api('/api/admin/treasury/destinations', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); toast(data.message || 'Destino cadastrado.'); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function toggleDestination(id) {
    try { const data = await api(`/api/admin/treasury/destinations/${idOf(id)}/toggle`, { method: 'POST', body: '{}' }); toast(data.message || 'Destino atualizado.'); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function toggleUser(id) {
    try { const data = await api(`/api/admin/users/${idOf(id)}/toggle`, { method: 'POST', body: '{}' }); toast(data.message || 'Usuário atualizado.'); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function toggleStore(id) {
    try { const data = await api(`/api/admin/stores/${idOf(id)}/toggle`, { method: 'POST', body: '{}' }); toast(data.message || 'Loja atualizada.'); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function demoSettle(id) {
    try { const data = await api(`/api/admin/lightning/demo-settle/${idOf(id)}`, { method: 'POST', body: '{}' }); toast(data.message || 'Pagamento demo atualizado.'); closeModal(); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function loadCustody() {
    if (!state.user) { openAuth('login'); return; }
    const root = $('#custodyContent');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando configuração Bitcoin');
    try {
      const cfg = await api('/api/custody/config');
      state.custody = cfg;
      config.custodyMode = cfg.custody_mode || config.custodyMode;
      config.lightningMode = cfg.lightning_mode || config.lightningMode;
      config.commissionSigningMode = cfg.commission_signing_mode || config.commissionSigningMode;
      renderNetwork();
      let commission = null;
      if (state.user.role === 'admin') commission = await api('/api/admin/commission');
      const commissionPanel = commission ? commissionAdminHtml(commission) : '';
      const custodyHero = `<header class="custody-hero financial-intro"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> PAGAMENTOS BITCOIN</p><h1>Seu caminho em Bitcoin.</h1><p>Chaves públicas, pagamento e assinatura externa. Cada caminho mantém estado próprio.</p></div><span class="mode-tag">Rede ${esc(config.btcNetwork)} · ${esc(config.btcMode)}</span></header>`;
      const profilePanels = `<div class="grid-2 custody-settings section"><section class="panel"><p class="eyebrow">IDENTIDADE BITCOIN</p><h2>Minha chave pública</h2><p>Formato comprimido: 02 ou 03 + 64 caracteres hexadecimais. Chave privada e seed ficam fora da BitLoja.</p><form id="profileKeyForm"><div class="field"><label for="profilePubkey">Chave pública</label><div class="bitcoin-key-field"><input class="input" id="profilePubkey" name="pubkey" type="password" value="${esc(cfg.user_pubkey || '')}" pattern="(02|03)[0-9a-fA-F]{64}" minlength="66" maxlength="66" placeholder="02/03 + 64 caracteres hex" spellcheck="false" autocomplete="off" aria-describedby="profileKeyFeedback"><button class="btn btn-secondary btn-sm" type="button" data-action="toggle-public-key" data-key-target="profilePubkey" aria-controls="profilePubkey" aria-pressed="false">Mostrar</button></div><small id="profileKeyFeedback" role="status" aria-live="polite"></small></div><div class="actions"><button class="btn btn-primary" type="submit">Salvar chave pública</button><button class="btn btn-secondary" type="button" data-action="copy-field" data-field="profilePubkey">Copiar chave</button></div></form></section><section class="panel"><p class="eyebrow">TERCEIRO PARTICIPANTE</p><h2>Chave pública do mediador</h2><details class="bitcoin-key-disclosure"><summary>Mostrar chave pública do servidor</summary><code class="keybox">${esc(cfg.platform_pubkey || 'Não configurada')}</code></details><p>O mediador participa do escrow. Liberação ou devolução exige duas das três assinaturas.</p>${cfg.platform_pubkey ? `<button class="btn btn-secondary btn-sm" type="button" data-action="copy" data-value="${esc(cfg.platform_pubkey)}">Copiar chave do mediador</button>` : '<div class="notice notice-warning">Chave do mediador não configurada.</div>'}</section></div>`;
      root.innerHTML = `${custodyHero}${bitcoinGuideHtml(cfg)}${profilePanels}${state.user.role === 'seller' ? '<div class="notice notice-info">A chave escrow específica da loja fica em <button class="text-link" type="button" data-seller-tab="store">Minha loja</button>.</div>' : ''}${commissionPanel}`;
      $('#profileKeyForm')?.addEventListener('submit', saveProfileKey);
      updateProfileKeyFeedback();
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  async function saveProfileKey(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.getAttribute('aria-busy') === 'true' || !form.reportValidity()) return;
    const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
    const submit = $('button[type="submit"]', form);
    form.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    try {
      const data = await api('/api/profile/bitcoin-key', { method: 'POST', body: payload });
      state.user.bitcoin_pubkey = data.pubkey;
      if (state.custody) state.custody.user_pubkey = data.pubkey;
      const feedback = $('#profileKeyFeedback');
      if (feedback) feedback.textContent = data.message || 'Chave pública salva no servidor.';
    } catch (error) {
      const feedback = $('#profileKeyFeedback');
      if (feedback) { feedback.textContent = error.message; feedback.classList.add('error'); }
    } finally {
      form.setAttribute('aria-busy', 'false');
      if (submit.isConnected) submit.disabled = false;
    }
  }

  function updateProfileKeyFeedback() {
    const field = $('#profilePubkey');
    const feedback = $('#profileKeyFeedback');
    if (!field || !feedback) return;
    const value = field.value.trim();
    const valid = /^(02|03)[0-9a-fA-F]{64}$/.test(value);
    feedback.textContent = !value ? 'Nenhuma chave informada. Carteira watch-only pode derivar chaves por pedido.' : valid ? 'Formato comprimido válido. Servidor valida chave ao salvar.' : `${value.length}/66 caracteres. Use prefixo 02 ou 03 e somente hexadecimal.`;
    feedback.classList.toggle('error', Boolean(value) && !valid);
  }

  function bitcoinGuideHtml(cfg) {
    const seller = state.user?.role === 'seller';
    return `<section class="panel bitcoin-guide section"><div class="section-heading"><div><p class="eyebrow">ESCROW ON-CHAIN</p><h2>Do pedido à assinatura.</h2></div><span class="mode-tag">2 de 3 participantes</span></div><p>${esc(cfg.onchain_model || 'Modelo on-chain não informado pelo servidor.')}</p>
      <svg class="bitcoin-flow-svg" viewBox="0 0 800 150" role="img" aria-labelledby="bitcoinSvgTitle bitcoinSvgDesc"><title id="bitcoinSvgTitle">Caminho do escrow on-chain</title><desc id="bitcoinSvgDesc">Chaves públicas de comprador, vendedor e mediador formam escrow. Pagamento é confirmado; duas assinaturas externas autorizam proposta PSBT de liberação ou devolução.</desc><path class="flow-link" d="M166 65H220M378 65H430M588 65H640" fill="none"/><circle class="flow-pulse" cx="195" cy="65" r="5"/><circle class="flow-pulse" cx="405" cy="65" r="5"/><circle class="flow-pulse" cx="615" cy="65" r="5"/><rect class="flow-node" x="6" y="20" width="160" height="90" rx="18"/><rect class="flow-node" x="220" y="20" width="158" height="90" rx="18"/><rect class="flow-node" x="430" y="20" width="158" height="90" rx="18"/><rect class="flow-node" x="640" y="20" width="154" height="90" rx="18"/><text class="flow-label" x="86" y="57" text-anchor="middle">3 chaves públicas</text><text class="flow-caption" x="86" y="81" text-anchor="middle">Comprador · loja · mediador</text><text class="flow-label" x="299" y="57" text-anchor="middle">Escrow do pedido</text><text class="flow-caption" x="299" y="81" text-anchor="middle">Pagamento on-chain</text><text class="flow-label" x="509" y="57" text-anchor="middle">PSBT externa</text><text class="flow-caption" x="509" y="81" text-anchor="middle">2 assinaturas válidas</text><text class="flow-label" x="717" y="57" text-anchor="middle">Destino revisado</text><text class="flow-caption" x="717" y="81" text-anchor="middle">Liberação ou devolução</text><text class="flow-caption" x="400" y="137" text-anchor="middle">Servidor prepara e valida. Sua carteira assina fora da BitLoja.</text></svg>
      <div class="bitcoin-paths"><details open><summary><span>01</span> Preparar identidade e carteira</summary><p>Cadastre chave pública comprimida abaixo ou configure descriptors públicos da carteira watch-only. Chaves por pedido dependem da configuração retornada pelo servidor.</p><button class="btn btn-secondary btn-sm" type="button" data-view="wallet">Abrir carteira <i class="bi bi-arrow-up-right" aria-hidden="true"></i></button>${seller ? '<button class="btn btn-secondary btn-sm" type="button" data-seller-tab="store">Chave escrow da loja</button>' : ''}</details><details><summary><span>02</span> Pagar endereço do pedido</summary><p>Checkout apresenta endereço escrow e total de cada loja. Use rede ${esc(config.btcNetwork)} e consulte confirmação em detalhes do pedido.</p><button class="btn btn-secondary btn-sm" type="button" data-view="account">Abrir pedidos</button></details><details><summary><span>03</span> Liberar ou devolver por PSBT</summary><p>Abra detalhes do pedido e gerencie PSBTs. Baixe proposta, assine em carteira externa e envie assinatura. Transmissão aparece quando servidor confirma assinaturas suficientes.</p><p>Escrows não entram automaticamente em lotes de liquidação da tesouraria.</p><button class="btn btn-secondary btn-sm" type="button" data-view="account">Consultar PSBTs por pedido</button></details><details><summary><span>LN</span> Lightning segue caminho custodial</summary><p>${esc(cfg.warning || 'Lightning comum liquida no nó da plataforma e não herda escrow 2-de-3 on-chain.')}</p><span class="mode-tag">Lightning · ${esc(cfg.lightning_mode || 'Não informado')}</span></details></div></section>
      <section class="bitcoin-capabilities protocol-grid section" aria-label="Configuração atual do servidor"><article class="protocol-card"><p class="eyebrow">ON-CHAIN</p><h3>Custódia ${esc(cfg.custody_mode || 'Não informada')}</h3><p>${config.btcMode === 'rpc' ? 'Conectado por configuração RPC; disponibilidade operacional é consultada na carteira.' : 'Modo demonstração; exemplos não representam confirmação de rede.'}</p></article><article class="protocol-card"><p class="eyebrow">LIGHTNING</p><h3>${cfg.lightning_mode === 'off' ? 'Desativado' : `Modo ${esc(cfg.lightning_mode || 'Não informado')}`}</h3><p>${cfg.lightning_mode === 'off' ? 'Opção indisponível no checkout deste servidor.' : `Modelo informado: ${esc(cfg.lightning_custody || 'Não informado')}.`}</p></article><article class="protocol-card"><p class="eyebrow">COMISSÃO</p><h3>Assinatura ${esc(cfg.commission_signing_mode || 'Não informada')}</h3><p>${cfg.commission_signing_mode === 'hot' ? 'Envio direto depende de Bitcoin Core e confirmações administrativas.' : 'PSBT permite assinatura externa; consolidação e distribuição diretas ficam desativadas.'}</p>${state.user?.role === 'admin' ? '<button class="text-link" type="button" data-admin-tab="treasury">Abrir tesouraria</button>' : ''}</article></section>`;
  }

  function commissionAdminHtml(data) {
    const wallet = data.wallet || {};
    const transfers = data.transfers || [];
    return `<section class="panel section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Administração</p><h2>Carteira de comissões</h2></div><span class="mode-tag">Assinatura ${esc(wallet.signing_mode || '—')}</span></div><p>Comissões registradas e saldo desta carteira vêm da API administrativa.</p><div class="metrics"><article class="metric-card"><small>Registradas</small><strong>₿ ${esc(data.earned_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Confirmado</small><strong>₿ ${esc(wallet.trusted_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Pendente</small><strong>₿ ${esc(wallet.pending_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Status</small><strong>${esc(wallet.status || '—')}</strong></article></div><div class="grid-3 section"><article class="panel"><h3>Preparar carteiras</h3><p>Configurar carteiras watch-only de escrow e comissão.</p><button class="btn btn-secondary" type="button" data-action="setup-bitcoin-wallets">Configurar Bitcoin Core</button></article><article class="panel"><h3>Novo endereço</h3><p>Gerar endereço da carteira de comissão.</p><button class="btn btn-primary" type="button" data-action="commission-new-address">Criar endereço</button></article><article class="panel"><h3>Transferência</h3><p>Preparar envio de comissão por PSBT ou modo habilitado.</p><button class="btn btn-danger" type="button" data-action="commission-transfer">Criar transferência</button></article></div><h3>Transferências</h3>${transfers.length ? transfers.map(transfer => `<article class="psbt-row"><div class="checkout-order-head"><strong>${esc(transfer.reference)}</strong>${statusTag(transfer.status)}</div><small>${esc(transfer.mode)} · ₿ ${esc(transfer.amount_btc)} → ${esc(short(transfer.destination, 34))}</small><div class="actions">${transfer.psbt_base64 ? `<button class="btn btn-secondary btn-sm" type="button" data-action="commission-download" data-id="${idOf(transfer.id)}">Baixar PSBT</button>` : ''}${['awaiting_signature', 'partially_signed'].includes(transfer.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="commission-signed" data-id="${idOf(transfer.id)}">Enviar assinada</button>` : ''}${transfer.status === 'ready_to_broadcast' ? `<button class="btn btn-success btn-sm" type="button" data-action="commission-broadcast" data-id="${idOf(transfer.id)}">Transmitir</button>` : ''}</div></article>`).join('') : '<div class="empty">Nenhuma transferência de comissão.</div>'}</section>`;
  }

  async function setupBitcoinWallets() {
    const critical = await promptCritical('CONFIGURAR CARTEIRAS');
    if (!critical) return;
    try { const data = await api('/api/admin/bitcoin/setup-wallets', { method: 'POST', body: JSON.stringify(critical) }); toast(data.message || 'Carteiras configuradas.'); await loadCustody(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function commissionAddress() {
    const critical = await promptCritical('CRIAR ENDERECO DE COMISSAO');
    if (!critical) return;
    try { const data = await api('/api/admin/commission/new-address', { method: 'POST', body: JSON.stringify(critical) }); openModal('Endereço de comissão', `<div class="address">${esc(data.address)}</div><button class="btn btn-secondary" type="button" data-action="copy" data-value="${esc(data.address)}">Copiar</button>`); }
    catch (error) { toast(error.message, 'error'); }
  }

  function commissionTransferForm() {
    openModal('Mover comissão', `<div class="notice notice-warning">A transferência usa somente carteira de comissão.</div><form id="commissionTransferForm"><div class="field"><label for="commissionDestination">Destino</label><input class="input" id="commissionDestination" name="destination" required maxlength="120"></div><div class="field"><label for="commissionAmount">Valor BTC</label><input class="input" id="commissionAmount" name="amount_btc" type="number" min="0.00000001" step="0.00000001" required></div><div class="field"><label for="commissionMode">Modo</label><select class="input" id="commissionMode" name="mode"><option value="psbt">PSBT para assinatura offline</option><option value="hot">Envio direto, se habilitado</option></select></div><button class="btn btn-primary" type="submit">Continuar</button></form>`);
  }

  async function submitCommissionTransfer(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const phrase = body.mode === 'hot' ? 'MOVER COMISSAO' : 'CRIAR PSBT DE COMISSAO';
    const critical = await promptCritical(phrase);
    if (!critical) return;
    try {
      const path = body.mode === 'hot' ? '/api/admin/commission/send' : '/api/admin/commission/psbt';
      const data = await api(path, { method: 'POST', body: JSON.stringify({ ...body, ...critical }) });
      closeModal();
      toast(data.message || 'Transferência de comissão criada.');
      await loadCustody();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function commissionSigned(id) {
    openPsbtUpload('Enviar PSBT da comissão', async psbt => {
      const data = await api(`/api/admin/commission/transfers/${idOf(id)}/signed`, { method: 'POST', body: JSON.stringify({ psbt }) });
      toast(data.message || 'Assinatura recebida.');
      await loadCustody();
    });
  }

  async function commissionBroadcast(id) {
    const critical = await promptCritical('TRANSMITIR COMISSAO');
    if (!critical) return;
    try { const data = await api(`/api/admin/commission/transfers/${idOf(id)}/broadcast`, { method: 'POST', body: JSON.stringify(critical) }); toast(`${data.message || 'Comissão transmitida.'} ${short(data.txid)}`); await loadCustody(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function loadWallet() {
    if (!state.user) { openAuth('login'); return; }
    const root = $('#walletContent');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Consultando carteira');
    try {
      const data = await api('/api/wallet');
      state.wallet = data;
      renderWallet(data);
      applyWalletModeGate(data.wallet || {});
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  function renderWallet(data) {
    const wallet = data.wallet || {};
    const transfers = data.transfers || [];
    const addresses = data.addresses || [];
    const setup = wallet.requires_setup ? `<section class="panel wallet-setup"><h2>Configurar carteira watch-only</h2><p>Informe descriptors públicos ranged da mesma carteira e senha da conta. A tela não aceita seed ou chave privada.</p><form id="walletSetupForm"><div class="field"><label for="walletDescriptor">Descriptor externo público</label><textarea class="input mono-textarea" id="walletDescriptor" name="descriptor" required spellcheck="false" autocomplete="off"></textarea></div><div class="field"><label for="changeDescriptor">Descriptor de troco público</label><textarea class="input mono-textarea" id="changeDescriptor" name="change_descriptor" required spellcheck="false" autocomplete="off"></textarea></div><div class="field"><label for="walletSetupPassword">Senha da conta</label><input class="input" id="walletSetupPassword" name="password" type="password" autocomplete="current-password" required></div><button class="btn btn-primary" type="submit">Configurar carteira</button></form></section>` : '';
    const addressPanel = `<section class="panel"><div class="section-heading"><div><h2>Recebimento</h2><p>Endereços retornados pela carteira.</p></div>${wallet.configured ? '<button class="btn btn-secondary btn-sm" type="button" data-action="wallet-new-address">Gerar endereço</button>' : ''}</div>${wallet.address ? `<code class="address">${esc(wallet.address)}</code>` : '<div class="empty">Endereço não disponível.</div>'}${addresses.length ? `<div class="address-list">${addresses.map(address => `<div><code>${esc(address.address)}</code><small>${esc(address.purpose)} · ${esc(dateText(address.created_at))}</small><button class="btn btn-secondary btn-sm" type="button" data-action="copy" data-value="${esc(address.address)}">Copiar</button></div>`).join('')}</div>` : ''}</section>`;
    const transfersPanel = `<section class="panel"><h2>Transferências</h2>${transfers.length ? transfers.map(transfer => `<article class="psbt-row"><div class="checkout-order-head"><strong>${esc(transfer.reference)}</strong>${statusTag(transfer.status)}</div><p>₿ ${esc(transfer.amount_btc)} · taxa ₿ ${esc(transfer.fee_btc)}</p><code>${esc(transfer.destination)}</code><small>${esc(dateText(transfer.created_at))}${transfer.txid ? ` · TXID ${esc(short(transfer.txid))}` : ''}</small><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="wallet-download" data-id="${idOf(transfer.id)}">Baixar PSBT</button>${['draft', 'signed', 'ready_to_broadcast'].includes(transfer.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="wallet-signed" data-id="${idOf(transfer.id)}">Enviar assinatura</button>` : ''}${transfer.status === 'ready_to_broadcast' ? `<button class="btn btn-primary btn-sm" type="button" data-action="wallet-broadcast" data-id="${idOf(transfer.id)}">Transmitir</button>` : ''}${transfer.status === 'draft' ? `<button class="btn btn-danger btn-sm" type="button" data-action="wallet-cancel" data-id="${idOf(transfer.id)}">Cancelar</button>` : ''}</div></article>`).join('') : '<div class="empty">Nenhuma transferência preparada.</div>'}</section>`;
    const transferForm = state.user?.role === 'seller' && wallet.configured ? `<section class="panel"><h2>Preparar transferência</h2><p>Crie PSBT, assine em carteira externa, envie para validação e transmita após validação do servidor.</p><form id="walletTransferForm"><div class="field"><label for="transferDestination">Endereço de destino</label><input class="input" id="transferDestination" name="destination" required maxlength="120"></div><div class="field"><label for="transferAmount">Valor BTC</label><input class="input" id="transferAmount" name="amount_btc" type="number" min="0.00000001" step="0.00000001" required></div><div class="field"><label for="transferPassword">Senha da conta</label><input class="input" id="transferPassword" name="password" type="password" autocomplete="current-password" required></div><button class="btn btn-primary" type="submit">Criar PSBT</button></form></section>` : '';
    const walletNotice = String(wallet.mode || '').toLowerCase() === 'demo'
      ? ' · Modo demonstração — operações de carteira desativadas.'
      : wallet.requires_setup ? ' · Configure para habilitar recursos watch-only.' : '';
    $('#walletContent').innerHTML = `<header class="financial-intro wallet-page-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> CARTEIRA BITCOIN</p><h1>Saldo e movimentações</h1></div><p>Estado da carteira, recebimentos e transferências.</p></header><div class="notice ${wallet.status === 'offline' ? 'notice-danger' : 'notice-info'}"><strong>${esc(wallet.mode || '—')}</strong> · ${esc(wallet.network || config.btcNetwork)} · ${esc(statusLabels[wallet.status] || wallet.status || '—')}${walletNotice}</div><div class="metrics wallet-metrics"><article class="metric-card"><small>Confirmado</small><strong>₿ ${esc(wallet.confirmed_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Pendente</small><strong>₿ ${esc(wallet.pending_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Reservado</small><strong>₿ ${esc(wallet.reserved_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Disponível</small><strong>₿ ${esc(wallet.available_btc || '0.00000000')}</strong></article></div>${setup}<div class="grid-2 section wallet-operation-grid">${addressPanel}${transferForm}</div><div class="section wallet-transfers">${transfersPanel}</div>`;
  }

  function applyWalletModeGate(wallet) {
    if (wallet.mode !== 'demo' && config.btcMode !== 'demo') return;
    $('#walletSetupForm')?.closest('.panel')?.remove();
    $('#walletTransferForm')?.closest('.panel')?.remove();
    $('#walletContent [data-action="wallet-new-address"]')?.remove();
    const notice = document.createElement('div');
    notice.className = 'notice notice-info wallet-mode-note';
    notice.textContent = 'Configuração e transferências disponíveis quando Bitcoin Core estiver habilitado.';
    const metrics = $('#walletContent .metrics');
    if (metrics) metrics.insertAdjacentElement('afterend', notice);
    else $('#walletContent')?.prepend(notice);
  }

  function createIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  async function setupWallet(event) {
    event.preventDefault();
    try {
      const data = await api('/api/wallet/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      toast('Carteira configurada.');
      await loadWallet();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function createWalletAddress() {
    try { const data = await api('/api/wallet/addresses', { method: 'POST', body: '{}' }); toast('Novo endereço criado.'); await loadWallet(); openModal('Novo endereço', `<code class="address">${esc(data.address)}</code><button class="btn btn-secondary" type="button" data-action="copy" data-value="${esc(data.address)}">Copiar endereço</button>`); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function createWalletTransfer(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.idempotency_key = createIdempotencyKey();
    try {
      const data = await api('/api/wallet/transfers', { method: 'POST', body: JSON.stringify(body) });
      toast('PSBT criada. Assine externamente e envie para validação.');
      await loadWallet();
      if (data.transfer) openWalletTransfer(data.transfer);
    } catch (error) { toast(error.message, 'error'); }
  }

  function openWalletTransfer(transfer) {
    openModal(`Transferência ${transfer.reference}`, `<div class="notice notice-info">Transação PSBT preparada. Baixe, assine em carteira externa e submeta para validação.</div><div class="metric-card"><small>Valor e taxa</small><strong>₿ ${esc(transfer.amount_btc)} + ₿ ${esc(transfer.fee_btc)}</strong></div><div class="actions"><button class="btn btn-secondary" type="button" data-action="wallet-download" data-id="${idOf(transfer.id)}">Baixar arquivo PSBT</button><button class="btn btn-primary" type="button" data-action="wallet-signed" data-id="${idOf(transfer.id)}">Enviar PSBT assinada</button></div>`);
  }

  async function uploadWalletSigned(id) {
    openPsbtUpload('Enviar PSBT assinada', async psbt => {
      const data = await api(`/api/wallet/transfers/${idOf(id)}/signed`, { method: 'POST', body: JSON.stringify({ psbt }) });
      closeModal();
      toast(data.message || 'PSBT validada.');
      await loadWallet();
    });
  }

  function broadcastWalletForm(id) {
    openModal('Transmitir transferência', `<div class="notice notice-warning">Confira destino e valor antes de transmitir para a rede.</div><form id="walletBroadcastForm" data-transfer-id="${idOf(id)}"><div class="field"><label for="broadcastPassword">Senha da conta</label><input class="input" id="broadcastPassword" name="password" type="password" autocomplete="current-password" required></div><div class="field"><label for="broadcastConfirm">Digite ENVIAR BTC</label><input class="input" id="broadcastConfirm" name="confirm" required autocomplete="off"></div><button class="btn btn-danger" type="submit">Transmitir BTC</button></form>`);
  }

  async function submitWalletBroadcast(event) {
    event.preventDefault();
    const id = idOf(event.currentTarget.dataset.transferId);
    try {
      const data = await api(`/api/wallet/transfers/${id}/broadcast`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      closeModal();
      toast(data.message || 'Transferência transmitida.');
      await loadWallet();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function cancelWalletTransfer(id) {
    if (!window.confirm('Cancelar transferência e liberar inputs reservados?')) return;
    try { const data = await api(`/api/wallet/transfers/${idOf(id)}/cancel`, { method: 'POST', body: '{}' }); toast(data.message || 'Transferência cancelada.'); await loadWallet(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function refreshNotificationBadge() {
    if (!state.user) return;
    try { const data = await api('/api/notifications?limit=1'); state.unreadCount = idOf(data.unread_count); renderSession(); }
    catch (_) { /* Badge stays at last server-confirmed count. */ }
  }

  async function openNotifications(beforeId = '') {
    if (!state.user) { openAuth('login'); return; }
    if (state.activeView !== 'notifications') {
      state.notificationsReturn = { view: state.activeView, sellerTab: state.sellerTab, adminTab: state.adminTab };
      closeModal({ restoreFocus: false });
      showView('notifications');
    }
    if (state.notificationsLoading) { renderNotifications(); return; }
    const request = ++state.notificationsRequest;
    const append = Boolean(beforeId);
    state.notificationsLoading = true;
    if (!append) {
      state.notifications = [];
      state.notificationsCursor = 0;
      state.notificationsHasMore = false;
    }
    renderNotifications();
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (beforeId) query.set('before_id', String(idOf(beforeId)));
      const data = await api(`/api/notifications?${query}`);
      if (request !== state.notificationsRequest || !state.user) return;
      const page = Array.isArray(data.notifications) ? data.notifications : [];
      const unique = new Map((append ? state.notifications : []).map(item => [idOf(item.id), item]));
      page.forEach(item => { unique.set(idOf(item.id), item); });
      state.notifications = Array.from(unique.values()).sort((a, b) => idOf(b.id) - idOf(a.id));
      state.unreadCount = idOf(data.unread_count);
      state.notificationsCursor = page.length ? Math.min(...page.map(item => idOf(item.id))) : 0;
      state.notificationsHasMore = page.length === 50 && state.notificationsCursor > 0;
      state.notificationsLoading = false;
      renderSession();
      renderNotifications();
      if (!append) focusUpdatedContent($('#notificationsContent'), null);
    } catch (error) {
      if (request === state.notificationsRequest) {
        state.notificationsLoading = false;
        renderNotifications(error.message);
      }
    }
  }

  function renderNotifications(error = '') {
    const filter = state.notificationsFilter;
    const visible = state.notifications.filter(item => filter === 'all' || (filter === 'unread' ? !item.read_at : Boolean(item.read_at)));
    const roleLabel = state.user?.role === 'admin' ? 'Administração' : state.user?.role === 'seller' ? 'Painel do vendedor' : 'Sua conta';
    const pending = state.notificationsLoading || state.notificationsWriting;
    const origin = state.notificationsReturn?.view || 'account';
    const originLabel = { home: 'Início', catalog: 'Produtos', product: 'Produto', store: 'Loja', cart: 'Carrinho', checkout: 'Checkout', seller: 'Painel do vendedor', admin: 'Administração', wallet: 'Carteira', custody: 'Bitcoin', account: 'Pedidos' }[origin] || 'Pedidos';
    $('#notificationsContent').innerHTML = `<div class="inbox-toolbar"><div><span class="mode-tag">${roleLabel}</span><p><strong>${state.unreadCount}</strong> ${state.unreadCount === 1 ? 'não lida' : 'não lidas'} no total · ${state.notifications.length} carregadas</p></div><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="notifications-back"><i class="bi bi-arrow-left" aria-hidden="true"></i> ${originLabel}</button><button class="btn btn-secondary btn-sm" type="button" data-action="notifications" ${pending ? 'disabled' : ''}><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Atualizar</button><button class="btn btn-primary btn-sm" type="button" data-action="read-all-notifications" ${pending || !state.unreadCount ? 'disabled' : ''}>Marcar todas como lidas</button></div></div>
      <div class="inbox-filters" role="group" aria-label="Filtrar notificações">${[['all', 'Todas'], ['unread', 'Não lidas'], ['read', 'Lidas']].map(([value, label]) => `<button class="btn btn-${filter === value ? 'primary' : 'secondary'} btn-sm" type="button" data-action="filter-notifications" data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div>
      <p id="notificationsFeedback" class="${error ? 'notice notice-danger' : 'inbox-feedback'}" role="status" aria-live="polite">${error ? esc(error) : state.notificationsLoading ? 'Carregando notificações…' : state.notificationsWriting ? 'Salvando leitura…' : `${visible.length} ${visible.length === 1 ? 'notificação exibida' : 'notificações exibidas'}${state.notificationsHasMore && filter !== 'all' ? '. Filtro aplicado às notificações carregadas.' : '.'}`}</p>
      <div class="inbox-list" aria-busy="${pending}">${visible.length ? visible.map(item => `<article class="inbox-item ${item.read_at ? 'is-read' : 'is-unread'}"><span class="inbox-icon"><i class="bi ${String(item.kind || '').includes('dispute') ? 'bi-chat-square-text' : String(item.kind || '').includes('payment') ? 'bi-currency-bitcoin' : item.order_id ? 'bi-box-seam' : 'bi-bell'}" aria-hidden="true"></i></span><div class="inbox-copy"><div class="inbox-item-heading"><h3>${esc(item.title)}</h3>${!item.read_at ? '<span class="inbox-unread-label">Não lida</span>' : ''}</div><p>${esc(item.body)}</p><time datetime="${esc(item.created_at || '')}">${esc(dateText(item.created_at))}</time></div><div class="inbox-actions">${item.order_id ? `<button class="btn btn-secondary btn-sm" type="button" data-action="notification-order" data-id="${idOf(item.order_id)}">Ver pedido <i class="bi bi-arrow-up-right" aria-hidden="true"></i></button>` : ''}${!item.read_at ? `<button class="btn btn-secondary btn-sm" type="button" data-action="read-notification" data-id="${idOf(item.id)}" ${pending ? 'disabled' : ''}><i class="bi bi-check2" aria-hidden="true"></i> Marcar lida</button>` : '<small>Lida</small>'}</div></article>`).join('') : state.notificationsLoading ? '<div class="empty">Buscando atualizações da conta.</div>' : `<div class="empty"><i class="bi bi-bell" aria-hidden="true"></i><h2>${filter === 'unread' ? 'Nenhuma não lida carregada' : filter === 'read' ? 'Nenhuma lida carregada' : 'Nenhuma notificação'}</h2><p>${state.notificationsHasMore ? 'Carregue anteriores para continuar consulta.' : 'Atualizações de pedidos e conta aparecem aqui.'}</p></div>`}</div>
      ${state.notificationsHasMore ? `<div class="inbox-pagination"><button class="btn btn-secondary" type="button" data-action="older-notifications" data-before="${state.notificationsCursor}" ${pending ? 'disabled' : ''}>Carregar anteriores</button></div>` : ''}${error ? `<button class="btn btn-secondary" type="button" data-action="${state.notifications.length ? 'older-notifications' : 'notifications'}" data-before="${state.notificationsCursor}">Tentar novamente</button>` : ''}`;
  }

  async function markNotificationRead(id) {
    if (state.notificationsWriting) return;
    const sessionVersion = state.sessionVersion;
    state.notificationsWriting = true;
    renderNotifications();
    try {
      await api(`/api/notifications/${idOf(id)}/read`, { method: 'POST', body: '{}' });
      if (sessionVersion !== state.sessionVersion) return;
      state.notifications = state.notifications.map(item => idOf(item.id) === idOf(id) ? { ...item, read_at: item.read_at || true } : item);
      await refreshNotificationBadge();
      if (sessionVersion !== state.sessionVersion) return;
      state.notificationsWriting = false;
      renderNotifications();
      focusUpdatedContent($('#notificationsContent'), null);
    } catch (error) { if (sessionVersion === state.sessionVersion) { state.notificationsWriting = false; renderNotifications(error.message); } }
  }

  async function markAllNotificationsRead() {
    if (state.notificationsWriting || !state.unreadCount) return;
    const sessionVersion = state.sessionVersion;
    state.notificationsWriting = true;
    renderNotifications();
    try {
      await api('/api/notifications/read-all', { method: 'POST', body: '{}' });
      if (sessionVersion !== state.sessionVersion) return;
      state.notifications = state.notifications.map(item => ({ ...item, read_at: item.read_at || true }));
      await refreshNotificationBadge();
      if (sessionVersion !== state.sessionVersion) return;
      state.notificationsWriting = false;
      renderNotifications();
      focusUpdatedContent($('#notificationsContent'), null);
    } catch (error) { if (sessionVersion === state.sessionVersion) { state.notificationsWriting = false; renderNotifications(error.message); } }
  }

  function openDisputeThreadFromOrder(id) { openDispute(id); }

  function openOrderPsbtForm(orderId, kind) {
    const title = kind === 'release' ? 'Criar PSBT de liberação' : 'Criar PSBT de devolução';
    const guidance = kind === 'release' ? 'Taxa de rede é descontada do valor líquido do vendedor; comissão segue para carteira separada.' : 'A proposta devolve ao comprador o valor disponível, descontada a taxa de rede.';
    openModal(title, `<div class="notice notice-warning">${guidance}</div><form id="orderPsbtForm" data-order-id="${idOf(orderId)}" data-kind="${esc(kind)}"><div class="field"><label for="sellerAddress">Endereço do vendedor</label><input class="input" id="sellerAddress" name="seller_address" placeholder="Usar endereço cadastrado na loja"></div><div class="field"><label for="buyerAddress">Endereço do comprador</label><input class="input" id="buyerAddress" name="buyer_address" placeholder="Usar endereço de reembolso do pedido"></div><button class="btn btn-primary" type="submit">Gerar PSBT sem assinar</button></form>`);
  }

  async function managePsbt(orderId) {
    try {
      const data = await api(`/api/orders/${idOf(orderId)}/psbts`);
      const proposals = data.proposals || [];
      const rows = proposals.length ? proposals.map(proposal => `<article class="psbt-row"><div class="checkout-order-head"><strong>${esc(proposal.reference)}</strong>${statusTag(proposal.status)}</div><p>${proposal.kind === 'release' ? 'Liberação ao vendedor + comissão' : 'Devolução ao comprador'} · assinaturas: ${esc((proposal.signers || []).join(', ') || 'nenhuma')}</p><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="order-psbt-download" data-id="${idOf(proposal.id)}">Baixar PSBT</button>${proposal.status !== 'broadcast' ? `<button class="btn btn-secondary btn-sm" type="button" data-action="order-psbt-signed" data-id="${idOf(proposal.id)}" data-order="${idOf(orderId)}">Enviar assinada</button>` : ''}${proposal.status === 'ready_to_broadcast' ? `<button class="btn btn-success btn-sm" type="button" data-action="order-psbt-broadcast" data-id="${idOf(proposal.id)}" data-order="${idOf(orderId)}">Transmitir</button>` : ''}${proposal.txid ? `<code>${esc(short(proposal.txid, 28))}</code>` : ''}</div></article>`).join('') : '<div class="empty">Nenhuma proposta criada.</div>';
      openModal('PSBTs do escrow', `<div class="notice notice-info">O servidor prepara e valida a transação. Assinatura acontece em carteira externa.</div><div class="actions"><button class="btn btn-primary" type="button" data-action="order-psbt-new" data-id="${idOf(orderId)}" data-kind="release">Liberar vendedor</button><button class="btn btn-danger" type="button" data-action="order-psbt-new" data-id="${idOf(orderId)}" data-kind="refund">Criar devolução</button></div><div class="section">${rows}</div>`, true);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function submitOrderPsbt(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = idOf(form.dataset.orderId);
    const payload = Object.fromEntries(new FormData(form));
    payload.kind = form.dataset.kind;
    try { const data = await api(`/api/orders/${orderId}/psbts`, { method: 'POST', body: JSON.stringify(payload) }); toast(data.message || 'PSBT criada.'); await managePsbt(orderId); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function submitOrderPsbtSignature(proposalId, orderId) {
    openPsbtUpload('Enviar PSBT assinada', async psbt => {
      const data = await api(`/api/psbts/${idOf(proposalId)}/submit-signature`, { method: 'POST', body: JSON.stringify({ psbt }) });
      toast(data.complete ? 'Duas assinaturas válidas. PSBT pronta.' : data.message || 'Assinatura recebida.');
      await managePsbt(orderId);
    });
  }

  async function broadcastOrderPsbt(proposalId, orderId) {
    if (!window.confirm('Transmitir a transação final para a rede?')) return;
    try { const data = await api(`/api/psbts/${idOf(proposalId)}/broadcast`, { method: 'POST', body: '{}' }); toast(`${data.message || 'Transação transmitida.'} ${short(data.txid)}`); await managePsbt(orderId); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function adminRefund(id) {
    const critical = await promptCritical('REEMBOLSAR');
    if (!critical) return;
    const amount = window.prompt('Valor BTC. Deixe vazio para usar o máximo pago:');
    if (amount === null) return;
    try { const data = await api(`/api/admin/orders/${idOf(id)}/refund`, { method: 'POST', body: JSON.stringify({ ...critical, amount_btc: amount }) }); toast(`${data.message || 'Reembolso preparado.'} TX ${short(data.txid)}`); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function openNotificationsOrder(id) { closeModal(); await openOrder(id); }

  function toggleSearch() {
    state.searchOpen = !state.searchOpen;
    $('#searchForm').classList.toggle('search-open', state.searchOpen);
    $('#searchToggle').setAttribute('aria-expanded', String(state.searchOpen));
    if (state.searchOpen) $('#searchInput').focus();
  }

  function closeMobileMenu() {
    state.mobileMenuOpen = false;
    $('#primaryNav').classList.remove('open');
    $('#mobileMenuBtn').setAttribute('aria-expanded', 'false');
  }

  function toggleMobileMenu() {
    state.mobileMenuOpen = !state.mobileMenuOpen;
    $('#primaryNav').classList.toggle('open', state.mobileMenuOpen);
    $('#mobileMenuBtn').setAttribute('aria-expanded', String(state.mobileMenuOpen));
  }

  async function copyText(value) {
    const text = String(value || '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado.');
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      toast(copied ? 'Copiado.' : 'Selecione e copie o conteúdo.', copied ? 'success' : 'error');
    }
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    const id = idOf(button.dataset.id);
    switch (action) {
      case 'home': showView('home'); focusViewDestination('home'); break;
      case 'auth-home': closeModal({ restoreFocus: false }); showView('home'); focusViewDestination('home'); break;
      case 'catalog': showView('catalog'); focusViewDestination('catalog'); break;
      case 'sell': sellAction(); break;
      case 'account-menu': accountMenu(); break;
      case 'cart': showView('cart'); focusViewDestination('cart'); break;
      case 'notifications': await openNotifications(); break;
      case 'search-toggle': toggleSearch(); break;
      case 'menu': toggleMobileMenu(); break;
      case 'close-modal': closeModal(); break;
      case 'toggle-password': {
        const input = $(`#${CSS.escape(button.dataset.passwordTarget || '')}`);
        if (!input) break;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.textContent = visible ? 'Ocultar' : 'Mostrar';
        button.setAttribute('aria-pressed', String(visible));
        button.setAttribute('aria-label', `${visible ? 'Ocultar' : 'Mostrar'} senha`);
        break;
      }
      case 'go-view': {
        const view = button.dataset.viewName;
        closeModal({ restoreFocus: false });
        showView(view);
        focusViewDestination(view);
        break;
      }
      case 'logout': await logout(); break;
      case 'logout-then-seller': await logout(); openAuth('register', 'seller'); break;
      case 'open-product': await openProduct(id); break;
      case 'open-store': await openStore(id); break;
      case 'add-cart': await addToCart(id); break;
      case 'add-current-product': await addCurrentProduct(button); break;
      case 'buy-current-product': await addCurrentProduct(button, true); break;
      case 'product-qty': {
        const input = $('#productQty');
        if (input) input.value = String(Math.max(1, Math.min(idOf(input.max), idOf(input.value) + num(button.dataset.delta))));
        break;
      }
      case 'checkout': await openCheckout(); break;
      case 'checkout-step': setCheckoutStep(button.dataset.step); break;
      case 'checkout-back': saveCheckoutDraft(); showView('cart'); focusViewDestination('cart'); break;
      case 'checkout-sync': await syncCheckoutOrder(id); break;
      case 'checkout-orders': closeModal({ restoreFocus: false }); showView('account'); focusViewDestination('account'); break;
      case 'refresh-account': await loadAccount(); break;
      case 'reset-account-filters': state.accountSearch = ''; state.accountStatus = 'all'; renderAccount(); focusIfVisible($('#accountOrderSearch')); break;
      case 'cart-remove': await updateCart(id, 0); break;
      case 'cart-qty': {
        const input = $(`[data-cart-qty="${id}"]`);
        const delta = Number(button.dataset.delta || 0);
        await updateCart(id, Math.max(0, idOf(input?.value) + delta));
        break;
      }
      case 'open-order': await openOrder(id); break;
      case 'tracking': await openOrder(id); break;
      case 'sync-order': await syncOrder(id); break;
      case 'review-form': openReviewForm(idOf(button.dataset.order), idOf(button.dataset.product), button.dataset.name || 'produto'); break;
      case 'dispute-form': openDisputeForm(id); break;
      case 'open-dispute': openDisputeForm(id); break;
      case 'open-dispute-thread': await openDispute(id); break;
      case 'resolve-dispute': openResolveDispute(id); break;
      case 'copy': await copyText(button.dataset.value || ''); break;
      case 'reset-product': resetProduct(); break;
      case 'edit-product': editProduct(id); break;
      case 'disable-product': await disableProduct(id); break;
      case 'sync-all': await syncAll(); break;
      case 'mock-credit': await mockCredit(id); break;
      case 'preview-settlement': await openSettlementPreview(); break;
      case 'open-batch': await openBatch(id); break;
      case 'batch-create-psbt': await createBatchPsbt(); break;
      case 'batch-download-psbt': downloadText(state.activeBatchPsbt, `lote-${state.activeBatchId}.psbt`); break;
      case 'batch-upload-psbt': uploadBatchSigned(); break;
      case 'batch-broadcast': await broadcastBatch(); break;
      case 'batch-cancel': await cancelBatch(); break;
      case 'new-settlement-address': await createSettlementAddress(); break;
      case 'consolidate': await consolidateTreasury(); break;
      case 'distribute-reserves': await distributeReserves(); break;
      case 'refresh-treasury': await loadAdmin(); break;
      case 'treasury-section': {
        const section = $(`#${CSS.escape(button.dataset.section || '')}`);
        focusIfVisible(section);
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'select-reserve-destinations': $$('[data-reserve-dest]').forEach(input => { input.checked = true; }); updateReservePreview(); break;
      case 'clear-reserve-destinations': $$('[data-reserve-dest]').forEach(input => { input.checked = false; }); updateReservePreview(); break;
      case 'export-destinations': exportDestinations(); break;
      case 'toggle-destination': await toggleDestination(id); break;
      case 'toggle-user': await toggleUser(id); break;
      case 'toggle-store': await toggleStore(id); break;
      case 'demo-settle': await demoSettle(id); break;
      case 'setup-bitcoin-wallets': await setupBitcoinWallets(); break;
      case 'commission-new-address': await commissionAddress(); break;
      case 'commission-transfer': commissionTransferForm(); break;
      case 'commission-download': await download(`/api/admin/commission/transfers/${id}/download`, `comissao-${id}.psbt`); break;
      case 'commission-signed': commissionSigned(id); break;
      case 'commission-broadcast': await commissionBroadcast(id); break;
      case 'wallet-new-address': await createWalletAddress(); break;
      case 'wallet-download': await download(`/api/wallet/transfers/${id}/download`, `transferencia-${id}.psbt`); break;
      case 'wallet-signed': uploadWalletSigned(id); break;
      case 'wallet-broadcast': broadcastWalletForm(id); break;
      case 'wallet-cancel': await cancelWalletTransfer(id); break;
      case 'read-notification': await markNotificationRead(id); break;
      case 'read-all-notifications': await markAllNotificationsRead(); break;
      case 'filter-notifications': if (['all', 'unread', 'read'].includes(button.dataset.filter)) { state.notificationsFilter = button.dataset.filter; renderNotifications(); focusIfVisible($(`[data-action="filter-notifications"][data-filter="${state.notificationsFilter}"]`)); } break;
      case 'notifications-back': {
        const target = state.notificationsReturn || { view: 'account' };
        if (target.sellerTab) state.sellerTab = target.sellerTab;
        if (target.adminTab) state.adminTab = target.adminTab;
        showView(target.view);
        focusViewDestination(target.view);
        break;
      }
      case 'older-notifications': await openNotifications(button.dataset.before); break;
      case 'notification-order': await openNotificationsOrder(id); break;
      case 'manage-psbt': await managePsbt(id); break;
      case 'order-psbt-new': openOrderPsbtForm(id, button.dataset.kind); break;
      case 'order-psbt-download': await download(`/api/psbts/${id}/download`, `proposta-${id}.psbt`); break;
      case 'order-psbt-signed': submitOrderPsbtSignature(id, idOf(button.dataset.order)); break;
      case 'order-psbt-broadcast': await broadcastOrderPsbt(id, idOf(button.dataset.order)); break;
      case 'admin-refund': await adminRefund(id); break;
      case 'toggle-public-key': {
        const field = $(`#${CSS.escape(button.dataset.keyTarget || '')}`);
        if (!field) break;
        const show = field.type === 'password';
        field.type = show ? 'text' : 'password';
        button.textContent = show ? 'Ocultar' : 'Mostrar';
        button.setAttribute('aria-pressed', String(show));
        button.setAttribute('aria-label', `${show ? 'Ocultar' : 'Mostrar'} chave pública`);
        break;
      }
      case 'copy-field': await copyText($(`#${CSS.escape(button.dataset.field || '')}`)?.value || ''); break;
      default: break;
    }
  }

  document.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      event.preventDefault();
      handleAction(actionButton).catch(error => toast(error.message, 'error'));
      return;
    }
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      event.preventDefault();
      const previousFocus = captureFocusTarget();
      const view = viewButton.dataset.view;
      showView(view);
      focusViewDestination(view, previousFocus);
      return;
    }
    const scrollButton = event.target.closest('[data-scroll]');
    if (scrollButton) {
      event.preventDefault();
      const target = $(`#${CSS.escape(scrollButton.dataset.scroll)}`);
      if (!target) return;
      if (target.closest('#howView') && state.activeView !== 'how') showView('how', { scroll: false });
      else if (target.closest('#homeView') && state.activeView !== 'home') showView('home', { scroll: false });
      focusIfVisible(target);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closeMobileMenu();
      return;
    }
    const productSection = event.target.closest('[data-product-section]');
    if (productSection) {
      const target = $(`#${CSS.escape(productSection.dataset.productSection || '')}`);
      focusIfVisible(target);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const sellerTab = event.target.closest('[data-seller-tab]');
    if (sellerTab) {
      const previousFocus = captureFocusTarget();
      state.sellerTab = sellerTab.dataset.sellerTab;
      if (state.activeView !== 'seller') {
        showView('seller');
        focusViewDestination('seller', previousFocus);
      } else {
        renderSeller();
        focusDashboardTab('seller', state.sellerTab, previousFocus);
      }
      return;
    }
    const adminTab = event.target.closest('[data-admin-tab]');
    if (adminTab) {
      const previousFocus = captureFocusTarget();
      state.adminTab = adminTab.dataset.adminTab;
      if (state.activeView !== 'admin') {
        showView('admin');
        focusViewDestination('admin', previousFocus);
      } else {
        renderAdmin();
        focusDashboardTab('admin', state.adminTab, previousFocus);
      }
      return;
    }
    const categoryButton = event.target.closest('[data-category]');
    if (categoryButton) {
      $('#categoryFilter').value = categoryButton.dataset.category;
      $$('.category-link').forEach(button => button.classList.toggle('active', button.dataset.category === categoryButton.dataset.category));
      loadProducts();
      return;
    }
    const authTab = event.target.closest('[data-auth-tab]');
    if (authTab) {
      const tab = authTab.dataset.authTab;
      if (tab === 'register') state.authRole = $('#registerRole')?.value || state.authRole;
      $('#authBody').innerHTML = tab === 'login' ? loginFormHtml() : registerFormHtml(state.authRole);
      $('#authBody').setAttribute('aria-labelledby', tab === 'login' ? 'authLoginTab' : 'authRegisterTab');
      $$('.auth-tab').forEach(button => {
        const active = button.dataset.authTab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      $(tab === 'login' ? '#loginEmail' : '#registerName')?.focus();
      return;
    }
  });

  document.addEventListener('submit', event => {
    const handlers = {
      loginForm: doLogin,
      registerForm: doRegister,
      checkoutForm: submitCheckout,
      reviewForm: async formEvent => {
        formEvent.preventDefault();
        try { const data = await api('/api/reviews', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formEvent.currentTarget))) }); closeModal(); toast(data.message || 'Avaliação publicada.'); await loadAccount(); }
        catch (error) { toast(error.message, 'error'); }
      },
      disputeForm: async formEvent => {
        formEvent.preventDefault();
        try { const data = await api('/api/disputes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formEvent.currentTarget))) }); toast(data.message || 'Disputa aberta.'); await openDispute(data.dispute_id); }
        catch (error) { toast(error.message, 'error'); }
      },
      messageForm: async formEvent => {
        formEvent.preventDefault();
        const id = idOf(formEvent.currentTarget.dataset.disputeId);
        try { const data = await api(`/api/disputes/${id}/messages`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formEvent.currentTarget))) }); toast(data.message || 'Mensagem enviada.'); await openDispute(id); }
        catch (error) { toast(error.message, 'error'); }
      },
      resolveForm: async formEvent => {
        formEvent.preventDefault();
        const id = idOf(formEvent.currentTarget.dataset.disputeId);
        try { const data = await api(`/api/admin/disputes/${id}/resolve`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formEvent.currentTarget))) }); closeModal(); toast(data.message || 'Decisão registrada.'); await loadAdmin(); }
        catch (error) { toast(error.message, 'error'); }
      },
      trackingForm: submitTracking,
      storeForm: saveStore,
      productForm: saveProduct,
      destinationForm: addDestination,
      createBatchForm: createBatch,
      orderPsbtForm: submitOrderPsbt,
      walletSetupForm: setupWallet,
      walletTransferForm: createWalletTransfer,
      walletBroadcastForm: submitWalletBroadcast,
      commissionTransferForm: submitCommissionTransfer
    };
    const form = event.target instanceof HTMLFormElement ? event.target : event.target.closest('form');
    const handler = form ? handlers[form.id] : null;
    if (handler) handler({
      preventDefault: () => event.preventDefault(),
      currentTarget: form,
      target: form,
      submitter: event.submitter || null
    });
  });

  document.addEventListener('change', event => {
    if (event.target.matches('[data-cart-qty]')) updateCart(idOf(event.target.dataset.cartQty), idOf(event.target.value));
    if (['categoryFilter', 'sortFilter'].includes(event.target.id)) loadProducts();
    if (event.target.id === 'registerRole') state.authRole = event.target.value;
    if (event.target.matches('input[name="payment_method"]')) {
      $('#multisigCheckoutFields')?.classList.toggle('hidden', event.target.value === 'lightning' && event.target.checked);
      saveCheckoutDraft();
    }
    if (event.target.id === 'accountOrderStatus') { state.accountStatus = event.target.value; renderAccountOrders(); }
    if (event.target.matches('[data-reserve-dest]')) updateReservePreview();
    if (event.target.id === 'treasuryDestinationFilter') { state.treasuryFilter = event.target.value; $('#treasuryDestinationResults').innerHTML = destinationsTable(filteredDestinations()); }
  });

  document.addEventListener('input', event => {
    if (['priceMin', 'priceMax', 'inStockFilter'].includes(event.target.id)) renderProducts();
    if (event.target.closest('#checkoutForm')) saveCheckoutDraft();
    if (event.target.id === 'accountOrderSearch') { state.accountSearch = event.target.value; renderAccountOrders(); }
    if (event.target.id === 'reserveAmount') updateReservePreview();
    if (event.target.id === 'treasuryDestinationSearch') { state.treasurySearch = event.target.value; $('#treasuryDestinationResults').innerHTML = destinationsTable(filteredDestinations()); }
    if (event.target.id === 'profilePubkey') updateProfileKeyFeedback();
  });

  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const fallback = safeImage(image.dataset.fallback);
    const source = safeImage(image.getAttribute('src'));
    if (fallback && source !== fallback && image.dataset.fallbackAttempted !== 'true') {
      image.dataset.fallbackAttempted = 'true';
      image.src = fallback;
      return;
    }
    if (image.dataset.imageContext || image.classList.contains('product-image')) markProductImageMissing(image);
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if ($('#modalRoot .modal')) { closeModal(); return; }
      if (state.mobileMenuOpen) { closeMobileMenu(); return; }
      if (state.searchOpen) { state.searchOpen = false; $('#searchForm').classList.remove('search-open'); $('#searchToggle').setAttribute('aria-expanded', 'false'); }
    }
    const authTab = event.target instanceof Element ? event.target.closest('[data-auth-tab]') : null;
    if (authTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = $$('[data-auth-tab]', $('#modalRoot')).filter(tab => !tab.disabled);
      const currentIndex = tabs.indexOf(authTab);
      if (currentIndex >= 0 && tabs.length) {
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex];
        event.preventDefault();
        if (nextTab !== authTab) {
          nextTab.click();
          nextTab.focus();
        }
      }
      return;
    }
    const dialog = $('#modalRoot .modal');
    if (!dialog || event.key !== 'Tab') return;
    const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]', dialog).filter(element => element.offsetParent !== null);
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  $('#searchForm').addEventListener('submit', event => {
    event.preventDefault();
    state.searchOpen = false;
    $('#searchForm').classList.remove('search-open');
    $('#searchToggle').setAttribute('aria-expanded', 'false');
    showView('catalog');
    loadProducts();
  });

  $('#resetFiltersBtn')?.addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#categoryFilter').value = '';
    $('#sortFilter').value = 'featured';
    $('#priceMin').value = '';
    $('#priceMax').value = '';
    $('#inStockFilter').checked = false;
    loadProducts();
  });

  renderSession();
  bootstrap();
})();
