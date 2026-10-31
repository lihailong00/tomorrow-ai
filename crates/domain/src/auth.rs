use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::DomainError;

const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;

/// Account identifiers use the same practical mailbox shape accepted by the UI.
/// Preserve plus tags, apostrophes and Unicode names without attempting to
/// implement all of RFC 5322; reject incomplete addresses and header characters.
pub fn normalize_email(input: &str) -> Result<String, DomainError> {
    let value = input.trim().to_lowercase();
    let invalid = || DomainError::Validation("请输入有效的邮箱地址".into());
    let (local, domain) = value.split_once('@').ok_or_else(invalid)?;
    if value.len() > 254
        || input.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
        || local.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || domain.split('.').any(str::is_empty)
    {
        return Err(invalid());
    }
    Ok(value)
}

/// HTTP authentication schemes are case-insensitive; credentials are not.
/// RFC 9110 allows one or more SP characters between the scheme and token.
pub fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, credentials) = header.split_once(' ')?;
    let token = credentials.trim_start_matches(' ');
    if scheme.eq_ignore_ascii_case("Bearer")
        && !token.is_empty()
        && !token.chars().any(|character| character.is_whitespace() || character.is_control())
    {
        Some(token)
    } else {
        None
    }
}

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
    fn emails_reject_incomplete_or_ambiguous_addresses_without_restricting_normal_mailboxes() {
        for input in ["@", "qa@", "@example.test", "qa@@example.test", "qa@example", "qa@.example", "qa@example.", "qa@exam..ple.test", "qa name@example.test", "qa\r\n@example.test", "qa@example.test\n"] {
            assert!(normalize_email(input).is_err(), "accepted {input:?}");
        }
        for (input, expected) in [
            ("  User+tag@Example.TEST  ", "user+tag@example.test"),
            ("o'connor@example.test", "o'connor@example.test"),
            ("用户@例子.测试", "用户@例子.测试"),
        ] {
            assert_eq!(normalize_email(input).unwrap(), expected);
        }
        assert!(normalize_email(&format!("{}@example.test", "a".repeat(242))).is_err());
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_but_token_bytes_and_parts_are_exact() {
        for header in ["Bearer AbC-123", "bearer AbC-123", "bEaReR AbC-123", "BEARER   AbC-123"] {
            assert_eq!(bearer_token(header), Some("AbC-123"));
        }
        for header in ["Bearer", "Bearer ", "Bearer\tAbC-123", "Basic AbC-123", "BearerX AbC-123", " Bearer AbC-123", "Bearer AbC-123 ", "Bearer AbC-123 other", "Bearer AbC\t123", "Bearer AbC\r123"] {
            assert_eq!(bearer_token(header), None, "accepted {header:?}");
        }
    }

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
