use super::{
    client_context::{ClientContext, ClientLocation, RuntimeContext, RuntimeLocation},
    AppState, Auth, Result,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
use tomorrow_domain::{new_id, validate_text, DomainError};

const WAIT_SECONDS: u64 = 90;

#[derive(Clone, Default)]
pub(crate) struct Interactions(Arc<Mutex<HashMap<String, Run>>>);

struct Run {
    user: String,
    location_allowed: bool,
    location_requested: bool,
    permission_inspection_allowed: bool,
    permission_inspection_requested: bool,
    system_settings_allowed: bool,
    system_settings_requested: bool,
    delivery_subject: Option<&'static str>,
    delivery_location: Option<RuntimeLocation>,
    delivery_autofill_claimed: bool,
    didi_order_confirmation: bool,
    didi_quote: Option<crate::didi_order::Quote>,
    didi_order_started: bool,
    didi_cancel_required: bool,
    didi_cancel_started: bool,
    didi_cancel_verified: bool,
    action_confirmation: bool,
    opened: u8,
    pending: Option<Pending>,
    answered: Vec<String>,
}

struct Pending {
    card: Card,
    answer: oneshot::Sender<Value>,
}

#[derive(Clone, Serialize)]
pub(crate) struct Card {
    pub id: String,
    pub run_id: String,
    expires_at: i64,
    #[serde(flatten)]
    kind: Kind,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Kind {
    Location,
    AppPermissionInspection { #[serde(flatten)] request: crate::app_permission_intent::InspectionRequest },
    SystemSettings { destination: crate::app_permission_intent::SettingsDestination },
    DidiOrder { #[serde(flatten)] summary: crate::didi_order::Summary },
    ActionConfirmation { #[serde(flatten)] review: crate::chat_confirmation::Review },
    AlipayCheckout { payment_url: String },
    PersonalDetails {
        provider: String,
        tool: String,
        purpose: String,
        subject: String,
        fields: Vec<crate::personal_autofill::Field>,
        arguments: serde_json::Map<String, Value>,
        #[serde(skip)]
        schema: Value,
    },
    Choice {
        question: String,
        options: Vec<String>,
    },
}

pub(crate) struct Registration {
    interactions: Interactions,
    run: String,
}

struct Waiting<'a> {
    interactions: &'a Interactions,
    run: &'a str,
    id: String,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.interactions.clear(self.run, &self.id);
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.interactions
            .0
            .lock()
            .expect("interaction lock")
            .remove(&self.run);
    }
}

impl Interactions {
    pub fn register(&self, run: &str, user: &str, location_allowed: bool, delivery_subject: Option<&'static str>, didi_order_confirmation: bool, location: Option<&RuntimeLocation>, permission_inspection_allowed: bool) -> Registration {
        self.0.lock().expect("interaction lock").insert(
            run.into(),
            Run {
                user: user.into(),
                location_allowed,
                location_requested: false,
                permission_inspection_allowed,
                permission_inspection_requested: false,
                system_settings_allowed: false,
                system_settings_requested: false,
                delivery_subject,
                delivery_location: location.filter(|_| delivery_subject == Some("self")).cloned(),
                delivery_autofill_claimed: false,
                didi_order_confirmation,
                didi_quote: None,
                didi_order_started: false,
                didi_cancel_required: false,
                didi_cancel_started: false,
                didi_cancel_verified: false,
                action_confirmation: false,
                opened: 0,
                pending: None,
                answered: Vec::new(),
            },
        );
        Registration {
            interactions: self.clone(),
            run: run.into(),
        }
    }

    pub fn enable_system_settings(&self, run: &str, user: &str) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run).filter(|run| run.user == user) {
            run.system_settings_allowed = true;
        }
    }

    pub fn delivery_subject(&self, run: &str, user: &str) -> Option<&'static str> {
        let runs = self.0.lock().expect("interaction lock");
        runs.get(run).filter(|run| run.user == user)?.delivery_subject
    }

    pub fn delivery_location(&self, run: &str, user: &str) -> Option<RuntimeLocation> {
        let runs = self.0.lock().expect("interaction lock");
        runs.get(run).filter(|run| run.user == user)?.delivery_location.clone()
    }

    pub fn supports_didi_order(&self, run: &str, user: &str) -> bool {
        self.0.lock().expect("interaction lock").get(run)
            .is_some_and(|run| run.user == user && run.didi_order_confirmation)
    }

    pub fn enable_action_confirmation(&self, run: &str, user: &str) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run).filter(|run| run.user == user) {
            run.action_confirmation = true;
        }
    }

    pub fn supports_action_confirmation(&self, run: &str, user: &str) -> bool {
        self.0.lock().expect("interaction lock").get(run)
            .is_some_and(|run| run.user == user && run.action_confirmation)
    }

    pub fn require_didi_cancellation(&self, run: &str, user: &str) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run).filter(|run| run.user == user) {
            run.didi_cancel_required = true;
        }
    }

    pub fn didi_cancellation_blocks_order(&self, run: &str, user: &str) -> bool {
        self.0.lock().expect("interaction lock").get(run)
            .is_some_and(|run| run.user == user && run.didi_cancellation_blocks_order())
    }

    pub fn claim_didi_cancellation(&self, run: &str, user: &str) -> bool {
        let mut runs = self.0.lock().expect("interaction lock");
        let Some(run) = runs.get_mut(run).filter(|run| run.user == user && !run.didi_order_started) else {
            return false;
        };
        let already_started = std::mem::replace(&mut run.didi_cancel_started, true);
        run.action_confirmation && !already_started
    }

    pub fn record_didi_cancellation(&self, run: &str, user: &str) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run)
            .filter(|run| run.user == user && run.didi_cancel_started) {
            run.didi_cancel_verified = true;
        }
    }

    pub fn remember_didi_quote(&self, run: &str, user: &str, quote: Option<crate::didi_order::Quote>) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run)
            .filter(|run| run.user == user && run.didi_order_confirmation && !run.didi_order_started) {
            run.didi_quote = quote;
        }
    }

    pub fn claim_didi_order(&self, run: &str, user: &str, arguments: &Value) -> Option<(crate::didi_order::Summary, i64, std::time::Instant)> {
        let mut runs = self.0.lock().expect("interaction lock");
        let run = runs.get_mut(run).filter(|run| run.user == user && run.didi_order_confirmation && !run.didi_order_started
            && !run.didi_cancellation_blocks_order())?;
        let quote = run.didi_quote.as_ref()?;
        let summary = quote.summary(arguments)?;
        run.didi_order_started = true;
        Some((summary, quote.generation, quote.expires))
    }

    pub fn claim_delivery_autofill(&self, run: &str, user: &str) -> bool {
        let mut runs = self.0.lock().expect("interaction lock");
        let Some(run) = runs.get_mut(run).filter(|run| run.user == user && run.delivery_subject.is_some()) else {
            return false;
        };
        !std::mem::replace(&mut run.delivery_autofill_claimed, true)
    }

    pub fn pending(&self, user: &str, run_id: &str) -> Option<Card> {
        let runs = self.0.lock().expect("interaction lock");
        let run = runs.get(run_id).filter(|run| run.user == user)?;
        let pending = run.pending.as_ref()?;
        (pending.card.expires_at > chrono::Utc::now().timestamp()).then(|| pending.card.clone())
    }

    fn open(
        &self,
        run_id: &str,
        user: &str,
        kind: Kind,
    ) -> Option<(String, oneshot::Receiver<Value>)> {
        let mut runs = self.0.lock().expect("interaction lock");
        let run = runs.get_mut(run_id).filter(|run| run.user == user)?;
        if run.pending.is_some() || run.opened >= 4 {
            return None;
        }
        if matches!(kind, Kind::ActionConfirmation { .. } | Kind::AlipayCheckout { .. }) && !run.action_confirmation {
            return None;
        }
        if matches!(kind, Kind::Location) {
            if !run.location_allowed || run.location_requested {
                return None;
            }
            run.location_requested = true;
        }
        if let Kind::AppPermissionInspection { request } = &kind {
            let enhanced = request.permission.is_some() || request.scope.is_some() || request.mode.is_some();
            if !run.permission_inspection_allowed || run.permission_inspection_requested || (enhanced && !run.system_settings_allowed) {
                return None;
            }
            run.permission_inspection_requested = true;
        }
        if matches!(kind, Kind::SystemSettings { .. }) {
            if !run.system_settings_allowed || run.system_settings_requested {
                return None;
            }
            run.system_settings_requested = true;
        }
        let id = new_id();
        run.opened += 1;
        let (answer, receiver) = oneshot::channel();
        run.pending = Some(Pending {
            answer,
            card: Card {
                id: id.clone(),
                run_id: run_id.into(),
                kind,
                expires_at: chrono::Utc::now().timestamp() + WAIT_SECONDS as i64,
            },
        });
        Some((id, receiver))
    }

    fn clear(&self, run: &str, id: &str) {
        if let Some(run) = self.0.lock().expect("interaction lock").get_mut(run) {
            if run
                .pending
                .as_ref()
                .is_some_and(|pending| pending.card.id == id)
            {
                run.pending = None;
            }
        }
    }
}

