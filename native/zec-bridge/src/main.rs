// Shielded Zcash for Kusari Wallet. One JSON request per line on stdin, one JSON answer per line on stdout.
// The seed only passes through those pipes and is never written or logged here. The wallet state is handed
// back to the app as bytes, and the app encrypts it. With a SOCKS port set there is no direct connection at all.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bip0039::{Count, English, Mnemonic};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::str::FromStr;
use std::time::Duration;
use tokio_socks::tcp::Socks5Stream;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint, Uri};
use tower::service_fn;
use webzjs_common::Network;
use webzjs_wallet::{
    validation::validate_confirmations_policy, wallet::usk_from_seed_str, Wallet, PRUNING_DEPTH,
};
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions, input_selection::GreedyInputSelector, propose_shielding,
    SpendingKeys,
};
use zcash_client_backend::data_api::{
    wallet::ConfirmationsPolicy, InputSource, WalletCommitmentTrees, WalletRead, WalletSummary,
};
use zcash_client_backend::fees::standard::MultiOutputChangeStrategy;
use zcash_client_backend::fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule};
use zcash_client_backend::proposal::Proposal;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_client_memory::MemoryWalletDb;
use zcash_keys::keys::UnifiedAddressRequest;
use zcash_primitives::transaction::fees::FeeRule;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedProtocol;

type Zw = Wallet<MemoryWalletDb<Network>, Channel>;

/// Same rule as Zashi: below this, shielding would mostly pay the fee.
const SHIELD_MIN: Zatoshis = Zatoshis::const_from_u64(100_000);

fn policy() -> Result<ConfirmationsPolicy, String> {
    validate_confirmations_policy(3, 10, true).map_err(fail)
}

fn fee_of<N>(p: &Proposal<StandardFeeRule, N>) -> u64 {
    p.steps().iter().map(|s| s.balance().fee_required().into_u64()).sum()
}

fn spendable<T: Eq + std::hash::Hash>(s: &WalletSummary<T>) -> u64 {
    s.account_balances().values().map(|b| b.spendable_value().into_u64()).sum()
}

/// Works out the amount and fee before anything is signed. "max" means all of it minus the fee,
/// which depends on how many notes that takes, hence the repeat.
async fn quote(w: &Zw, account: u32, to: &ZcashAddress, value: Option<u64>) -> Result<(u64, u64), String> {
    let id = account.into();
    if let Some(v) = value {
        let p = w.propose_transfer(id, to.clone(), v).await.map_err(fail)?;
        return Ok((v, fee_of(&p)));
    }
    let s = w.get_wallet_summary().await.map_err(fail)?.ok_or("not scanned yet")?;
    let all = spendable(&s);
    let mut fee = 10_000u64;
    for _ in 0..4 {
        let v = all.checked_sub(fee).filter(|v| *v > 0).ok_or("nothing to send after the fee")?;
        let needed = fee_of(&w.propose_transfer(id, to.clone(), v).await.map_err(fail)?);
        if needed == fee {
            return Ok((v, fee));
        }
        fee = needed;
    }
    Err("could not settle on a fee".into())
}

async fn send(w: &Zw, seed: &str, index: u32, account: u32, to: ZcashAddress, value: u64, max_fee: u64) -> Result<Value, String> {
    let (usk, _) = usk_from_seed_str(seed, index, &w.network).map_err(fail)?;
    let proposal = w.propose_transfer(account.into(), to, value).await.map_err(fail)?;
    let fee = fee_of(&proposal);
    if fee > max_fee {
        return Err(format!("fee rose to {fee} from the {max_fee} shown"));
    }
    let txids = w.create_proposed_transactions(proposal, &usk).await.map_err(fail)?;
    w.send_authorized_transactions(&txids).await.map_err(fail)?;
    Ok(json!({ "txids": txids.iter().map(|t| t.to_string()).collect::<Vec<_>>(), "fee": fee }))
}

