"""Per-user watch-only wallets, withdrawals, notifications and order tracking."""

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal

from flask import Response, g, jsonify, request
from werkzeug.security import check_password_hash


ACTIVE_TRANSFER_STATES = ("draft", "signed", "ready_to_broadcast", "broadcasting")
FINAL_TRANSFER_STATES = ("broadcast", "confirmed", "cancelled", "failed")
_reauth_lock = threading.Lock()
_reauth_attempts = {}


def init_marketplace_schema(db, min_confirmations=1):
    """Idempotently add feature tables without rebuilding existing tables."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(reviews)")}
    if "purchase_verified" not in columns:
        db.execute("ALTER TABLE reviews ADD COLUMN purchase_verified INTEGER NOT NULL DEFAULT 0")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS user_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            core_wallet_name TEXT NOT NULL UNIQUE,
            network TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'watch-only',
            status TEXT NOT NULL DEFAULT 'ready',
            fingerprint TEXT NOT NULL UNIQUE,
            keyset_hash TEXT NOT NULL DEFAULT '',
            external_descriptor TEXT NOT NULL,
            change_descriptor TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS wallet_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            address TEXT NOT NULL UNIQUE,
            pubkey TEXT NOT NULL DEFAULT '',
            purpose TEXT NOT NULL CHECK(purpose IN ('receive','escrow')),
            created_at TEXT NOT NULL,
            FOREIGN KEY(wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_addresses_user ON wallet_addresses(user_id,id DESC);
        CREATE TABLE IF NOT EXISTS wallet_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            wallet_id INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            reference TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            destination TEXT NOT NULL,
            amount_sats INTEGER NOT NULL,
            fee_sats INTEGER NOT NULL DEFAULT 0,
            reserved_sats INTEGER NOT NULL DEFAULT 0,
            psbt TEXT NOT NULL,
            signed_psbt TEXT NOT NULL DEFAULT '',
            final_hex TEXT NOT NULL DEFAULT '',
            expected_tx_json TEXT NOT NULL,
            txid TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(user_id,idempotency_key),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user ON wallet_transfers(user_id,id DESC);
        CREATE TABLE IF NOT EXISTS wallet_transfer_inputs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id INTEGER NOT NULL,
            wallet_id INTEGER NOT NULL,
            txid TEXT NOT NULL,
            vout INTEGER NOT NULL,
            amount_sats INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','spent','released')),
            created_at TEXT NOT NULL,
            FOREIGN KEY(transfer_id) REFERENCES wallet_transfers(id) ON DELETE CASCADE,
            FOREIGN KEY(wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE,
            UNIQUE(transfer_id,txid,vout)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transfer_inputs_active
            ON wallet_transfer_inputs(wallet_id,txid,vout) WHERE state IN ('reserved','spent');
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            order_id INTEGER,
            dedupe_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            read_at TEXT,
            UNIQUE(user_id,dedupe_key),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,id DESC);
        CREATE TABLE IF NOT EXISTS order_tracking_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            carrier TEXT NOT NULL DEFAULT '',
            tracking_code TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            actor_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(actor_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_tracking_order ON order_tracking_events(order_id,id);
        CREATE TABLE IF NOT EXISTS used_escrow_addresses (
            address TEXT PRIMARY KEY,
            order_id INTEGER NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        CREATE TRIGGER IF NOT EXISTS order_tracking_no_update
            BEFORE UPDATE ON order_tracking_events BEGIN
                SELECT RAISE(ABORT,'tracking events are append-only');
            END;
        CREATE TRIGGER IF NOT EXISTS order_tracking_no_delete
            BEFORE DELETE ON order_tracking_events BEGIN
                SELECT RAISE(ABORT,'tracking events are append-only');
            END;
        DROP VIEW IF EXISTS verified_reviews;
        """
    )
    confirmations = max(1, int(min_confirmations))
    db.executescript(
        f"""
        CREATE VIEW verified_reviews AS
            SELECT r.* FROM reviews r
            JOIN orders o ON o.id=r.order_id
            JOIN order_items oi ON oi.order_id=r.order_id AND oi.product_id=r.product_id
            JOIN products p ON p.id=r.product_id AND p.store_id=r.store_id
            WHERE r.purchase_verified=1 AND o.status='completed'
              AND o.paid_sats>=o.total_sats AND o.paid_at IS NOT NULL
              AND o.buyer_id=r.buyer_id
              AND ((o.payment_method='lightning' AND o.lightning_status='SETTLED')
                   OR (o.payment_method<>'lightning' AND o.confirmations>={confirmations}))
              AND COALESCE(o.refund_txid,'')='';
        """
    )
    wallet_columns = {row[1] for row in db.execute("PRAGMA table_info(user_wallets)")}
    if "keyset_hash" not in wallet_columns:
        db.execute("ALTER TABLE user_wallets ADD COLUMN keyset_hash TEXT NOT NULL DEFAULT ''")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallet_keyset ON user_wallets(keyset_hash) WHERE keyset_hash<>''")


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def notify_user(db, user_id, kind, title, body, order_id=None, dedupe_key=None):
    key = str(dedupe_key or secrets.token_hex(16))
    db.execute(
        """INSERT OR IGNORE INTO notifications(user_id,kind,title,body,order_id,dedupe_key,created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (user_id, kind, title[:120], body[:500], order_id, key, _now()),
    )


def notify_order_parties(db, order_id, kind, title, body, event_key):
    row = db.execute(
        """SELECT o.id,o.buyer_id,o.reference,s.owner_id FROM orders o
           JOIN stores s ON s.id=o.store_id WHERE o.id=?""",
        (order_id,),
    ).fetchone()
    if not row:
        return
    for user_id in {int(row["buyer_id"]), int(row["owner_id"])}:
        notify_user(db, user_id, kind, title, body, order_id, f"order:{order_id}:{event_key}")


class MarketplaceFeatures:
    def __init__(self, app, ctx):
        self.app = app
        self.ctx = ctx
        self.rpc_factory = ctx["BitcoinRPC"]

    def _db(self):
        return self.ctx["get_db"]()

    def _error(self, message, status=400):
        return self.ctx["api_error"](message, status)

    def _wallet(self, db, user_id):
        return db.execute("SELECT * FROM user_wallets WHERE user_id=?", (user_id,)).fetchone()

    def _rpc(self, wallet_name=None):
        return self.rpc_factory(wallet_name)

    def _wallet_rpc(self, row):
        return self._rpc(row["core_wallet_name"])

    def _clean(self, value, max_len=255, required=False):
        return self.ctx["clean_text"](value, max_len, required)

    def _payload(self):
        data = request.get_json(silent=True)
        if data is None:
            return {}, None
        if not isinstance(data, dict):
            return None, self._error("Corpo JSON deve ser objeto.", 400)
        return data, None

    def _auth_password(self, data):
        key = (int(g.user["id"]), request.remote_addr or "unknown")
        now = time.monotonic()
        with _reauth_lock:
            recent = [stamp for stamp in _reauth_attempts.get(key, []) if now - stamp < 900]
            if len(recent) >= 8:
                _reauth_attempts[key] = recent
                return False
            recent.append(now)
            _reauth_attempts[key] = recent
            if len(_reauth_attempts) > 5000:
                oldest = sorted(_reauth_attempts, key=lambda item: _reauth_attempts[item][0] if _reauth_attempts[item] else now)[:1000]
                for item in oldest:
                    _reauth_attempts.pop(item, None)
        password = str((data or {}).get("password") or "")
        user = self._db().execute("SELECT password_hash FROM users WHERE id=?", (g.user["id"],)).fetchone()
        valid = bool(user and check_password_hash(user["password_hash"], password))
        if valid:
            with _reauth_lock:
                _reauth_attempts.pop(key, None)
        return valid

    def _rpc_error(self):
        return self._error("Serviço Bitcoin indisponível.", 502)

    def _known_transaction_status(self, rpc, wallet_rpc, txid):
        try:
            self._call(rpc, "getmempoolentry", [txid])
            return "broadcast"
        except RuntimeError:
            pass
        try:
            transaction = self._call(rpc, "getrawtransaction", [txid, True]) or {}
            confirmations = int(transaction.get("confirmations", 0))
            if confirmations >= 0:
                return "confirmed" if confirmations > 0 else "broadcast"
        except RuntimeError:
            pass
        try:
            transaction = self._call(wallet_rpc, "gettransaction", [txid]) or {}
            if transaction.get("txid") == txid and not transaction.get("abandoned") and not transaction.get("walletconflicts"):
                confirmations = int(transaction.get("confirmations", 0))
                if confirmations >= 0:
                    return "confirmed" if confirmations > 0 else "broadcast"
        except RuntimeError:
            pass
        return ""

    def _call(self, rpc, method, params=None):
        try:
            return rpc.call(method, params or [])
        except Exception as exc:
            raise RuntimeError("Bitcoin Core indisponível.") from exc

    def _verify_network(self, rpc):
        info = self._call(rpc, "getblockchaininfo") or {}
        expected = {"mainnet": "main", "main": "main"}.get(self.ctx["BTC_NETWORK"], self.ctx["BTC_NETWORK"])
        chain = info.get("chain")
        if chain != expected or (chain == "main" and not self.ctx["ALLOW_MAINNET"]):
            raise RuntimeError("Rede Bitcoin não corresponde à configuração.")
        return chain

    def _descriptor_info(self, rpc, descriptor):
        descriptor = self._clean(descriptor, 3000, True)
        if re.search(r"(?:xprv|tprv|yprv|zprv|prv)[1-9A-HJ-NP-Za-km-z]*|\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b", descriptor, re.I):
            raise ValueError("Descriptor deve conter somente chaves públicas.")
        if "#" in descriptor:
            descriptor = descriptor.split("#", 1)[0]
        info = self._call(rpc, "getdescriptorinfo", [descriptor])
        if info.get("hasprivatekeys") or not info.get("isrange") or not info.get("issolvable"):
            raise ValueError("Descriptor deve ser público, ranged e solvable.")
        canonical = str(info.get("descriptor") or "")
        origins = re.findall(r"\[([0-9a-fA-F]{8})(?:/[^\]]*)?\]", canonical)
        xpubs = re.findall(r"(?:xpub|tpub|ypub|zpub|Ypub|Zpub)[1-9A-HJ-NP-Za-km-z]{40,120}", canonical)
        if not origins or len(xpubs) != 1 or not canonical.lower().startswith("wpkh("):
            raise ValueError("Use descriptor WPKH ranged com uma chave pública estendida e fingerprint.")
        return canonical, origins[0].lower(), sorted(xpubs)

    def _ensure_core_wallet(self, name):
        root = self._rpc(None)
        self._verify_network(root)
        loaded = self._call(root, "listwallets") or []
        if name in loaded:
            return
        directory = self._call(root, "listwalletdir") or {}
        existing = {entry.get("name") for entry in directory.get("wallets", [])}
        if name in existing:
            self._call(root, "loadwallet", [name])
        else:
            self._call(root, "createwallet", {
                "wallet_name": name,
                "disable_private_keys": True,
                "blank": True,
                "descriptors": True,
                "load_on_startup": True,
            })

    def _import_user_descriptors(self, rpc, external, change):
        result = self._call(rpc, "importdescriptors", [[
            {"desc": external, "timestamp": "now", "active": True, "internal": False, "range": [0, 999]},
            {"desc": change, "timestamp": "now", "active": True, "internal": True, "range": [0, 999]},
        ]])
        if not result or any(not row.get("success") for row in result):
            raise RuntimeError("Bitcoin Core recusou os descriptors.")

    def _address(self, db, wallet, purpose="receive"):
        rpc = self._wallet_rpc(wallet)
        address = self._call(rpc, "getnewaddress", [f"{purpose}_{secrets.token_hex(8)}", "bech32"])
        info = self._call(rpc, "getaddressinfo", [address]) or {}
        if not info.get("ismine"):
            raise RuntimeError("Bitcoin Core não confirmou endereço próprio.")
        db.execute(
            "INSERT INTO wallet_addresses(wallet_id,user_id,address,pubkey,purpose,created_at) VALUES(?,?,?,?,?,?)",
            (wallet["id"], wallet["user_id"], address, str(info.get("pubkey") or ""), purpose, _now()),
        )
        return address, str(info.get("pubkey") or "")

    def fresh_escrow_pubkey(self, db, user_id, label):
        wallet = self._wallet(db, user_id)
        if not wallet or wallet["status"] != "ready":
            return ""
        address, pubkey = self._address(db, wallet, "escrow")
        if not self.ctx["valid_compressed_pubkey"](pubkey):
            raise RuntimeError("A carteira watch-only não retornou chave pública para escrow.")
        return pubkey

    def _wallet_payload(self, db, row):
        if not row:
            return {"id": None, "network": self.ctx["BTC_NETWORK"], "mode": "demo" if self.ctx["BTC_MODE"] != "rpc" else "watch-only",
                    "status": "unconfigured", "configured": False, "address": "", "confirmed_btc": "0.00000000",
                    "pending_btc": "0.00000000", "reserved_btc": "0.00000000", "available_btc": "0.00000000", "requires_setup": True}
        if self.ctx["BTC_MODE"] != "rpc":
            return {"id": row["id"], "network": row["network"], "mode": "demo", "status": "demo",
                    "configured": False, "address": "", "confirmed_btc": "0.00000000", "pending_btc": "0.00000000",
                    "reserved_btc": "0.00000000", "available_btc": "0.00000000", "requires_setup": True}
        try:
            rpc = self._wallet_rpc(row)
            info = self._call(rpc, "getbalances") or {}
            watch = info.get("watchonly", {})
            mine = info.get("mine", {})
            confirmed = self.ctx["btc_to_sats"](watch.get("trusted", 0)) + self.ctx["btc_to_sats"](mine.get("trusted", 0))
            pending = self.ctx["btc_to_sats"](watch.get("untrusted_pending", 0)) + self.ctx["btc_to_sats"](mine.get("untrusted_pending", 0))
            reserved = db.execute(
                "SELECT COALESCE(SUM(amount_sats),0) FROM wallet_transfer_inputs WHERE wallet_id=? AND state='reserved'",
                (row["id"],),
            ).fetchone()[0]
            latest = db.execute("SELECT address FROM wallet_addresses WHERE user_id=? AND purpose='receive' ORDER BY id DESC LIMIT 1", (row["user_id"],)).fetchone()
            return {"id": row["id"], "network": row["network"], "mode": "watch-only", "status": row["status"],
                    "configured": True, "address": latest["address"] if latest else "", "confirmed_btc": self.ctx["sats_to_btc"](confirmed),
                    "pending_btc": self.ctx["sats_to_btc"](pending), "reserved_btc": self.ctx["sats_to_btc"](reserved),
                    "available_btc": self.ctx["sats_to_btc"](max(0, confirmed-reserved)), "requires_setup": False}
        except Exception:
            return {"id": row["id"], "network": row["network"], "mode": "watch-only", "status": "offline",
                    "configured": True, "address": "", "confirmed_btc": "0.00000000", "pending_btc": "0.00000000",
                    "reserved_btc": "0.00000000", "available_btc": "0.00000000", "requires_setup": False}

    def wallet_get(self):
        db = self._db()
        wallet = self._wallet(db, g.user["id"])
        transfers = db.execute("SELECT * FROM wallet_transfers WHERE user_id=? ORDER BY id DESC LIMIT 50", (g.user["id"],)).fetchall()
        addresses = db.execute("SELECT address,purpose,created_at FROM wallet_addresses WHERE user_id=? ORDER BY id DESC LIMIT 100", (g.user["id"],)).fetchall()
        return jsonify(wallet=self._wallet_payload(db, wallet), transfers=[self._serialize_transfer(t) for t in transfers], addresses=[dict(a) for a in addresses])

    def wallet_setup(self):
        if g.user["role"] not in {"buyer", "seller"}:
            return self._error("Carteira disponível para compradores e vendedores.", 403)
        if self.ctx["BTC_MODE"] != "rpc":
            return self._error("Carteira pessoal exige BTC_MODE=rpc.", 409)
        data, error = self._payload()
        if error:
            return error
        if not self._auth_password(data):
            return self._error("Senha inválida.", 403)
        db = self._db()
        existing = self._wallet(db, g.user["id"])
        if existing:
            return self._error("Carteira já configurada; troca exige migração controlada.", 409)
        try:
            root = self._rpc(None)
            self._verify_network(root)
            external, fp_ext, xpub_ext = self._descriptor_info(root, data.get("descriptor"))
            change, fp_change, xpub_change = self._descriptor_info(root, data.get("change_descriptor"))
            if fp_ext != fp_change or xpub_ext != xpub_change:
                raise ValueError("Descriptors externo e de troco devem usar mesma carteira pública.")
            ext_branch = re.search(r"/([01])/\*", external)
            change_branch = re.search(r"/([01])/\*", change)
            if not ext_branch or ext_branch.group(1) != "0" or not change_branch or change_branch.group(1) != "1":
                raise ValueError("Descriptor externo deve usar ramo /0/* e troco deve usar /1/*.")
            keyset_hash = hashlib.sha256(json.dumps(xpub_ext, separators=(",", ":")).encode()).hexdigest()
            if db.execute("SELECT 1 FROM user_wallets WHERE fingerprint=? OR keyset_hash=?", (fp_ext, keyset_hash)).fetchone():
                return self._error("Fingerprint já associado a outra conta.", 409)
            name = "user_" + secrets.token_hex(20)
            self._ensure_core_wallet(name)
            rpc = self._rpc(name)
            self._import_user_descriptors(rpc, external, change)
            db.execute("BEGIN IMMEDIATE")
            cur = db.execute(
                """INSERT INTO user_wallets(user_id,core_wallet_name,network,mode,status,fingerprint,keyset_hash,external_descriptor,change_descriptor,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (g.user["id"], name, self.ctx["BTC_NETWORK"], "watch-only", "ready", fp_ext, keyset_hash, external, change, _now(), _now()),
            )
            wallet = db.execute("SELECT * FROM user_wallets WHERE id=?", (cur.lastrowid,)).fetchone()
            self._address(db, wallet, "receive")
            db.commit()
            return jsonify(wallet=self._wallet_payload(db, wallet)), 201
        except sqlite3.IntegrityError:
            db.rollback()
            return self._error("Fingerprint já associado a outra conta.", 409)
        except ValueError as exc:
            db.rollback()
            return self._error(exc)
        except Exception:
            db.rollback()
            return self._rpc_error()

    def wallet_new_address(self):
        db = self._db()
        wallet = self._wallet(db, g.user["id"])
        if not wallet or self.ctx["BTC_MODE"] != "rpc":
            return self._error("Configure carteira Bitcoin watch-only antes de gerar endereço.", 409)
        try:
            address, _ = self._address(db, wallet, "receive")
            db.commit()
            return jsonify(address=address), 201
        except sqlite3.IntegrityError:
            db.rollback()
            return self._error("Bitcoin Core retornou endereço já registrado.", 409)
        except Exception:
            db.rollback()
            return self._rpc_error()

    def _serialize_transfer(self, row):
        return {"id": row["id"], "reference": row["reference"], "status": row["status"],
                "amount_btc": self.ctx["sats_to_btc"](row["amount_sats"]), "fee_btc": self.ctx["sats_to_btc"](row["fee_sats"]),
                "destination": row["destination"], "txid": row["txid"], "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def _tx_body(self, tx):
        inputs = []
        for item in tx.get("vin", []):
            if "coinbase" in item:
                raise ValueError("Transação contém input coinbase inesperado.")
            inputs.append({"txid": str(item["txid"]).lower(), "vout": int(item["vout"]), "sequence": int(item.get("sequence", 0xFFFFFFFF))})
        outputs = []
        for item in tx.get("vout", []):
            script = item.get("scriptPubKey", {}) or {}
            addresses = script.get("addresses") or ([script["address"]] if script.get("address") else [])
            outputs.append({"value_sats": self.ctx["btc_to_sats"](item.get("value", 0)),
                            "script_hex": str(script.get("hex") or "").lower(),
                            "address": str(addresses[0]) if len(addresses) == 1 else ""})
        return {"version": int(tx.get("version", 2)), "locktime": int(tx.get("locktime", 0)), "vin": inputs, "vout": outputs}

    def _input_amount(self, decoded_input, outpoint, rpc):
        utxo = decoded_input.get("witness_utxo") or {}
        if "amount" in utxo:
            return self.ctx["btc_to_sats"](utxo["amount"])
        if "value" in utxo:
            return self.ctx["btc_to_sats"](utxo["value"])
        non_witness = decoded_input.get("non_witness_utxo") or {}
        vout = int(outpoint["vout"])
        if vout < len(non_witness.get("vout", [])):
            return self.ctx["btc_to_sats"](non_witness["vout"][vout].get("value", 0))
        root = self._rpc(None)
        found = self._call(root, "gettxout", [outpoint["txid"], vout, True])
        if not found:
            raise ValueError("Input reservado não está disponível.")
        return self.ctx["btc_to_sats"](found.get("value", 0))

    def _validate_transaction(self, rpc, tx, psbt_inputs, destination, amount_sats):
        body = self._tx_body(tx)
        recipients = [out for out in body["vout"] if out["address"] == destination and out["value_sats"] == amount_sats]
        if len(recipients) != 1:
            raise ValueError("Transação assinada alterou destino ou valor.")
        for output in body["vout"]:
            if output is recipients[0]:
                continue
            if not output["address"]:
                raise ValueError("Transação contém saída sem endereço verificável.")
            info = self._call(rpc, "getaddressinfo", [output["address"]]) or {}
            if not info.get("ismine"):
                raise ValueError("Transação contém saída externa não autorizada.")
        if len(body["vin"]) != len(psbt_inputs):
            raise ValueError("Transação alterou conjunto de inputs.")
        total_in = sum(self._input_amount(psbt_inputs[index], body["vin"][index], rpc) for index in range(len(body["vin"])))
        total_out = sum(out["value_sats"] for out in body["vout"])
        fee_sats = total_in - total_out
        max_fee_sats = max(1, min(amount_sats // 100, 10_000))
        if fee_sats < 0 or fee_sats > max_fee_sats:
            raise ValueError("Taxa da transação excede limite permitido.")
        return body, fee_sats, total_in

    def _lock_reserved(self, db, wallet, rpc):
        rows = db.execute(
            """SELECT i.txid,i.vout FROM wallet_transfer_inputs i JOIN wallet_transfers t ON t.id=i.transfer_id
               WHERE i.wallet_id=? AND i.state='reserved' AND t.status IN ('draft','signed','ready_to_broadcast','broadcasting')""",
            (wallet["id"],),
        ).fetchall()
        if rows:
            try:
                self._call(rpc, "lockunspent", [False, [{"txid": r["txid"], "vout": r["vout"]} for r in rows]])
            except RuntimeError:
                raise

    def _unlock_uncommitted(self, db, rpc, wallet_id, outpoints):
        if not outpoints:
            return
        active = {
            (row["txid"], row["vout"])
            for row in db.execute(
                "SELECT txid,vout FROM wallet_transfer_inputs WHERE wallet_id=? AND state IN ('reserved','spent')",
                (wallet_id,),
            ).fetchall()
        }
        releasable = [item for item in outpoints if (item["txid"], item["vout"]) not in active]
        if releasable:
            try:
                self._call(rpc, "lockunspent", [True, releasable])
            except RuntimeError:
                pass

    def transfer_create(self):
        if g.user["role"] != "seller":
            return self._error("Somente vendedor pode iniciar transferência.", 403)
        if self.ctx["BTC_MODE"] != "rpc":
            return self._error("Transferência Bitcoin exige BTC_MODE=rpc.", 409)
        data, error = self._payload()
        if error:
            return error
        if not self._auth_password(data):
            return self._error("Senha inválida.", 403)
        try:
            destination = self._clean(data.get("destination"), 120, True)
            amount_sats = self.ctx["btc_to_sats"](data.get("amount_btc"))
            idem = self._clean(data.get("idempotency_key"), 128, True)
            if amount_sats <= 0 or len(idem) < 8:
                raise ValueError("Valor e chave de idempotência inválidos.")
        except (ValueError, TypeError) as exc:
            return self._error(exc)
        db = self._db()
        request_hash = hashlib.sha256(json.dumps({"destination": destination, "amount_sats": amount_sats}, sort_keys=True).encode()).hexdigest()
        rpc = None
        funded = None
        new_outpoints = []
        wallet_id = None
        try:
            db.execute("BEGIN IMMEDIATE")
            wallet = self._wallet(db, g.user["id"])
            if not wallet or wallet["status"] != "ready":
                db.rollback()
                return self._error("Configure carteira watch-only antes de transferir.", 409)
            wallet_id = wallet["id"]
            existing = db.execute("SELECT * FROM wallet_transfers WHERE user_id=? AND idempotency_key=?", (g.user["id"], idem)).fetchone()
            if existing:
                db.rollback()
                if existing["request_hash"] != request_hash:
                    return self._error("Chave de idempotência já usada com outros dados.", 409)
                return jsonify(transfer=self._serialize_transfer(existing) | {"psbt": existing["psbt"]}), 200
            rpc = self._wallet_rpc(wallet)
            self._verify_network(rpc)
            address_info = self._call(rpc, "validateaddress", [destination]) or {}
            if not address_info.get("isvalid"):
                raise ValueError("Endereço inválido para a rede configurada.")
            if self.ctx["PSBT_FEE_RATE"] <= 0:
                raise ValueError("PSBT_FEE_RATE precisa ser positivo.")
            self._lock_reserved(db, wallet, rpc)
            change = self._call(rpc, "getrawchangeaddress", ["bech32"])
            funded = self._call(rpc, "walletcreatefundedpsbt", [[], [{destination: self.ctx["sats_to_btc"](amount_sats)}], 0,
                {"add_inputs": True, "includeWatching": True, "lockUnspents": True,
                 "minconf": max(1, int(self.ctx["MIN_CONFIRMATIONS"])), "changeAddress": change,
                 "fee_rate": float(self.ctx["PSBT_FEE_RATE"])}, True])
            psbt = funded["psbt"]
            decoded = self._call(rpc, "decodepsbt", [psbt])
            tx = decoded.get("tx") or {}
            new_outpoints = [
                {"txid": str(item["txid"]), "vout": int(item["vout"])}
                for item in tx.get("vin", []) if "txid" in item and "vout" in item
            ]
            body, computed_fee, total_in = self._validate_transaction(rpc, tx, decoded.get("inputs", []), destination, amount_sats)
            fee_sats = self.ctx["btc_to_sats"](funded.get("fee", 0))
            if fee_sats != computed_fee or computed_fee <= 0:
                raise ValueError("Fee retornada pelo nó diverge do corpo da transação.")
            if not body["vin"]:
                raise ValueError("Carteira não selecionou inputs confirmados.")
            ref = "TR-" + secrets.token_hex(12).upper()
            cur = db.execute(
                """INSERT INTO wallet_transfers(user_id,wallet_id,idempotency_key,request_hash,reference,status,destination,amount_sats,fee_sats,reserved_sats,psbt,expected_tx_json,created_at,updated_at)
                   VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)""",
                (g.user["id"], wallet["id"], idem, request_hash, ref, destination, amount_sats, fee_sats, total_in, psbt,
                 json.dumps(body, sort_keys=True), _now(), _now()),
            )
            transfer_id = cur.lastrowid
            for index, outpoint in enumerate(body["vin"]):
                amount = self._input_amount(decoded.get("inputs", [])[index], outpoint, rpc)
                db.execute("INSERT INTO wallet_transfer_inputs(transfer_id,wallet_id,txid,vout,amount_sats,state,created_at) VALUES(?,?,?,?,?,'reserved',?)",
                           (transfer_id, wallet["id"], outpoint["txid"], outpoint["vout"], amount, _now()))
            notify_user(db, g.user["id"], "transfer", "Transferência preparada", "PSBT criada; assinatura externa pendente.", None, f"transfer:{transfer_id}:created")
            db.commit()
            row = db.execute("SELECT * FROM wallet_transfers WHERE id=?", (transfer_id,)).fetchone()
            return jsonify(transfer=self._serialize_transfer(row) | {"psbt": psbt}), 201
        except sqlite3.IntegrityError:
            db.rollback()
            self._unlock_uncommitted(db, rpc, wallet_id, new_outpoints)
            return self._error("Input já reservado ou chave de idempotência concorrente.", 409)
        except ValueError as exc:
            db.rollback()
            self._unlock_uncommitted(db, rpc, wallet_id, new_outpoints)
            return self._error(exc, 409)
        except Exception:
            db.rollback()
            if funded and not new_outpoints and rpc:
                try:
                    failed_decode = self._call(rpc, "decodepsbt", [funded["psbt"]])
                    new_outpoints = [
                        {"txid": str(item["txid"]), "vout": int(item["vout"])}
                        for item in (failed_decode.get("tx") or {}).get("vin", [])
                        if "txid" in item and "vout" in item
                    ]
                except Exception:
                    pass
            self._unlock_uncommitted(db, rpc, wallet_id, new_outpoints)
            return self._rpc_error()

    def _owned_transfer(self, db, transfer_id):
        return db.execute("SELECT * FROM wallet_transfers WHERE id=? AND user_id=?", (transfer_id, g.user["id"])).fetchone()

    def transfer_download(self, transfer_id):
        row = self._owned_transfer(self._db(), transfer_id)
        if not row:
            return self._error("Transferência não encontrada.", 404)
        response = Response(row["signed_psbt"] or row["psbt"], mimetype="text/plain")
        response.headers["Content-Disposition"] = f'attachment; filename="{row["reference"].lower()}.psbt"'
        return response

    def _assert_all_sighash(self, decoded):
        for item in decoded.get("inputs", []):
            sighash = item.get("sighash")
            if sighash is not None and str(sighash).upper() not in {"1", "ALL", "SIGHASH_ALL"}:
                raise ValueError("Assinatura deve usar SIGHASH_ALL.")
            signatures = list((item.get("partial_signatures") or {}).values())
            taproot_sig = item.get("taproot_key_path_signature")
            signatures.extend([taproot_sig] if taproot_sig else [])
            signatures.extend((item.get("taproot_script_path_signatures") or {}).values())
            final_witness = item.get("final_scriptwitness")
            if isinstance(final_witness, dict):
                final_stack = final_witness.get("stack") or []
            elif isinstance(final_witness, list):
                final_stack = final_witness
            else:
                final_stack = []
            # Wallet Core finalizes PSBT inputs by moving signatures into the
            # witness stack and dropping partial_signatures. User wallets are
            # constrained to ranged WPKH, where the first witness element is
            # the DER signature followed by its explicit sighash byte.
            if final_stack:
                signatures.append(final_stack[0])
            if not signatures:
                raise ValueError("PSBT não contém assinatura verificável.")
            for signature in signatures:
                if not isinstance(signature, str):
                    raise ValueError("Assinatura PSBT inválida.")
                raw = bytes.fromhex(signature)
                if not raw or raw[-1] != 1:
                    raise ValueError("Assinatura deve usar SIGHASH_ALL explícito.")

    def transfer_signed(self, transfer_id):
        db = self._db()
        row = self._owned_transfer(db, transfer_id)
        if not row:
            return self._error("Transferência não encontrada.", 404)
        if row["status"] not in {"draft", "signed", "ready_to_broadcast"}:
            return self._error("Transferência não aceita nova assinatura.", 409)
        data, error = self._payload()
        if error:
            return error
        try:
            db.execute("BEGIN IMMEDIATE")
            row = self._owned_transfer(db, transfer_id)
            if not row or row["status"] not in {"draft", "signed", "ready_to_broadcast"}:
                db.rollback()
                return self._error("Transferência não aceita nova assinatura.", 409)
            signed = self._clean(data.get("psbt"), 1_500_000, True)
            wallet = self._wallet(db, g.user["id"])
            rpc = self._wallet_rpc(wallet)
            original = self._call(rpc, "decodepsbt", [row["psbt"]])
            candidate = self._call(rpc, "decodepsbt", [signed])
            expected = json.loads(row["expected_tx_json"])
            if self._tx_body(candidate.get("tx") or {}) != expected:
                raise ValueError("PSBT assinada alterou inputs, destino, taxa ou outputs.")
            original_inputs = original.get("inputs", [])
            candidate_inputs = candidate.get("inputs", [])
            if len(original_inputs) != len(candidate_inputs):
                raise ValueError("PSBT assinada alterou conjunto de inputs.")
            for before, after in zip(original_inputs, candidate_inputs):
                for key in ("witness_utxo", "non_witness_utxo", "sighash", "redeem_script", "witness_script"):
                    if key in before and before.get(key) != after.get(key):
                        raise ValueError("PSBT assinada alterou dados dos inputs.")
            self._assert_all_sighash(candidate)
            combined = self._call(rpc, "combinepsbt", [[row["psbt"], signed]])
            decoded = self._call(rpc, "decodepsbt", [combined])
            if self._tx_body(decoded.get("tx") or {}) != expected:
                raise ValueError("PSBT combinada diverge da transação autorizada.")
            finalized = self._call(rpc, "finalizepsbt", [combined, True])
            if not finalized.get("complete") or not finalized.get("hex"):
                raise ValueError("Assinatura incompleta.")
            raw = self._call(rpc, "decoderawtransaction", [finalized["hex"]])
            if self._tx_body(raw) != expected:
                raise ValueError("Transação final diverge da autorização.")
            test = self._call(self._rpc(None), "testmempoolaccept", [[finalized["hex"]]])
            if not test or not test[0].get("allowed"):
                raise ValueError("Bitcoin Core recusou a transação final.")
            txid = str(raw.get("txid") or "")
            if not txid:
                raise ValueError("Bitcoin Core não retornou txid final.")
            updated = db.execute("UPDATE wallet_transfers SET status='ready_to_broadcast',signed_psbt=?,final_hex=?,txid=?,updated_at=? WHERE id=? AND user_id=? AND status IN ('draft','signed','ready_to_broadcast')",
                       (combined, finalized["hex"], txid, _now(), transfer_id, g.user["id"]))
            if not updated.rowcount:
                raise ValueError("Transferência mudou durante a assinatura.")
            notify_user(db, g.user["id"], "transfer", "Transferência assinada", "Transação validada; reautenticação necessária para transmitir.", None, f"transfer:{transfer_id}:signed")
            db.commit()
            return jsonify(transfer=self._serialize_transfer(self._owned_transfer(db, transfer_id)))
        except ValueError as exc:
            db.rollback()
            return self._error(exc, 409)
        except Exception:
            db.rollback()
            return self._rpc_error()

    def transfer_broadcast(self, transfer_id):
        if g.user["role"] != "seller":
            return self._error("Somente vendedor pode transmitir transferência.", 403)
        data, error = self._payload()
        if error:
            return error
        if not self._auth_password(data):
            return self._error("Senha inválida.", 403)
        if data.get("confirm") != "ENVIAR BTC":
            return self._error("Confirmação deve ser ENVIAR BTC.", 400)
        db = self._db()
        row = self._owned_transfer(db, transfer_id)
        if not row:
            return self._error("Transferência não encontrada.", 404)
        if row["status"] not in {"ready_to_broadcast", "broadcasting", "broadcast", "confirmed"} or not row["final_hex"]:
            return self._error("Transação ainda não está pronta para transmissão.", 409)
        try:
            db.execute("BEGIN IMMEDIATE")
            row = self._owned_transfer(db, transfer_id)
            if not row:
                db.rollback()
                return self._error("Transferência não encontrada.", 404)
            if row["status"] in {"broadcast", "confirmed"}:
                db.rollback()
                return jsonify(transfer=self._serialize_transfer(row))
            if row["status"] == "ready_to_broadcast":
                db.execute("UPDATE wallet_transfers SET status='broadcasting',updated_at=? WHERE id=? AND status='ready_to_broadcast'", (_now(), transfer_id))
                row = self._owned_transfer(db, transfer_id)
            if row["status"] != "broadcasting" or not row["txid"]:
                db.rollback()
                return self._error("Transação não está em estado recuperável.", 409)
            db.commit()
            rpc = self._rpc(None)
            self._verify_network(rpc)
            wallet = self._wallet(db, g.user["id"])
            wallet_rpc = self._wallet_rpc(wallet)
            status = self._known_transaction_status(rpc, wallet_rpc, row["txid"])
            if status:
                txid = row["txid"]
            else:
                try:
                    txid = self._call(rpc, "sendrawtransaction", [row["final_hex"]])
                except RuntimeError:
                    status = self._known_transaction_status(rpc, wallet_rpc, row["txid"])
                    if not status:
                        raise
                    txid = row["txid"]
            if not status:
                status = "broadcast"
            if str(txid) != str(row["txid"]):
                return self._error("Bitcoin Core retornou txid divergente.", 502)
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE wallet_transfers SET status=?,txid=?,updated_at=? WHERE id=? AND user_id=?",
                       (status, txid, _now(), transfer_id, g.user["id"]))
            db.execute("UPDATE wallet_transfer_inputs SET state='spent' WHERE transfer_id=? AND state='reserved'", (transfer_id,))
            notify_user(db, g.user["id"], "transfer", "Transferência transmitida", "Bitcoin Core aceitou a transação.", None, f"transfer:{transfer_id}:broadcast")
            db.commit()
            return jsonify(transfer=self._serialize_transfer(self._owned_transfer(db, transfer_id)))
        except Exception:
            db.rollback()
            return self._rpc_error()

    def transfer_cancel(self, transfer_id):
        if g.user["role"] != "seller":
            return self._error("Somente vendedor pode cancelar transferência.", 403)
        data, error = self._payload()
        if error:
            return error
        if not self._auth_password(data):
            return self._error("Senha inválida.", 403)
        db = self._db()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = self._owned_transfer(db, transfer_id)
            if not row:
                db.rollback()
                return self._error("Transferência não encontrada.", 404)
            if row["status"] == "cancelled":
                inputs = db.execute("SELECT txid,vout FROM wallet_transfer_inputs WHERE transfer_id=?", (transfer_id,)).fetchall()
                wallet = self._wallet(db, g.user["id"])
                rpc = self._wallet_rpc(wallet)
                db.commit()
                self._call(rpc, "lockunspent", [True, [{"txid": item["txid"], "vout": item["vout"]} for item in inputs]])
                return jsonify(transfer=self._serialize_transfer(row))
            if row["status"] != "draft":
                db.rollback()
                return self._error("Somente PSBT ainda não assinada pode ser cancelada.", 409)
            wallet = self._wallet(db, g.user["id"])
            rpc = self._wallet_rpc(wallet)
            inputs = db.execute("SELECT txid,vout FROM wallet_transfer_inputs WHERE transfer_id=? AND state='reserved'", (transfer_id,)).fetchall()
            cur = db.execute("UPDATE wallet_transfers SET status='cancelled',updated_at=? WHERE id=? AND status='draft'", (_now(), transfer_id))
            if not cur.rowcount:
                db.rollback()
                return self._error("Transferência mudou durante cancelamento.", 409)
            db.execute("UPDATE wallet_transfer_inputs SET state='released' WHERE transfer_id=? AND state='reserved'", (transfer_id,))
            notify_user(db, g.user["id"], "transfer", "Transferência cancelada", "Inputs reservados foram liberados.", None, f"transfer:{transfer_id}:cancelled")
            db.commit()
            self._call(rpc, "lockunspent", [True, [{"txid": r["txid"], "vout": r["vout"]} for r in inputs]])
            return jsonify(transfer=self._serialize_transfer(self._owned_transfer(db, transfer_id)))
        except Exception:
            db.rollback()
            return self._rpc_error()

    def notifications_list(self):
        db = self._db()
        limit = max(1, min(request.args.get("limit", default=50, type=int), 100))
        before = request.args.get("before_id", type=int)
        where = "user_id=?" + (" AND id<?" if before else "")
        params = [g.user["id"]] + ([before] if before else []) + [limit]
        rows = db.execute(f"SELECT id,kind,title,body,order_id,created_at,read_at FROM notifications WHERE {where} ORDER BY id DESC LIMIT ?", params).fetchall()
        unread = db.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (g.user["id"],)).fetchone()[0]
        return jsonify(notifications=[dict(r) for r in rows], unread_count=unread)

    def notification_read(self, notification_id):
        db = self._db()
        cur = db.execute("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?", (_now(), notification_id, g.user["id"]))
        if not cur.rowcount:
            return self._error("Notificação não encontrada.", 404)
        db.commit()
        return jsonify(message="Notificação marcada como lida.")

    def notification_read_all(self):
        db = self._db()
        cur = db.execute("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (_now(), g.user["id"]))
        db.commit()
        return jsonify(message="Notificações marcadas como lidas.", changed=cur.rowcount)

    def _order_for_tracking(self, db, order_id):
        return db.execute("SELECT o.*,s.owner_id FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=?", (order_id,)).fetchone()

    def tracking_get(self, order_id):
        db = self._db()
        order = self._order_for_tracking(db, order_id)
        if not order or not self.ctx["can_access_order"](order):
            return self._error("Pedido não encontrado.", 404)
        events = db.execute("SELECT e.id,e.status,e.note,e.created_at,u.name actor_name,e.carrier,e.tracking_code FROM order_tracking_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.id", (order_id,)).fetchall()
        latest = next((event for event in reversed(events) if event["carrier"] or event["tracking_code"]), None)
        return jsonify(tracking={"carrier": latest["carrier"] if latest else "", "tracking_code": latest["tracking_code"] if latest else ""},
                       events=[{k: e[k] for k in ("id","status","note","created_at","actor_name")} for e in events])

    def tracking_post(self, order_id):
        db = self._db()
        order = self._order_for_tracking(db, order_id)
        if not order:
            return self._error("Pedido não encontrado.", 404)
        if g.user["role"] != "admin" and (g.user["role"] != "seller" or order["owner_id"] != g.user["id"]):
            return self._error("Pedido não encontrado.", 404)
        data, error = self._payload()
        if error:
            return error
        try:
            status = self._clean(data.get("status"), 30, True).lower()
            carrier = self._clean(data.get("carrier"), 120)
            tracking_code = self._clean(data.get("tracking_code"), 160)
            note = self._clean(data.get("note"), 1000)
            if status not in {"processing", "shipped", "completed", "cancelled"}:
                raise ValueError("Status de rastreio inválido.")
            if status == "shipped" and (not carrier or not tracking_code):
                raise ValueError("Envio exige transportadora e código de rastreio.")
            self.ctx["transition_order_status"](db, order, status, g.user["id"], carrier, tracking_code, note)
            db.commit()
            return jsonify(message="Rastreio e status atualizados.")
        except ValueError as exc:
            db.rollback()
            return self._error(exc, 409)
        except sqlite3.IntegrityError:
            db.rollback()
            return self._error("Transição concorrente; recarregue o pedido.", 409)

    def register_routes(self):
        login = self.ctx["login_required"]
        roles = self.ctx["roles_required"]
        routes = [
            ("/api/wallet", "feature_wallet_get", login(self.wallet_get), ["GET"]),
            ("/api/wallet/setup", "feature_wallet_setup", roles("buyer", "seller")(self.wallet_setup), ["POST"]),
            ("/api/wallet/addresses", "feature_wallet_new_address", login(self.wallet_new_address), ["POST"]),
            ("/api/wallet/transfers", "feature_transfer_create", roles("seller")(self.transfer_create), ["POST"]),
            ("/api/wallet/transfers/<int:transfer_id>/download", "feature_transfer_download", login(self.transfer_download), ["GET"]),
            ("/api/wallet/transfers/<int:transfer_id>/signed", "feature_transfer_signed", roles("seller")(self.transfer_signed), ["POST"]),
            ("/api/wallet/transfers/<int:transfer_id>/broadcast", "feature_transfer_broadcast", roles("seller")(self.transfer_broadcast), ["POST"]),
            ("/api/wallet/transfers/<int:transfer_id>/cancel", "feature_transfer_cancel", roles("seller")(self.transfer_cancel), ["POST"]),
            ("/api/notifications", "feature_notifications_list", login(self.notifications_list), ["GET"]),
            ("/api/notifications/<int:notification_id>/read", "feature_notification_read", login(self.notification_read), ["POST"]),
            ("/api/notifications/read-all", "feature_notifications_read_all", login(self.notification_read_all), ["POST"]),
            ("/api/orders/<int:order_id>/tracking", "feature_tracking_get", login(self.tracking_get), ["GET"]),
            ("/api/orders/<int:order_id>/tracking", "feature_tracking_post", roles("seller", "admin")(self.tracking_post), ["POST"]),
        ]
        for rule, endpoint, view, methods in routes:
            self.app.add_url_rule(rule, endpoint, view, methods=methods)


def install_marketplace_features(app, ctx):
    features = MarketplaceFeatures(app, ctx)
    features.register_routes()
    app.extensions["marketplace_features"] = features
    return features
