import base64
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from functools import wraps
from pathlib import Path

from flask import Flask, Response, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from marketplace_features import (
    init_marketplace_schema,
    install_marketplace_features,
    notify_order_parties,
    notify_user,
)


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", BASE_DIR / "marketplace.db"))
APP_SECRET = os.getenv("APP_SECRET", "troque-esta-chave-" + secrets.token_hex(24))
BTC_MODE = os.getenv("BTC_MODE", "demo").strip().lower()  # demo | rpc
BTC_NETWORK = os.getenv("BTC_NETWORK", "testnet").strip().lower()  # regtest | testnet | signet | main
BTC_RPC_URL = os.getenv("BTC_RPC_URL", "http://127.0.0.1:18332").rstrip("/")
BTC_RPC_USER = os.getenv("BTC_RPC_USER", "bitcoinrpc")
BTC_RPC_PASSWORD = os.getenv("BTC_RPC_PASSWORD", "troque-a-senha")
BTC_RPC_WALLET = os.getenv("BTC_RPC_WALLET", "marketplace")
ALLOW_MAINNET = os.getenv("ALLOW_MAINNET", "0") == "1"
ADMIN_ACTION_KEY = os.getenv("ADMIN_ACTION_KEY", "ALTERE-ESTA-CHAVE")
PLATFORM_FEE_BPS = max(0, min(3000, int(os.getenv("PLATFORM_FEE_BPS", "250"))))
MIN_CONFIRMATIONS = max(0, int(os.getenv("MIN_CONFIRMATIONS", "1")))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"
ENABLE_DEMO_SEED = os.getenv("ENABLE_DEMO_SEED", "0") == "1"

# V3: custódia, PSBT e Lightning
CUSTODY_MODE = os.getenv("CUSTODY_MODE", "demo").strip().lower()  # demo | multisig
BTC_ESCROW_WALLET = os.getenv("BTC_ESCROW_WALLET", "marketplace_escrow_watch")
BTC_COMMISSION_WALLET = os.getenv("BTC_COMMISSION_WALLET", "marketplace_commission")
COMMISSION_SIGNING_MODE = os.getenv("COMMISSION_SIGNING_MODE", "psbt").strip().lower()  # psbt | hot
PLATFORM_ESCROW_PUBKEY = os.getenv("PLATFORM_ESCROW_PUBKEY", "").strip()
PLATFORM_COMMISSION_ADDRESS = os.getenv("PLATFORM_COMMISSION_ADDRESS", "").strip()
PLATFORM_COMMISSION_DESCRIPTOR = os.getenv("PLATFORM_COMMISSION_DESCRIPTOR", "").strip()
PLATFORM_COMMISSION_CHANGE_DESCRIPTOR = os.getenv("PLATFORM_COMMISSION_CHANGE_DESCRIPTOR", "").strip()
PLATFORM_PAYOUT_DESCRIPTOR = os.getenv("PLATFORM_PAYOUT_DESCRIPTOR", "").strip()
PLATFORM_PAYOUT_CHANGE_DESCRIPTOR = os.getenv("PLATFORM_PAYOUT_CHANGE_DESCRIPTOR", "").strip()
PSBT_FEE_RATE = Decimal(os.getenv("PSBT_FEE_RATE", "2.0"))  # sat/vB

LN_MODE = os.getenv("LN_MODE", "off").strip().lower()  # off | demo | lnd | cln
LND_REST_URL = os.getenv("LND_REST_URL", "https://127.0.0.1:8080").rstrip("/")
LND_MACAROON_HEX = os.getenv("LND_MACAROON_HEX", "").strip()
LND_TLS_CERT = os.getenv("LND_TLS_CERT", "").strip()
LND_INSECURE_TLS = os.getenv("LND_INSECURE_TLS", "0") == "1"
CLN_REST_URL = os.getenv("CLN_REST_URL", "https://127.0.0.1:3010").rstrip("/")
CLN_RUNE = os.getenv("CLN_RUNE", "").strip()
LIGHTNING_WEBHOOK_SECRET = os.getenv("LIGHTNING_WEBHOOK_SECRET", "troque-o-segredo")
ENABLE_LIGHTNING_POLLER = os.getenv("ENABLE_LIGHTNING_POLLER", "0") == "1"
LIGHTNING_POLL_SECONDS = max(5, int(os.getenv("LIGHTNING_POLL_SECONDS", "15")))

