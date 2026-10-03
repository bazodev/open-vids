//! The Projects home screen: a loopback server for the whole app lifetime.
//!
//! The webview has no Tauri IPC (no `withGlobalTauri`, empty capabilities,
//! no dialog/fs plugins — that stays), so the home page is a document served
//! by this listener with a small JSON API behind it (see `home_routes` for
//! the endpoint list).
//!
//! Protection: a per-launch token (`home_auth::HomeToken`) is injected into
//! the page and required on every `/api` request (see `home_auth`); Host and
//! Origin are scoped to this server. See "Security" in the README.
//!
//! Lifetime: the server lives in `AppState` for the whole process and is
//! never dropped on project open — "Show All Projects" navigates back to it
//! without restarting anything. Opening a project only swaps what the
//! window shows (dev) or restarts the Studio sidecar (prod).

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use super::home_auth::HomeToken;
use super::home_routes::{serve_one, thumb_name_for, HomeInner, OpenPhase, Opener, PrefsListener};

/// A loopback listener that serves the home page for the app's lifetime.
pub struct HomeServer {
    port: u16,
    #[allow(dead_code)]
    token: HomeToken,
    inner: Arc<Mutex<HomeInner>>,
    stop: Arc<AtomicBool>,
    accept: TcpListener,
}

impl HomeServer {
    pub fn bind(recents_path: PathBuf, thumbs_dir: PathBuf) -> std::io::Result<Self> {
        let inner = HomeInner::load(recents_path, thumbs_dir)?;
        let accept = TcpListener::bind(("127.0.0.1", 0))?;
        let port = accept.local_addr()?.port();
        let token = HomeToken::generate();
        let inner = Arc::new(Mutex::new(inner));
        let stop = Arc::new(AtomicBool::new(false));

        let shared = accept.try_clone()?;
        let state = Arc::clone(&inner);
        let flag = Arc::clone(&stop);
        let token_value = token.value().to_string();
        thread::spawn(move || {
            let _ = shared.set_nonblocking(false);
            for stream in shared.incoming() {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                match stream {
                    Ok(stream) => {
                        let state = Arc::clone(&state);
                        let token_value = token_value.clone();
                        thread::spawn(move || {
                            serve_one(stream, &state, &token_value, port);
                        });
                    }
                    Err(_) => continue,
                }
            }
        });

        Ok(Self {
            port,
            token,
            inner,
            stop,
            accept,
        })
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The opener runs the real project open (dev navigate / prod sidecar).
    pub fn set_opener(&self, opener: Opener) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.opener = Some(opener);
        }
    }
    /// Record a successful open in recents (also used at launch for
    /// `OPENVIDS_PROJECT` so it appears on the home screen).
    /// A recorded open is complete, so the loading phase clears too.
    pub fn record_open(&self, id: &str, dir: &Path) {
        let dims = std::fs::read_to_string(dir.join("index.html"))
            .ok()
            .filter(|html| super::structure::is_composition_source(html))
            .map(|html| super::structure::composition_dimensions(&html));
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .recents
                .record(id, dir, dims.map(|(w, _)| w), dims.map(|(_, h)| h));
            inner.current_id = Some(id.to_string());
            inner.open_phase = super::home_routes::OpenPhase::Idle;
        }
    }

    pub fn set_open_phase(&self, phase: OpenPhase) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.open_phase = phase;
        }
    }

    /// Publish (or clear) the Studio origin Studio's token-less menu posts
    /// are checked against. Set when lib.rs navigates to a project, cleared
    /// by the shared home-navigation cleanup.
    pub fn set_studio_origin(&self, origin: Option<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.studio_origin = origin;
        }
    }

    /// Forget the currently open project (the window navigated home). Only a
    /// real return from a project skips the launch intro on the next page
    /// load; the navigation hook also fires for the window's first load and
    /// for reloads of the Projects page, which keep the intro.
    pub fn clear_current(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.current_id.take().is_some() {
                inner.skip_intro = true;
            }
            inner.open_phase = OpenPhase::Idle;
        }
    }

    /// Help › Welcome to OpenVids… while a project shows: the Projects page
    /// the window is about to navigate to opens the onboarding on load.
    pub fn request_onboarding(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending_onboarding = true;
        }
    }

    /// Told about preference changes saved through the page (window theme).
    pub fn set_prefs_listener(&self, listener: PrefsListener) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.prefs_listener = Some(listener);
        }
    }

    /// The most recently opened project that still exists, for
    /// "On launch: Reopen last project".
    pub fn last_project(&self) -> Option<PathBuf> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .recents
                .entries()
                .iter()
                .find(|e| e.dir.is_dir())
                .map(|e| e.dir.clone())
        })
    }

    /// Cache fetched thumbnail bytes for `dir` under a stable name and point
    /// the recent at it. Best-effort: failures only mean a placeholder card.
    pub fn cache_thumbnail(&self, dir: &Path, bytes: &[u8], ext: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            let name = thumb_name_for(dir, ext);
            if std::fs::write(inner.thumbs_dir.join(&name), bytes).is_ok() {
                inner.recents.update_meta(dir, Some(name), None, None);
            }
        }
    }

    #[cfg(test)]
    pub fn token_for_test(&self) -> String {
        self.token.value().to_string()
    }
}

