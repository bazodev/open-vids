//! The global Asset Search policy, for the Projects page.
//!
//! Studio edits this policy through its server
//! (`packages/studio-server/src/research/sources/policyStore.ts`, routes under
//! `/api/research/*`); no Studio server runs on the Projects page, so this is
//! a port of that store and of the request parsing in `research/requests.ts`.
//! Both sides read and write the SAME file, `policy.json` in
//! `$OPENVIDS_RESEARCH_DIR` (default `~/.openvids/research`), in the same
//! format and under the same rules:
//!
//! - schema `openvids.research-policy/1`: `mode`, `builtIns` (what the user
//!   changed about a built-in source), `userSources`, `removedBuiltIns`,
//!   `websites.readLinkedPages`, `websites.fullAccess`, `updatedAt` (ms since
//!   the epoch);
//! - a file that cannot be read as such (also: an unusable user source, a
//!   damaged `websites`) is copied to `policy.json.bak` and replaced by the
//!   defaults, never guessed at, so a damaged policy can only narrow what is
//!   allowed; a file from before the website reader has no `websites` and
//!   gets the default (reading linked pages on), and one from before full
//!   access keeps its `readLinkedPages` with `fullAccess` off;
//! - writes replace the file atomically (temp file + rename), mode 0600, in a
//!   directory of mode 0700;
//! - the response of every route is the full policy view.
//!
//! The built-in source list below is duplicated from
//! `packages/studio-server/src/research/sources/builtins.ts`: change both
//! together. The limits mirror `RESEARCH_LIMITS` in
//! `packages/agent-protocol/src/research.ts`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Number, Value};

const POLICY_SCHEMA: &str = "openvids.research-policy/1";
const POLICY_FILE: &str = "policy.json";

pub const MODES: [&str; 2] = ["trusted", "any"];
pub const MEDIA_KINDS: [&str; 3] = ["video", "picture", "audio"];

// Mirrors `RESEARCH_LIMITS` (agent-protocol/src/research.ts).
const MAX_SOURCES: usize = 64;
const MAX_DOMAINS_PER_SOURCE: usize = 16;
const NAME_CHARS: usize = 80;
const NOTE_CHARS: usize = 500;
const URL_CHARS: usize = 2_048;

/// Serializes read-modify-write cycles within this process (the home server
/// answers each connection on its own thread). Studio's server is another
/// process; like the TS store, nothing coordinates with it.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// ── Errors ──────────────────────────────────────────────────────────────────

/// A refused request: the wire error `{ code, message }` and its HTTP status
/// (`researchStatus` in `research/errors.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    pub code: &'static str,
    pub message: String,
}

impl PolicyError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    pub fn status(&self) -> u16 {
        match self.code {
            "invalid_request" | "unknown_source" => 400,
            "conflict" => 409,
            _ => 500,
        }
    }
}

// ── Built-in sources ────────────────────────────────────────────────────────

struct BuiltInDef {
    id: &'static str,
    name: &'static str,
    connector: &'static str,
    domains: &'static [&'static str],
    kinds: &'static [&'static str],
    description: &'static str,
    license_note: &'static str,
    homepage: &'static str,
}

/// The built-in trusted sources, in display order. DUPLICATE of
/// `BUILT_IN_SOURCES` in `packages/studio-server/src/research/sources/builtins.ts`
/// (the Studio server cannot run here and this crate cannot import it): when a
/// source is added, removed or edited, change both lists.
const BUILT_INS: [BuiltInDef; 4] = [
    BuiltInDef {
        id: "wikimedia-commons",
        name: "Wikimedia Commons",
        connector: "wikimedia_commons",
        domains: &["commons.wikimedia.org", "upload.wikimedia.org", "wikimedia.org"],
        kinds: &["video", "picture", "audio"],
        description: "Free media files of Wikipedia and its sister projects.",
        license_note: "Each file carries its own license (public domain, CC0, CC BY, CC BY-SA…); the author and license come from the file's page.",
        homepage: "https://commons.wikimedia.org",
    },
    BuiltInDef {
        id: "openverse",
        name: "Openverse",
        connector: "openverse",
        domains: &["api.openverse.org", "openverse.org"],
        kinds: &["picture", "audio"],
        description: "Openly licensed images and audio gathered from Flickr, Freesound, Wikimedia and other collections.",
        license_note: "Every result states its Creative Commons license and creator; the files are hosted by the original collection.",
        homepage: "https://openverse.org",
    },
    BuiltInDef {
        id: "nasa-images",
        name: "NASA Image and Video Library",
        connector: "nasa_images",
        domains: &["images-api.nasa.gov", "images-assets.nasa.gov", "images.nasa.gov"],
        kinds: &["video", "picture", "audio"],
        description: "Images, video and audio from NASA missions.",
        license_note: "NASA media is generally not copyrighted (public domain), except where the page says otherwise; logos and people's likenesses have their own rules.",
        homepage: "https://images.nasa.gov",
    },
    BuiltInDef {
        id: "internet-archive",
        name: "Internet Archive",
        connector: "internet_archive",
        domains: &["archive.org"],
        kinds: &["video", "picture", "audio"],
        description: "Public-domain and openly licensed films, recordings and images.",
        license_note: "Only items with a license field are treated as licensed; everything else is marked unknown.",
        homepage: "https://archive.org",
    },
];

fn is_built_in(id: &str) -> bool {
    BUILT_INS.iter().any(|b| b.id == id)
}

impl BuiltInDef {
    fn source(&self) -> TrustedSource {
        TrustedSource {
            id: self.id.to_string(),
            name: self.name.to_string(),
            built_in: true,
            enabled: true,
            connector: self.connector.to_string(),
            domains: self.domains.iter().map(|d| d.to_string()).collect(),
            kinds: self.kinds.iter().map(|k| k.to_string()).collect(),
            description: self.description.to_string(),
            license_note: self.license_note.to_string(),
            homepage: Some(self.homepage.to_string()),
        }
    }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/// A trusted source as served (and, for the user's own, as stored).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrustedSource {
    pub id: String,
    pub name: String,
    #[serde(rename = "builtIn")]
    pub built_in: bool,
    pub enabled: bool,
    pub connector: String,
    pub domains: Vec<String>,
    pub kinds: Vec<String>,
    pub description: String,
    #[serde(rename = "licenseNote")]
    pub license_note: String,
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Websites {
    #[serde(rename = "readLinkedPages")]
    pub read_linked_pages: bool,
    #[serde(rename = "fullAccess")]
    pub full_access: bool,
}

/// `AssetSearchPolicy` (agent-protocol): the body every route answers with.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PolicyView {
    pub mode: String,
    pub sources: Vec<TrustedSource>,
    #[serde(rename = "removedBuiltIns")]
    pub removed_built_ins: Vec<String>,
    pub websites: Websites,
    #[serde(rename = "updatedAt")]
    pub updated_at: Number,
}

