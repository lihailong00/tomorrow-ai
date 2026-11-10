//! One-shot device location, requested by the trusted local UI after a user action.
//! No IP lookup, background tracking, logging or storage of coordinates.
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tauri::{State, WebviewWindow};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Requests {
    active: Option<(String, CancellationToken)>,
    cancelled: HashMap<String, Instant>,
}
#[derive(Default)]
pub struct LocationState(Mutex<Requests>);

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
impl LocationState {
    fn begin(&self, id: &str) -> Result<CancellationToken, &'static str> {
        if !valid_id(id) {return Err("invalid_request");}
        let mut state = self.0.lock().map_err(|_| "unavailable")?;
        state.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if state.cancelled.remove(id).is_some() {return Err("cancelled");}
        if state.active.is_some() {return Err("unavailable");}
        let token = CancellationToken::new();
        state.active = Some((id.to_owned(), token.clone())); Ok(token)
    }
    fn cancel(&self, id: &str) -> Result<(), &'static str> {
        if !valid_id(id) {return Err("invalid_request");}
        let mut state = self.0.lock().map_err(|_| "unavailable")?;
        if let Some((active_id, token)) = state.active.as_ref() {
            if active_id == id {token.cancel(); return Ok(());}
        }
        state.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if state.cancelled.len() < 64 {state.cancelled.insert(id.to_owned(), Instant::now());}
        Ok(())
    }
    fn finish(&self, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            if state.active.as_ref().is_some_and(|(active_id, _)| active_id == id) {state.active = None;}
        }
    }
}

#[derive(Serialize)]
pub struct DeviceFix {
    source: &'static str,
    latitude: f64,
    longitude: f64,
    accuracy_m: f64,
    observed_at: String,
    coordinate_system: &'static str,
}

// WebView2 may own keyboard focus while Tao's cached window focus is false.
// Use the actual foreground top-level HWND, not the embedded view's focus flag.
#[cfg(target_os = "windows")]
fn foreground(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};
    let Ok(hwnd) = window.hwnd() else {return false;};
    // SAFETY: HWNDs are only compared; GetAncestor does not dereference app memory.
    unsafe {
        let active = GetForegroundWindow();
        !active.is_null() && GetAncestor(active, GA_ROOT) == hwnd.0
    }
}
#[cfg(not(target_os = "windows"))]
fn foreground(window: &WebviewWindow) -> bool {window.is_focused().unwrap_or(false)}

#[tauri::command]
pub async fn desktop_location_request(window: WebviewWindow, state: State<'_, LocationState>, request_id: String, silent: Option<bool>) -> Result<DeviceFix, String> {
    if window.label() != "main" || !foreground(&window) {return Err("unavailable".into());}
    let token = state.begin(&request_id).map_err(str::to_string)?;
    let result = tokio::select! {
        _ = token.cancelled() => Err("cancelled"),
        result = tokio::time::timeout(Duration::from_secs(55), current(window, token.clone(), silent.unwrap_or(false))) => result.unwrap_or(Err("timeout")),
    };
    token.cancel(); state.finish(&request_id); result.map_err(str::to_string)
}

#[tauri::command]
pub fn desktop_location_ready(window: WebviewWindow) -> bool {
    if window.label() != "main" || !foreground(&window) { return false; }
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Geolocation::{Geolocator, PositionStatus};
        Geolocator::new().and_then(|locator| locator.LocationStatus()).is_ok_and(|status| status == PositionStatus::Ready)
    }
    #[cfg(not(target_os = "windows"))]
    { false }
}

#[tauri::command]
pub fn desktop_location_cancel(window: WebviewWindow, state: State<'_, LocationState>, request_id: String) -> Result<(), String> {
    if window.label() != "main" {return Err("unavailable".into());}
    state.cancel(&request_id).map_err(str::to_string)
}

#[tauri::command]
pub fn desktop_location_settings(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {return Err("unavailable".into());}
    #[cfg(target_os = "windows")]
    {open::that("ms-settings:privacy-location").map_err(|_| "unavailable".to_string())}
    #[cfg(not(target_os = "windows"))]
    {Err("unsupported".into())}
}

#[cfg(not(target_os = "windows"))]
async fn current(_: WebviewWindow, _: CancellationToken, _: bool) -> Result<DeviceFix, &'static str> {Err("unsupported")}

#[cfg(target_os = "windows")]
fn location_error(error: windows::core::Error) -> &'static str {
    match error.code().0 as u32 {
        0x80070005 => "permission_denied", // E_ACCESSDENIED
        0x800705B4 => "timeout",           // ERROR_TIMEOUT
        _ => "unavailable",
    }
}

