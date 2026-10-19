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
                let value = t.xml_content(XmlVersion::Implicit1_0);
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
            Event::End(e) => match local(e.name().as_ref()) {
                "href" | "getetag" | "getcontentlength" | "getlastmodified" | "status" => {
                    field.clear()
                }
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
            },
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

use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::header::{HeaderValue, CONTENT_TYPE, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Method, StatusCode, Url};
use std::time::Duration;

/// 仅接受 HTTPS（局域网 HTTP 必须显式允许）；禁止重定向泄漏 Basic Auth。
pub struct WebdavClient {
    http: Client,
    root: Url,
    username: String,
    password: String,
}

fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.chars().any(|c| c == '\\' || c == '/' || c == '\0')
        && !part.chars().any(char::is_control)
}

impl WebdavClient {
    pub fn new(
        server: &str,
        username: &str,
        password: &str,
        folder: &str,
        allow_http: bool,
    ) -> Result<Self, String> {
        let mut root = Url::parse(server.trim()).map_err(|_| "WebDAV 服务器地址不正确")?;
        if root.scheme() != "https" && !(allow_http && root.scheme() == "http") {
            return Err("WebDAV 默认只允许 HTTPS；局域网 HTTP 需手动允许".into());
        }
        if root.host_str().is_none()
            || !root.username().is_empty()
            || root.password().is_some()
            || root.query().is_some()
            || root.fragment().is_some()
        {
            return Err("服务器地址不能包含账号密码、查询参数或片段".into());
        }
        let parts: Vec<&str> = folder.trim_matches('/').split('/').collect();
        if parts.iter().any(|part| !valid_part(part)) {
            return Err("远程文件夹路径不正确".into());
        }
        root.set_query(None);
        {
            let mut segments = root.path_segments_mut().map_err(|_| "无效的服务器路径")?;
            segments.pop_if_empty();
            for part in &parts {
                segments.push(part);
            }
            segments.push("");
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .tls_backend_rustls()
            .build()
            .map_err(|e| format!("创建 WebDAV 连接失败：{e}"))?;
        Ok(Self {
            http,
            root,
            username: username.into(),
            password: password.into(),
        })
    }

    /// 所有远程路径都作为单独的 URL 段编码，避免 #、%、中文和空格被解释成 URL 结构。
    pub fn url_for(&self, path: &str) -> Result<Url, String> {
        let mut url = self.root.clone();
        if path.is_empty() {
            return Ok(url);
        }
        let directory = path.ends_with('/');
        let segments = path.trim_end_matches('/');
        if segments.split('/').any(|part| !valid_part(part)) {
            return Err("WebDAV 文件路径不安全".into());
        }
        {
            let mut parts = url.path_segments_mut().map_err(|_| "WebDAV 根路径无效")?;
            parts.pop_if_empty();
            for part in segments.split('/') {
                parts.push(part);
            }
            if directory {
                parts.push("");
            }
        }
        Ok(url)
    }

    fn request(&self, method: Method, url: Url) -> RequestBuilder {
        self.http
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password))
    }

    fn result(response: Response, accepted: &[StatusCode]) -> Result<Response, String> {
        let status = response.status();
        if accepted.contains(&status) {
            return Ok(response);
        }
        let text = match status.as_u16() {
            401 => "账号或应用密码错误",
            403 => "服务器拒绝访问，请检查写入权限",
            404 => "WebDAV 文件或文件夹不存在",
            405 => "WebDAV 服务端不支持此操作",
            409 => "远程目录不存在或写入发生冲突",
            412 => "远程文件在同步期间已修改，稍后重试",
            423 => "文件被服务端锁定",
            429 | 503 => "请求太频繁，请稍后再同步",
            507 => "网盘存储空间不足",
            _ => "WebDAV 请求失败",
        };
        Err(format!("{text}（HTTP {status}）"))
    }

    fn send(&self, req: RequestBuilder, accepted: &[StatusCode]) -> Result<Response, String> {
        let response = req.send().map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                "WebDAV 离线或连接超时".to_string()
            } else if e.to_string().to_ascii_lowercase().contains("certificate") {
                "TLS 证书不受信任；此版本不支持自签名证书".to_string()
            } else {
                format!("WebDAV 网络错误：{e}")
            }
        })?;
        Self::result(response, accepted)
    }

    /// 验证返回的 href 仍位于配置的远程文件夹下，拒绝越界和编码后的斜杠。
    pub fn relative_href(&self, href: &str) -> Result<String, String> {
        let url = self
            .root
            .join(href)
            .map_err(|_| "WebDAV 返回了无效的文件地址")?;
        if url.scheme() != self.root.scheme()
            || url.host() != self.root.host()
            || url.port_or_known_default() != self.root.port_or_known_default()
            || !url.path().starts_with(self.root.path())
        {
            return Err("WebDAV 返回的文件地址不在同步目录内".into());
        }
        let suffix = &url.path()[self.root.path().len()..];
        if suffix.is_empty() {
            return Ok(String::new());
        }
        let mut parts = Vec::new();
        for part in suffix.trim_end_matches('/').split('/') {
            let decoded = percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .map_err(|_| "WebDAV 路径不是 UTF-8")?;
            if !valid_part(&decoded) {
                return Err("WebDAV 返回了不安全的文件名".into());
            }
            parts.push(decoded.into_owned());
        }
        let mut path = parts.join("/");
        if suffix.ends_with('/') {
            path.push('/');
        }
        Ok(path)
    }

    /// 每级目录只请求 Depth:1，不使用多数网盘不兼容的 infinity。
    pub fn list(&self, folder: &str) -> Result<Vec<(String, RemoteEntry)>, String> {
        let url = self.url_for(folder)?;
        let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;
        let reply = self.send(
            self.request(propfind, url)
                .header("Depth", "1")
                .header(CONTENT_TYPE, "application/xml; charset=utf-8")
                .body(body),
            &[StatusCode::MULTI_STATUS],
        )?;
        let xml = reply
            .text()
            .map_err(|e| format!("WebDAV 列目录读取失败：{e}"))?;
        let mut entries = Vec::new();
        for entry in parse_multistatus(&xml)? {
            let path = self.relative_href(&entry.href)?;
            if !path.is_empty() && path.starts_with(folder) {
                let rest = &path[folder.len()..];
                // 服务端应当尊重 Depth:1；拒绝异常的跨层文件名。
                if rest.trim_end_matches('/').contains('/') {
                    return Err("WebDAV 服务端返回了超出 Depth:1 的文件".into());
                }
                entries.push((path, entry));
            }
        }
        Ok(entries)
    }

    pub fn get(&self, path: &str) -> Result<(Vec<u8>, Option<String>), String> {
        let reply = self.send(
            self.request(Method::GET, self.url_for(path)?),
            &[StatusCode::OK],
        )?;
        let etag = reply
            .headers()
            .get(ETAG)
            .and_then(|h| h.to_str().ok())
            .map(str::to_string);
        let data = reply
            .bytes()
            .map_err(|e| format!("读取 WebDAV 文件失败：{e}"))?;
        Ok((data.to_vec(), etag))
    }

    /// 上传已存在的文件要求 ETag 或 Last-Modified 条件保护。
    pub fn put(
        &self,
        path: &str,
        bytes: Vec<u8>,
        existing: Option<&RemoteEntry>,
    ) -> Result<Option<String>, String> {
        let mut request = self.request(Method::PUT, self.url_for(path)?).body(bytes);
        match existing {
            Some(old) if old.etag.is_some() => {
                let value = HeaderValue::from_str(old.etag.as_deref().unwrap())
                    .map_err(|_| "WebDAV ETag 无效")?;
                request = request.header(IF_MATCH, value);
            }
            Some(old) if old.modified.is_some() => {
                request = request.header(
                    "If-Unmodified-Since",
                    HeaderValue::from_str(old.modified.as_deref().unwrap())
                        .map_err(|_| "WebDAV 修改时间无效")?,
                );
            }
            Some(_) => return Err("服务端未提供 ETag 或修改时间，拒绝无条件覆盖".into()),
            None => request = request.header(IF_NONE_MATCH, "*"),
        }
        let response = self.send(
            request,
            &[StatusCode::CREATED, StatusCode::NO_CONTENT, StatusCode::OK],
        )?;
        Ok(response
            .headers()
            .get(ETAG)
            .and_then(|h| h.to_str().ok())
            .map(str::to_string))
    }

    pub fn mkcol(&self, path: &str) -> Result<(), String> {
        let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
        let directory = if path.ends_with('/') || path.is_empty() {
            path.to_string()
        } else {
            format!("{path}/")
        };
        let response = self
            .request(mkcol, self.url_for(&directory)?)
            .send()
            .map_err(|e| format!("创建远程文件夹失败：{e}"))?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            // 405 可能表示目录已经存在，必须再核对。
            self.list(&directory)?;
            return Ok(());
        }
        Self::result(response, &[StatusCode::CREATED, StatusCode::OK])?;
        Ok(())
    }

    pub fn move_file(&self, from: &str, to: &str) -> Result<(), String> {
        let method = Method::from_bytes(b"MOVE").map_err(|e| e.to_string())?;
        let dest = self.url_for(to)?;
        self.send(
            self.request(method, self.url_for(from)?)
                .header("Destination", dest.as_str())
                .header("Overwrite", "F"),
            &[StatusCode::CREATED, StatusCode::NO_CONTENT],
        )?;
        Ok(())
    }

    pub fn delete_probe(&self, path: &str) -> Result<(), String> {
        self.send(
            self.request(Method::DELETE, self.url_for(path)?),
            &[StatusCode::NO_CONTENT, StatusCode::OK],
        )?;
        Ok(())
    }

    /// 先确认账户能列目录，再试创建、写入、删除一个专用小文件。
    pub fn test_connection(&self) -> Result<(), String> {
        self.list("")?;
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!(".minipad-test-{id}.txt");
        self.put(&name, b"MinipadNext test".to_vec(), None)?;
        self.delete_probe(&name)
    }
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
    fn failed_property_status_does_not_hide_successful_metadata() {
        let xml = r#"<d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/MinipadNext/文件.md</d:href>
          <d:propstat><d:prop><d:getetag>"ok"</d:getetag><d:getcontentlength>12</d:getcontentlength></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          <d:propstat><d:prop><d:unknown/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
        </d:response></d:multistatus>"#;
        let entry = parse_multistatus(xml).unwrap().pop().unwrap();
        assert_eq!(entry.etag.as_deref(), Some(r#""ok""#));
        assert_eq!(entry.size, Some(12));
    }

    #[test]
    fn encodes_chinese_spaces_hash_percent_without_escaping_folder() {
        let client = WebdavClient::new(
            "https://cloud.example.com/remote.php/dav/files/user/",
            "user",
            "secret",
            "/MinipadNext/",
            false,
        )
        .unwrap();
        let url = client.url_for("工作/文 件#%笔记.md").unwrap();
        assert!(url.path().contains("MinipadNext/%E5%B7%A5%E4%BD%9C/"));
        assert!(url.path().contains("%20"));
        assert!(url.path().contains("%23%25"));
        assert_eq!(
            client.relative_href(url.as_str()).unwrap(),
            "工作/文 件#%笔记.md"
        );
        assert!(client
            .relative_href("https://evil.example.com/MinipadNext/secret.md")
            .is_err());
        assert!(client
            .relative_href("/remote.php/dav/files/user/MinipadNext/%2Fsecret.md")
            .is_err());
        assert!(client.url_for("../outside.md").is_err());
    }

    #[test]
    fn http_requires_explicit_insecure_opt_in() {
        assert!(
            WebdavClient::new("http://localhost:8080", "a", "b", "/MinipadNext/", false).is_err()
        );
        assert!(
            WebdavClient::new("http://localhost:8080", "a", "b", "/MinipadNext/", true).is_ok()
        );
        assert!(WebdavClient::new("https://example.com", "a", "b", "/../", false).is_err());
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse_multistatus("<d:response>").is_err());
    }
}
