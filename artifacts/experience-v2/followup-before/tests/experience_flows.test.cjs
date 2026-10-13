const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'static/js/bitloja.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const exportsToTest = ['state', 'config', 'api', 'resetPrivateState', 'productImage', 'renderAccount', 'renderAccountOrders', 'openCheckout', 'submitCheckout', 'renderCheckoutOrders', 'openNotifications', 'markNotificationRead', 'markAllNotificationsRead', 'calculateReserveAllocation', 'btcStringToSats', 'satsToBtcText', 'treasurySection', 'updateProfileKeyFeedback'];
for (const name of exportsToTest.filter(name => !['state', 'config'].includes(name))) {
  assert.match(source, new RegExp(`function ${name}\\(`), `Missing experience flow: ${name}`);
}

class Node {
  constructor(id = '') {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.type = 'text';
    this.isConnected = true;
    this.dataset = {};
    this.attributes = new Map();
    this.selectors = new Map();
    this.lists = new Map();
    this.closestNodes = new Map();
    this.disabled = false;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  querySelector(selector) { return this.selectors.get(selector) || null; }
  querySelectorAll(selector) { return this.lists.get(selector) || []; }
  closest(selector) { return this.closestNodes.get(selector) || null; }
  matches() { return true; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) || null; }
  removeAttribute(key) { this.attributes.delete(key); }
  replaceChildren() { this.innerHTML = ''; }
  append() {}
  addEventListener() {}
  click() {}
  remove() { this.isConnected = false; }
  focus() { document.activeElement = this; }
  scrollIntoView(options) { this.scrollOptions = options; }
  checkValidity() { return true; }
  reportValidity() { return true; }
}

const nodes = new Map();
const handlers = new Map();
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector, new Node(selector.replace(/^#/, '')));
  return nodes.get(selector);
};
const document = {
  body: new Node('body'),
  activeElement: null,
  querySelector: node,
  querySelectorAll: () => [],
  createElement: () => new Node(),
  addEventListener: (event, handler) => handlers.set(event, handler)
};
document.body.dataset = { btcMode: 'demo', btcNetwork: 'regtest' };
document.activeElement = document.body;
class FormDataFixture {
  constructor(form) { this.values = Object.entries(form.fieldValues || {}); }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}
const requests = [];
let responses = [];
const fetchFixture = async (url, options) => {
  requests.push({ url: String(url), options });
  const entry = responses.shift();
  if (typeof entry === 'function') return entry(url, options);
  if (!entry) throw new Error(`Unexpected request ${url}`);
  return response(entry);
};
const response = data => ({ ok: !data.error, status: data.error ? 400 : 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data });
const context = {
  document, HTMLElement: Node, HTMLFormElement: Node, HTMLImageElement: Node, Element: Node,
  window: { scrollTo: options => { context.lastScroll = options; }, setTimeout: () => 0, crypto: { randomUUID: () => 'test-id' } },
  location: { origin: 'http://localhost' }, navigator: {}, CSS: { escape: String },
  Headers, URL, URLSearchParams, Blob, FormData: FormDataFixture, fetch: fetchFixture, console
};
const injected = source.replace(/  renderSession\(\);\s*bootstrap\(\);\s*\}\)\(\);\s*$/, `  globalThis.experience = { ${exportsToTest.join(', ')} };\n})();`);
assert.notEqual(injected, source, 'Test injection must replace startup only');
vm.runInNewContext(injected, context, { filename: sourcePath });
const x = context.experience;
const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
const test = (name, run) => tests.push({ name, run });
const user = { id: 1, role: 'buyer', name: 'Comprador', email: 'buyer@example.test' };
const shipping = {
  payment_method: 'onchain_multisig', buyer_pubkey: '', shipping_name: 'Comprador', shipping_zip: '01001-000',
  shipping_address: 'Rua de teste, 10', shipping_city: 'São Paulo', shipping_state: 'SP', buyer_refund_address: ''
};

