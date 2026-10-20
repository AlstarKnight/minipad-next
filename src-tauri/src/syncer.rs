//! WebDAV 同步的纯决策逻辑：不碰文件系统或网络，先保证冲突不丢数据。
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Skip,
    Upload,
    Download,
    Conflict,
    DeleteLocal,
    DeleteRemote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FirstSync {
    Merge,
    Remote,
    Local,
}

/// 哈希是文件内容摘要。None 表示这一侧不存在该文件。
pub fn decide(base: Option<&str>, local: Option<&str>, remote: Option<&str>) -> Action {
    if local == remote {
        return Action::Skip;
    }
    if let Some(previous) = base {
        if local == Some(previous) {
            return if remote.is_some() {
                Action::Download
            } else {
                Action::DeleteLocal
            };
        }
        if remote == Some(previous) {
            return if local.is_some() {
                Action::Upload
            } else {
                Action::DeleteRemote
            };
        }
        // 其中一端删除、另一端有修改，优先恢复保留修改的文件。
        return match (local, remote) {
            (None, Some(_)) => Action::Download,
            (Some(_), None) => Action::Upload,
            (Some(_), Some(_)) => Action::Conflict,
            (None, None) => Action::Skip,
        };
    }
    match (local, remote) {
        (Some(_), None) => Action::Upload,
        (None, Some(_)) => Action::Download,
        (Some(_), Some(_)) => Action::Conflict,
        (None, None) => Action::Skip,
    }
}

/// 首次同步单独处理，禁止把初次没有记录误判成删除。
pub fn first_sync(local: Option<&str>, remote: Option<&str>, mode: FirstSync) -> Action {
    if local == remote {
        return Action::Skip;
    }
    match mode {
        FirstSync::Merge => decide(None, local, remote),
        FirstSync::Remote => match remote {
            Some(_) => Action::Download,
            None if local.is_some() => Action::DeleteLocal,
            None => Action::Skip,
        },
        FirstSync::Local => match local {
            Some(_) => Action::Upload,
            None if remote.is_some() => Action::DeleteRemote,
            None => Action::Skip,
        },
    }
}

#[cfg(test)]
pub fn deletion_needs_confirmation(delete_count: usize, all_pages: usize) -> bool {
    deletion_needs_confirmation_with(delete_count, all_pages, 20, 3)
}

pub fn deletion_needs_confirmation_with(
    delete_count: usize,
    all_pages: usize,
    limit: usize,
    divisor: usize,
) -> bool {
    delete_count > limit || (all_pages > 0 && delete_count.saturating_mul(divisor) > all_pages)
}

/// 保留 .md、笔记本元数据和选中的图片；只允许一层笔记本子目录。
pub fn should_sync(path: &str, images: bool) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.is_empty()
        || parts.len() > 3
        || parts.iter().any(|p| {
            p.is_empty() || *p == "." || *p == ".." || p.starts_with('.') && *p != ".minipad.json"
        })
        || path.contains('\\')
    {
        return false;
    }
    match parts.as_slice() {
        [name] => name.ends_with(".md") || *name == ".minipad.json",
        [folder, name] if *folder == "assets" => images && !name.starts_with('.'),
        [book, name] => !book.is_empty() && (name.ends_with(".md") || *name == ".minipad.json"),
        [book, dir, name] => images && !book.is_empty() && *dir == "assets" && !name.is_empty(),
        _ => false,
    }
}

/// 一次快照对比每个文件只产生一次操作，按文件名稳定排序。
pub fn plan<'a>(
    base: &'a BTreeMap<String, String>,
    local: &'a BTreeMap<String, String>,
    remote: &'a BTreeMap<String, String>,
    mode: FirstSync,
    first_run: bool,
) -> Vec<(String, Action)> {
    let paths: BTreeSet<_> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    paths
        .into_iter()
        .map(|path| {
            let l = local.get(path).map(String::as_str);
            let r = remote.get(path).map(String::as_str);
            let action = if first_run {
                first_sync(l, r, mode)
            } else {
                decide(base.get(path).map(String::as_str), l, r)
            };
            (path.clone(), action)
        })
        .collect()
}

/// 笔记本元数据按字段三方合并。当前页和阅读/编辑模式只留在本机。
/// 同一字段两边都更改且值不同时返回冲突，调用方必须留副本。
pub fn merge_metadata(
    base: Option<&serde_json::Value>,
    local: &serde_json::Value,
    remote: &serde_json::Value,
) -> Result<(serde_json::Value, Vec<String>), Vec<String>> {
    use serde_json::{Map, Value};
    let (Some(l), Some(r)) = (local.as_object(), remote.as_object()) else {
        return Err(vec![".minipad.json 不是对象".into()]);
    };
    let before = base.and_then(Value::as_object);
    let mut output: Map<String, Value> = l.clone();
    let mut conflicts = Vec::new();
    let keys: BTreeSet<_> = l.keys().chain(r.keys()).collect();
    for key in keys {
        if matches!(key.as_str(), "active" | "modes" | "current_book") {
            continue;
        }
        let lv = l.get(key);
        let rv = r.get(key);
        let bv = before.and_then(|m| m.get(key));
        if lv == rv {
            continue;
        }
        let result = if lv == bv {
            rv
        } else if rv == bv {
            lv
        } else {
            conflicts.push(key.clone());
            continue;
        };
        match result {
            Some(value) => {
                output.insert(key.clone(), value.clone());
            }
            None => {
                output.remove(key);
            }
        }
    }
    Ok((Value::Object(output), conflicts))
}

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 同步下载和页面保存共用此锁，避免同一文件并发改写。
pub static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 后台网络同步排队执行，防止多个触发器同时改写笔记和同步状态。
pub static RUN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Default)]
pub struct WebdavStatus {
    pub state: String,
    pub last_time: String,
    pub message: String,
    pub history: Vec<String>,
}

static STATUS: std::sync::OnceLock<Mutex<WebdavStatus>> = std::sync::OnceLock::new();

fn status_store() -> &'static Mutex<WebdavStatus> {
    STATUS.get_or_init(|| Mutex::new(WebdavStatus::default()))
}

