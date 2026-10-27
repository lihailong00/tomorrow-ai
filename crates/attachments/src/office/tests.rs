use super::*;
use std::io::Write;
use zip::{ZipWriter, write::SimpleFileOptions};

const DOC_CONTENT: &str = r#"<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
const XLS_CONTENT: &str = r#"<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#;

fn archive(files: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn upload(name: &str, bytes: &[u8]) -> Upload {
    Upload {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        mime_type: "application/octet-stream".into(),
        size: bytes.len() as i64,
        created_at: chrono::Utc::now().to_rfc3339(),
        uri: String::new(),
    }
}

fn docx(xml: &str) -> Vec<u8> {
    archive(&[
        ("[Content_Types].xml", DOC_CONTENT),
        ("word/document.xml", xml),
    ])
}

fn document(xml: &str) -> String {
    let bytes = docx(xml);
    extract(&upload("note.docx", &bytes), &bytes).unwrap()
}

#[test]
fn docx_preserves_chinese_paragraphs_tabs_line_breaks_and_standard_entities() {
    assert_eq!(
        document(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>会议 &amp; 项目 &#x4E2D;</w:t><w:tab/><w:t>周五</w:t><w:br/><w:t>14:00</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>"#
        ),
        "会议 & 项目 中\t周五\n14:00\n第二段"
    );
}

#[test]
fn docx_paired_and_empty_separators_extract_equivalent_text() {
    let prefix = r#"<w:document xmlns:w="word"><w:p><w:r><w:t>one</w:t>"#;
    let suffix = r#"<w:t>four</w:t></w:r></w:p></w:document>"#;
    let empty = format!("{prefix}<w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t><w:cr/>{suffix}");
    let paired = format!("{prefix}<w:tab></w:tab><w:t>two</w:t><w:br></w:br><w:t>three</w:t><w:cr></w:cr>{suffix}");
    assert_eq!(document(&empty), "one\ttwo\nthree\nfour");
    assert_eq!(document(&paired), document(&empty));
}

#[test]
fn docx_reads_tables_without_executing_fields_or_deleted_text() {
    let text = document(
        r#"<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>客户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:instrText>INCLUDETEXT file:///etc/passwd</w:instrText><w:delText>删除</w:delText><w:t>当前内容</w:t></w:r></w:p></w:body></w:document>"#,
    );
    assert!(text.contains("客户\n\t甲方"));
    assert!(!text.contains("etc/passwd"));
    assert!(!text.contains("删除"));
    assert!(text.ends_with("当前内容"));
}

#[test]
fn xlsx_reads_workbook_order_shared_and_inline_strings_sparse_addresses_and_cached_formula() {
    let bytes = archive(&[
        ("[Content_Types].xml", XLS_CONTENT),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns:r="relationships"><sheets><sheet name="进度 &amp; 计划" sheetId="1" r:id="rId2"/><sheet name="空表" sheetId="2" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#,
        ),
        (
            "xl/sharedStrings.xml",
            r#"<sst><si><r><t>客户</t></r><r><t>甲方</t></r></si></sst>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData/></worksheet>",
        ),
        (
            "xl/worksheets/sheet2.xml",
            r#"<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="D2" t="inlineStr"><is><t>周五</t></is></c><c r="F2"><f>SUM(A1:B1)</f><v>30</v></c><c r="G2" t="b"><v>1</v></c><c r="H2"><f>HYPERLINK("https://example.test")</f></c></row></sheetData></worksheet>"#,
        ),
    ]);
    let text = extract(&upload("plan.xlsx", &bytes), &bytes).unwrap();
    assert!(text.find("进度 & 计划").unwrap() < text.find("空表").unwrap());
    assert!(text.contains("A2\t客户甲方\nD2\t周五\nF2\t30\nG2\ttrue\nH2\t[公式，无缓存结果]"));
    assert!(!text.contains("https://example.test"));
}

