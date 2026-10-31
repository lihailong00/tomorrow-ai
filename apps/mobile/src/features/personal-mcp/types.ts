export type McpEnvironment = 'production' | 'sandbox' | 'experience';

export interface PersonalMcpConnection {
  id: string;
  name: string;
  description: string;
  help_url: string;
  credential_label: string;
  credential_kind?: 'token';
  transport: string;
  status: 'not_configured' | 'not_connected' | 'connected' | 'needs_reconnect';
  unavailable_reason?: string | null;
  supports_sandbox?: boolean;
  tool_count: number;
  has_credentials?: boolean;
  checked_at?: string | null;
  environment: McpEnvironment;
}

export interface PersonalMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PersonalMcpAction {
  id: string;
  provider: string;
  provider_name: string;
  tool: string;
  arguments: Record<string, unknown>;
  status:
    | 'pending'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'unknown_outcome';
  expires_at: string;
  result?: unknown;
}
