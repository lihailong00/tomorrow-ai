use super::{AppState, Result};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tomorrow_domain::{
    auth,
    phone::{normalize_phone, validate_code_input, PhoneCodeChallenge, PhonePurpose},
    phone_password, validate_text, AuthSession, DomainError,
};
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
pub struct CodeInput {
    phone: String,
    purpose: PhonePurpose,
}
#[derive(Deserialize, ToSchema)]
pub struct PhoneLoginInput {
    phone: String,
    #[schema(min_length = 8, max_length = 128, write_only = true)]
    password: String,
}
#[derive(Deserialize, ToSchema)]
pub struct PhoneRegisterInput {
    phone: String,
    code: String,
    challenge_id: String,
    #[schema(min_length = 8, max_length = 128, write_only = true)]
    password: String,
    name: Option<String>,
    timezone: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct PhonePasswordResetInput {
    phone: String,
    code: String,
    challenge_id: String,
    #[schema(min_length = 8, max_length = 128, write_only = true)]
    new_password: String,
}

#[derive(Serialize, ToSchema)]
pub struct PhonePasswordResetResult {
    ok: bool,
}

#[utoipa::path(post,path="/v1/auth/phone/code",request_body=CodeInput,responses((status=200,body=PhoneCodeChallenge)))]
pub async fn request_code(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CodeInput>,
) -> Result<Json<PhoneCodeChallenge>> {
    Ok(Json(
        state
            .phone_auth
            .issue_code(&state.repository, &input.phone, input.purpose)
            .await?,
    ))
}

#[utoipa::path(post,path="/v1/auth/phone/register",request_body=PhoneRegisterInput,responses((status=200,body=AuthSession)))]
pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PhoneRegisterInput>,
) -> Result<Json<AuthSession>> {
    state.phone_auth.ensure_available()?;
    validate_code_input(&input.challenge_id, &input.code)?;
    auth::validate_password(&input.password)?;
    let phone = normalize_phone(&input.phone)?;
    let name = input
        .name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("用户{}", &phone[phone.len() - 4..]));
    let name = validate_text(&name, "昵称", 80)?;
    let timezone = input.timezone.unwrap_or_else(|| "Asia/Shanghai".into());
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(DomainError::Validation("无效的 IANA 时区".into()).into());
    }
    Ok(Json(
        state
            .phone_auth
            .register_with_password(
                &state.repository,
                &phone,
                &input.code,
                &input.challenge_id,
                input.password,
                &name,
                &timezone,
            )
            .await?,
    ))
}

#[utoipa::path(post,path="/v1/auth/phone/login",request_body=PhoneLoginInput,responses((status=200,body=AuthSession)))]
pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PhoneLoginInput>,
) -> Result<Json<AuthSession>> {
    Ok(Json(
        phone_password::login(&state.repository, &input.phone, input.password).await?,
    ))
}

#[utoipa::path(post,path="/v1/auth/phone/password/reset",request_body=PhonePasswordResetInput,responses((status=200,body=PhonePasswordResetResult)))]
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PhonePasswordResetInput>,
) -> Result<Json<PhonePasswordResetResult>> {
    state.phone_auth.ensure_available()?;
    validate_code_input(&input.challenge_id, &input.code)?;
    auth::validate_password(&input.new_password)?;
    let phone = normalize_phone(&input.phone)?;
    state
        .phone_auth
        .reset_password(
            &state.repository,
            &phone,
            &input.code,
            &input.challenge_id,
            input.new_password,
        )
        .await?;
    Ok(Json(PhonePasswordResetResult { ok: true }))
}
