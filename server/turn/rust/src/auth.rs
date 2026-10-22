//! TURN REST credentials: username "<unix expiry>:<user id>", password
//! base64(HMAC-SHA1(shared secret, username)), long-term key
//! MD5(username:realm:password). Nonces are stateless: issue time + MAC.

use std::net::IpAddr;

use base64::Engine;
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;
use sha2::Sha256;

use crate::stun::{attr, Message};

const NONCE_TTL_SECS: u64 = 3600;

pub struct Credentials {
    pub username: String,
    pub user_id: String,
    pub expires_at: u64,
    pub key: [u8; 16],
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rejection {
    /// No MESSAGE-INTEGRITY yet: answer 401 with realm and nonce.
    Challenge,
    BadCredentials,
    StaleNonce,
    BadRequest,
}

pub struct Auth {
    secret: Vec<u8>,
    realm: String,
    nonce_key: [u8; 32],
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Auth {
    pub fn new(secret: Vec<u8>, realm: String) -> Self {
        Auth { secret, realm, nonce_key: rand::random() }
    }

    pub fn realm(&self) -> &str {
        &self.realm
    }

    pub fn password(&self, username: &str) -> String {
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(&self.secret).expect("any key length");
        mac.update(username.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    pub fn long_term_key(username: &str, realm: &str, password: &str) -> [u8; 16] {
        Md5::digest(format!("{username}:{realm}:{password}").as_bytes()).into()
    }

    fn nonce_mac(&self, issued: u64, ip: IpAddr) -> Hmac<Sha256> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.nonce_key).expect("any key length");
        mac.update(&issued.to_be_bytes());
        match ip.to_canonical() {
            IpAddr::V4(v4) => mac.update(&v4.octets()),
            IpAddr::V6(v6) => mac.update(&v6.octets()),
        }
        mac
    }

    pub fn nonce(&self, ip: IpAddr, now: u64) -> String {
        let tag = self.nonce_mac(now, ip).finalize().into_bytes();
        format!("{now:016x}{}", hex(&tag[..8]))
    }

    pub fn nonce_ok(&self, nonce: &str, ip: IpAddr, now: u64) -> bool {
        if nonce.len() != 32 || !nonce.is_ascii() {
            return false;
        }
        let Ok(issued) = u64::from_str_radix(&nonce[..16], 16) else { return false };
        if issued > now + 5 || now - issued.min(now) > NONCE_TTL_SECS {
            return false;
        }
        let mut tag = [0u8; 8];
        for (i, out) in tag.iter_mut().enumerate() {
            match u8::from_str_radix(&nonce[16 + 2 * i..18 + 2 * i], 16) {
                Ok(b) => *out = b,
                Err(_) => return false,
            }
        }
        self.nonce_mac(issued, ip).verify_truncated_left(&tag).is_ok()
    }

    /// Checks MESSAGE-INTEGRITY; whether an expired credential is still good
    /// enough is the caller's decision (new allocation vs. refresh).
    pub fn check(&self, msg: &Message, ip: IpAddr, now: u64) -> Result<Credentials, Rejection> {
        if !msg.has_integrity() {
            return Err(Rejection::Challenge);
        }
        let (Some(username), Some(realm), Some(nonce)) =
            (msg.get_str(attr::USERNAME), msg.get_str(attr::REALM), msg.get_str(attr::NONCE))
        else {
            return Err(Rejection::BadRequest);
        };
        if !self.nonce_ok(nonce, ip, now) {
            return Err(Rejection::StaleNonce);
        }
        if realm != self.realm {
            return Err(Rejection::BadCredentials);
        }
        let Some((expiry, user)) = username.split_once(':') else { return Err(Rejection::BadCredentials) };
        let Ok(expires_at) = expiry.parse::<u64>() else { return Err(Rejection::BadCredentials) };
        if user.is_empty() {
            return Err(Rejection::BadCredentials);
        }
        let key = Self::long_term_key(username, realm, &self.password(username));
        if !msg.verify_integrity(&key) {
            return Err(Rejection::BadCredentials);
        }
        Ok(Credentials { username: username.to_string(), user_id: user.to_string(), expires_at, key })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stun::{method, Builder, Class};

    fn request(auth: &Auth, username: &str, password: &str, nonce: &str) -> Vec<u8> {
        let key = Auth::long_term_key(username, auth.realm(), password);
        Builder::new(method::ALLOCATE, Class::Request, &[1; 12])
            .u32(attr::REQUESTED_TRANSPORT, 17 << 24)
            .attr(attr::USERNAME, username.as_bytes())
            .attr(attr::REALM, auth.realm().as_bytes())
            .attr(attr::NONCE, nonce.as_bytes())
            .integrity(&key)
            .finish()
    }

    #[test]
    fn accepts_rest_credentials_and_rejects_forgeries() {
        let auth = Auth::new(b"s3cret".to_vec(), "televo".into());
        let ip: IpAddr = "198.51.100.7".parse().unwrap();
        let now = 1_800_000_000;
        let nonce = auth.nonce(ip, now);
        let user = "1800003600:4c7f0d2e-user";
        let good = request(&auth, user, &auth.password(user), &nonce);
        let creds = auth.check(&Message::parse(&good).unwrap(), ip, now).unwrap();
        assert_eq!(creds.user_id, "4c7f0d2e-user");
        assert_eq!(creds.expires_at, 1_800_003_600);

        let forged = request(&auth, user, "guess", &nonce);
        assert_eq!(auth.check(&Message::parse(&forged).unwrap(), ip, now).err(), Some(Rejection::BadCredentials));
        assert_eq!(auth.check(&Message::parse(&good).unwrap(), "198.51.100.8".parse().unwrap(), now).err(), Some(Rejection::StaleNonce));
        assert_eq!(auth.check(&Message::parse(&good).unwrap(), ip, now + NONCE_TTL_SECS + 1).err(), Some(Rejection::StaleNonce));
    }

    #[test]
    fn password_matches_the_edge_function() {
        // turn-credentials: btoa(HMAC-SHA1(COTURN_SECRET, username))
        let auth = Auth::new(b"secret".to_vec(), "r".into());
        assert_eq!(auth.password("1700000000:user"), "I/MZeIG6MwzOV8Uubr9liB2556o=");
    }
}
