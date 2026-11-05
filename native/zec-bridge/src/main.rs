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
use webzjs_wallet::{validation::validate_confirmations_policy, Wallet, PRUNING_DEPTH};
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::{WalletRead, WalletSummary};
use zcash_client_memory::MemoryWalletDb;
use zcash_keys::keys::UnifiedAddressRequest;

type Zw = Wallet<MemoryWalletDb<Network>, Channel>;

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
    let policy = validate_confirmations_policy(3, 10, true).map_err(fail)?;
    Wallet::new(db, channel(url, socks)?, network, policy).map_err(fail)
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
        "send" => {
            let to = ZcashAddress::from_str(text(p, "to")?).map_err(fail)?;
            wallet
                .transfer(
                    text(p, "seed")?,
                    number(p, "index")? as u32,
                    (number(p, "account")? as u32).into(),
                    to,
                    number(p, "value")?,
                )
                .await
                .map_err(fail)?;
            Ok(json!(true))
        }
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
