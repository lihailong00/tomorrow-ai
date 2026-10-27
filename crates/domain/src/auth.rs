use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::DomainError;

const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;

/// Password hashing is CPU/memory intensive; async callers should use spawn_blocking.
pub fn hash_password(password: &str) -> Result<String, DomainError> {
    validate_password(password)?;

    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| DomainError::Internal("密码处理失败".into()))
}

/// Validate Unicode character length without trimming or changing the password.
pub fn validate_password(password: &str) -> Result<(), DomainError> {
    if password_length_is_valid(password) {
        Ok(())
    } else {
        Err(DomainError::Validation("密码长度须为 8～128 个字符".into()))
    }
}

/// Malformed hashes and invalid passwords are authentication failures, never panics.
pub fn verify_password(password: &str, encoded_hash: &str) -> bool {
    if !password_length_is_valid(password) {
        return false;
    }
    let Ok(parsed_hash) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

/// A session token contains 256 bits from the operating system's random generator.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

/// Only this one-way digest belongs in the session table; return the token once.
pub fn hash_token(token: &str) -> String {
    hex_encode(&Sha256::digest(token.as_bytes()))
}

fn password_length_is_valid(password: &str) -> bool {
    let length = password.chars().take(MAX_PASSWORD_CHARS + 1).count();
    (MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&length)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salted_passwords_verify_and_reject_wrong_passwords() {
        let first = hash_password("安全密码 example 2026").unwrap();
        let second = hash_password("安全密码 example 2026").unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("$argon2id$"));
        assert!(verify_password("安全密码 example 2026", &first));
        assert!(!verify_password("another valid password", &first));
        assert!(!verify_password("安全密码 example 2026", "invalid hash"));
    }

    #[test]
    fn password_limits_count_characters_and_do_not_trim_passwords() {
        assert!(hash_password("1234567").is_err());
        assert!(hash_password(&"字".repeat(129)).is_err());
        assert!(hash_password(&"字".repeat(8)).is_ok());
        assert!(hash_password(&"a".repeat(128)).is_ok());
        let hash = hash_password(" password ").unwrap();
        assert!(verify_password(" password ", &hash));
        assert!(!verify_password("password", &hash));
    }

    #[test]
    fn session_tokens_are_random_and_only_digests_are_persisted() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert_ne!(hash_token(&first), first);
        assert_ne!(hash_token(&first), hash_token(&second));
        assert_eq!(
            hash_token("hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }
}
