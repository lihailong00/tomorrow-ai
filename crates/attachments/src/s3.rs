//! Optional SDK-backed S3 transport. Ownership is enforced by the module's SQL
//! metadata before any operation reaches this transport.
use std::{path::Path, time::Duration};

use aws_sdk_s3::{
    Client,
    config::{
        Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
        retry::RetryConfig, timeout::TimeoutConfig,
    },
    primitives::ByteStream,
};
use axum::{body::Body, http::StatusCode};

use crate::AttachmentError;

#[derive(Clone)]
pub(crate) struct S3Storage {
    client: Client,
    bucket: String,
    prefix: String,
}

impl S3Storage {
    pub(crate) fn from_env() -> Result<Self, AttachmentError> {
        let required = |key: &str| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| AttachmentError::validation(format!("S3 存储需要配置 {key}")))
        };
        let endpoint = required("S3_ENDPOINT")?;
        let bucket = required("S3_BUCKET")?;
        let access_key = required("S3_ACCESS_KEY_ID")?;
        let secret_key = required("S3_SECRET_ACCESS_KEY")?;
        let region = std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into());
        let session_token = std::env::var("S3_SESSION_TOKEN")
            .ok()
            .filter(|v| !v.is_empty());
        let prefix = std::env::var("S3_PREFIX").unwrap_or_else(|_| "tomorrow-uploads".into());
        let path_style = match std::env::var("S3_FORCE_PATH_STYLE").as_deref() {
            Ok("false") | Ok("0") => false,
            Ok("true") | Ok("1") | Err(_) => true,
            _ => {
                return Err(AttachmentError::validation(
                    "S3_FORCE_PATH_STYLE 须为 true 或 false",
                ));
            }
        };
        Self::configured(
            &endpoint,
            bucket,
            region,
            access_key,
            secret_key,
            session_token,
            prefix,
            path_style,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn configured(
        endpoint: &str,
        bucket: String,
        region: String,
        access_key: String,
        secret_key: String,
        session_token: Option<String>,
        prefix: String,
        path_style: bool,
    ) -> Result<Self, AttachmentError> {
        let url = reqwest::Url::parse(endpoint)
            .map_err(|_| AttachmentError::validation("S3_ENDPOINT 不是有效 URL"))?;
        if !["https", "http"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AttachmentError::validation(
                "S3_ENDPOINT 须为不含凭据、查询参数的 HTTP(S) 地址",
            ));
        }
        if bucket.is_empty()
            || bucket.len() > 63
            || bucket.contains('/')
            || bucket.chars().any(char::is_control)
        {
            return Err(AttachmentError::validation("S3_BUCKET 无效"));
        }
        let prefix = prefix.trim_matches('/').to_owned();
        if prefix.len() > 256
            || prefix.chars().any(char::is_control)
            || prefix.split('/').any(|s| s == ".." || s == ".")
        {
            return Err(AttachmentError::validation("S3_PREFIX 无效"));
        }
        let config = aws_sdk_s3::Config::builder()
            .behavior_version_latest()
            .endpoint_url(endpoint)
            .region(Region::new(region))
            .credentials_provider(Credentials::new(
                access_key,
                secret_key,
                session_token,
                None,
                "tomorrow-env",
            ))
            .force_path_style(path_style)
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .retry_config(RetryConfig::standard().with_max_attempts(2))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .operation_timeout(Duration::from_secs(90))
                    .build(),
            )
            .build();
        Ok(Self {
            client: Client::from_conf(config),
            bucket,
            prefix,
        })
    }

    pub(crate) fn target(&self, id: &str) -> (String, String) {
        let key = if self.prefix.is_empty() {
            id.to_owned()
        } else {
            format!("{}/{id}", self.prefix)
        };
        (self.bucket.clone(), key)
    }

    #[cfg(test)]
    pub(crate) async fn ensure_test_bucket(&self) -> Result<(), AttachmentError> {
        if self
            .client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .is_err()
        {
            self.client
                .create_bucket()
                .bucket(&self.bucket)
                .send()
                .await
                .map_err(|_| unavailable())?;
        }
        Ok(())
    }

    pub(crate) async fn put(
        &self,
        bucket: &str,
        key: &str,
        path: &Path,
        mime: &str,
        size: i64,
    ) -> Result<(), AttachmentError> {
        let body = ByteStream::from_path(path)
            .await
            .map_err(|_| AttachmentError::internal())?;
        self.client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(mime)
            .content_length(size)
            .body(body)
            .send()
            .await
            .map_err(|_| unavailable())?;
        Ok(())
    }

    pub(crate) async fn body(&self, bucket: &str, key: &str) -> Result<Body, AttachmentError> {
        let response = self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| unavailable())?;
        let stream = futures_util::stream::try_unfold(response.body, |mut stream| async move {
            match stream.try_next().await {
                Ok(Some(bytes)) => Ok(Some((bytes, stream))),
                Ok(None) => Ok(None),
                Err(_) => Err(std::io::Error::other("object stream interrupted")),
            }
        });
        Ok(Body::from_stream(stream))
    }

    pub(crate) async fn read(
        &self,
        bucket: &str,
        key: &str,
        limit: u64,
    ) -> Result<Vec<u8>, AttachmentError> {
        let response = self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| unavailable())?;
        if response
            .content_length()
            .is_some_and(|size| size > limit as i64)
        {
            return Err(AttachmentError::too_large());
        }
        let mut stream = response.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.try_next().await.map_err(|_| unavailable())? {
            if bytes.len() as u64 + chunk.len() as u64 > limit {
                return Err(AttachmentError::too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub(crate) async fn delete(&self, bucket: &str, key: &str) -> Result<(), AttachmentError> {
        self.client
            .delete_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| unavailable())?;
        Ok(())
    }
}

fn unavailable() -> AttachmentError {
    AttachmentError::new(
        StatusCode::BAD_GATEWAY,
        "object_storage_unavailable",
        "对象存储请求失败，请检查服务配置或稍后重试",
    )
}