/// Moves everything on the transparent address into the shielded pool. A swap service can only
/// pay a transparent address, so this is the step that makes those coins private.
async fn shield(w: &Zw, seed: &str, index: u32, account: u32) -> Result<Value, String> {
    let (usk, _) = usk_from_seed_str(seed, index, &w.network).map_err(fail)?;
    let id = account.into();
    let confirmations = policy()?;
    let txids = {
        let mut db = w.db.write().await;
        let tip = db.chain_height().map_err(fail)?.ok_or("not scanned yet")?;
        let from: Vec<_> = db
            .get_transparent_balances(id, tip.into(), confirmations)
            .map_err(fail)?
            .into_keys()
            .collect();
        if from.is_empty() {
            return Err("no transparent funds".into());
        }
        let change = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedProtocol::Orchard,
            DustOutputPolicy::default(),
            SplitPolicy::single_output(),
        );
        let proposal = propose_shielding::<_, _, _, _, <MemoryWalletDb<Network> as WalletCommitmentTrees>::Error>(
            &mut *db,
            &w.network,
            &GreedyInputSelector::new(),
            &change,
            SHIELD_MIN,
            &from,
            id,
            confirmations,
        )
        .map_err(|e| format!("{e:?}"))?;
        let prover = LocalTxProver::bundled();
        create_proposed_transactions::<
            _,
            _,
            <MemoryWalletDb<Network> as InputSource>::Error,
            _,
            <StandardFeeRule as FeeRule>::Error,
            _,
        >(
            &mut *db,
            &w.network,
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(usk),
            OvkPolicy::Sender,
            &proposal,
        )
        .map_err(|e| format!("{e:?}"))?
    };
    w.send_authorized_transactions(&txids).await.map_err(fail)?;
    Ok(json!({ "txids": txids.iter().map(|t| t.to_string()).collect::<Vec<_>>() }))
}

/// Direction and amount per transaction, from what this wallet could decrypt. Fees aren't counted.
/// Transparent deposits don't appear until they are shielded: this database keeps only a total for them.
async fn history(w: &Zw, account: u32) -> Result<Value, String> {
    use std::collections::BTreeMap;
    use zcash_client_backend::data_api::TransactionStatus;
    let id: <MemoryWalletDb<Network> as WalletRead>::AccountId = account.into();
    let db = w.db.read().await;
    let tip = db.chain_height().map_err(fail)?.map(u32::from);
    let mut map: BTreeMap<_, (u64, u64)> = BTreeMap::new();
    for n in db.received_notes().iter() {
        if n.account_id() == id {
            map.entry(n.txid()).or_default().0 += n.note().value().into_u64();
        }
    }
    for (k, n) in db.sent_notes().iter() {
        if n.from_account_id() == id {
            map.entry(*k.txid()).or_default().1 += n.value().into_u64();
        }
    }
    let list: Vec<Value> = map
        .into_iter()
        .map(|(txid, (received, sent))| {
            let entry = db.tx_table().get(&txid);
            let height = entry.and_then(|e| e.mined_height()).map(u32::from);
            let status = match entry.map(|e| e.status()) {
                Some(TransactionStatus::Mined(_)) => "confirmed",
                Some(TransactionStatus::NotInMainChain) => {
                    let expired = match (entry.and_then(|e| e.expiry_height()), tip) {
                        (Some(x), Some(t)) => u32::from(x) != 0 && t > u32::from(x),
                        _ => false,
                    };
                    if expired { "failed" } else { "pending" }
                }
                _ => "pending",
            };
            json!({ "txid": txid.to_string(), "received": received, "sent": sent, "height": height, "status": status })
        })
        .collect();
    Ok(json!({ "tip": tip, "items": list }))
}

fn fail<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

