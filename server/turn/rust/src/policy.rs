//! Peers a relay must never reach: private networks, loopback, link-local
//! (incl. the cloud metadata service), CGNAT, multicast, reserved ranges.

use std::net::IpAddr;

const DENIED: &[&str] = &[
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4",
    "240.0.0.0/4", "::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10",
    "ff00::/8",
];

#[derive(Clone, Copy, Debug)]
struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl Cidr {
    fn parse(s: &str) -> Option<Self> {
        let (ip, prefix) = s.split_once('/')?;
        let net: IpAddr = ip.trim().parse().ok()?;
        let prefix: u8 = prefix.trim().parse().ok()?;
        let max = if net.is_ipv4() { 32 } else { 128 };
        (prefix <= max).then_some(Cidr { net, prefix })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (self.net, ip) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                let mask = if self.prefix == 0 { 0 } else { u32::MAX << (32 - self.prefix) };
                u32::from(n) & mask == u32::from(i) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => {
                let mask = if self.prefix == 0 { 0 } else { u128::MAX << (128 - self.prefix) };
                u128::from(n) & mask == u128::from(i) & mask
            }
            _ => false,
        }
    }
}

pub struct PeerPolicy {
    deny: Vec<Cidr>,
    allow: Vec<Cidr>,
}

impl PeerPolicy {
    pub fn new(allow: &[String]) -> Result<Self, String> {
        let parse = |s: &str| Cidr::parse(s).ok_or_else(|| format!("bad CIDR {s:?}"));
        Ok(PeerPolicy {
            deny: DENIED.iter().map(|s| parse(s)).collect::<Result<_, _>>()?,
            allow: allow.iter().filter(|s| !s.trim().is_empty()).map(|s| parse(s)).collect::<Result<_, _>>()?,
        })
    }

    pub fn allows(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.allow.iter().any(|c| c.contains(ip)) || !self.deny.iter().any(|c| c.contains(ip))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_internal_ranges_only() {
        let p = PeerPolicy::new(&[]).unwrap();
        for bad in ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(!p.allows(bad.parse().unwrap()), "{bad}");
        }
        for good in ["8.8.8.8", "51.158.147.206", "2a00:1450::1"] {
            assert!(p.allows(good.parse().unwrap()), "{good}");
        }
        let test = PeerPolicy::new(&["127.0.0.0/8".into()]).unwrap();
        assert!(test.allows("127.0.0.1".parse().unwrap()));
    }
}
