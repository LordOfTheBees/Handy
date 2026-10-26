//! Refresh Windows App's macOS-to-RDP clipboard bridge before a paste.
//!
//! Windows App can forward a new macOS pasteboard value only after its window
//! loses and regains focus. Keep the focus change limited to that app, and
//! never send a paste keystroke unless its original process is active again.

use std::ffi::{c_char, CStr};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tauri::{AppHandle, Manager};

const WINDOWS_APP_BUNDLE_ID: &str = "com.microsoft.rdc.macos";
const FOCUS_AWAY_DELAY: Duration = Duration::from_millis(150);
const FOCUS_AWAY_TIMEOUT: Duration = Duration::from_millis(600);
const FOCUS_RETURN_TIMEOUT: Duration = Duration::from_millis(1000);
const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;
const NONACTIVATING_PANEL: usize = 1 << 7;

#[derive(Clone, Copy)]
struct FocusPanelState {
    was_visible: bool,
    alpha: f64,
    style_mask: usize,
}

fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|error| format!("Could not schedule RDP focus change: {error}"))?;
    rx.recv()
        .map_err(|_| "RDP focus change was dropped by the main thread".to_string())?
}

/// All Objective-C objects are used on the main thread only. The returned PID
/// is copied out so no autoreleased AppKit object crosses the worker thread.
fn frontmost_application() -> Option<(i32, String)> {
    // SAFETY: These AppKit selectors have their declared signatures in
    // NSWorkspace/NSRunningApplication. Nil Objective-C results are checked
    // before dereferencing, and UTF8String remains valid while its NSString is
    // retained by the current autorelease pool.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let application: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if application.is_null() {
            return None;
        }
        let bundle_id: *mut AnyObject = msg_send![application, bundleIdentifier];
        if bundle_id.is_null() {
            return None;
        }
        let identifier: *const c_char = msg_send![bundle_id, UTF8String];
        if identifier.is_null() {
            return None;
        }
        let pid: i32 = msg_send![application, processIdentifier];
        let bundle_id = CStr::from_ptr(identifier).to_str().ok()?.to_owned();
        Some((pid, bundle_id))
    }
}

fn activate_application(pid: i32) -> Result<(), String> {
    // SAFETY: runningApplicationWithProcessIdentifier: returns an AppKit
    // NSRunningApplication or nil. activateWithOptions: accepts NSUInteger and
    // returns BOOL. The object is used only during this main-thread call.
    unsafe {
        let application: *mut AnyObject = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if application.is_null() {
            return Err("Application exited before focus could be changed".into());
        }
        let activated: bool =
            msg_send![application, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS];
        if !activated {
            return Err("Application rejected the focus change request".into());
        }
    }
    Ok(())
}

