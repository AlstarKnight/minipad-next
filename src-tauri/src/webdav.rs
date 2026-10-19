//! WebDAV PROPFIND Depth:1 响应解析（网络客户端会调用该模块）。
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteEntry {
    pub href: String,
    pub etag: Option<String>,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub directory: bool,
}

/// 不依赖 WebDAV 的 XML 前缀名称（D:、d:、其他自定义前缀）。
fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// 每个 propstat 单独判断状态；404 的属性不能覆盖 200 的属性。
pub fn parse_multistatus(xml: &str) -> Result<Vec<RemoteEntry>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut entries = Vec::new();
    let mut item: Option<RemoteEntry> = None;
    let mut prop: Option<RemoteEntry> = None;
    let mut prop_ok = false;
    let mut field = String::new();
    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("WebDAV 列目录响应不是有效 XML：{e}"))?;
        match event {
            Event::Start(e) => {
                let name = local(e.name().as_ref()).to_string();
                match name.as_str() {
                    "response" => {
                        item = Some(RemoteEntry {
                            href: String::new(),
                            etag: None,
                            size: None,
                            modified: None,
                            directory: false,
                        });
                    }
                    "propstat" if item.is_some() => {
                        prop = Some(RemoteEntry {
                            href: String::new(),
                            etag: None,
                            size: None,
                            modified: None,
                            directory: false,
                        });
                        prop_ok = false;
                    }
                    "href" | "getetag" | "getcontentlength" | "getlastmodified" | "status" => {
                        field = name;
                    }
                    "collection" if prop.is_some() => {
                        if let Some(ref mut p) = prop {
                            p.directory = true;
                        }
                    }
                    _ => {}
                }
            }
            Event::Empty(e) => {
                if local(e.name().as_ref()) == "collection" {
                    if let Some(ref mut p) = prop {
                        p.directory = true;
                    }
                }
            }
            Event::Text(t) => {
                let value = t.xml_content(XmlVersion::Implicit1_0)
                    .map_err(|e| format!("WebDAV XML 字段无法解码：{e}"))?;
                if field == "href" && prop.is_none() {
                    if let Some(ref mut entry) = item {
                        entry.href.push_str(&value);
                    }
                } else if let Some(ref mut p) = prop {
                    match field.as_str() {
                        "getetag" => p.etag = Some(value.into_owned()),
                        "getcontentlength" => p.size = value.parse().ok(),
                        "getlastmodified" => p.modified = Some(value.into_owned()),
                        "status" => prop_ok = value.contains(" 200 "),
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                match local(e.name().as_ref()) {
                    "href" | "getetag" | "getcontentlength" | "getlastmodified" | "status" => field.clear(),
                    "propstat" => {
                        if prop_ok {
                            if let (Some(ref mut entry), Some(p)) = (&mut item, &prop) {
                                entry.etag = p.etag.clone().or_else(|| entry.etag.clone());
                                entry.size = p.size.or(entry.size);
                                entry.modified = p.modified.clone().or_else(|| entry.modified.clone());
                                entry.directory |= p.directory;
                            }
                        }
                        prop = None;
                    }
                    "response" => {
                        if let Some(entry) = item.take() {
                            if !entry.href.is_empty() {
                                entries.push(entry);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => {
                if item.is_some() || prop.is_some() {
                    return Err("WebDAV 列目录响应提前结束".into());
                }
                break;
            }
            _ => {}
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaced_webdav_multistatus() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/MinipadNext/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/MinipadNext/中文%20笔记.md</d:href><d:propstat><d:prop>
            <d:getetag>"abc"</d:getetag><d:getcontentlength>31</d:getcontentlength>
            <d:getlastmodified>Sun, 18 Oct 2026 10:00:00 GMT</d:getlastmodified>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          </d:multistatus>"#;
        let entries = parse_multistatus(xml).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].directory);
        assert_eq!(entries[1].href, "/MinipadNext/中文%20笔记.md");
        assert_eq!(entries[1].size, Some(31));
        assert!(entries[1]
            .modified
            .as_deref()
            .unwrap()
            .starts_with("Sun, 18 Oct"));
        assert_eq!(entries[1].etag.as_deref(), Some(r#""abc""#));
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse_multistatus("<d:response>").is_err());
    }
}