pub fn status() -> WebdavStatus {
    status_store().lock().unwrap().clone()
}

pub fn update_status(state: &str, message: &str) {
    let mut current = status_store().lock().unwrap();
    current.state = state.into();
    current.message = message.into();
    if state != "syncing" {
        let time = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        if matches!(state, "synced" | "conflict") {
            current.last_time = time.clone();
        }
        current.history.insert(0, format!("{time} {message}"));
        current.history.truncate(50);
    }
}

/// 同步记录只含路径、哈希和远程版本信息，绝不储存密码或认证头。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct FileRecord {
    pub hash: String,
    pub etag: Option<String>,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub base_metadata: Option<serde_json::Value>,
    pub local_size: Option<u64>,
    pub local_modified_ns: Option<u128>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Journal {
    pub files: BTreeMap<String, FileRecord>,
    /// 首次同步失败后沿用最初的选择，防止后续文件改成普通三方比较。
    pub initial_mode: Option<FirstSync>,
}

/// 每个 WebDAV 账号和远程文件夹拥有独立的本地同步状态。
pub fn journal_path(data_dir: &Path, server: &str, user: &str, folder: &str) -> PathBuf {
    let identity = format!("{server}\n{user}\n{folder}");
    let digest = Sha256::digest(identity.as_bytes());
    data_dir.join(format!("webdav-{:x}.json", digest))
}

/// 记录同时绑定本地笔记根目录，换目录时不会误认为大量文件被删除。
pub fn journal_path_for_root(
    data_dir: &Path,
    root: &Path,
    server: &str,
    user: &str,
    folder: &str,
) -> PathBuf {
    let identity = format!(
        "{}\n{}\n{}\n{}",
        server,
        user,
        folder,
        root.to_string_lossy()
    );
    let digest = Sha256::digest(identity.as_bytes());
    data_dir.join(format!("webdav-{:x}.json", digest))
}

pub fn read_journal(path: &Path) -> Result<(Journal, bool), String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let journal: Journal = serde_json::from_str(&raw)
                .map_err(|e| format!("同步记录损坏，已停止同步以保护笔记：{e}"))?;
            let first_run = journal.initial_mode.is_some();
            Ok((journal, first_run))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((Journal::default(), true)),
        Err(e) => Err(format!("无法读取同步记录：{e}")),
    }
}

pub fn save_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let data = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    crate::notes::write_atomic(path, &data)
}

/// 大小和修改时间均未改变时可以沿用上次的哈希；无法取得时间时重新读取。
fn local_stamp(path: &Path) -> Option<(u64, u128)> {
    let meta = fs::metadata(path).ok()?;
    let nanos = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((meta.len(), nanos))
}

fn stamp_record(root: &Path, path: &str, mut record: FileRecord) -> FileRecord {
    if let Some((size, modified)) = local_stamp(&root.join(path)) {
        record.local_size = Some(size);
        record.local_modified_ns = Some(modified);
    }
    record
}

/// 本机按与 WebDAV 一致的白名单扫描，拒绝符号链接和超出笔记本层级的目录。
#[cfg(test)]
pub fn local_files(root: &Path, images: bool) -> Result<BTreeMap<String, String>, String> {
    local_files_cached(root, images, None)
}

fn local_files_cached(
    root: &Path,
    images: bool,
    journal: Option<&Journal>,
) -> Result<BTreeMap<String, String>, String> {
    fn scan(
        folder: &Path,
        prefix: &str,
        images: bool,
        depth: usize,
        result: &mut BTreeMap<String, String>,
        journal: Option<&Journal>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(folder).map_err(|e| format!("扫描笔记失败：{e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{}", name)
            };
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_file() && should_sync(&path, images) {
                let old = journal.and_then(|j| j.files.get(&path));
                let hash = match (old, local_stamp(&entry.path())) {
                    (Some(old), Some((size, mtime)))
                        if old.local_size == Some(size) && old.local_modified_ns == Some(mtime) =>
                    {
                        old.hash.clone()
                    }
                    _ => {
                        let bytes = fs::read(entry.path())
                            .map_err(|e| format!("读取待同步文件「{path}」失败：{e}"))?;
                        content_hash(&path, &bytes)
                    }
                };
                result.insert(path.clone(), hash);
            } else if kind.is_dir()
                && depth < 2
                && !name.starts_with('.')
                && (depth == 0 || name == "assets" && images)
            {
                scan(&entry.path(), &path, images, depth + 1, result, journal)?;
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    scan(root, "", images, 0, &mut files, journal)?;
    Ok(files)
}

/// 导航状态属于设备自身，不参加远端对比，也不引发无意义上传。
pub fn content_hash(path: &str, bytes: &[u8]) -> String {
    if path.ends_with(".minipad.json") {
        if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) {
            if let Some(meta) = value.as_object_mut() {
                for local in ["active", "modes", "current_book"] {
                    meta.remove(local);
                }
                if let Ok(shared) = serde_json::to_vec(&value) {
                    return format!("{:x}", Sha256::digest(shared));
                }
            }
        }
    }
    format!("{:x}", Sha256::digest(bytes))
}

use crate::webdav::{RemoteEntry, WebdavClient};

#[derive(Clone, Debug)]
pub struct RemoteFile {
    pub entry: RemoteEntry,
    pub hash: String,
    pub downloaded: Option<Vec<u8>>,
}

fn unchanged_remote(entry: &RemoteEntry, old: &FileRecord) -> bool {
    if let (Some(current), Some(previous)) = (&entry.etag, &old.etag) {
        return current == previous;
    }
    entry.etag.is_none()
        && old.etag.is_none()
        && (entry.size.is_some() || entry.modified.is_some())
        && entry.size == old.size
        && entry.modified == old.modified
}

/// 远端仅逐层请求 Depth:1；ETag 未变时沿用上次的内容哈希。
pub fn remote_files(
    client: &WebdavClient,
    images: bool,
    journal: &Journal,
) -> Result<BTreeMap<String, RemoteFile>, String> {
    let mut entries = Vec::new();
    let roots = match client.list("") {
        Ok(entries) => entries,
        Err(message) if message.contains("HTTP 404") => {
            client.mkcol("")?;
            client.list("")?
        }
        Err(message) => return Err(message),
    };
    for (path, entry) in roots {
        if entry.directory {
            let book = path.trim_end_matches('/');
            if book.is_empty() || book.starts_with('.') || book.contains('/') {
                continue;
            }
            for (child, item) in client.list(&path)? {
                if item.directory {
                    if child == format!("{path}assets/") && images {
                        entries.extend(client.list(&child)?);
                    }
                } else {
                    entries.push((child, item));
                }
            }
        } else {
            entries.push((path, entry));
        }
    }
    let mut files = BTreeMap::new();
    for (path, entry) in entries {
        if !should_sync(&path, images) || entry.directory {
            continue;
        }
        let (hash, downloaded) = match journal.files.get(&path) {
            Some(old) if unchanged_remote(&entry, old) => (old.hash.clone(), None),
            _ => {
                let (bytes, _) = client.get(&path)?;
                (content_hash(&path, &bytes), Some(bytes))
            }
        };
        files.insert(
            path,
            RemoteFile {
                entry,
                hash,
                downloaded,
            },
        );
    }
    Ok(files)
}

fn remote_content(
    client: &WebdavClient,
    path: &str,
    remote: &mut RemoteFile,
) -> Result<(Vec<u8>, Option<String>), String> {
    match remote.downloaded.take() {
        Some(bytes) => Ok((bytes, remote.entry.etag.clone())),
        None => client.get(path),
    }
}

pub fn remote_hashes(files: &BTreeMap<String, RemoteFile>) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|(path, info)| (path.clone(), info.hash.clone()))
        .collect()
}

