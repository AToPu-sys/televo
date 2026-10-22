//! TURN allocations (RFC 5766): Allocate, Refresh, CreatePermission,
//! ChannelBind, Send/Data indications and ChannelData, plus STUN Binding.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::Rng;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::auth::{Auth, Credentials, Rejection};
use crate::config::Config;
use crate::policy::PeerPolicy;
use crate::stun::{self, attr, method, Builder, Class, Message};

pub const SOFTWARE: &str = concat!("televo-turn-rs/", env!("CARGO_PKG_VERSION"));
const DEFAULT_LIFETIME: u64 = 600;
const PERMISSION_LIFETIME: Duration = Duration::from_secs(300);
const CHANNEL_LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Transport {
    Udp,
    Tcp,
    Tls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FiveTuple {
    pub transport: Transport,
    pub local: SocketAddr,
    pub client: SocketAddr,
}

pub enum ClientSink {
    Udp { socket: Arc<UdpSocket>, client: SocketAddr },
    Stream(mpsc::Sender<Vec<u8>>),
}

impl ClientSink {
    fn is_stream(&self) -> bool {
        matches!(self, ClientSink::Stream(_))
    }

    fn send(&self, msg: Vec<u8>) -> bool {
        match self {
            ClientSink::Udp { socket, client } => socket.try_send_to(&msg, *client).is_ok(),
            ClientSink::Stream(tx) => tx.try_send(msg).is_ok(),
        }
    }
}

struct AllocState {
    expires: Instant,
    permissions: HashMap<IpAddr, Instant>,
    channels: HashMap<u16, (SocketAddr, Instant)>,
    peer_channels: HashMap<SocketAddr, u16>,
    allocate_txid: [u8; 12],
    allocate_reply: Vec<u8>,
}

impl AllocState {
    fn permitted(&self, peer: SocketAddr, now: Instant) -> bool {
        self.permissions.get(&peer.ip()).is_some_and(|exp| *exp > now) || self.live_channel(peer, now).is_some()
    }

    fn live_channel(&self, peer: SocketAddr, now: Instant) -> Option<u16> {
        let ch = *self.peer_channels.get(&peer)?;
        self.channels.get(&ch).filter(|(_, exp)| *exp > now).map(|_| ch)
    }
}

/// Caps one allocation's relayed bitrate; over the cap packets are dropped,
/// as a congested link would.
pub struct TokenBucket {
    rate: f64,
    burst: f64,
    state: Mutex<(f64, Instant)>,
}

impl TokenBucket {
    pub fn new(bits_per_second: u64) -> Option<Self> {
        (bits_per_second > 0).then(|| {
            let rate = bits_per_second as f64 / 8.0;
            TokenBucket { rate, burst: rate / 2.0, state: Mutex::new((rate / 2.0, Instant::now())) }
        })
    }

    pub fn allow(&self, n: usize) -> bool {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        let tokens = (st.0 + now.duration_since(st.1).as_secs_f64() * self.rate).min(self.burst);
        *st = (tokens, now);
        if tokens < n as f64 {
            return false;
        }
        st.0 -= n as f64;
        true
    }
}

fn within(bucket: &Option<TokenBucket>, n: usize) -> bool {
    bucket.as_ref().is_none_or(|b| b.allow(n))
}

pub struct Allocation {
    to_peer: Option<TokenBucket>,
    to_client: Option<TokenBucket>,
    username: String,
    user_id: String,
    relay: Arc<UdpSocket>,
    sink: ClientSink,
    state: Mutex<AllocState>,
    cancel: CancellationToken,
}

#[cfg(test)]
mod tests {
    use super::TokenBucket;

    #[test]
    fn token_bucket_caps_and_refills() {
        let b = TokenBucket::new(8_000).unwrap(); // 1000 bytes/s, burst 500
        assert!(b.allow(400));
        assert!(!b.allow(400));
        std::thread::sleep(std::time::Duration::from_millis(450));
        assert!(b.allow(400));
        assert!(TokenBucket::new(0).is_none());
    }
}

#[derive(Default)]
pub struct Metrics {
    pub allocations_created: AtomicU64,
    pub allocations_deleted: AtomicU64,
    pub auth_failures: AtomicU64,
    pub quota_rejections: AtomicU64,
    pub denied_peers: AtomicU64,
    pub bytes_to_peer: AtomicU64,
    pub bytes_to_client: AtomicU64,
    pub dropped_packets: AtomicU64,
    pub malformed: AtomicU64,
    pub stream_connections: AtomicUsize,
}

fn inc(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

pub fn canonical(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn bind_udp(addr: SocketAddr, buffer: usize, reuse_port: bool) -> io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let domain = if addr.is_ipv4() { Domain::IPV4 } else { Domain::IPV6 };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;
    #[cfg(unix)]
    if reuse_port {
        socket.set_reuse_port(true)?;
    }
    let _ = socket.set_recv_buffer_size(buffer);
    let _ = socket.set_send_buffer_size(buffer);
    socket.bind(&addr.into())?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

pub struct Server {
    cfg: Config,
    auth: Auth,
    policy: PeerPolicy,
    allocations: RwLock<HashMap<FiveTuple, Arc<Allocation>>>,
    per_user: Mutex<HashMap<String, usize>>,
    pub metrics: Arc<Metrics>,
}

impl Server {
    pub fn new(cfg: Config, secret: Vec<u8>, policy: PeerPolicy) -> Self {
        let auth = Auth::new(secret, cfg.realm.clone());
        Server {
            cfg,
            auth,
            policy,
            allocations: RwLock::new(HashMap::new()),
            per_user: Mutex::new(HashMap::new()),
            metrics: Arc::new(Metrics::default()),
        }
    }

    pub fn allocation_count(&self) -> usize {
        self.allocations.read().unwrap().len()
    }

    pub fn has_allocation(&self, tuple: &FiveTuple) -> bool {
        self.allocations.read().unwrap().contains_key(tuple)
    }

    fn get(&self, tuple: &FiveTuple) -> Option<Arc<Allocation>> {
        self.allocations.read().unwrap().get(tuple).cloned()
    }

    pub fn remove(&self, tuple: &FiveTuple) {
        let removed = self.allocations.write().unwrap().remove(tuple);
        if let Some(alloc) = removed {
            alloc.cancel.cancel();
            self.release_user(&alloc.user_id);
            inc(&self.metrics.allocations_deleted, 1);
            debug!(?tuple, "allocation deleted");
        }
    }

    fn release_user(&self, user: &str) {
        let mut per_user = self.per_user.lock().unwrap();
        if let Some(n) = per_user.get_mut(user) {
            *n -= 1;
            if *n == 0 {
                per_user.remove(user);
            }
        }
    }

    pub fn shutdown(&self) {
        let tuples: Vec<FiveTuple> = self.allocations.read().unwrap().keys().copied().collect();
        for t in tuples {
            self.remove(&t);
        }
    }

    /// Expires allocations, permissions and channel bindings.
    pub async fn sweep(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            let now = Instant::now();
            let mut expired = Vec::new();
            for (tuple, alloc) in self.allocations.read().unwrap().iter() {
                let mut st = alloc.state.lock().unwrap();
                if st.expires <= now {
                    expired.push(*tuple);
                    continue;
                }
                st.permissions.retain(|_, exp| *exp > now);
                let dead: Vec<u16> = st.channels.iter().filter(|(_, (_, exp))| *exp <= now).map(|(ch, _)| *ch).collect();
                for ch in dead {
                    if let Some((peer, _)) = st.channels.remove(&ch) {
                        st.peer_channels.remove(&peer);
                    }
                }
            }
            for tuple in expired {
                self.remove(&tuple);
            }
        }
    }

    /// One packet from a client; returns the response to send back, if any.
    pub fn handle(&self, tuple: &FiveTuple, sink: &dyn Fn() -> ClientSink, pkt: &[u8]) -> Option<Vec<u8>> {
        match pkt.first()? >> 6 {
            0 => self.handle_stun(tuple, sink, pkt),
            1 => {
                self.handle_channel_data(tuple, pkt);
                None
            }
            _ => None,
        }
    }

    fn handle_stun(&self, tuple: &FiveTuple, sink: &dyn Fn() -> ClientSink, pkt: &[u8]) -> Option<Vec<u8>> {
        let msg = match Message::parse(pkt) {
            Ok(m) => m,
            Err(_) => {
                inc(&self.metrics.malformed, 1);
                return None;
            }
        };
        match msg.class {
            Class::Request => {}
            Class::Indication => {
                if msg.method == method::SEND {
                    self.handle_send(tuple, &msg);
                }
                return None;
            }
            _ => return None,
        }
        let unknown: Vec<u8> = msg
            .attr_types()
            .filter(|t| *t < 0x8000 && !stun::KNOWN_REQUIRED.contains(t))
            .flat_map(u16::to_be_bytes)
            .collect();
        if !unknown.is_empty() {
            return Some(
                Builder::new(msg.method, Class::Error, &msg.transaction_id)
                    .error(420, "Unknown Attribute")
                    .attr(attr::UNKNOWN_ATTRIBUTES, &unknown)
                    .attr(attr::SOFTWARE, SOFTWARE.as_bytes())
                    .fingerprint()
                    .finish(),
            );
        }
        Some(match msg.method {
            method::BINDING => self.binding(tuple, &msg),
            method::ALLOCATE => self.allocate(tuple, sink, &msg),
            method::REFRESH => self.refresh(tuple, &msg),
            method::CREATE_PERMISSION => self.create_permission(tuple, &msg),
            method::CHANNEL_BIND => self.channel_bind(tuple, &msg),
            _ => self.error(&msg, 400, "Bad Request", None),
        })
    }

    fn error(&self, msg: &Message, code: u16, reason: &str, key: Option<&[u8; 16]>) -> Vec<u8> {
        let mut b = Builder::new(msg.method, Class::Error, &msg.transaction_id);
        b.error(code, reason).attr(attr::SOFTWARE, SOFTWARE.as_bytes());
        if let Some(k) = key {
            b.integrity(k);
        }
        b.fingerprint().finish()
    }

    fn challenge(&self, msg: &Message, tuple: &FiveTuple, stale: bool) -> Vec<u8> {
        let (code, reason) = if stale { (438, "Stale Nonce") } else { (401, "Unauthorized") };
        Builder::new(msg.method, Class::Error, &msg.transaction_id)
            .error(code, reason)
            .attr(attr::REALM, self.auth.realm().as_bytes())
            .attr(attr::NONCE, self.auth.nonce(tuple.client.ip(), now_unix()).as_bytes())
            .attr(attr::SOFTWARE, SOFTWARE.as_bytes())
            .fingerprint()
            .finish()
    }

    fn authenticate(&self, tuple: &FiveTuple, msg: &Message) -> Result<Credentials, Vec<u8>> {
        match self.auth.check(msg, tuple.client.ip(), now_unix()) {
            Ok(c) => Ok(c),
            Err(Rejection::Challenge) => Err(self.challenge(msg, tuple, false)),
            Err(Rejection::StaleNonce) => Err(self.challenge(msg, tuple, true)),
            Err(Rejection::BadRequest) => Err(self.error(msg, 400, "Bad Request", None)),
            Err(Rejection::BadCredentials) => {
                inc(&self.metrics.auth_failures, 1);
                Err(self.challenge(msg, tuple, false))
            }
        }
    }

    /// Requests on an existing allocation: same username, and a credential
    /// that expired at most refresh-grace ago (a call may outlive it).
    fn authorize_existing(&self, tuple: &FiveTuple, msg: &Message) -> Result<(Arc<Allocation>, [u8; 16]), Vec<u8>> {
        let creds = self.authenticate(tuple, msg)?;
        let Some(alloc) = self.get(tuple) else {
            return Err(self.error(msg, 437, "Allocation Mismatch", Some(&creds.key)));
        };
        if creds.username != alloc.username {
            return Err(self.error(msg, 441, "Wrong Credentials", Some(&creds.key)));
        }
        if creds.expires_at + self.cfg.refresh_grace < now_unix() {
            inc(&self.metrics.auth_failures, 1);
            return Err(self.challenge(msg, tuple, false));
        }
        Ok((alloc, creds.key))
    }

    fn lifetime(&self, msg: &Message) -> u64 {
        let requested = msg.get_u32(attr::LIFETIME).map(u64::from).unwrap_or(DEFAULT_LIFETIME);
        requested.min(self.cfg.max_lifetime).max(DEFAULT_LIFETIME)
    }

    fn success(&self, msg: &Message, key: &[u8; 16], build: impl FnOnce(&mut Builder)) -> Vec<u8> {
        let mut b = Builder::new(msg.method, Class::Success, &msg.transaction_id);
        build(&mut b);
        b.attr(attr::SOFTWARE, SOFTWARE.as_bytes()).integrity(key).fingerprint().finish()
    }

    fn binding(&self, tuple: &FiveTuple, msg: &Message) -> Vec<u8> {
        Builder::new(method::BINDING, Class::Success, &msg.transaction_id)
            .xor_address(attr::XOR_MAPPED_ADDRESS, tuple.client)
            .mapped_address(tuple.client)
            .attr(attr::SOFTWARE, SOFTWARE.as_bytes())
            .fingerprint()
            .finish()
    }

    fn allocate(&self, tuple: &FiveTuple, sink: &dyn Fn() -> ClientSink, msg: &Message) -> Vec<u8> {
        if let Some(existing) = self.get(tuple) {
            let st = existing.state.lock().unwrap();
            if st.allocate_txid == msg.transaction_id {
                return st.allocate_reply.clone();
            }
        }
        let creds = match self.authenticate(tuple, msg) {
            Ok(c) => c,
            Err(reply) => return reply,
        };
        let key = Some(&creds.key);
        if self.get(tuple).is_some() {
            return self.error(msg, 437, "Allocation Mismatch", key);
        }
        if creds.expires_at < now_unix() {
            inc(&self.metrics.auth_failures, 1);
            return self.challenge(msg, tuple, false);
        }
        match msg.get_u32(attr::REQUESTED_TRANSPORT) {
            None => return self.error(msg, 400, "Bad Request", key),
            Some(v) if v >> 24 != 17 => return self.error(msg, 442, "Unsupported Transport Protocol", key),
            _ => {}
        }
        if msg.get(attr::RESERVATION_TOKEN).is_some() {
            return self.error(msg, 508, "Insufficient Capacity", key);
        }
        if msg.get(attr::REQUESTED_ADDRESS_FAMILY).is_some_and(|v| v.first() != Some(&0x01)) {
            return self.error(msg, 440, "Address Family not Supported", key);
        }
        if self.allocation_count() >= self.cfg.total_quota {
            inc(&self.metrics.quota_rejections, 1);
            return self.error(msg, 508, "Insufficient Capacity", key);
        }
        {
            let mut per_user = self.per_user.lock().unwrap();
            let n = per_user.entry(creds.user_id.clone()).or_insert(0);
            if *n >= self.cfg.user_quota {
                inc(&self.metrics.quota_rejections, 1);
                return self.error(msg, 486, "Allocation Quota Reached", key);
            }
            *n += 1;
        }
        let relay = match self.bind_relay(msg.get(attr::EVEN_PORT).is_some()) {
            Ok(s) => Arc::new(s),
            Err(_) => {
                self.release_user(&creds.user_id);
                return self.error(msg, 508, "Insufficient Capacity", key);
            }
        };
        let port = relay.local_addr().map(|a| a.port()).unwrap_or(0);
        let relayed = SocketAddr::new(self.cfg.external_ip, port);
        let lifetime = self.lifetime(msg);
        let reply = self.success(msg, &creds.key, |b| {
            b.xor_address(attr::XOR_RELAYED_ADDRESS, relayed)
                .xor_address(attr::XOR_MAPPED_ADDRESS, tuple.client)
                .u32(attr::LIFETIME, lifetime as u32);
        });
        let alloc = Arc::new(Allocation {
            to_peer: TokenBucket::new(self.cfg.max_bitrate),
            to_client: TokenBucket::new(self.cfg.max_bitrate),
            username: creds.username,
            user_id: creds.user_id,
            relay,
            sink: sink(),
            state: Mutex::new(AllocState {
                expires: Instant::now() + Duration::from_secs(lifetime),
                permissions: HashMap::new(),
                channels: HashMap::new(),
                peer_channels: HashMap::new(),
                allocate_txid: msg.transaction_id,
                allocate_reply: reply.clone(),
            }),
            cancel: CancellationToken::new(),
        });
        self.allocations.write().unwrap().insert(*tuple, alloc.clone());
        inc(&self.metrics.allocations_created, 1);
        debug!(?tuple, %relayed, "allocation created");
        tokio::spawn(relay_loop(alloc, self.metrics.clone()));
        reply
    }

    fn bind_relay(&self, even: bool) -> io::Result<UdpSocket> {
        let (min, max) = (self.cfg.min_port, self.cfg.max_port);
        let mut last = io::Error::new(io::ErrorKind::AddrInUse, "no free relay port");
        for _ in 0..64 {
            let mut port = rand::thread_rng().gen_range(min..=max);
            if even {
                port &= !1;
                if port < min {
                    continue;
                }
            }
            match bind_udp(SocketAddr::new(self.cfg.relay_bind_ip, port), 1 << 20, false) {
                Ok(s) => return Ok(s),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn refresh(&self, tuple: &FiveTuple, msg: &Message) -> Vec<u8> {
        let (alloc, key) = match self.authorize_existing(tuple, msg) {
            Ok(x) => x,
            Err(reply) => return reply,
        };
        let lifetime = if msg.get_u32(attr::LIFETIME) == Some(0) { 0 } else { self.lifetime(msg) };
        if lifetime == 0 {
            self.remove(tuple);
        } else {
            alloc.state.lock().unwrap().expires = Instant::now() + Duration::from_secs(lifetime);
        }
        self.success(msg, &key, |b| {
            b.u32(attr::LIFETIME, lifetime as u32);
        })
    }

    /// Validates a peer address: IPv4 only (relays are IPv4) and not internal.
    fn check_peer(&self, msg: &Message, peer: Option<SocketAddr>, key: &[u8; 16]) -> Result<SocketAddr, Vec<u8>> {
        let Some(peer) = peer.map(canonical) else {
            return Err(self.error(msg, 400, "Bad Request", Some(key)));
        };
        if !peer.is_ipv4() {
            return Err(self.error(msg, 443, "Peer Address Family Mismatch", Some(key)));
        }
        if !self.policy.allows(peer.ip()) || peer.port() == 0 {
            inc(&self.metrics.denied_peers, 1);
            return Err(self.error(msg, 403, "Forbidden", Some(key)));
        }
        Ok(peer)
    }

    fn create_permission(&self, tuple: &FiveTuple, msg: &Message) -> Vec<u8> {
        let (alloc, key) = match self.authorize_existing(tuple, msg) {
            Ok(x) => x,
            Err(reply) => return reply,
        };
        let raw_peers = msg.get_all(attr::XOR_PEER_ADDRESS);
        if raw_peers.is_empty() {
            return self.error(msg, 400, "Bad Request", Some(&key));
        }
        let mut peers = Vec::with_capacity(raw_peers.len());
        for v in raw_peers {
            match self.check_peer(msg, stun::decode_xor_address(v, &msg.transaction_id), &key) {
                Ok(p) => peers.push(p),
                Err(reply) => return reply,
            }
        }
        let expires = Instant::now() + PERMISSION_LIFETIME;
        let mut st = alloc.state.lock().unwrap();
        for p in peers {
            st.permissions.insert(p.ip(), expires);
        }
        drop(st);
        self.success(msg, &key, |_| {})
    }

    fn channel_bind(&self, tuple: &FiveTuple, msg: &Message) -> Vec<u8> {
        let (alloc, key) = match self.authorize_existing(tuple, msg) {
            Ok(x) => x,
            Err(reply) => return reply,
        };
        let channel = match msg.get(attr::CHANNEL_NUMBER) {
            Some(v) if v.len() >= 2 => u16::from_be_bytes([v[0], v[1]]),
            _ => return self.error(msg, 400, "Bad Request", Some(&key)),
        };
        if !(0x4000..=0x7FFF).contains(&channel) {
            return self.error(msg, 400, "Bad Request", Some(&key));
        }
        let peer = match self.check_peer(msg, msg.xor_address(attr::XOR_PEER_ADDRESS), &key) {
            Ok(p) => p,
            Err(reply) => return reply,
        };
        let now = Instant::now();
        let mut st = alloc.state.lock().unwrap();
        let channel_taken = st.channels.get(&channel).is_some_and(|(p, _)| *p != peer);
        let peer_taken = st.peer_channels.get(&peer).is_some_and(|c| *c != channel);
        if channel_taken || peer_taken {
            drop(st);
            return self.error(msg, 400, "Bad Request", Some(&key));
        }
        st.channels.insert(channel, (peer, now + CHANNEL_LIFETIME));
        st.peer_channels.insert(peer, channel);
        st.permissions.insert(peer.ip(), now + PERMISSION_LIFETIME);
        drop(st);
        self.success(msg, &key, |_| {})
    }

    fn handle_send(&self, tuple: &FiveTuple, msg: &Message) {
        let Some(alloc) = self.get(tuple) else { return };
        let (Some(peer), Some(data)) = (msg.xor_address(attr::XOR_PEER_ADDRESS), msg.get(attr::DATA)) else {
            return;
        };
        let peer = canonical(peer);
        if !alloc.state.lock().unwrap().permitted(peer, Instant::now()) {
            inc(&self.metrics.dropped_packets, 1);
            return;
        }
        self.to_peer(&alloc, data, peer);
    }

    fn handle_channel_data(&self, tuple: &FiveTuple, pkt: &[u8]) {
        let Some((channel, data)) = stun::parse_channel_data(pkt) else { return };
        let Some(alloc) = self.get(tuple) else { return };
        let peer = {
            let st = alloc.state.lock().unwrap();
            match st.channels.get(&channel) {
                Some((peer, exp)) if *exp > Instant::now() => *peer,
                _ => {
                    inc(&self.metrics.dropped_packets, 1);
                    return;
                }
            }
        };
        self.to_peer(&alloc, data, peer);
    }

    fn to_peer(&self, alloc: &Allocation, data: &[u8], peer: SocketAddr) {
        if !within(&alloc.to_peer, data.len()) {
            inc(&self.metrics.dropped_packets, 1);
            return;
        }
        match alloc.relay.try_send_to(data, peer) {
            Ok(n) => inc(&self.metrics.bytes_to_peer, n as u64),
            Err(_) => inc(&self.metrics.dropped_packets, 1),
        }
    }
}

/// Peer -> client for one allocation, until it is deleted.
async fn relay_loop(alloc: Arc<Allocation>, metrics: Arc<Metrics>) {
    let mut buf = vec![0u8; 65536];
    let stream = alloc.sink.is_stream();
    loop {
        let (n, from) = tokio::select! {
            _ = alloc.cancel.cancelled() => return,
            r = alloc.relay.recv_from(&mut buf) => match r {
                Ok(x) => x,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    continue;
                }
            },
        };
        let peer = canonical(from);
        if !within(&alloc.to_client, n) {
            inc(&metrics.dropped_packets, 1);
            continue;
        }
        let now = Instant::now();
        let channel = {
            let st = alloc.state.lock().unwrap();
            if !st.permitted(peer, now) {
                inc(&metrics.dropped_packets, 1);
                continue;
            }
            st.live_channel(peer, now)
        };
        let msg = match channel {
            Some(ch) => stun::channel_data(ch, &buf[..n], stream),
            None => stun::data_indication(peer, &buf[..n]),
        };
        if alloc.sink.send(msg) {
            inc(&metrics.bytes_to_client, n as u64);
        } else {
            inc(&metrics.dropped_packets, 1);
        }
    }
}
