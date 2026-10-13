# BitLoja — design QA

## Evidence
- Source: `C:/Users/guell/AppData/Local/Temp/codex-clipboard-fd810069-9f05-4ea0-9b93-f3705c1c5dd0.png`
- Initial capture: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/home-initial.jpg`
- Combined comparison: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/home-comparison-initial.jpg`
- Browser: Codex in-app browser; target viewport 1672 × 941 CSS pixels.
- Local preview: `http://127.0.0.1:5005/`; isolated demonstration database.

## Findings — initial pass
- [P1] Header composition differs. Reference uses one row with brand, navigation, search icon, login and store CTA. Implementation uses a wide search field and a second navigation row. Restore reference hierarchy.
- [P1] Hero image is too large and clipped below the viewport. Reference shows the entire bag and its shadow. Fit the complete object in the right-hand region.
- [P2] Hero CTAs are horizontal instead of stacked; extra paragraph displaces them. Stack 372-pixel buttons and remove the unrequested paragraph from this composition.
- [P2] Eyebrow is a single horizontal line instead of two text lines with a rule below. Match the reference treatment.
- [P2] Circular background shape is absent from the reference. Remove it; retain the generated brush asset.
- [P2] Brand icon has an extra rounded enclosure. Remove the enclosure.
- [P2] Handwritten annotation is small monospaced type. Use an appropriate local handwritten font and the reference placement.

## Required fidelity surfaces
- Typography: headline family and four-line wrapping are close; annotation and eyebrow need changes.
- Spacing/layout: header, bag bounds and CTA arrangement need changes listed above.
- Colors/tokens: cyan-blue, white and navy direction matches; remove the unrelated translucent circle.
- Image quality: five generated WebP assets have real alpha and intentional blue/crystal material. All are below 320 KB. Hero composition still needs correction.
- Copy/content: keep actual catalog data and actual counts; do not copy fabricated reference metrics or verification claims.

## Interaction verification
- Pending completion of the external frontend script and final backend integration.
- Final desktop/mobile captures and console checks remain pending.

## Continuation — admin, seller and authentication

- Request: rebuild the admin, seller, login and registration presentation while retaining working APIs and financial controls.
- Sources: supplied admin and seller references at 1672 × 941; authentication inherits their blue/white/navy palette and local typography. No authentication mock was supplied.
- Before evidence: `artifacts/redesign/screenshots/admin-before.jpg`, `seller-pass1.jpg`, and `login-before.jpg`.
- [P1] Dashboard repeats marketplace header above its own sidebar and topbar. Remove duplicate chrome in dashboard mode.
- [P1] Dashboard uses a generic boxed hero and oversized KPI cards instead of the reference's editorial heading and compact operational composition.
- [P1] Panel section rules override padding; titles touch edges and tables lack readable hierarchy.
- [P1] Authentication has browser-default submit/close controls and no designed visual hierarchy, inline error, pending state or password visibility control.
- [P2] Dashboard mobile navigation and authentication keyboard/focus behavior require explicit verification after changes.
- Existing isolated backend suite: 14 tests passed independently; final UI and rollback verification remain pending.

## Final continuation verification — 2026-10-12

The initial findings above are historical. The final verdict below covers admin, seller, login, registration, order-detail modals and the cart regression repaired during this continuation.

