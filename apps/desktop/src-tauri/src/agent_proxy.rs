//! The agent runtime, for the Projects page (contract 7).
//!
//! The Projects page needs the model catalog and the global agent defaults
//! before any project — and so any Studio sidecar with its own agent gateway —
//! exists. The home server therefore owns a second, project-less instance of
//! the same runtime process (`packages/agent-runtime`), started lazily on the
//! first request and reused for the app's lifetime:
//!
//! - launched as `bun <entry>` with `OPENVIDS_AGENT_TOKEN` (fresh per launch,
//!   never sent to the webview), `OPENVIDS_AGENT_PORT=0` and
//!   `OPENVIDS_AGENT_PARENT_PID` (the runtime exits when this process dies);
//! - ready once it printed its `{"openvids-agent":"listening","port":N}` line
//!   and `GET /v1/health` answers;
//! - placed in its own supervision scope (`crate::proc`: process group on
//!   unix, Job Object on Windows) and killed with it on shutdown.
//!
//! Only the global routes are proxied (`/v1/models`, `/v1/settings`); they
//! need the bearer token and no project scope. Settings live in
//! `~/.openvids/agent/`, so both runtime instances read and write the same file.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use super::coded_error::CodedError;
use super::logfile;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);

struct Running {
    child: Child,
    port: u16,
    token: String,
}

static RUNTIME: Mutex<Option<Running>> = Mutex::new(None);
static PROD_ENTRY: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

/// Production: the staged runtime (`Resources/agent-runtime/main.ts`) and bun.
pub fn set_production_launch(bun: PathBuf, entry: PathBuf) {
    if let Ok(mut slot) = PROD_ENTRY.lock() {
        *slot = Some((bun, entry));
    }
}

/// `(bun, entry)`: env overrides, else the staged production runtime, else
/// the workspace source (dev).
fn launch() -> Option<(PathBuf, PathBuf)> {
    let bun_override = std::env::var_os("OPENVIDS_AGENT_BUN").map(PathBuf::from);
    if let Some(entry) = std::env::var_os("OPENVIDS_AGENT_RUNTIME_ENTRY").map(PathBuf::from) {
        if entry.is_absolute() && entry.is_file() {
            return Some((bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)), entry));
        }
    }
    if let Some((bun, entry)) = PROD_ENTRY.lock().ok().and_then(|s| s.clone()) {
        if entry.is_file() {
            return Some((bun_override.unwrap_or(bun), entry));
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("agent-runtime")
        .join("src")
        .join("main.ts");
    if dev.is_file() {
        return Some((bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)), dev));
    }
    None
}

fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("os randomness for the agent token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn spawn() -> Result<Running, CodedError> {
    let (bun, entry) = launch()
        .ok_or_else(|| CodedError::plain("agent_not_installed", "the agent runtime is not installed"))?;
    let token = token();
    let mut command = Command::new(&bun);
    command
        .arg(&entry)
        .current_dir(entry.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .env("OPENVIDS_AGENT_TOKEN", &token)
        .env("OPENVIDS_AGENT_PORT", "0")
        .env("OPENVIDS_AGENT_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in super::ffmpeg_install::managed_env() {
        command.env(key, value);
    }
    crate::proc::configure(&mut command);
    let mut child = command.spawn().map_err(|e| {
        CodedError::new(
            "agent_start_failed",
            format!("could not start the agent runtime ({}): {e}", bun.display()),
            json!({ "path": bun.display().to_string(), "detail": e.to_string() }),
        )
    })?;
    crate::proc::track(&child);
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[home-agent] {line}");
                logfile::agent(&line);
            }
        });
    }
    let (tx, rx) = mpsc::channel::<u16>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !reported {
                    if let Some(port) = lifecycle_port(&line) {
                        reported = true;
                        let _ = tx.send(port);
                        continue;
                    }
                }
                eprintln!("[home-agent] {line}");
                logfile::agent(&line);
            }
        });
    }
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let port = loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(CodedError::new(
                "agent_exited",
                format!("the agent runtime exited during startup ({status})"),
                json!({ "status": status.to_string() }),
            ));
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(port) => break port,
            Err(_) if Instant::now() < deadline => continue,
            Err(_) => {
                kill(&mut child);
                return Err(CodedError::plain("agent_start_timeout", "the agent runtime did not start in time"));
            }
        }
    };
    let running = Running { child, port, token };
    while Instant::now() < deadline {
        if matches!(request(&running, "GET", "/v1/health", None), Ok((200, _))) {
            return Ok(running);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let mut running = running;
    kill(&mut running.child);
    Err(CodedError::plain("agent_unhealthy", "the agent runtime never became healthy"))
}

fn lifecycle_port(line: &str) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("openvids-agent")?.as_str()? != "listening" {
        return None;
    }
    u16::try_from(value.get("port")?.as_u64()?).ok().filter(|p| *p > 0)
}

