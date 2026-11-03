use super::{
    runtime::Operation,
    validation::{self, PaymentInput, QueryReceipt},
    PersonalWalletState,
};
use crate::{
    crypto::{digest, random_secret},
    ConnectorError, Result,
};
use axum::http::StatusCode;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use tomorrow_domain::{new_id, now, timestamp};

#[derive(Serialize, Deserialize)]
struct Payload {
    input: PaymentInput,
    confirmation_token: String,
    #[serde(default)]
    receipt: QueryReceipt,
    #[serde(default)]
    launch_url: Option<String>,
}
struct Payment {
    id: String,
    status: String,
    created: i64,
    expires: i64,
    payload: Payload,
}
fn missing() -> ConnectorError {
    ConnectorError::new(
        StatusCode::NOT_FOUND,
        "wallet_payment_not_found",
        "找不到这笔本人交易或付款请求",
    )
}
fn conflict() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "wallet_payment_conflict",
        "付款信息已变化或请求已处理，请刷新后重新核对；系统不会重复付款",
    )
}

impl PersonalWalletState {
    pub(super) async fn initialize_store(&self) -> Result<()> {
        let pool = self.inner.repository.pool();
        for query in [
            "CREATE TABLE IF NOT EXISTS personal_wallet_profile(slot INTEGER PRIMARY KEY,owner TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'not_connected',authorization TEXT NOT NULL DEFAULT '',authorization_expires BIGINT NOT NULL DEFAULT 0,checked_at BIGINT NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS personal_wallet_payments(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,order_key TEXT NOT NULL,argument_hash TEXT NOT NULL,encrypted_payload TEXT NOT NULL,status TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,started_at BIGINT NOT NULL DEFAULT 0,receipt_hash TEXT UNIQUE)",
            "CREATE INDEX IF NOT EXISTS personal_wallet_payment_owner ON personal_wallet_payments(owner,created_at)",
            "CREATE UNIQUE INDEX IF NOT EXISTS personal_wallet_active_order ON personal_wallet_payments(owner,order_key) WHERE status IN ('pending','executing','awaiting_payment','unknown_outcome','paid')",
        ] {sqlx::query(query).execute(&pool).await?;}
        let owner = self
            .inner
            .owner
            .as_ref()
            .ok_or_else(super::not_configured)?;
        sqlx::query("INSERT INTO personal_wallet_profile(slot,owner)VALUES(1,$1)ON CONFLICT(slot)DO NOTHING").bind(owner).execute(&pool).await?;
        let saved: String =
            sqlx::query_scalar("SELECT owner FROM personal_wallet_profile WHERE slot=1")
                .fetch_one(&pool)
                .await?;
        if &saved != owner {
            return Err(conflict());
        }
        Ok(())
    }
    fn seal<T: Serialize>(&self, user: &str, purpose: &str, value: &T) -> Result<String> {
        let data = serde_json::to_vec(value).map_err(|_| ConnectorError::internal())?;
        self.inner
            .crypto
            .as_ref()
            .ok_or_else(super::not_configured)?
            .encrypt(user, "alipay", purpose, &data)
    }
    fn unseal<T: for<'a> Deserialize<'a>>(
        &self,
        user: &str,
        purpose: &str,
        value: &str,
    ) -> Result<T> {
        let data = self
            .inner
            .crypto
            .as_ref()
            .ok_or_else(super::not_configured)?
            .decrypt(user, "alipay", purpose, value)?;
        serde_json::from_slice(&data).map_err(|_| ConnectorError::internal())
    }
    pub(super) async fn cached_status(&self, user: &str) -> Result<String> {
        self.runtime(user)?;
        let status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM personal_wallet_profile WHERE slot=1 AND owner=$1",
        )
        .bind(user)
        .fetch_optional(&self.inner.repository.pool())
        .await?;
        Ok(status.unwrap_or_else(|| "not_connected".into()))
    }
    pub(super) async fn save_status(
        &self,
        user: &str,
        status: &str,
        authorization: Option<&str>,
    ) -> Result<()> {
        // A read-only pending-status check must neither erase an unexpired
        // binding challenge nor extend its lifetime.
        if status == "awaiting_authorization" && authorization.is_none() {
            sqlx::query("UPDATE personal_wallet_profile SET status=$1,checked_at=$2 WHERE slot=1 AND owner=$3")
                .bind(status).bind(now()).bind(user).execute(&self.inner.repository.pool()).await?;
            return Ok(());
        }
        let encoded = authorization
            .map(|link| self.seal(user, "authorization", &link))
            .transpose()?
            .unwrap_or_default();
        sqlx::query("UPDATE personal_wallet_profile SET status=$1,authorization=$2,authorization_expires=$3,checked_at=$4 WHERE slot=1 AND owner=$5")
            .bind(status).bind(encoded).bind(if authorization.is_some(){now()+300}else{0}).bind(now()).bind(user).execute(&self.inner.repository.pool()).await?;
        if status == "needs_reconnect" {
            self.cancel_pending(user).await?;
        }
        Ok(())
    }
    pub(super) async fn saved_authorization(&self, user: &str) -> Result<Option<Value>> {
        let row=sqlx::query("SELECT authorization,authorization_expires FROM personal_wallet_profile WHERE slot=1 AND owner=$1 AND status='awaiting_authorization' AND authorization_expires>$2")
            .bind(user).bind(now()).fetch_optional(&self.inner.repository.pool()).await?;
        let Some(row) = row else { return Ok(None) };
        let link: String = self.unseal(
            user,
            "authorization",
            &row.try_get::<String, _>("authorization")?,
        )?;
        let mut value = self.status(user).await?;
        value["authorization_url"] = json!(link);
        value["expires_in"] =
            json!((row.try_get::<i64, _>("authorization_expires")? - now()).max(0));
        Ok(Some(value))
    }
    pub(super) async fn claim_binding(&self, user: &str) -> Result<()> {
        let changed=sqlx::query("UPDATE personal_wallet_profile SET status='binding',authorization='' WHERE slot=1 AND owner=$1 AND status='awaiting_authorization' AND authorization_expires>$2")
            .bind(user).bind(now()).execute(&self.inner.repository.pool()).await?.rows_affected();
        if changed != 1 {
            return Err(conflict());
        }
        Ok(())
    }
    pub(super) async fn cancel_pending(&self, user: &str) -> Result<()> {
        sqlx::query("UPDATE personal_wallet_payments SET status='cancelled' WHERE owner=$1 AND status='pending'").bind(user).execute(&self.inner.repository.pool()).await?;
        Ok(())
    }
    /// Agent may prepare an intent. No CLI or funds operation occurs here and
    /// the confirmation secret is intentionally absent from the agent result.
    pub async fn prepare_payment(
        &self,
        user: &str,
        mut input: PaymentInput,
        operation_key: &str,
    ) -> Result<Value> {
        self.runtime(user)?;
        input.validate()?;
        if !validation::text(operation_key, 200) {
            return Err(validation::invalid());
        }
        let request_key = digest(&format!("{user}:alipay:{operation_key}"));
        let order_key = digest(&format!("{user}:{}", input.payment_link));
        let argument_hash =
            digest(&serde_json::to_string(&input).map_err(|_| validation::invalid())?);
        let pool = self.inner.repository.pool();
        sqlx::query("UPDATE personal_wallet_payments SET status='expired' WHERE owner=$1 AND status='pending' AND expires_at<=$2").bind(user).bind(now()).execute(&pool).await?;
        if let Some(row)=sqlx::query("SELECT id,argument_hash FROM personal_wallet_payments WHERE owner=$1 AND request_key=$2").bind(user).bind(&request_key).fetch_optional(&pool).await? {
            if row.try_get::<String,_>("argument_hash")?!=argument_hash {return Err(conflict());}
            return self.payment(user,&row.try_get::<String,_>("id")?,false).await;
        }
        // A model retry with a new operation index must still not re-submit an
        // existing/unresolved cashier order. Expired/cancelled intents are safe
        // to recreate because those states can only precede the money call.
        if let Some(existing)=sqlx::query("SELECT id,argument_hash FROM personal_wallet_payments WHERE owner=$1 AND order_key=$2 AND status IN ('pending','executing','awaiting_payment','unknown_outcome','paid') ORDER BY created_at DESC LIMIT 1")
            .bind(user).bind(&order_key).fetch_optional(&pool).await? {
            if existing.try_get::<String,_>("argument_hash")?!=argument_hash {return Err(conflict());}
            return self.payment(user,&existing.try_get::<String,_>("id")?,false).await;
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM personal_wallet_payments WHERE owner=$1 AND created_at>$2",
        )
        .bind(user)
        .bind(now() - 60)
        .fetch_one(&pool)
        .await?;
        if count >= 10 {
            return Err(super::busy());
        }
        let id = new_id();
        let payload = Payload {
            input,
            confirmation_token: random_secret(),
            receipt: QueryReceipt::default(),
            launch_url: None,
        };
        let encrypted = self.seal(user, &format!("payment:{id}"), &payload)?;
        sqlx::query("INSERT INTO personal_wallet_payments(id,owner,request_key,order_key,argument_hash,encrypted_payload,status,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)ON CONFLICT DO NOTHING")
            .bind(&id).bind(user).bind(&request_key).bind(&order_key).bind(&argument_hash).bind(encrypted).bind(now()).bind(now()+600).execute(&pool).await?;
        let row=sqlx::query("SELECT id,argument_hash FROM personal_wallet_payments WHERE owner=$1 AND (request_key=$2 OR (order_key=$3 AND status IN ('pending','executing','awaiting_payment','unknown_outcome','paid'))) ORDER BY created_at DESC LIMIT 1")
            .bind(user).bind(request_key).bind(order_key).fetch_one(&pool).await?;
        if row.try_get::<String, _>("argument_hash")? != argument_hash {
            return Err(conflict());
        }
        self.payment(user, &row.try_get::<String, _>("id")?, false)
            .await
    }
    async fn record(&self, user: &str, id: &str) -> Result<Payment> {
        if !validation::text(id, 80) {
            return Err(validation::invalid());
        }
        self.runtime(user)?;
        let pool = self.inner.repository.pool();
        sqlx::query("UPDATE personal_wallet_payments SET status='unknown_outcome' WHERE owner=$1 AND id=$2 AND status='executing' AND started_at<$3")
            .bind(user).bind(id).bind(now()-60).execute(&pool).await?;
        sqlx::query("UPDATE personal_wallet_payments SET status='expired' WHERE owner=$1 AND id=$2 AND status='pending' AND expires_at<=$3")
            .bind(user).bind(id).bind(now()).execute(&pool).await?;
        let row=sqlx::query("SELECT id,status,created_at,expires_at,encrypted_payload FROM personal_wallet_payments WHERE owner=$1 AND id=$2").bind(user).bind(id).fetch_optional(&pool).await?.ok_or_else(missing)?;
        Ok(Payment {
            id: row.try_get("id")?,
            status: row.try_get("status")?,
            created: row.try_get("created_at")?,
            expires: row.try_get("expires_at")?,
            payload: self.unseal(
                user,
                &format!("payment:{id}"),
                &row.try_get::<String, _>("encrypted_payload")?,
            )?,
        })
    }
    fn view(record: Payment, client: bool) -> Value {
        let mut value = json!({"id":record.id,"title":record.payload.input.title,"merchant":record.payload.input.merchant,"amount":record.payload.input.amount,"currency":"CNY","status":record.status,"created_at":timestamp(record.created),"expires_at":timestamp(record.expires),"requires_confirmation":record.status=="pending","history_scope":"tada_transactions_only"});
        if client && record.status == "pending" {
            value["confirmation_token"] = json!(record.payload.confirmation_token);
        }
        if client
            && matches!(
                record.status.as_str(),
                "awaiting_payment" | "unknown_outcome"
            )
        {
            value["payment_url"] = json!(record.payload.launch_url);
        }
        if record.status == "unknown_outcome" {
            value["message"] =
                json!("暂时无法核实这笔付款。请先在支付宝核对；本请求不会再次提交扣款。");
        }
        value
    }
    pub async fn payment(&self, user: &str, id: &str, client: bool) -> Result<Value> {
        Ok(Self::view(self.record(user, id).await?, client))
    }
    pub async fn cancel_payment(&self, user: &str, id: &str) -> Result<Value> {
        self.runtime(user)?;
        sqlx::query("UPDATE personal_wallet_payments SET status='cancelled' WHERE owner=$1 AND id=$2 AND status='pending'").bind(user).bind(id).execute(&self.inner.repository.pool()).await?;
        self.payment(user, id, true).await
    }
    pub async fn confirm_payment(&self, user: &str, id: &str, token: &str) -> Result<Value> {
        let runtime = self.runtime(user)?;
        let _permit = self
            .inner
            .operations
            .try_acquire()
            .map_err(|_| super::busy())?;
        let record = self.record(user, id).await?;
        if record.status != "pending" {
            return self.payment(user, id, true).await;
        }
        if self.cached_status(user).await? != "connected" {
            return Err(ConnectorError::new(
                StatusCode::CONFLICT,
                "wallet_not_bound",
                "请先在支付宝完成本人授权并检查绑定状态，再核对付款",
            ));
        }
        if token.len() != 43 || digest(token) != digest(&record.payload.confirmation_token) {
            return Err(conflict());
        }
        let claimed=sqlx::query("UPDATE personal_wallet_payments SET status='executing',started_at=$3 WHERE owner=$1 AND id=$2 AND status='pending' AND expires_at>$3")
            .bind(user).bind(id).bind(now()).execute(&self.inner.repository.pool()).await?.rows_affected();
        if claimed != 1 {
            return self.payment(user, id, true).await;
        }
        let input = &record.payload.input;
        let summary = format!(
            "服务内容：{}，支付金额：¥{}，支付对象：{}",
            input.title, input.amount, input.merchant
        );
        let output = runtime
            .execute(Operation::Pay {
                session: id.into(),
                link: input.payment_link.clone(),
                summary,
            })
            .await;
        self.finish(user, record, output).await?;
        self.payment(user, id, true).await
    }
    async fn finish(&self, user: &str, mut record: Payment, output: Result<Value>) -> Result<()> {
        let status = if let Ok(output) = output {
            let new_receipt = QueryReceipt::from_output(&output);
            if new_receipt.available() {
                record.payload.receipt = new_receipt;
            }
            record.payload.launch_url = validation::public_link(&output);
            let mut status = validation::payment_state(&output, &record.payload.receipt);
            if status == "paid" {
                // A generic success code must not create a paid ledger entry.
                // The provider must return an actual matching transaction sum.
                let amount = validation::field(&output, &["totalAmount", "total_amount", "amount"]);
                if amount.and_then(validation::cents)
                    != validation::cents(&record.payload.input.amount)
                {
                    status = "unknown_outcome";
                }
            }
            status
        } else {
            "unknown_outcome"
        };
        let encrypted = self.seal(user, &format!("payment:{}", record.id), &record.payload)?;
        let receipt_hash = record
            .payload
            .receipt
            .order
            .as_ref()
            .map(|order| digest(order));
        let result=sqlx::query("UPDATE personal_wallet_payments SET status=$1,encrypted_payload=$2,receipt_hash=$3 WHERE owner=$4 AND id=$5 AND status IN ('executing','awaiting_payment','unknown_outcome')")
            .bind(status).bind(encrypted).bind(receipt_hash).bind(user).bind(&record.id).execute(&self.inner.repository.pool()).await;
        if result.is_err() {
            sqlx::query("UPDATE personal_wallet_payments SET status='unknown_outcome' WHERE owner=$1 AND id=$2 AND status<>'paid'")
                .bind(user).bind(&record.id).execute(&self.inner.repository.pool()).await?;
        }
        Ok(())
    }
    pub async fn refresh_payment(&self, user: &str, id: &str, client: bool) -> Result<Value> {
        let runtime = self.runtime(user)?;
        let _permit = self
            .inner
            .operations
            .try_acquire()
            .map_err(|_| super::busy())?;
        let record = self.record(user, id).await?;
        if !matches!(
            record.status.as_str(),
            "awaiting_payment" | "unknown_outcome"
        ) || !record.payload.receipt.available()
        {
            return Ok(Self::view(record, client));
        }
        let output = runtime
            .execute(Operation::Query(record.payload.receipt.clone()))
            .await;
        self.finish(user, record, output).await?;
        self.payment(user, id, client).await
    }
    pub async fn transactions(
        &self,
        user: &str,
        from: Option<i64>,
        until: Option<i64>,
        offset: u32,
        limit: u32,
        client: bool,
    ) -> Result<Value> {
        self.runtime(user)?;
        let from = from.unwrap_or(0);
        let until = until.unwrap_or_else(now);
        if from < 0
            || until < from
            || until > now() + 86400
            || offset > 10000
            || !(1..=50).contains(&limit)
        {
            return Err(validation::invalid());
        }
        let pool = self.inner.repository.pool();
        // Stream encrypted rows with bounded result memory. Explicitly report
        // incomplete aggregates rather than silently summing the current page.
        let mut rows=sqlx::query("SELECT id,status,encrypted_payload,created_at,expires_at,started_at FROM personal_wallet_payments WHERE owner=$1 AND created_at>=$2 AND created_at<=$3 ORDER BY created_at DESC,id DESC LIMIT 10001")
            .bind(user).bind(from).bind(until).fetch(&pool);
        let mut items = Vec::new();
        let mut count = 0u32;
        let mut paid = 0;
        let mut total = 0i64;
        while let Some(row) = rows.try_next().await? {
            count += 1;
            if count > 10000 {
                break;
            }
            let id: String = row.try_get("id")?;
            let payload: Payload = self.unseal(
                user,
                &format!("payment:{id}"),
                &row.try_get::<String, _>("encrypted_payload")?,
            )?;
            let mut status: String = row.try_get("status")?;
            let created: i64 = row.try_get("created_at")?;
            let expires: i64 = row.try_get("expires_at")?;
            if status == "pending" && expires <= now() {
                status = "expired".into();
            }
            if status == "executing" && row.try_get::<i64, _>("started_at")? < now() - 60 {
                status = "unknown_outcome".into();
            }
            if status == "paid" {
                paid += 1;
                total +=
                    validation::cents(&payload.input.amount).ok_or_else(validation::invalid)?;
            }
            if count > offset && items.len() < (limit as usize) {
                items.push(Self::view(
                    Payment {
                        id,
                        status,
                        created,
                        expires,
                        payload,
                    },
                    client,
                ));
            }
        }
        let has_more = count > offset + limit && offset + limit < 10000;
        Ok(
            json!({"items":items,"from":from,"until":until,"offset":offset,"limit":limit,"has_more":has_more,"next_offset":if has_more {Some(offset+limit)}else{None},"summary":{"paid_count":paid,"paid_amount":validation::yuan(total),"currency":"CNY","totals_complete":count<=10000},"history_scope":"tada_transactions_only"}),
        )
    }
}
