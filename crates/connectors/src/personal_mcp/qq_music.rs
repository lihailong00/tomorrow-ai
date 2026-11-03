//! Fixed-origin QQ Music personal gateway, following tencentmusic/qqmusic-skills 0.0.3.
use std::time::Duration;
use axum::http::StatusCode;
use reqwest::{Client, redirect::Policy};
use serde_json::{Value, json};
use super::transport::Credentials;
use crate::{ConnectorError, Result};
const LIMIT: usize = 256 * 1024;
fn error(status: StatusCode, code: &'static str, message: &'static str) -> ConnectorError {
    ConnectorError::new(status, code, message)
}
fn invalid() -> ConnectorError { error(StatusCode::BAD_REQUEST, "invalid_request", "QQ 音乐查询参数无效") }
fn upstream() -> ConnectorError { error(StatusCode::BAD_GATEWAY, "qq_music_upstream", "QQ 音乐请求未成功，请稍后重试") }
fn protocol() -> ConnectorError { error(StatusCode::BAD_GATEWAY, "qq_music_protocol", "QQ 音乐返回内容无法识别") }
pub fn is_read_only(tool: &str) -> bool {
    matches!(tool, "qq_music_search_songs" | "qq_music_daily_mix" | "qq_music_radio" | "qq_music_listening_report")
}
fn tools() -> Vec<Value> {
    vec![
      json!({"name":"qq_music_search_songs","description":"搜索 QQ 音乐歌曲，返回可打开的播放链接。","inputSchema":{"type":"object","properties":{"keyword":{"type":"string","minLength":1,"maxLength":200},"page":{"type":"integer","minimum":0,"maximum":100}},"required":["keyword"],"additionalProperties":false}}),
      json!({"name":"qq_music_daily_mix","description":"读取本人 QQ 音乐每日推荐。","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
      json!({"name":"qq_music_radio","description":"读取本人 QQ 音乐猜你喜欢电台。","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
      json!({"name":"qq_music_listening_report","description":"读取本人的日、周或月听歌报告。","inputSchema":{"type":"object","properties":{"timeKey":{"type":"string","enum":["d","w","m"]},"startTime":{"type":"integer","minimum":0}},"required":["timeKey"],"additionalProperties":false}})
    ]
}
pub fn validate_arguments(tool: &str, args: &Value) -> Result<()> { plan(tool, args).map(|_| ()) }
fn plan(tool: &str, args: &Value) -> Result<(&'static str, Value)> {
    let object=args.as_object().ok_or_else(invalid)?;
    let allowed: &[&str]=match tool {
      "qq_music_search_songs"=> &["keyword","page"],
      "qq_music_daily_mix" | "qq_music_radio"=> &[],
      "qq_music_listening_report"=> &["timeKey","startTime"],
      _=>return Err(invalid())
    };
    if object.keys().any(|k|!allowed.contains(&k.as_str())) { return Err(invalid()); }
    match tool {
      "qq_music_search_songs"=>{
        let keyword=args["keyword"].as_str().filter(|v| !v.trim().is_empty() && v.chars().count()<=200).ok_or_else(invalid)?;
        let page=match object.get("page") { Some(v)=>v.as_u64().filter(|p| (0..=100).contains(p)).ok_or_else(invalid)?,None=>0 };
        Ok(("/discover/search",json!({"keyword":keyword,"type":"0","page":page})))
      },
      "qq_music_daily_mix"=>Ok(("/discover/daily-mix",json!({}))),
      "qq_music_radio"=>Ok(("/discover/radio",json!({}))),
      "qq_music_listening_report"=>{
        let period=args["timeKey"].as_str().filter(|v|matches!(*v,"d"|"w"|"m")).ok_or_else(invalid)?;
        let mut params=json!({"timeKey":period});
        if let Some(v)=object.get("startTime") { params["startTime"]=json!(v.as_u64().filter(|t|*t<=253402300799).ok_or_else(invalid)?); }
        Ok(("/me/report",params))
      },
      _=>Err(invalid())
    }
}
fn validate(value: &Value) -> Result<()> {
    if !value.is_object() || value.get("error").is_some_and(|v|!v.is_null()) { return Err(protocol()); }
    for key in ["ret","sub_ret","code"] {
      if let Some(v)=value.get(key).filter(|v|!v.is_null()) {
        if !(v.as_i64()==Some(0) || v.as_str()==Some("0")) {
          return Err(error(StatusCode::BAD_GATEWAY,"qq_music_rejected","QQ 音乐未接受请求，请检查个人 API Key 或账号权限"));
        }
      }
    }
    if !["songs","songlist","songList","data","report","dayData","weekData","monthData","radio","dailyMix","recommend","list"].iter().any(|k|value.get(*k).is_some()) { return Err(protocol()); }
    Ok(())
}
async fn request(credentials: &Credentials, path: &str, params: Value) -> Result<Value> {
    let client=Client::builder().redirect(Policy::none()).timeout(Duration::from_secs(25)).build().map_err(|_|upstream())?;
    let mut response=client.post(format!("https://a.y.qq.com{path}"))
      .bearer_auth(&credentials.token).json(&json!({"params":params,"comm":{"skill_version":"0.0.3"}}))
      .send().await.map_err(|_|upstream())?;
    if matches!(response.status().as_u16(),401|403) { return Err(error(StatusCode::CONFLICT,"connection_required","QQ 音乐个人 API Key 无效或授权已过期")); }
    if !response.status().is_success() { return Err(upstream()); }
    if response.content_length().is_some_and(|n|n>LIMIT as u64) { return Err(protocol()); }
    let mut body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|upstream())? {
      if body.len()+chunk.len()>LIMIT { return Err(protocol()); } body.extend_from_slice(&chunk);
    }
    let value: Value=serde_json::from_slice(&body).map_err(|_|protocol())?;
    validate(&value)?; Ok(value)
}
pub async fn discover(credentials: &Credentials) -> Result<Vec<Value>> {
    request(credentials,"/discover/search",json!({"keyword":"音乐","type":"0","page":0})).await?;
    Ok(tools())
}
pub async fn call(credentials: &Credentials, tool: &str, args: Value) -> Result<Value> {
    let (path,params)=plan(tool,&args)?;
    let value=request(credentials,path,params).await?;
    Ok(json!({"content":[{"type":"text","text":serde_json::to_string(&value).map_err(|_|protocol())?}]}))
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn rejects_url_overrides_and_invalid_ranges() {
   assert!(plan("qq_music_search_songs",&json!({"keyword":"a","path":"https://evil.test"})).is_err());
   assert!(plan("qq_music_search_songs",&json!({"keyword":"a","page":101})).is_err());
   assert!(plan("qq_music_listening_report",&json!({"timeKey":"year"})).is_err());
   assert!(plan("qq_music_daily_mix",&json!({"token":"other"})).is_err());
 }
 #[test] fn rejects_business_errors_and_empty_success() {
   assert!(validate(&json!({"ret":0,"sub_ret":100,"songs":[]})).is_err());
   assert!(validate(&json!({"ret":0})).is_err());
   assert!(validate(&json!({"ret":0,"sub_ret":"0","songs":[]})).is_ok());
   for k in ["dayData","weekData","monthData"] { assert!(validate(&json!({"ret":0,k:[]})).is_ok()); }
   assert_eq!(plan("qq_music_search_songs", &json!({"keyword":"音乐"})).unwrap().1["page"],0);
 }
}
