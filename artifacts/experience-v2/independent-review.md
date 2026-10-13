# Independent review

## Helper unit: BLOCKED

Objective: package current source against immutable 46-file checkpoint; restore only fixed disposable artifacts/experience-v2/rollback-test; preserve workspace and protected files; verify package, behavior, and rollback.

Restrictions: no production edits, no old-artifact edits, no final ZIP build, no live transactions, no browser interaction. Review received diff and contract only.

Reviewed helper SHA-256:
- build_release.py: 686C388F7451426FF1C1F84A9C732CDE7C7721171C515BDE088F4F063466D98C
- verify_release.py: D6AF55B3B031C63155EB1569261F67B77436BB49BF51E3F60E0CE9E0801C5C2F
- restore_release.py: 20FB6D39EF7FCB8A2946FE3DE5CDF7A6D0ED302F8B7FF939DB807A66B355BC6E
- ROLLBACK.sh: D9EA23E7F0AD165C952363C621A402FB30A25637754AB725B9D7CB6DA3DE1B23

### Blocking comments

1. [P1] Reject Windows directory junctions before any rollback write. verify_release.py:252-261 and build_release.py:149-160 only reject is_symlink(), while checked_rollback_target() accepts any resolved location under SCRIPT_DIR. Real temporary Windows junction rollback-test -> another-copy returned is_symlink=false; checked_rollback_target(), require_real_path(), and restore preflight accepted it; write_baseline() changed another-copy/README.md. This violates fixed disposable rollback target. Reject junction/reparse-point ancestors and require exact non-redirected fixed target before staging or restore writes.

2. [P2] Reject unpinned extra baseline files before baseline behavior checks. build_release.py:174-212 validates approved entries but never validates actual baseline inventory. Temporary copy of pinned baseline plus tests/test_unpinned_review.py still returned 46 approved paths. verify_release.py:222-241 traverses/discovers extra JavaScript/tests, so recorded baseline behavior can include files outside immutable checkpoint. Require exact baseline inventory, allowing only checkpoint metadata, before imports, static scans, JavaScript checks, or unit discovery.

### Executed evidence

Runtime: C:/Users/guell/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe

Command: Python -B artifacts/experience-v2/build_release.py --dry-run
Input: current workspace source and immutable baseline.
Output:
```text
DRY_RUN files=46 excluded=1 baseline_files=46
DRY_RUN baseline_sha256=CF4FCB515626282FC0D3E1A0CB84AA8DD0E61DDB6FD83E1567FDDAFC109D44E2
```
Exit: 0. No ZIP produced.

Command: Python -B artifacts/experience-v2/verify_release.py --smoke baseline --js --unit-tests
Input: immutable baseline; temporary SQLite; demo/off backend; fake RPC unit fixtures.
Output:
```text
BASELINE_OK GET/=200 GET/api/bootstrap=200 GET/api/products=200 STATIC_FILES=28 JS_PARSE_FILES=1 UNIT_TESTS=14 protected_unchanged=true isolated_database=true
```
Exit: 0.

Command: Python -B - (independent temporary guard harness; imports helper functions only)
Input: disposable temporary artifact/junction/sentinel and copied approved baseline source plus unpinned test sentinel.
Output:
```text
JUNCTION is_symlink=false
JUNCTION resolved_fixed_target=false
CHECKED_ROLLBACK_TARGET=ACCEPTED junction to another-copy
REQUIRE_REAL_PATH=ACCEPTED junction ancestor
RESTORE_PREFLIGHT=ACCEPTED junction target outside fixed directory
WRITES_ANOTHER_COPY=true
BASELINE_WITH_EXTRA=46 approved paths accepted despite unpinned test
TEMP_FIXTURE_CLEANED=true
```
Exit: 0. Fixture removed only after junction removal and absolute temporary-root containment check.

Final package, production frontend, and real rollback cycle remain unreviewed. No approval issued for current helper hashes.

## Visual stylesheet unit: BLOCKED

Reviewed SHA-256 static/css/experience.css: 61AF3F226074B837240DA5B599CC8B0A083288CEF0E4BF057B19FFCBCB4B01A5.

Objective: intentional cyan/glass experience, real topbar-to-hero spacing, readable responsive account/inbox/checkout/product/Bitcoin/treasury flows; preserve existing home/catalog/store/auth and all API/role/financial behavior.

### Blocking comments

1. [P2] Keep process-diagram text readable on mobile. experience.css:1989-2025 scales 760/800-unit SVGs to width:100% with 10px captions and 13px labels; mobile rules at 2706-2709 change margins only. At 320px viewport, available diagram width is approximately 252px, so Bitcoin captions render about 3.15px and labels 4.09px; at 390px captions remain about 4.03px. Current treasury and Bitcoin viewBoxes are 760x150 and 800x150. Provide mobile diagram layout or contained scrolling with readable unscaled text; no page overflow.

2. [P2] Match order-progress grid to five actual stages. experience.css:1248-1254 uses repeat(4, minmax(0, 1fr)), but current account renderer emits Pagamento, Pago, Preparacao, Enviado, Concluido. Final stage therefore wraps onto isolated second row at every desktop width. Define five-stage desktop layout and deliberate readable mobile layout rather than accidental wrap.

