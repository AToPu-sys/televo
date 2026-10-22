//! STUN (RFC 5389) codec with the TURN (RFC 5766) methods and attributes.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use hmac::{Hmac, Mac};
use sha1::Sha1;

pub const MAGIC_COOKIE: u32 = 0x2112_A442;
pub const HEADER_LEN: usize = 20;
const FINGERPRINT_XOR: u32 = 0x5354_554E;

pub mod method {
    pub const BINDING: u16 = 0x001;
    pub const ALLOCATE: u16 = 0x003;
    pub const REFRESH: u16 = 0x004;
    pub const SEND: u16 = 0x006;
    pub const DATA: u16 = 0x007;
    pub const CREATE_PERMISSION: u16 = 0x008;
    pub const CHANNEL_BIND: u16 = 0x009;
}

pub mod attr {
    pub const MAPPED_ADDRESS: u16 = 0x0001;
    pub const USERNAME: u16 = 0x0006;
    pub const MESSAGE_INTEGRITY: u16 = 0x0008;
    pub const ERROR_CODE: u16 = 0x0009;
    pub const UNKNOWN_ATTRIBUTES: u16 = 0x000A;
    pub const CHANNEL_NUMBER: u16 = 0x000C;
    pub const LIFETIME: u16 = 0x000D;
    pub const XOR_PEER_ADDRESS: u16 = 0x0012;
    pub const DATA: u16 = 0x0013;
    pub const REALM: u16 = 0x0014;
    pub const NONCE: u16 = 0x0015;
    pub const XOR_RELAYED_ADDRESS: u16 = 0x0016;
    pub const REQUESTED_ADDRESS_FAMILY: u16 = 0x0017;
    pub const EVEN_PORT: u16 = 0x0018;
    pub const REQUESTED_TRANSPORT: u16 = 0x0019;
    pub const XOR_MAPPED_ADDRESS: u16 = 0x0020;
    pub const RESERVATION_TOKEN: u16 = 0x0022;
    pub const SOFTWARE: u16 = 0x8022;
    pub const FINGERPRINT: u16 = 0x8028;
}

/// Comprehension-required attributes this server accepts in a request;
/// any other one in 0x0000-0x7FFF gets a 420.
pub const KNOWN_REQUIRED: &[u16] = &[
    0x0001, 0x0002, 0x0003, 0x0006, 0x0008, 0x0009, 0x000A, 0x000C, 0x000D, 0x0012, 0x0013, 0x0014, 0x0015,
    0x0016, 0x0017, 0x0018, 0x0019, 0x001A, 0x001C, 0x001D, 0x001E, 0x0020, 0x0022, 0x0024, 0x0025, 0x0026,
    0x0027, 0x002A,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Request,
    Indication,
    Success,
    Error,
}

impl Class {
    fn bits(self) -> u16 {
        match self {
            Class::Request => 0,
            Class::Indication => 1,
            Class::Success => 2,
            Class::Error => 3,
        }
    }
}

pub fn message_type(method: u16, class: Class) -> u16 {
    let c = class.bits();
    (method & 0x000F) | ((method & 0x0070) << 1) | ((method & 0x0F80) << 2) | ((c & 1) << 4) | ((c & 2) << 7)
}

fn split_type(t: u16) -> (u16, Class) {
    let method = (t & 0x000F) | ((t & 0x00E0) >> 1) | ((t & 0x3E00) >> 2);
    let class = match ((t >> 4) & 1) | ((t >> 7) & 2) {
        0 => Class::Request,
        1 => Class::Indication,
        2 => Class::Success,
        _ => Class::Error,
    };
    (method, class)
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    NotStun,
    BadLength,
    BadAttribute,
    BadFingerprint,
}

struct Attr {
    typ: u16,
    start: usize,
    len: usize,
}

pub struct Message<'a> {
    pub method: u16,
    pub class: Class,
    pub transaction_id: [u8; 12],
    raw: &'a [u8],
    attrs: Vec<Attr>,
    integrity_at: Option<usize>,
}