#[test]
fn rejects_macro_external_relationship_dtd_unknown_entity_and_path_traversal() {
    let cases = [
        archive(&[
            ("[Content_Types].xml", DOC_CONTENT),
            ("word/document.xml", "<document/>"),
            ("word/vbaProject.bin", "macro"),
        ]),
        archive(&[
            ("[Content_Types].xml", DOC_CONTENT),
            ("word/document.xml", "<document/>"),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships><Relationship Id="r1" Type="hyperlink" Target="https://example.test" TargetMode="External"/></Relationships>"#,
            ),
        ]),
        docx(
            r#"<!DOCTYPE document [<!ENTITY ext SYSTEM "file:///etc/passwd">]><document><t>&ext;</t></document>"#,
        ),
        docx("<document><t>&unknown;</t></document>"),
    ];
    for bytes in cases {
        assert_eq!(
            extract(&upload("unsafe.docx", &bytes), &bytes)
                .unwrap_err()
                .code(),
            "unsafe_office_file"
        );
    }
    let bytes = archive(&[
        ("[Content_Types].xml", DOC_CONTENT),
        ("../escape.xml", "<a/>"),
    ]);
    assert_eq!(
        extract(&upload("path.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
}

#[test]
fn rejects_binary_renamed_files_mime_mismatch_malformed_xml_and_overlong_output() {
    let bytes = b"%PDF-1.7 fake document";
    assert_eq!(
        extract(&upload("fake.docx", bytes), bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
    let bytes = docx("<document><t>Hello</t></document>");
    let mut item = upload("note.docx", &bytes);
    item.mime_type = "image/png".into();
    assert_eq!(
        extract(&item, &bytes).unwrap_err().code(),
        "invalid_office_mime"
    );
    let bytes = docx("<document><t>Hello</document>");
    assert_eq!(
        extract(&upload("note.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "invalid_office_file"
    );
    let bytes = docx(&format!(
        "<document><t>{}</t></document>",
        "中".repeat(MAX_TEXT_BYTES as usize)
    ));
    assert_eq!(
        extract(&upload("large.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "attachment_too_long"
    );
}

#[test]
fn rejects_archive_bombs_excess_entries_xml_depth_and_encryption() {
    let bytes = docx(&format!(
        "<document>{}</document>",
        "x".repeat(MAX_XML_BYTES as usize + 1)
    ));
    assert_eq!(
        extract(&upload("bomb.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let entries: Vec<_> = (0..MAX_ARCHIVE_ENTRIES + 1)
        .map(|i| (format!("part{i}"), "".to_owned()))
        .collect();
    let refs: Vec<_> = entries
        .iter()
        .map(|(n, c)| (n.as_str(), c.as_str()))
        .collect();
    let bytes = archive(&refs);
    assert_eq!(
        extract(&upload("many.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let bytes = docx(&format!(
        "{}text{}",
        "<a>".repeat(MAX_XML_DEPTH + 1),
        "</a>".repeat(MAX_XML_DEPTH + 1)
    ));
    assert_eq!(
        extract(&upload("deep.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "office_file_limit"
    );
    let mut bytes = docx("<document><t>Hello</t></document>");
    // The encrypted flag is carried by both local and central headers.
    for i in 0..bytes.len() - 10 {
        if bytes[i..].starts_with(b"PK\x03\x04") {
            bytes[i + 6] |= 1;
        }
        if bytes[i..].starts_with(b"PK\x01\x02") {
            bytes[i + 8] |= 1;
        }
    }
    assert_eq!(
        extract(&upload("encrypted.docx", &bytes), &bytes)
            .unwrap_err()
            .code(),
        "unsafe_office_file"
    );
}

#[tokio::test]
async fn extracted_text_cache_keeps_owner_scope_works_in_agent_context_and_deletes_with_upload() {
    use crate::{AttachmentsState, router};
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use tomorrow_domain::Repository;
    use tower::ServiceExt;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user("office@fixtures.test", "unused", "owner", "Asia/Shanghai")
        .await
        .unwrap();
    let other = repo
        .create_user(
            "other-office@fixtures.test",
            "unused",
            "other",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&owner.id).await.unwrap();
    let other_token = repo.create_session(&other.id).await.unwrap();
    let directory =
        std::env::temp_dir().join(format!("tomorrow-office-test-{}", uuid::Uuid::new_v4()));
    let state =
        AttachmentsState::initialize(repo, directory.clone(), crate::DEFAULT_MAX_BYTES, None)
            .await
            .unwrap();
    let bytes = docx("<document><t>本周交付计划</t></document>");
    let item = upload("work.docx", &bytes);
    tokio::fs::write(state.path(&item.id).unwrap(), bytes)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO uploads(id,user_id,name,mime_type,size,created_at) VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(&item.id)
    .bind(&owner.id)
    .bind(&item.name)
    .bind(&item.mime_type)
    .bind(item.size)
    .bind(&item.created_at)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        state.read_text(&owner.id, &item.id).await.unwrap().text,
        "本周交付计划"
    );
    assert_eq!(
        state
            .read_text(&other.id, &item.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/v1/uploads/{}/text", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 128 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["text"], "本周交付计划");
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/v1/uploads/{}/text", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {other_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // Cached text remains readable even if the original object is temporarily unavailable.
    tokio::fs::remove_file(state.path(&item.id).unwrap())
        .await
        .unwrap();
    assert!(
        state
            .chat_context(&owner.id, &[item.id.clone()])
            .await
            .unwrap()
            .contains("本周交付计划")
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/uploads/{}", item.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cached: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM upload_text_cache")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(cached, 0);
    assert_eq!(
        state
            .read_text(&owner.id, &item.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    state.pool.close().await;
    let resolved = std::fs::canonicalize(&directory).unwrap();
    assert_eq!(
        resolved.parent().unwrap(),
        std::fs::canonicalize(std::env::temp_dir()).unwrap()
    );
    assert!(
        resolved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tomorrow-office-test-")
    );
    tokio::fs::remove_dir_all(resolved).await.unwrap();
}