#[cfg(target_os = "windows")]
async fn current(window: WebviewWindow, token: CancellationToken, silent: bool) -> Result<DeviceFix, &'static str> {
    use chrono::{DateTime, SecondsFormat, Utc};
    use windows::{Devices::Geolocation::{Geolocator, GeolocationAccessStatus, PositionStatus}, Foundation::TimeSpan};
    // RequestAccessAsync must START on the UI thread while the app is in the foreground.
    if !silent {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let permission_token = token.clone();
    window.run_on_main_thread(move || {
        if permission_token.is_cancelled() {let _ = sender.send(Err("cancelled")); return;}
        let result = Geolocator::RequestAccessAsync().map_err(location_error);
        // If the receiver went away before UI dispatch, cancel rather than leave an orphan operation.
        if let Err(Ok(operation)) = sender.send(result) {let _ = operation.Cancel();}
    }).map_err(|_| "unavailable")?;
    let operation = receiver.await.map_err(|_| "unavailable")??;
    let cancel = operation.clone();
    let mut permission_guard = CancelOnDrop(Some(Box::new(move || {let _ = cancel.Cancel();})));
    let access = operation.await.map_err(location_error)?;
    permission_guard.0 = None;
    if token.is_cancelled() {return Err("cancelled");}
    if access != GeolocationAccessStatus::Allowed {return Err("permission_denied");}
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        if token.is_cancelled() {let _ = sender.send(Err("cancelled")); return;}
        let result = (|| {
            let locator = Geolocator::new().map_err(location_error)?;
            if locator.LocationStatus().map_err(location_error)? == PositionStatus::Disabled {return Err("services_disabled");}
            let operation = locator.GetGeopositionAsyncWithAgeAndTimeout(
                TimeSpan {Duration: 60 * 10_000_000}, TimeSpan {Duration: 25 * 10_000_000},
            ).map_err(location_error)?;
            Ok(operation)
        })();
        if let Err(Ok(operation)) = sender.send(result) {let _ = operation.Cancel();}
    }).map_err(|_| "unavailable")?;
    let operation = receiver.await.map_err(|_| "unavailable")??;
    let cancel = operation.clone();
    let mut position_guard = CancelOnDrop(Some(Box::new(move || {let _ = cancel.Cancel();})));
    let position = operation.await.map_err(location_error)?;
    position_guard.0 = None;
    let coordinate = position.Coordinate().map_err(location_error)?;
    let point = coordinate.Point().map_err(location_error)?.Position().map_err(location_error)?;
    let accuracy = coordinate.Accuracy().map_err(location_error)?;
    let ticks = coordinate.Timestamp().map_err(location_error)?.UniversalTime;
    // WinRT DateTime is 100 ns since 1601, not Unix time and not the request time.
    let millis = ticks.checked_div(10_000).and_then(|value| value.checked_sub(11_644_473_600_000)).ok_or("invalid_result")?;
    if !valid_fix(point.Latitude, point.Longitude, accuracy, millis, Utc::now().timestamp_millis()) {return Err("invalid_result");}
    let observed_at = DateTime::from_timestamp_millis(millis).ok_or("invalid_result")?.to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(DeviceFix {source: "device", latitude: point.Latitude, longitude: point.Longitude, accuracy_m: accuracy,
        observed_at, coordinate_system: "wgs84"})
}

#[cfg(target_os = "windows")]
struct CancelOnDrop(Option<Box<dyn FnOnce() + Send>>);
#[cfg(target_os = "windows")]
impl Drop for CancelOnDrop {fn drop(&mut self) {if let Some(cancel) = self.0.take() {cancel();}}}

#[cfg(any(target_os = "windows", test))]
fn valid_fix(lat: f64, lon: f64, accuracy: f64, observed: i64, now: i64) -> bool {
    lat.is_finite() && lon.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) &&
        accuracy.is_finite() && (0.0..=100_000.0).contains(&accuracy) && observed <= now && now.saturating_sub(observed) <= 300_000
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_before_registration_cannot_start_a_location_read() {
        let state = LocationState::default(); state.cancel("one").unwrap();
        assert_eq!(state.begin("one").unwrap_err(), "cancelled");
        let token = state.begin("two").unwrap(); state.cancel("two").unwrap(); assert!(token.is_cancelled()); state.finish("two");
        assert!(state.begin("three").is_ok());
    }
    #[test]
    fn only_one_reader_and_no_arbitrary_cancel_ids() {
        let state = LocationState::default(); state.begin("one").unwrap();
        assert_eq!(state.begin("two").unwrap_err(), "unavailable"); state.finish("two");
        assert_eq!(state.begin("three").unwrap_err(), "unavailable");
        assert_eq!(state.cancel("../one").unwrap_err(), "invalid_request");
        assert_eq!(state.begin("").unwrap_err(), "invalid_request");
    }
    #[test]
    fn invalid_stale_or_future_coordinates_are_not_relabelled_as_current() {
        assert!(valid_fix(31.2, 121.5, 30.0, 1_000_000, 1_001_000));
        assert!(!valid_fix(f64::NAN, 121.5, 30.0, 1_000_000, 1_001_000));
        assert!(!valid_fix(31.2, 181.0, 30.0, 1_000_000, 1_001_000));
        assert!(!valid_fix(31.2, 121.5, 100_001.0, 1_000_000, 1_001_000));
        assert!(!valid_fix(31.2, 121.5, 30.0, 1_000_000, 1_300_001));
        assert!(!valid_fix(31.2, 121.5, 30.0, 1_000_001, 1_000_000));
    }
}
