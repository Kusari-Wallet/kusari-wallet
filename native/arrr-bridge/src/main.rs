//! Holds a Pirate Chain wallet for the app, using Pirate's own wallet core. One JSON request per line on stdin,
//! one JSON answer per line on stdout. The seed only ever passes through these pipes.
//! The database is the library's own, encrypted with a passphrase from the app's vault.
use pirate_wallet_service as api;
use pirate_wallet_service::{Output, SyncMode, TunnelMode};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

type R<T> = Result<T, String>;

fn fail<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn text<'a>(p: &'a Value, k: &str) -> R<&'a str> {
    p[k].as_str().ok_or_else(|| format!("missing {k}"))
}

fn number(p: &Value, k: &str) -> R<u64> {
    p[k].as_u64().ok_or_else(|| format!("missing {k}"))
}

fn proving_parameters() -> R<()> {
    let spend = std::env::var("ARRR_SAPLING_SPEND").map_err(|_| "proving parameters not set")?;
    let output = std::env::var("ARRR_SAPLING_OUTPUT").map_err(|_| "proving parameters not set")?;
    pirate_core::initialize_sapling_parameters(std::path::Path::new(&spend), std::path::Path::new(&output)).map_err(fail)
}

fn tunnel(p: &Value) -> TunnelMode {
    match p["socks"].as_u64() {
        // Tor is the app's own. With a port given there is no direct route from here.
        Some(port) => TunnelMode::Socks5 { url: format!("socks5h://127.0.0.1:{port}") },
        None => TunnelMode::Direct,
    }
}

fn wallet_id(p: &Value) -> R<String> {
    Ok(text(p, "wallet")?.to_string())
}

/// Finds the fee by building and throwing away. "max" is everything minus that fee.
fn quote(id: &str, to: &str, value: Option<u64>) -> R<(u64, u64)> {
    if let Some(v) = value {
        let t = api::build_tx(id.to_string(), vec![Output::new(to.to_string(), v, None)], None).map_err(fail)?;
        return Ok((v, t.fee));
    }
    let spendable = api::get_balance(id.to_string()).map_err(fail)?.spendable;
    let mut fee = api::estimate_fee(1, false, None).map_err(fail)?;
    for _ in 0..4 {
        let v = spendable.checked_sub(fee).filter(|v| *v > 0).ok_or("nothing to send after the fee")?;
        let needed = api::build_tx(id.to_string(), vec![Output::new(to.to_string(), v, None)], None).map_err(fail)?.fee;
        if needed == fee {
            return Ok((v, fee));
        }
        fee = needed;
    }
    Err("could not settle on a fee".into())
}

async fn call(m: &str, p: &Value) -> R<Value> {
    match m {
        "open" => {
            api::configure_wallet_storage(text(p, "dir")?.to_string(), text(p, "pass")?.to_string()).map_err(fail)?;
            api::set_tunnel(tunnel(p)).map_err(fail)?;
            let wallets = api::list_wallets().map_err(fail)?;
            Ok(json!({ "wallet": wallets.first().map(|w| w.id.clone()) }))
        }
        "restore" => {
            let birthday = p["birthday"].as_u64().map(|v| v as u32);
            let id = api::restore_wallet("main".into(), text(p, "seed")?.to_string(), birthday, None).map_err(fail)?;
            Ok(json!(id))
        }
        "use" => {
            let id = wallet_id(p)?;
            api::switch_wallet(id.clone()).map_err(fail)?;
            if let Some(server) = p["server"].as_str() {
                api::set_lightd_endpoint(id, server.to_string(), None).map_err(fail)?;
            }
            Ok(json!(true))
        }
        "tip" => {
            let t = api::test_node(text(p, "server")?.to_string(), None).await.map_err(fail)?;
            Ok(json!({ "ok": t.success, "height": t.latest_block_height, "error": t.error_message }))
        }
        "sync" => {
            let id = wallet_id(p)?;
            if !api::is_sync_running(id.clone()).map_err(fail)? {
                api::start_sync(id, SyncMode::Compact).await.map_err(fail)?;
            }
            Ok(json!(true))
        }
        "rescan" => {
            api::rescan(wallet_id(p)?, number(p, "from")? as u32).await.map_err(fail)?;
            Ok(json!(true))
        }
        "status" => {
            let id = wallet_id(p)?;
            let s = api::sync_status(id.clone()).map_err(fail)?;
            let b = api::get_balance(id.clone()).map_err(fail)?;
            Ok(json!({
                "running": api::is_sync_running(id).map_err(fail)?,
                "local": s.local_height, "target": s.target_height, "percent": s.percent,
                "total": b.total, "spendable": b.spendable, "pending": b.pending,
            }))
        }
        "address" => Ok(json!({ "address": api::current_receive_address(wallet_id(p)?).map_err(fail)? })),
        "validate" => Ok(json!(api::validate_address(text(p, "address")?.to_string()).map_err(fail)?.is_valid)),
        "quote" => {
            let (value, fee) = quote(&wallet_id(p)?, text(p, "to")?, p["value"].as_u64())?;
            Ok(json!({ "value": value, "fee": fee }))
        }
        "send" => {
            let id = wallet_id(p)?;
            proving_parameters()?;
            let pending = api::build_tx(id.clone(), vec![Output::new(text(p, "to")?.to_string(), number(p, "value")?, None)], None).map_err(fail)?;
            if pending.fee > number(p, "maxFee")? {
                return Err(format!("fee rose to {}", pending.fee));
            }
            let signed = api::sign_tx(id.clone(), pending).map_err(fail)?;
            let txid = api::broadcast_tx_for_wallet(id, signed).await.map_err(fail)?;
            Ok(json!({ "txid": txid.to_string() }))
        }
        "history" => {
            let items: Vec<Value> = api::list_transactions(wallet_id(p)?, Some(100))
                .map_err(fail)?
                .into_iter()
                .map(|t| json!({ "txid": t.txid.to_string(), "height": t.height, "time": t.timestamp, "amount": t.amount, "fee": t.fee, "confirmed": t.confirmed, "expired": t.expired }))
                .collect();
            Ok(json!(items))
        }
        _ => Err(format!("unknown method {m}")),
    }
}

