//! UDP, TCP and TLS listeners. Stream transports frame STUN messages and
//! ChannelData (padded to 4 bytes) per RFC 5766 11.5.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::warn;

use crate::relay::{canonical, ClientSink, FiveTuple, Server, Transport};
use crate::stun;
use crate::tls::Certs;

const MAX_STREAM_BUFFER: usize = 256 * 1024;
const NO_ALLOCATION_TIMEOUT: Duration = Duration::from_secs(60);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn serve_udp(server: Arc<Server>, socket: Arc<UdpSocket>) {
    let local = socket.local_addr().expect("bound socket");
    let mut buf = vec![0u8; 65536];
    loop {
        let (n, from) = match socket.recv_from(&mut buf).await {
            Ok(x) => x,
            Err(e) => {
                warn!("udp recv on {local}: {e}");
                tokio::time::sleep(Duration::from_millis(5)).await;
                continue;
            }
        };
        let tuple = FiveTuple { transport: Transport::Udp, local, client: canonical(from) };
        let sink = || ClientSink::Udp { socket: socket.clone(), client: from };
        if let Some(reply) = server.handle(&tuple, &sink, &buf[..n]) {
            let _ = socket.try_send_to(&reply, from);
        }
    }
}

pub async fn serve_stream(server: Arc<Server>, listener: TcpListener, certs: Option<Arc<Certs>>, max_connections: usize) {
    let local = listener.local_addr().expect("bound listener");
    loop {
        let (tcp, from) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                warn!("accept on {local}: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let open = &server.metrics.stream_connections;
        if open.fetch_add(1, Ordering::Relaxed) >= max_connections {
            open.fetch_sub(1, Ordering::Relaxed);
            continue;
        }
        let _ = tcp.set_nodelay(true);
        let server = server.clone();
        let certs = certs.clone();
        tokio::spawn(async move {
            let transport = if certs.is_some() { Transport::Tls } else { Transport::Tcp };
            let tuple = FiveTuple { transport, local, client: canonical(from) };
            match certs {
                Some(certs) => {
                    if let Ok(Ok(tls)) = timeout(HANDSHAKE_TIMEOUT, certs.acceptor().accept(tcp)).await {
                        run_stream(&server, tuple, tls).await;
                    }
                }
                None => run_stream(&server, tuple, tcp).await,
            }
            server.metrics.stream_connections.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn run_stream<S>(server: &Arc<Server>, tuple: FiveTuple, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(1024);
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if wr.write_all(&msg).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });

    let mut buf = BytesMut::with_capacity(16 * 1024);
    let mut idle_since = Instant::now();
    'conn: loop {
        loop {
            let need = match stun::stream_frame_len(&buf) {
                Ok(Some(n)) if buf.len() >= n => n,
                Ok(_) => break,
                Err(()) => break 'conn,
            };
            let frame = buf.split_to(need);
            let sink = || ClientSink::Stream(tx.clone());
            if let Some(reply) = server.handle(&tuple, &sink, &frame) {
                let _ = tx.try_send(reply);
            }
        }
        if buf.len() > MAX_STREAM_BUFFER {
            break;
        }
        match timeout(Duration::from_secs(30), rd.read_buf(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(_)) => {}
            Err(_) => {}
        }
        if server.has_allocation(&tuple) {
            idle_since = Instant::now();
        } else if idle_since.elapsed() > NO_ALLOCATION_TIMEOUT {
            break;
        }
    }
    server.remove(&tuple);
    drop(tx);
    let _ = writer.await;
}

pub fn first_udp_target(addrs: &[SocketAddr]) -> Option<SocketAddr> {
    addrs.first().map(|a| {
        let ip = if a.ip().is_unspecified() { "127.0.0.1".parse().unwrap() } else { a.ip() };
        SocketAddr::new(ip, a.port())
    })
}