impl Drop for HomeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        let _ = self.accept.set_nonblocking(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    const TOKEN_HEADER: &str = "x-openvids-token";

    fn base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn repo_templates() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("cli")
            .join("src")
            .join("templates")
    }

    fn spawn(name: &str) -> (HomeServer, String) {
        // Same value in every test, so parallel `set_var` is benign.
        std::env::set_var("OPENVids_TEST_TEMPLATES", repo_templates());
        let dir = base(name);
        let server = HomeServer::bind(dir.join("recents.json"), dir.join("thumbs")).unwrap();
        let origin = server.origin();
        (server, origin)
    }

    fn intro_flag(origin: &str) -> bool {
        let (code, body) = get(origin, "/", None);
        assert_eq!(code, 200);
        String::from_utf8_lossy(&body).contains("\"intro\":true")
    }

    #[test]
    fn intro_plays_on_launch_and_reload_but_not_after_a_project() {
        let (server, origin) = spawn("intro");
        // The navigation hook runs for the first load and every reload too.
        server.clear_current();
        assert!(intro_flag(&origin), "cold load plays the intro");
        server.clear_current();
        assert!(intro_flag(&origin), "reloading Projects plays it again");

        let project = base("intro-project");
        server.record_open("intro-project", &project);
        server.clear_current();
        assert!(!intro_flag(&origin), "coming back from a project skips it");
        assert!(intro_flag(&origin), "the skip applies to that one load only");
    }

    fn raw(origin: &str, req: &str, body: Option<&[u8]>) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        if let Some(body) = body {
            stream.write_all(body).unwrap();
        }
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        let code =
            String::from_utf8_lossy(&out[..out.iter().position(|&b| b == b'\r').unwrap_or(0)])
                .split_whitespace()
                .nth(1)
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
        let body = out
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| out[i + 4..].to_vec())
            .unwrap_or_default();
        (code, body)
    }

    fn get(origin: &str, path: &str, token: Option<&str>) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        if let Some(token) = token {
            req.push_str(&format!("{TOKEN_HEADER}: {token}\r\n"));
        }
        req.push_str("\r\n");
        raw(origin, &req, None)
    }

    fn post(origin: &str, path: &str, token: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(token) = token {
            req.push_str(&format!("{TOKEN_HEADER}: {token}\r\n"));
        }
        req.push_str("\r\n");
        raw(origin, &req, Some(body))
    }

    #[test]
    fn page_embeds_the_token_and_api_needs_it() {
        let (server, origin) = spawn("page");
        let token = server.token_for_test();
        let (code, body) = get(&origin, "/", None);
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains(&token));
        let (code, _) = get(&origin, "/api/recents", None);
        assert_eq!(code, 403);
        let (code, _) = post(&origin, "/api/remove", None, br#"{"id":"x"}"#);
        assert_eq!(code, 403);
        let (code, body) = get(&origin, "/api/recents", Some(&token));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("recents"));
    }

    #[test]
    fn create_open_rename_remove_flow() {
        let (server, origin) = spawn("flow");
        let token = server.token_for_test();
        let parent = base("flow-parent");
        let body = serde_json::json!({
            "parent": parent.to_string_lossy(),
            "name": "my-video",
            "fps": "24",
            "width": 1080,
            "height": 1920,
            "duration": 12.0,
        });
        // No opener hook in tests: begin_open marks the phase, calls nothing.
        let (code, _) = post(
            &origin,
            "/api/create",
            Some(&token),
            body.to_string().as_bytes(),
        );
        assert_eq!(code, 200);
        let dest = parent.join("my-video");
        let html = std::fs::read_to_string(dest.join("index.html")).unwrap();
        assert!(html.contains("data-composition-id"));
        assert!(html.contains("data-width=\"1080\""));
        assert!(html.contains("data-fps=\"24\""));
        assert!(dest.join("meta.json").is_file());
        // A duplicate create is refused; an empty name never reaches disk.
        let (code, refused) = post(
            &origin,
            "/api/create",
            Some(&token),
            body.to_string().as_bytes(),
        );
        assert_eq!(code, 400);
        let refused: serde_json::Value = serde_json::from_slice(&refused).unwrap();
        assert_eq!(refused["code"], "folder_exists");
        assert_eq!(refused["params"]["path"], dest.display().to_string());
        assert!(refused["error"].as_str().unwrap().ends_with("already exists and is not empty"));
        let bad = serde_json::json!({"parent": parent.to_string_lossy(), "name": "", "width": 8, "height": 8});
        let (code, refused) = post(
            &origin,
            "/api/create",
            Some(&token),
            bad.to_string().as_bytes(),
        );
        assert_eq!(code, 400);
        let refused: serde_json::Value = serde_json::from_slice(&refused).unwrap();
        assert_eq!(refused["code"], "create_no_name");
        assert_eq!(refused["error"], "give the project a name");

        // The open marked the phase; recording happens on real opens in lib.rs.
        let (code, body) = get(&origin, "/api/open-state", Some(&token));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("opening"));
        let (code, refused) = post(&origin, "/api/open", Some(&token), br#"{"id":"nope"}"#);
        assert_eq!(code, 404);
        let refused: serde_json::Value = serde_json::from_slice(&refused).unwrap();
        assert_eq!(refused["code"], "unknown_project");
        assert_eq!(refused["error"], "unknown project");
        // Record the open (sets the current-open guard), prove renaming
        // the open project is refused, then simulate Show All Projects and
        // rename for real.
        server.record_open("my-video", &dest);
        let (code, refused) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"my-video","new_name":"blocked"}"#,
        );
        assert_eq!(code, 400);
        let refused: serde_json::Value = serde_json::from_slice(&refused).unwrap();
        assert_eq!(refused["code"], "project_in_use");
        server.clear_current();

        // Rename moves the folder and keeps meta.json consistent.
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"my-video","new_name":"renamed"}"#,
        );
        assert_eq!(code, 200);
        assert!(parent.join("renamed").join("index.html").is_file());
        assert!(!parent.join("my-video").exists());
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(parent.join("renamed").join("meta.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["name"], "renamed");
        // Invalid names and unknown ids are refused.
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"renamed","new_name":"a/b"}"#,
        );
        assert_eq!(code, 400);
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"missing","new_name":"x"}"#,
        );
        assert_eq!(code, 404);

        // A project whose index.html vanished no longer opens …
        std::fs::remove_file(parent.join("renamed").join("index.html")).unwrap();
        let (code, body) = post(&origin, "/api/open", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 400);
        assert!(
            String::from_utf8_lossy(&body).contains("index.html"),
            "unexpected: {}",
            String::from_utf8_lossy(&body)
        );
        // … but an empty folder is reported missing rather than openable.
        std::fs::remove_dir_all(parent.join("renamed")).unwrap();
        let (code, _) = get(&origin, "/api/recents", Some(&token));
        assert_eq!(code, 200);
        let (_, body) = get(&origin, "/api/recents", Some(&token));
        assert!(String::from_utf8_lossy(&body).contains("\"missing\":true"));
        let (code, _) = post(&origin, "/api/open", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 410);

        // Remove drops the entry; unknown ids and trash targets 404.
        let (code, _) = post(&origin, "/api/remove", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 200);
        let (code, _) = post(&origin, "/api/remove", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 404);
        let (code, _) = post(&origin, "/api/trash", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 404);
    }

    #[test]
    fn start_names_the_project_from_the_sent_title_and_derives_when_it_is_missing() {
        let (server, origin) = spawn("start-name");
        let token = server.token_for_test();
        let parent = base("start-name-parent");
        let location = parent.to_string_lossy().to_string();

        // The model-chosen title becomes the folder name, and the intake keeps the prompt.
        let (code, body) = post(
            &origin,
            "/api/start",
            Some(&token),
            serde_json::json!({
                "prompt": "Сделай тизер из интервью с режиссёром",
                "name": "Тизер интервью",
                "location": location,
                "width": 1920,
                "height": 1080,
            })
            .to_string()
            .as_bytes(),
        );
        assert_eq!(code, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "Тизер интервью");
        assert_eq!(value["opening"], true);
        let project = parent.join("Тизер интервью");
        assert!(project.join("index.html").is_file());
        let intake: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(project.join(".hyperframes/agent/intake.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(intake["prompt"], "Сделай тизер из интервью с режиссёром");

        // The same title again is made unique rather than refused.
        let (code, body) = post(
            &origin,
            "/api/start",
            Some(&token),
            serde_json::json!({
                "prompt": "Сделай тизер из интервью с режиссёром",
                "name": "Тизер интервью",
                "location": location,
            })
            .to_string()
            .as_bytes(),
        );
        assert_eq!(code, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "Тизер интервью 2");

        // An unusable name (or none at all) falls back to the prompt derivation.
        let (code, body) = post(
            &origin,
            "/api/start",
            Some(&token),
            serde_json::json!({
                "prompt": "Build a product teaser with music",
                "name": "a/b",
                "location": location,
            })
            .to_string()
            .as_bytes(),
        );
        assert_eq!(code, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "Build a product teaser");

        // Files only, no prompt: the first media file names it.
        let clip = parent.join("cam-a.mov");
        std::fs::write(&clip, b"x").unwrap();
        let (code, body) = post(
            &origin,
            "/api/start",
            Some(&token),
            serde_json::json!({
                "files": [clip.to_string_lossy()],
                "location": location,
            })
            .to_string()
            .as_bytes(),
        );
        assert_eq!(code, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "cam-a");
    }

    fn send(origin: &str, method: &str, path: &str, token: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
        send_with_origin(origin, method, path, token, None, body)
    }

    fn send_with_origin(
        origin: &str,
        method: &str,
        path: &str,
        token: Option<&str>,
        request_origin: Option<&str>,
        body: &[u8],
    ) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(token) = token {
            req.push_str(&format!("{TOKEN_HEADER}: {token}\r\n"));
        }
        if let Some(request_origin) = request_origin {
            req.push_str(&format!("Origin: {request_origin}\r\n"));
        }
        req.push_str("\r\n");
        raw(origin, &req, Some(body))
    }

    #[test]
    fn research_policy_and_agent_provider_routes_are_gated_and_validated() {
        let (server, origin) = spawn("research");
        let token = server.token_for_test();
        let research_dir = base("research-policy");
        std::fs::create_dir_all(&research_dir).unwrap();
        // The only test that reads this variable.
        std::env::set_var("OPENVIDS_RESEARCH_DIR", &research_dir);

        for (method, path) in [
            ("GET", "/api/research/policy"),
            ("PUT", "/api/research/policy"),
            ("POST", "/api/research/sources"),
            ("PATCH", "/api/research/sources/openverse"),
            ("DELETE", "/api/research/sources/openverse"),
            ("POST", "/api/research/sources/restore"),
            ("GET", "/api/agent/providers"),
            ("POST", "/api/agent/providers/refresh"),
            ("GET", "/api/agent/providers/anthropic/models"),
            ("POST", "/api/agent/providers/anthropic/api-key"),
            ("POST", "/api/agent/jev/api-key"),
            ("POST", "/api/agent/jev/test"),
        ] {
            let (code, _) = send(&origin, method, path, None, b"{}");
            assert_eq!(code, 403, "{method} {path} needs the token");
        }

        // Provider ids are validated before anything is forwarded (no runtime needed).
        for path in [
            "/api/agent/providers/a%2Fb/models",
            "/api/agent/providers/..%2Fsettings/api-key",
            "/api/agent/providers/a%20b/models",
        ] {
            let (code, body) = send(&origin, "POST", path, Some(&token), br#"{"apiKey":"secret"}"#);
            let (code2, _) = send(&origin, "GET", path, Some(&token), b"");
            assert_eq!((code, code2), (400, 400), "{path}");
            assert!(String::from_utf8_lossy(&body).contains("invalid provider id"));
            assert!(!String::from_utf8_lossy(&body).contains("secret"));
        }
        let (code, _) = send(&origin, "GET", "/api/agent/providers/anthropic/api-key", Some(&token), b"");
        assert_eq!(code, 405);

        let json = |body: &[u8]| serde_json::from_slice::<serde_json::Value>(body).unwrap();
        let (code, body) = send(&origin, "GET", "/api/research/policy", Some(&token), b"");
        assert_eq!(code, 200);
        let policy = json(&body);
        assert_eq!(policy["mode"], "trusted");
        assert_eq!(policy["sources"].as_array().unwrap().len(), 4);
        assert_eq!(policy["websites"]["readLinkedPages"], true);
        assert_eq!(policy["websites"]["fullAccess"], false);

        let (code, body) = send(&origin, "PUT", "/api/research/policy", Some(&token), br#"{"mode":"any","websites":{"readLinkedPages":false,"fullAccess":true}}"#);
        assert_eq!(code, 200);
        let policy = json(&body);
        assert_eq!(policy["mode"], "any");
        assert_eq!(policy["websites"]["readLinkedPages"], false);
        assert_eq!(policy["websites"]["fullAccess"], true);
        let (code, body) = send(&origin, "PUT", "/api/research/policy", Some(&token), b"{}");
        assert_eq!(code, 400);
        assert_eq!(json(&body)["error"]["code"], "invalid_request");

        let (code, body) = send(&origin, "POST", "/api/research/sources", Some(&token), br#"{"name":"Pexels","domains":["https://www.pexels.com/x"]}"#);
        assert_eq!(code, 200);
        let policy = json(&body);
        let added = policy["sources"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(added["domains"], serde_json::json!(["pexels.com"]));
        let id = added["id"].as_str().unwrap().to_string();
        let (code, body) = send(&origin, "POST", "/api/research/sources", Some(&token), br#"{"name":"Dup","domains":["pexels.com"]}"#);
        assert_eq!(code, 409);
        assert_eq!(json(&body)["error"]["code"], "conflict");

        let (code, body) = send(&origin, "PATCH", &format!("/api/research/sources/{id}"), Some(&token), br#"{"enabled":false}"#);
        assert_eq!(code, 200);
        assert_eq!(json(&body)["sources"].as_array().unwrap().last().unwrap()["enabled"], false);
        let (code, body) = send(&origin, "PATCH", "/api/research/sources/src-nope", Some(&token), br#"{"enabled":true}"#);
        assert_eq!(code, 400);
        assert_eq!(json(&body)["error"]["code"], "unknown_source");

        let (code, body) = send(&origin, "DELETE", "/api/research/sources/openverse", Some(&token), b"");
        assert_eq!(code, 200);
        assert_eq!(json(&body)["removedBuiltIns"], serde_json::json!(["openverse"]));
        let (code, body) = send(&origin, "POST", "/api/research/sources/restore", Some(&token), b"");
        assert_eq!(code, 200);
        assert_eq!(json(&body)["removedBuiltIns"], serde_json::json!([]));
        let (code, _) = send(&origin, "DELETE", &format!("/api/research/sources/{id}"), Some(&token), b"");
        assert_eq!(code, 200);
        // The file on disk is what Studio's server reads.
        let file: serde_json::Value = serde_json::from_slice(&std::fs::read(research_dir.join("policy.json")).unwrap()).unwrap();
        assert_eq!(file["schema"], "openvids.research-policy/1");
        assert_eq!(file["mode"], "any");
        assert_eq!(file["websites"]["readLinkedPages"], false);
        assert_eq!(file["websites"]["fullAccess"], true);
    }

    // The fake CLI is a `sh` script: this test cannot run on Windows, where
    // `OPENVIDS_CLI_BUN=/bin/sh` does not exist. Windows CLI coverage belongs
    // to the process slice.
    #[test]
    #[cfg(unix)]
    fn system_routes_are_gated_and_drive_the_cli_and_the_chrome_install() {
        let (server, origin) = spawn("system");
        for (method, path) in [
            ("GET", "/api/system/check"),
            ("GET", "/api/system/install/chrome"),
            ("POST", "/api/system/install/chrome"),
            ("POST", "/api/system/install/chrome/cancel"),
        ] {
            let (code, _) = send(&origin, method, path, None, b"");
            assert_eq!(code, 403, "{method} {path} needs the token");
        }
        let script = r#"
case "$1" in
  doctor)
    echo '{"tools":{"ffmpeg":{"found":true,"path":"/usr/bin/ffmpeg","version":"7.1"},"ffprobe":{"found":false},"chrome":{"found":false}}}' ;;
  browser)
    echo '{"event":"start"}'
    echo '{"event":"progress","downloaded":10,"total":100}'
    sleep 30 ;;
esac
"#;
        crate::cli_runner::tests::with_fake_cli(script, || {
            crate::chrome_install::reset();
            let json = |body: &[u8]| serde_json::from_slice::<serde_json::Value>(body).unwrap();
            let (code, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            assert_eq!(code, 200);
            let check = json(&body);
            assert_eq!(check["ffmpeg"]["found"], true);
            assert_eq!(check["ffmpeg"]["version"], "7.1");
            assert_eq!(check["chrome"]["found"], false);
            assert_eq!(check["install"]["chrome"]["phase"], "idle");

            let (code, _) = send(&origin, "DELETE", "/api/system/check", Some(&token), b"");
            assert_eq!(code, 405);
            let (code, _) = send(&origin, "GET", "/api/system/nope", Some(&token), b"");
            assert_eq!(code, 404);

            let (code, body) = send(&origin, "POST", "/api/system/install/chrome", Some(&token), b"");
            assert_eq!(code, 200);
            assert!(json(&body)["phase"].is_string());
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let (_, body) = send(&origin, "GET", "/api/system/install/chrome", Some(&token), b"");
                let state = json(&body);
                if state["phase"] == "downloading" {
                    assert_eq!((state["downloaded"].as_u64(), state["total"].as_u64()), (Some(10), Some(100)));
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "never downloading: {state}");
                std::thread::sleep(Duration::from_millis(20));
            }
            let (code, body) = send(&origin, "POST", "/api/system/install/chrome/cancel", Some(&token), b"");
            assert_eq!(code, 200);
            assert_eq!(json(&body)["phase"], "cancelled");
            let (_, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            assert_eq!(json(&body)["install"]["chrome"]["phase"], "cancelled");
        });
    }

    // Homebrew is macOS-only and the fake brew is a `sh` script: this test
    // cannot run on Windows (no `sh` execution of the script, no brew flow).
    // Windows FFmpeg coverage lives in `home_api::ffprobe` lookup tests.
    #[test]
    #[cfg(unix)]
    fn ffmpeg_install_routes_drive_brew_and_report_homebrew_in_the_check() {
        let (server, origin) = spawn("ffmpeg-install");
        for (method, path) in [
            ("GET", "/api/system/install/ffmpeg"),
            ("POST", "/api/system/install/ffmpeg"),
            ("POST", "/api/system/install/ffmpeg/cancel"),
        ] {
            let (code, _) = send(&origin, method, path, None, b"");
            assert_eq!(code, 403, "{method} {path} needs the token");
        }
        let json = |body: &[u8]| serde_json::from_slice::<serde_json::Value>(body).unwrap();
        let cli = "console.log(JSON.stringify({tools:{ffmpeg:{found:false},ffprobe:{found:false},chrome:{found:false}}}))";
        crate::cli_runner::tests::with_fake_cli(cli, || {
            crate::ffmpeg_install::reset();
            // No Homebrew: the check says so, offers no button, and start is a clear 409.
            std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
            let (_, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            let check = json(&body);
            assert_eq!(check["homebrew"]["found"], false);
            assert_eq!(check["ffmpeg"]["canInstall"], false);
            assert_eq!(check["ffprobe"]["installer"], serde_json::Value::Null);
            let (code, body) = send(&origin, "POST", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!(code, 409);
            assert!(json(&body)["error"].as_str().unwrap().contains("https://brew.sh"));
            let (code, body) = send(&origin, "GET", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!((code, json(&body)["phase"].as_str()), (200, Some("idle")));

            // With a (fake) Homebrew: the button is offered and the job streams and finishes.
            let dir = std::env::temp_dir().join(format!("openvids-home-brew-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let brew = dir.join("brew.mjs");
            std::fs::write(&brew, "console.log('==> Fetching ffmpeg');\nawait Bun.sleep(1000);\n").unwrap();
            std::env::set_var("OPENVIDS_BREW_PATH", &brew);
            let (_, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            let check = json(&body);
            assert_eq!(check["homebrew"]["found"], true);
            assert_eq!(check["ffmpeg"]["canInstall"], true);
            assert_eq!(check["ffmpeg"]["installer"], "homebrew");
            assert_eq!(check["ffprobe"]["canInstall"], true);

            let (code, body) = send(&origin, "POST", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!(code, 200);
            assert_eq!(json(&body)["phase"], "installing");
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                let (_, body) = send(&origin, "GET", "/api/system/install/ffmpeg", Some(&token), b"");
                let state = json(&body);
                // The fake CLI says ffmpeg is still missing afterwards: brew "worked", the tool is not there.
                if state["phase"] == "failed" {
                    assert!(state["error"].as_str().unwrap().contains("not found afterwards"));
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "never finished: {state}");
                std::thread::sleep(Duration::from_millis(30));
            }
            let (code, body) = send(&origin, "POST", "/api/system/install/ffmpeg/cancel", Some(&token), b"");
            assert_eq!(code, 200);
            assert_eq!(json(&body)["phase"], "failed");
            let (code, _) = send(&origin, "DELETE", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!(code, 405);
            std::env::remove_var("OPENVIDS_BREW_PATH");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    // Windows never touches Homebrew: POST starts the official-build download
    // (driven here by a loopback server), GET polls it, cancel stops it.
    #[test]
    #[cfg(windows)]
    fn ffmpeg_install_routes_drive_the_windows_download() {
        let _env = crate::ffmpeg_install::FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::{Read, Write};
        let (server, origin) = spawn("ffmpeg-download");
        let token = server.token_for_test();
        for (method, path) in [
            ("GET", "/api/system/install/ffmpeg"),
            ("POST", "/api/system/install/ffmpeg"),
            ("POST", "/api/system/install/ffmpeg/cancel"),
        ] {
            let (code, _) = send(&origin, method, path, None, b"");
            assert_eq!(code, 403, "{method} {path} needs the token");
        }
        let json = |body: &[u8]| serde_json::from_slice::<serde_json::Value>(body).unwrap();
        // A tiny synthetic build: the two exes at the top level plus a license.
        let zip = {
            use std::io::Write;
            let mut out = std::io::Cursor::new(Vec::new());
            let mut writer = zip::ZipWriter::new(&mut out);
            let options = zip::write::SimpleFileOptions::default();
            for (name, content) in [("ffmpeg.exe", "fake-ffmpeg"), ("ffprobe.exe", "fake-ffprobe"), ("LICENSE", "gpl")] {
                writer.start_file(name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
            out.into_inner()
        };
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        hasher.update(&zip);
        let hex = format!("{:x}", hasher.finalize());
        let checksum_body = format!("{hex}  ffmpeg.zip");
        // Loopback file server for the archive and its checksum file.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut head = [0u8; 4096];
                let Ok(n) = stream.read(&mut head) else { continue };
                let path = String::from_utf8_lossy(&head[..n]).lines().next().unwrap_or_default().to_string();
                let (status, body, kind): (&str, &[u8], &str) = if path.contains("sha256") {
                    ("200 OK", checksum_body.as_bytes(), "text/plain")
                } else {
                    ("200 OK", &zip, "application/zip")
                };
                let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {kind}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                let _ = stream.write_all(body);
            }
        });
        let dir = std::env::temp_dir().join(format!("openvids-home-ffmpeg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("OPENVIDS_FFMPEG_DIR", &dir);
        std::env::set_var("OPENVIDS_FFMPEG_URL", format!("http://127.0.0.1:{port}/ffmpeg.zip"));
        std::env::set_var("OPENVIDS_FFMPEG_SHA256_URL", format!("http://127.0.0.1:{port}/ffmpeg.zip.sha256"));
        let cli = "console.log(JSON.stringify({tools:{ffmpeg:{found:false},ffprobe:{found:false},chrome:{found:false}}}))";
        crate::cli_runner::tests::with_fake_cli(cli, || {
            crate::ffmpeg_install::reset();
            let (_, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            let check = json(&body);
            assert_eq!(check["ffmpeg"]["canInstall"], true);
            assert_eq!(check["ffmpeg"]["installer"], "download");
            assert_eq!(check["ffprobe"]["installer"], "download");
            let (code, body) = send(&origin, "POST", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!(code, 200);
            assert!(matches!(json(&body)["phase"].as_str(), Some("downloading") | Some("installing")));
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let (_, body) = send(&origin, "GET", "/api/system/install/ffmpeg", Some(&token), b"");
                let state = json(&body);
                if state["phase"] == "done" {
                    assert!(state["path"].as_str().unwrap().ends_with("ffmpeg.exe"));
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "never finished: {state}");
                std::thread::sleep(Duration::from_millis(30));
            }
            // A managed build flips the installer off: nothing left to install.
            let (_, body) = send(&origin, "GET", "/api/system/check", Some(&token), b"");
            let check = json(&body);
            assert_eq!(check["ffmpeg"]["canInstall"], false);
            assert_eq!(check["ffmpeg"]["installer"], serde_json::Value::Null);
            let (code, _) = send(&origin, "DELETE", "/api/system/install/ffmpeg", Some(&token), b"");
            assert_eq!(code, 405);
        });
        std::env::remove_var("OPENVIDS_FFMPEG_URL");
        std::env::remove_var("OPENVIDS_FFMPEG_SHA256_URL");
        std::env::remove_var("OPENVIDS_FFMPEG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn the_onboarding_request_from_the_menu_reaches_the_page_once() {
        let (server, origin) = spawn("onboarding-boot");
        let flag = |origin: &str| {
            let (_, body) = get(origin, "/", None);
            let page = String::from_utf8_lossy(&body).into_owned();
            page.contains("\"openOnboarding\":true")
        };
        assert!(!flag(&origin));
        server.request_onboarding();
        assert!(flag(&origin), "the page opened after the request gets the flag");
        assert!(!flag(&origin), "and only that one");
    }

    #[test]
    fn thumbnails_roundtrip_through_the_server() {
        let (server, origin) = spawn("thumbs");
        let token = server.token_for_test();
        let dir = base("thumbs-proj");
        std::fs::create_dir_all(&dir).unwrap();
        server.record_open("demo", &dir);
        server.cache_thumbnail(&dir, b"fake-jpeg-bytes", "jpg");
        let (_, body) = get(&origin, "/api/recents", Some(&token));
        assert!(
            String::from_utf8_lossy(&body).contains(".jpg"),
            "unexpected: {}",
            String::from_utf8_lossy(&body)
        );
        // Extract the thumb file name from the JSON payload.
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let thumb = value["recents"][0]["thumb"].as_str().unwrap().to_string();
        let (code, body) = get(&origin, &format!("/thumb/{thumb}"), None);
        assert_eq!(code, 200);
        assert_eq!(body, b"fake-jpeg-bytes");
        // Traversal attempts are refused without a token check getting in the way.
        let (code, _) = get(&origin, "/thumb/../home.rs", None);
        assert_eq!(code, 400);
        let (code, _) = get(&origin, "/thumb/missing.jpg", None);
        assert_eq!(code, 404);
    }

    #[test]
    fn locales_routes_serve_the_compiled_catalog() {
        let (_server, origin) = spawn("locales");
        // Token-free GETs (like `/assets/*`): plain `fetch` from the page.
        let (code, body) = get(&origin, "/locales/index.json", None);
        assert_eq!(code, 200);
        let index: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(index.as_array().unwrap().iter().any(|e| e["code"] == "en"));
        let (code, body) = get(&origin, "/locales/en.json", None);
        assert_eq!(code, 200);
        let en: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(en.get("settings.language.label").is_some());
        for bad in ["/locales/xx.json", "/locales/../prefs.rs", "/locales/en.JSON"] {
            let (code, _) = get(&origin, bad, None);
            assert_eq!(code, 404, "{bad}");
        }
    }

    #[test]
    fn menu_routes_are_gated_validated_and_about_shaped() {
        let (_server, origin) = spawn("menu-routes");
        // Token-gated like every /api route (the menu asks from the page).
        for (method, path) in [
            ("GET", "/api/menu/about"),
            ("POST", "/api/menu/quit"),
            ("POST", "/api/menu/reload"),
            ("GET", "/api/menu/quit"),
            ("POST", "/api/menu/nonexistent"),
            ("POST", "/api/menu/"),
        ] {
            let (code, _) = send(&origin, method, path, None, b"{}");
            if method == "GET" && path == "/api/menu/about" {
                // About is a read: no token needed, like the pages and assets.
                assert_eq!(code, 200, "{method} {path}");
            } else {
                assert_eq!(code, 403, "{method} {path} needs the token");
            }
        }
        // About answers the same strings the native dialog shows.
        let (code, body) = get(&origin, "/api/menu/about", None);
        assert_eq!(code, 200);
        let about: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(about["name"], "OpenVids");
        assert_eq!(about["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(about["website"], "https://openvids.ai");
        assert_eq!(about["websiteLabel"], "openvids.ai");
        assert!(about["comment"].as_str().is_some_and(|s| !s.is_empty()));
        // Unknown or mistyped actions 404 even with the token, so a stale
        // page cannot trigger something new; only POST dispatches.
        let token = _server.token_for_test();
        for (method, path, code) in [
            ("POST", "/api/menu/nonexistent", 404),
            ("POST", "/api/menu/", 404),
            ("POST", "/api/menu/quit/now", 404),
            ("GET", "/api/menu/quit", 404),
            ("DELETE", "/api/menu/reload", 404),
        ] {
            assert_eq!(send(&origin, method, path, Some(&token), b"{}").0, code, "{method} {path}");
        }
    }

    #[test]
    fn pages_carry_the_locale_catalog_for_first_paint() {
        let (_server, origin) = spawn("locales-boot");
        let (code, body) = get(&origin, "/", None);
        assert_eq!(code, 200);
        let page = String::from_utf8_lossy(&body).into_owned();
        assert!(page.contains("\"locales\""), "boot has no locales object");
        assert!(page.contains("\"messages\""), "boot has no messages");
        assert!(page.contains("settings.language.label"), "boot has no en strings");
        assert!(!page.contains("__OV_BOOT__"), "boot placeholder leaked");
        let (code, body) = get(&origin, "/settings", None);
        assert_eq!(code, 200);
        let settings = String::from_utf8_lossy(&body).into_owned();
        assert!(settings.contains("settings.language.label"), "settings has no strings");
        assert!(!settings.contains("__OV_LOCALES__"), "locales placeholder leaked");
    }

    /// Studio's token-less `POST /api/menu/:action` passes only from the live
    /// Studio origin, only for whitelisted actions. Everything else — a
    /// foreign or missing `Origin`, a non-POST method, an unknown action, an
    /// action with extra path segments — falls back to the token check (403
    /// without it). Clearing the Studio origin (the shared home-navigation
    /// cleanup in `take_closed_studio`) closes the allowance again, so a
    /// stale port cannot be reused.
    #[test]
    fn studio_menu_posts_need_the_live_studio_origin() {
        let (server, origin) = spawn("studio-menu");
        let studio = "http://127.0.0.1:5210";
        // No Studio origin published yet: even the exact Origin is refused.
        for (method, path) in [("POST", "/api/menu/open_project"), ("POST", "/api/menu/reload")] {
            let (code, _) = send_with_origin(&origin, method, path, None, Some(studio), b"{}");
            assert_eq!(code, 403, "{method} {path} without a live Studio origin");
        }
        server.set_studio_origin(Some(studio.to_string()));
        // Whitelisted actions pass without the token (503: no app handle in tests).
        for action in super::super::MENU_ACTIONS {
            let (code, _) = send_with_origin(
                &origin,
                "POST",
                &format!("/api/menu/{action}"),
                None,
                Some(studio),
                b"{}",
            );
            assert_eq!(code, 503, "menu action {action}");
        }
        // The localhost spelling of the same port passes too.
        let (code, _) = send_with_origin(
            &origin,
            "POST",
            "/api/menu/reload",
            None,
            Some("http://localhost:5210"),
            b"{}",
        );
        assert_eq!(code, 503);
        // Everything else falls back to the token check.
        for (method, path, request_origin) in [
            ("POST", "/api/menu/reload", Some("http://evil.com")),
            ("POST", "/api/menu/reload", Some("http://127.0.0.1:9999")),
            ("POST", "/api/menu/reload", None),
            ("GET", "/api/menu/reload", Some(studio)),
            ("POST", "/api/menu/nonexistent", Some(studio)),
            ("POST", "/api/menu/quit/now", Some(studio)),
            ("POST", "/api/recents", Some(studio)),
        ] {
            let (code, _) = send_with_origin(&origin, method, path, None, request_origin, b"{}");
            assert_eq!(code, 403, "{method} {path}");
        }
        // Back on the Projects page the allowance is gone: the same Studio
        // origin is refused again, with or without the token. The cross-origin
        // gate runs first: a Studio `Origin` on the home port is foreign, so
        // the request never reaches the token check (the tokened path is for
        // same-origin page traffic, which sends the home `Origin` or none).
        server.set_studio_origin(None);
        let (code, _) =
            send_with_origin(&origin, "POST", "/api/menu/reload", None, Some(studio), b"{}");
        assert_eq!(code, 403);
        let token = server.token_for_test();
        let (code, _) =
            send_with_origin(&origin, "POST", "/api/menu/reload", Some(&token), Some(studio), b"{}");
        assert_eq!(code, 403);
        let (code, _) = send_with_origin(
            &origin,
            "POST",
            "/api/menu/reload",
            Some(&token),
            Some(&origin),
            b"{}",
        );
        assert_eq!(code, 503);
    }
}
