//! Independent extension boundaries. All credentials are synthetic fixtures.
use super::{state::{McpTransport, PersonalMcpState}, transport::Credentials};
use crate::{crypto::Crypto, personal_wallet::PersonalWalletState};
use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}, response::IntoResponse};
use serde_json::{Value, json};
use std::{collections::HashMap, future::Future, pin::Pin, sync::{Arc, Mutex}};
use tomorrow_domain::Repository;
use tower::ServiceExt;

type BoxResult<'a, T> = Pin<Box<dyn Future<Output=crate::Result<T>> + Send + 'a>>;
#[derive(Default)]
struct Upstream { discovers: Mutex<Vec<(String,String)>>, calls: Mutex<Vec<(String,String,String)>> }
impl McpTransport for Upstream {
    fn discover<'a>(&'a self, provider:&'a str, credentials:&'a Credentials)->BoxResult<'a,Vec<Value>> {
        Box::pin(async move {
            self.discovers.lock().unwrap().push((provider.into(), credentials.token.clone()));
            let tools = match provider { "baidu_netdisk"=>vec!["user_info","file_operation"], "yinxiang"=>vec!["yinxiang_list_notebooks","yinxiang_create_note"], _=>vec!["fixture_unknown"] };
            Ok(tools.into_iter().map(|name|json!({"name":name,"description":"fixture","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}})).collect())
        })
    }
    fn call<'a>(&'a self, provider:&'a str, credentials:&'a Credentials, tool:&'a str, _arguments:Value)->BoxResult<'a,Value> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((provider.into(), credentials.token.clone(),tool.into()));
            Ok(json!({"content":[{"type":"text","text":"fixture success"}],"structuredContent":{"owner":if credentials.token.ends_with("-one"){1}else{2}}}))
        })
    }
}
fn credentials(token:&str, environment:&str)->Credentials { Credentials { token:token.into(), environment:environment.into(), server_url:None } }
fn values(enabled:bool)->HashMap<String,String> { HashMap::from([("CONNECTOR_ENCRYPTION_KEY".into(),"42".repeat(32)),("BAIDU_NETDISK_EXPERIENCE_ENABLED".into(),enabled.to_string())]) }
async fn fixture()->(PersonalMcpState, Repository, String, String, Arc<Upstream>) {
    let repo=Repository::connect("sqlite::memory:").await.unwrap();
    let one=repo.create_user("extension-one@example.test","unused","One","Asia/Shanghai").await.unwrap();
    let two=repo.create_user("extension-two@example.test","unused","Two","Asia/Shanghai").await.unwrap();
    let upstream=Arc::new(Upstream::default());
    let state=PersonalMcpState::with_transport(repo.clone(),Some(Crypto::from_hex(&"42".repeat(32)).unwrap()),upstream.clone()).await.unwrap().reconfigured(&values(false));
    (state,repo,one.id,two.id,upstream)
}