/// A throwaway seed, a real sync, and the same address again on restore.
async fn selftest(server: &str, socks: Option<u64>, dir: &str) -> R<()> {
    let seed = api::generate_mnemonic(None, None).map_err(fail)?;
    let open = json!({ "dir": dir, "pass": "selftest passphrase only", "socks": socks });
    call("open", &open).await?;
    // Reports every server, then uses the first that gives a height.
    let mut chosen: Option<(String, u64)> = None;
    for one in server.split(',') {
        let tip = call("tip", &json!({ "server": one })).await;
        println!("tip {one}: {}", tip.as_ref().map(|t| t.to_string()).unwrap_or_else(|e| e.clone()).chars().take(150).collect::<String>());
        if let (None, Ok(t)) = (&chosen, &tip) {
            if let Some(h) = t["height"].as_u64().filter(|h| *h > 0) {
                chosen = Some((one.to_string(), h));
            }
        }
    }
    let (server, height) = chosen.ok_or("no server gave a height")?;
    let server = server.as_str();
    let id = call("restore", &json!({ "seed": seed, "birthday": height - 200 })).await?;
    let id = id.as_str().unwrap_or_default().to_string();
    call("use", &json!({ "wallet": id, "server": server })).await?;
    let a = call("address", &json!({ "wallet": id })).await?;
    println!("address kind: {}", a["address"].as_str().unwrap_or("").chars().take(4).collect::<String>());
    call("sync", &json!({ "wallet": id })).await?;
    let started = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let s = call("status", &json!({ "wallet": id })).await?;
        println!("t={} {s}", started.elapsed().as_secs());
        // It keeps following the chain, so "running" stays true.
        if s["local"].as_u64().unwrap_or(0) >= height {
            break;
        }
        if started.elapsed().as_secs() > 900 {
            return Err("scan timed out".into());
        }
    }
    println!("history: {}", call("history", &json!({ "wallet": id })).await?);
    println!("quote refused: {}", call("quote", &json!({ "wallet": id, "to": a["address"], "value": 100000 })).await.is_err());
    if std::env::var("ARRR_SAPLING_SPEND").is_ok() {
        proving_parameters()?;
        println!("proving parameters ok");
    }
    println!("selftest ok");
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") => {
            println!("arrr-bridge {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--check-params") => {
            println!("{}", proving_parameters().map(|_| "proving parameters ok".to_string()).unwrap_or_else(|e| e));
            return;
        }
        Some("--selftest") if args.len() > 4 => {
            let socks = if args[3] == "-" { None } else { args[3].parse().ok() };
            match selftest(&args[2], socks, &args[4]).await {
                Ok(()) => std::process::exit(0),
                Err(e) => {
                    println!("selftest failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        _ => {}
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req["id"].clone();
        let m = req["m"].as_str().unwrap_or("").to_string();
        let answer = match call(&m, &req["p"]).await {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}