fn channel(url: &str, socks: Option<u16>) -> Result<Channel, String> {
    let ep = Endpoint::from_shared(url.to_string())
        .map_err(fail)?
        .tls_config(ClientTlsConfig::new().with_webpki_roots())
        .map_err(fail)?
        .connect_timeout(Duration::from_secs(90));
    Ok(match socks {
        Some(port) => ep.connect_with_connector_lazy(service_fn(move |uri: Uri| async move {
            let host = uri.host().unwrap_or_default().to_string();
            let target = uri.port_u16().unwrap_or(443);
            let s = Socks5Stream::connect(("127.0.0.1", port), (host.as_str(), target))
                .await
                .map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(TokioIo::new(s))
        })),
        None => ep.connect_lazy(),
    })
}

fn open(url: &str, socks: Option<u16>, db: Option<&[u8]>) -> Result<Zw, String> {
    let network = Network::MainNetwork;
    let db = match db {
        Some(bytes) => MemoryWalletDb::decode_new(bytes, network, PRUNING_DEPTH).map_err(fail)?,
        None => MemoryWalletDb::new(network, PRUNING_DEPTH),
    };
    Wallet::new(db, channel(url, socks)?, network, policy()?).map_err(fail)
}

fn text<'a>(p: &'a Value, k: &str) -> Result<&'a str, String> {
    p[k].as_str().ok_or_else(|| format!("missing {k}"))
}

fn number(p: &Value, k: &str) -> Result<u64, String> {
    p[k].as_u64().ok_or_else(|| format!("missing {k}"))
}

fn summary_json<T: Eq + std::hash::Hash>(s: &WalletSummary<T>) -> Value {
    let (mut total, mut spendable, mut transparent) = (0u64, 0u64, 0u64);
    for b in s.account_balances().values() {
        total += b.total().into_u64();
        spendable += b.spendable_value().into_u64();
        transparent += b.unshielded_balance().total().into_u64();
    }
    json!({
        "total": total, "spendable": spendable, "transparent": transparent,
        "tip": u32::from(s.chain_tip_height()),
        "scanned": u32::from(s.fully_scanned_height()),
    })
}

async fn address(w: &Zw, account: u32) -> Result<Value, String> {
    let db = w.db.read().await;
    let a = db
        .get_last_generated_address_matching(account.into(), UnifiedAddressRequest::ALLOW_ALL)
        .map_err(fail)?
        .ok_or("no such account")?;
    Ok(json!({
        "unified": a.encode(&w.network),
        "transparent": a.transparent().map(|t| zcash_keys::encoding::AddressCodec::encode(t, &w.network)),
    }))
}

async fn call(w: &mut Option<Zw>, m: &str, p: &Value) -> Result<Value, String> {
    if m == "validate" {
        // Mainnet only: this decodes for that network and nothing else.
        let ok = zcash_keys::address::Address::decode(&Network::MainNetwork, text(p, "address")?).is_some();
        return Ok(json!(ok));
    }
    if m == "open" {
        let db = match p["db"].as_str() {
            Some(s) => Some(B64.decode(s).map_err(fail)?),
            None => None,
        };
        let socks = p["socks"].as_u64().map(|v| v as u16);
        *w = Some(open(text(p, "server")?, socks, db.as_deref())?);
        return Ok(json!(true));
    }
    let wallet = w.as_ref().ok_or("not open")?;
    match m {
        "account" => {
            let birthday = p["birthday"].as_u64().map(|v| v as u32);
            let id = wallet
                .create_account("main", text(p, "seed")?, number(p, "index")? as u32, birthday, None)
                .await
                .map_err(fail)?;
            Ok(json!(*id))
        }
        "sync" => {
            wallet.sync().await.map_err(fail)?;
            Ok(json!(true))
        }
        "summary" => {
            let s = wallet.get_wallet_summary().await.map_err(fail)?;
            Ok(s.map(|s| summary_json(&s)).unwrap_or(Value::Null))
        }
        "address" => address(wallet, number(p, "account")? as u32).await,
        "quote" => {
            let to = ZcashAddress::from_str(text(p, "to")?).map_err(fail)?;
            let (value, fee) = quote(wallet, number(p, "account")? as u32, &to, p["value"].as_u64()).await?;
            Ok(json!({ "value": value, "fee": fee }))
        }
        "send" => {
            let to = ZcashAddress::from_str(text(p, "to")?).map_err(fail)?;
            send(
                wallet,
                text(p, "seed")?,
                number(p, "index")? as u32,
                number(p, "account")? as u32,
                to,
                number(p, "value")?,
                number(p, "maxFee")?,
            )
            .await
        }
        "shield" => shield(wallet, text(p, "seed")?, number(p, "index")? as u32, number(p, "account")? as u32).await,
        "history" => history(wallet, number(p, "account")? as u32).await,
        "dump" => Ok(json!(B64.encode(wallet.db_to_bytes().await.map_err(fail)?))),
        _ => Err(format!("unknown method {m}")),
    }
}