### Visual evidence
- Admin: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/admin-final.jpg` and `admin-mobile-final.jpg` in the same directory.
- Seller: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/seller-final.jpg` and `seller-mobile-final.jpg`.
- Authentication: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/login-final.jpg`, `register-final.jpg`, `login-mobile-final.jpg`, `register-mobile-final.jpg`.
- Cart: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/cart-final.jpg` and `cart-mobile-final.jpg`.
- Order details: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/order-desktop-final.jpg`, `order-mobile-final.jpg`, `order-mobile-history-final.jpg`.
- Combined comparisons: `C:/Users/guell/Desktop/Nova pasta/BitLoja/artifacts/redesign/screenshots/admin-comparison-final.jpg`, `seller-comparison-final.jpg`, `auth-comparison-final.jpg`, `cart-comparison-final.jpg`.
- Comparison canvases are 3344 × 981: two explicitly resized 1672 × 941 panels plus a 40-pixel label strip. Capture dimensions vary with the browser surface; these are composition comparisons, not pixel-difference measurements.

### Fidelity surfaces
- Typography: local Archivo headlines use the reference's white/navy hierarchy; local monospaced labels separate operational information. Dashboard secondary tabs use compact headings instead of repeating the full hero.
- Layout: one sidebar and one topbar replace duplicated marketplace chrome. Compact live metrics sit below editorial headings and transparent artwork; navy panels contain orders, stock, disputes and working shortcuts. Mobile navigation scrolls horizontally; wide tables scroll inside their own containers.
- Color: bright Bitcoin-blue, navy and white follow the supplied direction. Hero blue is `#0092df`; white large text contrast is 3.40:1. Small hero labels use `#001039`, with 5.45:1 contrast. Authentication uses a darker blue panel for readable white copy.
- Assets: generated bag, parcel, cart, crystal and brush WebP assets retain real alpha, with measured alpha extrema 0–255 and individual sizes below 320 KB. Text remains HTML. Seller stock images load successfully using actual catalog URLs or the existing local product mapping.
- Content: counts, balances, stock and statuses come from APIs against an isolated demo database. Empty disputes, batches and notifications display explicit empty states. The reference's sample growth graphs, promotional verification claims and invented counts are replaced by available operational data. This is a faithful visual direction with deliberate data-driven differences, rather than a pixel-identical claim.

### Root browser checks
- Desktop target: 1672 × 941 CSS pixels. Mobile target: 390 × 844. Mobile document width measured 375 CSS pixels including the browser's scrollbar layout; no page-level horizontal overflow.
- Buyer registration succeeded with a synthetic local account. Login succeeded for buyer, seller and administrator fixtures. Pending forms disabled inputs and submission; invalid login produced `E-mail ou senha inválidos.` and re-enabled submission.
- Authentication tabs respond to ArrowLeft/ArrowRight/Home/End. Password visibility toggles. Escape closes the dialog and restores focus to `accountBtn`. Brand navigation closes authentication and returns to the marketplace.
- Admin tabs opened overview, settlements, treasury, disputes, users/stores and audit. Seller tabs opened overview, products, orders and store settings. Product forms, tables and action buttons remain available in the redesigned shell.
- Seller updated the funded test order from paid → preparing → shipped with carrier/code and notes. Administrator updated shipped → completed. History retained all three events; underlying dashboard status refreshed immediately after each saved update.
- Buyer order details displayed the same completed state and tracking history without an update form. Desktop and mobile modal buttons, labels and public-key wrapping were checked. Mobile modal scroll width equalled client width (326 pixels).
- Final modal focus regression checks passed: Details → loading → loaded → Escape restored the original `open-order` Details button; Details → Manage PSBT → Close restored the same button. These checks did not create or broadcast a PSBT.
- Demo wallet setup and write controls are replaced by an explicit demo-state message. Bitcoin Core functionality was exercised separately by the regtest smoke test.
- Cart test used two stores: 2 items = 0.00324000 BTC; increment = 3 items / 0.00423000 BTC; decrement restored 2; removal left 1 item / 0.00099000 BTC. Checkout navigation opened the existing form. Mobile quantity, price, remove and summary remained within the viewport.
- Admin notification dialog displayed `0 não lidas`, an honest empty state and disabled read-all. Earlier notification read state persisted during the local order flow.
- Browser console check after these flows returned no error or warning entries.

### Automated evidence
- Root isolated unit run: `& 'C:/Users/guell/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' -m unittest discover -s tests -q`; 14 tests in 28.357 s, `OK`, exit 0.
- Root JavaScript parse: `node --check static/js/bitloja.js`, exit 0.
- Root Bitcoin Core 28 regtest smoke: setup 201; authenticated route 401 → 200; own receiving address; transfer 201; external signing complete; signed submission 200; broadcast 200; create/broadcast retries returned the same transfer/transaction. `test_bypassed_sighash_check=false`; exit 0.
- Core fixture advanced from height 202 to 303 during that test and was shut down afterward. Local demo preview remains on `http://127.0.0.1:5005/`.