#[tokio::test]
async fn alipay_cannot_be_enabled_via_generic_mcp_or_forged_server_configuration() {
    let (state,repo,one,_,upstream)=fixture().await;
    let mut forged=values(true);
    forged.extend([("ALIPAY_WALLET_ENABLED".into(),"true".into()),("ALIPAY_APP_ID".into(),"merchant-id-is-not-a-personal-identity".into())]);
    let state=state.reconfigured(&forged);
    let wallet=PersonalWalletState::new(repo.clone()).await.unwrap().reconfigured(&forged);
    assert_eq!(wallet.status(&one).await.unwrap()["binding_available"],false);
    assert!(state.connect(&one,"alipay",credentials("personal-wallet-code-never-used","production")).await.is_err());
    assert!(state.tools(&one,"alipay").await.is_err());
    assert!(state.invoke(&one,"alipay","create_payment",json!({"amount":"0.01","confirmed":true})).await.is_err());
    assert!(upstream.discovers.lock().unwrap().is_empty());
    assert!(upstream.calls.lock().unwrap().is_empty());
    let token=repo.create_session(&one).await.unwrap();
    let router=crate::personal_wallet::router(wallet);
    let response=router.oneshot(Request::builder().method("POST").uri("/v1/personal-wallet/alipay/bind")
        .header("authorization",format!("Bearer {token}")).header("content-type","application/json")
        .body(Body::from(r#"{"code":"do-not-store-or-forward","configured":true}"#)).unwrap()).await.unwrap();
    assert_eq!(response.status(),StatusCode::SERVICE_UNAVAILABLE);
    let body=to_bytes(response.into_body(),4096).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("do-not-store-or-forward"));
    let tables:i64=sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'personal_wallet%'").fetch_one(&repo.pool()).await.unwrap();
    assert_eq!(tables,0,"unqualified wallet must not create a token or binding-code store");
}

#[tokio::test]
async fn disabling_baidu_experience_blocks_saved_accounts_and_already_pending_confirmation() {
    let (state,_,one,_,upstream)=fixture().await;
    assert!(state.connect(&one,"baidu_netdisk",credentials("fixture-baidu-one","experience")).await.is_err());
    assert!(upstream.discovers.lock().unwrap().is_empty());
    let enabled=state.reconfigured(&values(true));
    let connection=enabled.connect(&one,"baidu_netdisk",credentials("fixture-baidu-one","experience")).await.unwrap();
    assert_eq!(connection["environment"],"experience");
    assert_eq!(connection["experience_only"],true);
    let pending=enabled.invoke_scoped(&one,"baidu_netdisk","file_operation",json!({"operation":"delete","path":"/fixture-only"}),"baidu-gate:mcp:1").await.unwrap();
    assert_eq!(pending["status"],"confirmation_required");
    assert!(upstream.calls.lock().unwrap().is_empty());
    let disabled=enabled.reconfigured(&values(false));
    for result in [disabled.tools(&one,"baidu_netdisk").await,
        disabled.test(&one,"baidu_netdisk").await,
        disabled.invoke(&one,"baidu_netdisk","user_info",json!({})).await,
        disabled.confirm(&one,pending["action"]["id"].as_str().unwrap()).await] {
        assert_eq!(result.err().unwrap().into_response().status(),StatusCode::SERVICE_UNAVAILABLE);
    }
    let item=disabled.statuses(&one).await.unwrap().into_iter().find(|item|item["id"]=="baidu_netdisk").unwrap();
    assert_eq!(item["status"],"not_configured");
    assert_eq!(upstream.discovers.lock().unwrap().len(),1);
    assert!(upstream.calls.lock().unwrap().is_empty(),"turning the gate off must stop token forwarding even for an existing confirmation");
}

#[tokio::test]
async fn yinxiang_account_tokens_and_write_confirmations_remain_owner_scoped() {
    let (state,_,one,two,upstream)=fixture().await;
    state.connect(&one,"yinxiang",credentials("fixture-member-token-one","production")).await.unwrap();
    state.connect(&two,"yinxiang",credentials("fixture-member-token-two","production")).await.unwrap();
    let a=state.invoke(&one,"yinxiang","yinxiang_list_notebooks",json!({})).await.unwrap();
    let b=state.invoke(&two,"yinxiang","yinxiang_list_notebooks",json!({})).await.unwrap();
    assert_eq!(a["result"]["structuredContent"]["owner"],1);
    assert_eq!(b["result"]["structuredContent"]["owner"],2);
    let pending=state.invoke(&one,"yinxiang","yinxiang_create_note",json!({"title":"fixture","content":"private fixture content"})).await.unwrap();
    assert_eq!(pending["status"],"confirmation_required", "an upstream readOnlyHint cannot turn a create into a read");
    assert_eq!(upstream.calls.lock().unwrap().len(),2);
    let id=pending["action"]["id"].as_str().unwrap();
    assert_eq!(state.confirm(&two,id).await.err().unwrap().into_response().status(),StatusCode::NOT_FOUND);
    assert_eq!(upstream.calls.lock().unwrap().len(),2);
    assert_eq!(state.confirm(&one,id).await.unwrap()["status"],"completed");
    assert_eq!(state.confirm(&one,id).await.unwrap()["status"],"completed");
    let calls=upstream.calls.lock().unwrap();
    assert_eq!(calls.len(),3);
    assert_eq!(calls[2],("yinxiang".into(),"fixture-member-token-one".into(),"yinxiang_create_note".into()));
    let statuses=state.statuses(&two).await.unwrap();
    assert!(!serde_json::to_string(&statuses).unwrap().contains("fixture-member-token"));
}
