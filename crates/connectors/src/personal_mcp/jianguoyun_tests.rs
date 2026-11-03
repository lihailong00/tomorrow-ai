use super::*;

fn credentials() -> Credentials {
    Credentials {
        account: Some("fixture@example.test".into()),
        token: "application-password-fixture".into(),
        environment: "production".into(),
        server_url: None,
        client_id: None,
    }
}

#[test]
fn auth_is_basic_account_and_app_password_and_is_sensitive() {
    let header = authorization(&credentials()).unwrap();
    assert!(header.is_sensitive());
    assert_eq!(
        header.to_str().unwrap(),
        format!(
            "Basic {}",
            STANDARD.encode("fixture@example.test:application-password-fixture")
        )
    );
    let mut invalid = credentials();
    invalid.account = None;
    assert!(validate(&invalid).is_err());
    invalid.account = Some("injected\r\nAuthorization: other".into());
    assert!(validate(&invalid).is_err());
    invalid = credentials();
    invalid.server_url = Some("https://elsewhere.test".into());
    assert!(validate(&invalid).is_err());
    invalid = credentials();
    invalid.token.push('\n');
    assert!(validate(&invalid).is_err());
}

#[test]
fn paths_keep_fixed_origin_and_reject_traversal_urls_queries_and_double_encoding() {
    let url = resource_url("/笔记/日记.md").unwrap();
    assert_eq!(url.host_str(), Some("dav.jianguoyun.com"));
    assert_eq!(url.scheme(), "https");
    assert!(url.path().starts_with("/dav/"));
    assert_eq!(href_path(url.as_str()).unwrap(), "/笔记/日记.md");
    for path in [
        "../secret",
        "/a/../secret",
        "/%2e%2e/secret",
        "/%252e%252e/secret",
        "//evil.test/x",
        "https://user:pass@evil.test/x",
        "/x?q=1",
        "/x#part",
        "/a%2fb",
        "/a%5cb",
        "/%zz",
        "/a\0",
    ] {
        assert!(resource_url(path).is_err(), "accepted unsafe fixture path");
    }
    for href in [
        "https://evil.test/dav/file.txt",
        "https://user@dav.jianguoyun.com/dav/file.txt",
        "http://dav.jianguoyun.com/dav/file.txt",
        "https://dav.jianguoyun.com/dav/../dav/file.txt",
        "/elsewhere/file.txt",
        "/dav/file.txt?q=1",
    ] {
        assert!(href_path(href).is_err());
    }
}

#[test]
fn arguments_are_exact_and_only_read_tools_are_published() {
    assert!(validate_arguments("jianguoyun_list_files", &json!({})).is_ok());
    for args in [
        json!({"path":"/","limit":0}),
        json!({"limit":101}),
        json!({"url":"https://evil.test"}),
        json!({"path":null}),
    ] {
        assert!(validate_arguments("jianguoyun_list_files", &args).is_err());
    }
    assert!(validate_arguments("jianguoyun_read_text_file", &json!({"path":"/"})).is_err());
    assert!(validate_arguments("jianguoyun_delete_file", &json!({"path":"/file.txt"})).is_err());
    assert!(
        tools()
            .iter()
            .all(|tool| is_read_only(tool["name"].as_str().unwrap())
                && tool["annotations"]["readOnlyHint"] == true)
    );
}

#[test]
fn errors_do_not_include_upstream_body_auth_or_urls() {
    assert_eq!(status_error(401).code, "connection_required");
    assert_eq!(status_error(429).status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(status_error(302).code, "jianguoyun_redirect_rejected");
    for status in [401, 403, 404, 423, 429, 302, 500] {
        let text = status_error(status).to_string();
        assert!(!text.contains("fixture@example.test"));
        assert!(!text.contains("application-password-fixture"));
        assert!(!text.contains("Authorization"));
    }
}

const DAV: &str = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:displayname>Root</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/notes%20%26%20draft.md</d:href><d:propstat><d:prop><d:displayname>notes &amp; draft.md</d:displayname><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;

#[test]
fn dav_metadata_is_real_scoped_and_entity_decoded_without_external_expansion() {
    let rows = listing(DAV.as_bytes(), "/").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["is_directory"], true);
    assert_eq!(rows[1]["path"], "/notes & draft.md");
    assert_eq!(rows[1]["size_bytes"], 12);
    assert!(
        listing(
            DAV.replace("/dav/notes", "/dav/other/sub/notes").as_bytes(),
            "/"
        )
        .is_err()
    );
    assert!(xml(b"<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///private'>]><multistatus>&secret;</multistatus>").is_err());
    assert!(xml(b"<a><b></a>").is_err());
    assert!(xml(b"<a/><b/>").is_err());
    assert!(entities("&unknown;").is_err());
}

#[test]
fn file_and_xml_bodies_are_bounded_utf8_and_not_silently_truncated_or_binary() {
    assert!(bounded_text(&vec![b'x'; MAX_BYTES]).is_ok());
    assert!(bounded_text(&vec![b'x'; MAX_BYTES + 1]).is_err());
    assert!(bounded_text(&[0xff, 0xfe]).is_err());
    assert!(bounded_text(b"binary\0payload").is_err());
    assert!(text_file("/notes.MD"));
    assert!(!text_file("/report.pdf"));
    assert!(xml(format!("{}{}", "<a>".repeat(33), "</a>".repeat(33)).as_bytes()).is_err());
}
