//! User-owned MCP accounts. Provider application keys remain in server settings.
pub(crate) mod catalog;
pub(crate) mod memos;
pub(crate) mod notion;
pub(crate) mod transport;
pub(crate) mod yinxiang;
pub(crate) mod fliggy;
pub(crate) mod jianguoyun;
pub(crate) mod ima;
pub(crate) mod weread;
pub(crate) mod qq_music;
pub(super) mod state;

pub use state::{PersonalMcpState, router};

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "independent_tests.rs"]
mod independent_tests;

#[cfg(test)]
#[path = "wallet_extension_independent.rs"]
mod wallet_extension_independent;