/// The recording panel already joins all Spaces and can appear alongside a
/// full-screen app. Make it activating only while refreshing the RDP clipboard.
fn prepare_focus_panel(app: &AppHandle, target_pid: i32) -> Result<FocusPanelState, String> {
    let app_for_panel = app.clone();
    on_main(app, move || {
        if !frontmost_application().is_some_and(|(pid, _)| pid == target_pid) {
            return Err("Focus moved away from Windows App during the RDP paste".into());
        }
        let panel = app_for_panel
            .get_webview_window("recording_overlay")
            .ok_or("Handy recording panel is unavailable for the RDP focus change")?;
        let window = panel.ns_window().map_err(|error| error.to_string())? as *mut AnyObject;
        if window.is_null() {
            return Err("Handy recording panel has no native window".into());
        }
        // SAFETY: Tauri holds the registered NSPanel for the duration of this
        // main-thread callback. The selectors are NSWindow/NSPanel methods.
        let state = unsafe {
            let can_become_key: bool = msg_send![window, canBecomeKeyWindow];
            if !can_become_key {
                return Err("Handy recording panel cannot become the key window".into());
            }
            FocusPanelState {
                was_visible: panel.is_visible().map_err(|error| error.to_string())?,
                alpha: msg_send![window, alphaValue],
                style_mask: msg_send![window, styleMask],
            }
        };
        unsafe {
            if !state.was_visible {
                let _: () = msg_send![window, setAlphaValue: 0.0_f64];
            }
            let _: () = msg_send![window, setStyleMask: state.style_mask & !NONACTIVATING_PANEL];
        }
        let focused = (|| {
            if !state.was_visible {
                panel.show().map_err(|error| error.to_string())?;
            }
            unsafe {
                let _: () =
                    msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
            }
            if let Err(error) = activate_application(std::process::id() as i32) {
                log::debug!("Handy panel focus did not need application activation: {error}");
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = focused {
            if !state.was_visible {
                let _ = panel.hide();
            }
            unsafe {
                let _: () = msg_send![window, setStyleMask: state.style_mask];
                let _: () = msg_send![window, setAlphaValue: state.alpha];
            }
            return Err(error);
        }
        Ok(state)
    })
}

fn restore_focus_panel(app: &AppHandle, state: FocusPanelState) -> Result<(), String> {
    let app_for_panel = app.clone();
    on_main(app, move || {
        let panel = app_for_panel
            .get_webview_window("recording_overlay")
            .ok_or("Handy recording panel disappeared during the RDP focus change")?;
        let window = panel.ns_window().map_err(|error| error.to_string())? as *mut AnyObject;
        if window.is_null() {
            return Err("Handy recording panel has no native window".into());
        }
        if !state.was_visible {
            panel.hide().map_err(|error| error.to_string())?;
        }
        // SAFETY: Tauri still holds this NSPanel, and this is the main thread.
        unsafe {
            let _: () = msg_send![window, setStyleMask: state.style_mask];
            let _: () = msg_send![window, setAlphaValue: state.alpha];
        }
        Ok(())
    })
}

pub(crate) fn is_windows_app_frontmost(app: &AppHandle) -> Result<bool, String> {
    on_main(app, || {
        Ok(
            frontmost_application()
                .is_some_and(|(_, bundle_id)| bundle_id == WINDOWS_APP_BUNDLE_ID),
        )
    })
}

/// Called from the paste worker after publishing the transcript. Returns true
/// only after Windows App has actually regained focus.
pub(crate) fn bounce_if_windows_app(app: &AppHandle) -> Result<bool, String> {
    let target_pid = on_main(app, || {
        let Some((pid, bundle_id)) = frontmost_application() else {
            return Ok(None);
        };
        if bundle_id != WINDOWS_APP_BUNDLE_ID {
            return Ok(None);
        }
        Ok(Some(pid))
    })?;
    let Some(target_pid) = target_pid else {
        return Ok(false);
    };

    let panel_state = prepare_focus_panel(app, target_pid)?;
    thread::sleep(FOCUS_AWAY_DELAY);

    let result = (|| -> Result<bool, String> {
        let deadline = Instant::now() + FOCUS_AWAY_TIMEOUT;
        loop {
            match on_main(app, || Ok(frontmost_application()))? {
                Some((pid, _)) if pid == std::process::id() as i32 => break,
                Some((pid, _)) if pid == target_pid && Instant::now() < deadline => {}
                Some((pid, _)) if pid == target_pid => {
                    return Err(
                        "Handy recording panel did not take focus; paste was cancelled".into(),
                    );
                }
                other => {
                    return Err(format!(
                        "Focus moved to another app during the RDP paste: {:?}",
                        other.map(|(_, bundle_id)| bundle_id)
                    ));
                }
            }
            thread::sleep(Duration::from_millis(50));
        }

        on_main(app, move || activate_application(target_pid))?;
        let deadline = Instant::now() + FOCUS_RETURN_TIMEOUT;
        loop {
            let frontmost = on_main(app, || Ok(frontmost_application()))?;
            if frontmost
                .as_ref()
                .is_some_and(|(pid, _)| *pid == target_pid)
            {
                log::info!("Refreshed Windows App clipboard after panel focus change");
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Windows App did not regain focus (frontmost: {:?}); paste was cancelled",
                    frontmost.as_ref().map(|(_, bundle_id)| bundle_id)
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
    })();

    if let Err(error) = restore_focus_panel(app, panel_state) {
        return Err(format!(
            "Could not restore Handy recording panel after RDP paste: {error}"
        ));
    }
    result
}
