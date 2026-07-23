use crate::stremio_app::custom_api;
use crate::stremio_app::ipc;
use crate::stremio_app::RPCResponse;
use flume::{Receiver, Sender};
use libmpv2::{events::Event, events::EventContext, Format, Mpv, SetData};
use native_windows_gui::{self as nwg, PartialUi};
use std::{
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};
use winapi::shared::windef::HWND;

use crate::stremio_app::stremio_player::{
    CmdVal, InMsg, InMsgArgs, InMsgFn, MpvCmd, PlayerEnded, PlayerEvent, PlayerProprChange,
    PlayerResponse, PropKey, PropVal,
};

/// Last `glsl-shaders` value applied via `mpv-set-prop` (re-applied after each loadfile).
static LAST_GLSL_SHADERS: Mutex<String> = Mutex::new(String::new());

struct ObserveProperty {
    name: String,
    format: Format,
}

#[derive(Default)]
pub struct Player {
    pub channel: ipc::Channel,
}

impl PartialUi for Player {
    fn build_partial<W: Into<nwg::ControlHandle>>(
        // @TODO replace with `&mut self`?
        data: &mut Self,
        parent: Option<W>,
    ) -> Result<(), nwg::NwgError> {
        // @TODO replace all `expect`s with proper error handling?

        let window_handle = parent
            .expect("no parent window")
            .into()
            .hwnd()
            .expect("cannot obtain window handle");

        let (in_msg_sender, in_msg_receiver) = flume::unbounded();
        let (rpc_response_sender, rpc_response_receiver) = flume::unbounded();
        let (observe_property_sender, observe_property_receiver) = flume::unbounded();
        data.channel = ipc::Channel::new(Some((in_msg_sender, rpc_response_receiver)));

        let mpv = create_shareable_mpv(window_handle);

        let _event_thread = create_event_thread(
            Arc::clone(&mpv),
            observe_property_receiver,
            rpc_response_sender,
        );
        let _message_thread = create_message_thread(mpv, observe_property_sender, in_msg_receiver);
        // @TODO implement a mechanism to stop threads on `Player` drop if needed

        Ok(())
    }
}

fn create_shareable_mpv(window_handle: HWND) -> Arc<Mpv> {
    let mpv = Mpv::with_initializer(|initializer| {
        macro_rules! set_property {
            ($name:literal, $value:expr) => {
                initializer
                    .set_property($name, $value)
                    .expect(concat!("failed to set ", $name));
            };
        }
        set_property!("wid", window_handle as i64);
        set_property!("title", "MyStremio");
        set_property!("audio-client-name", "MyStremio");
        set_property!("terminal", "yes");
        // Optional VO hardeners — must NOT use expect(); invalid/unsupported
        // options panic the whole shell before a window appears.
        let _ = initializer.set_property("border", "no");
        let _ = initializer.set_property("force-window", "no");
        let _ = initializer.set_property("background", "#000000");
        #[cfg(debug_assertions)]
        set_property!("msg-level", "all=no,cplayer=debug");
        #[cfg(not(debug_assertions))]
        set_property!("msg-level", "all=no");
        set_property!("quiet", "yes");
        set_property!("hwdec", "auto");
        #[cfg(windows)]
        set_property!("gpu-api", "d3d11");
        set_property!("cache", "yes");
        // Fast first frame: small startup cache (user preload boost applies after playback starts).
        set_property!("cache-secs", "12");
        set_property!("demuxer-readahead-secs", "12");
        set_property!("demuxer-max-bytes", "200MiB");
        set_property!("cache-pause-initial", "no");
        // Stock Stremio quality path (shell-ng PR #73): prefer gpu-next, fall back to gpu.
        set_property!("vo", "gpu-next,gpu,");
        // Soft-fail quality / D3D11 colorspace defaults — unsupported opts must not panic the shell.
        for (name, value) in [
            ("gpu-context", "d3d11"),
            ("d3d11-output-format", "auto"),
            ("d3d11-output-csp", "auto"),
            ("target-colorspace-hint", "auto"),
            ("target-colorspace-hint-mode", "target"),
            ("tone-mapping", "bt.2390"),
            ("dither-depth", "auto"),
            ("deband", "yes"),
            ("scale", "spline36"),
            ("cscale", "spline36"),
        ] {
            if let Err(error) = initializer.set_property(name, value) {
                eprintln!("mpv: cannot set {name}={value}: {error:?}");
            }
        }
        Ok(())
    });
    let mpv = Arc::new(mpv.expect("cannot build MPV"));
    apply_stored_player_volume(&mpv);
    mpv
}