test('integer sats reject precision loss and invalid decimals', () => {
  assert.equal(x.btcStringToSats('0.00000001'), 1n);
  assert.equal(x.btcStringToSats('1.5'), 150000000n);
  assert.equal(x.btcStringToSats('90071992.54740993'), 9007199254740993n);
  for (const value of ['1e-8', '-1', '1.000000001', 'a', '.1']) assert.equal(x.btcStringToSats(value), null);
  assert.equal(x.satsToBtcText(1n), '0.00000001');
});
test('weighted allocation matches backend floor and final remainder', () => {
  const allocation = x.calculateReserveAllocation('0.00000010', [{ id: 3, weight: 3 }, { id: 1, weight: 1 }, { id: 2, weight: 2 }]);
  assert.deepEqual(Array.from(allocation, item => [item.id, item.sats]), [[1, 1n], [2, 3n], [3, 6n]]);
  assert.equal(allocation.reduce((total, item) => total + item.sats, 0n), 10n);
  const large = x.calculateReserveAllocation('90071992.54740993', [{ id: 1, weight: 1 }, { id: 2, weight: 1 }]);
  assert.equal(large.reduce((total, item) => total + item.sats, 0n), 9007199254740993n);
  assert.equal(x.calculateReserveAllocation('0', [{ id: 1, weight: 1 }]).length, 0);
});
test('unknown hardware never receives unrelated SSD photo', () => {
  assert.equal(x.productImage({ name: 'Cabo USB', category: 'Hardware' }), '');
  assert.equal(x.productImage({ name: 'Cabo USB', image_url: '/static/uploads/cabo.webp' }), '/static/uploads/cabo.webp');
  assert.equal(x.productImage({ name: 'SSD NVMe 1 TB' }), '/static/assets/products/ssd.webp');
  assert.equal(x.productImage({ name: 'SSD genérico' }), '');
});
test('checkout and inbox never invoke modal renderer', () => {
  for (const fn of [x.openCheckout, x.submitCheckout, x.renderCheckoutOrders, x.openNotifications]) assert.doesNotMatch(fn.toString(), /openModal\(/);
});
test('account uses real counts and searchable order cards', () => {
  x.state.user = user;
  x.state.accountOrders = [{ id: 9, reference: 'BL-009', store_name: 'Loja A', status: 'shipped', total_btc: '0.00100000', payment_method: 'onchain_multisig' }, { id: 10, reference: 'BL-010', store_name: 'Loja B', status: 'completed', total_btc: '0.00200000' }];
  x.renderAccount();
  assert.match(node('#accountContent').innerHTML, /Aguardando BTC/);
  assert.match(node('#accountOrders').innerHTML, /BL-009/);
  x.state.accountSearch = 'loja b';
  x.renderAccountOrders();
  assert.doesNotMatch(node('#accountOrders').innerHTML, /BL-009/);
  assert.match(node('#accountOrders').innerHTML, /BL-010/);
  assert.equal(node('#accountResultCount').textContent, '1 pedido');
  x.state.accountStatus = 'cancelled';
  x.renderAccountOrders();
  assert.match(node('#accountOrders').innerHTML, /Nenhum pedido encontrado/);
});
test('checkout fetches current cart and preserves named payload fields', async () => {
  x.state.user = user;
  x.state.checkoutDraft = { ...shipping };
  responses = [{ items: [{ id: 2, name: 'Produto real', quantity: 2, price_btc: '0.00000010', line_total_btc: '0.00000020', store_name: 'Loja A' }], count: 2, total_btc: '0.00000020' }];
  await x.openCheckout();
  assert.equal(requests.at(-1).url, '/api/cart');
  for (const field of Object.keys(shipping)) assert.match(node('#checkoutContent').innerHTML, new RegExp(`name="${field}"`));
  assert.match(node('#checkoutContent').innerHTML, /Produto real/);
  assert.match(node('#checkoutContent').innerHTML, /0\.00000020/);
});
test('checkout double submit sends one request and awaits payment', async () => {
  const form = node('#checkoutForm');
  form.fieldValues = { ...shipping };
  x.state.checkoutStep = 'review';
  let finish;
  responses = [() => new Promise(resolve => { finish = resolve; })];
  const start = requests.length;
  const event = { preventDefault() {}, currentTarget: form };
  const first = x.submitCheckout(event);
  await x.submitCheckout(event);
  assert.equal(requests.length - start, 1);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), shipping);
  finish(response({ orders: [{ id: 88, reference: 'BL-088', payment_method: 'onchain_multisig', payment_address: 'bcrt1qfixture', total_btc: '0.00000020' }] }));
  await first;
  assert.equal(x.state.checkoutPending, false);
  assert.match(node('#checkoutContent').innerHTML, /Aguardando pagamento/);
  assert.match(node('#checkoutContent').innerHTML, /bcrt1qfixture/);
  assert.doesNotMatch(node('#checkoutContent').innerHTML, /Pagamento confirmado/);
});
test('checkout server error remains inline and keeps draft', async () => {
  const form = node('#checkoutForm');
  form.fieldValues = { ...shipping };
  x.state.checkoutStep = 'review';
  responses = [{ error: 'Estoque mudou. Revise carrinho.' }];
  await x.submitCheckout({ preventDefault() {}, currentTarget: form });
  assert.equal(node('#checkoutFeedback').textContent, 'Estoque mudou. Revise carrinho.');
  assert.deepEqual(plain(x.state.checkoutDraft), shipping);
  assert.equal(x.state.checkoutPending, false);
});
test('notification pages dedupe by id and use latest page length', async () => {
  x.state.activeView = 'account';
  x.state.notificationsLoading = false;
  const page = Array.from({ length: 50 }, (_, index) => ({ id: 100 - index, title: `Item ${index}`, body: '', read_at: null }));
  responses = [{ notifications: page, unread_count: 50 }, { notifications: [{ id: 51, title: 'Repeated' }, { id: 50, title: 'Older' }], unread_count: 51 }];
  await x.openNotifications();
  assert.equal(x.state.notificationsHasMore, true);
  assert.equal(x.state.notificationsCursor, 51);
  await x.openNotifications(51);
  assert.equal(x.state.notifications.length, 51);
  assert.equal(x.state.notificationsHasMore, false);
  assert.match(requests.at(-1).url, /before_id=51/);
  assert.match(node('#notificationsContent').innerHTML, /51 carregadas/);
});
test('notification read preserves loaded pages and confirms badge server-side', async () => {
  const length = x.state.notifications.length;
  responses = [{ message: 'Lida' }, { notifications: [], unread_count: 50 }];
  await x.markNotificationRead(50);
  assert.equal(x.state.notifications.length, length);
  assert.equal(Boolean(x.state.notifications.find(item => item.id === 50).read_at), true);
  assert.equal(x.state.unreadCount, 50);
});
test('treasury direct actions gated by RPC plus hot signing', () => {
  const data = { destinations: [{ id: 1, label: 'Reserva A', address: 'bcrt1qfixture', weight: 1, active: true }], wallet: { status: 'online', utxos: 2 } };
  x.config.btcMode = 'rpc';
  x.config.commissionSigningMode = 'psbt';
  const offline = x.treasurySection(data);
  assert.match(offline, /data-action="consolidate" disabled/);
  assert.match(offline, /data-action="distribute-reserves" disabled/);
  assert.match(offline, /Abrir PSBT de comissão/);
  assert.match(offline, /Prévia local — servidor confirma divisão e taxas/);
  x.config.commissionSigningMode = 'hot';
  const hot = x.treasurySection(data);
  assert.doesNotMatch(hot, /data-action="consolidate" disabled/);
  x.config.btcMode = 'demo';
  assert.match(x.treasurySection(data), /data-action="distribute-reserves" disabled/);
});
test('public key format feedback does not claim backend validation', () => {
  node('#profilePubkey').value = '02' + 'a'.repeat(64);
  x.updateProfileKeyFeedback();
  assert.match(node('#profileKeyFeedback').textContent, /Servidor valida chave ao salvar/);
  node('#profilePubkey').value = 'seed';
  x.updateProfileKeyFeedback();
  assert.match(node('#profileKeyFeedback').textContent, /4\/66/);
});
test('Como funciona reveals home before scroll without competing scrollTo', () => {
  const button = new Node();
  button.dataset.scroll = 'howItWorks';
  button.closestNodes.set('[data-scroll]', button);
  const section = node('#howItWorks');
  section.closestNodes.set('#homeView', node('#homeView'));
  x.state.activeView = 'account';
  context.lastScroll = null;
  handlers.get('click')({ target: button, preventDefault() {} });
  assert.equal(x.state.activeView, 'home');
  assert.equal(context.lastScroll, null);
  assert.equal(section.scrollOptions.block, 'start');
  assert.equal(document.activeElement, section);
});
test('session change wipes private state and ignores late inbox response', async () => {
  x.state.activeView = 'account';
  let finish;
  responses = [() => new Promise(resolve => { finish = resolve; })];
  const pending = x.openNotifications();
  x.state.checkoutDraft = { shipping_name: 'Previous account' };
  x.state.checkoutOrders = [{ id: 88 }];
  x.resetPrivateState();
  x.state.user = { ...user, id: 2 };
  finish(response({ notifications: [{ id: 999, title: 'Previous account data' }], unread_count: 10 }));
  await pending;
  assert.equal(x.state.checkoutDraft, null);
  assert.equal(x.state.checkoutOrders.length, 0);
  assert.equal(x.state.accountOrders.length, 0);
  assert.equal(x.state.notifications.length, 0);
  assert.equal(node('#notificationsContent').innerHTML, '');
});
test('template exposes standalone pages and last experience stylesheet', () => {
  const template = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  for (const id of ['checkoutView', 'checkoutContent', 'notificationsView', 'notificationsContent', 'accountTitle', 'accountDescription']) assert.match(template, new RegExp(`id="${id}"`));
  assert.ok(template.indexOf('css/experience.css') > template.indexOf('css/glass.css'));
  const ids = [...template.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Template IDs must be unique');
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`EXPERIENCE_FLOWS_OK ${tests.length}/${tests.length}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
