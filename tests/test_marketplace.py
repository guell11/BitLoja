"""Isolated API, migration, transaction and ownership tests for marketplace features."""

import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

_TEST_ROOT = tempfile.TemporaryDirectory(prefix="bitloja-marketplace-tests-")
os.environ.update({
    "DATABASE_PATH": str(Path(_TEST_ROOT.name) / "initial.sqlite3"),
    "BTC_MODE": "rpc",
    "BTC_NETWORK": "regtest",
    "ALLOW_MAINNET": "0",
    "CUSTODY_MODE": "multisig",
    "LN_MODE": "off",
    "ENABLE_DEMO_SEED": "0",
    "ENABLE_LIGHTNING_POLLER": "0",
    "APP_SECRET": "test-app-secret-012345678901234567890123",
    "ADMIN_ACTION_KEY": "test-admin-action-key-0123456789012345",
    "BTC_RPC_PASSWORD": "test-rpc-password-0123456789",
    "BTC_RPC_USER": "test-user",
    "MIN_CONFIRMATIONS": "1",
    "PSBT_FEE_RATE": "2",
})

import app as app_module
from marketplace_features import MarketplaceFeatures, notify_user
import marketplace_features
from werkzeug.security import generate_password_hash


PASSWORD = "correct-horse-battery"
PUBKEY = app_module.demo_pubkey(100)
DESTINATION = "bcrt1q" + "2" * 38
XPUB_A = "tpub" + "1" * 90
XPUB_B = "tpub" + "2" * 90
DEFAULT_PAID_AT = object()


def descriptor(xpub, branch):
    fingerprint = "deadbeef" if xpub == XPUB_A else "decafbad"
    return f"wpkh([{fingerprint}/84h/1h/0h]{xpub}/{branch}/*)"