fn cmd_is_loadfile(cmd: &CmdVal) -> bool {
    matches!(
        cmd,
        CmdVal::Single((MpvCmd::Loadfile,))
            | CmdVal::Double(MpvCmd::Loadfile, _)
            | CmdVal::Tripple(MpvCmd::Loadfile, _, _)
            | CmdVal::Quadruple(MpvCmd::Loadfile, _, _, _)
            | CmdVal::Quintuple(MpvCmd::Loadfile, _, _, _, _)
    )
}

fn apply_stored_player_volume(mpv: &Mpv) {
    let stored = custom_api::player_volume();
    if let Some(level) = stored.get("level").and_then(|value| value.as_f64()) {
        let _ = mpv.set_property("volume", level.clamp(0.0, 100.0));
    }
    if let Some(muted) = stored.get("muted").and_then(|value| value.as_bool()) {
        let _ = mpv.set_property("mute", muted);
    }
}

/// Re-apply the last Anime4K / GLSL shader chain after a new file is loaded.
fn apply_stored_glsl_shaders(mpv: &Mpv) {
    let value = match LAST_GLSL_SHADERS.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    if let Err(error) = mpv.set_property("glsl-shaders", value) {
        eprintln!("cannot re-apply glsl-shaders after loadfile: '{error:#}'");
    }
}

/// Remember the last `glsl-shaders` string so loadfile can restore it.
fn remember_glsl_shaders(value: &str) {
    if let Ok(mut guard) = LAST_GLSL_SHADERS.lock() {
        *guard = value.to_string();
    }
}

fn create_event_thread(
    mpv: Arc<Mpv>,
    observe_property_receiver: Receiver<ObserveProperty>,
    rpc_response_sender: Sender<String>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut event_context = EventContext::new(mpv.ctx);
        event_context
            .disable_deprecated_events()
            .expect("failed to disable deprecated MPV events");

        for (name, format) in [
            ("time-pos", Format::Double),
            ("duration", Format::Double),
            ("demuxer-cache-time", Format::Double),
        ] {
            event_context
                .observe_property(name, format, 0)
                .expect("failed to observe default MPV property");
        }

        // -- Event handler loop --

        loop {
            for ObserveProperty { name, format } in observe_property_receiver.drain() {
                event_context
                    .observe_property(&name, format, 0)
                    .expect("failed to observer MPV property");
            }

            // -1.0 means to block and wait for an event.
            let event = match event_context.wait_event(-1.) {
                Some(Ok(event)) => event,
                Some(Err(error)) => {
                    eprintln!("Event errored: {error:?}");
                    continue;
                }
                // dummy event received (may be created on a wake up call or on timeout)
                None => continue,
            };

            // even if you don't do anything with the events, it is still necessary to empty the event loop
            let player_response = match event {
                Event::PropertyChange { name, change, .. } => PlayerResponse(
                    "mpv-prop-change",
                    PlayerEvent::PropChange(PlayerProprChange::from_name_value(
                        name.to_string(),
                        change,
                    )),
                ),
                Event::EndFile(reason) => PlayerResponse(
                    "mpv-event-ended",
                    PlayerEvent::End(PlayerEnded::from_end_reason(reason)),
                ),
                Event::Shutdown => {
                    break;
                }
                _ => continue,
            };

            rpc_response_sender
                .send(RPCResponse::response_message(player_response.to_value()))
                .expect("failed to send RPCResponse");
        }
    })
}