### Static evidence

- Current notificationsView includes both inbox-page and notifications-page; initial class-contract mismatch is resolved in latest template.
- experience.css loads after glass.css, dashboard.css, and base CSS.
- Higher-specificity hero margin:0 cancels previous negative margins. Content padding supplies 28px desktop and 18px mobile topbar gap.
- Minmax(0, 1fr), min-width:0, wrapping financial values, and contained table/nav scrolling guard major responsive grids.
- Focus-visible outline remains explicit; disabled, error, warning, success, and busy styles remain distinct.
- Reduced-motion rules disable new diagram animation; existing global reduced-motion rule covers other components.
- Only two asset URL references exist, both existing local blue-brush.webp. No fabricated content or third-party requests added by stylesheet.
- Brace inventory: 421 opening / 421 closing. Full browser render/overflow measurements belong to root; no UI used by reviewer.

No approval issued for current stylesheet hash.

## Helper repair review: PASS

Supersedes initial helper blockers. Reviewed helpers.patch SHA-256: 6706A62EFAAC8E4A58B7899FD26E195345BBB1518BA09324112E0CC7AF4CDEDC.

Approved helper SHA-256:
- build_release.py: 501416ACC8C53E2D5D48DEC83B792D390FE1F816A6F62D9AA7A1CE991097C898
- verify_release.py: B058A37ACB1EBB05C830B3A51987440DD538BE68229E4A3A05AD3DE244FD3FA1
- restore_release.py: 2968FFB611E94672DE9A7759B6E52F4279B94AB3AAB8CA73FBFDA447DEA1FAD0
- ROLLBACK.sh: D9EA23E7F0AD165C952363C621A402FB30A25637754AB725B9D7CB6DA3DE1B23
- helper_guard_tests.py: 6BF19A9E9EDC67AC932EE64E7B43EC5A9F4B3B2BB04C6EA6E9CC87D0F3FE7D30

Reviewed diff and guard-fixture source before execution. Real reparse-point checks now reject Windows junctions and ancestor redirects; rollback target is exact fixed path. Complete baseline inventory must equal 46 source paths plus two metadata files before behavior imports/scans/discovery.

Command: Python -B artifacts/experience-v2/helper_guard_tests.py
Output:
```text
Ran 4 tests in 2.467s
OK
JUNCTION_ANCESTORS_OK artifact_ancestor=blocked nested_destination=blocked
FIXED_TARGET_OK sibling_target=blocked
JUNCTION_GUARD_OK stage=blocked preflight=blocked write=blocked sentinel_unchanged=true
BASELINE_INVENTORY_OK files=46 metadata=2 extra_test=blocked extra_js=blocked extra_css=blocked imports=not_run scans=not_run discovery=not_run
```
Exit: 0. Temporary fixtures cleaned; baseline unchanged.

Command: Python -B artifacts/experience-v2/build_release.py --dry-run
Output:
```text
DRY_RUN files=48 excluded=1 baseline_files=46
DRY_RUN baseline_sha256=CF4FCB515626282FC0D3E1A0CB84AA8DD0E61DDB6FD83E1567FDDAFC109D44E2
```
Exit: 0. New stylesheet and frontend tests enter allowed source inventory. No ZIP built. Final archive and rollback execution remain root integration checks after source freeze.

## Production flow security/contracts review: BLOCKED (final hash pending)

Reviewed submitted flows.patch SHA-256: A63CAD98363C6399475565755DCBEBBDDCAFAD163DACC7E4DAFB82C0C470EA29. Latest user revision is editing help-page/inbox/quantity polish; final source-hash approval is held until updated diff arrives.

### Blocking comment

1. [P1] Apply session epoch to private PSBT downloads too. static/js/bitloja.js:67-80 rejects late JSON API responses after resetPrivateState(), but download():88-104 calls fetch directly and always creates/clicks its download link after response/blob await. Commission, wallet, and order PSBT actions all use this helper. Independent deferred-response fixture started download for user 1, reset private state, switched to user 2, then resolved old response; old private PSBT still triggered download. Capture initiating session and reject stale responses before producing any Blob URL/link/download, including a session change during blob reading; add regression tests. Preserve endpoint paths, CSRF headers, filenames, and server authorization.

### Evidence

Command: Node --check static/js/bitloja.js
Exit: 0.

Command: Node tests/experience_flows.test.cjs
Output: EXPERIENCE_FLOWS_OK 15/15
Exit: 0. All fetches are deterministic VM fixtures; no browser or network transactions.

Command: Node - (independent extension of reviewed VM fixture, exposing download; deferred synthetic PSBT and API responses)
Output:
```text
LATE_PRIVATE_DOWNLOAD clicks=1 current_user=2
LATE_API_RESPONSE=BLOCKED
```
Exit: 0. Fake link click only; no real file download or financial call.

Reviewed checkout payload field names against existing endpoint, read/read-all notification endpoints and pagination, role gates, CSRF handling, runtime capability gates, critical confirmation phrases, integer-satoshi allocation and backend floor/remainder algorithm. Existing financial backend/schemas were not modified. No additional contract blocker found in submitted diff. Latest help-page revision and final stylesheet fixes remain pending independent review.