/// What the user changed about a built-in source (domains and connector are fixed).
#[derive(Debug, Clone, PartialEq, Serialize)]
struct BuiltInOverride {
    enabled: bool,
    name: Option<String>,
}

/// The file's content.
#[derive(Debug, Clone, Serialize)]
struct Stored {
    schema: &'static str,
    mode: String,
    #[serde(rename = "builtIns")]
    built_ins: BTreeMap<String, BuiltInOverride>,
    #[serde(rename = "userSources")]
    user_sources: Vec<TrustedSource>,
    #[serde(rename = "removedBuiltIns")]
    removed_built_ins: Vec<String>,
    websites: Websites,
    #[serde(rename = "updatedAt")]
    updated_at: Number,
}

impl Stored {
    fn defaults() -> Self {
        Self {
            schema: POLICY_SCHEMA,
            mode: "trusted".into(),
            built_ins: BTreeMap::new(),
            user_sources: Vec::new(),
            removed_built_ins: Vec::new(),
            websites: Websites {
                read_linked_pages: true,
                full_access: false,
            },
            updated_at: Number::from(0u64),
        }
    }

    fn view(&self) -> PolicyView {
        let mut sources: Vec<TrustedSource> = BUILT_INS
            .iter()
            .filter(|def| !self.removed_built_ins.iter().any(|id| id == def.id))
            .map(|def| {
                let mut source = def.source();
                if let Some(over) = self.built_ins.get(def.id) {
                    source.enabled = over.enabled;
                    if let Some(name) = &over.name {
                        source.name = name.clone();
                    }
                }
                source
            })
            .collect();
        sources.extend(self.user_sources.iter().cloned());
        PolicyView {
            mode: self.mode.clone(),
            sources,
            removed_built_ins: self.removed_built_ins.clone(),
            websites: self.websites.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

// ── Reading the file ────────────────────────────────────────────────────────

fn kinds_of(value: &Value) -> Option<Vec<String>> {
    let entries = value.as_array().filter(|a| !a.is_empty())?;
    let mut kinds: Vec<String> = Vec::new();
    for entry in entries {
        let kind = entry.as_str().filter(|k| MEDIA_KINDS.contains(k))?;
        if !kinds.iter().any(|k| k == kind) {
            kinds.push(kind.to_string());
        }
    }
    Some(kinds)
}

fn user_source_of(value: &Value) -> Option<TrustedSource> {
    let map = value.as_object()?;
    let id = map.get("id")?.as_str().filter(|id| id.starts_with("src-"))?;
    let kinds = kinds_of(map.get("kinds")?)?;
    let name = map.get("name")?.as_str()?;
    let enabled = map.get("enabled")?.as_bool()?;
    let description = map.get("description")?.as_str()?;
    let license_note = map.get("licenseNote")?.as_str()?;
    let domains = map
        .get("domains")?
        .as_array()?
        .iter()
        .map(|d| d.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    Some(TrustedSource {
        id: id.to_string(),
        name: name.to_string(),
        built_in: false,
        enabled,
        connector: "site".into(),
        domains,
        kinds,
        description: description.to_string(),
        license_note: license_note.to_string(),
        homepage: map.get("homepage").and_then(Value::as_str).map(str::to_string),
    })
}

/// `storedPolicyOf`: the file's content, or `None` when any part is unusable.
fn stored_of(raw: &Value) -> Option<Stored> {
    let map = raw.as_object()?;
    if map.get("schema")?.as_str()? != POLICY_SCHEMA {
        return None;
    }
    let mode = map.get("mode")?.as_str().filter(|m| MODES.contains(m))?;
    let built_ins_raw = map.get("builtIns")?.as_object()?;
    let user_raw = map.get("userSources")?.as_array()?;
    let removed_raw = map.get("removedBuiltIns")?.as_array()?;
    let updated_at = map.get("updatedAt")?.as_number()?.clone();

    let mut built_ins = BTreeMap::new();
    for (id, entry) in built_ins_raw {
        if !is_built_in(id) {
            continue;
        }
        let entry = entry.as_object()?;
        let enabled = entry.get("enabled")?.as_bool()?;
        built_ins.insert(
            id.clone(),
            BuiltInOverride {
                enabled,
                name: entry.get("name").and_then(Value::as_str).map(str::to_string),
            },
        );
    }
    let user_sources = user_raw
        .iter()
        .map(user_source_of)
        .collect::<Option<Vec<TrustedSource>>>()?;
    // No `websites` (a file from before the website reader): the default. A
    // damaged value is not guessed at: the whole file is refused. A file from
    // before full access has no `fullAccess`: it stays off, keeping
    // `readLinkedPages`.
    let websites = match map.get("websites") {
        None => Websites {
            read_linked_pages: true,
            full_access: false,
        },
        Some(value) => {
            let websites = value.as_object()?;
            let read_linked_pages = websites.get("readLinkedPages")?.as_bool()?;
            let full_access = match websites.get("fullAccess") {
                None => false,
                Some(Value::Bool(flag)) => *flag,
                Some(_) => return None,
            };
            Websites {
                read_linked_pages,
                full_access,
            }
        }
    };
    Some(Stored {
        schema: POLICY_SCHEMA,
        mode: mode.to_string(),
        built_ins,
        user_sources,
        removed_built_ins: removed_raw
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| is_built_in(id))
            .map(str::to_string)
            .collect(),
        websites,
        updated_at,
    })
}

// ── Domains ─────────────────────────────────────────────────────────────────

/// Multi-label public suffixes a user must not trust as a whole. Mirrors
/// `SHARED_SUFFIXES` in `research/sources/domains.ts`.
const SHARED_SUFFIXES: [&str; 29] = [
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "ne.jp",
    "or.jp",
    "com.br",
    "com.cn",
    "com.mx",
    "com.ar",
    "com.tr",
    "co.in",
    "co.za",
    "co.kr",
    "github.io",
    "gitlab.io",
    "pages.dev",
    "vercel.app",
    "netlify.app",
    "blogspot.com",
    "herokuapp.com",
    "wordpress.com",
    "web.app",
    "firebaseapp.com",
];

fn is_shared_suffix(host: &str) -> bool {
    SHARED_SUFFIXES.contains(&host)
}

fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// Whether `host` is one of `domains` or a subdomain of one.
pub fn host_matches_domains(host: &str, domains: &[String]) -> bool {
    let name = host.to_lowercase();
    domains
        .iter()
        .any(|d| name == *d || name.ends_with(&format!(".{d}")))
}

/// `^[a-z][a-z0-9+.-]*://`
fn has_scheme(raw: &str) -> bool {
    let Some((scheme, _)) = raw.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
}

/// A trusted domain from what the user typed (a host, `www.example.org/path`,
/// or a full URL): lower-case host without scheme, path, port and `www.`.
/// IP addresses, `localhost`, single-label names and public suffixes are
/// refused. Port of `normalizeDomain` (`research/sources/domains.ts`).
pub fn normalize_domain(input: &str) -> Result<String, PolicyError> {
    let raw = input.trim().to_lowercase();
    if raw.is_empty() {
        return Err(PolicyError::invalid("A domain must not be empty"));
    }
    let not_a_domain = || PolicyError::invalid(format!("\"{input}\" is not a domain"));
    let candidate = if has_scheme(&raw) {
        raw.clone()
    } else {
        format!("https://{raw}")
    };
    let url = url::Url::parse(&candidate).map_err(|_| not_a_domain())?;
    let hostname = url.host_str().ok_or_else(not_a_domain)?;
    let mut host = strip_brackets(hostname).to_string();
    if host.ends_with('.') {
        host.pop();
    }
    if let Some(rest) = host.strip_prefix("www.") {
        host = rest.to_string();
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err(PolicyError::invalid(format!(
            "\"{input}\" is an IP address, not a website"
        )));
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(PolicyError::invalid(format!(
            "\"{input}\" is a local address, not a website"
        )));
    }
    let labels: Vec<&str> = host.split('.').collect();
    let well_formed = labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    if !well_formed {
        return Err(PolicyError::invalid(format!(
            "\"{input}\" is not a website domain (expected something like example.org)"
        )));
    }
    if is_shared_suffix(&host) {
        return Err(PolicyError::invalid(format!(
            "\"{host}\" is shared by many unrelated sites; name the specific site instead"
        )));
    }
    Ok(host)
}

// ── Requests (port of `research/requests.ts` and the store's own checks) ────

/// `PUT /api/research/policy`
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PolicyUpdate {
    pub mode: Option<String>,
    pub read_linked_pages: Option<bool>,
    pub full_access: Option<bool>,
}

/// `POST /api/research/sources`
#[derive(Debug, PartialEq, Eq)]
pub struct AddSource {
    pub name: String,
    pub domains: Vec<String>,
    pub kinds: Option<Vec<String>>,
    /// `Some(None)`: an explicit `null`.
    pub homepage: Option<Option<String>>,
    pub license_note: Option<String>,
}

/// `PATCH /api/research/sources/:id`
#[derive(Debug, Default, PartialEq, Eq)]
pub struct UpdateSource {
    pub enabled: Option<bool>,
    pub name: Option<String>,
    pub domains: Option<Vec<String>>,
    pub kinds: Option<Vec<String>>,
    pub license_note: Option<String>,
}

/// JS string length (UTF-16 code units), the unit the TS limits count in.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn body_object<'a>(raw: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, PolicyError> {
    let map = raw
        .as_object()
        .ok_or_else(|| PolicyError::invalid("The request body must be a JSON object"))?;
    if let Some(extra) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(PolicyError::invalid(format!("Unknown field \"{extra}\"")));
    }
    Ok(map)
}

/// `text` of `requests.ts`: a string, trimmed, non-empty unless `empty`, within `max`.
fn text(value: Option<&Value>, field: &str, max: usize, empty: bool) -> Result<String, PolicyError> {
    let Some(raw) = value.and_then(Value::as_str) else {
        return Err(PolicyError::invalid(format!("{field} must be text")));
    };
    let trimmed = raw.trim();
    if !empty && trimmed.is_empty() {
        return Err(PolicyError::invalid(format!("{field} must not be empty")));
    }
    if js_len(trimmed) > max {
        return Err(PolicyError::invalid(format!("{field} exceeds {max} characters")));
    }
    Ok(trimmed.to_string())
}

fn string_list(value: Option<&Value>, field: &str) -> Result<Vec<String>, PolicyError> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Err(PolicyError::invalid(format!("{field} must be a list")));
    };
    entries
        .iter()
        .map(|entry| text(Some(entry), field, URL_CHARS, false))
        .collect()
}