#[derive(Clone, Debug)]
pub struct SyncOptions {
    pub images: bool,
    pub first_mode: FirstSync,
    pub conflict_copy: bool,
    pub confirm_deletes: bool,
    pub delete_limit: usize,
    pub delete_divisor: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub changed: Vec<String>,
    pub rescan_needed: bool,
}

/// 删除前先进行完整规划，超过保护阈值一律不碰本地或远端文件。
pub fn preview_actions(
    journal: &Journal,
    local: &BTreeMap<String, String>,
    remote: &BTreeMap<String, RemoteFile>,
    mode: FirstSync,
    first: bool,
) -> (Vec<(String, Action)>, usize, usize) {
    let before = journal
        .files
        .iter()
        .map(|(p, record)| (p.clone(), record.hash.clone()))
        .collect::<BTreeMap<_, _>>();
    let distant = remote_hashes(remote);
    let actions = plan(&before, local, &distant, mode, first);
    let deletes = actions
        .iter()
        .filter(|(path, action)| {
            path.ends_with(".md") && matches!(action, Action::DeleteLocal | Action::DeleteRemote)
        })
        .count();
    let pages = local
        .keys()
        .chain(remote.keys())
        .filter(|path| path.ends_with(".md"))
        .collect::<BTreeSet<_>>()
        .len();
    (actions, deletes, pages)
}

/// 只提取用于跨设备同步的 .minipad.json 字段，其余导航信息保留设备本地。
fn shared_metadata(path: &str, data: &[u8]) -> Option<serde_json::Value> {
    if !path.ends_with(".minipad.json") {
        return None;
    }
    let mut meta = serde_json::from_slice::<serde_json::Value>(data).ok()?;
    let object = meta.as_object_mut()?;
    for key in ["active", "modes", "current_book"] {
        object.remove(key);
    }
    Some(meta)
}

fn preserve_navigation(local: &[u8], remote: &[u8]) -> Result<Vec<u8>, String> {
    let Ok(mut incoming) = serde_json::from_slice::<serde_json::Value>(remote) else {
        return Err("远端笔记本信息不是合法 JSON，已停止下载".into());
    };
    let current = serde_json::from_slice::<serde_json::Value>(local).ok();
    if let Some(object) = incoming.as_object_mut() {
        for key in ["active", "modes", "current_book"] {
            match current.as_ref().and_then(|v| v.get(key)) {
                Some(value) => {
                    object.insert(key.into(), value.clone());
                }
                None => {
                    object.remove(key);
                }
            }
        }
    } else {
        return Err("远端笔记本信息格式错误，已停止下载".into());
    }
    serde_json::to_vec_pretty(&incoming).map_err(|e| e.to_string())
}

fn check_local(root: &Path, path: &str, expected: Option<&str>) -> Result<Vec<u8>, String> {
    let file = root.join(path);
    let bytes = match fs::read(file) {
        Ok(_) if expected.is_none() => {
            return Err(format!("「{path}」在扫描后新建，拒绝覆盖"));
        }
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && expected.is_none() => Vec::new(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("「{path}」在扫描后被删除，留到下一轮同步"));
        }
        Err(e) => return Err(format!("重新读取文件「{path}」失败：{e}")),
    };
    if expected.is_some() && Some(content_hash(path, &bytes).as_str()) != expected {
        return Err(format!("「{path}」在扫描后被修改，留到下一轮同步"));
    }
    Ok(bytes)
}

fn ensure_parent(client: &WebdavClient, path: &str) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut dir = String::new();
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        dir.push_str(part);
        dir.push('/');
        client.mkcol(&dir)?;
    }
    Ok(())
}

