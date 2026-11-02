//! Independent route-level acceptance. Synthetic ciphertext only; no providers or mail.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

const PATH: &str = "/v1/private-vault/backup";

fn envelope(second: bool) -> Value {
    json!({
        "schema": 1,
        "algorithm": "A256GCM",
        "kid": if second { "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } else { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        "iv": "AAAAAAAAAAAAAAAA",
        "ciphertext": if second { "AQEBAQEBAQEBAQEBAQEBAQ==" } else { "AAAAAAAAAAAAAAAAAAAAAA==" }
    })
}

struct Fixture {
    repo: Repository,
    router: Router,
    owner: String,
    other: String,
    token: String,
    foreign: String,
}

impl Fixture {
    async fn new() -> Self {
        Self::connect("sqlite::memory:").await
    }

    async fn connect(database_url: &str) -> Self {
        let repo = Repository::connect(database_url).await.unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let owner = repo
            .create_user(
                &format!("independent-vault-a-{unique}@example.test"),
                "unused",
                "A",
                "UTC",
            )
            .await
            .unwrap();
        let other = repo
            .create_user(
                &format!("independent-vault-b-{unique}@example.test"),
                "unused",
                "B",
                "UTC",
            )
            .await
            .unwrap();
        let token = repo.create_session(&owner.id).await.unwrap();
        let foreign = repo.create_session(&other.id).await.unwrap();
        let router = app(AppState::new(
            repo.clone(),
            ModelProvider::from_lookup(|_| None),
            database_url,
        ));
        Self {
            repo,
            router,
            owner: owner.id,
            other: other.id,
            token,
            foreign,
        }
    }

    async fn raw(&self, token: &str, method: &str, raw: String) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(PATH)
            .header("content-type", "application/json");
        if !token.is_empty() {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(raw)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|h| h.to_str().ok()),
            Some("no-store, private"),
            "vault responses must prevent storage, including {status}"
        );
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("vault response must be JSON, status {status}"));
        (status, body)
    }

    async fn call(&self, token: &str, method: &str, body: Value) -> (StatusCode, Value) {
        self.raw(token, method, body.to_string()).await
    }

    async fn read(&self, token: &str) -> Value {
        let (status, body) = self.call(token, "GET", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        body
    }
}

