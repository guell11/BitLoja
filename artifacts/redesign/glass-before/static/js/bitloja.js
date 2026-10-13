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
    authRole: 'buyer', modalReturnFocus: null
  };
  const config = {
    btcMode: document.body.dataset.btcMode || 'demo',
    btcNetwork: document.body.dataset.btcNetwork || 'testnet',
    custodyMode: 'demo', lightningMode: 'off', commissionSigningMode: 'offline'
  };

  function productImage(product) {
    const text = `${product?.name || ''} ${product?.category || ''}`.toLocaleLowerCase('pt-BR');
    const id = idOf(product?.id);
    const fallbackById = {
      1: productPhotos.headset, 2: productPhotos.keyboard, 3: productPhotos.ssd,
      4: productPhotos.watch, 5: productPhotos.backpack, 6: productPhotos.lamp,
      7: productPhotos.bottle, 8: productPhotos.organizer
    };
    const key = text.includes('head') ? 'headset' : text.includes('tecl') ? 'keyboard' :
      text.includes('ssd') || text.includes('hardware') ? 'ssd' :
      text.includes('watch') || text.includes('wear') || text.includes('smartwatch') ? 'watch' :
      text.includes('moch') || text.includes('backpack') ? 'backpack' :
      text.includes('lumin') || text.includes('lamp') ? 'lamp' :
      text.includes('garrafa') || text.includes('bottle') ? 'bottle' :
      text.includes('organ') || text.includes('grid') ? 'organizer' : '';
    const fallback = productPhotos[key] || fallbackById[id] || productPhotos.organizer;
    const candidate = String(product?.image_url || '').trim();
    if (!candidate) return fallback;
    if (candidate.startsWith('/static/')) return candidate;
    try {
      const url = new URL(candidate, location.origin);
      if (url.protocol === 'https:' || url.origin === location.origin) return url.href;
    } catch (_) { /* Invalid seller image URL falls back to catalog asset. */ }
    return fallback;
  }

  async function api(path, options = {}) {
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
    if (!response.ok) {
      const message = typeof data === 'object' && data ? data.error || data.message : data;
      throw new Error(message || `Erro ${response.status}`);
    }
    return data;
  }

  async function download(path, fallbackName) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'X-CSRF-Token': state.csrf } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Erro ${response.status}`);
    }
    const disposition = response.headers.get('content-disposition') || '';
    const matchedName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const blob = await response.blob();
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

  function showView(name) {
    const target = $(`#${name}View`);
    if (!target) return;
    if (['account', 'wallet', 'custody', 'seller', 'admin'].includes(name) && !state.user) {
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
    const isDashboard = ['seller', 'admin'].includes(name);
    $('#siteHeader').classList.toggle('hidden', isDashboard);
    $$('.nav-link[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === name));
    $('#siteFooter').classList.toggle('hidden', isDashboard);
    closeMobileMenu();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    label.textContent = state.user ? String(state.user.name || 'Conta').trim().split(/\s+/)[0] : 'Entrar';
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
  }

  async function bootstrap() {
    try {
      const data = await api('/api/bootstrap');
      state.csrf = data.csrf_token || '';
      state.user = data.user || null;
      state.cartCount = idOf(data.cart_count);
      config.btcMode = data.btc_mode || config.btcMode;
      config.btcNetwork = data.network || config.btcNetwork;
      config.custodyMode = data.custody_mode || 'demo';
      config.lightningMode = data.lightning_mode || 'off';
      config.commissionSigningMode = data.commission_signing_mode || 'offline';
      renderSession();
      renderNetwork();
      await Promise.all([loadProducts(), loadStores()]);
      if (state.user) refreshNotificationBadge();
    } catch (error) {
      toast(error.message, 'error');
      await Promise.all([loadProducts(), loadStores()]);
    }
  }

  function renderProductCard(product) {
    const id = idOf(product.id);
    const image = productImage(product);
    const stock = num(product.stock);
    const reviewCount = idOf(product.review_count);
    const rating = num(product.rating);
    const compare = num(product.compare_at_sats) > num(product.price_sats);
    const fallback = productPhotos[id === 1 ? 'headset' : id === 2 ? 'keyboard' : id === 3 ? 'ssd' : id === 4 ? 'watch' : id === 5 ? 'backpack' : id === 6 ? 'lamp' : id === 7 ? 'bottle' : 'organizer'];
    return `<article class="product-card" data-product-card="${id}">
      <div class="product-media"><button class="product-open" type="button" data-action="open-product" data-id="${id}" aria-label="Ver ${esc(product.name)}"><img class="product-image" src="${esc(image)}" data-fallback="${esc(fallback)}" alt="${esc(product.name)}" loading="lazy"></button></div>
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
    restoreFocusTarget(previousFocus, $(`#${view}Content`) || $(`#${view}View`));
  }

  function focusUpdatedContent(root, previousFocus) {
    const fallback = root?.querySelector('[data-dashboard-title], h1, h2, .notice, .empty') || root;
    restoreFocusTarget(previousFocus, fallback);
  }

  function focusDashboardTab(role, tab, previousFocus) {
    const tabSelector = role === 'seller' ? 'data-seller-tab' : 'data-admin-tab';
    const fallback = $(`.dashboard-nav-link[${tabSelector}="${CSS.escape(tab)}"]`)
      || $(`#${role}Content [data-dashboard-title]`);
    restoreFocusTarget(previousFocus, fallback);
  }

  async function doLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
    setAuthFeedback(form);
    setAuthPending(form, true);
    try {
      const data = await api('/api/login', { method: 'POST', body: payload });
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
    setLoading(root, 'Carregando produto');
    try {
      const data = await api(`/api/products/${idOf(id)}`);
      state.currentProduct = data.product;
      const p = data.product;
      const store = data.store || {};
      const reviewItems = Array.isArray(data.reviews) ? data.reviews : [];
      const similar = Array.isArray(data.related) ? data.related : [];
      root.innerHTML = `<div class="crumbs"><button class="nav-link" type="button" data-view="home">Início</button><i class="bi bi-chevron-right" aria-hidden="true"></i><button class="nav-link" type="button" data-view="catalog">Produtos</button><i class="bi bi-chevron-right" aria-hidden="true"></i><span>${esc(p.category)}</span></div>
        <div class="product-detail-grid"><div class="product-detail-visual"><img src="${esc(productImage(p))}" data-fallback="${esc(productImage({ id: p.id, name: p.name, category: p.category }))}" alt="${esc(p.name)}"></div>
        <div class="product-buy-box"><p class="product-store">${esc(store.name || p.store_name || 'Loja')}</p><h1>${esc(p.name)}</h1><div class="detail-rating">${num(p.review_count) ? `${stars(p.rating)} ${num(p.rating).toFixed(1)} · ${idOf(p.review_count)} avaliações` : 'Sem avaliações registradas'}</div><p class="lead">${esc(p.short_description || p.description || '')}</p>${num(p.compare_at_sats) > num(p.price_sats) ? `<p class="old-price">Preço anterior: ₿ ${esc(p.compare_at_btc)}</p>` : ''}<strong class="big-price">₿ ${esc(p.price_btc)}</strong><p class="product-stock">${num(p.stock) > 0 ? `${num(p.stock)} unidades disponíveis` : 'Indisponível'}</p><div class="quantity-row"><label class="sr-only" for="productQty">Quantidade</label><input class="input" id="productQty" type="number" min="1" max="${Math.max(1, num(p.stock))}" value="1"><button class="btn btn-primary" type="button" data-action="add-current-product" data-id="${idOf(p.id)}" ${num(p.stock) < 1 ? 'disabled' : ''}><i class="bi bi-bag-plus" aria-hidden="true"></i> Adicionar ao carrinho</button></div><div class="seller-box"><span><small>Vendido por</small><strong>${esc(store.name || p.store_name || 'Loja')}</strong></span><button class="btn btn-secondary btn-sm" type="button" data-action="open-store" data-id="${idOf(store.id || p.store_id)}">Ver loja</button></div></div></div>
        <div class="detail-lower"><section class="panel"><h2>Descrição</h2><p class="preserve-lines">${esc(p.description || p.short_description || 'Sem descrição cadastrada.')}</p></section><section class="panel"><h2>Loja</h2><p>${esc(store.description || 'Sem descrição cadastrada.')}</p><div class="store-details">${num(store.review_count) ? `${stars(store.rating)} ${num(store.rating).toFixed(1)} · ${idOf(store.review_count)} avaliações` : 'Sem avaliações registradas'}${store.tier ? ` · ${esc(store.tier)}` : ''}</div></section></div>
        <section class="section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Compras concluídas</p><h2>Avaliações</h2></div></div>${reviewItems.length ? reviewItems.map(reviewCard).join('') : '<div class="empty">Este produto ainda não possui avaliações.</div>'}</section>
        ${similar.length ? `<section class="section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Catálogo</p><h2>Produtos relacionados</h2></div></div><div class="product-grid">${similar.map(renderProductCard).join('')}</div></section>` : ''}`;
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
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
    if (!state.user) { openAuth('login'); return; }
    try {
      const data = await api('/api/cart/add', { method: 'POST', body: JSON.stringify({ product_id: idOf(productId), quantity: Math.max(1, idOf(quantity)) }) });
      if (data.count !== undefined) state.cartCount = idOf(data.count); else state.cartCount += Math.max(1, idOf(quantity));
      renderSession();
      toast(data.message || 'Produto adicionado ao carrinho.');
    } catch (error) { toast(error.message, 'error'); }
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
      return `<article class="cart-item"><img class="cart-thumb" src="${esc(image)}" data-fallback="${esc(fallback)}" alt="${esc(item.name)}" loading="lazy"><div class="cart-item-info"><strong>${esc(item.name)}</strong><span>₿ ${esc(item.price_btc || item.unit_price_btc || '')} cada</span></div><div class="cart-line-total"><small>Total do item</small><strong class="cart-item-price">₿ ${esc(item.line_total_btc)}</strong></div><div class="qty-control"><button type="button" data-action="cart-qty" data-id="${idOf(item.id)}" data-delta="-1" aria-label="Diminuir quantidade de ${esc(item.name)}">−</button><label class="sr-only" for="cartQty${idOf(item.id)}">Quantidade de ${esc(item.name)}</label><input id="cartQty${idOf(item.id)}" type="number" min="0" max="${Math.max(0, num(item.stock))}" value="${idOf(item.quantity)}" data-cart-qty="${idOf(item.id)}"><button type="button" data-action="cart-qty" data-id="${idOf(item.id)}" data-delta="1" aria-label="Aumentar quantidade de ${esc(item.name)}">+</button></div><button class="remove-item" type="button" data-action="cart-remove" data-id="${idOf(item.id)}" aria-label="Remover ${esc(item.name)}"><i class="bi bi-trash3" aria-hidden="true"></i></button></article>`;
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

  function openCheckout() {
    if (!state.user) { openAuth('login'); return; }
    const key = state.user.bitcoin_pubkey || '';
    const body = `<div class="notice notice-info">Cada loja gera um pedido separado. On-chain usa escrow 2-de-3; Lightning fica identificado como custodial.</div><form id="checkoutForm"><fieldset class="field"><legend>Meio de pagamento</legend><label class="method-card"><input type="radio" name="payment_method" value="onchain_multisig" checked><span><strong>Escrow on-chain 2-de-3</strong><small>Comprador, vendedor e mediador; duas assinaturas decidem o destino.</small></span></label><label class="method-card"><input type="radio" name="payment_method" value="lightning" ${config.lightningMode === 'off' ? 'disabled' : ''}><span><strong>Lightning Express</strong><small>${config.lightningMode === 'off' ? 'Desativado neste servidor.' : 'Pagamento custodial pelo nó Lightning da plataforma.'}</small></span></label></fieldset><div id="multisigCheckoutFields"><div class="field"><label for="buyerPubkey">Sua chave pública Bitcoin comprimida</label><input class="input" id="buyerPubkey" name="buyer_pubkey" value="${esc(key)}" placeholder="Chave pública comprimida"><small>A chave privada permanece na sua carteira.</small></div></div><div class="grid-2"><div class="field"><label for="shippingName">Nome do destinatário</label><input class="input" id="shippingName" name="shipping_name" autocomplete="name" required value="${esc(state.user.name || '')}"></div><div class="field"><label for="shippingZip">CEP</label><input class="input" id="shippingZip" name="shipping_zip" autocomplete="postal-code" required></div></div><div class="field"><label for="shippingAddress">Endereço completo</label><input class="input" id="shippingAddress" name="shipping_address" autocomplete="street-address" required></div><div class="grid-2"><div class="field"><label for="shippingCity">Cidade</label><input class="input" id="shippingCity" name="shipping_city" autocomplete="address-level2" required></div><div class="field"><label for="shippingState">Estado</label><input class="input" id="shippingState" name="shipping_state" autocomplete="address-level1" required></div></div><div class="field"><label for="refundAddress">Endereço BTC para reembolso</label><input class="input" id="refundAddress" name="buyer_refund_address" placeholder="Endereço compatível com ${esc(config.btcNetwork)}"><small>Usado em propostas de devolução e pagamentos excedentes.</small></div><button class="btn btn-primary" type="submit">Criar pedidos</button></form>`;
    openModal('Finalizar compra', body, true);
  }

  async function submitCheckout(event) {
    event.preventDefault();
    try {
      const data = await api('/api/checkout', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      state.cartCount = 0;
      renderSession();
      const orders = Array.isArray(data.orders) ? data.orders : [];
      const cards = orders.map(order => `<article class="checkout-order"><div class="checkout-order-head"><strong>${esc(order.reference)}</strong>${statusTag(order.status || 'awaiting_payment')}</div><p>₿ ${esc(order.total_btc)}</p><span class="mode-tag">${order.payment_method === 'lightning' ? 'Lightning custodial' : 'Escrow on-chain 2-de-3'}</span><div class="keybox">${esc(order.payment_method === 'lightning' ? order.lightning_invoice : order.payment_address)}</div><button class="btn btn-secondary btn-sm" type="button" data-action="copy" data-value="${esc(order.payment_method === 'lightning' ? order.lightning_invoice : order.payment_address)}">Copiar ${order.payment_method === 'lightning' ? 'invoice' : 'endereço escrow'}</button></article>`).join('');
      openModal('Pedidos criados', `<div class="notice notice-success">${esc(data.message || 'Pedidos criados.')}</div>${cards}<button class="btn btn-primary" type="button" data-action="checkout-orders">Ver meus pedidos</button>`, true);
    } catch (error) { toast(error.message, 'error'); }
  }

  function orderTable(orders, seller = false) {
    if (!orders?.length) return '<div class="empty">Nenhum pedido registrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>${seller ? 'Comprador' : 'Loja'}</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${esc(order.reference)}</strong><br><small>${esc(dateText(order.created_at))}</small></td><td>${esc(seller ? order.buyer_name || '' : order.store_name || '')}</td><td>₿ ${esc(order.total_btc)}</td><td>${statusTag(order.status)}</td><td><div class="actions"><button class="btn btn-secondary btn-sm" type="button" data-action="open-order" data-id="${idOf(order.id)}">Detalhes</button>${seller ? `<button class="btn btn-secondary btn-sm" type="button" data-action="tracking" data-id="${idOf(order.id)}">Rastreio</button>${!['awaiting_payment', 'partial', 'cancelled', 'refunded'].includes(order.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="open-dispute" data-id="${idOf(order.id)}">Disputa</button>` : ''}` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  async function loadAccount() {
    if (!state.user) { openAuth('login'); showView('home'); return; }
    const root = $('#accountContent');
    const previousFocus = captureFocusTarget();
    setLoading(root, 'Carregando pedidos');
    try {
      const data = await api('/api/orders/my');
      const orders = Array.isArray(data.orders) ? data.orders : [];
      const paid = orders.filter(order => !['awaiting_payment', 'partial', 'cancelled'].includes(order.status)).length;
      const completed = orders.filter(order => order.status === 'completed').length;
      const progress = orders.filter(order => ['paid', 'processing', 'shipped'].includes(order.status)).length;
      root.innerHTML = `<div class="metrics"><article class="metric-card"><small>Pedidos</small><strong>${orders.length}</strong></article><article class="metric-card"><small>Pagos</small><strong>${paid}</strong></article><article class="metric-card"><small>Concluídos</small><strong>${completed}</strong></article><article class="metric-card"><small>Em andamento</small><strong>${progress}</strong></article></div><section class="panel section"><div class="section-heading"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Histórico</p><h2>Seus pedidos</h2></div></div>${orderTable(orders)}</section>`;
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
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
    const fallbackImages = { 1: productPhotos.headset, 2: productPhotos.keyboard, 3: productPhotos.ssd, 4: productPhotos.watch, 5: productPhotos.backpack, 6: productPhotos.lamp, 7: productPhotos.bottle, 8: productPhotos.organizer };
    const rows = stockItems.length ? stockItems.map(product => {
      const source = String(product.image_url || '').trim() ? productImage(product) : fallbackImages[idOf(product.id)];
      const thumb = source ? `<img src="${esc(source)}" alt="" loading="lazy">` : '<i class="bi bi-box-seam" aria-hidden="true"></i>';
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
    return `<div class="table-wrap"><table><thead><tr><th>Lote</th><th>Lojas</th><th>Total</th><th>Status</th><th>Ação</th></tr></thead><tbody>${batches.map(batch => `<tr><td><strong>${esc(batch.reference)}</strong><br><small>${esc(dateText(batch.created_at))}</small></td><td>${esc(batch.store_count ?? batch.items_count ?? '—')}</td><td>₿ ${esc(batch.total_btc)}</td><td>${statusTag(batch.status)}</td><td><button class="btn btn-secondary btn-sm" type="button" data-action="open-batch" data-id="${idOf(batch.id)}">Detalhes</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function treasurySection(data) {
    const destinations = data.destinations || [];
    const active = destinations.filter(item => item.active);
    return `<div class="grid-2 section"><section class="panel"><h2>Carteira de liquidação</h2><p>Crie endereço rotulado no Bitcoin Core ou consolide UTXOs conforme a política do servidor.</p><button class="btn btn-primary" type="button" data-action="new-settlement-address">Criar endereço</button><div class="field"><label for="consolidateDestination">Destino da consolidação (opcional)</label><input class="input" id="consolidateDestination"></div><button class="btn btn-danger" type="button" data-action="consolidate" ${config.btcMode !== 'rpc' ? 'disabled' : ''}>Centralizar UTXOs</button></section><section class="panel"><h2>Distribuição de reservas</h2><p>Distribui o valor entre destinos aprovados conforme os pesos cadastrados.</p><div class="field"><label for="reserveAmount">Valor BTC</label><input class="input" id="reserveAmount" type="number" min="0.00000001" step="0.00000001"></div><div id="destinationChecks">${active.length ? active.map(item => `<label class="check-row"><input type="checkbox" value="${idOf(item.id)}" data-reserve-dest><span>${esc(item.label)} · peso ${esc(item.weight)}</span></label>`).join('') : '<div class="empty">Nenhum destino ativo.</div>'}</div><button class="btn btn-secondary" type="button" data-action="distribute-reserves" ${active.length ? '' : 'disabled'}>Distribuir reservas</button></section></div><div class="grid-2 section"><section class="panel"><h2>Novo destino aprovado</h2><form id="destinationForm"><div class="field"><label for="destinationLabel">Rótulo</label><input class="input" id="destinationLabel" name="label" required maxlength="120"></div><div class="field"><label for="destinationAddress">Endereço Bitcoin</label><input class="input" id="destinationAddress" name="address" required maxlength="160"></div><div class="field"><label for="destinationWeight">Peso</label><input class="input" id="destinationWeight" name="weight" type="number" min="1" max="100" value="1" required></div><button class="btn btn-primary" type="submit">Cadastrar destino</button></form></section><section class="panel"><h2>Destinos cadastrados</h2>${destinationsTable(destinations)}</section></div>`;
  }

  function destinationsTable(destinations) {
    if (!destinations.length) return '<div class="empty">Nenhum destino cadastrado.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Destino</th><th>Peso</th><th>Status</th><th>Ação</th></tr></thead><tbody>${destinations.map(item => `<tr><td><strong>${esc(item.label)}</strong><br><small>${esc(short(item.address, 30))}</small></td><td>${esc(item.weight)}</td><td>${item.active ? 'Ativo' : 'Inativo'}</td><td><button class="btn btn-secondary btn-sm" type="button" data-action="toggle-destination" data-id="${idOf(item.id)}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}</tbody></table></div>`;
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
    const critical = await promptCritical('CENTRALIZAR TESOURARIA');
    if (!critical) return;
    try { const data = await api('/api/admin/treasury/consolidate', { method: 'POST', body: JSON.stringify({ ...critical, destination: String($('#consolidateDestination')?.value || '').trim() }) }); toast(`${data.message || 'Consolidação enviada.'} TX ${short(data.txid)}`); await loadAdmin(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function distributeReserves() {
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
      let commission = null;
      if (state.user.role === 'admin') commission = await api('/api/admin/commission');
      const commissionPanel = commission ? commissionAdminHtml(commission) : '';
      root.innerHTML = `<section class="custody-banner"><div><p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span> Configuração atual</p><h2>Pagamentos Bitcoin</h2><p>Confira modos ativos no servidor. Chaves privadas e seeds não são recebidas pela BitLoja.</p></div><img src="/static/assets/bitcoin-crystal.webp" alt="" aria-hidden="true"></section><div class="protocol-grid section"><article class="protocol-card"><span class="protocol-step">01</span><h3>Escrow on-chain</h3><p>P2WSH 2-de-3 com chaves públicas do comprador, vendedor e mediador.</p><span class="mode-tag">${esc(cfg.custody_mode || '—')}</span></article><article class="protocol-card"><span class="protocol-step">02</span><h3>PSBT offline</h3><p>Propostas são exportadas, assinadas em carteira externa e submetidas para validação.</p><span class="mode-tag">BIP 174</span></article><article class="protocol-card"><span class="protocol-step">03</span><h3>Lightning</h3><p>O modo e a configuração exibidos refletem o serviço disponível no servidor.</p><span class="mode-tag">${esc(cfg.lightning_mode || '—')}</span></article></div><div class="grid-2 section"><section class="panel"><h2>Minha chave pública</h2><p>Cadastre chave pública Bitcoin comprimida. Não envie seed, WIF ou chave privada.</p><form id="profileKeyForm"><div class="field"><label for="profilePubkey">Chave pública</label><input class="input" id="profilePubkey" name="pubkey" value="${esc(cfg.user_pubkey || '')}" placeholder="02/03 + 64 caracteres hex"></div><button class="btn btn-primary" type="submit">Salvar chave pública</button></form></section><section class="panel"><h2>Chave pública do mediador</h2><code class="keybox">${esc(cfg.platform_pubkey || 'Não configurada')}</code><p>O backend guarda chave pública e descriptors; assinatura ocorre fora do Flask.</p></section></div>${state.user.role === 'seller' ? '<div class="notice notice-info">A chave escrow específica da loja fica em Minha loja.</div>' : ''}${commissionPanel}`;
      $('#profileKeyForm')?.addEventListener('submit', saveProfileKey);
    } catch (error) { root.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`; }
    finally { focusUpdatedContent(root, previousFocus); }
  }

  async function saveProfileKey(event) {
    event.preventDefault();
    try { const data = await api('/api/profile/bitcoin-key', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); state.user.bitcoin_pubkey = data.pubkey; toast(data.message || 'Chave pública salva.'); }
    catch (error) { toast(error.message, 'error'); }
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
    $('#walletContent').innerHTML = `<div class="notice ${wallet.status === 'offline' ? 'notice-danger' : 'notice-info'}"><strong>${esc(wallet.mode || '—')}</strong> · ${esc(wallet.network || config.btcNetwork)} · ${esc(statusLabels[wallet.status] || wallet.status || '—')}${walletNotice}</div><div class="metrics"><article class="metric-card"><small>Confirmado</small><strong>₿ ${esc(wallet.confirmed_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Pendente</small><strong>₿ ${esc(wallet.pending_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Reservado</small><strong>₿ ${esc(wallet.reserved_btc || '0.00000000')}</strong></article><article class="metric-card"><small>Disponível</small><strong>₿ ${esc(wallet.available_btc || '0.00000000')}</strong></article></div>${setup}<div class="grid-2 section">${addressPanel}${transferForm}</div><div class="section">${transfersPanel}</div>`;
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
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (beforeId) query.set('before_id', String(idOf(beforeId)));
      const data = await api(`/api/notifications?${query}`);
      state.notifications = beforeId ? [...state.notifications, ...(data.notifications || [])] : (data.notifications || []);
      state.unreadCount = idOf(data.unread_count);
      renderSession();
      const oldest = state.notifications.reduce((min, item) => Math.min(min, idOf(item.id)), Number.MAX_SAFE_INTEGER);
      const body = `<div class="notifications-tools"><strong>${state.unreadCount} não lidas</strong><button class="btn btn-secondary btn-sm" type="button" data-action="read-all-notifications" ${state.unreadCount ? '' : 'disabled'}>Marcar todas como lidas</button></div><div class="notification-list">${state.notifications.length ? state.notifications.map(item => `<article class="notification-item ${item.read_at ? 'is-read' : ''}"><div><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><small>${esc(dateText(item.created_at))}</small></div><div class="notification-actions">${item.order_id ? `<button class="btn btn-secondary btn-sm" type="button" data-action="notification-order" data-id="${idOf(item.order_id)}">Ver pedido</button>` : ''}${!item.read_at ? `<button class="btn btn-secondary btn-sm" type="button" data-action="read-notification" data-id="${idOf(item.id)}">Marcar lida</button>` : ''}</div></article>`).join('') : '<div class="empty">Nenhuma notificação.</div>'}</div>${state.notifications.length >= 50 ? `<button class="btn btn-secondary" type="button" data-action="older-notifications" data-before="${oldest}">Carregar anteriores</button>` : ''}`;
      openModal('Notificações', body, true);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function markNotificationRead(id) {
    try { const data = await api(`/api/notifications/${idOf(id)}/read`, { method: 'POST', body: '{}' }); toast(data.message || 'Notificação marcada como lida.'); await openNotifications(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function markAllNotificationsRead() {
    try { const data = await api('/api/notifications/read-all', { method: 'POST', body: '{}' }); toast(data.message || 'Notificações atualizadas.'); await openNotifications(); }
    catch (error) { toast(error.message, 'error'); }
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
      case 'home': showView('home'); break;
      case 'auth-home': closeModal({ restoreFocus: false }); showView('home'); focusViewDestination('home'); break;
      case 'catalog': showView('catalog'); break;
      case 'sell': sellAction(); break;
      case 'account-menu': accountMenu(); break;
      case 'cart': showView('cart'); break;
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
      case 'add-current-product': await addToCart(id, $('#productQty')?.value || 1); break;
      case 'checkout': openCheckout(); break;
      case 'checkout-orders': closeModal({ restoreFocus: false }); showView('account'); focusViewDestination('account'); break;
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
      case 'older-notifications': await openNotifications(button.dataset.before); break;
      case 'notification-order': await openNotificationsOrder(id); break;
      case 'manage-psbt': await managePsbt(id); break;
      case 'order-psbt-new': openOrderPsbtForm(id, button.dataset.kind); break;
      case 'order-psbt-download': await download(`/api/psbts/${id}/download`, `proposta-${id}.psbt`); break;
      case 'order-psbt-signed': submitOrderPsbtSignature(id, idOf(button.dataset.order)); break;
      case 'order-psbt-broadcast': await broadcastOrderPsbt(id, idOf(button.dataset.order)); break;
      case 'admin-refund': await adminRefund(id); break;
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
    if (viewButton) { event.preventDefault(); showView(viewButton.dataset.view); return; }
    const scrollButton = event.target.closest('[data-scroll]');
    if (scrollButton) {
      const target = $(`#${CSS.escape(scrollButton.dataset.scroll)}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closeMobileMenu();
      return;
    }
    const sellerTab = event.target.closest('[data-seller-tab]');
    if (sellerTab) {
      const previousFocus = captureFocusTarget();
      state.sellerTab = sellerTab.dataset.sellerTab;
      renderSeller();
      focusDashboardTab('seller', state.sellerTab, previousFocus);
      return;
    }
    const adminTab = event.target.closest('[data-admin-tab]');
    if (adminTab) {
      const previousFocus = captureFocusTarget();
      state.adminTab = adminTab.dataset.adminTab;
      renderAdmin();
      focusDashboardTab('admin', state.adminTab, previousFocus);
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
    if (event.target.matches('input[name="payment_method"]')) $('#multisigCheckoutFields')?.classList.toggle('hidden', event.target.value === 'lightning' && event.target.checked);
  });

  document.addEventListener('input', event => {
    if (['priceMin', 'priceMax', 'inStockFilter'].includes(event.target.id)) renderProducts();
  });

  document.addEventListener('error', event => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.dataset.fallback && image.src !== new URL(image.dataset.fallback, location.origin).href) {
      image.src = image.dataset.fallback;
      image.removeAttribute('data-fallback');
    }
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

  bootstrap();
})();
