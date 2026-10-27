#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--probe-sms-transport")
    {
        if arguments.len() != 1 {
            anyhow::bail!("--probe-sms-transport does not accept additional arguments");
        }
        let report = tomorrow_domain::sms::probe_transport().await;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if arguments
        .iter()
        .any(|argument| argument == "--export-openapi")
    {
        println!("{}", tomorrow_api::openapi_document().to_pretty_json()?);
        return Ok(());
    }
    tomorrow_api::serve().await
}