fn kind_list(value: &Value) -> Result<Vec<String>, PolicyError> {
    let Some(entries) = value.as_array() else {
        return Err(PolicyError::invalid("kinds must be a list"));
    };
    entries
        .iter()
        .map(|entry| match entry.as_str().filter(|k| MEDIA_KINDS.contains(k)) {
            Some(kind) => Ok(kind.to_string()),
            None => Err(PolicyError::invalid(format!(
                "kinds must be one of {}",
                MEDIA_KINDS.join(", ")
            ))),
        })
        .collect()
}

pub fn parse_policy_update(raw: &Value) -> Result<PolicyUpdate, PolicyError> {
    let map = body_object(raw, &["mode", "websites"])?;
    if map.get("mode").is_none() && map.get("websites").is_none() {
        return Err(PolicyError::invalid("Give mode or websites"));
    }
    let mut update = PolicyUpdate::default();
    if let Some(mode) = map.get("mode") {
        match mode.as_str().filter(|m| MODES.contains(m)) {
            Some(mode) => update.mode = Some(mode.to_string()),
            None => {
                return Err(PolicyError::invalid(format!(
                    "mode must be {}",
                    MODES.join(" or ")
                )))
            }
        }
    }
    if let Some(websites) = map.get("websites") {
        let websites = body_object(websites, &["readLinkedPages", "fullAccess"])?;
        if websites.get("readLinkedPages").is_none() && websites.get("fullAccess").is_none() {
            return Err(PolicyError::invalid("websites needs readLinkedPages or fullAccess"));
        }
        if let Some(flag) = websites.get("readLinkedPages") {
            match flag {
                Value::Bool(flag) => update.read_linked_pages = Some(*flag),
                _ => return Err(PolicyError::invalid("readLinkedPages must be true or false")),
            }
        }
        if let Some(flag) = websites.get("fullAccess") {
            match flag {
                Value::Bool(flag) => update.full_access = Some(*flag),
                _ => return Err(PolicyError::invalid("fullAccess must be true or false")),
            }
        }
    }
    Ok(update)
}