fn unique_conflict_path(root: &Path, path: &str) -> Result<String, String> {
    let (folder, name) = match path.rsplit_once('/') {
        Some((folder, name)) => (format!("{folder}/"), name),
        None => (String::new(), path),
    };
    let (stem, ext) = name.rsplit_once('.').ok_or("文件名无扩展名")?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M").to_string();
    for attempt in 0..100 {
        let extra = if attempt == 0 {
            String::new()
        } else {
            format!(" ({attempt})")
        };
        let candidate = format!(
            "{}{}{}.{}",
            folder,
            crate::notes::conflict_name(stem, &stamp),
            extra,
            ext
        );
        if !root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err("冲突副本名称已用尽，取消覆盖".into())
}

/// 回收站保留文件内容；Markdown 使用现有的页面回收站格式。
fn local_trash(root: &Path, path: &str) -> Result<(), String> {
    if path.ends_with(".md") {
        let (book, filename) = path.rsplit_once('/').unwrap_or(("", path));
        let name = filename.strip_suffix(".md").ok_or("页面格式错误")?;
        return crate::notes::move_to_trash(root, book, name);
    }
    let target = root.join(path);
    if !target.exists() {
        return Ok(());
    }
    let stamp = chrono::Utc::now().timestamp();
    let (folder, filename) = path.rsplit_once('/').unwrap_or(("", path));
    let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, ""));
    let base = root.join(".trash").join(".webdav").join(folder);
    fs::create_dir_all(&base).map_err(|e| format!("创建同步回收站失败：{e}"))?;
    for attempt in 0..100 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!(" ({})", attempt + 1)
        };
        let saved = if ext.is_empty() {
            format!("{stem}.{stamp}{suffix}")
        } else {
            format!("{stem}.{stamp}{suffix}.{ext}")
        };
        let dest = base.join(saved);
        if !dest.exists() {
            return fs::rename(target, dest).map_err(|e| format!("移动文件到回收站失败：{e}"));
        }
    }
    Err("同步回收站存在大量重名文件，请先整理".into())
}

/// 同一字段被双端修改时先在本机留下远端元数据完整副本，再使用本机版本。
fn backup_metadata_conflict(root: &Path, path: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().timestamp();
    let folder = path.rsplit_once('/').map(|(book, _)| book).unwrap_or("");
    let archive = root.join(".trash").join(".webdav").join(folder);
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
    for attempt in 0..100 {
        let name = if attempt == 0 {
            format!(".minipad.{stamp}.json")
        } else {
            format!(".minipad.{stamp} ({}).json", attempt + 1)
        };
        let saved = archive.join(name);
        if !saved.exists() {
            crate::notes::write_atomic_bytes(&saved, bytes)?;
            return Ok(saved);
        }
    }
    Err("同步元数据冲突副本过多，请先整理回收站".into())
}

fn record_for(
    path: &str,
    bytes: &[u8],
    etag: Option<String>,
    size: Option<u64>,
    modified: Option<String>,
) -> FileRecord {
    FileRecord {
        hash: content_hash(path, bytes),
        etag,
        size,
        modified,
        base_metadata: shared_metadata(path, bytes),
        local_size: None,
        local_modified_ns: None,
    }
}

/// PUT 成功后记录远端版本；如果本机这时已变，下一轮必须重新读取本地。
fn finish_upload(
    root: &Path,
    path: &str,
    scanned_hash: &str,
    original: &[u8],
    uploaded: &[u8],
    etag: Option<String>,
) -> Result<(FileRecord, bool, bool), String> {
    let _lock = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let replaced = uploaded != original;
    match check_local(root, path, Some(scanned_hash)) {
        Ok(_) => {
            if replaced {
                crate::notes::write_atomic_bytes(&root.join(path), uploaded)?;
            }
            let record = record_for(path, uploaded, etag, Some(uploaded.len() as u64), None);
            Ok((stamp_record(root, path, record), false, replaced))
        }
        // 合并后的笔记本信息没能写回本机：以合并前的本机内容为基准、不记 ETag，
        // 下一轮重新读取网盘再合并，网盘那边改的字段不会被本机的新版本盖掉。
        Err(message) if message.contains("在扫描后") && replaced => {
            Ok((record_for(path, original, None, None, None), true, false))
        }
        Err(message) if message.contains("在扫描后") => Ok((
            record_for(path, uploaded, etag, Some(uploaded.len() as u64), None),
            true,
            false,
        )),
        Err(message) => Err(message),
    }
}

