//! User-owned MCP accounts. Provider application keys remain in server settings.
pub(crate) mod catalog;
pub(crate) mod transport;
pub(crate) mod yinxiang;
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