#[tokio::test]
async fn postgres_independent_pools_preserve_vault_cas_owner_scope_and_deletion_tombstone() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("SKIPPED actual PostgreSQL fixture: TEST_DATABASE_URL is not configured");
        return;
    };
    let f = Fixture::connect(&url).await;
    let second_repo = Repository::connect(&url).await.unwrap();
    let g = Fixture {
        router: app(AppState::new(
            second_repo.clone(),
            ModelProvider::from_lookup(|_| None),
            &url,
        )),
        repo: second_repo,
        owner: f.owner.clone(),
        other: f.other.clone(),
        token: f.token.clone(),
        foreign: f.foreign.clone(),
    };
    let (a, b) = tokio::join!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(false)})
        ),
        g.call(
            &g.token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(true)})
        )
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let recorded = g.read(&g.token).await;
    assert_eq!(recorded["version"], 1);
    assert_eq!(g.read(&g.foreign).await["envelope"], Value::Null);
    let (put, delete) = tokio::join!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":1,"envelope":envelope(true)})
        ),
        g.call(&g.token, "DELETE", json!({"expected_version":1}))
    );
    let mut statuses = [put.0.as_u16(), delete.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    assert_eq!(f.read(&f.token).await["version"], 2);
    assert_eq!(
        g.call(&g.token, "DELETE", json!({"expected_version":2}))
            .await
            .0,
        StatusCode::OK
    );
    for stale in [0, 1, 2] {
        assert_eq!(
            f.call(
                &f.token,
                "PUT",
                json!({"expected_version":stale,"envelope":envelope(false)})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    let final_state = g.read(&g.token).await;
    assert_eq!(final_state["version"], 3);
    assert_eq!(final_state["envelope"], Value::Null);
    assert_eq!(
        g.call(&g.foreign, "DELETE", json!({"expected_version":3}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (version_type,): (String,) = sqlx::query_as(
        "SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='private_vault_backups' AND column_name='version'"
    ).fetch_one(&f.repo.pool()).await.unwrap();
    assert_eq!(version_type, "bigint");
    assert!(f.repo.memories(&f.owner).await.unwrap().is_empty());
}

#[tokio::test]
async fn every_backup_operation_requires_authentication_and_errors_are_not_cacheable() {
    let f = Fixture::new().await;
    for token in ["", "synthetic-invalid-session"] {
        for method in ["GET", "PUT", "DELETE"] {
            let (status, body) = f
                .call(
                    token,
                    method,
                    json!({"expected_version":0,"envelope":envelope(false)}),
                )
                .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(!body.to_string().contains("synthetic-invalid-session"));
            assert!(!body.to_string().contains("ciphertext"));
        }
    }
    assert_eq!(f.read(&f.token).await["version"], 0);
    assert_eq!(f.read(&f.foreign).await["version"], 0);
}

#[tokio::test]
async fn simultaneous_creation_has_one_winner_and_loser_cannot_overwrite_it() {
    let f = Fixture::new().await;
    let left = json!({"expected_version":0,"envelope":envelope(false)});
    let right = json!({"expected_version":0,"envelope":envelope(true)});
    let (a, b) = tokio::join!(
        f.call(&f.token, "PUT", left),
        f.call(&f.token, "PUT", right)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let winner = if a.0 == StatusCode::OK { &a.1 } else { &b.1 };
    let observed = f.read(&f.token).await;
    assert_eq!(observed["version"], 1);
    assert_eq!(observed["envelope"], winner["envelope"]);
    assert!(observed["updated_at"].as_i64().is_some());
    assert_eq!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(true)})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(f.read(&f.token).await, observed);
    assert_eq!(f.read(&f.foreign).await["envelope"], Value::Null);
}

#[tokio::test]
async fn delete_tombstone_survives_replays_and_update_delete_race_has_one_winner() {
    let f = Fixture::new().await;
    assert_eq!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(false)})
        )
        .await
        .0,
        StatusCode::OK
    );
    let deleted = f
        .call(&f.token, "DELETE", json!({"expected_version":1}))
        .await;
    assert_eq!(deleted.0, StatusCode::OK);
    assert_eq!(deleted.1["version"], 2);
    assert_eq!(deleted.1["envelope"], Value::Null);
    for stale in [0, 1] {
        assert_eq!(
            f.call(
                &f.token,
                "PUT",
                json!({"expected_version":stale,"envelope":envelope(false)})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            f.call(&f.token, "DELETE", json!({"expected_version":stale}))
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(f.read(&f.token).await["version"], 2);
    let (put, delete) = tokio::join!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":2,"envelope":envelope(true)})
        ),
        f.call(&f.token, "DELETE", json!({"expected_version":2}))
    );
    let mut statuses = [put.0.as_u16(), delete.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let current = f.read(&f.token).await;
    assert_eq!(current["version"], 3);
    assert_eq!(
        current["envelope"],
        if put.0 == StatusCode::OK {
            envelope(true)
        } else {
            Value::Null
        }
    );
    assert_eq!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":2,"envelope":envelope(false)})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(f.read(&f.token).await, current);
}

#[tokio::test]
async fn malformed_metadata_and_oversized_bodies_cannot_mutate_or_echo_private_input() {
    let f = Fixture::new().await;
    let mut malformed = Vec::new();
    for (field, value) in [
        ("schema", json!(2)),
        ("algorithm", json!("A128GCM")),
        ("kid", json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
        ("iv", json!("AAAAAAAAAAAAAAA=")),
        ("ciphertext", json!("AAAAAAAAAAAAAAAAAAAAAB==")),
        ("ciphertext", json!("plaintext-not-an-encrypted-envelope")),
    ] {
        let mut bad = envelope(false);
        bad[field] = value;
        malformed.push(json!({"expected_version":0,"envelope":bad}));
    }
    for body in malformed {
        assert_eq!(
            f.call(&f.token, "PUT", body).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for version in [-1_i64, 9_007_199_254_740_991] {
        assert_eq!(
            f.call(
                &f.token,
                "PUT",
                json!({"expected_version":version,"envelope":envelope(false)})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let marker = "PRIVATE-FIELD-MUST-NOT-APPEAR-IN-ERROR";
    for body in [
        json!({"expected_version":0,"envelope":envelope(false),"user_id":f.other}),
        json!({"expected_version":0,"envelope":envelope(false),"plaintext":marker}),
    ] {
        let (status, result) = f.call(&f.token, "PUT", body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!result.to_string().contains(marker));
    }
    assert_eq!(
        f.raw(&f.token, "PUT", "{malformed".into()).await.0,
        StatusCode::BAD_REQUEST
    );
    let huge =
        json!({"expected_version":0,"envelope":envelope(false),"padding":"x".repeat(300*1024)});
    assert_eq!(
        f.call(&f.token, "PUT", huge).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let still_empty = f.read(&f.token).await;
    assert_eq!(still_empty["version"], 0);
    assert_eq!(still_empty["envelope"], Value::Null);
}

#[tokio::test]
async fn foreign_mutations_use_only_authenticated_owner_and_backup_never_creates_memories() {
    let f = Fixture::new().await;
    assert_eq!(
        f.call(
            &f.token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(false)})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.call(&f.foreign, "DELETE", json!({"expected_version":1}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.call(
            &f.foreign,
            "PUT",
            json!({"expected_version":1,"envelope":envelope(true)})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.call(
            &f.foreign,
            "PUT",
            json!({"expected_version":0,"envelope":envelope(true)})
        )
        .await
        .0,
        StatusCode::OK
    );
    let a = f.read(&f.token).await;
    let b = f.read(&f.foreign).await;
    assert_eq!(a["version"], 1);
    assert_eq!(b["version"], 1);
    assert_ne!(a["envelope"], b["envelope"]);
    assert!(f.repo.memories(&f.owner).await.unwrap().is_empty());
    assert!(f.repo.memories(&f.other).await.unwrap().is_empty());
    assert_eq!(
        f.call(&f.foreign, "DELETE", json!({"expected_version":1}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(f.read(&f.token).await, a);
    assert_eq!(f.read(&f.foreign).await["envelope"], Value::Null);
}
