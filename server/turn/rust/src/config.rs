use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "televo-turn-rs", version, about = "Televo's TURN relay with TURN REST credentials")]
pub struct Config {
    /// Realm sent to clients.
    #[arg(long, env = "TURN_REALM", default_value = "televo")]
    pub realm: String,
    /// Public IPv4 advertised as the relayed address.
    #[arg(long, env = "TURN_EXTERNAL_IP")]
    pub external_ip: IpAddr,
    /// Local address relay sockets bind to.
    #[arg(long, env = "TURN_RELAY_BIND_IP", default_value = "0.0.0.0")]
    pub relay_bind_ip: IpAddr,
    #[arg(long, env = "TURN_UDP", value_delimiter = ',', default_value = "0.0.0.0:3478")]
    pub udp: Vec<SocketAddr>,
    #[arg(long, env = "TURN_TCP", value_delimiter = ',', default_value = "0.0.0.0:3478")]
    pub tcp: Vec<SocketAddr>,
    #[arg(long, env = "TURN_TLS", value_delimiter = ',')]
    pub tls: Vec<SocketAddr>,
    /// TLS certificate chain (PEM), reloaded when it changes.
    #[arg(long, env = "TURN_TLS_CERT")]
    pub cert: Option<PathBuf>,
    #[arg(long, env = "TURN_TLS_KEY")]
    pub key: Option<PathBuf>,
    #[arg(long, env = "TURN_MIN_PORT", default_value_t = 49152)]
    pub min_port: u16,
    #[arg(long, env = "TURN_MAX_PORT", default_value_t = 65535)]
    pub max_port: u16,
    /// File with the shared secret (default: $CREDENTIALS_DIRECTORY/secret, then $TURN_SECRET).
    #[arg(long, env = "TURN_SECRET_FILE")]
    pub secret_file: Option<PathBuf>,
    #[arg(long, env = "TURN_USER_QUOTA", default_value_t = 100)]
    pub user_quota: usize,
    #[arg(long, env = "TURN_TOTAL_QUOTA", default_value_t = 20000)]
    pub total_quota: usize,
    #[arg(long, env = "TURN_MAX_LIFETIME", default_value_t = 3600)]
    pub max_lifetime: u64,
    /// Seconds an expired credential may keep refreshing an allocation it already holds.
    #[arg(long, env = "TURN_REFRESH_GRACE", default_value_t = 86400)]
    pub refresh_grace: u64,
    #[arg(long, env = "TURN_METRICS", default_value = "127.0.0.1:9479")]
    pub metrics: SocketAddr,
    /// Peer CIDRs allowed despite the deny list (tests only).
    #[arg(long = "allow-peer", env = "TURN_ALLOW_PEERS", value_delimiter = ',')]
    pub allow_peers: Vec<String>,
    #[arg(long, env = "TURN_MAX_TCP_CONNECTIONS", default_value_t = 20000)]
    pub max_tcp_connections: usize,
}

pub fn load_secret(cfg: &Config) -> Result<Vec<u8>, String> {
    let path = cfg
        .secret_file
        .clone()
        .or_else(|| std::env::var_os("CREDENTIALS_DIRECTORY").map(|d| PathBuf::from(d).join("secret")));
    let secret = match path {
        Some(p) => std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?,
        None => std::env::var("TURN_SECRET").map_err(|_| "no secret: set --secret-file, LoadCredential=secret or TURN_SECRET".to_string())?,
    };
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("the secret is empty".into());
    }
    Ok(secret.as_bytes().to_vec())
}