fn create_message_thread(
    mpv: Arc<Mpv>,
    observe_property_sender: Sender<ObserveProperty>,
    in_msg_receiver: Receiver<String>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        // -- Helpers --

        let observe_property = |name: String, format: Format| {
            observe_property_sender
                .send(ObserveProperty { name, format })
                .expect("cannot send ObserveProperty");
            mpv.wake_up();
        };

        let send_command = |cmd: &CmdVal| {
            let is_loadfile = cmd_is_loadfile(cmd);
            if is_loadfile {
                apply_stored_player_volume(&mpv);
            }
            let cmd = cmd.clone();
            let a1;
            let a2;
            let a3;
            let a4;
            let (name, args) = match cmd {
                CmdVal::Quintuple(name, arg1, arg2, arg3, arg4) => {
                    a1 = format!(r#""{arg1}""#);
                    a2 = format!(r#""{arg2}""#);
                    a3 = format!(r#""{arg3}""#);
                    a4 = format!(r#""{arg4}""#);
                    (
                        name,
                        vec![a1.as_ref(), a2.as_ref(), a3.as_ref(), a4.as_ref()],
                    )
                }
                CmdVal::Quadruple(name, arg1, arg2, arg3) => {
                    a1 = format!(r#""{arg1}""#);
                    a2 = format!(r#""{arg2}""#);
                    a3 = format!(r#""{arg3}""#);
                    (name, vec![a1.as_ref(), a2.as_ref(), a3.as_ref()])
                }
                CmdVal::Tripple(name, arg1, arg2) => {
                    a1 = format!(r#""{arg1}""#);
                    a2 = format!(r#""{arg2}""#);
                    (name, vec![a1.as_ref(), a2.as_ref()])
                }
                CmdVal::Double(name, arg1) => {
                    a1 = format!(r#""{arg1}""#);
                    (name, vec![a1.as_ref()])
                }
                CmdVal::Single((name,)) => (name, vec![]),
            };
            if let Err(error) = mpv.command(&name.to_string(), &args) {
                eprintln!("failed to execute MPV command: '{error:#}'")
            }
            if is_loadfile {
                apply_stored_glsl_shaders(&mpv);
            }
        };

        fn set_property(name: impl ToString, value: impl SetData, mpv: &Mpv) {
            if let Err(error) = mpv.set_property(&name.to_string(), value) {
                eprintln!("cannot set MPV property: '{error:#}'")
            }
        }

        // -- InMsg handler loop --

        for msg in in_msg_receiver.iter() {
            let in_msg: InMsg = match serde_json::from_str(&msg) {
                Ok(in_msg) => in_msg,
                Err(error) => {
                    eprintln!("cannot parse InMsg:{:?} {error:#}", &msg);
                    continue;
                }
            };

            match in_msg {
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Bool(prop))) => {
                    observe_property(prop.to_string(), Format::Flag);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Int(prop))) => {
                    observe_property(prop.to_string(), Format::Int64);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Fp(prop))) => {
                    observe_property(prop.to_string(), Format::Double);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Str(prop))) => {
                    observe_property(prop.to_string(), Format::String);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Bool(value))) => {
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Num(value))) => {
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Str(value))) => {
                    let value = if name.to_string() == "vo" {
                        let mut value = value;
                        if !value.is_empty() && !value.ends_with(',') {
                            value.push(',');
                        }
                        value.push_str("gpu-next,");
                        value
                    } else {
                        value
                    };
                    if name.to_string() == "glsl-shaders" {
                        remember_glsl_shaders(&value);
                    }
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvCommand, InMsgArgs::Cmd(cmd)) => {
                    send_command(&cmd);
                }
                msg => {
                    eprintln!("MPV unsupported message: '{msg:?}'");
                }
            }
        }
    })
}

trait MpvExt {
    fn wake_up(&self);
}

impl MpvExt for Mpv {
    // @TODO create a PR to the `libmpv` crate and then remove `libmpv-sys` from Cargo.toml?
    fn wake_up(&self) {
        unsafe { libmpv2_sys::mpv_wakeup(self.ctx.as_ptr()) }
    }
}