pub fn parse_add_source(raw: &Value) -> Result<AddSource, PolicyError> {
    let map = body_object(raw, &["name", "domains", "kinds", "homepage", "licenseNote"])?;
    let name = text(map.get("name"), "name", NAME_CHARS, false)?;
    let domains = string_list(map.get("domains"), "domains")?;
    let kinds = map.get("kinds").map(kind_list).transpose()?;
    let homepage = match map.get("homepage") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => Some(Some(text(Some(value), "homepage", URL_CHARS, false)?)),
    };
    let license_note = map
        .get("licenseNote")
        .map(|v| text(Some(v), "licenseNote", NOTE_CHARS, true))
        .transpose()?;
    Ok(AddSource {
        name,
        domains,
        kinds,
        homepage,
        license_note,
    })
}

pub fn parse_update_source(raw: &Value) -> Result<UpdateSource, PolicyError> {
    let map = body_object(raw, &["enabled", "name", "domains", "kinds", "licenseNote"])?;
    let enabled = match map.get("enabled") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Err(PolicyError::invalid("enabled must be true or false")),
    };
    Ok(UpdateSource {
        enabled,
        name: map
            .get("name")
            .map(|v| text(Some(v), "name", NAME_CHARS, false))
            .transpose()?,
        domains: map
            .get("domains")
            .map(|v| string_list(Some(v), "domains"))
            .transpose()?,
        kinds: map.get("kinds").map(kind_list).transpose()?,
        license_note: map
            .get("licenseNote")
            .map(|v| text(Some(v), "licenseNote", NOTE_CHARS, true))
            .transpose()?,
    })
}

/// `domainsOf` (store): a non-empty, bounded list, each normalized, no repeats.
fn domains_of(entries: &[String]) -> Result<Vec<String>, PolicyError> {
    if entries.is_empty() {
        return Err(PolicyError::invalid("domains must be a non-empty list"));
    }
    if entries.len() > MAX_DOMAINS_PER_SOURCE {
        return Err(PolicyError::invalid(format!(
            "A source has at most {MAX_DOMAINS_PER_SOURCE} domains"
        )));
    }
    let mut domains: Vec<String> = Vec::new();
    for entry in entries {
        let domain = normalize_domain(entry)?;
        if !domains.contains(&domain) {
            domains.push(domain);
        }
    }
    Ok(domains)
}

/// `kindsOf` for a request that named kinds: non-empty, no repeats.
fn request_kinds(kinds: &[String]) -> Result<Vec<String>, PolicyError> {
    kinds_of(&Value::from(kinds.to_vec())).ok_or_else(|| {
        PolicyError::invalid(format!(
            "kinds must be a non-empty list of {}",
            MEDIA_KINDS.join(", ")
        ))
    })
}

/// `homepageOf` (store): an http(s) address, serialized the WHATWG way.
fn homepage_of(value: &str) -> Result<String, PolicyError> {
    if let Ok(url) = url::Url::parse(value) {
        if matches!(url.scheme(), "http" | "https") {
            return Ok(url.to_string());
        }
    }
    Err(PolicyError::invalid("homepage must be an http(s) address"))
}

// ── The store ───────────────────────────────────────────────────────────────

/// The research directory: `OPENVIDS_RESEARCH_DIR`, else `~/.openvids/research`.
pub fn research_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_RESEARCH_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    super::prefs::home_dir().join(".openvids").join("research")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct PolicyStore {
    file: PathBuf,
    now: fn() -> u64,
}

impl PolicyStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            file: dir.join(POLICY_FILE),
            now: now_ms,
        }
    }

    /// The store over the default directory.
    pub fn open() -> Self {
        Self::new(&research_dir())
    }

    fn load(&self) -> Stored {
        if !self.file.exists() {
            return Stored::defaults();
        }
        let parsed = std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|raw| stored_of(&raw));
        if let Some(stored) = parsed {
            return stored;
        }
        // Best effort: the defaults are still safe.
        let mut backup = self.file.clone().into_os_string();
        backup.push(".bak");
        let _ = std::fs::copy(&self.file, PathBuf::from(backup));
        Stored::defaults()
    }

    fn save(&self, mut stored: Stored) -> Result<PolicyView, PolicyError> {
        stored.updated_at = Number::from((self.now)());
        let io = |err: std::io::Error| {
            PolicyError::new("io_error", format!("could not save the Asset Search policy: {err}"))
        };
        let mut bytes = serde_json::to_vec_pretty(&stored)
            .map_err(|err| PolicyError::new("io_error", err.to_string()))?;
        bytes.push(b'\n');
        write_private_atomic(&self.file, &bytes).map_err(io)?;
        Ok(stored.view())
    }

    pub fn get(&self) -> PolicyView {
        self.load().view()
    }

    pub fn update_policy(&self, update: &PolicyUpdate) -> Result<PolicyView, PolicyError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        if update.mode.is_none() && update.read_linked_pages.is_none() && update.full_access.is_none()
        {
            return Ok(stored.view());
        }
        if let Some(mode) = &update.mode {
            if !MODES.contains(&mode.as_str()) {
                return Err(PolicyError::invalid(format!(
                    "mode must be {}",
                    MODES.join(" or ")
                )));
            }
            stored.mode = mode.clone();
        }
        if let Some(flag) = update.read_linked_pages {
            stored.websites.read_linked_pages = flag;
        }
        if let Some(flag) = update.full_access {
            stored.websites.full_access = flag;
        }
        self.save(stored)
    }

    pub fn add_source(&self, request: &AddSource) -> Result<PolicyView, PolicyError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        let current = stored.view();
        if current.sources.len() >= MAX_SOURCES {
            return Err(PolicyError::invalid(format!(
                "There can be at most {MAX_SOURCES} trusted sources"
            )));
        }
        let name = text(Some(&Value::from(request.name.as_str())), "name", NAME_CHARS, false)?;
        let domains = domains_of(&request.domains)?;
        assert_free(&current, &domains, None)?;
        let kinds = match &request.kinds {
            None => MEDIA_KINDS.iter().map(|k| k.to_string()).collect(),
            Some(kinds) => request_kinds(kinds)?,
        };
        let license_note = match &request.license_note {
            None => String::new(),
            Some(note) => text(Some(&Value::from(note.as_str())), "licenseNote", NOTE_CHARS, true)?,
        };
        let homepage = match &request.homepage {
            None => Some(format!("https://{}", domains.first().map(String::as_str).unwrap_or(""))),
            Some(None) => None,
            Some(Some(value)) => Some(homepage_of(value)?),
        };
        stored.user_sources.push(TrustedSource {
            id: format!("src-{}", random_hex4()),
            name,
            built_in: false,
            enabled: true,
            connector: "site".into(),
            description: format!(
                "Website {}, searched through the web and read page by page.",
                domains.join(", ")
            ),
            domains,
            kinds,
            license_note,
            homepage,
        });
        self.save(stored)
    }

    pub fn update_source(&self, id: &str, request: &UpdateSource) -> Result<PolicyView, PolicyError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        let current = stored.view();
        let Some(source) = current.sources.iter().find(|s| s.id == id) else {
            return Err(unknown_source(id));
        };
        if source.built_in {
            if request.domains.is_some() || request.kinds.is_some() || request.license_note.is_some() {
                return Err(PolicyError::invalid(format!(
                    "{} is a built-in source: only enabled and name can change",
                    source.name
                )));
            }
            let before = stored.built_ins.get(id).cloned();
            let over = BuiltInOverride {
                enabled: request
                    .enabled
                    .or(before.as_ref().map(|b| b.enabled))
                    .unwrap_or(source.enabled),
                name: request
                    .name
                    .clone()
                    .or(before.and_then(|b| b.name)),
            };
            stored.built_ins.insert(id.to_string(), over);
            return self.save(stored);
        }
        let domains = request.domains.as_deref().map(domains_of).transpose()?;
        if let Some(domains) = &domains {
            assert_free(&current, domains, Some(id))?;
        }
        let kinds = request.kinds.as_deref().map(request_kinds).transpose()?;
        for entry in stored.user_sources.iter_mut().filter(|s| s.id == id) {
            if let Some(enabled) = request.enabled {
                entry.enabled = enabled;
            }
            if let Some(name) = &request.name {
                entry.name = name.clone();
            }
            if let Some(domains) = &domains {
                entry.domains = domains.clone();
            }
            if let Some(kinds) = &kinds {
                entry.kinds = kinds.clone();
            }
            if let Some(note) = &request.license_note {
                entry.license_note = note.clone();
            }
        }
        self.save(stored)
    }

    pub fn remove_source(&self, id: &str) -> Result<PolicyView, PolicyError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        if is_built_in(id) {
            if stored.removed_built_ins.iter().any(|r| r == id) {
                return Err(unknown_source(id));
            }
            stored.built_ins.remove(id);
            stored.removed_built_ins.push(id.to_string());
            return self.save(stored);
        }
        if !stored.user_sources.iter().any(|s| s.id == id) {
            return Err(unknown_source(id));
        }
        stored.user_sources.retain(|s| s.id != id);
        self.save(stored)
    }

    /// Brings every removed built-in source back, enabled and under its own name.
    pub fn restore_built_ins(&self) -> Result<PolicyView, PolicyError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        for id in std::mem::take(&mut stored.removed_built_ins) {
            stored.built_ins.remove(&id);
        }
        self.save(stored)
    }
}