impl<'a> Message<'a> {
    pub fn parse(raw: &'a [u8]) -> Result<Self, ParseError> {
        if raw.len() < HEADER_LEN || raw[0] & 0xC0 != 0 {
            return Err(ParseError::NotStun);
        }
        if u32::from_be_bytes([raw[4], raw[5], raw[6], raw[7]]) != MAGIC_COOKIE {
            return Err(ParseError::NotStun);
        }
        let len = u16::from_be_bytes([raw[2], raw[3]]) as usize;
        if len % 4 != 0 || HEADER_LEN + len != raw.len() {
            return Err(ParseError::BadLength);
        }
        let (method, class) = split_type(u16::from_be_bytes([raw[0], raw[1]]));
        let mut transaction_id = [0u8; 12];
        transaction_id.copy_from_slice(&raw[8..20]);

        let mut attrs = Vec::new();
        let mut integrity_at = None;
        let mut pos = HEADER_LEN;
        while pos < raw.len() {
            if pos + 4 > raw.len() {
                return Err(ParseError::BadAttribute);
            }
            let typ = u16::from_be_bytes([raw[pos], raw[pos + 1]]);
            let alen = u16::from_be_bytes([raw[pos + 2], raw[pos + 3]]) as usize;
            let start = pos + 4;
            let padded = (alen + 3) & !3;
            if start + padded > raw.len() {
                return Err(ParseError::BadAttribute);
            }
            if typ == attr::FINGERPRINT {
                if alen != 4 || start + 4 != raw.len() {
                    return Err(ParseError::BadFingerprint);
                }
                let expected = crc32fast::hash(&raw[..pos]) ^ FINGERPRINT_XOR;
                let got = u32::from_be_bytes([raw[start], raw[start + 1], raw[start + 2], raw[start + 3]]);
                if got != expected {
                    return Err(ParseError::BadFingerprint);
                }
                break;
            }
            // Everything after MESSAGE-INTEGRITY except FINGERPRINT is ignored (RFC 5389 15.4).
            if integrity_at.is_none() {
                if typ == attr::MESSAGE_INTEGRITY {
                    if alen != 20 {
                        return Err(ParseError::BadAttribute);
                    }
                    integrity_at = Some(pos);
                }
                attrs.push(Attr { typ, start, len: alen });
            }
            pos = start + padded;
        }
        Ok(Message { method, class, transaction_id, raw, attrs, integrity_at })
    }

    pub fn get(&self, typ: u16) -> Option<&'a [u8]> {
        let raw = self.raw;
        self.attrs.iter().find(|a| a.typ == typ).map(|a| &raw[a.start..a.start + a.len])
    }

    pub fn get_all(&self, typ: u16) -> Vec<&'a [u8]> {
        let raw = self.raw;
        self.attrs.iter().filter(|a| a.typ == typ).map(|a| &raw[a.start..a.start + a.len]).collect()
    }

    pub fn attr_types(&self) -> impl Iterator<Item = u16> + '_ {
        self.attrs.iter().map(|a| a.typ)
    }

    pub fn has_integrity(&self) -> bool {
        self.integrity_at.is_some()
    }

    pub fn get_str(&self, typ: u16) -> Option<&'a str> {
        self.get(typ).and_then(|v| std::str::from_utf8(v).ok())
    }

    pub fn get_u32(&self, typ: u16) -> Option<u32> {
        self.get(typ).filter(|v| v.len() >= 4).map(|v| u32::from_be_bytes([v[0], v[1], v[2], v[3]]))
    }

    pub fn xor_address(&self, typ: u16) -> Option<SocketAddr> {
        self.get(typ).and_then(|v| decode_xor_address(v, &self.transaction_id))
    }

    pub fn verify_integrity(&self, key: &[u8]) -> bool {
        let Some(at) = self.integrity_at else { return false };
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
        let len = (at + 24 - HEADER_LEN) as u16;
        mac.update(&self.raw[0..2]);
        mac.update(&len.to_be_bytes());
        mac.update(&self.raw[4..at]);
        mac.verify_slice(&self.raw[at + 4..at + 24]).is_ok()
    }
}

pub fn decode_xor_address(v: &[u8], tid: &[u8; 12]) -> Option<SocketAddr> {
    if v.len() < 4 {
        return None;
    }
    let port = u16::from_be_bytes([v[2], v[3]]) ^ (MAGIC_COOKIE >> 16) as u16;
    match v[1] {
        0x01 if v.len() >= 8 => {
            let x = u32::from_be_bytes([v[4], v[5], v[6], v[7]]) ^ MAGIC_COOKIE;
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(x)), port))
        }
        0x02 if v.len() >= 20 => {
            let mut mask = [0u8; 16];
            mask[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            mask[4..].copy_from_slice(tid);
            let mut ip = [0u8; 16];
            for i in 0..16 {
                ip[i] = v[4 + i] ^ mask[i];
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip)), port))
        }
        _ => None,
    }
}

