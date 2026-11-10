export interface Integration {
  id: string;
  name: string;
  category: string;
  mode: 'import' | 'mail' | 'oauth' | 'token' | 'map';
  status: 'available' | 'not_configured' | 'not_connected' | 'connected';
  detail: string;
  import_supported?: boolean;
  notification_supported?: boolean;
  required_configuration?: string[];
  credential_scope?: 'user';
  workspace_name?: string;
}

export interface ImportedContent {
  id: string;
  source_app: string;
  title: string;
  text: string;
  url?: string | null;
  external_id?: string | null;
  created_at: string;
}

export interface ImportContentInput {
  source_app: string;
  title: string;
  text: string;
  url?: string;
  external_id?: string;
}

export interface IntegrationResult {
  id: string;
  title: string;
  text: string;
  url?: string;
}

export interface MailDraft {
  client_request_id: string;
  to: string;
  subject: string;
  body: string;
}

export interface MailReceipt {
  status: 'sent' | 'sending' | 'unknown' | 'failed';
  client_request_id: string;
  detail: string;
}
