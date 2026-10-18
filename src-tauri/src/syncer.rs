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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

pub fn deletion_needs_confirmation(delete_count: usize, all_pages: usize) -> bool {
    delete_count > 20 || (all_pages > 0 && delete_count * 3 > all_pages)
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
            let action = if base.is_empty() {
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
) -> Result<serde_json::Value, Vec<String>> {
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
    if conflicts.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(conflicts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!should_sync("工作/assets/图 片.png", false));
        for p in [
            ".trash/x.md",
            ".import-old/x.md",
            ".tmp.md",
            "工作/深层/子/页.md",
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
        let combined = merge_metadata(Some(&base), &local, &remote).unwrap();
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
            merge_metadata(Some(&base), &local, &remote),
            Err(vec!["icon".to_string()])
        );
        assert!(merge_metadata(None, &json!([]), &remote).is_err());
    }

    #[test]
    fn stable_plan() {
        let base = BTreeMap::from([("a.md".into(), "a".into())]);
        let local = BTreeMap::from([("a.md".into(), "a".into()), ("b.md".into(), "b".into())]);
        let remote = BTreeMap::from([("a.md".into(), "c".into())]);
        assert_eq!(
            plan(&base, &local, &remote, FirstSync::Merge),
            vec![
                ("a.md".into(), Action::Download),
                ("b.md".into(), Action::Upload)
            ]
        );
    }
}
