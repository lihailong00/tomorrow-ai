//! Keep the native frame consistent with the app's light palette.
//! Native decorations retain Windows dragging, snapping, resize and caption buttons.

#[cfg(target_os = "windows")]
pub fn apply(window: &tauri::Window) {
    use std::{mem::size_of, ptr};
    use windows_sys::Win32::{
        Graphics::Dwm::{
            DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
            DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute,
        },
        UI::{
            Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
            WindowsAndMessaging::{SPI_GETHIGHCONTRAST, SystemParametersInfoW},
        },
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let mut contrast = HIGHCONTRASTW {
        cbSize: size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    // SAFETY: Windows fills this initialized structure synchronously; its size matches cbSize.
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            contrast.cbSize,
            ptr::from_mut(&mut contrast).cast(),
            0,
        )
    };
    if read == 0 {
        return;
    }
    let high_contrast = contrast.dwFlags & HCF_HIGHCONTRASTON != 0;
    let rgb = |r: u32, g: u32, b: u32| r | (g << 8) | (b << 16);
    let default_color = 0xffff_ffff;
    let attributes = [
        (
            DWMWA_CAPTION_COLOR,
            if high_contrast {
                default_color
            } else {
                rgb(244, 246, 251)
            },
        ),
        (
            DWMWA_TEXT_COLOR,
            if high_contrast {
                default_color
            } else {
                rgb(48, 57, 76)
            },
        ),
        (
            DWMWA_BORDER_COLOR,
            if high_contrast {
                default_color
            } else {
                rgb(227, 232, 242)
            },
        ),
    ];
    // SAFETY: this live HWND is owned by Tauri. Each value is a COLORREF (u32),
    // borrowed only for the synchronous call. Older Windows may reject color
    // attributes; the configured native light theme remains the fallback.
    unsafe {
        if !high_contrast {
            let dark: u32 = 0;
            let _ = DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                ptr::from_ref(&dark).cast(),
                size_of::<u32>() as u32,
            );
        }
        for (attribute, color) in attributes {
            let _ = DwmSetWindowAttribute(
                hwnd.0,
                attribute as u32,
                ptr::from_ref(&color).cast(),
                size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn apply(_window: &tauri::Window) {}
