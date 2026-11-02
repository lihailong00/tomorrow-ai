use super::*;
use serde_json::json;

#[test]
fn provider_measurements_keep_cache_inside_input_and_leave_absent_fields_unknown() {
    let usage = measurements(&json!({"usage":{
        "prompt_tokens":120,"completion_tokens":17,
        "prompt_tokens_details":{"cached_tokens":80},"cache_write_tokens":5,
        "seconds":1.25
    }}));
    assert_eq!(usage.input_tokens, Some(120));
    assert_eq!(usage.output_tokens, Some(17));
    assert_eq!(usage.cache_read_tokens, Some(80));
    assert_eq!(usage.cache_write_tokens, Some(5));
    assert_eq!(usage.audio_ms, Some(1250));
    assert_eq!(usage.image_count, None);
    let unknown = measurements(&json!({"choices":[],"elapsed_ms":1234,"audio_bytes":999999}));
    assert_eq!(unknown, UsageMeasurements::default());
    let audio_tokens = measurements(
        &json!({"usage":{"input_tokens":20,"input_tokens_details":{"audio_tokens":19}}}),
    );
    assert_eq!(
        audio_tokens.audio_ms, None,
        "audio tokens are not elapsed audio seconds"
    );
    assert_eq!(
        measurements(&json!({"duration":2.006})).audio_ms,
        Some(2006)
    );
}

#[test]
fn invalid_provider_counts_are_unknown_instead_of_zero_or_truncated() {
    let usage = measurements(&json!({"usage":{
        "prompt_tokens":-1,"completion_tokens":1.5,"cache_read_tokens":9007199254740992u64,
        "seconds":-2
    }}));
    assert_eq!(usage, UsageMeasurements::default());
}

fn pcm_wav(frames: u32) -> Vec<u8> {
    let size = frames * 2;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16000u32.to_le_bytes());
    bytes.extend_from_slice(&32000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.resize(44 + size as usize, 0);
    bytes
}

#[test]
fn wav_duration_uses_validated_sample_frames_and_rejects_unknown_audio() {
    let bytes = pcm_wav(20000);
    assert_eq!(wav_duration_ms(&bytes), Some(1250));
    assert_eq!(wav_duration_ms(b"audio"), None);
    assert_eq!(wav_duration_ms(&bytes[..bytes.len() - 1]), None);
    let mut compressed = bytes.clone();
    compressed[20..22].copy_from_slice(&85u16.to_le_bytes());
    assert_eq!(wav_duration_ms(&compressed), None);
    let mut bad_alignment = bytes.clone();
    bad_alignment[32..34].copy_from_slice(&4u16.to_le_bytes());
    assert_eq!(wav_duration_ms(&bad_alignment), None);
    let mut bad_rate = bytes;
    bad_rate[28..32].copy_from_slice(&1u32.to_le_bytes());
    assert_eq!(wav_duration_ms(&bad_rate), None);
}

#[test]
fn ledger_identity_matches_configured_provider_base_across_media_adapters() {
    for suffix in ["/chat/completions", "/embeddings", "/audio/transcriptions"] {
        assert_eq!(
            deployment(&format!("https://service.example/private/v1{suffix}")),
            "https://service.example/private/v1"
        );
    }
}

#[tokio::test]
async fn dropped_operation_preserves_owner_scoped_unknown_dispatch() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("media-owner@example.test", "hash", "owner", "Asia/Shanghai")
        .await
        .unwrap();
    let other = repo
        .create_user("media-other@example.test", "hash", "other", "Asia/Shanghai")
        .await
        .unwrap();
    let usage = MediaUsage::begin(
        &repo,
        &user.id,
        "https://service.example/private/v1/chat/completions",
        "fixture",
        "vision",
        "gallery",
        None,
        Some(1),
    )
    .await
    .unwrap();
    let id = usage.request_id.clone();
    drop(usage);
    let pool = repo.pool();
    let row: (String, String, String) = sqlx::query_as(
        "SELECT user_id,purpose,outcome_json FROM usage_requests WHERE request_id=$1",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, (user.id.clone(), "gallery".into(), String::new()));
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_requests WHERE user_id=$1")
        .bind(&other.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(foreign, 0);
    pool.close().await;
}