fn unknown_source(id: &str) -> PolicyError {
    PolicyError::new("unknown_source", format!("No trusted source \"{id}\""))
}

/// A domain belongs to one source at a time.
fn assert_free(policy: &PolicyView, domains: &[String], ignoring: Option<&str>) -> Result<(), PolicyError> {
    for source in &policy.sources {
        if Some(source.id.as_str()) == ignoring {
            continue;
        }
        if let Some(taken) = domains.iter().find(|d| host_matches_domains(d, &source.domains)) {
            return Err(PolicyError::new(
                "conflict",
                format!("{taken} already belongs to the source \"{}\"", source.name),
            ));
        }
    }
    Ok(())
}

fn random_hex4() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("os randomness for a source id");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Temp file in the same directory (mode 0600 on Unix), then rename over the
/// target; the directory is created with mode 0700 on Unix. On Windows the
/// 0600/0700 bits do not exist: the file lives under `~/.openvids` in the user
/// profile, which already inherits the profile ACL (readable by the user,
/// SYSTEM and admins only), so no extra DACL is applied — the profile
/// inheritance is the protection, and tightening it further would risk
/// locking the user out of their own policy file.
fn write_private_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)?;
    }
    let tmp = dir.join(format!(
        "{}.{}.{}.tmp",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id(),
        random_hex4()
    ));
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, path)
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── Tests (ported from `policyStore.test.ts`) ───────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-policy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn code<T>(result: Result<T, PolicyError>) -> &'static str {
        match result {
            Err(err) => err.code,
            Ok(_) => panic!("expected a refusal"),
        }
    }

    fn add(name: &str, domains: &[&str]) -> AddSource {
        AddSource {
            name: name.into(),
            domains: domains.iter().map(|d| d.to_string()).collect(),
            kinds: None,
            homepage: None,
            license_note: None,
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn starts_in_trusted_mode_with_the_four_built_ins_and_keeps_changes_across_instances() {
        let dir = dir("start");
        let store = PolicyStore::new(&dir);
        let first = store.get();
        assert_eq!(first.mode, "trusted");
        let ids: Vec<(&str, bool, bool)> = first
            .sources
            .iter()
            .map(|s| (s.id.as_str(), s.enabled, s.built_in))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("wikimedia-commons", true, true),
                ("openverse", true, true),
                ("nasa-images", true, true),
                ("internet-archive", true, true),
            ]
        );
        // Reading never creates the file.
        assert!(!dir.join("policy.json").exists());

        store
            .update_policy(&PolicyUpdate {
                mode: Some("any".into()),
                read_linked_pages: None,
                full_access: None,
            })
            .unwrap();
        store
            .update_source(
                "openverse",
                &UpdateSource {
                    enabled: Some(false),
                    name: Some("Openverse (mine)".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let again = PolicyStore::new(&dir).get();
        assert_eq!(again.mode, "any");
        let openverse = again.sources.iter().find(|s| s.id == "openverse").unwrap();
        assert!(!openverse.enabled);
        assert_eq!(openverse.name, "Openverse (mine)");
        assert_eq!(openverse.domains, strings(&["api.openverse.org", "openverse.org"]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("policy.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn adds_a_user_website_with_normalized_domains_and_lets_everything_but_a_built_ins_domains_change() {
        let store = PolicyStore::new(&dir("add"));
        let mut request = add(
            "Pexels",
            &["https://www.Pexels.com/search/ocean/", "images.pexels.com", "pexels.com"],
        );
        request.kinds = Some(strings(&["video", "picture"]));
        let added = store.add_source(&request).unwrap();
        let source = added.sources.iter().find(|s| !s.built_in).unwrap().clone();
        assert_eq!(source.name, "Pexels");
        assert_eq!(source.connector, "site");
        assert!(source.enabled);
        assert_eq!(source.domains, strings(&["pexels.com", "images.pexels.com"]));
        assert_eq!(source.kinds, strings(&["video", "picture"]));
        assert_eq!(source.homepage.as_deref(), Some("https://pexels.com"));
        assert!(source.id.starts_with("src-") && source.id.len() == 12);
        assert!(source.id[4..].chars().all(|c| c.is_ascii_hexdigit()));

        let updated = store
            .update_source(
                &source.id,
                &UpdateSource {
                    domains: Some(strings(&["pexels.com", "videos.pexels.com"])),
                    enabled: Some(false),
                    kinds: Some(strings(&["video"])),
                    ..Default::default()
                },
            )
            .unwrap();
        let changed = updated.sources.iter().find(|s| s.id == source.id).unwrap();
        assert!(!changed.enabled);
        assert_eq!(changed.domains, strings(&["pexels.com", "videos.pexels.com"]));
        assert_eq!(changed.kinds, strings(&["video"]));

        // A built-in source's domains are fixed.
        assert_eq!(
            code(store.update_source(
                "wikimedia-commons",
                &UpdateSource {
                    domains: Some(strings(&["evil.example"])),
                    ..Default::default()
                }
            )),
            "invalid_request"
        );
        assert_eq!(
            code(store.update_source(
                "src-nope",
                &UpdateSource {
                    enabled: Some(true),
                    ..Default::default()
                }
            )),
            "unknown_source"
        );
        let removed = store.remove_source(&source.id).unwrap();
        assert!(removed.sources.iter().all(|s| s.built_in));
    }

    #[test]
    fn removes_a_built_in_for_good_until_the_user_restores_the_built_in_sources() {
        let dir = dir("restore");
        let store = PolicyStore::new(&dir);
        store
            .update_source(
                "nasa-images",
                &UpdateSource {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        let removed = store.remove_source("nasa-images").unwrap();
        assert!(removed.sources.iter().all(|s| s.id != "nasa-images"));
        assert_eq!(removed.removed_built_ins, strings(&["nasa-images"]));
        // Other updates do not bring it back.
        store
            .update_policy(&PolicyUpdate {
                mode: Some("any".into()),
                read_linked_pages: None,
                full_access: None,
            })
            .unwrap();
        assert_eq!(PolicyStore::new(&dir).get().removed_built_ins, strings(&["nasa-images"]));
        assert_eq!(code(store.remove_source("nasa-images")), "unknown_source");

        let restored = store.restore_built_ins().unwrap();
        assert!(restored.removed_built_ins.is_empty());
        let nasa = restored.sources.iter().find(|s| s.id == "nasa-images").unwrap();
        assert!(nasa.enabled);
        assert_eq!(nasa.name, "NASA Image and Video Library");
    }

    #[test]
    fn refuses_domains_that_are_not_one_organizations_website() {
        for bad in [
            "com",
            "localhost",
            "127.0.0.1",
            "192.168.1.5",
            "[::1]",
            "intranet",
            "printer.local",
            "co.uk",
            "github.io",
            "firebaseapp.com",
            "",
            "not a domain",
        ] {
            assert_eq!(code(normalize_domain(bad)), "invalid_request", "{bad}");
        }
        assert_eq!(normalize_domain("HTTP://WWW.Example.ORG:8080/path?q=1").unwrap(), "example.org");
        assert_eq!(normalize_domain("blog.example.co.uk").unwrap(), "blog.example.co.uk");
        assert_eq!(normalize_domain("www.example.org/path").unwrap(), "example.org");
        assert_eq!(normalize_domain("Example.org.").unwrap(), "example.org");
        // Internationalized names are stored as punycode, as `new URL` does.
        assert_eq!(normalize_domain("bücher.example").unwrap(), "xn--bcher-kva.example");
    }

    #[test]
    fn refuses_bad_sources_and_a_domain_another_source_owns() {
        let store = PolicyStore::new(&dir("refuse"));
        assert_eq!(
            code(store.add_source(&add("x", &["commons.wikimedia.org"]))),
            "conflict"
        );
        // A subdomain of a built-in's domain is taken too.
        assert_eq!(code(store.add_source(&add("x", &["a.archive.org"]))), "conflict");
        assert_eq!(code(store.add_source(&add("", &["a.example"]))), "invalid_request");
        assert_eq!(code(store.add_source(&add("x", &[]))), "invalid_request");
        let many: Vec<String> = (0..17).map(|i| format!("d{i}.example")).collect();
        let request = AddSource {
            domains: many,
            ..add("x", &[])
        };
        assert_eq!(code(store.add_source(&request)), "invalid_request");
        let request = AddSource {
            kinds: Some(vec![]),
            ..add("x", &["a.example"])
        };
        assert_eq!(code(store.add_source(&request)), "invalid_request");
        assert_eq!(
            code(store.add_source(&add(&"x".repeat(81), &["a.example"]))),
            "invalid_request"
        );
        let request = AddSource {
            homepage: Some(Some("ftp://a.example".into())),
            ..add("x", &["a.example"])
        };
        assert_eq!(code(store.add_source(&request)), "invalid_request");
        // The same domain twice in a request is one domain.
        let added = store.add_source(&add("Two", &["B.example", "https://www.b.example/x"])).unwrap();
        assert_eq!(added.sources.last().unwrap().domains, strings(&["b.example"]));
        // Another source cannot take it, and updating a source may keep its own.
        let id = added.sources.last().unwrap().id.clone();
        assert_eq!(code(store.add_source(&add("Three", &["b.example"]))), "conflict");
        assert!(store
            .update_source(
                &id,
                &UpdateSource {
                    domains: Some(strings(&["b.example", "c.b.example"])),
                    ..Default::default()
                }
            )
            .is_ok());
    }

    #[test]
    fn a_source_limit_applies_to_built_ins_and_user_sources_together() {
        let store = PolicyStore::new(&dir("limit"));
        for i in 0..(MAX_SOURCES - 4) {
            store.add_source(&add(&format!("s{i}"), &[&format!("s{i}.example")])).unwrap();
        }
        assert_eq!(code(store.add_source(&add("over", &["over.example"]))), "invalid_request");
    }

    #[test]
    fn falls_back_to_the_defaults_keeping_the_damaged_file_as_a_backup() {
        let dir = dir("damaged");
        let store = PolicyStore::new(&dir);
        store
            .update_policy(&PolicyUpdate {
                mode: Some("any".into()),
                read_linked_pages: None,
                full_access: None,
            })
            .unwrap();
        std::fs::write(
            dir.join("policy.json"),
            r#"{"schema":"openvids.research-policy/1","mode":"any","userSources":[{"id":"src-x","domains":["evil.example"]}]"#,
        )
        .unwrap();
        let policy = store.get();
        assert_eq!(policy.mode, "trusted");
        assert_eq!(policy.sources.len(), 4);
        let backup = std::fs::read_to_string(dir.join("policy.json.bak")).unwrap();
        assert!(backup.contains("evil.example"));

        // A structurally valid file with an unusable user source is refused as a whole too.
        std::fs::write(
            dir.join("policy.json"),
            json!({
                "schema": "openvids.research-policy/1",
                "mode": "any",
                "builtIns": {},
                "userSources": [{
                    "id": "src-x", "name": "x", "enabled": true, "domains": [5],
                    "kinds": ["video"], "description": "", "licenseNote": ""
                }],
                "removedBuiltIns": [],
                "updatedAt": 1
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(store.get().mode, "trusted");
    }

    fn stored_file(extra: Value) -> String {
        let mut base = json!({
            "schema": "openvids.research-policy/1",
            "mode": "any",
            "builtIns": {},
            "userSources": [],
            "removedBuiltIns": [],
            "updatedAt": 1
        });
        merge_into(&mut base, extra);
        base.to_string()
    }

    fn merge_into(base: &mut Value, extra: Value) {
        if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
            for (key, value) in extra {
                base.insert(key, value);
            }
        }
    }

    #[test]
    fn websites_default_to_reading_linked_pages_for_new_and_old_files() {
        let dir = dir("websites-default");
        let store = PolicyStore::new(&dir);
        let fresh = store.get().websites;
        assert!(fresh.read_linked_pages);
        assert!(!fresh.full_access);
        std::fs::write(dir.join("policy.json"), stored_file(json!({}))).unwrap();
        let old = store.get();
        assert_eq!(old.mode, "any");
        assert!(old.websites.read_linked_pages);
        assert!(!old.websites.full_access);

        // A file from before full access existed keeps its switch, with full access off.
        std::fs::write(
            dir.join("policy.json"),
            stored_file(json!({"websites": {"readLinkedPages": false}})),
        )
        .unwrap();
        let before = store.get();
        assert_eq!(before.mode, "any");
        assert!(!before.websites.read_linked_pages);
        assert!(!before.websites.full_access);
        assert!(!dir.join("policy.json.bak").exists());
    }

    #[test]
    fn the_websites_switches_survive_without_touching_the_mode_or_the_sources() {
        let dir = dir("websites-switch");
        let store = PolicyStore::new(&dir);
        store
            .update_policy(&PolicyUpdate {
                mode: Some("any".into()),
                read_linked_pages: None,
                full_access: None,
            })
            .unwrap();
        store
            .update_policy(&PolicyUpdate {
                mode: None,
                read_linked_pages: Some(false),
                full_access: Some(true),
            })
            .unwrap();
        let again = PolicyStore::new(&dir).get();
        assert_eq!(again.mode, "any");
        assert!(!again.websites.read_linked_pages);
        assert!(again.websites.full_access);
        assert_eq!(again.sources.len(), 4);
        // An update that names nothing changes nothing.
        let same = PolicyStore::new(&dir).update_policy(&PolicyUpdate::default()).unwrap();
        assert!(!same.websites.read_linked_pages);
        assert!(same.websites.full_access);
        // Changing one switch keeps the other.
        let just_full = store
            .update_policy(&PolicyUpdate {
                mode: None,
                read_linked_pages: None,
                full_access: Some(false),
            })
            .unwrap();
        assert!(!just_full.websites.read_linked_pages);
        assert!(!just_full.websites.full_access);
        let just_read = store
            .update_policy(&PolicyUpdate {
                mode: None,
                read_linked_pages: Some(true),
                full_access: None,
            })
            .unwrap();
        assert!(just_read.websites.read_linked_pages);
        assert!(!just_read.websites.full_access);
    }

    #[test]
    fn a_damaged_websites_value_replaces_the_whole_file_by_the_defaults() {
        let dir = dir("websites-damaged");
        let store = PolicyStore::new(&dir);
        std::fs::write(
            dir.join("policy.json"),
            stored_file(json!({"websites": {"readLinkedPages": "no"}})),
        )
        .unwrap();
        assert_eq!(store.get().mode, "trusted");
        assert!(dir.join("policy.json.bak").exists());

        // A present-but-non-boolean fullAccess is damaged as well.
        store
            .update_policy(&PolicyUpdate {
                mode: Some("any".into()),
                ..Default::default()
            })
            .unwrap();
        std::fs::write(
            dir.join("policy.json"),
            stored_file(json!({"websites": {"readLinkedPages": true, "fullAccess": "yes"}})),
        )
        .unwrap();
        let after = store.get();
        assert_eq!(after.mode, "trusted");
        assert!(after.websites.read_linked_pages);
        assert!(!after.websites.full_access);
    }

    #[test]
    fn reads_what_the_ts_store_writes_and_writes_what_it_reads() {
        // A file in the shape `PolicyStore` (TS) saves: pretty JSON, trailing newline.
        let dir = dir("interop");
        let file = dir.join("policy.json");
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&json!({
                "schema": "openvids.research-policy/1",
                "mode": "any",
                "builtIns": {
                    "openverse": {"enabled": false, "name": "Mine"},
                    "not-a-built-in": {"enabled": true, "name": null}
                },
                "userSources": [{
                    "id": "src-0a1b2c3d", "name": "Pexels", "builtIn": false, "enabled": true,
                    "connector": "site", "domains": ["pexels.com"], "kinds": ["video", "video", "picture"],
                    "description": "d", "licenseNote": "", "homepage": "https://pexels.com"
                }],
                "removedBuiltIns": ["nasa-images", "gone", 5],
                "websites": {"readLinkedPages": false},
                "updatedAt": 1700000000000u64
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let store = PolicyStore::new(&dir);
        let view = store.get();
        assert_eq!(view.mode, "any");
        assert_eq!(view.removed_built_ins, strings(&["nasa-images"]));
        assert!(!view.websites.read_linked_pages);
        // The TS file predates full access: it loads as off, and is written back with the key.
        assert!(!view.websites.full_access);
        assert_eq!(view.updated_at, Number::from(1_700_000_000_000u64));
        let ids: Vec<&str> = view.sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["wikimedia-commons", "openverse", "internet-archive", "src-0a1b2c3d"]);
        assert_eq!(view.sources[1].name, "Mine");
        assert!(!view.sources[1].enabled);
        assert_eq!(view.sources[3].kinds, strings(&["video", "picture"]));

        let saved = store
            .update_source(
                "src-0a1b2c3d",
                &UpdateSource {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(saved.updated_at.as_u64().unwrap() > 1_700_000_000_000);
        let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(written["schema"], "openvids.research-policy/1");
        assert_eq!(written["builtIns"], json!({"openverse": {"enabled": false, "name": "Mine"}}));
        assert_eq!(written["userSources"][0]["builtIn"], false);
        assert_eq!(written["userSources"][0]["enabled"], false);
        assert_eq!(written["removedBuiltIns"], json!(["nasa-images"]));
        assert_eq!(written["websites"], json!({"readLinkedPages": false, "fullAccess": false}));
        assert!(std::fs::read_to_string(&file).unwrap().ends_with("}\n"));
    }

    #[test]
    fn the_built_in_list_is_the_one_the_ts_store_serves() {
        // Guards the duplicated list against drift in the fields the UI shows.
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/studio-server/src/research/sources/builtins.ts"),
        );
        // The file only exists in a full checkout; a packaged build skips the check.
        let Ok(ts) = ts else { return };
        for def in &BUILT_INS {
            assert!(ts.contains(&format!("id: \"{}\"", def.id)), "{}", def.id);
            assert!(ts.contains(&format!("name: \"{}\"", def.name)), "{}", def.id);
            assert!(ts.contains(&format!("connector: \"{}\"", def.connector)), "{}", def.id);
            assert!(ts.contains(&format!("homepage: \"{}\"", def.homepage)), "{}", def.id);
            for domain in def.domains {
                assert!(ts.contains(&format!("\"{domain}\"")), "{domain}");
            }
        }
        assert_eq!(ts.matches("builtIn: true").count(), BUILT_INS.len());
    }

    #[test]
    fn the_shared_suffix_list_matches_the_ts_one() {
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/studio-server/src/research/sources/domains.ts"),
        );
        let Ok(ts) = ts else { return };
        let block = ts
            .split("new Set([")
            .nth(1)
            .and_then(|rest| rest.split("]);").next())
            .unwrap();
        let mut theirs: Vec<&str> = block.split('"').skip(1).step_by(2).collect();
        let mut ours: Vec<&str> = SHARED_SUFFIXES.to_vec();
        theirs.sort();
        ours.sort();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn request_parsing_follows_requests_ts() {
        let ok = parse_policy_update(&json!({"mode": "any", "websites": {"readLinkedPages": false}})).unwrap();
        assert_eq!(ok.mode.as_deref(), Some("any"));
        assert_eq!(ok.read_linked_pages, Some(false));
        assert_eq!(ok.full_access, None);

        // Either key alone is a valid update; nothing else may ride along.
        let full = parse_policy_update(&json!({"websites": {"fullAccess": true}})).unwrap();
        assert_eq!(full, PolicyUpdate { mode: None, read_linked_pages: None, full_access: Some(true) });
        let both =
            parse_policy_update(&json!({"websites": {"readLinkedPages": true, "fullAccess": false}}))
                .unwrap();
        assert_eq!(both.read_linked_pages, Some(true));
        assert_eq!(both.full_access, Some(false));

        for bad in [
            json!({}),
            json!([]),
            json!({"mode": "none"}),
            json!({"mode": null}),
            json!({"mode": "any", "extra": 1}),
            json!({"websites": {}}),
            json!({"websites": {"readLinkedPages": "yes"}}),
            json!({"websites": {"fullAccess": "yes"}}),
            json!({"websites": {"fullAccess": 1}}),
            json!({"websites": {"readLinkedPages": true, "x": 1}}),
            json!({"websites": 3}),
        ] {
            assert_eq!(code(parse_policy_update(&bad)), "invalid_request", "{bad}");
        }

        let add = parse_add_source(&json!({
            "name": "  Pexels ", "domains": [" pexels.com "], "kinds": ["video"],
            "homepage": null, "licenseNote": ""
        }))
        .unwrap();
        assert_eq!(add.name, "Pexels");
        assert_eq!(add.domains, strings(&["pexels.com"]));
        assert_eq!(add.homepage, Some(None));
        assert_eq!(add.license_note.as_deref(), Some(""));
        for bad in [
            json!({"domains": ["a.example"]}),
            json!({"name": "x"}),
            json!({"name": "x", "domains": "a.example"}),
            json!({"name": "x", "domains": [""]}),
            json!({"name": "x", "domains": [5]}),
            json!({"name": "x", "domains": ["a.example"], "kinds": "video"}),
            json!({"name": "x", "domains": ["a.example"], "kinds": ["gif"]}),
            json!({"name": "x", "domains": ["a.example"], "homepage": ""}),
            json!({"name": "x", "domains": ["a.example"], "licenseNote": "n".repeat(501)}),
            json!({"name": "x", "domains": ["a.example"], "id": "src-1"}),
        ] {
            assert_eq!(code(parse_add_source(&bad)), "invalid_request", "{bad}");
        }

        let update = parse_update_source(&json!({"enabled": false, "name": "N"})).unwrap();
        assert_eq!(update.enabled, Some(false));
        assert_eq!(update.name.as_deref(), Some("N"));
        assert_eq!(parse_update_source(&json!({})).unwrap(), UpdateSource::default());
        for bad in [
            json!({"enabled": "yes"}),
            json!({"enabled": null}),
            json!({"name": ""}),
            json!({"kinds": ["gif"]}),
            json!({"builtIn": true}),
        ] {
            assert_eq!(code(parse_update_source(&bad)), "invalid_request", "{bad}");
        }
    }

    #[test]
    fn homepages_are_http_addresses_serialized_like_new_url() {
        assert_eq!(homepage_of("https://pexels.com").unwrap(), "https://pexels.com/");
        assert_eq!(homepage_of("http://a.example/x?y=1").unwrap(), "http://a.example/x?y=1");
        assert_eq!(code(homepage_of("javascript:alert(1)")), "invalid_request");
        assert_eq!(code(homepage_of("not a url")), "invalid_request");
        let store = PolicyStore::new(&dir("homepage"));
        let request = AddSource {
            homepage: Some(Some("https://pexels.com".into())),
            ..add("Pexels", &["pexels.com"])
        };
        let view = store.add_source(&request).unwrap();
        assert_eq!(view.sources.last().unwrap().homepage.as_deref(), Some("https://pexels.com/"));
        let view = store
            .add_source(&AddSource {
                homepage: Some(None),
                ..add("Other", &["other.example"])
            })
            .unwrap();
        assert_eq!(view.sources.last().unwrap().homepage, None);
    }
}