// Uses a throwaway seed made on the spot: a real account, a real scan, and the saved state read back.
async fn selftest(server: &str, socks: Option<u16>) -> Result<(), String> {
    let phrase = Mnemonic::<English>::generate(Count::Words24).phrase().to_string();
    let mut w = None;
    let say = |k: &str, v: &Value| println!("{k}: {v}");
    call(&mut w, "open", &json!({ "server": server, "socks": socks })).await?;
    let id = call(&mut w, "account", &json!({ "seed": phrase, "index": 0 })).await?;
    say("account", &id);
    let a = call(&mut w, "address", &json!({ "account": id })).await?;
    say("address", &a);
    if !a["unified"].as_str().unwrap_or("").starts_with("u1") {
        return Err("not a mainnet unified address".into());
    }
    let started = std::time::Instant::now();
    call(&mut w, "sync", &json!({})).await?;
    say("sync seconds", &json!(started.elapsed().as_secs()));
    let s = call(&mut w, "summary", &json!({})).await?;
    say("summary", &s);
    if s["total"] != json!(0) || s["tip"].as_u64().unwrap_or(0) < 3_000_000 {
        return Err("unexpected summary".into());
    }
    // Paths that need no coins: each must answer, and refuse rather than build anything.
    if call(&mut w, "validate", &json!({ "address": a["unified"] })).await? != json!(true)
        || call(&mut w, "validate", &json!({ "address": a["transparent"] })).await? != json!(true)
        || call(&mut w, "validate", &json!({ "address": "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU" })).await? != json!(false)
    {
        return Err("address check is wrong".into());
    }
    say("history", &call(&mut w, "history", &json!({ "account": id })).await?);
    say("quote refused", &json!(call(&mut w, "quote", &json!({ "account": id, "to": a["unified"], "value": 100000 })).await.is_err()));
    say("shield refused", &json!(call(&mut w, "shield", &json!({ "seed": phrase, "index": 0, "account": id })).await.err()));
    let dump = call(&mut w, "dump", &json!({})).await?;
    say("state bytes", &json!(dump.as_str().unwrap_or("").len() * 3 / 4));
    let mut again = None;
    call(&mut again, "open", &json!({ "server": server, "socks": socks, "db": dump })).await?;
    let b = call(&mut again, "address", &json!({ "account": id })).await?;
    if a != b {
        return Err("state did not survive a reload".into());
    }
    println!("selftest ok");
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") {
        println!("zec-bridge {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.get(1).map(String::as_str) == Some("--selftest") {
        let socks = args.get(3).and_then(|s| s.parse().ok());
        if let Err(e) = selftest(&args[2], socks).await {
            eprintln!("selftest failed: {e}");
            std::process::exit(1);
        }
        return;
    }
    let mut wallet = None;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req["id"].clone();
        let m = req["m"].as_str().unwrap_or("").to_string();
        let answer = match call(&mut wallet, &m, &req["p"]).await {
            Ok(r) => json!({ "id": id, "result": r }),
            Err(e) => json!({ "id": id, "error": e }),
        };
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}