impl Run {
    fn didi_cancellation_blocks_order(&self) -> bool {
        (self.didi_cancel_required || self.didi_cancel_started) && !self.didi_cancel_verified
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Answer {
    Cancel,
    AppPermissionInspection { result: AppPermissionResult },
    SystemSettings { status: SettingsStatus },
    ConfirmDidiOrder,
    ConfirmAction,
    CheckAlipayPayment,
    PersonalDetails { values: std::collections::BTreeMap<String, String> },
    Choice { index: usize },
    Location { location: ClientLocation },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AppPermissionResult {
    Completed { scanned: u32, flagged: u32 },
    Partial { scanned: u32, flagged: u32 },
    Unavailable,
    NeedsSelection,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SettingsStatus { Opened, Fallback, Unavailable, NeedsSelection }

pub(crate) async fn answer(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path((run_id, id)): Path<(String, String)>,
    Json(answer): Json<Answer>,
) -> Result<Json<Value>> {
    let view = state.repository.agent_run(&auth.user_id, &run_id).await?;
    if view.status != "running" {
        return Err(DomainError::Conflict("此次查询已结束".into()).into());
    }
    let mut runs = state.interactions.0.lock().expect("interaction lock");
    let run = runs
        .get_mut(&run_id)
        .filter(|run| run.user == auth.user_id)
        .ok_or(DomainError::NotFound)?;
    if run.answered.contains(&id) {
        return Ok(Json(json!({"accepted":true})));
    }
    let pending = run
        .pending
        .as_ref()
        .filter(|pending| {
            pending.card.id == id
                && pending.card.expires_at > chrono::Utc::now().timestamp()
                && !pending.answer.is_closed()
        })
        .ok_or(DomainError::NotFound)?;
    let mut delivery_location = None;
    let result = match (&pending.card.kind, answer) {
        (_, Answer::Cancel) => json!({"status":"cancelled"}),
        (Kind::AppPermissionInspection { .. }, Answer::AppPermissionInspection { result }) => {
            match &result {
                AppPermissionResult::Completed { scanned, flagged } | AppPermissionResult::Partial { scanned, flagged }
                    if *scanned > 50_000 || flagged > scanned =>
                        return Err(DomainError::Validation("应用权限检查汇总无效".into()).into()),
                _ => {}
            }
            json!(result)
        },
        (Kind::SystemSettings { .. }, Answer::SystemSettings { status }) => json!({"status":status}),
        (Kind::DidiOrder { .. }, Answer::ConfirmDidiOrder) => json!({"status":"confirmed"}),
        (Kind::ActionConfirmation { .. }, Answer::ConfirmAction) => json!({"status":"confirmed"}),
        (Kind::AlipayCheckout { .. }, Answer::CheckAlipayPayment) => json!({"status":"check_payment"}),
        (Kind::PersonalDetails { fields, schema, provider, tool, .. }, Answer::PersonalDetails { values }) => {
            crate::personal_autofill::validate_values(fields, &values, schema, provider, tool)?;
            json!({"status":"answered","values":values})
        }
        (Kind::Choice { options, .. }, Answer::Choice { index }) if index < options.len() => {
            json!({"status":"answered","index":index,"selected":options[index]})
        }
        (Kind::Location, Answer::Location { location }) => {
            let context = ClientContext {
                timezone: "UTC".into(),
                location: Some(location),
            };
            context.validate()?;
            let captured = RuntimeContext::capture(Some(&context), "UTC", chrono::Utc::now());
            if captured.location.is_none() {
                return Err(DomainError::Validation("位置已过期，请重新选择".into()).into());
            }
            if run.delivery_subject == Some("self") {
                delivery_location = captured.location.clone();
            }
            json!({"status":"answered","location":captured.location})
        }
        _ => return Err(DomainError::Validation("答案与当前卡片不匹配".into()).into()),
    };
    let pending = run.pending.take().expect("validated pending interaction");
    pending
        .answer
        .send(result)
        .map_err(|_| DomainError::Conflict("此次提问已结束".into()))?;
    if delivery_location.is_some() {
        run.delivery_location = delivery_location;
    }
    run.answered.push(id);
    Ok(Json(json!({"accepted":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChoiceInput {
    question: String,
    options: Vec<String>,
}

pub(crate) async fn tool(
    state: &AppState,
    run: &str,
    token: &str,
    user: &str,
    name: &str,
    args: Value,
) -> Result<Json<Value>> {
    let kind = if name == "request_location" {
        if !args.as_object().is_some_and(|args| args.is_empty()) {
            return Err(DomainError::Validation("选址工具不接受参数".into()).into());
        }
        Kind::Location
    } else {
        let input: ChoiceInput = serde_json::from_value(args)
            .map_err(|_| DomainError::Validation("单选问题格式无效".into()))?;
        let question = validate_text(&input.question, "问题", 140)?;
        if !(2..=6).contains(&input.options.len()) {
            return Err(DomainError::Validation("请提供 2 至 6 个选项".into()).into());
        }
        let mut options = Vec::new();
        for option in input.options {
            let option = validate_text(&option, "选项", 60)?;
            if options.contains(&option) {
                return Err(DomainError::Validation("选项不能重复".into()).into());
            }
            options.push(option);
        }
        Kind::Choice { question, options }
    };
    Ok(Json(wait_for(state, run, token, user, kind).await?))
}

pub(crate) async fn personal_details(
    state: &AppState, run: &str, token: &str, user: &str,
    provider: &str, tool: &str, purpose: &str, subject: &str,
    fields: Vec<crate::personal_autofill::Field>, arguments: serde_json::Map<String, Value>, schema: Value,
) -> Result<Value> {
    wait_for(state, run, token, user, Kind::PersonalDetails {
        provider: provider.into(), tool: tool.into(), purpose: purpose.into(), subject: subject.into(), fields, arguments, schema,
    }).await
}

pub(super) async fn inspect_app_permissions(
    state: &AppState, run: &str, token: &str, user: &str,
    request: crate::app_permission_intent::InspectionRequest,
) -> Result<Value> {
    wait_for(state, run, token, user, Kind::AppPermissionInspection { request }).await
}

pub(super) async fn open_system_settings(
    state: &AppState, run: &str, token: &str, user: &str,
    destination: crate::app_permission_intent::SettingsDestination,
) -> Result<Value> {
    wait_for(state, run, token, user, Kind::SystemSettings { destination }).await
}

pub(crate) async fn didi_order(state: &AppState, run: &str, token: &str, user: &str, summary: crate::didi_order::Summary) -> Result<Value> {
    wait_for(state, run, token, user, Kind::DidiOrder { summary }).await
}

pub(crate) async fn confirm_action(state: &AppState, run: &str, token: &str, user: &str, review: crate::chat_confirmation::Review) -> Result<Value> {
    wait_for(state, run, token, user, Kind::ActionConfirmation { review }).await
}

pub(crate) async fn alipay_checkout(state: &AppState, run: &str, token: &str, user: &str, payment_url: String) -> Result<Value> {
    wait_for(state, run, token, user, Kind::AlipayCheckout { payment_url }).await
}

async fn wait_for(state: &AppState, run: &str, token: &str, user: &str, kind: Kind) -> Result<Value> {
    let Some((id, mut receiver)) = state.interactions.open(run, user, kind) else {
        return Ok(json!({"status":"unavailable","next":"本次对话无法显示所需卡片。"}));
    };
    let waiting = Waiting {
        interactions: &state.interactions,
        run,
        id,
    };
    let deadline = tokio::time::sleep(Duration::from_secs(WAIT_SECONDS));
    tokio::pin!(deadline);
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut deadline => break Ok(json!({"status":"timed_out"})),
            answer = &mut receiver => break Ok(answer.unwrap_or_else(|_| json!({"status":"cancelled"}))),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if let Err(error) = state.repository.agent_authority(run, token).await { break Err(error); }
            }
        }
    };
    drop(waiting);
    state.repository.agent_authority(run, token).await?;
    Ok(result?)
}

#[cfg(test)]
mod personal_tests {
    use super::*;
    use crate::personal_autofill::{Field, PersonalField};

    #[tokio::test]
    async fn didi_confirmation_is_scoped_to_the_run_owner_and_consumed_once() {
        let repo = tomorrow_domain::Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo.create_user("ride-owner@example.test", "unused", "测试", "Asia/Shanghai").await.unwrap();
        let other = repo.create_user("ride-other@example.test", "unused", "别人", "Asia/Shanghai").await.unwrap();
        let run = repo.begin_agent_run(&user.id, "ride-test", "fixture", None, None).await.unwrap();
        let state = Arc::new(AppState::new(repo, tomorrow_domain::ModelProvider::local(), "sqlite::memory:"));
        let _registration = state.interactions.register(&run.id, &user.id, false, None, true, None, false);
        let quote = crate::didi_order::Quote::read(&json!({"from_name":"A","to_name":"B"}),
            &json!({"status":"completed","result":{"structuredContent":{"traceId":"trace",
                "items":[{"productCategory":"1","productName":"快车","priceText":"30"}]}}}), 1, true);
        state.interactions.remember_didi_quote(&run.id, &user.id, quote);
        let args = json!({"estimate_trace_id":"trace","product_category":"1"});
        assert!(state.interactions.claim_didi_order(&run.id, &other.id, &args).is_none());
        let (summary, _, _) = state.interactions.claim_didi_order(&run.id, &user.id, &args).unwrap();
        assert!(state.interactions.claim_didi_order(&run.id, &user.id, &args).is_none());
        let (id, receiver) = state.interactions.open(&run.id, &user.id, Kind::DidiOrder { summary }).unwrap();
        let wire = serde_json::to_value(state.interactions.pending(&user.id, &run.id).unwrap()).unwrap();
        assert_eq!(wire["kind"], "didi_order");
        assert_eq!(wire["products"][0]["price"], "30");
        let submit = |owner, value| answer(State(state.clone()), Auth { user_id: owner, token: String::new() },
            Path((run.id.clone(), id.clone())), Json(value));
        assert!(submit(other.id, Answer::ConfirmDidiOrder).await.is_err());
        assert!(submit(user.id.clone(), Answer::Choice { index: 0 }).await.is_err());
        assert!(submit(user.id.clone(), Answer::ConfirmDidiOrder).await.is_ok());
        assert_eq!(receiver.await.unwrap()["status"], "confirmed");
        assert!(submit(user.id, Answer::ConfirmDidiOrder).await.is_ok());
    }

    #[test]
    fn delivery_autofill_can_only_be_claimed_once_by_the_run_owner() {
        let interactions = Interactions::default();
        let _supported = interactions.register("run", "owner", false, Some("home"), false, None, false);
        let _legacy = interactions.register("legacy", "owner", false, None, false, None, false);
        assert_eq!(interactions.delivery_subject("run", "owner"), Some("home"));
        assert!(!interactions.claim_delivery_autofill("run", "other"));
        assert!(!interactions.claim_delivery_autofill("legacy", "owner"));
        assert!(interactions.claim_delivery_autofill("run", "owner"));
        assert!(!interactions.claim_delivery_autofill("run", "owner"));
    }

    #[test]
    fn rebooking_requires_the_current_runs_verified_cancellation() {
        let interactions = Interactions::default();
        let _run = interactions.register("run", "owner", false, None, true, None, false);
        interactions.enable_action_confirmation("run", "owner");
        let quote = crate::didi_order::Quote::read(&json!({"from_name":"A","to_name":"B"}),
            &json!({"status":"completed","result":{"structuredContent":{"traceId":"trace",
                "items":[{"productCategory":"1","productName":"快车","priceText":"30"}]}}}), 1, true);
        interactions.remember_didi_quote("run", "owner", quote);
        let args = json!({"estimate_trace_id":"trace","product_category":"1"});
        interactions.require_didi_cancellation("run", "owner");
        assert!(interactions.claim_didi_order("run", "owner", &args).is_none());
        assert!(!interactions.claim_didi_cancellation("run", "other"));
        assert!(interactions.claim_didi_cancellation("run", "owner"));
        assert!(!interactions.claim_didi_cancellation("run", "owner"));
        interactions.record_didi_cancellation("run", "other");
        assert!(interactions.claim_didi_order("run", "owner", &args).is_none());
        interactions.record_didi_cancellation("run", "owner");
        assert!(interactions.claim_didi_order("run", "owner", &args).is_some());
        assert!(interactions.claim_didi_order("run", "owner", &args).is_none());
    }

    #[tokio::test]
    async fn checkout_link_is_scoped_to_the_owner_and_does_not_accept_a_write_confirmation() {
        let repo = tomorrow_domain::Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo.create_user("checkout-owner@example.test", "unused", "测试", "Asia/Shanghai").await.unwrap();
        let other = repo.create_user("checkout-other@example.test", "unused", "别人", "Asia/Shanghai").await.unwrap();
        let run = repo.begin_agent_run(&user.id, "checkout-test", "fixture", None, None).await.unwrap();
        let state = Arc::new(AppState::new(repo, tomorrow_domain::ModelProvider::local(), "sqlite::memory:"));
        let _registration = state.interactions.register(&run.id, &user.id, false, None, false, None, false);
        let checkout = || Kind::AlipayCheckout { payment_url: "https://render.alipay.com/fixture".into() };
        assert!(state.interactions.open(&run.id, &user.id, checkout()).is_none());
        state.interactions.enable_action_confirmation(&run.id, &user.id);
        let (id, receiver) = state.interactions.open(&run.id, &user.id, checkout()).unwrap();
        assert!(state.interactions.pending(&other.id, &run.id).is_none());
        let submit = |owner, value| answer(State(state.clone()), Auth { user_id: owner, token: String::new() },
            Path((run.id.clone(), id.clone())), Json(value));
        assert!(submit(other.id, Answer::CheckAlipayPayment).await.is_err());
        assert!(submit(user.id.clone(), Answer::ConfirmAction).await.is_err());
        assert!(submit(user.id, Answer::CheckAlipayPayment).await.is_ok());
        assert_eq!(receiver.await.unwrap()["status"], "check_payment");
    }

    #[tokio::test]
    async fn personal_card_only_accepts_owner_and_exact_fields_once() {
        let repo = tomorrow_domain::Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo.create_user("form-owner@example.test","unused","测试","Asia/Shanghai").await.unwrap();
        let other = repo.create_user("form-other@example.test","unused","别人","Asia/Shanghai").await.unwrap();
        let run = repo.begin_agent_run(&user.id,"form-test","fixture",None,None).await.unwrap();
        let state = Arc::new(AppState::new(repo, tomorrow_domain::ModelProvider::local(), "sqlite::memory:"));
        let _registration = state.interactions.register(&run.id,&user.id,false,None,false,None,false);
        let kind = Kind::PersonalDetails { provider:"mcdonalds".into(), tool:"delivery-create-address".into(),purpose:"配送到家".into(),subject:"home".into(),arguments:serde_json::Map::new(),schema:json!({}),fields:vec![Field {
            key:"phone".into(),label:"联系电话".into(),semantic:PersonalField::Phone,value:"13800000000".into(),source:"已保存资料".into(),required:true,
        }] };
        let (id, receiver) = state.interactions.open(&run.id,&user.id,kind).unwrap();
        assert!(state.interactions.pending(&other.id,&run.id).is_none());
        let values = std::collections::BTreeMap::from([("phone".into(),"13800000000".into())]);
        assert!(answer(State(state.clone()),Auth{user_id:other.id,token:String::new()},Path((run.id.clone(),id.clone())),Json(Answer::PersonalDetails{values:values.clone()})).await.is_err());
        let invalid = std::collections::BTreeMap::from([("phone".into(),String::new())]);
        assert!(answer(State(state.clone()),Auth{user_id:user.id.clone(),token:String::new()},Path((run.id.clone(),id.clone())),Json(Answer::PersonalDetails{values:invalid})).await.is_err());
        assert!(state.interactions.pending(&user.id,&run.id).is_some());
        let _ = answer(State(state.clone()),Auth{user_id:user.id.clone(),token:String::new()},Path((run.id.clone(),id.clone())),Json(Answer::PersonalDetails{values:values.clone()})).await.unwrap_or_else(|_| panic!("owner submission"));
        let received = receiver.await.unwrap();
        assert_eq!(received["values"]["phone"],"13800000000");
        assert!(state.interactions.pending(&user.id,&run.id).is_none());
        let _ = answer(State(state),Auth{user_id:user.id,token:String::new()},Path((run.id.clone(),id)),Json(Answer::PersonalDetails{values})).await.unwrap_or_else(|_| panic!("idempotent acknowledgement"));
    }
}
