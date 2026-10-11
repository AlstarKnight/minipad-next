//! 每日自动备份:每天第一次保存时把整个笔记文件夹打成一个 zip,只留最近几份。
//! 这里的函数不依赖 Tauri,日期由调用方传进来,方便测试。

use crate::notes::TRASH_DIR;
use chrono::{DateTime as LocalTime, Datelike, Local, Timelike};
use std::fs;
use std::io::{self, BufWriter, Seek, Write};
use std::path::{Path, PathBuf};
use zip::result::ZipResult;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

const PREFIX: &str = "笔记备份 ";
const EXT: &str = ".zip";

/// 某一天的备份文件名,`day` 形如 2026-10-11
pub fn file_name(day: &str) -> String {
    format!("{PREFIX}{day}{EXT}")
}

/// 从备份文件名里取出日期;不是程序生成的备份就返回 None
fn day_of(file: &str) -> Option<&str> {
    let day = file.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    let ok = day.len() == 10
        && day.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    ok.then_some(day)
}

/// 备份文件夹里已有的备份,按日期从旧到新
pub fn list(dest: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dest) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            day_of(&name).map(|day| (day.to_string(), e.path()))
        })
        .collect();
    found.sort();
    found
}

/// 今天还没有备份就打一个,再删掉超出 `keep` 份的旧备份。
/// 返回新备份的路径;今天已经备份过就什么都不做,返回 None。
pub fn run(notes: &Path, dest: &Path, day: &str, keep: usize) -> Result<Option<PathBuf>, String> {
    let target = dest.join(file_name(day));
    if target.exists() {
        return Ok(None);
    }
    fs::read_dir(notes).map_err(|e| format!("读不了笔记文件夹 {}:{e}", notes.display()))?;
    fs::create_dir_all(dest).map_err(|e| format!("无法创建备份文件夹 {}:{e}", dest.display()))?;
    // 先写到临时文件,写完再改名,半截的 zip 不会被当成备份
    let tmp = dest.join(format!("{}.tmp~", file_name(day)));
    let written = write_zip(notes, &tmp, dest)
        .and_then(|_| fs::rename(&tmp, &target).map_err(|e| e.to_string()));
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("打包时出错:{e}"));
    }
    prune(dest, keep);
    Ok(Some(target))
}

/// 只留最近 `keep` 份(至少一份),多出来的从最旧的删起。
/// 删不掉的(比如正被别的程序打开)先留着,下次备份时再删。
pub fn prune(dest: &Path, keep: usize) {
    let all = list(dest);
    let extra = all.len().saturating_sub(keep.max(1));
    for (_, path) in &all[..extra] {
        if let Err(e) = fs::remove_file(path) {
            eprintln!("删除旧备份 {} 失败:{e}", path.display());
        }
    }
}

fn write_zip(notes: &Path, out: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    // 备份文件夹万一放在笔记文件夹里面,不能把自己也装进去
    let skip = fs::canonicalize(dest).ok();
    add_dir(&mut zip, notes, "", skip.as_deref()).map_err(|e| e.to_string())?;
    zip.finish()
        .map_err(|e| e.to_string())?
        .into_inner()
        .map_err(|e| e.to_string())?
        .sync_all()
        .map_err(|e| e.to_string())
}

/// 把 `dir` 里的东西放进 zip 的 `prefix` 下面。
/// `.git` 这类点开头的文件夹不备份,`.trash` 里是删掉的页面,要备份;正在写的临时文件跳过。
/// 读不了的文件(比如被别的程序独占打开)跳过,不让整个备份失败。
fn add_dir<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    skip: Option<&Path>,
) -> ZipResult<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            let hidden = name.starts_with('.') && name != TRASH_DIR;
            if hidden || (skip.is_some() && fs::canonicalize(&path).ok().as_deref() == skip) {
                continue;
            }
            zip.add_directory(rel.as_str(), options(&path))?;
            add_dir(zip, &path, &rel, skip)?;
        } else if kind.is_file() && !name.ends_with(".tmp~") {
            let Ok(mut file) = fs::File::open(&path) else {
                continue;
            };
            zip.start_file(rel.as_str(), options(&path))?;
            io::copy(&mut file, zip)?;
        }
    }
    Ok(())
}

/// 压缩方式和修改时间(用文件自己的修改时间,解压出来时间不会变)
fn options(path: &Path) -> SimpleFileOptions {
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    match modified(path) {
        Some(time) => opts.last_modified_time(time),
        None => opts,
    }
}