### Account routes and checkout follow-up — 2026-10-12
- Administrator account menu opened `Meus pedidos`, `Carteira` and `Pagamentos Bitcoin`; active destinations were respectively `accountContent`, `walletContent` and `custodyContent`, each visible.
- Demo checkout created order `BTC-261012-F4FF9E` with status `AGUARDANDO PAGAMENTO`. `Ver meus pedidos` opened `accountContent`; dialog was closed and destination visible.
- Order was created only in fixture `preview.db`; no payment occurred.
- Browser console errors and warnings: `[]`.

final result: passed

## Glass continuation — mobile layout QA

This section records the later glass-layer pass; earlier navy dashboard captures and comparison canvases above are historical, not evidence for the current glass appearance.

- 320 px admin wallet: document width 320 px; content width 286 px; sidebar 140.5 px.
- 320 px custody: document width 320 px; protocol content width 286 px.
- 390 px wallet: document width 375 px including browser scrollbar layout; metrics use two 166 px columns.
- 390 px custody: document width 375 px; protocol content width 341 px; horizontal navigation scroll width 1008 px and client width 343 px, allowing the full nav to remain reachable without page overflow.
- All admin/seller financial screens at 320/390 px: root reports no page overflow and correct role/view identity. Document widths were 320/375 px; no separate seller-mobile screenshot is saved yet.
- Buyer wallet keeps marketplace chrome: sidebar hidden, header visible.
- Screenshots: `artifacts/redesign/screenshots/wallet-320-glass-final.jpg`, `custody-320-glass-final.jpg`, `wallet-mobile-glass-final.jpg`, and `custody-mobile-glass-final.jpg`.
- Root reports these observed viewport/layout checks passed. Seller-specific mobile screenshots remain unavailable; desktop comparison canvases are now saved.

The previous white-on-glass hero contrast measurement belongs to the earlier styling pass. Current CSS uses navy hero headings; do not carry the old ratio forward as a current measurement.

Current glass desktop evidence: `admin-glass-final.jpg`, `seller-glass-final.jpg`, `wallet-glass-final.jpg`, `custody-glass-final.jpg`, `treasury-glass-final.jpg`, `stores-glass-final.jpg`, and `home-glass-final.jpg` under `artifacts/redesign/screenshots/`.
- Comparisons: `admin-glass-comparison-final.jpg` pairs the supplied admin reference with the current glass capture; `seller-glass-comparison-final.jpg` does the same for seller; `glass-mobile-comparison-final.jpg` places wallet/custody screenshots at 320/390 px together. These canvases preserve source pixels and pad panels; no resizing or pixel-difference claim.
- Root accepts the current desktop composition/contrast. Desktop captures appear soft across the viewport; root reports no active DOM filters. Treat comparisons as composition review, not pixel-fidelity evidence.
- Actual image files: admin glass 1672 × 941 px; seller, wallet and custody glass captures 1657 × 933 px. Mobile screenshot files are 305 × 804 px (320 target) and 375 × 812 px (390 target).
- Admin shortcut Enter opened `Usuários e lojas` with visible button focus and `adminView`. Seller Orders shortcut Enter also focused the visible button and opened seller role view.
- Cart at 390 px: document width 375 px. Quantity increment produced 0.00198000 BTC; decrement restored 0.00099000 BTC, matching API values. Console errors/warnings were `[]`. `cart-mobile-glass-final.jpg` and `cart-empty-mobile-glass-final.jpg` were recaptured after the glass fix. `Continuar comprando` now has translucent white `.42` background and ink `#001445`; root reloaded and confirmed visible. `Explorar produtos` remains white on `#006da8` and passed. No checkout/payment was initiated in this latest cart pass.
- Read-only source check found no global filter/transform/opacity rule on seller view; glass backdrop filters remain scoped to surfaces.