class FakeCore:
    """Small Bitcoin Core RPC fixture; all funds and txids exist only in test memory."""

    def __init__(self):
        self.wallets = set()
        self.addresses = {}
        self.address_counter = 0
        self.psbts = {}
        self.raw_transactions = {}
        self.funded_count = 0
        self.locked = set()
        self.mempool = set()
        self.wallet_transactions = {}
        self.txid = "f" * 64
        self.input_txid = "a" * 64
        self.input_sats = 2_000_000
        self.fee_sats = 417
        self.same_input = True
        self.calls = []
        self.reject_mempool = False

    def rpc(self, wallet_name=None):
        core = self

        class RPC:
            def call(self, method, params=None):
                return core.call(method, params or [], wallet_name)

        return RPC()

    def _address(self, wallet):
        self.address_counter += 1
        address = "bcrt1q" + f"{self.address_counter:038d}"
        self.addresses[address] = wallet
        return address

    def _tx_output(self, address, sats):
        script = "0014" + hashlib.sha256(address.encode()).hexdigest()[:40]
        return {"value": f"{Decimal(sats) / Decimal(100_000_000):.8f}",
                "scriptPubKey": {"hex": script, "address": address, "addresses": [address]}}

    def call(self, method, params, wallet_name=None):
        self.calls.append((method, copy.deepcopy(params), wallet_name))
        if method == "getblockchaininfo":
            return {"chain": "regtest"}
        if method == "listwallets":
            return sorted(self.wallets)
        if method == "listwalletdir":
            return {"wallets": [{"name": item} for item in sorted(self.wallets)]}
        if method == "createwallet":
            if not isinstance(params, dict):
                raise AssertionError("createwallet must use named parameter object")
            if not (params.get("blank") and params.get("disable_private_keys") and params.get("descriptors")):
                raise AssertionError("wallet must be blank, descriptor-based and watch-only")
            name = params["wallet_name"]
            self.wallets.add(name)
            return {"name": name, "warning": ""}
        if method == "loadwallet":
            self.wallets.add(params[0])
            return {"name": params[0], "warning": ""}
        if method == "getdescriptorinfo":
            desc = params[0]
            private = any(token in desc.lower() for token in ("xprv", "tprv", "yprv", "zprv"))
            return {"descriptor": desc, "checksum": "fixture", "hasprivatekeys": private,
                    "isrange": "/*" in desc, "issolvable": True}
        if method == "importdescriptors":
            return [{"success": True} for _ in params[0]]
        if method == "getnewaddress":
            return self._address(wallet_name)
        if method == "getrawchangeaddress":
            return self._address(wallet_name)
        if method == "getaddressinfo":
            address = params[0]
            owned = address in self.addresses and self.addresses[address] == wallet_name
            return {"ismine": owned, "pubkey": app_module.demo_pubkey(100 + len(self.addresses)) if owned else ""}
        if method == "validateaddress":
            return {"isvalid": params[0].startswith("bcrt1q")}
        if method == "getbalances":
            return {"mine": {"trusted": "0.02500000", "untrusted_pending": "0.00100000"}, "watchonly": {}}
        if method == "lockunspent":
            unlock = bool(params[0])
            for outpoint in (params[1] if len(params) > 1 else []):
                key = (outpoint["txid"], int(outpoint["vout"]))
                if unlock:
                    self.locked.discard(key)
                else:
                    self.locked.add(key)
            return True
        if method == "walletcreatefundedpsbt":
            self.funded_count += 1
            if not (params[3].get("includeWatching") and params[3].get("lockUnspents")
                    and params[3].get("minconf", 0) >= 1 and "subtractFeeFromOutputs" not in params[3]):
                raise AssertionError("funding request must be confirmed, locked and exact-output")
            destination, amount_btc = next(iter(params[1][0].items()))
            amount = int(Decimal(str(amount_btc)) * Decimal(100_000_000))
            change = params[3]["changeAddress"]
            input_txid = self.input_txid if self.same_input else f"{self.funded_count:064x}"
            input_sats = self.input_sats
            change_sats = input_sats - amount - self.fee_sats
            tx = {"version": 2, "locktime": 0, "vin": [{"txid": input_txid, "vout": 0, "sequence": 0xFFFFFFFD}],
                  "vout": [self._tx_output(destination, amount), self._tx_output(change, change_sats)]}
            inputs = [{"witness_utxo": {"amount": f"{Decimal(input_sats) / Decimal(100_000_000):.8f}",
                                         "scriptPubKey": {"hex": "0014" + "a" * 40}}}]
            psbt = f"psbt-original-{self.funded_count}"
            self.psbts[psbt] = {"tx": tx, "inputs": inputs}
            self.locked.add((input_txid, 0))
            return {"psbt": psbt, "fee": f"{Decimal(self.fee_sats) / Decimal(100_000_000):.8f}", "changepos": 1}
        if method == "decodepsbt":
            if params[0] not in self.psbts:
                raise ValueError("Unknown PSBT")
            return copy.deepcopy(self.psbts[params[0]])
        if method == "combinepsbt":
            originals = params[0]
            merged = copy.deepcopy(self.psbts[originals[0]])
            supplied = self.psbts[originals[-1]]
            merged["inputs"] = copy.deepcopy(supplied["inputs"])
            token = f"psbt-combined-{len(self.psbts)}"
            self.psbts[token] = merged
            return token
        if method == "finalizepsbt":
            source = copy.deepcopy(self.psbts[params[0]])
            raw_hex = f"raw-{len(self.raw_transactions) + 1}"
            raw = copy.deepcopy(source["tx"])
            raw["txid"] = self.txid
            self.raw_transactions[raw_hex] = raw
            return {"complete": True, "hex": raw_hex}
        if method == "decoderawtransaction":
            return copy.deepcopy(self.raw_transactions[params[0]])
        if method == "testmempoolaccept":
            return [{"allowed": not self.reject_mempool, "reject-reason": "fixture rejection" if self.reject_mempool else ""}]
        if method in {"getmempoolentry", "getrawtransaction"}:
            if params[0] not in self.mempool:
                raise ValueError("No such mempool transaction")
            return {"txid": params[0]}
        if method == "gettransaction":
            if params[0] not in self.wallet_transactions:
                raise ValueError("Wallet transaction not found")
            return copy.deepcopy(self.wallet_transactions[params[0]])
        if method == "sendrawtransaction":
            if params[0] not in self.raw_transactions:
                raise ValueError("Unknown raw transaction")
            if self.txid in self.mempool:
                raise ValueError("already in mempool")
            self.mempool.add(self.txid)
            self.wallet_transactions[self.txid] = {"txid": self.txid, "confirmations": 0, "abandoned": False, "walletconflicts": []}
            return self.txid
        if method == "gettxout":
            return {"value": f"{Decimal(self.input_sats) / Decimal(100_000_000):.8f}"}
        raise AssertionError(f"Unexpected Bitcoin RPC method: {method}")


class MarketplaceBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bitloja-case-")
        app_module.DATABASE_PATH = Path(self.temp.name) / "case.sqlite3"
        app_module.init_db()
        app_module.app.config["TESTING"] = True
        self.features = app_module.app.extensions["marketplace_features"]
        self.core = FakeCore()
        self.features.rpc_factory = self.core.rpc
        with marketplace_features._reauth_lock:
            marketplace_features._reauth_attempts.clear()
        self.password_hash = generate_password_hash(PASSWORD)
        with app_module.app.app_context():
            db = app_module.get_db()
            self.ids = {}
            for role, email in (("buyer", "buyer1@test.invalid"), ("buyer", "buyer2@test.invalid"),
                                ("seller", "seller1@test.invalid"), ("seller", "seller2@test.invalid"),
                                ("admin", "admin@test.invalid")):
                cur = db.execute("INSERT INTO users(name,email,password_hash,role,active,created_at,bitcoin_pubkey) VALUES(?,?,?,?,1,?,?)",
                                 (email.split("@")[0], email, self.password_hash, role, app_module.now_iso(), app_module.demo_pubkey(100 + len(self.ids) + 1)))
                self.ids[email] = cur.lastrowid
            seller_id = self.ids["seller1@test.invalid"]
            cur = db.execute("INSERT INTO stores(owner_id,name,slug,payout_address,active,created_at,escrow_pubkey) VALUES(?,?,?,?,1,?,?)",
                             (seller_id, "Test Store", "test-store", DESTINATION, app_module.now_iso(), PUBKEY))
            self.store_id = cur.lastrowid
            cur = db.execute("INSERT INTO products(store_id,name,short_description,description,category,price_sats,stock,active,created_at) VALUES(?,?,?,?,?,100000,20,1,?)",
                             (self.store_id, "Test item", "short", "description", "Test", app_module.now_iso()))
            self.product_id = cur.lastrowid
            db.commit()
        self.clients = {}
        self.csrf = {}
        for email, user_id in self.ids.items():
            client = app_module.app.test_client()
            token = f"csrf-{user_id}-token"
            with client.session_transaction() as session:
                session["user_id"] = user_id
                session["csrf_token"] = token
            self.clients[email] = client
            self.csrf[email] = token

    def tearDown(self):
        self.temp.cleanup()

    def post(self, email, path, body=None, csrf=True):
        headers = {"X-CSRF-Token": self.csrf[email]} if csrf else {}
        return self.clients[email].post(path, json=body, headers=headers)

    def add_wallet(self, email, xpub=XPUB_A):
        body = {"password": PASSWORD, "descriptor": descriptor(xpub, 0),
                "change_descriptor": descriptor(xpub, 1)}
        return self.post(email, "/api/wallet/setup", body)

    def add_order(self, *, status="paid", buyer="buyer1@test.invalid", paid_sats=100000,
                  total_sats=100000, confirmations=1, paid_at=DEFAULT_PAID_AT, refund_txid="", product_id=None,
                  payment_method="onchain_multisig", lightning_status=""):
        with app_module.app.app_context():
            db = app_module.get_db()
            cur = db.execute(
                """INSERT INTO orders(buyer_id,store_id,reference,status,payment_address,total_sats,platform_fee_sats,
                       seller_net_sats,paid_sats,confirmations,paid_at,refund_txid,payment_method,lightning_status,
                       shipping_name,shipping_address,shipping_city,shipping_state,shipping_zip,created_at,updated_at)
                   VALUES(?,?,?,?,'bcrt1qfixture',?,?,?,?,?,?,?,?,?,'Test Buyer','Street','City','ST','00000',?,?)""",
                (self.ids[buyer], self.store_id, f"ORD-{threading.get_ident()}-{len(db.execute('SELECT id FROM orders').fetchall())}",
                 status, total_sats, 0, total_sats, paid_sats, confirmations,
                 app_module.now_iso() if paid_at is DEFAULT_PAID_AT else paid_at,
                 refund_txid, payment_method, lightning_status, app_module.now_iso(), app_module.now_iso()),
            )
            order_id = cur.lastrowid
            db.execute("INSERT INTO order_items(order_id,product_id,product_name,unit_price_sats,quantity) VALUES(?,?,?,?,1)",
                       (order_id, product_id or self.product_id, "Test item", total_sats))
            db.commit()
            return order_id

    def test_csrf_and_json_object_validation(self):
        no_csrf = self.clients["seller1@test.invalid"].post("/api/wallet/transfers", json=[])
        self.assertEqual(no_csrf.status_code, 403)
        bad_shape = self.post("seller1@test.invalid", "/api/wallet/transfers", [], csrf=True)
        self.assertEqual(bad_shape.status_code, 400)
        self.assertIn("Cache-Control", bad_shape.headers)
        self.assertEqual(bad_shape.headers["Cache-Control"], "no-store")

    def test_wallet_setup_isolation_unique_keys_and_addresses(self):
        one = self.add_wallet("seller1@test.invalid")
        two = self.add_wallet("seller2@test.invalid", XPUB_B)
        self.assertEqual(one.status_code, 201, one.get_json())
        self.assertEqual(two.status_code, 201, two.get_json())
        address_one = one.get_json()["wallet"]["address"]
        address_two = two.get_json()["wallet"]["address"]
        self.assertNotEqual(address_one, address_two)
        self.assertEqual(self.add_wallet("buyer1@test.invalid").status_code, 409)
        seller_view = self.clients["seller1@test.invalid"].get("/api/wallet").get_json()
        other_view = self.clients["seller2@test.invalid"].get("/api/wallet").get_json()
        self.assertEqual(seller_view["wallet"]["address"], address_one)
        self.assertNotEqual(other_view["wallet"]["address"], address_one)
        self.assertEqual(seller_view["wallet"]["confirmed_btc"], "0.02500000")
        with app_module.app.app_context():
            db = app_module.get_db()
            self.assertEqual(db.execute("SELECT COUNT(DISTINCT address) FROM wallet_addresses").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM user_wallets").fetchone()[0], 2)

    def test_descriptor_private_material_rejected(self):
        private = "xprv" + "1" * 90
        response = self.post("buyer1@test.invalid", "/api/wallet/setup", {
            "password": PASSWORD, "descriptor": descriptor(private, 0), "change_descriptor": descriptor(private, 1)
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len([call for call in self.core.calls if call[0] == "getdescriptorinfo"]), 0)

    def test_reauth_throttle_blocks_repeated_password_guesses(self):
        body = {"password": "wrong", "descriptor": descriptor(XPUB_A, 0),
                "change_descriptor": descriptor(XPUB_A, 1)}
        statuses = [self.post("seller1@test.invalid", "/api/wallet/setup", body).status_code for _ in range(8)]
        self.assertEqual(statuses, [403] * 8)
        body["password"] = PASSWORD
        locked = self.post("seller1@test.invalid", "/api/wallet/setup", body)
        self.assertEqual(locked.status_code, 403)

    def test_legacy_review_migration_is_idempotent_and_preserves_row(self):
        legacy_path = Path(self.temp.name) / "legacy.sqlite3"
        db = sqlite3.connect(legacy_path)
        db.row_factory = sqlite3.Row
        db.executescript("""
            CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE stores(id INTEGER PRIMARY KEY);
            CREATE TABLE products(id INTEGER PRIMARY KEY, store_id INTEGER);
            CREATE TABLE orders(id INTEGER PRIMARY KEY, buyer_id INTEGER, store_id INTEGER, status TEXT,
                paid_sats INTEGER, total_sats INTEGER, paid_at TEXT, payment_method TEXT,
                lightning_status TEXT, confirmations INTEGER, refund_txid TEXT);
            CREATE TABLE order_items(order_id INTEGER, product_id INTEGER);
            CREATE TABLE reviews(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, buyer_id INTEGER,
                store_id INTEGER, rating INTEGER, title TEXT, comment TEXT, created_at TEXT);
            INSERT INTO reviews VALUES(41,9,7,3,2,5,'Legacy','Kept','2026-01-01T00:00:00+00:00');
        """)
        app_module.init_marketplace_schema(db, 3)
        app_module.init_marketplace_schema(db, 3)
        row = db.execute("SELECT id,rating,title,purchase_verified FROM reviews WHERE id=41").fetchone()
        self.assertEqual(tuple(row), (41, 5, "Legacy", 0))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='wallet_transfers'").fetchone()[0], 1)
        db.close()

    def test_transfer_idempotency_ownership_and_fees(self):
        self.assertEqual(self.add_wallet("seller1@test.invalid").status_code, 201)
        first = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.00100000", "password": PASSWORD,
            "idempotency_key": "withdrawal-key-0001"})
        self.assertEqual(first.status_code, 201, first.get_json())
        transfer = first.get_json()["transfer"]
        self.assertEqual(transfer["fee_btc"], "0.00000417")
        create_call = next(params for method, params, _ in self.core.calls if method == "walletcreatefundedpsbt")
        self.assertTrue(create_call[3]["includeWatching"])
        self.assertTrue(create_call[3]["lockUnspents"])
        self.assertNotIn("subtractFeeFromOutputs", create_call[3])
        same = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.00100000", "password": PASSWORD,
            "idempotency_key": "withdrawal-key-0001"})
        self.assertEqual(same.status_code, 200)
        self.assertEqual(same.get_json()["transfer"]["id"], transfer["id"])
        conflict = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": "bcrt1q" + "3" * 38, "amount_btc": "0.00100000", "password": PASSWORD,
            "idempotency_key": "withdrawal-key-0001"})
        self.assertEqual(conflict.status_code, 409)
        bad_fee_amount = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "NaN", "password": PASSWORD,
            "idempotency_key": "withdrawal-key-0002"})
        self.assertEqual(bad_fee_amount.status_code, 400)
        wrong_password = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.001", "password": "wrong",
            "idempotency_key": "withdrawal-key-0003"})
        self.assertEqual(wrong_password.status_code, 403)
        foreign = self.clients["seller2@test.invalid"].get(f"/api/wallet/transfers/{transfer['id']}/download")
        self.assertEqual(foreign.status_code, 404)
        own = self.clients["seller1@test.invalid"].get(f"/api/wallet/transfers/{transfer['id']}/download")
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.data.decode(), transfer["psbt"])
        duplicate_input = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.001", "password": PASSWORD,
            "idempotency_key": "withdrawal-key-0004"})
        self.assertEqual(duplicate_input.status_code, 409)

    def test_transfer_signed_rejects_body_and_signature_tamper(self):
        self.assertEqual(self.add_wallet("seller1@test.invalid").status_code, 201)
        created = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.001", "password": PASSWORD,
            "idempotency_key": "signed-key-0001"})
        transfer = created.get_json()["transfer"]
        original_token = transfer["psbt"]
        original = self.core.psbts[original_token]
        tampered_output = copy.deepcopy(original)
        tampered_output["tx"]["vout"][0] = self.core._tx_output("bcrt1q" + "4" * 38, 100000)
        self.core.psbts["tampered-output"] = tampered_output
        rejected = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/signed", {"psbt": "tampered-output"})
        self.assertEqual(rejected.status_code, 409)
        tampered_sig = copy.deepcopy(original)
        tampered_sig["inputs"][0]["partial_signatures"] = {PUBKEY: "30010102"}
        self.core.psbts["tampered-sighash"] = tampered_sig
        rejected = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/signed", {"psbt": "tampered-sighash"})
        self.assertEqual(rejected.status_code, 409)
        good = copy.deepcopy(original)
        good["inputs"][0]["partial_signatures"] = {PUBKEY: "300101"}
        self.core.psbts["signed-good"] = good
        signed = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/signed", {"psbt": "signed-good"})
        self.assertEqual(signed.status_code, 200, signed.get_json())
        self.assertEqual(signed.get_json()["transfer"]["status"], "ready_to_broadcast")
        cancelled = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/cancel", {"password": PASSWORD})
        self.assertEqual(cancelled.status_code, 409)

    def test_transfer_cancel_cas_and_reservation_release(self):
        self.assertEqual(self.add_wallet("seller1@test.invalid").status_code, 201)
        created = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.001", "password": PASSWORD,
            "idempotency_key": "cancel-key-0001"})
        transfer = created.get_json()["transfer"]
        self.assertIn((self.core.input_txid, 0), self.core.locked)
        cancelled = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/cancel", {"password": PASSWORD})
        self.assertEqual(cancelled.status_code, 200, cancelled.get_json())
        self.assertEqual(cancelled.get_json()["transfer"]["status"], "cancelled")
        self.assertNotIn((self.core.input_txid, 0), self.core.locked)
        signed = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/signed", {"psbt": "signed-good"})
        self.assertEqual(signed.status_code, 409)
        again = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/cancel", {"password": PASSWORD})
        self.assertEqual(again.status_code, 200)

    def test_broadcast_reauth_confirmation_and_recovery_are_idempotent(self):
        self.assertEqual(self.add_wallet("seller1@test.invalid").status_code, 201)
        created = self.post("seller1@test.invalid", "/api/wallet/transfers", {
            "destination": DESTINATION, "amount_btc": "0.001", "password": PASSWORD,
            "idempotency_key": "broadcast-key-0001"})
        transfer = created.get_json()["transfer"]
        good = copy.deepcopy(self.core.psbts[transfer["psbt"]])
        good["inputs"][0]["partial_signatures"] = {PUBKEY: "300101"}
        self.core.psbts["broadcast-signed"] = good
        signed = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/signed", {"psbt": "broadcast-signed"})
        self.assertEqual(signed.status_code, 200)
        wrong = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": "bad", "confirm": "ENVIAR BTC"})
        self.assertEqual(wrong.status_code, 403)
        no_confirm = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": PASSWORD, "confirm": "send"})
        self.assertEqual(no_confirm.status_code, 400)
        broadcast = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": PASSWORD, "confirm": "ENVIAR BTC"})
        self.assertEqual(broadcast.status_code, 200, broadcast.get_json())
        retry = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": PASSWORD, "confirm": "ENVIAR BTC"})
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.get_json()["transfer"]["txid"], broadcast.get_json()["transfer"]["txid"])
        with app_module.app.app_context():
            db = app_module.get_db()
            db.execute("UPDATE wallet_transfers SET status='broadcasting' WHERE id=?", (transfer["id"],))
            db.commit()
        self.core.mempool.clear()
        self.core.wallet_transactions[self.core.txid] = {"txid": self.core.txid, "confirmations": 1,
                                                          "abandoned": False, "walletconflicts": []}
        resumed = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": PASSWORD, "confirm": "ENVIAR BTC"})
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.get_json()["transfer"]["status"], "confirmed")
        confirmed_retry = self.post("seller1@test.invalid", f"/api/wallet/transfers/{transfer['id']}/broadcast", {"password": PASSWORD, "confirm": "ENVIAR BTC"})
        self.assertEqual(confirmed_retry.status_code, 200)
        self.assertEqual(confirmed_retry.get_json()["transfer"]["txid"], self.core.txid)

    def test_notifications_are_isolated_and_read_is_idempotent(self):
        with app_module.app.app_context():
            db = app_module.get_db()
            notify_user(db, self.ids["seller1@test.invalid"], "transfer", "A", "B", dedupe_key="test:one")
            notify_user(db, self.ids["seller2@test.invalid"], "transfer", "C", "D", dedupe_key="test:two")
            db.commit()
        one = self.clients["seller1@test.invalid"].get("/api/notifications").get_json()
        two = self.clients["seller2@test.invalid"].get("/api/notifications").get_json()
        self.assertEqual(one["unread_count"], 1)
        self.assertEqual(two["unread_count"], 1)
        notification_id = one["notifications"][0]["id"]
        foreign = self.post("seller2@test.invalid", f"/api/notifications/{notification_id}/read", {})
        self.assertEqual(foreign.status_code, 404)
        read1 = self.post("seller1@test.invalid", f"/api/notifications/{notification_id}/read", {})
        read2 = self.post("seller1@test.invalid", f"/api/notifications/{notification_id}/read", {})
        self.assertEqual(read1.status_code, 200)
        self.assertEqual(read2.status_code, 200)
        self.assertEqual(self.clients["seller1@test.invalid"].get("/api/notifications").get_json()["unread_count"], 0)
        all_read = self.post("seller2@test.invalid", "/api/notifications/read-all", {})
        self.assertEqual(all_read.status_code, 200)

    def test_tracking_requires_paid_order_owner_and_valid_flow(self):
        order_id = self.add_order(status="paid", paid_sats=100000, total_sats=100000, confirmations=1)
        other = self.post("seller2@test.invalid", f"/api/orders/{order_id}/tracking", {"status": "processing"})
        self.assertEqual(other.status_code, 404)
        unpaid_id = self.add_order(status="paid", paid_sats=50000, total_sats=100000, confirmations=1)
        unpaid = self.post("seller1@test.invalid", f"/api/orders/{unpaid_id}/tracking", {"status": "processing"})
        self.assertEqual(unpaid.status_code, 409)
        processing = self.post("seller1@test.invalid", f"/api/orders/{order_id}/tracking", {"status": "processing", "note": "Separado"})
        self.assertEqual(processing.status_code, 200, processing.get_json())
        missing_tracking = self.post("seller1@test.invalid", f"/api/orders/{order_id}/tracking", {"status": "shipped"})
        self.assertEqual(missing_tracking.status_code, 409)
        shipped = self.post("seller1@test.invalid", f"/api/orders/{order_id}/tracking", {
            "status": "shipped", "carrier": "Carrier", "tracking_code": "TRACK-001", "note": "Enviado"})
        self.assertEqual(shipped.status_code, 200)
        completed = self.post("seller1@test.invalid", f"/api/orders/{order_id}/tracking", {"status": "completed"})
        self.assertEqual(completed.status_code, 200)
        regress = self.post("seller1@test.invalid", f"/api/orders/{order_id}/tracking", {"status": "processing"})
        self.assertEqual(regress.status_code, 409)
        tracking = self.clients["buyer1@test.invalid"].get(f"/api/orders/{order_id}/tracking").get_json()
        self.assertEqual(tracking["tracking"]["tracking_code"], "TRACK-001")
        self.assertEqual([event["status"] for event in tracking["events"]], ["processing", "shipped", "completed"])
        admin_paid = self.post("admin@test.invalid", f"/api/admin/orders/{unpaid_id}/status", {"status": "paid"})
        self.assertEqual(admin_paid.status_code, 400)
        with app_module.app.app_context():
            db = app_module.get_db()
            with self.assertRaises(Exception):
                db.execute("UPDATE order_tracking_events SET note='tamper' WHERE order_id=?", (order_id,))

    def test_live_payable_orders_cannot_cancel_before_reconciliation(self):
        lightning_id = self.add_order(status="awaiting_payment", paid_sats=0, total_sats=100000,
                                      confirmations=0, paid_at=None, payment_method="lightning",
                                      lightning_status="OPEN")
        onchain_id = self.add_order(status="awaiting_payment", paid_sats=0, total_sats=100000,
                                    confirmations=0, paid_at=None, payment_method="onchain_multisig")
        for order_id in (lightning_id, onchain_id):
            result = self.post("seller1@test.invalid", f"/api/seller/orders/{order_id}/status", {"status": "cancelled"})
            self.assertEqual(result.status_code, 409, result.get_json())
        with app_module.app.app_context():
            db = app_module.get_db()
            lightning = db.execute("SELECT * FROM orders WHERE id=?", (lightning_id,)).fetchone()
            self.assertEqual(lightning["status"], "awaiting_payment")
            app_module.mark_lightning_settled(db, lightning, 100000, {"state": "SETTLED"})
            db.commit()
            settled = db.execute("SELECT status,paid_sats,lightning_status,paid_at FROM orders WHERE id=?", (lightning_id,)).fetchone()
            self.assertEqual((settled["status"], settled["paid_sats"], settled["lightning_status"]), ("paid", 100000, "SETTLED"))
            self.assertTrue(settled["paid_at"])
            onchain = db.execute("SELECT status,paid_sats,paid_at FROM orders WHERE id=?", (onchain_id,)).fetchone()
            self.assertEqual((onchain["status"], onchain["paid_sats"], onchain["paid_at"]), ("awaiting_payment", 0, None))

    def test_reviews_require_funded_completed_owned_item_and_are_verified(self):
        pending_id = self.add_order(status="completed", paid_sats=50000, total_sats=100000, confirmations=5)
        unpaid = self.post("buyer1@test.invalid", "/api/reviews", {
            "order_id": pending_id, "product_id": self.product_id, "rating": 5, "comment": "Não deveria aparecer"})
        self.assertEqual(unpaid.status_code, 400)
        completed_id = self.add_order(status="completed", paid_sats=100000, total_sats=100000,
                                      confirmations=1, product_id=self.product_id)
        foreign = self.post("buyer2@test.invalid", "/api/reviews", {
            "order_id": completed_id, "product_id": self.product_id, "rating": 5, "comment": "IDOR"})
        self.assertEqual(foreign.status_code, 400)
        with app_module.app.app_context():
            db = app_module.get_db()
            db.execute("INSERT INTO reviews(order_id,product_id,buyer_id,store_id,rating,title,comment,created_at,purchase_verified) VALUES(?,?,?,?,5,'legacy','hidden',?,0)",
                       (completed_id, self.product_id, self.ids["buyer1@test.invalid"], self.store_id, app_module.now_iso()))
            db.commit()
        created = self.post("buyer1@test.invalid", "/api/reviews", {
            "order_id": completed_id, "product_id": self.product_id, "rating": 4, "title": "Confirmed", "comment": "Compra concluída"})
        self.assertEqual(created.status_code, 201, created.get_json())
        duplicate = self.post("buyer1@test.invalid", "/api/reviews", {
            "order_id": completed_id, "product_id": self.product_id, "rating": 4, "comment": "Duplicate"})
        self.assertEqual(duplicate.status_code, 409)
        listing = self.clients["buyer2@test.invalid"].get(f"/api/products/{self.product_id}").get_json()
        self.assertEqual(listing["product"]["review_count"], 1)
        self.assertEqual(len(listing["reviews"]), 1)
        self.assertTrue(listing["reviews"][0]["purchase_verified"])
        self.assertNotIn("buyer_id", listing["reviews"][0])
        self.assertNotIn("order_id", listing["reviews"][0])
        refunded_id = self.add_order(status="completed", paid_sats=100000, total_sats=100000,
                                     confirmations=1, refund_txid="confirmed-refund")
        refunded = self.post("buyer1@test.invalid", "/api/reviews", {
            "order_id": refunded_id, "product_id": self.product_id, "rating": 4, "comment": "Refund"})
        self.assertEqual(refunded.status_code, 400)

    def test_checkout_serializes_stock_decrement(self):
        with app_module.app.app_context():
            db = app_module.get_db()
            db.execute("UPDATE products SET stock=1 WHERE id=?", (self.product_id,))
            for email in ("buyer1@test.invalid", "buyer2@test.invalid"):
                db.execute("INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,1)", (self.ids[email], self.product_id))
            db.commit()
        counter = {"value": 0}
        lock = threading.Lock()

        def escrow(*_args):
            with lock:
                counter["value"] += 1
                suffix = counter["value"]
            return {"address": "bcrt1q" + str(suffix).zfill(38), "descriptor": "wsh(fixture)",
                    "redeem_script": "", "witness_script": "", "platform_pubkey": PUBKEY}

        body = {"shipping_name": "Buyer", "shipping_address": "Street", "shipping_city": "City",
                "shipping_state": "ST", "shipping_zip": "00000", "payment_method": "onchain_multisig"}
        barrier = threading.Barrier(2)
        outcomes = []

        def checkout(email):
            barrier.wait()
            response = self.post(email, "/api/checkout", body)
            outcomes.append((response.status_code, response.get_json()))

        with mock.patch.object(app_module, "create_multisig_escrow", side_effect=escrow), \
             mock.patch.object(app_module, "platform_escrow_pubkey", return_value=PUBKEY), \
             mock.patch.object(app_module, "commission_address_for_order", return_value=DESTINATION):
            threads = [threading.Thread(target=checkout, args=(email,)) for email in ("buyer1@test.invalid", "buyer2@test.invalid")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
        self.assertEqual(sorted(status for status, _ in outcomes), [201, 400], outcomes)
        with app_module.app.app_context():
            db = app_module.get_db()
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?", (self.product_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM orders").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
