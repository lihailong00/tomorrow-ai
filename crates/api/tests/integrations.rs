use axum::{Router,body::{Body,to_bytes},http::{Request,StatusCode}};
use serde_json::{Value,json};
use tomorrow_api::{app,AppState};
use tomorrow_connectors::domestic::IntegrationState;
use tomorrow_domain::{Repository,ModelProvider,agent::AgentClient};
use tower::ServiceExt;

const SERVICE:&str="integration-test-service-token-at-least-32-characters";
async fn request(router:Router,path:&str,token:&str,service:Option<&str>,body:Value)->(StatusCode,Value){
    let mut request=Request::builder().method("POST").uri(path).header("content-type","application/json").header("authorization",format!("Bearer {token}"));
    if let Some(service)=service{request=request.header("x-agent-service",service);}
    let response=router.oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status=response.status();let body=to_bytes(response.into_body(),1_000_000).await.unwrap();
    (status,serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn phone_imports_reach_only_the_owning_agent_run_and_cancel_stops_reads(){
    let repo=Repository::connect("sqlite::memory:").await.unwrap();
    let a=repo.create_user("phone-import-a@example.test","unused","A","Asia/Shanghai").await.unwrap();
    let b=repo.create_user("phone-import-b@example.test","unused","B","Asia/Shanghai").await.unwrap();
    let session_a=repo.create_session(&a.id).await.unwrap();
    let session_b=repo.create_session(&b.id).await.unwrap();
    let mut state=AppState::new(repo.clone(),ModelProvider::local(),"sqlite::memory:");
    state.integrations=Some(IntegrationState::new(repo.clone()).await.unwrap());
    state.agent=Some(AgentClient::new("http://127.0.0.1:9",SERVICE.into(),"fixture".into()).unwrap());
    let router=app(state);
    let(status,stored)=request(router.clone(),"/v1/integrations/imports",&session_a,None,json!({"source_app":"wechat","title":"项目跟进","text":"只给甲账号的会议资料","external_id":"notification-fixture"})).await;
    assert_eq!(status,StatusCode::OK);assert!(stored["id"].is_string());
    let run_a=repo.begin_agent_run(&a.id,"import-a","fixture",None,None).await.unwrap();
    let run_b=repo.begin_agent_run(&b.id,"import-b","fixture",None,None).await.unwrap();
    let path_a=format!("/internal/agent/runs/{}/tools",run_a.id);
    let path_b=format!("/internal/agent/runs/{}/tools",run_b.id);
    let search=json!({"name":"search_imports","arguments":{"query":"会议"}});
    assert_eq!(request(router.clone(),&path_a,&run_a.token,None,search.clone()).await.0,StatusCode::UNAUTHORIZED);
    assert_eq!(request(router.clone(),&path_a,&session_b,Some(SERVICE),search.clone()).await.0,StatusCode::FORBIDDEN);
    let(status,result)=request(router.clone(),&path_a,&run_a.token,Some(SERVICE),search.clone()).await;
    assert_eq!(status,StatusCode::OK);assert_eq!(result["items"].as_array().unwrap().len(),1);
    let(_,result)=request(router.clone(),&path_b,&run_b.token,Some(SERVICE),search.clone()).await;
    assert_eq!(result["items"],json!([]));
    let(_,result)=request(router.clone(),&path_a,&run_a.token,Some(SERVICE),json!({"name":"read_integration","arguments":{"provider":"wechat","query":{"query":"会议"}}})).await;
    assert_eq!(result["items"].as_array().unwrap().len(),1);
    repo.cancel_agent_run(&a.id,&run_a.id).await.unwrap();
    assert_eq!(request(router,&path_a,&run_a.token,Some(SERVICE),search).await.0,StatusCode::FORBIDDEN);
}
