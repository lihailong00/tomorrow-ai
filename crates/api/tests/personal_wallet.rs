use axum::{Router,body::{Body,to_bytes},http::{Request,StatusCode}};
use serde_json::{Value,json};
use tomorrow_api::{AppState,app};
use tomorrow_connectors::{personal_mcp::PersonalMcpState,personal_wallet::PersonalWalletState};
use tomorrow_domain::{ModelProvider,Repository};
use tower::ServiceExt;

async fn request(router:Router,method:&str,path:&str,token:&str,body:Value)->(StatusCode,Value){
    let mut request=Request::builder().method(method).uri(path).header("content-type","application/json");
    if !token.is_empty(){request=request.header("authorization",format!("Bearer {token}"));}
    let response=router.oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status=response.status();
    let bytes=to_bytes(response.into_body(),1_000_000).await.unwrap();
    (status,serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn mounted_wallet_is_a_session_protected_unconfigured_entry_without_binding_or_payment(){
    let repo=Repository::connect("sqlite::memory:").await.unwrap();
    let user=repo.create_user("wallet-mount@example.test","unused","QA","Asia/Shanghai").await.unwrap();
    let session=repo.create_session(&user.id).await.unwrap();
    let mut state=AppState::new(repo.clone(),ModelProvider::local(),"sqlite::memory:");
    state.personal_wallet=Some(PersonalWalletState::new(repo.clone()).await.unwrap());
    state.personal_mcp=Some(PersonalMcpState::new(repo).await.unwrap().reconfigured(&std::collections::HashMap::from([
        ("CONNECTOR_ENCRYPTION_KEY".into(),"42".repeat(32)),
        ("BAIDU_NETDISK_EXPERIENCE_ENABLED".into(),"false".into()),
    ])));
    let router=app(state);
    assert_eq!(request(router.clone(),"GET","/v1/personal-wallet/alipay","",json!({})).await.0,StatusCode::UNAUTHORIZED);
    let(status,wallet)=request(router.clone(),"GET","/v1/personal-wallet/alipay",&session,json!({})).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(wallet["status"],"not_configured");
    assert_eq!(wallet["binding_available"],false);
    assert_eq!(wallet["payment_available"],false);
    for operation in ["authorize","bind","test"]{
        let(status,body)=request(router.clone(),"POST",&format!("/v1/personal-wallet/alipay/{operation}"),&session,json!({"code":"not-a-real-code"})).await;
        assert_eq!(status,StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"],"wallet_not_configured");
        assert!(!body.to_string().contains("not-a-real-code"));
    }
    let(status,connections)=request(router,"GET","/v1/personal-mcp",&session,json!({})).await;
    assert_eq!(status,StatusCode::OK);
    let baidu=connections["items"].as_array().unwrap().iter().find(|item|item["id"]=="baidu_netdisk").unwrap();
    assert_eq!(baidu["environment"],"experience");
    assert_eq!(baidu["status"],"not_configured");
    let yinxiang=connections["items"].as_array().unwrap().iter().find(|item|item["id"]=="yinxiang").unwrap();
    assert_eq!(yinxiang["transport"],"official_skill");
    assert_eq!(yinxiang["status"],"not_connected");
}
