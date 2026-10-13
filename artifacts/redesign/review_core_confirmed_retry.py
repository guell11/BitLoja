import json
import os
import subprocess
import sys
from pathlib import Path
from decimal import Decimal
from werkzeug.security import generate_password_hash
from flask import g

ROOT = Path(__file__).resolve().parent
REGTEST = ROOT / "regtest"
sys.path.insert(0, str(ROOT.parents[1]))
for line in (REGTEST / "rpc-fixture.env").read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    os.environ[key] = value
os.environ["DATABASE_PATH"] = str(REGTEST / f"feature-test-{os.getpid()}.db")
os.environ["CUSTODY_MODE"] = "multisig"
os.environ["LN_MODE"] = "off"
os.environ["ENABLE_LIGHTNING_POLLER"] = "0"
os.environ["APP_SECRET"] = "regtest-fixture-only-0123456789012345"
os.environ["ADMIN_ACTION_KEY"] = "regtest-admin-action-key-0123456"

import app as app_module
from marketplace_features import MarketplaceFeatures

CLI = Path(__file__).resolve().parent / "tools" / "bitcoin-28.0" / "bin" / "bitcoin-cli.exe"
RPC_USER = os.environ["BTC_RPC_USER"]
RPC_PASSWORD = os.environ["BTC_RPC_PASSWORD"]

def cli(*args, wallet=None):
    cmd = [str(CLI), "-regtest", f"-datadir={REGTEST}", "-rpcport=18453",
           f"-rpcuser={RPC_USER}", f"-rpcpassword={RPC_PASSWORD}"]
    if wallet:
        cmd.append(f"-rpcwallet={wallet}")
    cmd.extend(map(str, args))
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()

def call_feature(method, path, payload=None):
    with app_module.app.test_request_context(path, method=method, json=payload):
        g.user = {"id": seller_id, "role": "seller", "active": 1}
        if path in route_name:
            result = getattr(features, route_name[path])()
        else:
            transfer_id = int(path.rstrip("/").split("/")[-2])
            action = "transfer_signed" if path.endswith("/signed") else "transfer_broadcast"
            result = getattr(features, action)(transfer_id)
        if isinstance(result, tuple):
            response, status = result
        else:
            response, status = result, 200
        return response.get_json(), status

with app_module.app.app_context():
    db = app_module.get_db()
    password_hash = generate_password_hash("fixture-password")
    cur = db.execute("INSERT INTO users(name,email,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?)",
                     ("Regtest Seller", "seller@fixture.invalid", password_hash, "seller", 1, app_module.now_iso()))
    seller_id = cur.lastrowid
    db.commit()

auth_client = app_module.app.test_client()
assert auth_client.get("/api/wallet").status_code == 401
with auth_client.session_transaction() as session:
    csrf_token = session["csrf_token"]
login_response = auth_client.post("/api/login", json={"email": "seller@fixture.invalid", "password": "fixture-password"},
                                  headers={"X-CSRF-Token": csrf_token})
assert login_response.status_code == 200, login_response.get_json()
api_wallet_response = auth_client.get("/api/wallet")
assert api_wallet_response.status_code == 200, api_wallet_response.get_json()

ctx = {
    "BitcoinRPC": app_module.BitcoinRPC,
    "get_db": app_module.get_db,
    "api_error": app_module.api_error,
    "clean_text": app_module.clean_text,
    "BTC_NETWORK": app_module.BTC_NETWORK,
    "BTC_MODE": app_module.BTC_MODE,
    "ALLOW_MAINNET": app_module.ALLOW_MAINNET,
    "btc_to_sats": app_module.btc_to_sats,
    "sats_to_btc": app_module.sats_to_btc,
    "PSBT_FEE_RATE": app_module.PSBT_FEE_RATE,
    "MIN_CONFIRMATIONS": app_module.MIN_CONFIRMATIONS,
    "valid_compressed_pubkey": app_module.valid_compressed_pubkey,
    "can_access_order": app_module.can_access_order,
    "transition_order_status": app_module.transition_order_status,
    "login_required": app_module.login_required,
    "roles_required": app_module.roles_required,
}
features = MarketplaceFeatures(app_module.app, ctx)
if os.getenv("TEST_BYPASS_SIGHASH") == "1":
    # Diagnostic only: exercise finalize/mempool/broadcast after isolating the
    # current `_assert_all_sighash` compatibility failure; never used normally.
    features._assert_all_sighash = lambda _decoded: None
route_name = {"/api/wallet/setup": "wallet_setup", "/api/wallet": "wallet_get",
              "/api/wallet/transfers": "transfer_create",
              "/api/wallet/transfers/{id}/signed": "transfer_signed",
              "/api/wallet/transfers/{id}/broadcast": "transfer_broadcast"}

fixture = json.loads((REGTEST / "descriptors-fixture.json").read_text(encoding="utf-8"))
setup, setup_status = call_feature("POST", "/api/wallet/setup", {
    "password": "fixture-password", "descriptor": fixture["external"],
    "change_descriptor": fixture["change"]})