pub fn encode_xor_address(addr: SocketAddr, tid: &[u8; 12]) -> Vec<u8> {
    let port = addr.port() ^ (MAGIC_COOKIE >> 16) as u16;
    let mut out = vec![0u8];
    match addr.ip() {
        IpAddr::V4(ip) => {
            out.push(0x01);
            out.extend_from_slice(&port.to_be_bytes());
            out.extend_from_slice(&(u32::from(ip) ^ MAGIC_COOKIE).to_be_bytes());
        }
        IpAddr::V6(ip) => {
            out.push(0x02);
            out.extend_from_slice(&port.to_be_bytes());
            let mut mask = [0u8; 16];
            mask[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            mask[4..].copy_from_slice(tid);
            for (b, m) in ip.octets().iter().zip(mask) {
                out.push(b ^ m);
            }
        }
    }
    out
}

pub struct Builder {
    buf: Vec<u8>,
}

impl Builder {
    pub fn new(method: u16, class: Class, tid: &[u8; 12]) -> Self {
        let mut buf = Vec::with_capacity(160);
        buf.extend_from_slice(&message_type(method, class).to_be_bytes());
        buf.extend_from_slice(&[0, 0]);
        buf.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        buf.extend_from_slice(tid);
        Builder { buf }
    }

    fn tid(&self) -> [u8; 12] {
        let mut t = [0u8; 12];
        t.copy_from_slice(&self.buf[8..20]);
        t
    }

    fn set_len(&mut self, extra: usize) {
        let len = (self.buf.len() - HEADER_LEN + extra) as u16;
        self.buf[2..4].copy_from_slice(&len.to_be_bytes());
    }

    pub fn attr(&mut self, typ: u16, value: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(&typ.to_be_bytes());
        self.buf.extend_from_slice(&(value.len() as u16).to_be_bytes());
        self.buf.extend_from_slice(value);
        self.buf.resize(self.buf.len() + (4 - value.len() % 4) % 4, 0);
        self.set_len(0);
        self
    }

    pub fn u32(&mut self, typ: u16, v: u32) -> &mut Self {
        self.attr(typ, &v.to_be_bytes())
    }

    pub fn xor_address(&mut self, typ: u16, addr: SocketAddr) -> &mut Self {
        let v = encode_xor_address(addr, &self.tid());
        self.attr(typ, &v)
    }

    pub fn mapped_address(&mut self, addr: SocketAddr) -> &mut Self {
        let mut v = vec![0u8];
        match addr.ip() {
            IpAddr::V4(ip) => {
                v.push(0x01);
                v.extend_from_slice(&addr.port().to_be_bytes());
                v.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                v.push(0x02);
                v.extend_from_slice(&addr.port().to_be_bytes());
                v.extend_from_slice(&ip.octets());
            }
        }
        self.attr(attr::MAPPED_ADDRESS, &v)
    }

    pub fn error(&mut self, code: u16, reason: &str) -> &mut Self {
        let mut v = vec![0, 0, (code / 100) as u8, (code % 100) as u8];
        v.extend_from_slice(reason.as_bytes());
        self.attr(attr::ERROR_CODE, &v)
    }

    pub fn integrity(&mut self, key: &[u8]) -> &mut Self {
        self.set_len(24);
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
        mac.update(&self.buf);
        let tag = mac.finalize().into_bytes();
        self.buf.extend_from_slice(&attr::MESSAGE_INTEGRITY.to_be_bytes());
        self.buf.extend_from_slice(&20u16.to_be_bytes());
        self.buf.extend_from_slice(&tag);
        self
    }

    pub fn fingerprint(&mut self) -> &mut Self {
        self.set_len(8);
        let crc = crc32fast::hash(&self.buf) ^ FINGERPRINT_XOR;
        self.buf.extend_from_slice(&attr::FINGERPRINT.to_be_bytes());
        self.buf.extend_from_slice(&4u16.to_be_bytes());
        self.buf.extend_from_slice(&crc.to_be_bytes());
        self
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

/// ChannelData (RFC 5766 11.4); padded to 4 bytes on stream transports.
pub fn channel_data(channel: u16, data: &[u8], pad: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len() + 3);
    out.extend_from_slice(&channel.to_be_bytes());
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
    if pad {
        out.resize(out.len() + (4 - data.len() % 4) % 4, 0);
    }
    out
}

pub fn parse_channel_data(pkt: &[u8]) -> Option<(u16, &[u8])> {
    if pkt.len() < 4 {
        return None;
    }
    let channel = u16::from_be_bytes([pkt[0], pkt[1]]);
    if !(0x4000..=0x7FFF).contains(&channel) {
        return None;
    }
    let len = u16::from_be_bytes([pkt[2], pkt[3]]) as usize;
    pkt.get(4..4 + len).map(|data| (channel, data))
}

pub fn data_indication(peer: SocketAddr, data: &[u8]) -> Vec<u8> {
    let tid: [u8; 12] = rand::random();
    Builder::new(method::DATA, Class::Indication, &tid)
        .xor_address(attr::XOR_PEER_ADDRESS, peer)
        .attr(attr::DATA, data)
        .finish()
}

/// Bytes needed for the next whole message on a stream transport, once the
/// first 4 bytes are in; None while fewer are buffered, Err on garbage.
pub fn stream_frame_len(buf: &[u8]) -> Result<Option<usize>, ()> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    match buf[0] >> 6 {
        0 => Ok(Some(HEADER_LEN + len)),
        1 => Ok(Some((4 + len + 3) & !3)),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_encoding_matches_rfc_values() {
        assert_eq!(message_type(method::BINDING, Class::Request), 0x0001);
        assert_eq!(message_type(method::BINDING, Class::Success), 0x0101);
        assert_eq!(message_type(method::ALLOCATE, Class::Error), 0x0113);
        assert_eq!(message_type(method::SEND, Class::Indication), 0x0016);
        assert_eq!(message_type(method::DATA, Class::Indication), 0x0017);
        for m in [1u16, 3, 4, 6, 7, 8, 9] {
            for c in [Class::Request, Class::Indication, Class::Success, Class::Error] {
                assert_eq!(split_type(message_type(m, c)), (m, c));
            }
        }
    }

    #[test]
    fn builds_and_parses_with_integrity_and_fingerprint() {
        let tid = [7u8; 12];
        let peer: SocketAddr = "203.0.113.9:4242".parse().unwrap();
        let six: SocketAddr = "[2001:db8::1]:9".parse().unwrap();
        let raw = Builder::new(method::ALLOCATE, Class::Success, &tid)
            .xor_address(attr::XOR_RELAYED_ADDRESS, peer)
            .xor_address(attr::XOR_PEER_ADDRESS, six)
            .u32(attr::LIFETIME, 600)
            .attr(attr::SOFTWARE, b"x")
            .integrity(b"key")
            .fingerprint()
            .finish();
        let msg = Message::parse(&raw).unwrap();
        assert_eq!((msg.method, msg.class), (method::ALLOCATE, Class::Success));
        assert_eq!(msg.xor_address(attr::XOR_RELAYED_ADDRESS), Some(peer));
        assert_eq!(msg.xor_address(attr::XOR_PEER_ADDRESS), Some(six));
        assert_eq!(msg.get_u32(attr::LIFETIME), Some(600));
        assert!(msg.verify_integrity(b"key"));
        assert!(!msg.verify_integrity(b"other"));

        let mut broken = raw.clone();
        broken[30] ^= 1;
        assert!(Message::parse(&broken).is_err());
    }

    // RFC 5769 2.2: sample IPv4 response, short-term password as the key.
    #[test]
    fn rfc5769_ipv4_response() {
        let raw: [u8; 80] = [
            0x01, 0x01, 0x00, 0x3c, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87,
            0xdf, 0xae, 0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20,
            0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43, 0x00, 0x08, 0x00, 0x14, 0x2b, 0x91,
            0xf5, 0x99, 0xfd, 0x9e, 0x90, 0xc3, 0x8c, 0x74, 0x89, 0xf9, 0x2a, 0xf9, 0xba, 0x53, 0xf0, 0x6b, 0xe7, 0xd7,
            0x80, 0x28, 0x00, 0x04, 0xc0, 0x7d, 0x4c, 0x96,
        ];
        let msg = Message::parse(&raw).expect("parses, fingerprint ok");
        assert_eq!(msg.xor_address(attr::XOR_MAPPED_ADDRESS), Some("192.0.2.1:32853".parse().unwrap()));
        assert!(msg.verify_integrity(b"VOkJxbRl1RmTxUk/WvJxBt"));
    }

    #[test]
    fn channel_data_framing() {
        let framed = channel_data(0x4001, b"abcde", true);
        assert_eq!(framed.len(), 12);
        assert_eq!(stream_frame_len(&framed), Ok(Some(12)));
        assert_eq!(parse_channel_data(&framed), Some((0x4001, &b"abcde"[..])));
        assert_eq!(channel_data(0x4001, b"abcde", false).len(), 9);
        assert_eq!(parse_channel_data(&[0x80, 0, 0, 0]), None);
    }
}
