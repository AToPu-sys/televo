mod auth;
mod config;
mod policy;
mod relay;
mod stun;
mod tls;
mod transport;

use std::fmt::Write as _;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::Parser;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use crate::relay::Server;
use crate::stun::{method, Builder, Class, Message};

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn sd_notify(state: &str) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::net::UnixDatagram;
        let Some(path) = std::env::var_os("NOTIFY_SOCKET") else { return };
        let Ok(sock) = UnixDatagram::unbound() else { return };
        let path = path.to_string_lossy().into_owned();
        if let Some(name) = path.strip_prefix('@') {
            use std::os::linux::net::SocketAddrExt;
            if let Ok(addr) = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()) {
                let _ = sock.send_to_addr(state.as_bytes(), &addr);
            }
        } else {
            let _ = sock.send_to(state.as_bytes(), &path);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = state;
}

/// A STUN Binding to our own UDP listener every 2 s; only a working round
/// trip counts as healthy and pets systemd's watchdog.
async fn self_check(target: SocketAddr, last_ok: Arc<AtomicU64>) {
    let Ok(sock) = UdpSocket::bind("127.0.0.1:0").await else { return };
    let mut buf = [0u8; 1500];
    loop {
        let tid: [u8; 12] = rand::random();
        let req = Builder::new(method::BINDING, Class::Request, &tid).fingerprint().finish();
        let ok = sock.send_to(&req, target).await.is_ok()
            && matches!(
                tokio::time::timeout(Duration::from_secs(1), sock.recv_from(&mut buf)).await,
                Ok(Ok((n, _))) if Message::parse(&buf[..n]).is_ok_and(|m| m.transaction_id == tid && m.class == Class::Success)
            );
        if ok {
            last_ok.store(unix_now(), Ordering::Relaxed);
            sd_notify("WATCHDOG=1");
        } else {
            warn!("self-check failed");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn serve_metrics(addr: SocketAddr, server: Arc<Server>, last_ok: Arc<AtomicU64>) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("metrics endpoint {addr}: {e}");
            return;
        }
    };
    loop {
        let Ok((mut conn, _)) = listener.accept().await else { continue };
        let server = server.clone();
        let last_ok = last_ok.clone();
        tokio::spawn(async move {
            let mut req = [0u8; 1024];
            let n = match tokio::time::timeout(Duration::from_secs(5), conn.read(&mut req)).await {
                Ok(Ok(n)) => n,
                _ => return,
            };
            let line = String::from_utf8_lossy(&req[..n]);
            let healthy = unix_now().saturating_sub(last_ok.load(Ordering::Relaxed)) <= 10;
            let (status, body) = if line.starts_with("GET /healthz") {
                if healthy { ("200 OK", "ok\n".to_string()) } else { ("503 Service Unavailable", "unhealthy\n".to_string()) }
            } else if line.starts_with("GET /metrics") {
                let m = &server.metrics;
                let mut b = String::new();
                let mut g = |name: &str, kind: &str, help: &str, v: u64| {
                    let _ = writeln!(b, "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {v}");
                };
                let load = |c: &AtomicU64| c.load(Ordering::Relaxed);
                g("turn_allocations", "gauge", "Live allocations.", server.allocation_count() as u64);
                g("turn_allocations_created_total", "counter", "Allocations created.", load(&m.allocations_created));
                g("turn_allocations_deleted_total", "counter", "Allocations deleted.", load(&m.allocations_deleted));
                g("turn_auth_failures_total", "counter", "Rejected credentials.", load(&m.auth_failures));
                g("turn_quota_rejections_total", "counter", "Allocations refused by a quota.", load(&m.quota_rejections));
                g("turn_denied_peers_total", "counter", "Permissions refused for internal peer addresses.", load(&m.denied_peers));
                g("turn_bytes_to_peer_total", "counter", "Payload bytes relayed client to peer.", load(&m.bytes_to_peer));
                g("turn_bytes_to_client_total", "counter", "Payload bytes relayed peer to client.", load(&m.bytes_to_client));
                g("turn_dropped_packets_total", "counter", "Packets dropped (bitrate cap, no permission, full buffers).", load(&m.dropped_packets));
                g("turn_malformed_total", "counter", "Unparseable STUN messages.", load(&m.malformed));
                g("turn_stream_connections", "gauge", "Open TCP/TLS connections.", m.stream_connections.load(Ordering::Relaxed) as u64);
                g("turn_healthy", "gauge", "1 while the STUN self-check passes.", healthy as u64);
                ("200 OK", b)
            } else {
                ("404 Not Found", "not found\n".to_string())
            };
            let resp = format!("HTTP/1.1 {status}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = conn.write_all(resp.as_bytes()).await;
        });
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let cfg = config::Config::parse();
    if let Err(e) = run(cfg).await {
        error!("{e}");
        std::process::exit(1);
    }
}

async fn run(cfg: config::Config) -> Result<(), String> {
    if !cfg.external_ip.is_ipv4() {
        return Err("--external-ip must be the server's public IPv4 address".into());
    }
    let secret = config::load_secret(&cfg)?;
    let policy = policy::PeerPolicy::new(&cfg.allow_peers)?;
    let server = Arc::new(Server::new(cfg.clone(), secret, policy));

    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    for addr in &cfg.udp {
        // One SO_REUSEPORT socket per core on Linux; the kernel keeps a flow on one socket.
        let count = if cfg!(target_os = "linux") { cores } else { 1 };
        for _ in 0..count {
            let sock = relay::bind_udp(*addr, 8 << 20, count > 1).map_err(|e| format!("udp {addr}: {e}"))?;
            tokio::spawn(transport::serve_udp(server.clone(), Arc::new(sock)));
        }
    }
    for addr in &cfg.tcp {
        let l = TcpListener::bind(addr).await.map_err(|e| format!("tcp {addr}: {e}"))?;
        tokio::spawn(transport::serve_stream(server.clone(), l, None, cfg.max_tcp_connections));
    }
    if !cfg.tls.is_empty() {
        let (Some(cert), Some(key)) = (cfg.cert.clone(), cfg.key.clone()) else {
            return Err("--tls needs --cert and --key".into());
        };
        let certs = tls::Certs::load(cert, key).map_err(|e| format!("tls: {e}"))?;
        for addr in &cfg.tls {
            let l = TcpListener::bind(addr).await.map_err(|e| format!("tls {addr}: {e}"))?;
            tokio::spawn(transport::serve_stream(server.clone(), l, Some(certs.clone()), cfg.max_tcp_connections));
        }
        tokio::spawn(certs.watch());
    }
    tokio::spawn(server.clone().sweep());

    let last_ok = Arc::new(AtomicU64::new(0));
    if let Some(target) = transport::first_udp_target(&cfg.udp) {
        tokio::spawn(self_check(target, last_ok.clone()));
    }
    tokio::spawn(serve_metrics(cfg.metrics, server.clone(), last_ok));

    info!(
        "{} up: realm={} external={} udp={:?} tcp={:?} tls={:?} relay={}-{}",
        relay::SOFTWARE, cfg.realm, cfg.external_ip, cfg.udp, cfg.tcp, cfg.tls, cfg.min_port, cfg.max_port
    );
    sd_notify("READY=1");

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
    tokio::select! {
        _ = term.recv() => {},
        _ = tokio::signal::ctrl_c() => {},
    }
    sd_notify("STOPPING=1");
    server.shutdown();
    Ok(())
}
