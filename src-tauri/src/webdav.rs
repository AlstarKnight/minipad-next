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

/// 只读取 Depth:1 当前目录的 response。错误 XML 必须失败，而不能被当成空目录。
pub fn parse_multistatus(xml: &str) -> Result<Vec<RemoteEntry>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut entries = Vec::new();
    let mut item: Option<RemoteEntry> = None;
    let mut field = String::new();
    let mut valid_property = false;
    let mut status_ok = true;
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
                        status_ok = true;
                    }
                    "propstat" => {
                        valid_property = true;
                    }
                    "href" | "getetag" | "getcontentlength" | "getlastmodified" | "status" => {
                        field = name.clone();
                    }
                    "collection" if valid_property => {
                        if let Some(ref mut entry) = item {
                            entry.directory = true;
                        }
                    }
                    _ => {}
                }
            }
            Event::Empty(e) => {
                if local(e.name().as_ref()) == "collection" && valid_property {
                    if let Some(ref mut entry) = item {
                        entry.directory = true;
                    }
                }
            }
            Event::Text(t) => {
                let value = t.xml_content(XmlVersion::Implicit1_0);
                if let Some(ref mut entry) = item {
                    match field.as_str() {
                        "href" => entry.href.push_str(&value),
                        "getetag" if valid_property => entry.etag = Some(value.into_owned()),
                        "getcontentlength" if valid_property => entry.size = value.parse().ok(),
                        "getlastmodified" if valid_property => {
                            entry.modified = Some(value.into_owned())
                        }
                        "status" if valid_property => {
                            status_ok = value.contains(" 200 ");
                        }
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                let name = local(e.name().as_ref()).to_string();
                match name.as_str() {
                    "href" | "getetag" | "getcontentlength" | "getlastmodified" | "status" => {
                        field.clear()
                    }
                    "propstat" => valid_property = false,
                    "response" => {
                        if let Some(entry) = item.take() {
                            if !entry.href.is_empty() && status_ok {
                                entries.push(entry);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => {
                if item.is_some() {
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
        assert!(entries[1].modified.as_deref().unwrap().starts_with("Sun, 18 Oct"));
        assert_eq!(entries[1].etag.as_deref(), Some(r#""abc""#));
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse_multistatus("<d:response>").is_err());
    }
}
