use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};

use crate::{ConnectorError, Result};

// No Debug implementation: encryption keys never belong in diagnostic output.
#[derive(Clone)]
pub(crate) struct Crypto {
    key: [u8; 32],
}

impl Crypto {
    pub(crate) fn from_hex(encoded: &str) -> Result<Self> {
        if encoded.len() != 64 {
            return Err(ConnectorError::unavailable());
        }
        let mut key = [0u8; 32];
        for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(ConnectorError::unavailable)?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(ConnectorError::unavailable)?;
            key[index] = ((high << 4) | low) as u8;
        }
        Ok(Self { key })
    }

    pub(crate) fn encrypt(
        &self,
        user: &str,
        service: &str,
        purpose: &str,
        plaintext: &[u8],
    ) -> Result<String> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| ConnectorError::internal())?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = context(user, service, purpose);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ConnectorError::internal())?;
        Ok(format!(
            "v1.{}.{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(ciphertext)
        ))
    }

    pub(crate) fn decrypt(
        &self,
        user: &str,
        service: &str,
        purpose: &str,
        encoded: &str,
    ) -> Result<Vec<u8>> {
        let parts: Vec<_> = encoded.split('.').collect();
        if parts.len() != 3 || parts[0] != "v1" || encoded.len() > 65536 {
            return Err(ConnectorError::reconnect());
        }
        let nonce = URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|_| ConnectorError::reconnect())?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(parts[2])
            .map_err(|_| ConnectorError::reconnect())?;
        if nonce.len() != 12 {
            return Err(ConnectorError::reconnect());
        }
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| ConnectorError::internal())?;
        let aad = context(user, service, purpose);
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ConnectorError::reconnect())
    }
}

fn context(user: &str, service: &str, purpose: &str) -> String {
    // Length delimiters make the binding unambiguous even for unusual future IDs.
    format!(
        "tomorrow-connectors:v1:{}:{user}:{}:{service}:{}:{purpose}",
        user.len(),
        service.len(),
        purpose.len()
    )
}

pub(crate) fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
