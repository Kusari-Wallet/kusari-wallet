# Checks signed transactions with Bitcoin Core's own consensus code (libbitcoinkernel, py-bitcoinkernel).
import json, sys
import pbk
from pbk.script import PrecomputedTransactionData
F = pbk.ScriptVerificationFlags
flags = F.P2SH | F.DERSIG | F.NULLDUMMY | F.CHECKLOCKTIMEVERIFY | F.CHECKSEQUENCEVERIFY | F.WITNESS | F.TAPROOT
d = json.load(sys.stdin)
def ok(tx, i, amounts, scripts):
    # Taproot signatures commit to every spent output, so all of them are passed in.
    spent = [pbk.TransactionOutput(pbk.ScriptPubkey(bytes.fromhex(s)), a) for a, s in zip(amounts, scripts)]
    t = pbk.Transaction(bytes.fromhex(tx))
    try:
        return bool(pbk.ScriptPubkey(bytes.fromhex(scripts[i])).verify(amounts[i], t, PrecomputedTransactionData(t, spent), i, flags))
    except pbk.ScriptVerifyException:
        return False
amounts = [u["value"] for u in d["inputs"]]
scripts = [u["script"] for u in d["inputs"]]
n = len(amounts)
out = {"valid": [ok(d["hex"], i, amounts, scripts) for i in range(n)]}
out["wrong_amount"] = ok(d["hex"], 0, [amounts[0] + 1] + amounts[1:], scripts)
out["wrong_script"] = ok(d["hex"], 0, amounts, [scripts[1], scripts[0]] + scripts[2:])
bad = bytearray(bytes.fromhex(d["hex"]))
# version 4, segwit marker 2, input count 1, 41-byte inputs, output count 1: then the first output's value
bad[4 + 2 + 1 + 41 * n + 1] ^= 1
out["tampered"] = ok(bad.hex(), 0, amounts, scripts)
print(json.dumps(out))