/// WebDAV 在后台线程调用，所有远程冲突用条件请求保护，所有本地修改用写锁和扫描后复查保护。
pub fn sync_once(
    client: &WebdavClient,
    root: &Path,
    journal_file: &Path,
    options: &SyncOptions,
    backup_first: impl FnOnce() -> Result<(), String>,
) -> Result<SyncReport, String> {
    let (mut journal, first) = read_journal(journal_file)?;
    let previous_books: BTreeSet<String> = journal
        .files
        .keys()
        .filter_map(|p| p.split_once('/').map(|(book, _)| book.to_string()))
        .filter(|book| book != "assets")
        .collect();
    let mode = journal.initial_mode.unwrap_or(options.first_mode);
    let local = local_files_cached(root, options.images, Some(&journal))?;
    let mut remote = remote_files(client, options.images, &journal)?;
    let (actions, deletes, total) = preview_actions(&journal, &local, &remote, mode, first);
    if !options.confirm_deletes
        && deletion_needs_confirmation_with(
            deletes,
            total,
            options.delete_limit,
            options.delete_divisor,
        )
    {
        let local_count = actions
            .iter()
            .filter(|(p, a)| p.ends_with(".md") && *a == Action::DeleteLocal)
            .count();
        let remote_count = actions
            .iter()
            .filter(|(p, a)| p.ends_with(".md") && *a == Action::DeleteRemote)
            .count();
        return Err(format!(
            "WEB_DAV_CONFIRM_DELETE:{deletes}:{total}:{local_count}:{remote_count}"
        ));
    }
    if first {
        backup_first()?;
        journal.initial_mode = Some(mode);
        save_journal(journal_file, &journal)?;
    }
    let mut report = SyncReport::default();
    // 保存与网络同步可能同时发生；文件变化只跳过当前项。
    macro_rules! checked_local {
        ($path:expr, $expected:expr) => {
            match check_local(root, $path, $expected) {
                Ok(bytes) => bytes,
                Err(message) if message.contains("在扫描后") => {
                    report.rescan_needed = true;
                    continue;
                }
                Err(message) => return Err(message),
            }
        };
    }
    let mut created_dirs: BTreeSet<String> = remote
        .keys()
        .filter_map(|path| path.rsplit_once('/').map(|(folder, _)| folder.to_string()))
        .collect();
    for (path, action) in actions {
        let local_hash = local.get(&path).map(String::as_str);
        let mut remote_file = remote.get_mut(&path);
        let prior = journal.files.get(&path).cloned();
        match action {
            Action::Skip => {
                if let Some(info) = remote_file {
                    if let Some(hash) = local_hash {
                        let cached_stamp = prior
                            .as_ref()
                            .and_then(|old| old.local_size.zip(old.local_modified_ns));
                        let stamp_at_action = local_stamp(&root.join(&path));
                        let record = if cached_stamp.is_some() && cached_stamp == stamp_at_action {
                            let mut old = prior.clone().unwrap();
                            old.hash = hash.to_string();
                            old.etag = info.entry.etag.clone();
                            old.size = info.entry.size;
                            old.modified = info.entry.modified.clone();
                            old
                        } else {
                            let local_data = checked_local!(&path, Some(hash));
                            if local_stamp(&root.join(&path)) != stamp_at_action {
                                report.rescan_needed = true;
                                continue;
                            }
                            stamp_record(
                                root,
                                &path,
                                record_for(
                                    &path,
                                    &local_data,
                                    info.entry.etag.clone(),
                                    info.entry.size,
                                    info.entry.modified.clone(),
                                ),
                            )
                        };
                        journal.files.insert(path.clone(), record);
                    }
                } else {
                    journal.files.remove(&path);
                }
            }
            Action::Upload | Action::Conflict => {
                let hash = local_hash.ok_or("上传时文件已不存在")?;
                let local_data = checked_local!(&path, Some(hash));
                let mut upload = local_data.clone();
                if first && mode == FirstSync::Local && action == Action::Upload {
                    if let Some(previous) = remote_file.as_deref_mut() {
                        let (old_bytes, _) = remote_content(client, &path, previous)?;
                        if content_hash(&path, &old_bytes) != previous.hash {
                            return Err(format!("「{path}」在同步期间再次修改，请重试"));
                        }
                        client.mkcol(".trash/")?;
                        let stamp = chrono::Utc::now().timestamp_millis();
                        let filename = path.replace('/', "_");
                        let destination = match filename.rsplit_once('.') {
                            Some((stem, ext)) => format!(".trash/{stem}.{stamp}.{ext}"),
                            None => format!(".trash/{filename}.{stamp}"),
                        };
                        client.move_file(&path, &destination, &previous.entry)?;
                    }
                }
                if action == Action::Conflict {
                    let previous = remote_file.as_deref_mut().ok_or("冲突时远端文件不存在")?;
                    let (remote_data, _) = remote_content(client, &path, previous)?;
                    if content_hash(&path, &remote_data) != previous.hash {
                        return Err(format!("「{path}」在同步期间再次修改，请重试"));
                    }
                    if path.ends_with(".minipad.json") {
                        let ours: serde_json::Value = serde_json::from_slice(&local_data)
                            .map_err(|_| "本地笔记本信息 JSON 损坏")?;
                        let theirs: serde_json::Value = serde_json::from_slice(&remote_data)
                            .map_err(|_| "远端笔记本信息 JSON 损坏")?;
                        let base = journal
                            .files
                            .get(&path)
                            .and_then(|entry| entry.base_metadata.as_ref());
                        match merge_metadata(base, &ours, &theirs) {
                            Ok((merged, conflicts)) => {
                                upload = serde_json::to_vec_pretty(&merged)
                                    .map_err(|e| e.to_string())?;
                                if !conflicts.is_empty() && options.conflict_copy {
                                    backup_metadata_conflict(root, &path, &remote_data)?;
                                    report.conflicts += 1;
                                    report.changed.push(path.clone());
                                }
                            }
                            Err(_) if options.conflict_copy => {
                                backup_metadata_conflict(root, &path, &remote_data)?;
                                report.conflicts += 1;
                            }
                            Err(_) => {}
                        }
                    } else if options.conflict_copy {
                        let conflict = unique_conflict_path(root, &path)?;
                        ensure_parent(client, &conflict)?;
                        client.put(&conflict, remote_data.clone(), None)?;
                        {
                            let _lock = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
                            if root.join(&conflict).exists() {
                                return Err("冲突副本重名，停止覆盖".into());
                            }
                            crate::notes::write_atomic_bytes(&root.join(&conflict), &remote_data)?;
                        }
                        report.changed.push(conflict);
                        report.conflicts += 1;
                    }
                }
                if created_dirs.insert(
                    path.rsplit_once('/')
                        .map(|(p, _)| p)
                        .unwrap_or("")
                        .to_string(),
                ) {
                    ensure_parent(client, &path)?;
                }
                // 只有真实存在的远端文件才允许 If-Match/If-Unmodified-Since。
                let etag = client.put(
                    &path,
                    upload.clone(),
                    if first && mode == FirstSync::Local {
                        None
                    } else {
                        remote_file.as_deref().map(|f| &f.entry)
                    },
                )?;
                let (record, needs_rescan, replaced) =
                    finish_upload(root, &path, hash, &local_data, &upload, etag)?;
                if needs_rescan {
                    report.rescan_needed = true;
                }
                if replaced {
                    report.changed.push(path.clone());
                }
                journal.files.insert(path.clone(), record);
                report.uploaded += 1;
            }
            Action::Download => {
                let info = remote_file.ok_or("下载时远端文件不存在")?;
                let (received, etag) = remote_content(client, &path, info)?;
                if content_hash(&path, &received) != info.hash {
                    return Err(format!("「{path}」在下载期间变化，稍后重试"));
                }
                let _lock = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
                let current = checked_local!(&path, local_hash);
                let bytes = if path.ends_with(".minipad.json") && local_hash.is_some() {
                    preserve_navigation(&current, &received)?
                } else {
                    received.clone()
                };
                if first && mode == FirstSync::Remote && local_hash.is_some() {
                    local_trash(root, &path)?;
                }
                crate::notes::write_atomic_bytes(&root.join(&path), &bytes)?;
                journal.files.insert(
                    path.clone(),
                    stamp_record(
                        root,
                        &path,
                        record_for(
                            &path,
                            &bytes,
                            etag.or_else(|| info.entry.etag.clone()),
                            info.entry.size,
                            info.entry.modified.clone(),
                        ),
                    ),
                );
                report.changed.push(path.clone());
                report.downloaded += 1;
            }
            Action::DeleteLocal => {
                let _lock = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
                checked_local!(&path, local_hash);
                local_trash(root, &path)?;
                journal.files.remove(&path);
                report.changed.push(path.clone());
                report.deleted += 1;
            }
            Action::DeleteRemote => {
                let info = remote_file.ok_or("远端文件已不存在")?;
                checked_local!(&path, None);
                let (contents, _) = remote_content(client, &path, info)?;
                if content_hash(&path, &contents) != info.hash {
                    return Err(format!("「{path}」在删除前已被别处修改，停止删除"));
                }
                client.mkcol(".trash/")?;
                let id = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos();
                let filename = path.replace('/', "_");
                let destination = match filename.rsplit_once('.') {
                    Some((stem, ext)) => format!(".trash/{stem}.{id}.{ext}"),
                    None => format!(".trash/{filename}.{id}"),
                };
                client.move_file(&path, &destination, &info.entry)?;
                journal.files.remove(&path);
                report.deleted += 1;
            }
        }
        if action != Action::Skip || prior.as_ref() != journal.files.get(&path) {
            save_journal(journal_file, &journal)?;
        }
    }
    if !first && !report.rescan_needed {
        for book in previous_books {
            let prefix = format!("{book}/");
            if remote.keys().any(|path| path.starts_with(&prefix))
                || journal.files.keys().any(|path| path.starts_with(&prefix))
            {
                continue;
            }
            let dir = root.join(&book);
            if !dir.is_dir()
                || fs::read_dir(&dir).map_err(|e| e.to_string())?.any(|entry| {
                    entry.is_ok_and(|e| {
                        e.file_type().is_ok_and(|t| {
                            t.is_file() && e.path().extension().is_some_and(|ext| ext == "md")
                        })
                    })
                })
            {
                continue;
            }
            crate::notes::delete_book(root, &book)?;
            report.changed.push(format!("{book}/"));
        }
    }
    if first {
        // 首次优先模式只应用一轮；补扫时按普通三方比较保留新页面。
        journal.initial_mode = None;
        save_journal(journal_file, &journal)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_version_is_reused_only_when_etag_or_fallback_matches() {
        let old = FileRecord {
            hash: "hash".into(),
            etag: Some("v1".into()),
            size: Some(12),
            modified: Some("Mon".into()),
            base_metadata: None,
            ..FileRecord::default()
        };
        let mut entry = RemoteEntry {
            href: "/notes/a.md".into(),
            etag: Some("v1".into()),
            size: Some(12),
            modified: Some("Tue".into()),
            directory: false,
        };
        assert!(unchanged_remote(&entry, &old));
        entry.etag = Some("v2".into());
        assert!(!unchanged_remote(&entry, &old));
        entry.etag = None;
        assert!(!unchanged_remote(&entry, &old));
        let old_no_etag = FileRecord { etag: None, ..old };
        entry.modified = Some("Mon".into());
        assert!(unchanged_remote(&entry, &old_no_etag));
    }

    #[test]
    fn journals_are_isolated_and_corruption_never_resets_deletion_history() {
        let root = crate::notes::temp_dir("webdav-journal");
        let a = journal_path(&root, "https://one.example", "me", "/MinipadNext/");
        let b = journal_path(&root, "https://one.example", "other", "/MinipadNext/");
        assert_ne!(a, b);
        assert!(read_journal(&a).unwrap().1);
        let journal = Journal {
            files: BTreeMap::from([(
                "页面.md".into(),
                FileRecord {
                    hash: "abc".into(),
                    ..FileRecord::default()
                },
            )]),
            initial_mode: None,
        };
        save_journal(&a, &journal).unwrap();
        assert_eq!(read_journal(&a).unwrap().0.files, journal.files);
        fs::write(&a, "not json").unwrap();
        assert!(read_journal(&a).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changing_notes_root_starts_a_new_sync_history() {
        let root = crate::notes::temp_dir("webdav-roots");
        let a = journal_path_for_root(
            &root,
            &root.join("notes-a"),
            "https://one.example",
            "me",
            "/",
        );
        let b = journal_path_for_root(
            &root,
            &root.join("notes-b"),
            "https://one.example",
            "me",
            "/",
        );
        save_journal(&a, &Journal::default()).unwrap();
        assert_ne!(a, b);
        assert!(read_journal(&b).unwrap().1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upload_completed_after_local_edit_is_next_planned_as_upload() {
        let root = crate::notes::temp_dir("webdav-upload-rebase");
        let original = b"before";
        let uploaded = b"before";
        let newer = b"edited while uploading";
        fs::write(root.join("page.md"), original).unwrap();
        let hash = content_hash("page.md", original);
        fs::write(root.join("page.md"), newer).unwrap();
        let (record, rescan, replaced) = finish_upload(
            &root,
            "page.md",
            &hash,
            original,
            uploaded,
            Some("new-etag".into()),
        )
        .unwrap();
        assert!(rescan);
        assert!(!replaced);
        assert_eq!(record.hash, hash);
        assert_eq!(record.etag.as_deref(), Some("new-etag"));
        assert_eq!(record.local_size, None);
        assert_eq!(record.local_modified_ns, None);
        assert_eq!(
            decide(
                Some(&record.hash),
                Some(&content_hash("page.md", newer)),
                Some(&record.hash),
            ),
            Action::Upload
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merged_metadata_not_written_back_keeps_remote_changes_for_next_merge() {
        use serde_json::json;
        let root = crate::notes::temp_dir("webdav-upload-merged-meta");
        let path = ".minipad.json";
        let original = br#"{"order":["a","b"],"icon":"book"}"#;
        let merged = br#"{"order":["a","b"],"icon":"star"}"#;
        let newer = br#"{"order":["a","b","c"],"icon":"book"}"#;
        fs::write(root.join(path), newer).unwrap();
        let (record, rescan, replaced) = finish_upload(
            &root,
            path,
            &content_hash(path, original),
            original,
            merged,
            Some("merged-etag".into()),
        )
        .unwrap();
        assert!(rescan);
        assert!(!replaced);
        assert_eq!(fs::read(root.join(path)).unwrap(), newer);
        assert_eq!(record.hash, content_hash(path, original));
        assert_eq!(record.etag, None);
        let entry = RemoteEntry {
            href: "/notes/.minipad.json".into(),
            etag: Some("merged-etag".into()),
            size: Some(merged.len() as u64),
            modified: None,
            directory: false,
        };
        assert!(!unchanged_remote(&entry, &record));
        assert_eq!(
            decide(
                Some(&record.hash),
                Some(&content_hash(path, newer)),
                Some(&content_hash(path, merged)),
            ),
            Action::Conflict
        );
        let ours: serde_json::Value = serde_json::from_slice(newer).unwrap();
        let theirs: serde_json::Value = serde_json::from_slice(merged).unwrap();
        let (result, conflicts) =
            merge_metadata(record.base_metadata.as_ref(), &ours, &theirs).unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(result, json!({"order":["a","b","c"],"icon":"star"}));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upload_must_recheck_local_contents_before_recording_completion() {
        let root = crate::notes::temp_dir("webdav-upload-race");
        let path = root.join("test.md");
        fs::write(&path, "同步前内容").unwrap();
        let original = content_hash("test.md", &fs::read(&path).unwrap());
        assert!(check_local(&root, "test.md", Some(&original)).is_ok());
        // 远端上传期间，编辑器可能把页面更新为另一个版本。
        fs::write(&path, "上传途中修改").unwrap();
        assert!(check_local(&root, "test.md", Some(&original))
            .unwrap_err()
            .contains("在扫描后被修改"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_local_snapshot_uses_journal_hash() {
        let root = crate::notes::temp_dir("webdav-cache");
        let path = root.join("note.md");
        fs::write(&path, b"initial").unwrap();
        let (size, mtime) = local_stamp(&path).unwrap();
        let journal = Journal {
            files: BTreeMap::from([(
                "note.md".into(),
                FileRecord {
                    hash: "cached-content-hash".into(),
                    local_size: Some(size),
                    local_modified_ns: Some(mtime),
                    ..FileRecord::default()
                },
            )]),
            ..Journal::default()
        };
        assert_eq!(
            local_files_cached(&root, false, Some(&journal)).unwrap()["note.md"],
            "cached-content-hash"
        );
        fs::write(&path, b"changed content has a different length").unwrap();
        assert_ne!(
            local_files_cached(&root, false, Some(&journal)).unwrap()["note.md"],
            "cached-content-hash"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_thousand_unchanged_pages_reuse_hashes_without_reading_contents() {
        let root = crate::notes::temp_dir("webdav-thousand-pages");
        let mut records = BTreeMap::new();
        for i in 0..1000 {
            let name = format!("note-{i:04}.md");
            let file = root.join(&name);
            fs::write(&file, b"content").unwrap();
            let (size, modified) = local_stamp(&file).unwrap();
            records.insert(
                name,
                FileRecord {
                    hash: "cached".into(),
                    local_size: Some(size),
                    local_modified_ns: Some(modified),
                    ..FileRecord::default()
                },
            );
        }
        let journal = Journal {
            files: records,
            ..Journal::default()
        };
        let found = local_files_cached(&root, false, Some(&journal)).unwrap();
        assert_eq!(found.len(), 1000);
        assert!(found.values().all(|hash| hash == "cached"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_scanning_excludes_trash_temporary_and_optional_images() {
        let root = crate::notes::temp_dir("webdav-files");
        fs::write(root.join("主页.md"), "hello").unwrap();
        fs::create_dir_all(root.join("工作/assets")).unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets/默认笔记本 图片.png"), b"default-image").unwrap();
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(root.join(".trash/已删除.md"), "deleted").unwrap();
        fs::write(root.join("工作/页面.md"), "note").unwrap();
        fs::write(root.join("工作/assets/photo.png"), b"image").unwrap();
        let normal = local_files(&root, false).unwrap();
        assert_eq!(normal.len(), 2);
        assert!(!normal.contains_key("工作/assets/photo.png"));
        assert!(!normal.contains_key("assets/默认笔记本 图片.png"));
        let with_images = local_files(&root, true).unwrap();
        assert_eq!(with_images.len(), 4);
        assert!(with_images.contains_key("assets/默认笔记本 图片.png"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn simultaneous_metadata_edits_are_preserved_in_local_trash() {
        let root = crate::notes::temp_dir("webdav-metadata-conflict");
        let remote = r#"{"order":["远端"],"active":"a"}"#.as_bytes();
        let stored = backup_metadata_conflict(&root, ".minipad.json", remote).unwrap();
        assert_eq!(fs::read(stored).unwrap(), remote);
        let base = serde_json::json!({"order": ["旧"]});
        let local = serde_json::json!({"order": ["本机"]});
        let theirs = serde_json::json!({"order": ["远端"]});
        assert_eq!(
            merge_metadata(Some(&base), &local, &theirs).unwrap().1,
            vec!["order".to_string()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflicting_order_keeps_unrelated_remote_changes() {
        use serde_json::json;
        let base = json!({"order":["旧"], "icon":"book", "pinned":[]});
        let ours = json!({"order":["本地"], "icon":"book", "pinned":["重要"]});
        let theirs = json!({"order":["远端"], "icon":"star", "pinned":[]});
        let (merged, conflicts) = merge_metadata(Some(&base), &ours, &theirs).unwrap();
        assert_eq!(conflicts, vec!["order".to_string()]);
        assert_eq!(merged["order"], json!(["本地"]));
        assert_eq!(merged["icon"], "star");
        assert_eq!(merged["pinned"], json!(["重要"]));
    }

    #[test]
    fn page_navigation_changes_do_not_change_metadata_hash() {
        let a = r#"{"active":"页1","order":["页1"],"modes":{"页1":"edit"}}"#.as_bytes();
        let b = r#"{"active":"页2","order":["页1"],"modes":{"页1":"view"}}"#.as_bytes();
        assert_eq!(
            content_hash(".minipad.json", a),
            content_hash(".minipad.json", b)
        );
        assert_ne!(content_hash("页.md", a), content_hash("页.md", b));
    }

    #[test]
    fn three_way_table() {
        use Action::*;
        let cases = [
            (Some("a"), Some("a"), Some("a"), Skip),
            (Some("a"), Some("b"), Some("a"), Upload),
            (Some("a"), Some("a"), Some("b"), Download),
            (Some("a"), Some("b"), Some("b"), Skip),
            (Some("a"), Some("b"), Some("c"), Conflict),
            (None, Some("a"), None, Upload),
            (None, None, Some("a"), Download),
            (Some("a"), None, Some("a"), DeleteRemote),
            (Some("a"), Some("a"), None, DeleteLocal),
            (Some("a"), None, Some("b"), Download),
            (Some("a"), Some("b"), None, Upload),
            (Some("a"), None, None, Skip),
        ];
        for (base, local, remote, expected) in cases {
            assert_eq!(
                decide(base, local, remote),
                expected,
                "{base:?} {local:?} {remote:?}"
            );
        }
    }

    #[test]
    fn first_sync_modes() {
        use Action::*;
        assert_eq!(first_sync(Some("a"), Some("b"), FirstSync::Merge), Conflict);
        assert_eq!(
            first_sync(Some("a"), Some("b"), FirstSync::Remote),
            Download
        );
        assert_eq!(first_sync(Some("a"), Some("b"), FirstSync::Local), Upload);
        assert_eq!(first_sync(Some("a"), None, FirstSync::Remote), DeleteLocal);
        assert_eq!(first_sync(None, Some("a"), FirstSync::Local), DeleteRemote);
        assert_eq!(first_sync(Some("a"), None, FirstSync::Merge), Upload);
    }

    #[test]
    fn deletion_protection() {
        assert!(!deletion_needs_confirmation(0, 0));
        assert!(!deletion_needs_confirmation(20, 60));
        assert!(deletion_needs_confirmation(21, 100));
        assert!(deletion_needs_confirmation(11, 30));
        assert!(!deletion_needs_confirmation(10, 30));
    }

    #[test]
    fn configurable_delete_safety() {
        assert!(deletion_needs_confirmation_with(11, 100, 10, 3));
        assert!(!deletion_needs_confirmation_with(11, 100, 30, 3));
        assert!(deletion_needs_confirmation_with(11, 30, 30, 3));
        assert!(!deletion_needs_confirmation_with(11, 30, 30, 2));
    }

    #[test]
    fn file_scope_and_exclusions() {
        for p in [
            "页面.md",
            ".minipad.json",
            "工作/笔记.md",
            "工作/.minipad.json",
        ] {
            assert!(should_sync(p, false), "{p}");
        }
        assert!(should_sync("工作/assets/图 片.png", true));
        assert!(should_sync("assets/图 片#1.png", true));
        assert!(!should_sync("assets/图 片#1.png", false));
        assert!(!should_sync("工作/assets/图 片.png", false));
        for p in [
            ".trash/x.md",
            ".import-old/x.md",
            ".tmp.md",
            "工作/深层/子/页.md",
            "assets/深层/图片.png",
            "assets/.minipad.json",
            "assets/.hidden.png",
            "../secret.md",
            "工作/../页.md",
            "设置.json",
            "工作/a.tmp",
            "工作\\文件.md",
        ] {
            assert!(!should_sync(p, true), "{p}");
        }
    }

    #[test]
    fn notebook_meta_merges_shared_fields_without_navigation() {
        use serde_json::json;
        let base = json!({"active": "甲", "modes": {"甲":"edit"}, "order":["甲"], "icon":"book", "pinned":[]});
        let local = json!({"active": "乙", "modes": {"甲":"read"}, "order":["甲","乙"], "icon":"book", "pinned":[]});
        let remote = json!({"active": "甲", "modes": {"甲":"edit"}, "order":["甲"], "icon":"star", "pinned":[]});
        let combined = merge_metadata(Some(&base), &local, &remote).unwrap().0;
        assert_eq!(combined["active"], "乙");
        assert_eq!(combined["modes"]["甲"], "read");
        assert_eq!(combined["order"], json!(["甲", "乙"]));
        assert_eq!(combined["icon"], "star");
    }

    #[test]
    fn notebook_meta_conflicts_are_not_silently_discarded() {
        use serde_json::json;
        let base = json!({"icon":"book", "active":"a"});
        let local = json!({"icon":"star", "active":"b"});
        let remote = json!({"icon":"heart", "active":"c"});
        assert_eq!(
            merge_metadata(Some(&base), &local, &remote).unwrap().1,
            vec!["icon".to_string()]
        );
        assert!(merge_metadata(None, &json!([]), &remote).is_err());
    }

    #[test]
    fn an_empty_snapshot_is_not_always_a_first_sync() {
        let base = BTreeMap::new();
        let local = BTreeMap::from([("note.md".into(), "text".into())]);
        let remote = BTreeMap::new();
        assert_eq!(
            plan(&base, &local, &remote, FirstSync::Remote, true),
            vec![("note.md".into(), Action::DeleteLocal)]
        );
        assert_eq!(
            plan(&base, &local, &remote, FirstSync::Remote, false),
            vec![("note.md".into(), Action::Upload)]
        );
    }

    #[test]
    fn stable_plan() {
        let base = BTreeMap::from([("a.md".into(), "a".into())]);
        let local = BTreeMap::from([("a.md".into(), "a".into()), ("b.md".into(), "b".into())]);
        let remote = BTreeMap::from([("a.md".into(), "c".into())]);
        assert_eq!(
            plan(&base, &local, &remote, FirstSync::Merge, false),
            vec![
                ("a.md".into(), Action::Download),
                ("b.md".into(), Action::Upload)
            ]
        );
    }
}