fn modified(path: &Path) -> Option<DateTime> {
    let t: LocalTime<Local> = fs::metadata(path).ok()?.modified().ok()?.into();
    DateTime::from_date_and_time(
        u16::try_from(t.year()).ok()?,
        t.month() as u8,
        t.day() as u8,
        t.hour() as u8,
        t.minute() as u8,
        t.second() as u8,
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::temp_dir;
    use std::io::Read;

    /// zip 里的全部条目名,和每个文件的内容
    fn read_zip(path: &Path) -> Vec<(String, String)> {
        let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        (0..zip.len())
            .map(|i| {
                let mut f = zip.by_index(i).unwrap();
                let mut content = String::new();
                if f.is_file() {
                    f.read_to_string(&mut content).unwrap();
                }
                (f.name().unwrap().to_string(), content)
            })
            .collect()
    }

    fn days(dest: &Path) -> Vec<String> {
        list(dest).into_iter().map(|(d, _)| d).collect()
    }

    #[test]
    fn recognizes_only_its_own_backup_files() {
        assert_eq!(day_of("笔记备份 2026-10-11.zip"), Some("2026-10-11"));
        assert_eq!(day_of("笔记备份 2026-10-11.zip.tmp~"), None);
        assert_eq!(day_of("笔记备份 2026-1-11.zip"), None);
        assert_eq!(day_of("笔记备份 abcd-ef-gh.zip"), None);
        assert_eq!(day_of("别的文件 2026-10-11.zip"), None);
        assert_eq!(file_name("2026-10-11"), "笔记备份 2026-10-11.zip");
    }

    #[test]
    fn zips_the_notes_folder_once_a_day() {
        let root = temp_dir("backup");
        let notes = root.join("notes");
        let dest = root.join("backups");
        fs::create_dir_all(notes.join("工作")).unwrap();
        fs::create_dir_all(notes.join("空笔记本")).unwrap();
        fs::create_dir_all(notes.join(".trash")).unwrap();
        fs::create_dir_all(notes.join(".git")).unwrap();
        fs::write(notes.join("欢迎.md"), "你好").unwrap();
        fs::write(notes.join(".minipad.json"), "{}").unwrap();
        fs::write(notes.join("工作").join("周报.md"), "本周").unwrap();
        fs::write(notes.join(".trash").join("旧.1700000000.md"), "删掉的").unwrap();
        fs::write(notes.join(".git").join("config"), "").unwrap();
        fs::write(notes.join("正在写.tmp~"), "").unwrap();

        let made = run(&notes, &dest, "2026-10-11", 14).unwrap().unwrap();
        assert_eq!(made, dest.join("笔记备份 2026-10-11.zip"));
        let entries = read_zip(&made);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                ".minipad.json",
                ".trash/",
                ".trash/旧.1700000000.md",
                "工作/",
                "工作/周报.md",
                "欢迎.md",
                "空笔记本/",
            ]
        );
        let content = |name: &str| entries.iter().find(|(n, _)| n == name).unwrap().1.clone();
        assert_eq!(content("欢迎.md"), "你好");
        assert_eq!(content("工作/周报.md"), "本周");
        assert_eq!(content(".trash/旧.1700000000.md"), "删掉的");

        // 同一天再保存不会再备份
        fs::write(notes.join("欢迎.md"), "改过了").unwrap();
        assert_eq!(run(&notes, &dest, "2026-10-11", 14).unwrap(), None);
        assert_eq!(read_zip(&made).len(), 7);
        // 第二天第一次保存会生成新的备份
        let next = run(&notes, &dest, "2026-10-12", 14).unwrap().unwrap();
        let entries = read_zip(&next);
        assert_eq!(
            entries.iter().find(|(n, _)| n == "欢迎.md").unwrap().1,
            "改过了"
        );
        assert_eq!(days(&dest), vec!["2026-10-11", "2026-10-12"]);
        // 不会留下临时文件
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn keeps_only_the_latest_backups() {
        let root = temp_dir("backup-keep");
        let notes = root.join("notes");
        let dest = root.join("backups");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "a").unwrap();
        fs::create_dir_all(&dest).unwrap();
        // 用户自己放在备份文件夹里的文件不会被删
        fs::write(dest.join("我的文件.zip"), "").unwrap();
        for day in ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"] {
            run(&notes, &dest, day, 3).unwrap();
        }
        assert_eq!(days(&dest), vec!["2026-10-02", "2026-10-03", "2026-10-04"]);
        // 把保留份数改小,下次备份时多出来的会被删掉
        run(&notes, &dest, "2026-10-05", 1).unwrap();
        assert_eq!(days(&dest), vec!["2026-10-05"]);
        // 保留份数填 0 也至少留一份
        prune(&dest, 0);
        assert_eq!(days(&dest), vec!["2026-10-05"]);
        assert!(dest.join("我的文件.zip").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn never_zips_the_backup_folder_into_itself() {
        let root = temp_dir("backup-nested");
        let notes = root.join("notes");
        let dest = notes.join("备份");
        fs::create_dir_all(&dest).unwrap();
        fs::write(notes.join("a.md"), "a").unwrap();
        run(&notes, &dest, "2026-10-11", 14).unwrap();
        let second = run(&notes, &dest, "2026-10-12", 14).unwrap().unwrap();
        let names: Vec<String> = read_zip(&second).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["a.md"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_a_missing_notes_folder() {
        let root = temp_dir("backup-missing");
        let err = run(&root.join("没有"), &root.join("backups"), "2026-10-11", 14).unwrap_err();
        assert!(err.contains("读不了笔记文件夹"));
        assert!(list(&root.join("backups")).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
