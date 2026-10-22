//! TLS certificate from disk, swapped in place when certbot renews it.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use tokio_rustls::TlsAcceptor;
use tracing::{info, warn};

pub struct Certs {
    cert: PathBuf,
    key: PathBuf,
    current: RwLock<(Arc<rustls::ServerConfig>, Option<SystemTime>)>,
}

fn modified(paths: [&Path; 2]) -> Option<SystemTime> {
    paths.iter().filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).max()
}

fn build(cert: &Path, key: &Path) -> io::Result<Arc<rustls::ServerConfig>> {
    let chain = rustls_pemfile::certs(&mut BufReader::new(File::open(cert)?)).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut BufReader::new(File::open(key)?))?
        .ok_or_else(|| io::Error::other("no private key in the key file"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(io::Error::other)?;
    Ok(Arc::new(config))
}

impl Certs {
    pub fn load(cert: PathBuf, key: PathBuf) -> io::Result<Arc<Self>> {
        let stamp = modified([&cert, &key]);
        let config = build(&cert, &key)?;
        Ok(Arc::new(Certs { cert, key, current: RwLock::new((config, stamp)) }))
    }

    pub fn acceptor(&self) -> TlsAcceptor {
        TlsAcceptor::from(self.current.read().unwrap().0.clone())
    }

    pub async fn watch(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let stamp = modified([&self.cert, &self.key]);
            if stamp == self.current.read().unwrap().1 {
                continue;
            }
            match build(&self.cert, &self.key) {
                Ok(config) => {
                    *self.current.write().unwrap() = (config, stamp);
                    info!("certificate reloaded");
                }
                Err(e) => warn!("certificate reload failed, keeping the old one: {e}"),
            }
        }
    }
}