/// The runtime gets 2 s to shut down cleanly before the fatal stop.
const KILL_GRACE: Duration = Duration::from_secs(2);

fn kill(child: &mut Child) {
    crate::proc::terminate(child, KILL_GRACE);
}

/// Stop the runtime (app exit). The runtime's parent-pid watch is the
/// backstop on unix when this never runs (SIGKILL, crash); on Windows the
/// kill-on-close Job Object is the backstop.
pub fn shutdown() {
    if let Ok(mut slot) = RUNTIME.lock() {
        if let Some(mut running) = slot.take() {
            kill(&mut running.child);
        }
    }
}

/// One blocking HTTP/1.1 request to the runtime. Returns (status, body).
fn request(
    running: &Running,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> std::io::Result<(u16, Vec<u8>)> {
    request_with_timeout(running, method, path, body, Duration::from_secs(30))
}

/// `GET /v1/settings` when the runtime is already up, `None` when it is not.
/// The bug reporter (`report.rs`) uses this to describe the user's providers
/// and models; it must never start the runtime just to do so, and must never
/// wait long.
pub fn settings_if_running(timeout: Duration) -> Option<Vec<u8>> {
    let mut slot = RUNTIME.lock().ok()?;
    let running = slot.as_mut()?;
    if !matches!(running.child.try_wait(), Ok(None)) {
        return None;
    }
    request_with_timeout(running, "GET", "/v1/settings", None, timeout)
        .ok()
        .filter(|(status, _)| *status == 200)
        .map(|(_, body)| body)
}

fn request_with_timeout(
    running: &Running,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    read_timeout: Duration,
) -> std::io::Result<(u16, Vec<u8>)> {
    let mut stream = TcpStream::connect(("127.0.0.1", running.port))?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(10).min(read_timeout)))?;
    let body = body.unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        running.port,
        running.token,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| std::io::Error::other("malformed runtime response"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);
    let payload = if head.contains("transfer-encoding: chunked") {
        crate::thumbnails::decode_chunked(&raw[split..])
            .ok_or_else(|| std::io::Error::other("malformed chunked body"))?
    } else {
        raw[split..].to_vec()
    };
    Ok((status, payload))
}

/// Forward one request to the runtime, starting it first if needed. A dead
/// runtime is replaced once. Errors are user-facing strings.
pub fn forward(method: &str, path: &str, body: Option<&[u8]>) -> Result<(u16, Vec<u8>), CodedError> {
    let mut slot = RUNTIME
        .lock()
        .map_err(|_| CodedError::plain("agent_state_poisoned", "agent runtime state poisoned"))?;
    for attempt in 0..2 {
        let alive = slot
            .as_mut()
            .map(|r| matches!(r.child.try_wait(), Ok(None)))
            .unwrap_or(false);
        if !alive {
            if let Some(mut dead) = slot.take() {
                kill(&mut dead.child);
            }
            *slot = Some(spawn()?);
        }
        let running = slot
            .as_ref()
            .ok_or_else(|| CodedError::plain("agent_missing", "agent runtime missing"))?;
        match request(running, method, path, body) {
            Ok(result) => return Ok(result),
            Err(error) if attempt == 0 => {
                eprintln!("[home-agent] request failed, restarting: {error}");
                logfile::agent(&format!("request failed, restarting: {error}"));
                if let Some(mut dead) = slot.take() {
                    kill(&mut dead.child);
                }
            }
            Err(error) => {
                return Err(CodedError::new(
                    "agent_no_answer",
                    format!("the agent runtime did not answer: {error}"),
                    json!({ "detail": error.to_string() }),
                ))
            }
        }
    }
    Err(CodedError::plain("agent_unavailable", "the agent runtime is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_line_parsing() {
        assert_eq!(
            lifecycle_port(r#"{"openvids-agent":"listening","port":5123,"protocolVersion":2}"#),
            Some(5123)
        );
        assert_eq!(lifecycle_port(r#"{"openvids-agent":"starting","port":5123}"#), None);
        assert_eq!(lifecycle_port("plain log line"), None);
        assert_eq!(lifecycle_port(r#"{"openvids-agent":"listening","port":0}"#), None);
    }
}