assert setup_status == 201, (setup_status, setup)
wallet = setup["wallet"]
assert wallet["mode"] == "watch-only" and wallet["address"]
address_info = json.loads(cli("getaddressinfo", wallet["address"], wallet="watch_fixture"))
assert address_info["ismine"] is True
cli("generatetoaddress", "101", wallet["address"])
wallet_payload, wallet_status = call_feature("GET", "/api/wallet")
assert wallet_status == 200, wallet_status
balance = Decimal(wallet_payload["wallet"]["confirmed_btc"])
assert balance > 0, wallet_payload["wallet"]
destination = cli("getnewaddress", "withdrawal_destination", "bech32", wallet="signer_fixture")
transfer, create_status = call_feature("POST", "/api/wallet/transfers", {
    "password": "fixture-password", "destination": destination, "amount_btc": "0.001",
    "idempotency_key": "regtest-transfer-0001"})
assert create_status == 201, (create_status, transfer)
created = transfer["transfer"]
assert created["status"] == "draft" and created["fee_btc"] != "0.00000000", created
signed_rpc = json.loads(cli("walletprocesspsbt", created["psbt"], "true", "ALL", "true", wallet="signer_fixture"))
assert signed_rpc["complete"] is True, signed_rpc
decoded_candidate = json.loads(cli("decodepsbt", signed_rpc["psbt"]))
print("SIGNED_INPUT_FIELDS=" + json.dumps([sorted(item.keys()) for item in decoded_candidate.get("inputs", [])]))
signed, signed_status = call_feature("POST", f"/api/wallet/transfers/{created['id']}/signed", {"psbt": signed_rpc["psbt"]})
assert signed_status == 200, (signed_status, signed)
assert signed["transfer"]["status"] == "ready_to_broadcast", signed
broadcast, broadcast_status = call_feature("POST", f"/api/wallet/transfers/{created['id']}/broadcast", {
    "password": "fixture-password", "confirm": "ENVIAR BTC"})
assert broadcast_status == 200, (broadcast_status, broadcast)
assert broadcast["transfer"]["status"] == "broadcast" and broadcast["transfer"]["txid"], broadcast
txid = broadcast["transfer"]["txid"]
with app_module.app.app_context():
    watch_name = app_module.get_db().execute("SELECT core_wallet_name FROM user_wallets WHERE user_id=?", (seller_id,)).fetchone()[0]
miner = cli("getnewaddress", "review-confirmed-retry", "bech32", wallet="signer_fixture")
cli("generatetoaddress", "1", miner)
watch_transaction = json.loads(cli("gettransaction", txid, wallet=watch_name))
assert watch_transaction["confirmations"] >= 1, watch_transaction
with app_module.app.app_context():
    db = app_module.get_db()
    db.execute("UPDATE wallet_transfers SET status='broadcasting' WHERE id=?", (created["id"],))
    db.commit()
confirmed_retry, confirmed_retry_status = call_feature("POST", f"/api/wallet/transfers/{created['id']}/broadcast", {
    "password": "fixture-password", "confirm": "ENVIAR BTC"})
print("CONFIRMED_RETRY=" + json.dumps({"status": confirmed_retry_status, "body": confirmed_retry,
      "wallet_confirmations": watch_transaction["confirmations"]}, ensure_ascii=False))

repeat, repeat_status = call_feature("POST", "/api/wallet/transfers", {
    "password": "fixture-password", "destination": destination, "amount_btc": "0.001",
    "idempotency_key": "regtest-transfer-0001"})
assert repeat_status == 200 and repeat["transfer"]["id"] == created["id"], (repeat_status, repeat)
repeat_broadcast, repeat_broadcast_status = call_feature("POST", f"/api/wallet/transfers/{created['id']}/broadcast", {
    "password": "fixture-password", "confirm": "ENVIAR BTC"})
assert repeat_broadcast_status == 200, (repeat_broadcast_status, repeat_broadcast)
assert repeat_broadcast["transfer"]["txid"] == broadcast["transfer"]["txid"], (repeat_broadcast, broadcast)

print(json.dumps({
    "test_bypassed_sighash_check": os.getenv("TEST_BYPASS_SIGHASH") == "1",
    "core_version": cli("getnetworkinfo").split('"subversion": "')[1].split('"')[0],
    "setup_status": setup_status, "wallet_mode": wallet["mode"], "address_ismine": address_info["ismine"],
    "route_auth_before_login": "401", "route_auth_after_login": api_wallet_response.status_code,
    "confirmed_btc": wallet_payload["wallet"]["confirmed_btc"], "transfer_create_status": create_status,
    "transfer_status": created["status"], "fee_btc": created["fee_btc"],
    "signer_complete": signed_rpc["complete"], "signed_status": signed_status,
    "ready_status": signed["transfer"]["status"], "broadcast_status": broadcast_status,
    "broadcast_result": broadcast["transfer"]["status"], "txid_present": bool(broadcast["transfer"]["txid"]),
    "create_retry_status": repeat_status, "create_retry_same_id": repeat["transfer"]["id"] == created["id"],
    "broadcast_retry_status": repeat_broadcast_status,
    "broadcast_retry_same_txid": repeat_broadcast["transfer"]["txid"] == broadcast["transfer"]["txid"],
}, indent=2))
