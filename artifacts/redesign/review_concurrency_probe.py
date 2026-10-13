import copy
import sys
import threading
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "tests"))
from test_marketplace import MarketplaceBackendTests, PASSWORD, DESTINATION
import app as app_module

case = MarketplaceBackendTests()
case.setUp()
try:
    assert case.add_wallet("seller1@test.invalid").status_code == 201
    created = case.post("seller1@test.invalid", "/api/wallet/transfers", {
        "destination": DESTINATION, "amount_btc": "0.001", "password": PASSWORD,
        "idempotency_key": "review-concurrency-01"})
    assert created.status_code == 201, created.get_json()
    transfer = created.get_json()["transfer"]
    signed = copy.deepcopy(case.core.psbts[transfer["psbt"]])
    signed["inputs"][0]["partial_signatures"] = {"02" + "1" * 64: "300101"}
    case.core.psbts["review-signed"] = signed
    entered = threading.Event()
    release = threading.Event()
    original_call = case.core.call
    def delayed_call(method, params, wallet_name=None):
        if method == "decodepsbt" and params and params[0] == "review-signed":
            entered.set()
            if not release.wait(10):
                raise TimeoutError("review gate timeout")
        return original_call(method, params, wallet_name)
    case.core.call = delayed_call
    def client_for(email):
        c = app_module.app.test_client()
        with c.session_transaction() as session:
            session["user_id"] = case.ids[email]
            session["csrf_token"] = case.csrf[email]
        return c
    sign_client = client_for("seller1@test.invalid")
    cancel_client = client_for("seller1@test.invalid")
    results = {}
    def sign():
        r = sign_client.post(f"/api/wallet/transfers/{transfer['id']}/signed", json={"psbt":"review-signed"},
                             headers={"X-CSRF-Token":case.csrf["seller1@test.invalid"]})
        results["sign"] = (r.status_code, r.get_json())
    def cancel():
        r = cancel_client.post(f"/api/wallet/transfers/{transfer['id']}/cancel", json={"password":PASSWORD},
                               headers={"X-CSRF-Token":case.csrf["seller1@test.invalid"]})
        results["cancel"] = (r.status_code, r.get_json())
    t1=threading.Thread(target=sign); t1.start()
    assert entered.wait(5), "sign did not enter RPC while transaction held"
    t2=threading.Thread(target=cancel); t2.start()
    release.set()
    t1.join(15); t2.join(15)
    assert not t1.is_alive() and not t2.is_alive(), "request thread timed out"
    with app_module.app.app_context():
        status=app_module.get_db().execute("SELECT status FROM wallet_transfers WHERE id=?", (transfer["id"],)).fetchone()[0]
    print({"sign":results.get("sign"),"cancel":results.get("cancel"),"final_status":status})
    assert results["sign"][0] == 200
    assert results["cancel"][0] == 409
    assert status == "ready_to_broadcast"
finally:
    case.tearDown()