app = Flask(__name__)
app.config.update(
    SECRET_KEY=APP_SECRET,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sats_to_btc(sats):
    return f"{Decimal(int(sats or 0)) / Decimal(100_000_000):.8f}"


def btc_to_sats(value):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite():
            raise InvalidOperation
        quantized = amount.quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError("Valor BTC inválido.")
    if amount < 0:
        raise ValueError("O valor não pode ser negativo.")
    if amount != quantized:
        raise ValueError("Valor BTC aceita no máximo oito casas decimais.")
    if amount > Decimal("21000000"):
        raise ValueError("Valor BTC excede o limite monetário.")
    return int(quantized * Decimal(100_000_000))


def request_json_object():
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError("Corpo JSON deve ser objeto.")
    return data


def clean_text(value, max_len=255, required=False):
    text = str(value or "").strip()
    if required and not text:
        raise ValueError("Campo obrigatório não preenchido.")
    return text[:max_len]


def slugify(value):
    value = clean_text(value, 80, True).lower()
    value = re.sub(r"[^a-z0-9à-ÿ]+", "-", value, flags=re.IGNORECASE)
    return re.sub(r"-+", "-", value).strip("-") or f"loja-{secrets.token_hex(3)}"


def clamp(value, low, high):
    return max(low, min(high, value))


# Utilitário mínimo de secp256k1 usado somente para gerar chaves públicas de demonstração.
# Em produção, as chaves privadas devem permanecer nas carteiras dos participantes.
_SECP_P = 2**256 - 2**32 - 977
_SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_SECP_G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _SECP_P == 0:
        return None
    if p1 == p2:
        slope = (3 * x1 * x1) * pow(2 * y1, _SECP_P - 2, _SECP_P)
    else:
        slope = (y2 - y1) * pow((x2 - x1) % _SECP_P, _SECP_P - 2, _SECP_P)
    slope %= _SECP_P
    x3 = (slope * slope - x1 - x2) % _SECP_P
    y3 = (slope * (x1 - x3) - y1) % _SECP_P
    return x3, y3


def _scalar_mult(k, point=_SECP_G):
    k %= _SECP_N
    result = None
    addend = point
    while k:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        k >>= 1
    return result


def demo_pubkey(seed):
    point = _scalar_mult(int(seed))
    prefix = "02" if point[1] % 2 == 0 else "03"
    return prefix + f"{point[0]:064x}"


def valid_compressed_pubkey(value):
    value = str(value or "").strip().lower()
    if not re.fullmatch(r"0[23][0-9a-f]{64}", value):
        return False
    try:
        x = int(value[2:], 16)
        y_sq = (pow(x, 3, _SECP_P) + 7) % _SECP_P
        y = pow(y_sq, (_SECP_P + 1) // 4, _SECP_P)
        return pow(y, 2, _SECP_P) == y_sq
    except Exception:
        return False


def platform_escrow_pubkey():
    key = PLATFORM_ESCROW_PUBKEY or (demo_pubkey(31) if CUSTODY_MODE == "demo" else "")
    if not valid_compressed_pubkey(key):
        raise RuntimeError("PLATFORM_ESCROW_PUBKEY não configurada ou inválida.")
    return key.lower()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def add_column_if_missing(db, table, column, definition):
    columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATABASE_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('buyer','seller','admin')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL UNIQUE,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            logo_url TEXT NOT NULL DEFAULT '',
            banner_url TEXT NOT NULL DEFAULT '',
            payout_address TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY(owner_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            short_description TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'Outros',
            image_url TEXT NOT NULL DEFAULT '',
            price_sats INTEGER NOT NULL CHECK(price_sats >= 1),
            compare_at_sats INTEGER NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
            sales_count INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY(store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS cart_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
            UNIQUE(user_id,product_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS settlement_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'draft',
            total_sats INTEGER NOT NULL DEFAULT 0,
            destination_count INTEGER NOT NULL DEFAULT 0,
            txid TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_by INTEGER,
            created_at TEXT NOT NULL,
            executed_at TEXT,
            FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            buyer_id INTEGER NOT NULL,
            store_id INTEGER NOT NULL,
            reference TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'awaiting_payment',
            payment_address TEXT NOT NULL,
            total_sats INTEGER NOT NULL,
            platform_fee_sats INTEGER NOT NULL,
            seller_net_sats INTEGER NOT NULL,
            paid_sats INTEGER NOT NULL DEFAULT 0,
            confirmations INTEGER NOT NULL DEFAULT 0,
            txid TEXT NOT NULL DEFAULT '',
            shipping_name TEXT NOT NULL,
            shipping_address TEXT NOT NULL,
            shipping_city TEXT NOT NULL,
            shipping_state TEXT NOT NULL,
            shipping_zip TEXT NOT NULL,
            buyer_refund_address TEXT NOT NULL DEFAULT '',
            payout_txid TEXT NOT NULL DEFAULT '',
            refund_txid TEXT NOT NULL DEFAULT '',
            settlement_batch_id INTEGER,
            created_at TEXT NOT NULL,
            paid_at TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(buyer_id) REFERENCES users(id),
            FOREIGN KEY(store_id) REFERENCES stores(id),
            FOREIGN KEY(settlement_batch_id) REFERENCES settlement_batches(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER,
            product_name TEXT NOT NULL,
            unit_price_sats INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            buyer_id INTEGER NOT NULL,
            store_id INTEGER NOT NULL,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            title TEXT NOT NULL DEFAULT '',
            comment TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(order_id,product_id),
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY(buyer_id) REFERENCES users(id),
            FOREIGN KEY(store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS disputes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            opened_by INTEGER NOT NULL,
            reason TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            resolution TEXT NOT NULL DEFAULT '',
            admin_note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(opened_by) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS dispute_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dispute_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(dispute_id) REFERENCES disputes(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS settlement_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            store_id INTEGER NOT NULL,
            amount_sats INTEGER NOT NULL,
            payout_address TEXT NOT NULL,
            order_ids_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            txid TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(batch_id) REFERENCES settlement_batches(id) ON DELETE CASCADE,
            FOREIGN KEY(store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS treasury_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            address TEXT NOT NULL UNIQUE,
            weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 1),
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wallet_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            event_type TEXT NOT NULL,
            amount_sats INTEGER NOT NULL DEFAULT 0,
            address TEXT NOT NULL DEFAULT '',
            txid TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'recorded',
            details TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL DEFAULT '',
            target_id TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
        CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);
        CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id);
        CREATE INDEX IF NOT EXISTS idx_settlement_items_batch ON settlement_items(batch_id);
        """
    )
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS psbt_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            reference TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('release','refund')),
            status TEXT NOT NULL DEFAULT 'draft',
            psbt_base64 TEXT NOT NULL,
            combined_psbt TEXT NOT NULL DEFAULT '',
            final_hex TEXT NOT NULL DEFAULT '',
            txid TEXT NOT NULL DEFAULT '',
            seller_address TEXT NOT NULL DEFAULT '',
            buyer_address TEXT NOT NULL DEFAULT '',
            commission_address TEXT NOT NULL DEFAULT '',
            total_input_sats INTEGER NOT NULL DEFAULT 0,
            seller_amount_sats INTEGER NOT NULL DEFAULT 0,
            commission_sats INTEGER NOT NULL DEFAULT 0,
            network_fee_sats INTEGER NOT NULL DEFAULT 0,
            signers_json TEXT NOT NULL DEFAULT '[]',
            created_by INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS lightning_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payment_hash TEXT NOT NULL DEFAULT '',
            amount_sats INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS commission_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference TEXT NOT NULL UNIQUE,
            mode TEXT NOT NULL,
            destination TEXT NOT NULL,
            amount_sats INTEGER NOT NULL,
            psbt_base64 TEXT NOT NULL DEFAULT '',
            final_hex TEXT NOT NULL DEFAULT '',
            txid TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft',
            created_by INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_psbt_order ON psbt_proposals(order_id);
        CREATE INDEX IF NOT EXISTS idx_lightning_order ON lightning_events(order_id);
        """
    )
    # Compatibilidade com a primeira versão do projeto.
    add_column_if_missing(db, "stores", "logo_url", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "stores", "banner_url", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "products", "short_description", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "products", "compare_at_sats", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(db, "products", "sales_count", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(db, "orders", "settlement_batch_id", "INTEGER")
    add_column_if_missing(db, "users", "bitcoin_pubkey", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "stores", "escrow_pubkey", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "payment_method", "TEXT NOT NULL DEFAULT 'onchain_multisig'")
    add_column_if_missing(db, "orders", "custody_model", "TEXT NOT NULL DEFAULT 'noncustodial_2of3'")
    add_column_if_missing(db, "orders", "escrow_descriptor", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "escrow_redeem_script", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "escrow_witness_script", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "buyer_pubkey", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "seller_pubkey", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "platform_pubkey", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "commission_address", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "lightning_invoice", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "lightning_hash", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "lightning_status", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "orders", "lightning_provider", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "settlement_batches", "psbt_base64", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "settlement_batches", "final_hex", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing(db, "settlement_batches", "signing_mode", "TEXT NOT NULL DEFAULT 'psbt'")
    add_column_if_missing(db, "settlement_batches", "updated_at", "TEXT")
    init_marketplace_schema(db, MIN_CONFIRMATIONS)
    db.commit()
    if ENABLE_DEMO_SEED and BTC_MODE == "demo" and CUSTODY_MODE == "demo" and LN_MODE in {"off", "demo"}:
        seed_demo_data(db)
    db.close()


def seed_demo_data(db):
    if not (ENABLE_DEMO_SEED and BTC_MODE == "demo" and CUSTODY_MODE == "demo" and LN_MODE in {"off", "demo"}):
        return
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        return
    created = now_iso()
    users = [
        ("Administrador", "admin@demo.local", generate_password_hash("Admin123!"), "admin", created),
        ("Nakamoto Tech", "vendedor@demo.local", generate_password_hash("Vendedor123!"), "seller", created),
        ("Casa Satoshi", "vendedor2@demo.local", generate_password_hash("Vendedor123!"), "seller", created),
        ("Cliente Teste", "comprador@demo.local", generate_password_hash("Comprador123!"), "buyer", created),
    ]
    db.executemany("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)", users)
    seller1 = db.execute("SELECT id FROM users WHERE email='vendedor@demo.local'").fetchone()[0]
    seller2 = db.execute("SELECT id FROM users WHERE email='vendedor2@demo.local'").fetchone()[0]
    db.executemany(
        "INSERT INTO stores(owner_id,name,slug,description,payout_address,created_at) VALUES(?,?,?,?,?,?)",
        [
            (seller1, "Nakamoto Tech", "nakamoto-tech", "Tecnologia, periféricos e produtos selecionados para setups modernos.", "", created),
            (seller2, "Casa Satoshi", "casa-satoshi", "Itens para casa, viagem e rotina com pagamento em Bitcoin.", "", created),
        ],
    )
    s1 = db.execute("SELECT id FROM stores WHERE owner_id=?", (seller1,)).fetchone()[0]
    s2 = db.execute("SELECT id FROM stores WHERE owner_id=?", (seller2,)).fetchone()[0]
    products = [
        (s1, "Headset Gamer Orbit X", "Áudio imersivo e microfone removível.", "Som imersivo, microfone removível, conexão USB e construção leve.", "Periféricos", "", 145000, 189000, 18, created),
        (s1, "Teclado Mecânico Neon 75%", "Compacto, tátil e com iluminação RGB.", "Switches táteis, estrutura reforçada, conexão USB-C e keycaps duráveis.", "Periféricos", "", 225000, 279000, 12, created),
        (s1, "SSD NVMe 1 TB", "Armazenamento veloz para desktop e notebook.", "Unidade NVMe de alto desempenho, ideal para sistema, jogos e produtividade.", "Hardware", "", 310000, 349000, 9, created),
        (s1, "Smartwatch Pulse Pro", "Monitoramento esportivo e bateria longa.", "Tela brilhante, notificações, atividades esportivas e autonomia prolongada.", "Wearables", "", 198000, 249000, 20, created),
        (s2, "Mochila Urbana Vault", "Organização, conforto e espaço para notebook.", "Compartimento acolchoado, tecido resistente à água e bolsos de acesso rápido.", "Acessórios", "", 129000, 159000, 25, created),
        (s2, "Luminária Halo Desk", "Luz regulável para trabalho e estudo.", "Controle de intensidade, três temperaturas de cor e carregamento USB.", "Casa", "", 99000, 119000, 17, created),
        (s2, "Garrafa Térmica Block 750", "Bebida fria ou quente por mais tempo.", "Corpo em aço inoxidável, tampa de vedação e acabamento fosco.", "Casa", "", 74000, 89000, 34, created),
        (s2, "Organizador Modular Grid", "Módulos versáteis para sua mesa.", "Conjunto modular para cabos, pequenos objetos e acessórios de trabalho.", "Organização", "", 56000, 69000, 40, created),
    ]
    db.executemany(
        """INSERT INTO products(store_id,name,short_description,description,category,image_url,price_sats,compare_at_sats,stock,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        products,
    )
    buyer_id = db.execute("SELECT id FROM users WHERE email='comprador@demo.local'").fetchone()[0]
    db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (demo_pubkey(11), buyer_id))
    db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (demo_pubkey(12), seller1))
    db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (demo_pubkey(13), seller2))
    db.execute("UPDATE stores SET escrow_pubkey=? WHERE id=?", (demo_pubkey(21), s1))
    db.execute("UPDATE stores SET escrow_pubkey=? WHERE id=?", (demo_pubkey(22), s2))
    db.commit()


class BitcoinRPC:
    def __init__(self, wallet_name=BTC_RPC_WALLET):
        self.wallet_name = wallet_name
        wallet_part = f"/wallet/{urllib.parse.quote(wallet_name)}" if wallet_name else ""
        self.url = f"{BTC_RPC_URL}{wallet_part}"

    def call(self, method, params=None):
        payload = json.dumps({"jsonrpc": "2.0", "id": secrets.token_hex(6), "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url, data=payload, method="POST")
        token = base64.b64encode(f"{BTC_RPC_USER}:{BTC_RPC_PASSWORD}".encode()).decode()
        req.add_header("Authorization", "Basic " + token)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                data = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Bitcoin Core respondeu HTTP {exc.code}: {detail[:500]}")
        except Exception as exc:
            raise RuntimeError(f"Falha ao conectar ao Bitcoin Core: {exc}")
        if data.get("error"):
            raise RuntimeError(data["error"].get("message", "Erro RPC desconhecido"))
        return data.get("result")

    def ensure_safe_network(self):
        chain = self.call("getblockchaininfo").get("chain")
        expected = {"mainnet": "main", "main": "main"}.get(BTC_NETWORK, BTC_NETWORK)
        if chain != expected:
            raise RuntimeError(f"Rede do nó ({chain}) difere de BTC_NETWORK ({expected}).")
        if chain == "main" and not ALLOW_MAINNET:
            raise RuntimeError("Mainnet bloqueada. Use testnet/regtest ou habilite ALLOW_MAINNET conscientemente.")
        return chain

    def ensure_wallet(self, disable_private_keys=False):
        root = BitcoinRPC(None)
        root.ensure_safe_network()
        loaded = root.call("listwallets")
        if self.wallet_name in loaded:
            return self.wallet_name
        wallet_dir = {row.get("name") for row in root.call("listwalletdir").get("wallets", [])}
        if self.wallet_name in wallet_dir:
            root.call("loadwallet", [self.wallet_name])
        else:
            root.call("createwallet", {
                "wallet_name": self.wallet_name,
                "disable_private_keys": bool(disable_private_keys),
                "blank": False,
                "descriptors": True,
                "load_on_startup": True,
            })
        return self.wallet_name

    def new_address(self, label):
        self.ensure_safe_network()
        return self.call("getnewaddress", [label, "bech32"])

    def validate_address(self, address):
        return bool(self.call("validateaddress", [address]).get("isvalid"))

    def received_sats(self, address, minconf=1):
        return btc_to_sats(self.call("getreceivedbyaddress", [address, int(minconf)]))

    def balances(self):
        info = self.call("getbalances")
        mine = info.get("mine", {})
        watch = info.get("watchonly", {})
        return {
            "trusted_sats": btc_to_sats(mine.get("trusted", 0)),
            "pending_sats": btc_to_sats(mine.get("untrusted_pending", 0)),
            "immature_sats": btc_to_sats(mine.get("immature", 0)),
            "watch_trusted_sats": btc_to_sats(watch.get("trusted", 0)),
            "watch_pending_sats": btc_to_sats(watch.get("untrusted_pending", 0)),
        }

    def utxo_stats(self, addresses=None):
        rows = self.call("listunspent", [MIN_CONFIRMATIONS, 9999999, addresses or [], True])
        total = sum(btc_to_sats(row.get("amount", 0)) for row in rows)
        return {"count": len(rows), "total_sats": total, "rows": rows}

    def send_to(self, destination, amount_sats, comment):
        self.ensure_safe_network()
        if not self.validate_address(destination):
            raise ValueError("Endereço de destino inválido para a rede configurada.")
        return self.call("sendtoaddress", [destination, sats_to_btc(amount_sats), comment, "", False, True])

    def send_many(self, outputs, comment):
        self.ensure_safe_network()
        if not outputs:
            raise ValueError("Nenhum destino informado.")
        normalized = {}
        for address, sats in outputs.items():
            if not self.validate_address(address):
                raise ValueError(f"Endereço inválido: {address}")
            normalized[address] = sats_to_btc(sats)
        result = self.call("sendmany", {
            "dummy": "", "amounts": normalized, "minconf": MIN_CONFIRMATIONS,
            "comment": comment, "subtractfeefrom": [], "replaceable": True,
            "conf_target": 6, "estimate_mode": "conservative", "verbose": True,
        })
        return result.get("txid") if isinstance(result, dict) else str(result)

    def send_all(self, destination):
        self.ensure_safe_network()
        if not self.validate_address(destination):
            raise ValueError("Endereço de destino inválido para a rede configurada.")
        result = self.call("sendall", {
            "recipients": [destination], "estimate_mode": "conservative",
            "options": {"minconf": MIN_CONFIRMATIONS, "send_max": True},
        })
        return result.get("txid") if isinstance(result, dict) else str(result)

    def create_multisig(self, reference, pubkeys):
        self.ensure_wallet(disable_private_keys=True)
        if len(pubkeys) != 3 or any(not valid_compressed_pubkey(k) for k in pubkeys):
            raise ValueError("São necessárias três chaves públicas secp256k1 comprimidas válidas.")
        result = self.call("createmultisig", [2, pubkeys, "bech32"])
        descriptor = result.get("descriptor", "")
        if not descriptor:
            raise RuntimeError("Bitcoin Core não retornou o descriptor multisig.")
        imported = self.call("importdescriptors", [[{
            "desc": descriptor,
            "timestamp": "now",
            "active": False,
            "internal": False,
            "label": reference,
        }]])
        if not imported or not imported[0].get("success"):
            raise RuntimeError(f"Falha ao importar descriptor: {imported}")
        return {
            "address": result["address"],
            "descriptor": descriptor,
            "redeem_script": result.get("redeemScript", ""),
            "witness_script": result.get("witnessScript", ""),
        }

    def create_spend_psbt(self, order, kind, seller_address, buyer_address, commission_address):
        self.ensure_safe_network()
        utxos = self.call("listunspent", [0, 9999999, [order["payment_address"]], True])
        if not utxos:
            raise ValueError("Nenhum UTXO encontrado no endereço escrow deste pedido.")
        total_input = sum(btc_to_sats(u["amount"]) for u in utxos)
        if total_input < order["total_sats"]:
            raise ValueError("O escrow ainda não recebeu o valor total do pedido.")
        inputs = [{"txid": u["txid"], "vout": u["vout"], "sequence": 0xFFFFFFFD} for u in utxos]
        outputs = []
        subtract_index = 0
        if kind == "release":
            if not self.validate_address(seller_address):
                raise ValueError("Endereço de recebimento do vendedor inválido.")
            if not self.validate_address(commission_address):
                raise ValueError("Endereço de comissão inválido.")
            seller_amount = order["seller_net_sats"]
            commission = order["platform_fee_sats"]
            outputs = [{seller_address: sats_to_btc(seller_amount)}, {commission_address: sats_to_btc(commission)}]
            excess = total_input - seller_amount - commission
            if excess > 0:
                if not buyer_address or not self.validate_address(buyer_address):
                    raise ValueError("Há pagamento excedente; informe um endereço de reembolso válido.")
                outputs.append({buyer_address: sats_to_btc(excess)})
        else:
            if not buyer_address or not self.validate_address(buyer_address):
                raise ValueError("Endereço de reembolso do comprador inválido.")
            seller_amount = 0
            commission = 0
            outputs = [{buyer_address: sats_to_btc(total_input)}]
        result = self.call("walletcreatefundedpsbt", [
            inputs,
            outputs,
            0,
            {
                "add_inputs": False,
                "includeWatching": True,
                "subtractFeeFromOutputs": [subtract_index],
                "replaceable": True,
                "fee_rate": float(PSBT_FEE_RATE),
            },
            True,
        ])
        processed = self.call("walletprocesspsbt", [result["psbt"], False, "ALL", True])
        return {
            "psbt": processed.get("psbt", result["psbt"]),
            "fee_sats": btc_to_sats(result.get("fee", 0)),
            "total_input_sats": total_input,
            "seller_amount_sats": seller_amount,
            "commission_sats": commission,
        }

    def combine_and_finalize(self, psbts):
        combined = self.call("combinepsbt", [psbts]) if len(psbts) > 1 else psbts[0]
        analysis = self.call("analyzepsbt", [combined])
        final = self.call("finalizepsbt", [combined, True])
        return {
            "combined": combined,
            "analysis": analysis,
            "complete": bool(final.get("complete")),
            "hex": final.get("hex", ""),
        }

    def broadcast_raw(self, tx_hex):
        self.ensure_safe_network()
        return self.call("sendrawtransaction", [tx_hex])

    def create_wallet_psbt(self, destination, amount_sats):
        self.ensure_safe_network()
        if not self.validate_address(destination):
            raise ValueError("Endereço de destino inválido.")
        result = self.call("walletcreatefundedpsbt", [
            [], [{destination: sats_to_btc(amount_sats)}], 0,
            {"subtractFeeFromOutputs": [0], "replaceable": True, "fee_rate": float(PSBT_FEE_RATE)},
            True,
        ])
        return result


rpc = BitcoinRPC(BTC_RPC_WALLET)
escrow_rpc = BitcoinRPC(BTC_ESCROW_WALLET)
commission_rpc = BitcoinRPC(BTC_COMMISSION_WALLET)


class LightningClient:
    def _request(self, url, method="GET", payload=None, headers=None, ssl_context=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=20, context=ssl_context) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Lightning respondeu HTTP {exc.code}: {detail[:500]}")
        except Exception as exc:
            raise RuntimeError(f"Falha ao conectar ao nó Lightning: {exc}")

    def _lnd_context(self):
        if LND_INSECURE_TLS:
            return ssl._create_unverified_context()
        return ssl.create_default_context(cafile=LND_TLS_CERT or None)

    def create_invoice(self, amount_sats, reference):
        if LN_MODE == "demo":
            payment_hash = secrets.token_hex(32)
            return {
                "provider": "demo",
                "payment_hash": payment_hash,
                "invoice": f"lntb{amount_sats}n1demo{payment_hash}",
                "status": "OPEN",
            }
        if LN_MODE == "lnd":
            if not LND_MACAROON_HEX:
                raise RuntimeError("LND_MACAROON_HEX não configurado.")
            data = self._request(
                f"{LND_REST_URL}/v1/invoices",
                "POST",
                {"value": str(amount_sats), "memo": reference, "expiry": "3600", "private": True},
                {"Grpc-Metadata-macaroon": LND_MACAROON_HEX},
                self._lnd_context(),
            )
            payment_hash = base64.b64decode(data["r_hash"]).hex()
            return {"provider": "lnd", "payment_hash": payment_hash, "invoice": data["payment_request"], "status": "OPEN"}
        if LN_MODE == "cln":
            if not CLN_RUNE:
                raise RuntimeError("CLN_RUNE não configurado.")
            data = self._request(
                f"{CLN_REST_URL}/v1/invoice",
                "POST",
                {"amount_msat": amount_sats * 1000, "label": reference, "description": reference, "expiry": 3600},
                {"Rune": CLN_RUNE},
            )
            return {"provider": "cln", "payment_hash": data.get("payment_hash", ""), "invoice": data["bolt11"], "status": "OPEN"}
        raise ValueError("Lightning está desativado.")

    def lookup(self, order):
        provider = order["lightning_provider"]
        if provider == "demo":
            return {"state": order["lightning_status"] or "OPEN", "paid_sats": order["paid_sats"]}
        if provider == "lnd":
            data = self._request(
                f"{LND_REST_URL}/v1/invoice/{order['lightning_hash']}",
                "GET",
                headers={"Grpc-Metadata-macaroon": LND_MACAROON_HEX},
                ssl_context=self._lnd_context(),
            )
            return {"state": data.get("state", "OPEN"), "paid_sats": int(data.get("amt_paid_sat") or 0), "raw": data}
        if provider == "cln":
            data = self._request(
                f"{CLN_REST_URL}/v1/listinvoices",
                "POST",
                {"label": order["reference"]},
                {"Rune": CLN_RUNE},
            )
            rows = data.get("invoices", [])
            row = rows[0] if rows else {}
            amount_msat = row.get("amount_received_msat", 0)
            if isinstance(amount_msat, dict):
                amount_msat = amount_msat.get("msat", 0)
            return {"state": str(row.get("status", "unpaid")).upper(), "paid_sats": int(amount_msat or 0) // 1000, "raw": row}
        raise RuntimeError("Provedor Lightning do pedido não é suportado.")


lightning = LightningClient()


def ensure_descriptor_wallet(client, external_descriptor, internal_descriptor="", label="watchonly"):
    client.ensure_wallet(disable_private_keys=True)
    if not external_descriptor:
        raise RuntimeError(f"Descriptor externo da carteira {label} não configurado.")
    imports = [{"desc": external_descriptor, "timestamp": "now", "active": True, "internal": False}]
    if internal_descriptor:
        imports.append({"desc": internal_descriptor, "timestamp": "now", "active": True, "internal": True})
    result = client.call("importdescriptors", [imports])
    failures = [row for row in result if not row.get("success") and "already exists" not in str(row.get("error", "")).lower()]
    if failures:
        raise RuntimeError(f"Falha ao importar descriptors da carteira {label}: {failures}")
    return True


def ensure_commission_wallet():
    if BTC_MODE != "rpc":
        return True
    if COMMISSION_SIGNING_MODE == "hot":
        commission_rpc.ensure_wallet(disable_private_keys=False)
        return True
    return ensure_descriptor_wallet(
        commission_rpc,
        PLATFORM_COMMISSION_DESCRIPTOR,
        PLATFORM_COMMISSION_CHANGE_DESCRIPTOR,
        "commission",
    )


def ensure_payout_wallet():
    if BTC_MODE != "rpc":
        return True
    return ensure_descriptor_wallet(
        rpc,
        PLATFORM_PAYOUT_DESCRIPTOR,
        PLATFORM_PAYOUT_CHANGE_DESCRIPTOR,
        "payout",
    )


def commission_address_for_order(reference):
    if BTC_MODE == "rpc":
        if PLATFORM_COMMISSION_ADDRESS:
            if not commission_rpc.validate_address(PLATFORM_COMMISSION_ADDRESS):
                raise ValueError("PLATFORM_COMMISSION_ADDRESS inválido.")
            return PLATFORM_COMMISSION_ADDRESS
        ensure_commission_wallet()
        return commission_rpc.new_address(f"commission_{reference}")
    return demo_address(f"commission_{reference}")


def create_multisig_escrow(reference, buyer_pubkey, seller_pubkey):
    platform_key = platform_escrow_pubkey()
    keys = [buyer_pubkey.lower(), seller_pubkey.lower(), platform_key]
    if len(set(keys)) != 3:
        raise ValueError("As três chaves públicas do escrow devem ser diferentes.")
    if CUSTODY_MODE == "demo" or BTC_MODE != "rpc":
        descriptor = f"wsh(sortedmulti(2,{','.join(keys)}))"
        return {
            "address": demo_address(f"msig_{reference}"),
            "descriptor": descriptor,
            "redeem_script": "",
            "witness_script": "demo_witness_" + secrets.token_hex(32),
            "platform_pubkey": platform_key,
        }
    result = escrow_rpc.create_multisig(reference, keys)
    result["platform_pubkey"] = platform_key
    return result


def encode_demo_psbt(payload):
    return base64.b64encode(json.dumps(payload, sort_keys=True).encode()).decode()


def participant_role_for_order(db, order, user):
    if not user:
        return ""
    if user["role"] == "admin":
        return "platform"
    if order["buyer_id"] == user["id"]:
        return "buyer"
    store = db.execute("SELECT owner_id FROM stores WHERE id=?", (order["store_id"],)).fetchone()
    if store and store["owner_id"] == user["id"]:
        return "seller"
    return ""


def serialize_psbt(row):
    data = dict(row)
    for key in ("total_input_sats", "seller_amount_sats", "commission_sats", "network_fee_sats"):
        data[key.replace("_sats", "_btc")] = sats_to_btc(data[key])
    data["signers"] = json.loads(data.get("signers_json") or "[]")
    return data


def mark_lightning_settled(db, order, paid_sats, payload=None):
    paid_sats = max(0, int(paid_sats or 0))
    if order["status"] in {"cancelled", "refunded"}:
        return False
    funded = paid_sats >= int(order["total_sats"])
    next_status = order["status"]
    if order["status"] in {"awaiting_payment", "partial"}:
        next_status = "paid" if funded else ("partial" if paid_sats else "awaiting_payment")
    if (paid_sats == int(order["paid_sats"] or 0) and order["lightning_status"] == "SETTLED" and next_status == order["status"]):
        return False
    db.execute(
        "UPDATE orders SET paid_sats=?,status=?,lightning_status='SETTLED',paid_at=CASE WHEN ? THEN COALESCE(paid_at,?) ELSE paid_at END,updated_at=? WHERE id=?",
        (paid_sats, next_status, 1 if funded else 0, now_iso(), now_iso(), order["id"]),
    )
    db.execute(
        "INSERT INTO lightning_events(order_id,provider,event_type,payment_hash,amount_sats,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
        (order["id"], order["lightning_provider"], "invoice_settled" if funded else "invoice_underpaid", order["lightning_hash"], paid_sats, json.dumps({"state": "SETTLED", "paid_sats": paid_sats}), now_iso()),
    )
    if funded and order["status"] in {"awaiting_payment", "partial"}:
        notify_order_parties(db, order["id"], "payment", "Pagamento confirmado", "Pagamento integral confirmado.", "payment:confirmed")
    return True



def get_current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return get_db().execute("SELECT id,name,email,role,active,created_at,bitcoin_pubkey FROM users WHERE id=?", (user_id,)).fetchone()


@app.before_request
def load_user_and_csrf():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(24)
    g.user = get_current_user()
    if request.path == "/api/lightning/webhook":
        return None
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        supplied = request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf_token", "")
        if not supplied or not hmac.compare_digest(supplied, expected):
            return jsonify(error="Token CSRF inválido. Recarregue a página."), 403


@app.after_request
def security_response_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


def api_error(message, status=400):
    return jsonify(error=str(message)), status


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not g.user:
            return api_error("Faça login para continuar.", 401)
        if not g.user["active"]:
            session.clear()
            return api_error("Conta desativada.", 403)
        return fn(*args, **kwargs)
    return wrapper


def roles_required(*roles):
    def decorator(fn):
        @wraps(fn)
        @login_required
        def wrapper(*args, **kwargs):
            if g.user["role"] not in roles:
                return api_error("Você não tem permissão para esta ação.", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def require_admin_action(data, phrase):
    if not hmac.compare_digest(str(data.get("action_key", "")), ADMIN_ACTION_KEY):
        raise PermissionError("Chave administrativa inválida.")
    if str(data.get("confirm", "")).strip().upper() != phrase.upper():
        raise PermissionError(f'Digite exatamente "{phrase}" para confirmar.')


def log_action(action, target_type="", target_id="", details=""):
    db = get_db()
    db.execute(
        "INSERT INTO audit_logs(user_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?)",
        (g.user["id"] if g.user else None, action, target_type, str(target_id), clean_text(details, 1500), now_iso()),
    )
    db.commit()


def serialize_user(row):
    if not row:
        return None
    keys = ("id", "name", "email", "role", "active", "created_at", "bitcoin_pubkey")
    return {k: row[k] for k in keys if k in row.keys()}


def store_stats(db, store_id):
    rating = db.execute("SELECT COUNT(*) c,COALESCE(AVG(rating),0) avg FROM verified_reviews WHERE store_id=?", (store_id,)).fetchone()
    orders = db.execute(
        """SELECT COUNT(*) total,
                  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
                  SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled
           FROM orders WHERE store_id=? AND status NOT IN ('awaiting_payment','partial')""",
        (store_id,),
    ).fetchone()
    disputes = db.execute(
        "SELECT COUNT(*) FROM disputes d JOIN orders o ON o.id=d.order_id WHERE o.store_id=?",
        (store_id,),
    ).fetchone()[0]
    total = int(orders["total"] or 0)
    completed = int(orders["completed"] or 0)
    cancelled = int(orders["cancelled"] or 0)
    avg = float(rating["avg"] or 0)
    review_count = int(rating["c"] or 0)
    completion_rate = completed / total if total else 1.0
    cancel_rate = cancelled / total if total else 0.0
    dispute_rate = disputes / total if total else 0.0
    score = 50 + (avg / 5 * 30 if review_count else 15) + completion_rate * 15 + min(math.log10(total + 1) * 5, 5) - cancel_rate * 20 - dispute_rate * 25
    score = round(clamp(score, 0, 100), 1)
    if score >= 80:
        tier, payout_rule = "Excelente", "Pedidos enviados ou concluídos"
    elif score >= 60:
        tier, payout_rule = "Confiável", "Pedidos concluídos"
    else:
        tier, payout_rule = "Em observação", "Revisão manual do administrador"
    return {
        "score": score,
        "tier": tier,
        "payout_rule": payout_rule,
        "rating": round(avg, 1),
        "review_count": review_count,
        "orders_count": total,
        "completed_count": completed,
        "disputes_count": disputes,
        "completion_rate": round(completion_rate * 100, 1),
    }


def serialize_store(row, db=None):
    if not row:
        return None
    db = db or get_db()
    data = dict(row)
    owner_id = data.get("owner_id")
    if owner_id is None:
        owner = db.execute("SELECT owner_id FROM stores WHERE id=?", (data["id"],)).fetchone()
        owner_id = owner["owner_id"] if owner else None
    if not g.user or (g.user["role"] != "admin" and g.user["id"] != owner_id):
        data.pop("payout_address", None)
        data.pop("escrow_pubkey", None)
    data.update(store_stats(db, data["id"]))
    return data


def serialize_public_review(row):
    return {
        "id": row["id"],
        "rating": row["rating"],
        "title": row["title"],
        "comment": row["comment"],
        "created_at": row["created_at"],
        "buyer_name": row["buyer_name"],
        "product_name": row["product_name"] if "product_name" in row.keys() else "",
        "purchase_verified": True,
    }


def order_is_funded(order):
    if int(order["paid_sats"] or 0) < int(order["total_sats"] or 0) or not order["paid_at"]:
        return False
    if order["payment_method"] == "lightning":
        return order["lightning_status"] == "SETTLED"
    return int(order["confirmations"] or 0) >= max(1, MIN_CONFIRMATIONS)


def transition_order_status(db, order, status, actor_id, carrier="", tracking_code="", note=""):
    current = db.execute("SELECT * FROM orders WHERE id=?", (order["id"],)).fetchone()
    if not current:
        raise ValueError("Pedido não encontrado.")
    if status == "cancelled":
        if current["status"] != "awaiting_payment" or current["paid_sats"] != 0 or current["paid_at"] or current["refund_txid"]:
            raise ValueError("Cancelamento permitido somente antes de qualquer pagamento.")
        if BTC_MODE == "rpc" and current["payment_method"] in {"lightning", "onchain_multisig"}:
            raise ValueError("Pedido com invoice ou endereço on-chain ativo exige expiração/reconciliação antes do cancelamento.")
        db.execute("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?", (now_iso(), current["id"]))
        items = db.execute("SELECT product_id,quantity FROM order_items WHERE order_id=? AND product_id IS NOT NULL", (current["id"],)).fetchall()
        for item in items:
            db.execute("UPDATE products SET stock=stock+?,sales_count=MAX(0,sales_count-?) WHERE id=?", (item["quantity"], item["quantity"], item["product_id"]))
    else:
        next_status = {"paid": "processing", "processing": "shipped", "shipped": "completed"}
        if status not in next_status.values() or next_status.get(current["status"]) != status:
            raise ValueError("Transição de status fora do fluxo permitido.")
        if not order_is_funded(current):
            raise ValueError("Pedido exige pagamento integral confirmado antes do fulfillment.")
        if status == "completed" and order_has_open_dispute(db, current["id"]):
            raise ValueError("Há uma disputa aberta neste pedido.")
        if status == "shipped" and (not carrier or not tracking_code):
            raise ValueError("Envio exige transportadora e código de rastreio.")
        db.execute("UPDATE orders SET status=?,updated_at=? WHERE id=?", (status, now_iso(), current["id"]))
    event = db.execute(
        """INSERT INTO order_tracking_events(order_id,status,carrier,tracking_code,note,actor_id,created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (current["id"], status, carrier, tracking_code, note, actor_id, now_iso()),
    )
    notify_order_parties(db, current["id"], "tracking", "Atualização do pedido", f"Status do pedido: {status}.", f"tracking:{event.lastrowid}:{status}")


def serialize_product(row):
    data = dict(row)
    data["price_btc"] = sats_to_btc(data["price_sats"])
    data["compare_at_btc"] = sats_to_btc(data.get("compare_at_sats", 0))
    if data.get("review_count") is None:
        data["review_count"] = 0
    if data.get("rating") is None:
        data["rating"] = 0
    return data


def serialize_order(row, include_items=True):
    data = dict(row)
    for key in ("total_sats", "platform_fee_sats", "seller_net_sats", "paid_sats"):
        data[key.replace("_sats", "_btc")] = sats_to_btc(data[key])
    if include_items:
        items = get_db().execute("SELECT * FROM order_items WHERE order_id=? ORDER BY id", (data["id"],)).fetchall()
        data["items"] = []
        for item in items:
            x = dict(item)
            x["unit_price_btc"] = sats_to_btc(x["unit_price_sats"])
            data["items"].append(x)
    return data


def demo_address(label):
    return f"demo_{BTC_NETWORK}_" + secrets.token_hex(18)


def generate_payment_address(reference):
    return rpc.new_address(f"order_{reference}") if BTC_MODE == "rpc" else demo_address(reference)


def can_access_order(order):
    if not g.user:
        return False
    if g.user["role"] == "admin" or order["buyer_id"] == g.user["id"]:
        return True
    if g.user["role"] == "seller":
        store = get_db().execute("SELECT id FROM stores WHERE owner_id=?", (g.user["id"],)).fetchone()
        return bool(store and store["id"] == order["store_id"])
    return False


def order_has_open_dispute(db, order_id):
    return bool(db.execute("SELECT 1 FROM disputes WHERE order_id=? AND status IN ('open','under_review')", (order_id,)).fetchone())


def eligible_order_for_settlement(db, order, stats):
    # Pedidos multisig são liquidados diretamente por PSBT; nunca entram na carteira operacional.
    if order["payment_method"] == "onchain_multisig":
        return False
    if order["payout_txid"] or order["settlement_batch_id"] or order_has_open_dispute(db, order["id"]):
        return False
    if stats["score"] >= 80:
        return order["status"] in {"shipped", "completed"}
    if stats["score"] >= 60:
        return order["status"] == "completed"
    return False


@app.route("/")
def index():
    return render_template("index.html", csrf_token=session.get("csrf_token", ""), btc_mode=BTC_MODE, btc_network=BTC_NETWORK, platform_fee=f"{PLATFORM_FEE_BPS/100:.2f}")


@app.get("/api/bootstrap")
def bootstrap():
    cart_count = 0
    if g.user:
        cart_count = get_db().execute("SELECT COALESCE(SUM(quantity),0) FROM cart_items WHERE user_id=?", (g.user["id"],)).fetchone()[0]
    return jsonify(csrf_token=session["csrf_token"], user=serialize_user(g.user), cart_count=cart_count, btc_mode=BTC_MODE, btc_network=BTC_NETWORK, platform_fee_bps=PLATFORM_FEE_BPS, custody_mode=CUSTODY_MODE, lightning_mode=LN_MODE, commission_signing_mode=COMMISSION_SIGNING_MODE)


@app.post("/api/register")
def register():
    try:
        data = request_json_object()
        name = clean_text(data.get("name"), 100, True)
        email = clean_text(data.get("email"), 160, True).lower()
        password = str(data.get("password") or "")
        role = str(data.get("role") or "buyer").lower()
        if role not in {"buyer", "seller"}:
            raise ValueError("Tipo de conta inválido.")
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise ValueError("E-mail inválido.")
        if len(password) < 8:
            raise ValueError("A senha deve ter pelo menos 8 caracteres.")
        db = get_db()
        cur = db.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)", (name, email, generate_password_hash(password), role, now_iso()))
        if CUSTODY_MODE == "demo":
            db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (demo_pubkey(1000 + cur.lastrowid), cur.lastrowid))
        db.commit()
        session.clear(); session["user_id"] = cur.lastrowid; session["csrf_token"] = secrets.token_urlsafe(24)
        g.user = get_current_user(); log_action("register", "user", cur.lastrowid, f"role={role}")
        return jsonify(message="Conta criada.", user=serialize_user(g.user), csrf_token=session["csrf_token"]), 201
    except sqlite3.IntegrityError:
        return api_error("Este e-mail já está cadastrado.", 409)
    except ValueError as exc:
        return api_error(exc)


_login_attempts = {}
_login_attempts_lock = threading.Lock()


def login_attempts(email, remote_addr, record=False, success=False):
    now = time.time()
    keys = ("ip:" + remote_addr, "email:" + email)
    with _login_attempts_lock:
        for key in list(_login_attempts):
            _login_attempts[key] = [stamp for stamp in _login_attempts[key] if now - stamp < 900]
            if not _login_attempts[key]:
                _login_attempts.pop(key, None)
        if success:
            for key in keys:
                _login_attempts.pop(key, None)
            return False, 0
        limited = any(len(_login_attempts.get(key, [])) >= 10 for key in keys)
        if record:
            for key in keys:
                _login_attempts.setdefault(key, []).append(now)
            if len(_login_attempts) > 5000:
                oldest = sorted(_login_attempts, key=lambda k: _login_attempts[k][0] if _login_attempts[k] else now)[:1000]
                for key in oldest:
                    _login_attempts.pop(key, None)
        return limited, max((900 - int(now - attempts[0]) for key in keys if (attempts := _login_attempts.get(key))), default=0)


@app.post("/api/login")
def login():
    try: data = request_json_object()
    except ValueError as exc: return api_error(exc)
    email = clean_text(data.get("email"), 160).lower()
    remote = request.remote_addr or "unknown"
    limited, _retry = login_attempts(email, remote)
    if limited: return api_error("Muitas tentativas. Aguarde e tente novamente.", 429)
    row = get_db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], str(data.get("password") or "")):
        login_attempts(email, remote, record=True)
        return api_error("E-mail ou senha inválidos.", 401)
    if not row["active"]:
        login_attempts(email, remote, record=True)
        return api_error("Conta desativada.", 403)
    login_attempts(email, remote, success=True)
    session.clear(); session["user_id"] = row["id"]; session["csrf_token"] = secrets.token_urlsafe(24)
    g.user = get_current_user(); log_action("login", "user", row["id"])
    return jsonify(message="Login realizado.", user=serialize_user(g.user), csrf_token=session["csrf_token"])


@app.post("/api/logout")
def logout():
    if g.user: log_action("logout", "user", g.user["id"])
    session.clear(); session["csrf_token"] = secrets.token_urlsafe(24)
    return jsonify(message="Sessão encerrada.", csrf_token=session["csrf_token"])


@app.get("/api/products")
def list_products():
    q = clean_text(request.args.get("q"), 100)
    category = clean_text(request.args.get("category"), 80)
    store_id = request.args.get("store_id", type=int)
    where = ["p.active=1", "s.active=1"]
    params = []
    if q:
        where.append("(p.name LIKE ? OR p.description LIKE ? OR p.category LIKE ? OR s.name LIKE ?)")
        term = f"%{q}%"; params += [term, term, term, term]
    if category:
        where.append("p.category=?"); params.append(category)
    if store_id:
        where.append("p.store_id=?"); params.append(store_id)
    sort = request.args.get("sort", "featured")
    order_sql = {"price_asc": "p.price_sats ASC", "price_desc": "p.price_sats DESC", "rating": "rating DESC", "sales": "p.sales_count DESC"}.get(sort, "p.sales_count DESC,p.id DESC")
    rows = get_db().execute(
        f"""SELECT p.*,s.name store_name,s.slug store_slug,
                    COALESCE(AVG(r.rating),0) rating,COUNT(r.id) review_count
            FROM products p JOIN stores s ON s.id=p.store_id
             LEFT JOIN verified_reviews r ON r.product_id=p.id
            WHERE {' AND '.join(where)} GROUP BY p.id ORDER BY {order_sql}""",
        params,
    ).fetchall()
    cats = [r[0] for r in get_db().execute("SELECT DISTINCT category FROM products WHERE active=1 ORDER BY category").fetchall()]
    return jsonify(products=[serialize_product(r) for r in rows], categories=cats)


@app.get("/api/products/<int:product_id>")
def product_detail(product_id):
    db = get_db()
    row = db.execute(
        """SELECT p.*,s.name store_name,s.slug store_slug,s.description store_description,s.logo_url,s.banner_url,
                  COALESCE(AVG(r.rating),0) rating,COUNT(r.id) review_count
           FROM products p JOIN stores s ON s.id=p.store_id LEFT JOIN verified_reviews r ON r.product_id=p.id
           WHERE p.id=? AND p.active=1 AND s.active=1 GROUP BY p.id""",
        (product_id,),
    ).fetchone()
    if not row: return api_error("Produto não encontrado.", 404)
    reviews = db.execute("SELECT r.*,u.name buyer_name,p.name product_name FROM verified_reviews r JOIN users u ON u.id=r.buyer_id JOIN products p ON p.id=r.product_id WHERE r.product_id=? ORDER BY r.id DESC", (product_id,)).fetchall()
    related = db.execute(
        """SELECT p.*,s.name store_name,s.slug store_slug,COALESCE(AVG(r.rating),0) rating,COUNT(r.id) review_count
           FROM products p JOIN stores s ON s.id=p.store_id LEFT JOIN verified_reviews r ON r.product_id=p.id
           WHERE p.active=1 AND s.active=1 AND p.id<>? AND (p.category=? OR p.store_id=?)
           GROUP BY p.id ORDER BY p.sales_count DESC,p.id DESC LIMIT 4""",
        (product_id, row["category"], row["store_id"]),
    ).fetchall()
    store = db.execute("SELECT * FROM stores WHERE id=?", (row["store_id"],)).fetchone()
    return jsonify(product=serialize_product(row), store=serialize_store(store, db), reviews=[serialize_public_review(r) for r in reviews], related=[serialize_product(r) for r in related])


@app.get("/api/stores")
def list_stores():
    db = get_db(); rows = db.execute("SELECT * FROM stores WHERE active=1 ORDER BY id DESC").fetchall()
    result = []
    for row in rows:
        x = serialize_store(row, db)
        x["product_count"] = db.execute("SELECT COUNT(*) FROM products WHERE store_id=? AND active=1", (row["id"],)).fetchone()[0]
        result.append(x)
    return jsonify(stores=result)


@app.get("/api/stores/<int:store_id>")
def store_detail(store_id):
    db = get_db(); store = db.execute("SELECT * FROM stores WHERE id=? AND active=1", (store_id,)).fetchone()
    if not store: return api_error("Loja não encontrada.", 404)
    products = db.execute(
        """SELECT p.*,s.name store_name,s.slug store_slug,COALESCE(AVG(r.rating),0) rating,COUNT(r.id) review_count
           FROM products p JOIN stores s ON s.id=p.store_id LEFT JOIN verified_reviews r ON r.product_id=p.id
           WHERE p.store_id=? AND p.active=1 GROUP BY p.id ORDER BY p.sales_count DESC,p.id DESC""",
        (store_id,),
    ).fetchall()
    recent = db.execute("SELECT r.*,u.name buyer_name,p.name product_name FROM verified_reviews r JOIN users u ON u.id=r.buyer_id JOIN products p ON p.id=r.product_id WHERE r.store_id=? ORDER BY r.id DESC LIMIT 10", (store_id,)).fetchall()
    return jsonify(store=serialize_store(store, db), products=[serialize_product(p) for p in products], reviews=[serialize_public_review(r) for r in recent])


@app.post("/api/store")
@roles_required("seller")
def create_or_update_store():
    data = request.get_json(silent=True) or {}
    try:
        name = clean_text(data.get("name"), 100, True)
        description = clean_text(data.get("description"), 1500)
        payout = clean_text(data.get("payout_address"), 120)
        escrow_pubkey = clean_text(data.get("escrow_pubkey"), 80)
        if escrow_pubkey and not valid_compressed_pubkey(escrow_pubkey):
            raise ValueError("Chave pública escrow inválida. Use uma chave secp256k1 comprimida iniciada por 02 ou 03.")
        logo = clean_text(data.get("logo_url"), 500)
        banner = clean_text(data.get("banner_url"), 500)
        db = get_db(); current = db.execute("SELECT * FROM stores WHERE owner_id=?", (g.user["id"],)).fetchone()
        if payout and BTC_MODE == "rpc" and not rpc.validate_address(payout):
            raise ValueError("Endereço de repasse inválido para a rede configurada.")
        if current:
            db.execute("UPDATE stores SET name=?,description=?,payout_address=?,escrow_pubkey=?,logo_url=?,banner_url=? WHERE id=?", (name, description, payout, escrow_pubkey, logo, banner, current["id"]))
            store_id = current["id"]
        else:
            base_slug = slugify(name); slug = base_slug; n = 2
            while db.execute("SELECT 1 FROM stores WHERE slug=?", (slug,)).fetchone(): slug = f"{base_slug}-{n}"; n += 1
            cur = db.execute("INSERT INTO stores(owner_id,name,slug,description,payout_address,escrow_pubkey,logo_url,banner_url,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (g.user["id"], name, slug, description, payout, escrow_pubkey, logo, banner, now_iso()))
            store_id = cur.lastrowid
        db.commit(); log_action("store_save", "store", store_id)
        return jsonify(message="Loja salva.")
    except (ValueError, RuntimeError) as exc:
        return api_error(exc)


def seller_store(db):
    return db.execute("SELECT * FROM stores WHERE owner_id=?", (g.user["id"],)).fetchone()


@app.get("/api/seller/dashboard")
@roles_required("seller")
def seller_dashboard():
    db = get_db(); store = seller_store(db)
    if not store: return jsonify(store=None, products=[], orders=[], disputes=[], metrics={})
    products = db.execute("SELECT * FROM products WHERE store_id=? ORDER BY id DESC", (store["id"],)).fetchall()
    orders = db.execute("SELECT o.*,u.name buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id WHERE o.store_id=? ORDER BY o.id DESC", (store["id"],)).fetchall()
    disputes = db.execute("SELECT d.*,o.reference order_reference,u.name opened_by_name FROM disputes d JOIN orders o ON o.id=d.order_id JOIN users u ON u.id=d.opened_by WHERE o.store_id=? ORDER BY d.id DESC", (store["id"],)).fetchall()
    pending = sum(o["seller_net_sats"] for o in orders if not o["payout_txid"] and o["status"] in {"paid","processing","shipped","completed"})
    return jsonify(
        store=serialize_store(store, db), products=[serialize_product(p) for p in products],
        orders=[serialize_order(o, False) for o in orders], disputes=[dict(d) for d in disputes],
        metrics={"products": len(products), "orders": len(orders), "pending_btc": sats_to_btc(pending), "sales_btc": sats_to_btc(sum(o["total_sats"] for o in orders if o["status"] not in {"awaiting_payment","partial","cancelled"}))},
    )


def product_payload(data):
    name = clean_text(data.get("name"), 140, True)
    short_description = clean_text(data.get("short_description"), 220)
    description = clean_text(data.get("description"), 4000)
    category = clean_text(data.get("category"), 80) or "Outros"
    image_url = clean_text(data.get("image_url"), 500)
    price_sats = btc_to_sats(data.get("price_btc"))
    compare_at_sats = btc_to_sats(data.get("compare_at_btc") or 0)
    stock = int(data.get("stock") or 0)
    if price_sats < 1 or stock < 0: raise ValueError("Preço ou estoque inválido.")
    return name, short_description, description, category, image_url, price_sats, compare_at_sats, stock


@app.post("/api/products")
@roles_required("seller")
def create_product():
    db = get_db(); store = seller_store(db)
    if not store: return api_error("Crie sua loja primeiro.", 409)
    try:
        values = product_payload(request.get_json(silent=True) or {})
        cur = db.execute("""INSERT INTO products(store_id,name,short_description,description,category,image_url,price_sats,compare_at_sats,stock,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)""", (store["id"], *values, now_iso()))
        db.commit(); log_action("product_create", "product", cur.lastrowid)
        return jsonify(message="Produto criado."), 201
    except (ValueError, TypeError) as exc: return api_error(exc)


@app.put("/api/products/<int:product_id>")
@roles_required("seller")
def update_product(product_id):
    db = get_db(); store = seller_store(db)
    if not store or not db.execute("SELECT 1 FROM products WHERE id=? AND store_id=?", (product_id, store["id"])).fetchone(): return api_error("Produto não encontrado.", 404)
    try:
        values = product_payload(request.get_json(silent=True) or {})
        db.execute("""UPDATE products SET name=?,short_description=?,description=?,category=?,image_url=?,price_sats=?,compare_at_sats=?,stock=? WHERE id=?""", (*values, product_id))
        db.commit(); log_action("product_update", "product", product_id)
        return jsonify(message="Produto atualizado.")
    except (ValueError, TypeError) as exc: return api_error(exc)


@app.delete("/api/products/<int:product_id>")
@roles_required("seller")
def delete_product(product_id):
    db = get_db(); store = seller_store(db)
    if not store: return api_error("Loja não encontrada.", 404)
    cur = db.execute("UPDATE products SET active=0 WHERE id=? AND store_id=?", (product_id, store["id"]))
    db.commit()
    if not cur.rowcount: return api_error("Produto não encontrado.", 404)
    log_action("product_disable", "product", product_id); return jsonify(message="Produto desativado.")


@app.get("/api/cart")
@login_required
def get_cart():
    rows = get_db().execute(
        """SELECT c.id cart_id,c.quantity,p.*,s.name store_name,s.id store_id
           FROM cart_items c JOIN products p ON p.id=c.product_id JOIN stores s ON s.id=p.store_id
           WHERE c.user_id=? ORDER BY s.name,p.name""", (g.user["id"],)
    ).fetchall()
    items = []
    for row in rows:
        x = serialize_product(row); x["line_total_sats"] = x["price_sats"] * x["quantity"]; x["line_total_btc"] = sats_to_btc(x["line_total_sats"]); items.append(x)
    return jsonify(items=items, total_btc=sats_to_btc(sum(i["line_total_sats"] for i in items)), count=sum(i["quantity"] for i in items))


@app.post("/api/cart/add")
@login_required
def add_cart():
    data = request.get_json(silent=True) or {}; product_id = int(data.get("product_id") or 0); qty = int(data.get("quantity") or 1)
    product = get_db().execute("SELECT p.* FROM products p JOIN stores s ON s.id=p.store_id WHERE p.id=? AND p.active=1 AND s.active=1", (product_id,)).fetchone()
    if not product: return api_error("Produto indisponível.", 404)
    if qty < 1 or qty > product["stock"]: return api_error("Quantidade indisponível.")
    db = get_db(); current = db.execute("SELECT quantity FROM cart_items WHERE user_id=? AND product_id=?", (g.user["id"], product_id)).fetchone()
    new_qty = qty + (current["quantity"] if current else 0)
    if new_qty > product["stock"]: return api_error("Quantidade superior ao estoque.")
    db.execute("INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity", (g.user["id"], product_id, new_qty)); db.commit()
    return jsonify(message="Produto adicionado.")


@app.post("/api/cart/update")
@login_required
def update_cart():
    data = request.get_json(silent=True) or {}; product_id = int(data.get("product_id") or 0); qty = int(data.get("quantity") or 0); db = get_db()
    if qty <= 0: db.execute("DELETE FROM cart_items WHERE user_id=? AND product_id=?", (g.user["id"], product_id))
    else:
        product = db.execute("SELECT stock FROM products WHERE id=? AND active=1", (product_id,)).fetchone()
        if not product or qty > product["stock"]: return api_error("Quantidade indisponível.")
        db.execute("UPDATE cart_items SET quantity=? WHERE user_id=? AND product_id=?", (qty, g.user["id"], product_id))
    db.commit(); return jsonify(message="Carrinho atualizado.")


@app.post("/api/checkout")
@login_required
def checkout():
    try:
        data = request_json_object()
        shipping_name = clean_text(data.get("shipping_name"), 120, True)
        address = clean_text(data.get("shipping_address"), 220, True)
        city = clean_text(data.get("shipping_city"), 100, True)
        state = clean_text(data.get("shipping_state"), 40, True)
        zip_code = clean_text(data.get("shipping_zip"), 20, True)
        refund_address = clean_text(data.get("buyer_refund_address"), 120)
        payment_method = clean_text(data.get("payment_method") or "onchain_multisig", 40)
        if payment_method not in {"onchain_multisig", "lightning"}:
            raise ValueError("Meio de pagamento inválido.")
        if refund_address and BTC_MODE == "rpc" and not rpc.validate_address(refund_address):
            raise ValueError("Endereço de reembolso inválido.")
        db = get_db()
        db.execute("BEGIN IMMEDIATE")
        buyer_pubkey = clean_text(data.get("buyer_pubkey") or g.user["bitcoin_pubkey"], 80)
        if payment_method == "onchain_multisig":
            buyer_wallet = db.execute("SELECT 1 FROM user_wallets WHERE user_id=?", (g.user["id"],)).fetchone()
            if not valid_compressed_pubkey(buyer_pubkey) and not buyer_wallet:
                raise ValueError("Cadastre a chave pública Bitcoin comprimida do comprador antes de criar um escrow.")
            if valid_compressed_pubkey(buyer_pubkey) and buyer_pubkey != (g.user["bitcoin_pubkey"] or ""):
                db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (buyer_pubkey.lower(), g.user["id"]))
        elif LN_MODE == "off":
            raise ValueError("Lightning está desativado neste servidor.")

        rows = db.execute(
            """SELECT c.quantity,p.*,s.active store_active,s.owner_id seller_user_id,s.escrow_pubkey,s.payout_address
               FROM cart_items c JOIN products p ON p.id=c.product_id
               JOIN stores s ON s.id=p.store_id WHERE c.user_id=?""",
            (g.user["id"],),
        ).fetchall()
        if not rows:
            raise ValueError("Seu carrinho está vazio.")
        grouped = {}
        for row in rows:
            if not row["active"] or not row["store_active"] or row["quantity"] > row["stock"]:
                raise ValueError(f"Produto indisponível: {row['name']}")
            grouped.setdefault(row["store_id"], []).append(row)

        orders = []
        for store_id, items in grouped.items():
            total = sum(i["price_sats"] * i["quantity"] for i in items)
            fee = total * PLATFORM_FEE_BPS // 10000
            net = total - fee
            reference = "BTC-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(3).upper()
            payment_address = ""
            descriptor = redeem_script = witness_script = seller_pubkey = platform_pubkey = commission_address = ""
            lightning_invoice = lightning_hash = lightning_status = lightning_provider = ""
            custody_model = "noncustodial_2of3"

            if payment_method == "onchain_multisig":
                derived_buyer = marketplace_features.fresh_escrow_pubkey(db, g.user["id"], reference)
                derived_seller = marketplace_features.fresh_escrow_pubkey(db, items[0]["seller_user_id"], reference)
                if derived_buyer:
                    buyer_pubkey = derived_buyer
                seller_pubkey = derived_seller or clean_text(items[0]["escrow_pubkey"], 80)
                if BTC_MODE == "rpc" and (not derived_buyer or not derived_seller):
                    reused = db.execute(
                        """SELECT 1 FROM orders WHERE payment_method='onchain_multisig'
                           AND buyer_pubkey=? AND seller_pubkey=? AND platform_pubkey=? LIMIT 1""",
                        (buyer_pubkey.lower(), seller_pubkey.lower(), platform_escrow_pubkey()),
                    ).fetchone()
                    if reused:
                        raise ValueError("Par de chaves estáticas já usada; configure carteira watch-only para derivação por pedido.")
                if not valid_compressed_pubkey(seller_pubkey):
                    raise ValueError(f"A loja do produto {items[0]['name']} ainda não cadastrou uma chave pública escrow válida.")
                escrow = create_multisig_escrow(reference, buyer_pubkey, seller_pubkey)
                payment_address = escrow["address"]
                if db.execute("SELECT 1 FROM orders WHERE payment_address=? LIMIT 1", (payment_address,)).fetchone():
                    raise ValueError("Bitcoin Core reutilizou endereço escrow; configure chaves públicas novas.")
                descriptor = escrow["descriptor"]
                redeem_script = escrow.get("redeem_script", "")
                witness_script = escrow.get("witness_script", "")
                platform_pubkey = escrow["platform_pubkey"]
                commission_address = commission_address_for_order(reference)
            else:
                invoice = lightning.create_invoice(total, reference)
                lightning_invoice = invoice["invoice"]
                lightning_hash = invoice["payment_hash"]
                lightning_status = invoice["status"]
                lightning_provider = invoice["provider"]
                custody_model = "platform_lightning_custodial"

            cur = db.execute(
                """INSERT INTO orders(
                    buyer_id,store_id,reference,status,payment_address,total_sats,platform_fee_sats,seller_net_sats,
                    shipping_name,shipping_address,shipping_city,shipping_state,shipping_zip,buyer_refund_address,
                    payment_method,custody_model,escrow_descriptor,escrow_redeem_script,escrow_witness_script,
                    buyer_pubkey,seller_pubkey,platform_pubkey,commission_address,
                    lightning_invoice,lightning_hash,lightning_status,lightning_provider,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    g.user["id"], store_id, reference, "awaiting_payment", payment_address, total, fee, net,
                    shipping_name, address, city, state, zip_code, refund_address,
                    payment_method, custody_model, descriptor, redeem_script, witness_script,
                    buyer_pubkey if payment_method == "onchain_multisig" else "", seller_pubkey, platform_pubkey, commission_address,
                    lightning_invoice, lightning_hash, lightning_status, lightning_provider, now_iso(), now_iso(),
                ),
            )
            order_id = cur.lastrowid
            if payment_method == "onchain_multisig":
                db.execute("INSERT INTO used_escrow_addresses(address,order_id,created_at) VALUES(?,?,?)", (payment_address, order_id, now_iso()))
            for item in items:
                db.execute(
                    "INSERT INTO order_items(order_id,product_id,product_name,unit_price_sats,quantity) VALUES(?,?,?,?,?)",
                    (order_id, item["id"], item["name"], item["price_sats"], item["quantity"]),
                )
                changed = db.execute("UPDATE products SET stock=stock-?,sales_count=sales_count+? WHERE id=? AND stock>=? AND active=1", (item["quantity"], item["quantity"], item["id"], item["quantity"]))
                if not changed.rowcount:
                    raise ValueError(f"Estoque insuficiente: {item['name']}")
            if payment_method == "onchain_multisig":
                db.execute(
                    "INSERT INTO wallet_events(order_id,event_type,amount_sats,address,status,details,created_at) VALUES(?,?,?,?,?,?,?)",
                    (order_id, "multisig_escrow_created", total, payment_address, "awaiting", reference, now_iso()),
                )
            else:
                db.execute(
                    "INSERT INTO lightning_events(order_id,provider,event_type,payment_hash,amount_sats,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
                    (order_id, lightning_provider, "invoice_created", lightning_hash, total, json.dumps({"reference": reference}), now_iso()),
                )
            notify_order_parties(db, order_id, "order", "Pedido criado", "Novo pedido aguarda pagamento.", "order:created")
            orders.append({
                "id": order_id,
                "reference": reference,
                "payment_method": payment_method,
                "custody_model": custody_model,
                "payment_address": payment_address,
                "lightning_invoice": lightning_invoice,
                "total_btc": sats_to_btc(total),
            })
        db.execute("DELETE FROM cart_items WHERE user_id=?", (g.user["id"],))
        db.commit()
        log_action("checkout", "orders", ",".join(str(o["id"]) for o in orders), f"method={payment_method}")
        return jsonify(message="Pedidos criados.", orders=orders), 201
    except (ValueError, RuntimeError) as exc:
        get_db().rollback()
        return api_error(exc)


@app.get("/api/orders/my")
@login_required
def my_orders():
    db = get_db()
    if g.user["role"] == "seller":
        store = seller_store(db); rows = [] if not store else db.execute("SELECT o.*,s.name store_name,u.name buyer_name FROM orders o JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.buyer_id WHERE o.store_id=? ORDER BY o.id DESC", (store["id"],)).fetchall()
    elif g.user["role"] == "admin":
        rows = db.execute("SELECT o.*,s.name store_name,u.name buyer_name FROM orders o JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.buyer_id ORDER BY o.id DESC LIMIT 200").fetchall()
    else:
        rows = db.execute("SELECT o.*,s.name store_name FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.buyer_id=? ORDER BY o.id DESC", (g.user["id"],)).fetchall()
    return jsonify(orders=[serialize_order(r, False) for r in rows])


@app.get("/api/orders/<int:order_id>")
@login_required
def order_detail(order_id):
    db = get_db(); row = db.execute("SELECT o.*,s.name store_name,s.owner_id,u.name buyer_name FROM orders o JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.buyer_id WHERE o.id=?", (order_id,)).fetchone()
    if not row or not can_access_order(row): return api_error("Pedido não encontrado.", 404)
    disputes = db.execute("SELECT d.*,u.name opened_by_name FROM disputes d JOIN users u ON u.id=d.opened_by WHERE d.order_id=? ORDER BY d.id DESC", (order_id,)).fetchall()
    review_ids = [r[0] for r in db.execute("SELECT product_id FROM reviews WHERE order_id=? AND purchase_verified=1", (order_id,)).fetchall()]
    return jsonify(order=serialize_order(row), disputes=[dict(d) for d in disputes], reviewed_product_ids=review_ids)


def sync_one_order(db, order):
    if order["status"] in {"cancelled", "refunded"}:
        return False
    if order["payment_method"] == "lightning":
        result = lightning.lookup(order)
        state = str(result.get("state", "OPEN")).upper()
        if state in {"SETTLED", "PAID", "COMPLETE"}:
            return mark_lightning_settled(db, order, result.get("paid_sats", 0), result.get("raw"))
        if state in {"ACCEPTED"}:
            changed = order["lightning_status"] != state
            if changed:
                db.execute("UPDATE orders SET lightning_status=?,updated_at=? WHERE id=?", (state, now_iso(), order["id"]))
            return changed
        return False
    confirmed = escrow_rpc.received_sats(order["payment_address"], MIN_CONFIRMATIONS)
    pending = escrow_rpc.received_sats(order["payment_address"], 0)
    paid = max(confirmed, pending)
    status = "paid" if confirmed >= order["total_sats"] else ("partial" if paid > 0 else "awaiting_payment")
    protected_status = order["status"] in {"processing", "shipped", "completed"}
    if protected_status:
        paid = max(paid, int(order["paid_sats"] or 0))
        status = order["status"]
    changed = paid != order["paid_sats"] or status != order["status"] or order["confirmations"] != (MIN_CONFIRMATIONS if confirmed else 0)
    if changed:
        db.execute(
            "UPDATE orders SET paid_sats=?,confirmations=?,status=?,paid_at=CASE WHEN ? THEN COALESCE(paid_at,?) ELSE paid_at END,updated_at=? WHERE id=?",
            (paid, MIN_CONFIRMATIONS if confirmed else 0, status, 1 if confirmed >= order["total_sats"] else 0, now_iso(), now_iso(), order["id"]),
        )
        db.execute(
            "INSERT INTO wallet_events(order_id,event_type,amount_sats,address,status,details,created_at) VALUES(?,?,?,?,?,?,?)",
            (order["id"], "multisig_payment_sync", paid, order["payment_address"], status, f"confirmed={confirmed}", now_iso()),
        )
        if status == "paid" and order["status"] in {"awaiting_payment", "partial"} and confirmed >= order["total_sats"]:
            notify_order_parties(db, order["id"], "payment", "Pagamento confirmado", "Pagamento integral confirmado.", "payment:confirmed")
    return changed


@app.post("/api/orders/<int:order_id>/sync")
@login_required
def sync_order(order_id):
    db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or not can_access_order(order): return api_error("Pedido não encontrado.", 404)
    try:
        changed = sync_one_order(db, order); db.commit(); return jsonify(message="Pagamento sincronizado.", changed=changed)
    except RuntimeError as exc: return api_error(exc, 502)


@app.post("/api/seller/orders/<int:order_id>/status")
@roles_required("seller")
def seller_order_status(order_id):
    try: data = request_json_object()
    except ValueError as exc: return api_error(exc)
    status = clean_text(data.get("status"), 30)
    if status not in {"processing","shipped","completed","cancelled"}: return api_error("Status inválido.")
    db = get_db(); store = seller_store(db); order = None if not store else db.execute("SELECT * FROM orders WHERE id=? AND store_id=?", (order_id, store["id"])).fetchone()
    if not order: return api_error("Pedido não encontrado.", 404)
    try:
        transition_order_status(db, order, status, g.user["id"], clean_text(data.get("carrier"), 120), clean_text(data.get("tracking_code"), 160), clean_text(data.get("note"), 1000))
    except ValueError as exc:
        db.rollback(); return api_error(exc, 409)
    db.commit(); log_action("seller_order_status", "order", order_id, status)
    return jsonify(message="Status atualizado.")


@app.post("/api/reviews")
@roles_required("buyer")
def create_review():
    try:
        data = request_json_object()
        order_id = int(data.get("order_id") or 0); product_id = int(data.get("product_id") or 0); rating = int(data.get("rating") or 0)
        title = clean_text(data.get("title"), 120); comment = clean_text(data.get("comment"), 1500, True)
        if rating < 1 or rating > 5: raise ValueError("A nota deve estar entre 1 e 5.")
        db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=? AND buyer_id=?", (order_id, g.user["id"])).fetchone()
        if not order or order["status"] != "completed" or not order_is_funded(order): raise ValueError("Somente pedidos concluídos e integralmente pagos podem ser avaliados.")
        if order["refund_txid"]: raise ValueError("Pedido reembolsado não pode receber avaliação verificada.")
        if not db.execute("SELECT 1 FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND oi.product_id=? AND p.store_id=?", (order_id, product_id, order["store_id"])).fetchone(): raise ValueError("Produto não pertence ao pedido.")
        existing = db.execute("SELECT id,buyer_id,store_id,purchase_verified FROM reviews WHERE order_id=? AND product_id=?", (order_id, product_id)).fetchone()
        if existing:
            if existing["buyer_id"] != g.user["id"] or existing["store_id"] != order["store_id"]:
                raise ValueError("Avaliação existente não corresponde à compra autenticada.")
            if existing["purchase_verified"]:
                return api_error("Este item já foi avaliado.", 409)
            db.execute("UPDATE reviews SET purchase_verified=1 WHERE id=?", (existing["id"],))
        else:
            db.execute("INSERT INTO reviews(order_id,product_id,buyer_id,store_id,rating,title,comment,created_at,purchase_verified) VALUES(?,?,?,?,?,?,?,?,1)", (order_id, product_id, g.user["id"], order["store_id"], rating, title, comment, now_iso()))
        store = db.execute("SELECT owner_id FROM stores WHERE id=?", (order["store_id"],)).fetchone()
        notify_user(db, store["owner_id"], "review", "Nova avaliação verificada", "Um pedido concluído recebeu avaliação.", order_id, f"order:{order_id}:review:{product_id}")
        db.commit(); log_action("review_create", "product", product_id, f"rating={rating}")
        return jsonify(message="Avaliação publicada."), 201
    except sqlite3.IntegrityError: return api_error("Este item já foi avaliado.", 409)
    except (ValueError, TypeError) as exc: return api_error(exc)


@app.post("/api/disputes")
@login_required
def create_dispute():
    data = request.get_json(silent=True) or {}
    try:
        order_id = int(data.get("order_id") or 0); reason = clean_text(data.get("reason"), 120, True); description = clean_text(data.get("description"), 2500, True)
        db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not order or not can_access_order(order) or g.user["role"] == "admin": raise ValueError("Pedido não encontrado.")
        if order["status"] in {"awaiting_payment","partial","cancelled","refunded"}: raise ValueError("Este pedido ainda não permite disputa.")
        if db.execute("SELECT 1 FROM disputes WHERE order_id=? AND status IN ('open','under_review')", (order_id,)).fetchone(): raise ValueError("Já existe uma disputa aberta para este pedido.")
        cur = db.execute("INSERT INTO disputes(order_id,opened_by,reason,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (order_id, g.user["id"], reason, description, "open", now_iso(), now_iso()))
        db.execute("INSERT INTO dispute_messages(dispute_id,user_id,message,created_at) VALUES(?,?,?,?)", (cur.lastrowid, g.user["id"], description, now_iso()))
        notify_order_parties(db, order_id, "dispute", "Disputa aberta", "Uma parte abriu disputa para este pedido.", f"dispute:{cur.lastrowid}:opened")
        db.commit(); log_action("dispute_open", "order", order_id, reason)
        return jsonify(message="Disputa aberta.", dispute_id=cur.lastrowid), 201
    except (ValueError, TypeError) as exc: return api_error(exc)


def get_dispute_access(db, dispute_id):
    row = db.execute("""SELECT d.*,o.buyer_id,o.store_id,s.owner_id,o.reference order_reference,s.name store_name
                        FROM disputes d JOIN orders o ON o.id=d.order_id JOIN stores s ON s.id=o.store_id WHERE d.id=?""", (dispute_id,)).fetchone()
    if not row: return None
    if g.user["role"] == "admin" or g.user["id"] in {row["buyer_id"], row["owner_id"]}: return row
    return None


@app.get("/api/disputes/<int:dispute_id>")
@login_required
def dispute_detail(dispute_id):
    db = get_db(); dispute = get_dispute_access(db, dispute_id)
    if not dispute: return api_error("Disputa não encontrada.", 404)
    messages = db.execute("SELECT m.*,u.name user_name,u.role user_role FROM dispute_messages m JOIN users u ON u.id=m.user_id WHERE m.dispute_id=? ORDER BY m.id", (dispute_id,)).fetchall()
    return jsonify(dispute=dict(dispute), messages=[dict(m) for m in messages])


@app.post("/api/disputes/<int:dispute_id>/messages")
@login_required
def dispute_message(dispute_id):
    db = get_db(); dispute = get_dispute_access(db, dispute_id)
    if not dispute: return api_error("Disputa não encontrada.", 404)
    if dispute["status"] == "resolved": return api_error("A disputa já foi encerrada.", 409)
    try: message = clean_text((request.get_json(silent=True) or {}).get("message"), 2000, True)
    except ValueError as exc: return api_error(exc)
    db.execute("INSERT INTO dispute_messages(dispute_id,user_id,message,created_at) VALUES(?,?,?,?)", (dispute_id, g.user["id"], message, now_iso()))
    if g.user["role"] == "admin": db.execute("UPDATE disputes SET status='under_review',updated_at=? WHERE id=?", (now_iso(), dispute_id))
    else: db.execute("UPDATE disputes SET updated_at=? WHERE id=?", (now_iso(), dispute_id))
    db.commit(); return jsonify(message="Mensagem enviada.")



@app.get("/api/custody/config")
def custody_config():
    store = None
    if g.user and g.user["role"] == "seller":
        row = get_db().execute("SELECT * FROM stores WHERE owner_id=?", (g.user["id"],)).fetchone()
        store = dict(row) if row else None
    try:
        platform_key = platform_escrow_pubkey()
    except RuntimeError:
        platform_key = ""
    return jsonify(
        custody_mode=CUSTODY_MODE,
        onchain_model="P2WSH 2-de-3: comprador + vendedor + mediador",
        platform_pubkey=platform_key,
        user_pubkey=(g.user["bitcoin_pubkey"] if g.user else ""),
        store=store,
        lightning_mode=LN_MODE,
        lightning_custody="custodial_platform_node",
        commission_signing_mode=COMMISSION_SIGNING_MODE,
        warning="Lightning comum liquida no nó da plataforma e não herda automaticamente o escrow 2-de-3 on-chain.",
    )


@app.post("/api/profile/bitcoin-key")
@login_required
def save_bitcoin_key():
    data = request.get_json(silent=True) or {}
    pubkey = clean_text(data.get("pubkey"), 80, True).lower()
    if not valid_compressed_pubkey(pubkey):
        return api_error("Chave pública inválida. Use uma chave secp256k1 comprimida com 66 caracteres hexadecimais.")
    db = get_db()
    db.execute("UPDATE users SET bitcoin_pubkey=? WHERE id=?", (pubkey, g.user["id"]))
    db.commit()
    log_action("bitcoin_pubkey_update", "user", g.user["id"])
    return jsonify(message="Chave pública atualizada.", pubkey=pubkey)


def _load_psbt_with_order(db, proposal_id):
    return db.execute(
        """SELECT p.*,o.buyer_id,o.store_id,o.payment_method,o.reference order_reference,
                  o.status order_status,o.buyer_refund_address,o.platform_fee_sats,o.seller_net_sats
           FROM psbt_proposals p JOIN orders o ON o.id=p.order_id WHERE p.id=?""",
        (proposal_id,),
    ).fetchone()


@app.get("/api/orders/<int:order_id>/psbts")
@login_required
def order_psbts(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or not can_access_order(order):
        return api_error("Pedido não encontrado.", 404)
    rows = db.execute("SELECT * FROM psbt_proposals WHERE order_id=? ORDER BY id DESC", (order_id,)).fetchall()
    return jsonify(proposals=[serialize_psbt(row) for row in rows])


@app.post("/api/orders/<int:order_id>/psbts")
@login_required
def create_order_psbt(order_id):
    data = request.get_json(silent=True) or {}
    kind = clean_text(data.get("kind") or "release", 20)
    if kind not in {"release", "refund"}:
        return api_error("Tipo de PSBT inválido.")
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or not can_access_order(order):
        return api_error("Pedido não encontrado.", 404)
    if order["payment_method"] != "onchain_multisig":
        return api_error("Este pedido não usa escrow multisig.", 409)
    if order["status"] not in {"paid", "processing", "shipped", "completed", "partial"}:
        return api_error("O escrow ainda não possui saldo liberável.", 409)
    role = participant_role_for_order(db, order, g.user)
    if role == "platform" and not order_has_open_dispute(db, order_id):
        return api_error("O mediador só participa da assinatura quando existe disputa aberta.", 403)
    store = db.execute("SELECT * FROM stores WHERE id=?", (order["store_id"],)).fetchone()
    seller_wallet_address = db.execute(
        """SELECT a.address FROM user_wallets w JOIN wallet_addresses a ON a.wallet_id=w.id
           WHERE w.user_id=? AND w.status='ready' AND a.purpose='receive' ORDER BY a.id DESC LIMIT 1""",
        (store["owner_id"],),
    ).fetchone()
    seller_address = clean_text((seller_wallet_address["address"] if seller_wallet_address else None) or data.get("seller_address") or store["payout_address"], 120)
    buyer_address = clean_text(data.get("buyer_address") or order["buyer_refund_address"], 120)
    try:
        if kind in {"release", "refund"} and not order_is_funded(order):
            return api_error("PSBT exige pagamento integral confirmado.", 409)
        if CUSTODY_MODE == "demo" or BTC_MODE != "rpc":
            total_input = max(order["paid_sats"], order["total_sats"])
            if kind == "release" and not seller_address:
                seller_address = "demo_seller_" + secrets.token_hex(12)
            if kind == "refund" and not buyer_address:
                buyer_address = "demo_buyer_" + secrets.token_hex(12)
            network_fee = min(350, max(1, total_input // 1000))
            seller_amount = order["seller_net_sats"] if kind == "release" else 0
            commission = order["platform_fee_sats"] if kind == "release" else 0
            payload = {
                "network": BTC_NETWORK,
                "order": order["reference"],
                "kind": kind,
                "inputs": [{"escrow": order["payment_address"], "sats": total_input}],
                "outputs": (
                    [{"address": seller_address, "sats": max(0, seller_amount - network_fee)}, {"address": order["commission_address"], "sats": commission}]
                    if kind == "release" else [{"address": buyer_address, "sats": max(0, total_input - network_fee)}]
                ),
            }
            result = {
                "psbt": encode_demo_psbt(payload),
                "fee_sats": network_fee,
                "total_input_sats": total_input,
                "seller_amount_sats": seller_amount,
                "commission_sats": commission,
            }
        else:
            result = escrow_rpc.create_spend_psbt(order, kind, seller_address, buyer_address, order["commission_address"])
        reference = "PSBT-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(4).upper()
        cur = db.execute(
            """INSERT INTO psbt_proposals(
                order_id,reference,kind,status,psbt_base64,combined_psbt,seller_address,buyer_address,
                commission_address,total_input_sats,seller_amount_sats,commission_sats,network_fee_sats,
                signers_json,created_by,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                order_id, reference, kind, "awaiting_signatures", result["psbt"], result["psbt"],
                seller_address, buyer_address, order["commission_address"], result["total_input_sats"],
                result["seller_amount_sats"], result["commission_sats"], result["fee_sats"],
                "[]", g.user["id"], now_iso(), now_iso(),
            ),
        )
        db.commit()
        log_action("escrow_psbt_create", "order", order_id, f"kind={kind} proposal={cur.lastrowid}")
        row = db.execute("SELECT * FROM psbt_proposals WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify(message="PSBT criada sem assinatura privada no servidor.", proposal=serialize_psbt(row)), 201
    except (ValueError, RuntimeError) as exc:
        db.rollback()
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.get("/api/psbts/<int:proposal_id>/download")
@login_required
def download_psbt(proposal_id):
    db = get_db()
    row = _load_psbt_with_order(db, proposal_id)
    if not row:
        return api_error("PSBT não encontrada.", 404)
    order = db.execute("SELECT * FROM orders WHERE id=?", (row["order_id"],)).fetchone()
    if not can_access_order(order):
        return api_error("PSBT não encontrada.", 404)
    content = row["combined_psbt"] or row["psbt_base64"]
    return Response(content + "\n", mimetype="text/plain", headers={"Content-Disposition": f"attachment; filename={row['reference']}.psbt"})


@app.post("/api/psbts/<int:proposal_id>/submit-signature")
@login_required
def submit_psbt_signature(proposal_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    proposal = _load_psbt_with_order(db, proposal_id)
    if not proposal:
        return api_error("PSBT não encontrada.", 404)
    order = db.execute("SELECT * FROM orders WHERE id=?", (proposal["order_id"],)).fetchone()
    role = participant_role_for_order(db, order, g.user)
    if not role:
        return api_error("Você não participa deste escrow.", 403)
    if role == "platform" and not order_has_open_dispute(db, order["id"]):
        return api_error("A assinatura do mediador só é aceita durante uma disputa aberta.", 403)
    if proposal["status"] in {"broadcast", "cancelled"}:
        return api_error("Esta proposta já foi encerrada.", 409)
    signers = json.loads(proposal["signers_json"] or "[]")
    try:
        if role not in signers:
            signers.append(role)
        if CUSTODY_MODE == "demo" or BTC_MODE != "rpc":
            signed = clean_text(data.get("psbt") or proposal["combined_psbt"], 200000, True)
            complete = len(set(signers)) >= 2
            final_hex = ("demohex" + secrets.token_hex(80)) if complete else ""
            status = "ready_to_broadcast" if complete else "partially_signed"
            combined = signed
        else:
            signed = clean_text(data.get("psbt"), 200000, True)
            result = escrow_rpc.combine_and_finalize([proposal["combined_psbt"] or proposal["psbt_base64"], signed])
            combined = result["combined"]
            complete = result["complete"]
            final_hex = result["hex"]
            status = "ready_to_broadcast" if complete else "partially_signed"
        db.execute(
            "UPDATE psbt_proposals SET combined_psbt=?,final_hex=?,status=?,signers_json=?,updated_at=? WHERE id=?",
            (combined, final_hex, status, json.dumps(sorted(set(signers))), now_iso(), proposal_id),
        )
        db.commit()
        log_action("escrow_psbt_signature_upload", "psbt", proposal_id, f"role={role} complete={complete}")
        row = db.execute("SELECT * FROM psbt_proposals WHERE id=?", (proposal_id,)).fetchone()
        return jsonify(message="PSBT atualizada.", complete=complete, proposal=serialize_psbt(row))
    except (ValueError, RuntimeError) as exc:
        db.rollback()
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/psbts/<int:proposal_id>/broadcast")
@login_required
def broadcast_psbt(proposal_id):
    db = get_db()
    proposal = _load_psbt_with_order(db, proposal_id)
    if not proposal:
        return api_error("PSBT não encontrada.", 404)
    order = db.execute("SELECT * FROM orders WHERE id=?", (proposal["order_id"],)).fetchone()
    if not participant_role_for_order(db, order, g.user):
        return api_error("Você não participa deste escrow.", 403)
    if proposal["status"] != "ready_to_broadcast" or not proposal["final_hex"]:
        return api_error("A PSBT ainda não possui duas assinaturas válidas.", 409)
    try:
        txid = ("demo_psbt_" + secrets.token_hex(16)) if CUSTODY_MODE == "demo" or BTC_MODE != "rpc" else escrow_rpc.broadcast_raw(proposal["final_hex"])
        if proposal["kind"] == "release":
            if order["status"] == "paid":
                transition_order_status(db, order, "processing", g.user["id"], note="Liberação escrow transmitida.")
            db.execute("UPDATE orders SET payout_txid=?,updated_at=? WHERE id=?", (txid, now_iso(), order["id"]))
            db.execute(
                "INSERT INTO wallet_events(order_id,event_type,amount_sats,address,txid,status,details,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (order["id"], "commission_output_created", proposal["commission_sats"], proposal["commission_address"], txid, "broadcast", proposal["reference"], now_iso()),
            )
        else:
            db.execute("UPDATE orders SET status='refunded',refund_txid=?,updated_at=? WHERE id=?", (txid, now_iso(), order["id"]))
        db.execute("UPDATE psbt_proposals SET status='broadcast',txid=?,updated_at=? WHERE id=?", (txid, now_iso(), proposal_id))
        db.commit()
        log_action("escrow_psbt_broadcast", "psbt", proposal_id, txid)
        return jsonify(message="Transação transmitida.", txid=txid)
    except RuntimeError as exc:
        db.rollback()
        return api_error(exc, 502)


@app.post("/api/orders/<int:order_id>/lightning/sync")
@login_required
def sync_lightning_order(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or not can_access_order(order):
        return api_error("Pedido não encontrado.", 404)
    if order["payment_method"] != "lightning":
        return api_error("Este pedido não usa Lightning.", 409)
    try:
        changed = sync_one_order(db, order)
        db.commit()
        return jsonify(message="Invoice Lightning sincronizada.", changed=changed)
    except RuntimeError as exc:
        db.rollback()
        return api_error(exc, 502)


@app.post("/api/admin/lightning/demo-settle/<int:order_id>")
@roles_required("admin")
def demo_settle_lightning(order_id):
    if LN_MODE != "demo":
        return api_error("Disponível somente com LN_MODE=demo.", 409)
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id=? AND payment_method='lightning'", (order_id,)).fetchone()
    if not order:
        return api_error("Pedido Lightning não encontrado.", 404)
    changed = mark_lightning_settled(db, order, order["total_sats"], {"demo": True})
    db.commit()
    log_action("lightning_demo_settle", "order", order_id)
    return jsonify(message="Invoice Lightning marcada como liquidada.", changed=changed)


@app.post("/api/lightning/webhook")
def lightning_webhook():
    supplied = request.headers.get("X-Lightning-Webhook-Secret", "")
    if not hmac.compare_digest(supplied, LIGHTNING_WEBHOOK_SECRET):
        return api_error("Webhook não autorizado.", 401)
    data = request.get_json(silent=True) or {}
    reference = clean_text(data.get("reference"), 80)
    payment_hash = clean_text(data.get("payment_hash"), 128)
    state = clean_text(data.get("state") or data.get("status"), 30).upper()
    db = get_db()
    if reference:
        order = db.execute("SELECT * FROM orders WHERE reference=? AND payment_method='lightning'", (reference,)).fetchone()
    else:
        order = db.execute("SELECT * FROM orders WHERE lightning_hash=? AND payment_method='lightning'", (payment_hash,)).fetchone()
    if not order:
        return api_error("Invoice não encontrada.", 404)
    if payment_hash and not hmac.compare_digest(payment_hash.lower(), str(order["lightning_hash"]).lower()):
        return api_error("Invoice não encontrada.", 404)
    if state not in {"SETTLED", "PAID", "COMPLETE"}:
        db.execute("UPDATE orders SET lightning_status=?,updated_at=? WHERE id=?", (state or "EVENT", now_iso(), order["id"]))
        db.commit()
        return jsonify(message="Evento registrado sem liquidação.")
    try:
        if order["lightning_provider"] == "demo":
            paid_sats = int(data.get("paid_sats") or order["total_sats"])
        else:
            provider_state = lightning.lookup(order)
            if str(provider_state.get("state", "")).upper() not in {"SETTLED", "PAID", "COMPLETE"}:
                return api_error("Provedor não confirmou liquidação.", 409)
            paid_sats = int(provider_state.get("paid_sats") or 0)
        changed = mark_lightning_settled(db, order, paid_sats, {"provider": order["lightning_provider"]})
    except (RuntimeError, ValueError, TypeError):
        db.rollback()
        return api_error("Provedor Lightning indisponível.", 502)
    db.commit()
    return jsonify(message="Liquidação Lightning registrada.", changed=changed)


@app.post("/api/admin/bitcoin/setup-wallets")
@roles_required("admin")
def setup_bitcoin_wallets():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CONFIGURAR CARTEIRAS")
        if BTC_MODE != "rpc":
            raise ValueError("BTC_MODE precisa ser rpc.")
        escrow_rpc.ensure_wallet(disable_private_keys=True)
        ensure_commission_wallet()
        ensure_payout_wallet()
        log_action("bitcoin_wallets_setup", "wallet", BTC_NETWORK, f"commission={COMMISSION_SIGNING_MODE}")
        return jsonify(message="Carteiras configuradas.", escrow_wallet=BTC_ESCROW_WALLET, commission_wallet=BTC_COMMISSION_WALLET)
    except PermissionError as exc:
        return api_error(exc, 403)
    except (ValueError, RuntimeError) as exc:
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.get("/api/admin/commission")
@roles_required("admin")
def commission_dashboard():
    db = get_db()
    wallet = {"mode": BTC_MODE, "signing_mode": COMMISSION_SIGNING_MODE, "trusted_btc": "0.00000000", "pending_btc": "0.00000000", "status": "demo"}
    if BTC_MODE == "rpc":
        try:
            ensure_commission_wallet()
            balances = commission_rpc.balances()
            wallet.update(status="online", trusted_btc=sats_to_btc(balances["trusted_sats"] + balances["watch_trusted_sats"]), pending_btc=sats_to_btc(balances["pending_sats"] + balances["watch_pending_sats"]))
        except RuntimeError as exc:
            wallet.update(status="offline", error=str(exc))
    transfers = db.execute("SELECT * FROM commission_transfers ORDER BY id DESC LIMIT 50").fetchall()
    earned = db.execute("SELECT COALESCE(SUM(amount_sats),0) FROM wallet_events WHERE event_type='commission_output_created'").fetchone()[0]
    return jsonify(wallet=wallet, earned_btc=sats_to_btc(earned), transfers=[dict(t) | {"amount_btc": sats_to_btc(t["amount_sats"])} for t in transfers])


@app.post("/api/admin/commission/new-address")
@roles_required("admin")
def commission_new_address():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CRIAR ENDERECO DE COMISSAO")
        address = commission_rpc.new_address("commission_admin") if BTC_MODE == "rpc" else demo_address("commission_admin")
        log_action("commission_address_create", "wallet", address)
        return jsonify(message="Endereço de comissão criado.", address=address)
    except PermissionError as exc:
        return api_error(exc, 403)
    except RuntimeError as exc:
        return api_error(exc, 502)


@app.post("/api/admin/commission/send")
@roles_required("admin")
def commission_hot_send():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "MOVER COMISSAO")
        if COMMISSION_SIGNING_MODE != "hot":
            raise ValueError("A carteira de comissão está em modo PSBT. Crie uma PSBT para assinatura offline.")
        destination = clean_text(data.get("destination"), 120, True)
        amount = btc_to_sats(data.get("amount_btc"))
        if amount <= 0:
            raise ValueError("Valor inválido.")
        txid = commission_rpc.send_to(destination, amount, "Marketplace commission transfer") if BTC_MODE == "rpc" else "demo_commission_" + secrets.token_hex(16)
        reference = "COM-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(3).upper()
        db = get_db()
        db.execute(
            "INSERT INTO commission_transfers(reference,mode,destination,amount_sats,txid,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (reference, "hot", destination, amount, txid, "broadcast", g.user["id"], now_iso(), now_iso()),
        )
        db.commit()
        log_action("commission_hot_send", "wallet", reference, txid)
        return jsonify(message="Comissão enviada.", txid=txid, reference=reference)
    except PermissionError as exc:
        return api_error(exc, 403)
    except (ValueError, RuntimeError) as exc:
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/admin/commission/psbt")
@roles_required("admin")
def commission_create_psbt():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CRIAR PSBT DE COMISSAO")
        destination = clean_text(data.get("destination"), 120, True)
        amount = btc_to_sats(data.get("amount_btc"))
        if amount <= 0:
            raise ValueError("Valor inválido.")
        if BTC_MODE == "rpc":
            ensure_commission_wallet()
            result = commission_rpc.create_wallet_psbt(destination, amount)
            psbt = result["psbt"]
        else:
            psbt = encode_demo_psbt({"type": "commission", "destination": destination, "amount_sats": amount})
        reference = "COMPSBT-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(3).upper()
        db = get_db()
        cur = db.execute(
            "INSERT INTO commission_transfers(reference,mode,destination,amount_sats,psbt_base64,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (reference, "psbt", destination, amount, psbt, "awaiting_signature", g.user["id"], now_iso(), now_iso()),
        )
        db.commit()
        log_action("commission_psbt_create", "commission_transfer", cur.lastrowid, reference)
        return jsonify(message="PSBT de comissão criada.", transfer_id=cur.lastrowid, reference=reference, psbt=psbt), 201
    except PermissionError as exc:
        return api_error(exc, 403)
    except (ValueError, RuntimeError) as exc:
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.get("/api/admin/commission/transfers/<int:transfer_id>/download")
@roles_required("admin")
def commission_download_psbt(transfer_id):
    row = get_db().execute("SELECT * FROM commission_transfers WHERE id=?", (transfer_id,)).fetchone()
    if not row:
        return api_error("Transferência não encontrada.", 404)
    return Response(row["psbt_base64"] + "\n", mimetype="text/plain", headers={"Content-Disposition": f"attachment; filename={row['reference']}.psbt"})


@app.post("/api/admin/commission/transfers/<int:transfer_id>/signed")
@roles_required("admin")
def commission_upload_signed(transfer_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM commission_transfers WHERE id=?", (transfer_id,)).fetchone()
    if not row:
        return api_error("Transferência não encontrada.", 404)
    try:
        signed = clean_text(data.get("psbt") or row["psbt_base64"], 200000, True)
        if BTC_MODE == "rpc":
            result = commission_rpc.combine_and_finalize([row["psbt_base64"], signed])
            if not result["complete"]:
                db.execute("UPDATE commission_transfers SET psbt_base64=?,status='partially_signed',updated_at=? WHERE id=?", (result["combined"], now_iso(), transfer_id))
                db.commit()
                return jsonify(message="PSBT ainda incompleta.", complete=False)
            final_hex = result["hex"]
        else:
            final_hex = "demohex" + secrets.token_hex(80)
        db.execute("UPDATE commission_transfers SET psbt_base64=?,final_hex=?,status='ready_to_broadcast',updated_at=? WHERE id=?", (signed, final_hex, now_iso(), transfer_id))
        db.commit()
        log_action("commission_psbt_signed_upload", "commission_transfer", transfer_id)
        return jsonify(message="PSBT pronta para transmissão.", complete=True)
    except (ValueError, RuntimeError) as exc:
        db.rollback()
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/admin/commission/transfers/<int:transfer_id>/broadcast")
@roles_required("admin")
def commission_broadcast(transfer_id):
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "TRANSMITIR COMISSAO")
        db = get_db()
        row = db.execute("SELECT * FROM commission_transfers WHERE id=?", (transfer_id,)).fetchone()
        if not row:
            return api_error("Transferência não encontrada.", 404)
        if row["status"] != "ready_to_broadcast" or not row["final_hex"]:
            return api_error("PSBT ainda não está finalizada.", 409)
        txid = commission_rpc.broadcast_raw(row["final_hex"]) if BTC_MODE == "rpc" else "demo_commission_psbt_" + secrets.token_hex(16)
        db.execute("UPDATE commission_transfers SET txid=?,status='broadcast',updated_at=? WHERE id=?", (txid, now_iso(), transfer_id))
        db.commit()
        log_action("commission_psbt_broadcast", "commission_transfer", transfer_id, txid)
        return jsonify(message="Transferência de comissão transmitida.", txid=txid)
    except PermissionError as exc:
        return api_error(exc, 403)
    except RuntimeError as exc:
        get_db().rollback()
        return api_error(exc, 502)


@app.post("/api/admin/settlements/<int:batch_id>/psbt")
@roles_required("admin")
def create_settlement_psbt(batch_id):
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CRIAR PSBT DO LOTE")
        db = get_db()
        batch = db.execute("SELECT * FROM settlement_batches WHERE id=?", (batch_id,)).fetchone()
        if not batch:
            return api_error("Lote não encontrado.", 404)
        if batch["status"] not in {"draft", "awaiting_signature", "partially_signed"}:
            return api_error("O lote não pode gerar uma nova PSBT neste estado.", 409)
        items = db.execute("SELECT * FROM settlement_items WHERE batch_id=?", (batch_id,)).fetchall()
        outputs = {}
        for item in items:
            outputs[item["payout_address"]] = outputs.get(item["payout_address"], 0) + item["amount_sats"]
        if not outputs:
            return api_error("Lote sem destinos.", 409)
        if BTC_MODE == "rpc":
            ensure_payout_wallet()
            normalized = [{address: sats_to_btc(sats)} for address, sats in outputs.items()]
            result = rpc.call("walletcreatefundedpsbt", [[], normalized, 0, {"replaceable": True, "fee_rate": float(PSBT_FEE_RATE), "subtractFeeFromOutputs": [0]}, True])
            psbt = result["psbt"]
        else:
            psbt = encode_demo_psbt({"type": "seller_batch", "batch": batch["reference"], "outputs": outputs})
        db.execute("UPDATE settlement_batches SET psbt_base64=?,final_hex='',status='awaiting_signature',updated_at=? WHERE id=?", (psbt, now_iso(), batch_id))
        db.commit()
        log_action("settlement_psbt_create", "batch", batch_id)
        return jsonify(message="PSBT do lote criada.", psbt=psbt)
    except PermissionError as exc:
        return api_error(exc, 403)
    except (ValueError, RuntimeError) as exc:
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/admin/settlements/<int:batch_id>/signed")
@roles_required("admin")
def upload_settlement_signed(batch_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    batch = db.execute("SELECT * FROM settlement_batches WHERE id=?", (batch_id,)).fetchone()
    if not batch or not batch["psbt_base64"]:
        return api_error("PSBT do lote não encontrada.", 404)
    try:
        signed = clean_text(data.get("psbt") or batch["psbt_base64"], 500000, True)
        if BTC_MODE == "rpc":
            result = rpc.combine_and_finalize([batch["psbt_base64"], signed])
            if not result["complete"]:
                db.execute("UPDATE settlement_batches SET psbt_base64=?,status='partially_signed',updated_at=? WHERE id=?", (result["combined"], now_iso(), batch_id))
                db.commit()
                return jsonify(message="PSBT do lote ainda incompleta.", complete=False)
            final_hex = result["hex"]
        else:
            final_hex = "demohex" + secrets.token_hex(120)
        db.execute("UPDATE settlement_batches SET psbt_base64=?,final_hex=?,status='ready_to_broadcast',updated_at=? WHERE id=?", (signed, final_hex, now_iso(), batch_id))
        db.commit()
        log_action("settlement_psbt_signed_upload", "batch", batch_id)
        return jsonify(message="PSBT do lote pronta.", complete=True)
    except (ValueError, RuntimeError) as exc:
        db.rollback()
        return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/admin/settlements/<int:batch_id>/broadcast-psbt")
@roles_required("admin")
def broadcast_settlement_psbt(batch_id):
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "TRANSMITIR LOTE")
        db = get_db()
        batch = db.execute("SELECT * FROM settlement_batches WHERE id=?", (batch_id,)).fetchone()
        if not batch:
            return api_error("Lote não encontrado.", 404)
        if batch["status"] != "ready_to_broadcast" or not batch["final_hex"]:
            return api_error("A PSBT do lote ainda não está pronta.", 409)
        txid = rpc.broadcast_raw(batch["final_hex"]) if BTC_MODE == "rpc" else "demo_batch_psbt_" + secrets.token_hex(16)
        items = db.execute("SELECT * FROM settlement_items WHERE batch_id=?", (batch_id,)).fetchall()
        for item in items:
            ids = json.loads(item["order_ids_json"])
            marks = ",".join("?" for _ in ids)
            db.execute("UPDATE settlement_items SET status='broadcast',txid=? WHERE id=?", (txid, item["id"]))
            db.execute(f"UPDATE orders SET payout_txid=?,updated_at=? WHERE id IN ({marks})", (txid, now_iso(), *ids))
        db.execute("UPDATE settlement_batches SET status='broadcast',txid=?,executed_at=?,updated_at=? WHERE id=?", (txid, now_iso(), now_iso(), batch_id))
        db.commit()
        log_action("settlement_psbt_broadcast", "batch", batch_id, txid)
        return jsonify(message="Lote transmitido.", txid=txid)
    except PermissionError as exc:
        return api_error(exc, 403)
    except RuntimeError as exc:
        get_db().rollback()
        return api_error(exc, 502)


@app.get("/api/admin/dashboard")
@roles_required("admin")
def admin_dashboard():
    db = get_db()
    wallet = {"mode": BTC_MODE, "network": BTC_NETWORK, "status": "demo", "trusted_btc": "0.00000000", "pending_btc": "0.00000000", "utxos": 0}
    if BTC_MODE == "rpc":
        try:
            rpc.ensure_safe_network(); balances = rpc.balances(); utxos = rpc.utxo_stats()
            wallet.update(status="online", trusted_btc=sats_to_btc(balances["trusted_sats"]), pending_btc=sats_to_btc(balances["pending_sats"]), utxos=utxos["count"])
        except RuntimeError as exc: wallet.update(status="offline", error=str(exc))
    orders = db.execute("SELECT o.*,s.name store_name,u.name buyer_name FROM orders o JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.buyer_id ORDER BY o.id DESC LIMIT 100").fetchall()
    users = db.execute("SELECT id,name,email,role,active,created_at FROM users ORDER BY id DESC LIMIT 100").fetchall()
    stores = db.execute("SELECT * FROM stores ORDER BY id DESC").fetchall()
    disputes = db.execute("SELECT d.*,o.reference order_reference,s.name store_name,u.name opened_by_name FROM disputes d JOIN orders o ON o.id=d.order_id JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=d.opened_by ORDER BY d.id DESC LIMIT 100").fetchall()
    batches = db.execute("SELECT * FROM settlement_batches ORDER BY id DESC LIMIT 30").fetchall()
    destinations = db.execute("SELECT * FROM treasury_destinations ORDER BY id DESC").fetchall()
    logs = db.execute("SELECT l.*,u.name user_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 40").fetchall()
    paid_total = db.execute("SELECT COALESCE(SUM(paid_sats),0) FROM orders").fetchone()[0]
    return jsonify(
        wallet=wallet,
        metrics={"users": len(users), "stores": len(stores), "orders": db.execute("SELECT COUNT(*) FROM orders").fetchone()[0], "disputes": db.execute("SELECT COUNT(*) FROM disputes WHERE status!='resolved'").fetchone()[0], "paid_btc": sats_to_btc(paid_total)},
        orders=[serialize_order(o, False) for o in orders], users=[dict(u) for u in users], stores=[serialize_store(s, db) for s in stores],
        disputes=[dict(d) for d in disputes], batches=[dict(b) | {"total_btc": sats_to_btc(b["total_sats"])} for b in batches], destinations=[dict(d) for d in destinations], logs=[dict(l) for l in logs],
    )


@app.post("/api/admin/sync-payments")
@roles_required("admin")
def admin_sync_payments():
    db = get_db(); orders = db.execute("SELECT * FROM orders WHERE status IN ('awaiting_payment','partial')").fetchall(); changed = 0; errors = []
    for order in orders:
        try: changed += 1 if sync_one_order(db, order) else 0
        except Exception as exc: errors.append(f"{order['reference']}: {exc}")
    db.commit(); log_action("admin_sync_payments", "orders", "all", f"changed={changed}")
    return jsonify(message=f"Sincronização concluída. {changed} pedido(s) atualizado(s).", errors=errors[:10])


@app.post("/api/admin/mock-credit/<int:order_id>")
@roles_required("admin")
def admin_mock_credit(order_id):
    if BTC_MODE != "demo": return api_error("Simulação disponível apenas no modo demo.", 409)
    db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order: return api_error("Pedido não encontrado.", 404)
    if order["status"] not in {"awaiting_payment", "partial"}: return api_error("Crédito demo permitido somente antes do pagamento integral.", 409)
    data = request.get_json(silent=True) or {}
    try: amount = btc_to_sats(data.get("amount_btc")) if data.get("amount_btc") not in (None, "") else order["total_sats"] - order["paid_sats"]
    except ValueError as exc: return api_error(exc)
    if amount <= 0: return api_error("Valor do crédito deve ser positivo.")
    paid = order["paid_sats"] + amount; status = "paid" if paid >= order["total_sats"] else "partial"; txid = "demo_" + secrets.token_hex(16)
    db.execute("UPDATE orders SET paid_sats=?,confirmations=?,status=?,txid=?,paid_at=?,updated_at=? WHERE id=?", (paid, 1 if status == "paid" else 0, status, txid, now_iso() if status == "paid" else order["paid_at"], now_iso(), order_id))
    db.execute("INSERT INTO wallet_events(order_id,event_type,amount_sats,address,txid,status,details,created_at) VALUES(?,?,?,?,?,?,?,?)", (order_id, "mock_credit", amount, order["payment_address"], txid, status, "Pagamento fictício", now_iso()))
    if status == "paid": notify_order_parties(db, order_id, "payment", "Pagamento confirmado", "Pagamento integral confirmado em modo demo.", "payment:confirmed")
    db.commit(); log_action("mock_credit", "order", order_id, f"amount={amount}"); return jsonify(message="Pagamento fictício registrado.", txid=txid, status=status)


@app.post("/api/admin/orders/<int:order_id>/status")
@roles_required("admin")
def admin_order_status(order_id):
    try: data = request_json_object()
    except ValueError as exc: return api_error(exc)
    status = clean_text(data.get("status"), 30)
    if status not in {"processing","shipped","completed","cancelled"}: return api_error("Status inválido.")
    db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order: return api_error("Pedido não encontrado.", 404)
    try:
        transition_order_status(db, order, status, g.user["id"], clean_text(data.get("carrier"), 120), clean_text(data.get("tracking_code"), 160), clean_text(data.get("note"), 1000))
    except ValueError as exc:
        db.rollback(); return api_error(exc, 409)
    db.commit()
    log_action("order_status", "order", order_id, status); return jsonify(message="Status atualizado.")


@app.post("/api/admin/users/<int:user_id>/toggle")
@roles_required("admin")
def admin_toggle_user(user_id):
    if user_id == g.user["id"]: return api_error("Você não pode desativar sua própria conta.", 409)
    db = get_db(); row = db.execute("SELECT active FROM users WHERE id=?", (user_id,)).fetchone()
    if not row: return api_error("Usuário não encontrado.", 404)
    active = 0 if row["active"] else 1; db.execute("UPDATE users SET active=? WHERE id=?", (active, user_id)); db.commit(); log_action("user_toggle", "user", user_id, f"active={active}")
    return jsonify(message="Usuário atualizado.", active=active)


@app.post("/api/admin/stores/<int:store_id>/toggle")
@roles_required("admin")
def admin_toggle_store(store_id):
    db = get_db(); row = db.execute("SELECT active FROM stores WHERE id=?", (store_id,)).fetchone()
    if not row: return api_error("Loja não encontrada.", 404)
    active = 0 if row["active"] else 1; db.execute("UPDATE stores SET active=? WHERE id=?", (active, store_id)); db.commit(); log_action("store_toggle", "store", store_id, f"active={active}")
    return jsonify(message="Loja atualizada.", active=active)


@app.post("/api/admin/treasury/destinations")
@roles_required("admin")
def add_treasury_destination():
    data = request.get_json(silent=True) or {}
    try:
        label = clean_text(data.get("label"), 100, True); address = clean_text(data.get("address"), 120, True); weight = max(1, min(100, int(data.get("weight") or 1)))
        if BTC_MODE == "rpc" and not rpc.validate_address(address): raise ValueError("Endereço inválido para a rede configurada.")
        db = get_db(); cur = db.execute("INSERT INTO treasury_destinations(label,address,weight,created_at) VALUES(?,?,?,?)", (label, address, weight, now_iso())); db.commit(); log_action("treasury_destination_add", "destination", cur.lastrowid, label)
        return jsonify(message="Destino adicionado."), 201
    except sqlite3.IntegrityError: return api_error("Este endereço já está cadastrado.", 409)
    except (ValueError, RuntimeError, TypeError) as exc: return api_error(exc)


@app.post("/api/admin/treasury/destinations/<int:destination_id>/toggle")
@roles_required("admin")
def toggle_treasury_destination(destination_id):
    db = get_db(); row = db.execute("SELECT active FROM treasury_destinations WHERE id=?", (destination_id,)).fetchone()
    if not row: return api_error("Destino não encontrado.", 404)
    active = 0 if row["active"] else 1; db.execute("UPDATE treasury_destinations SET active=? WHERE id=?", (active, destination_id)); db.commit(); return jsonify(message="Destino atualizado.")


@app.post("/api/admin/treasury/new-settlement-address")
@roles_required("admin")
def new_settlement_address():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CRIAR CARTEIRA DE LIQUIDACAO")
        address = commission_rpc.new_address("marketplace_commission") if BTC_MODE == "rpc" else demo_address("commission")
        get_db().execute("INSERT INTO wallet_events(event_type,address,status,details,created_at) VALUES(?,?,?,?,?)", ("settlement_address_created", address, "active", "Endereço de liquidação auditável", now_iso())); get_db().commit(); log_action("settlement_address_create", "wallet", address)
        return jsonify(message="Novo endereço de liquidação criado.", address=address)
    except PermissionError as exc: return api_error(exc, 403)
    except RuntimeError as exc: return api_error(exc, 502)


@app.post("/api/admin/treasury/consolidate")
@roles_required("admin")
def consolidate_treasury():
    if BTC_MODE != "rpc": return api_error("Centralização real está bloqueada no modo demo.", 409)
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "CENTRALIZAR TESOURARIA")
        if COMMISSION_SIGNING_MODE != "hot":
            raise ValueError("Consolidação direta desativada no modo PSBT. Use uma transferência PSBT da carteira de comissão.")
        destination = clean_text(data.get("destination"), 120) or commission_rpc.new_address("marketplace_commission")
        txid = commission_rpc.send_all(destination)
        db = get_db(); db.execute("INSERT INTO wallet_events(event_type,address,txid,status,details,created_at) VALUES(?,?,?,?,?,?)", ("treasury_consolidation", destination, txid, "broadcast", "Consolidação transparente de UTXOs", now_iso())); db.commit(); log_action("treasury_consolidate", "wallet", destination, txid)
        return jsonify(message="Consolidação transmitida.", txid=txid, destination=destination)
    except PermissionError as exc: return api_error(exc, 403)
    except (ValueError, RuntimeError) as exc: return api_error(exc, 502)


@app.post("/api/admin/treasury/distribute")
@roles_required("admin")
def distribute_treasury():
    data = request.get_json(silent=True) or {}
    try:
        require_admin_action(data, "DISTRIBUIR RESERVAS")
        amount_sats = btc_to_sats(data.get("amount_btc")); ids = [int(x) for x in data.get("destination_ids", [])]
        if amount_sats <= 0 or not ids: raise ValueError("Informe valor e destinos ativos.")
        db = get_db(); marks = ",".join("?" for _ in ids); rows = db.execute(f"SELECT * FROM treasury_destinations WHERE active=1 AND id IN ({marks})", ids).fetchall()
        if len(rows) != len(set(ids)): raise ValueError("Há destinos inválidos ou inativos.")
        total_weight = sum(r["weight"] for r in rows); outputs = {}; allocated = 0
        for index, row in enumerate(rows):
            sats = amount_sats - allocated if index == len(rows)-1 else amount_sats * row["weight"] // total_weight
            outputs[row["address"]] = outputs.get(row["address"], 0) + sats; allocated += sats
        if BTC_MODE == "rpc" and COMMISSION_SIGNING_MODE != "hot":
            raise ValueError("Distribuição direta desativada no modo PSBT. Gere transferências PSBT de comissão.")
        txid = commission_rpc.send_many(outputs, "Marketplace commission allocation") if BTC_MODE == "rpc" else "demo_reserve_" + secrets.token_hex(16)
        for address, sats in outputs.items(): db.execute("INSERT INTO wallet_events(event_type,amount_sats,address,txid,status,details,created_at) VALUES(?,?,?,?,?,?,?)", ("reserve_allocation", sats, address, txid, "broadcast" if BTC_MODE=="rpc" else "demo", "Distribuição transparente e auditável", now_iso()))
        db.commit(); log_action("treasury_distribute", "wallet", txid, f"outputs={len(outputs)} amount={amount_sats}")
        return jsonify(message="Distribuição registrada.", txid=txid, outputs={a:sats_to_btc(v) for a,v in outputs.items()})
    except PermissionError as exc: return api_error(exc, 403)
    except (ValueError, RuntimeError, TypeError) as exc: return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


def settlement_preview_data(db):
    stores = db.execute("SELECT * FROM stores WHERE active=1 AND payout_address<>'' ORDER BY name").fetchall(); result = []
    for store in stores:
        stats = store_stats(db, store["id"])
        orders = db.execute("SELECT * FROM orders WHERE store_id=? AND payout_txid='' AND settlement_batch_id IS NULL ORDER BY id", (store["id"],)).fetchall()
        eligible = [o for o in orders if eligible_order_for_settlement(db, o, stats)]
        blocked = [o for o in orders if o["status"] in {"paid","processing","shipped","completed"} and o not in eligible]
        if eligible or blocked:
            result.append({"store_id": store["id"], "store_name": store["name"], "payout_address": store["payout_address"], **stats, "eligible_order_ids": [o["id"] for o in eligible], "eligible_btc": sats_to_btc(sum(o["seller_net_sats"] for o in eligible)), "blocked_count": len(blocked)})
    return result


@app.get("/api/admin/settlements/preview")
@roles_required("admin")
def settlements_preview():
    return jsonify(stores=settlement_preview_data(get_db()))


@app.post("/api/admin/settlements")
@roles_required("admin")
def create_settlement():
    data = request.get_json(silent=True) or {}; selected = {int(x) for x in data.get("store_ids", [])}; db = get_db(); preview = settlement_preview_data(db)
    if selected: preview = [x for x in preview if x["store_id"] in selected]
    preview = [x for x in preview if x["eligible_order_ids"]]
    if not preview: return api_error("Nenhum saldo elegível para liquidação.", 409)
    reference = "SET-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(3).upper(); total = 0
    try:
        cur = db.execute("INSERT INTO settlement_batches(reference,status,total_sats,destination_count,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)", (reference, "draft", 0, len(preview), clean_text(data.get("notes"), 500), g.user["id"], now_iso())); batch_id = cur.lastrowid
        for x in preview:
            marks = ",".join("?" for _ in x["eligible_order_ids"]); orders = db.execute(f"SELECT id,seller_net_sats FROM orders WHERE id IN ({marks})", x["eligible_order_ids"]).fetchall(); amount = sum(o["seller_net_sats"] for o in orders); total += amount
            db.execute("INSERT INTO settlement_items(batch_id,store_id,amount_sats,payout_address,order_ids_json) VALUES(?,?,?,?,?)", (batch_id, x["store_id"], amount, x["payout_address"], json.dumps(x["eligible_order_ids"])))
            db.execute(f"UPDATE orders SET settlement_batch_id=? WHERE id IN ({marks})", (batch_id, *x["eligible_order_ids"]))
        db.execute("UPDATE settlement_batches SET total_sats=? WHERE id=?", (total, batch_id)); db.commit(); log_action("settlement_create", "batch", batch_id, f"total={total}")
        return jsonify(message="Lote criado.", batch_id=batch_id, reference=reference, total_btc=sats_to_btc(total)), 201
    except Exception:
        db.rollback(); raise


@app.get("/api/admin/settlements/<int:batch_id>")
@roles_required("admin")
def settlement_detail(batch_id):
    db = get_db(); batch = db.execute("SELECT * FROM settlement_batches WHERE id=?", (batch_id,)).fetchone()
    if not batch: return api_error("Lote não encontrado.", 404)
    items = db.execute("SELECT i.*,s.name store_name FROM settlement_items i JOIN stores s ON s.id=i.store_id WHERE i.batch_id=?", (batch_id,)).fetchall()
    return jsonify(batch=dict(batch) | {"total_btc": sats_to_btc(batch["total_sats"])}, items=[dict(i) | {"amount_btc": sats_to_btc(i["amount_sats"]), "order_ids": json.loads(i["order_ids_json"])} for i in items])


@app.post("/api/admin/settlements/<int:batch_id>/execute")
@roles_required("admin")
def execute_settlement(batch_id):
    return api_error("Execução direta desativada na V3. Gere a PSBT do lote, assine offline e use a rota de transmissão PSBT.", 409)


@app.post("/api/admin/settlements/<int:batch_id>/cancel")
@roles_required("admin")
def cancel_settlement(batch_id):
    db = get_db(); batch = db.execute("SELECT status FROM settlement_batches WHERE id=?", (batch_id,)).fetchone()
    if not batch: return api_error("Lote não encontrado.", 404)
    if batch["status"] != "draft": return api_error("Somente lotes em rascunho podem ser cancelados.", 409)
    db.execute("UPDATE orders SET settlement_batch_id=NULL WHERE settlement_batch_id=?", (batch_id,)); db.execute("UPDATE settlement_batches SET status='cancelled' WHERE id=?", (batch_id,)); db.commit(); log_action("settlement_cancel", "batch", batch_id)
    return jsonify(message="Lote cancelado.")


@app.post("/api/admin/orders/<int:order_id>/refund")
@roles_required("admin")
def admin_refund(order_id):
    data = request.get_json(silent=True) or {}
    try: require_admin_action(data, "REEMBOLSAR")
    except PermissionError as exc: return api_error(exc, 403)
    db = get_db(); order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order: return api_error("Pedido não encontrado.", 404)
    if order["payment_method"] == "onchain_multisig":
        return api_error("Pedido multisig exige PSBT de devolução com duas assinaturas; o admin não pode mover o escrow diretamente.", 409)
    if BTC_MODE != "rpc": return api_error("Reembolso exige transmissão Bitcoin real; modo demo não altera estado financeiro.", 409)
    if order["status"] in {"cancelled", "refunded"} or not order_is_funded(order): return api_error("Reembolso exige pedido ativo integralmente pago.", 409)
    if order["refund_txid"]: return api_error("Reembolso já registrado.", 409)
    if not order["buyer_refund_address"]: return api_error("Comprador não informou endereço de reembolso.", 409)
    try:
        amount = btc_to_sats(data.get("amount_btc") or sats_to_btc(order["paid_sats"]))
        if amount != order["paid_sats"]: raise ValueError("Reembolso parcial não suportado; valor deve corresponder ao total recebido.")
        db.execute("BEGIN IMMEDIATE")
        current = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if current["refund_txid"] or current["status"] in {"cancelled", "refunded"} or not order_is_funded(current):
            db.rollback(); return api_error("Pedido mudou; reembolso não foi transmitido.", 409)
        txid = rpc.send_to(current["buyer_refund_address"], amount, f"Refund {current['reference']}")
        db.execute("UPDATE orders SET refund_txid=?,status='refunded',updated_at=? WHERE id=?", (txid, now_iso(), order_id))
        db.execute("INSERT INTO wallet_events(order_id,event_type,amount_sats,address,txid,status,details,created_at) VALUES(?,?,?,?,?,?,?,?)", (order_id, "refund", amount, current["buyer_refund_address"], txid, "broadcast", "Reembolso integral administrativo", now_iso()))
        notify_order_parties(db, order_id, "payment", "Reembolso transmitido", "Reembolso integral enviado à rede.", "refund:transmitted")
        db.commit(); log_action("order_refund", "order", order_id, txid)
        return jsonify(message="Reembolso registrado.", txid=txid)
    except (ValueError, RuntimeError) as exc: db.rollback(); return api_error(exc, 502 if isinstance(exc, RuntimeError) else 400)


@app.post("/api/admin/disputes/<int:dispute_id>/resolve")
@roles_required("admin")
def resolve_dispute(dispute_id):
    data = request.get_json(silent=True) or {}
    try:
        resolution = clean_text(data.get("resolution"), 80, True); note = clean_text(data.get("admin_note"), 2500, True)
        if resolution not in {"release_seller","refund_buyer","partial_refund","agreement","closed_no_action"}: raise ValueError("Resolução inválida.")
        db = get_db(); dispute = db.execute("SELECT * FROM disputes WHERE id=?", (dispute_id,)).fetchone()
        if not dispute: return api_error("Disputa não encontrada.", 404)
        db.execute("UPDATE disputes SET status='resolved',resolution=?,admin_note=?,updated_at=? WHERE id=?", (resolution, note, now_iso(), dispute_id)); db.execute("INSERT INTO dispute_messages(dispute_id,user_id,message,created_at) VALUES(?,?,?,?)", (dispute_id, g.user["id"], "Decisão administrativa: " + note, now_iso()))
        notify_order_parties(db, dispute["order_id"], "dispute", "Disputa encerrada", "Administrador encerrou a disputa.", f"dispute:{dispute_id}:resolved")
        db.commit(); log_action("dispute_resolve", "dispute", dispute_id, resolution)
        return jsonify(message="Disputa resolvida. Transferências financeiras, quando aplicáveis, devem ser executadas em ação separada e auditada.")
    except ValueError as exc: return api_error(exc)



_lightning_poller_started = False
_lightning_poller_lock = threading.Lock()


def lightning_poller_loop():
    while True:
        try:
            with app.app_context():
                db = get_db()
                rows = db.execute(
                    "SELECT * FROM orders WHERE payment_method='lightning' AND status IN ('awaiting_payment','partial') ORDER BY id LIMIT 200"
                ).fetchall()
                for order in rows:
                    try:
                        sync_one_order(db, order)
                    except Exception as exc:
                        db.execute(
                            "INSERT INTO lightning_events(order_id,provider,event_type,payment_hash,payload_json,created_at) VALUES(?,?,?,?,?,?)",
                            (order["id"], order["lightning_provider"], "poll_error", order["lightning_hash"], json.dumps({"error": str(exc)[:500]}), now_iso()),
                        )
                db.commit()
        except Exception:
            pass
        time.sleep(LIGHTNING_POLL_SECONDS)


def start_lightning_poller():
    global _lightning_poller_started
    if not ENABLE_LIGHTNING_POLLER or LN_MODE not in {"lnd", "cln"}:
        return False
    with _lightning_poller_lock:
        if _lightning_poller_started:
            return True
        thread = threading.Thread(target=lightning_poller_loop, name="bitloja-lightning-poller", daemon=True)
        thread.start()
        _lightning_poller_started = True
    return True


@app.get("/health")
def health():
    try: get_db().execute("SELECT 1").fetchone(); db_status = "ok"
    except Exception as exc: db_status = str(exc)
    return jsonify(status="ok" if db_status == "ok" else "degraded", database=db_status, btc_mode=BTC_MODE, custody_mode=CUSTODY_MODE, lightning_mode=LN_MODE, lightning_poller=_lightning_poller_started)


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"): return api_error("Rota não encontrada.", 404)
    return render_template("index.html", csrf_token=session.get("csrf_token", ""), btc_mode=BTC_MODE, btc_network=BTC_NETWORK, platform_fee=f"{PLATFORM_FEE_BPS/100:.2f}"), 404


@app.errorhandler(413)
def too_large(_error):
    return api_error("Requisição muito grande.", 413)


# Inicializa o esquema também quando o projeto é carregado por um servidor WSGI.
def validate_live_configuration():
    if BTC_MODE != "rpc":
        return
    if CUSTODY_MODE != "multisig" or LN_MODE == "demo":
        raise RuntimeError("Configuração live exige custódia multisig e Lightning real ou desligado.")
    if BTC_NETWORK in {"main", "mainnet"} and not ALLOW_MAINNET:
        raise RuntimeError("Mainnet exige ALLOW_MAINNET=1.")
    required = {
        "APP_SECRET": (os.getenv("APP_SECRET", ""), 32),
        "ADMIN_ACTION_KEY": (os.getenv("ADMIN_ACTION_KEY", ""), 32),
        "BTC_RPC_PASSWORD": (os.getenv("BTC_RPC_PASSWORD", ""), 16),
    }
    if LN_MODE in {"lnd", "cln"}:
        required["LIGHTNING_WEBHOOK_SECRET"] = (os.getenv("LIGHTNING_WEBHOOK_SECRET", ""), 32)
    weak = [name for name, (value, minimum) in required.items() if len(value) < minimum or value.lower().startswith(("troque", "altere", "change-me", "replace-me"))]
    if weak:
        raise RuntimeError("Segredos obrigatórios ausentes ou fracos: " + ", ".join(weak))


marketplace_features = install_marketplace_features(app, globals())
validate_live_configuration()
init_db()
start_lightning_poller()

if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG", "0") == "1")
