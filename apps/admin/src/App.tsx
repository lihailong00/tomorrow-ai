import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import QRCode from "qrcode";
import {
  ApiError,
  configurationChanges,
  isSessionExpired,
  connectUrl,
  request,
  remainingEdits,
  userLoginIdentity,
  userManagementLabel,
  isValidEmailIdentifier,
  safePublicUrl,
  type Backups,
  type Config,
  type Edit,
  type Session,
  type Setting,
  type ProviderProbe,
  type Status,
  type User,
  type UserPage,
} from "./api";
import { Icon, Orb } from "./icons";
import { ProviderPanel } from "./ProviderPanel";
import { UsagePricePanel } from "./UsagePricePanel";
import { currentService, providerIssue, type Service } from "./providers";

type Page = "overview" | "ai" | "connections" | "users" | "maintenance";
const navigation: {
  id: Page;
  label: string;
  icon: string;
  subtitle: string;
}[] = [
  {
    id: "overview",
    label: "概览",
    icon: "grid",
    subtitle: "让每一份灵感，都有妥善的去处。",
  },
  {
    id: "ai",
    label: "AI 与语音",
    icon: "spark",
    subtitle: "为这台服务器选择合适的思考与表达方式。",
  },
  {
    id: "connections",
    label: "应用连接",
    icon: "link",
    subtitle: "配置平台能力，让用户安全地连接自己的账号。",
  },
  {
    id: "users",
    label: "用户与访问",
    icon: "users",
    subtitle: "管理谁可以使用，以及他们如何加入。",
  },
  {
    id: "maintenance",
    label: "数据与维护",
    icon: "database",
    subtitle: "照顾好数据，也照顾好每一次恢复。",
  },
];
const groupNames: Record<string, string> = {
  instance: "服务器信息",
  general: "服务器信息",
  ai: "对话与思考",
  model: "对话与思考",
  llm: "对话与思考",
  voice: "语音转文字",
  speech: "语音转文字",
  asr: "语音转文字",
  embeddings: "向量检索",
  embedding: "向量检索",
  vision: "图片理解",
  access: "注册与登录",
  auth: "注册与登录",
  sms: "短信认证",
  storage: "文件存储",
  integrations: "平台连接",
  connectors: "平台连接",
  connections: "平台连接",
  search: "联网搜索",
  security: "安全设置",
  limits: "运行与用量限制",
  "connections:GOOGLE": "Google 账号",
  "connections:TENCENT_DOCS": "腾讯文档",
  "connections:WPS": "WPS 文档",
  "connections:FEISHU": "飞书",
  "connections:DINGTALK": "钉钉",
  "connections:AMAP": "高德地图",
  "connections:BAIDU_NETDISK": "百度网盘个人体验",
  "connections:HUAWEI_HEALTH": "华为运动健康",
  "connections:XIAOMI_HEALTH": "小米运动健康",
  "connections:OTHER": "授权凭证保护",
};
const niceGroup = (group: string) => groupNames[group] ?? group;
const isAI = (item: Setting) =>
  /ai|llm|model|voice|speech|asr|embedding|vision|search/.test(
    item.group.toLowerCase()
  );
const isAccess = (item: Setting) =>
  /access|auth|sms|registration|limits/.test(item.group.toLowerCase()) ||
  /REGISTRATION|INVITE|SIGNUP|LOGIN/.test(item.key);
const isGeneral = (item: Setting) =>
  /instance|general|storage|security/.test(item.group.toLowerCase());
const showValue = (value: unknown) =>
  value === undefined || value === null ? "—" : String(value);
const timestamp = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString(
    "zh-CN",
    { hour12: false }
  );
const fileSize = (bytes: number | undefined) =>
  bytes === undefined
    ? "—"
    : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(value);
}

function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button {...props} className={`button button-${variant} ${className}`}>
      {children}
    </button>
  );
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "blue" | "amber";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Empty({
  icon = "link",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={25} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [boot, setBoot] = useState<
    "loading" | "setup" | "login" | "ready" | "error"
  >("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [userPage, setUserPage] = useState({ offset: 0, limit: 100, total: 0, has_more: false });
  const usersOffset = useRef(0);
  const usersRequest = useRef(0);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [accessUser, setAccessUser] = useState<User | null>(null);
  const [passwordChange, setPasswordChange] = useState(false);
  const [createUser, setCreateUser] = useState(false);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const currentEdits = useRef(edits);
  currentEdits.current = edits;
  const activeSession = useRef<Session | null>(session);
  const sessionRefresh = useRef(0);
  activeSession.current = session;

  const synchronizeSession = useCallback(async (expected: Session) => {
    const requestId = ++sessionRefresh.current;
    const refreshed = await request<Session>("/session");
    if (requestId !== sessionRefresh.current || !activeSession.current || activeSession.current.user.id !== expected.user.id) return null;
    if (refreshed.user.id !== expected.user.id) {
      throw new ApiError(401, "admin_identity_changed", "管理账号已变更，请重新登录。");
    }
    activeSession.current = refreshed;
    setSession(refreshed);
    return refreshed;
  }, []);

  const handleError = useCallback(function reportError(err: unknown) {
    if (isSessionExpired(err)) {
      activeSession.current = null;
      ++sessionRefresh.current;
      setSession(null);
      setConfig(null);
      setStatus(null);
      setUsers([]);
      usersOffset.current = 0;
      setUserPage({ offset: 0, limit: 100, total: 0, has_more: false });
      setBackups(null);
      setEdits({});
      setCreateUser(false);
      setResetUser(null);
      setAccessUser(null);
      setPasswordChange(false);
      setNotice("");
      setMenu(false);
      setBoot("login");
      setError("登录已过期，请重新登录。");
    } else {
      setError(
        err instanceof ApiError
          ? err.message
          : "暂时无法连接服务器，请稍后重试。"
      );
      const expected = activeSession.current;
      if (err instanceof ApiError && err.status === 403 && expected) {
        // Refresh the token, but never replay an action that may have effects.
        void synchronizeSession(expected).then(refreshed => {
          if (refreshed && refreshed.csrf_token !== expected.csrf_token) {
            setError("管理会话已同步，请重试刚才的操作。未自动重复提交。");
          }
        }).catch(recoveryError => {
          if (isSessionExpired(recoveryError)) reportError(recoveryError);
        });
      }
    }
  }, [synchronizeSession]);

  const reload = useCallback(
    async (current: Session, offset = usersOffset.current) => {
      const refreshed = await synchronizeSession(current);
      if (!refreshed) return;
      const requestId = ++usersRequest.current;
      const result = await Promise.allSettled([
        request<Status>("/status"),
        refreshed.user.role === "owner"
          ? request<Config>("/config")
          : Promise.resolve(null),
        request<UserPage>(`/users?offset=${offset}&limit=100`),
        refreshed.user.role === "owner"
          ? request<Backups>("/backups")
          : Promise.resolve(null),
      ]);
      if (activeSession.current?.csrf_token !== refreshed.csrf_token) return;
      const [s, c, u, b] = result;
      if (s.status === "fulfilled") setStatus(s.value);
      else handleError(s.reason);
      if (c.status === "fulfilled") setConfig(c.value);
      else handleError(c.reason);
      if (requestId === usersRequest.current) {
        if (u.status === "fulfilled") {
          setUsers(u.value.items);
          usersOffset.current = u.value.offset;
          setUserPage(u.value);
        } else handleError(u.reason);
      }
      if (b.status === "fulfilled") setBackups(b.value);
      else
        setBackups({
          items: [],
          supported: false,
          reason: "备份服务暂不可用，请检查服务器部署配置。",
        });
    },
    [handleError, synchronizeSession]
  );

  const initialize = useCallback(async () => {
    setBoot("loading");
    setError("");
    try {
      const bootstrap = await request<{
        initialized: boolean;
        setup_required: boolean;
      }>("/bootstrap");
      if (!bootstrap.initialized || bootstrap.setup_required) {
        setBoot("setup");
        return;
      }
      try {
        const current = await request<Session>("/session");
        activeSession.current = current;
        setSession(current);
        setBoot("ready");
        await reload(current);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setBoot("login");
        else throw err;
      }
    } catch (err) {
      setBoot("error");
      handleError(err);
    }
  }, [handleError, reload]);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => {
      setCompactNavigation(media.matches);
      if (!media.matches) setMenu(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!compactNavigation || !menu) return;
    const root = sidebar.current;
    const focusable = () => Array.from(root?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),[tabindex='0']") ?? [])
      .filter(item => item.getClientRects().length > 0);
    (root?.querySelector<HTMLElement>("[aria-current='page']") ?? focusable()[0])?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMenu(false); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (menuButton.current?.getClientRects().length) menuButton.current.focus();
    };
  }, [compactNavigation, menu]);
  useEffect(() => {
    const refresh = () => {
      const expected = activeSession.current;
      if (expected && !operationPending.current && document.visibilityState === "visible") {
        void synchronizeSession(expected).catch(handleError);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [handleError, synchronizeSession]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (
      !session ||
      !backups?.items.some((item) =>
        ["queued", "running"].includes(item.status)
      )
    )
      return;
    const timer = window.setInterval(() => {
      void request<Backups>("/backups").then(setBackups).catch(handleError);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [session, backups, handleError]);

  async function operation(action: () => Promise<void>) {
    if (operationPending.current) return false;
    operationPending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }
  function authenticated(current: Session) {
    ++sessionRefresh.current;
    usersOffset.current = 0;
    activeSession.current = current;
    setSession(current);
    setBoot("ready");
    setError("");
    void reload(current);
  }
  async function mutate(path: string, body?: unknown, method = "POST") {
    const current = activeSession.current;
    if (!current) throw new Error("No session");
    return request(path, { method, body, csrf: current.csrf_token });
  }
  async function saveConfiguration(checkOnly = false) {
    if (!session || !config) return;
    const issue = providerIssue(config.settings, edits);
    if (issue) { setError(issue); return; }
    const changes = configurationChanges(config.settings, edits);
    const submittedEdits = edits;
    await operation(async () => {
      const result = await mutate(
        checkOnly ? "/config/check" : "/config",
        { expected_revision: config.revision, changes },
        checkOnly ? "POST" : "PATCH"
      );
      if (checkOnly) {
        const validation = result as {
          valid?: boolean;
          errors?: unknown[];
          warnings?: string[];
          readiness?: Status["readiness"];
        };
        if (validation.valid === false)
          throw new ApiError(
            422,
            "invalid_configuration",
            "配置校验未通过，请检查地址和必填项。"
          );
        const incomplete =
          validation.readiness?.groups.filter(
            (item) => item.status === "incomplete"
          ).length ?? 0;
        setNotice(
          `格式校验通过。${
            incomplete ? `仍有 ${incomplete} 组配置待补齐。` : ""
          }未验证上游连接，未调用计费服务。`
        );
      } else {
        setEdits(current => remainingEdits(current, submittedEdits));
        await reload(session);
        setNotice(Object.keys(currentEdits.current).length ? "本次配置已保存，之后的修改仍待保存。" : "配置已保存，新请求将使用最新配置。");
      }
    });
  }
  async function testProvider(service: Service, signal: AbortSignal): Promise<ProviderProbe> {
    if (!session || !config) throw new Error("请先登录并加载配置");
    const inherited = (service === "vision" || service === "embedding") && currentService(config.settings, edits, service).inherited;
    const selected = config.settings.filter(item => item.group === service || inherited && ["ASR_BASE_URL", "ASR_API_KEY", "ASR_PROTOCOL"].includes(item.key));
    const selectedEdits = Object.fromEntries(selected.filter(item => edits[item.key]).map(item => [item.key, edits[item.key]]));
    const issue = providerIssue(selected, selectedEdits);
    if (issue) throw new ApiError(400, "incomplete_configuration", issue);
    try {
      return await request<ProviderProbe>("/config/test-" + service, {
        method: "POST", csrf: session.csrf_token, signal,
        body: { expected_revision: config.revision, changes: configurationChanges(selected, selectedEdits) },
      });
    } catch (error) {
      if (isSessionExpired(error) || error instanceof ApiError && error.status === 403) handleError(error);
      throw error;
    }
  }
  async function logout() {
    await operation(async () => {
      await mutate("/logout");
      ++sessionRefresh.current;
      activeSession.current = null;
      setSession(null);
      setConfig(null);
      setStatus(null);
      setUsers([]);
      usersOffset.current = 0;
      setUserPage({ offset: 0, limit: 100, total: 0, has_more: false });
      setBackups(null);
      setEdits({});
      setBoot("login");
      setPage("overview");
    });
  }

  if (boot === "loading")
    return (
      <div className="initial-loader">
        <Orb />
        <p>正在连接妥啦服务…</p>
      </div>
    );
  if (boot === "error")
    return (
      <div className="initial-loader">
        <Orb />
        <h2>暂时无法连接服务</h2>
        <p>{error}</p>
        <Button onClick={() => void initialize()}>重新连接</Button>
      </div>
    );
  if (boot === "setup" || boot === "login")
    return (
      <AuthPage
        setup={boot === "setup"}
        onSession={authenticated}
        error={error}
        onError={handleError}
      />
    );

  const selected = navigation.find((item) => item.id === page)!;
  const instanceName = String(
    status?.instance.name ?? status?.instance.instance_name ?? "妥啦服务器"
  );
  const instanceMode = String(
    status?.instance.deployment_mode ??
      status?.instance.mode ??
      config?.settings.find((item) => item.key === "INSTANCE_MODE")?.value ??
      "self_hosted"
  );
  const settings = config?.settings ?? [];
  const filteredSettings =
    page === "ai"
      ? settings.filter(isAI)
      : page === "users"
      ? settings.filter(isAccess)
      : page === "maintenance"
      ? settings.filter((item) => isGeneral(item) && !isAccess(item))
      : settings.filter(
          (item) => !isAI(item) && !isAccess(item) && !isGeneral(item)
        );
  const changeCount = Object.keys(configurationChanges(settings, edits)).length;
  const canManageUser = (user: User) =>
    user.id !== session?.user.id &&
    user.role !== "owner" &&
    (user.role !== "admin" || session?.user.role === "owner");

  return (
    <div className="app-shell">
      <aside ref={sidebar} id="admin-navigation" className={`sidebar ${menu ? "sidebar-open" : ""}`}
        inert={compactNavigation && !menu} aria-hidden={compactNavigation && !menu ? true : undefined}
        role={compactNavigation && menu ? "dialog" : undefined} aria-modal={compactNavigation && menu ? true : undefined}
        aria-label={compactNavigation && menu ? "管理导航" : undefined}>
        <button className="icon-button mobile-drawer-close" aria-label="收起导航" onClick={() => setMenu(false)}><Icon name="close" /></button>
        <a className="brand" href="/admin/" aria-label="妥啦服务管理首页">
          <Orb small />
          <span>
            妥啦<span className="brand-caption">服务管理</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <Icon
              name={instanceMode === "official" ? "cloud" : "shield"}
              size={18}
            />
          </span>
          <div>
            <strong>{instanceName}</strong>
            <small>
              {instanceMode === "official" ? "官方服务" : "自建服务"}
            </small>
          </div>
          <span className="status-dot" />
        </div>
        <p className="nav-caption">工作空间</p>
        <nav aria-label="管理页面">
          {navigation.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setPage(item.id);
                setMenu(false);
              }}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {page === item.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-mark">
            <Icon name="shield" size={19} />
            <div>
              <strong>数据，始终有归处</strong>
              <p>
                连接由用户授权
                <br />
                密钥仅保存在服务器
              </p>
            </div>
          </div>
          <button
            className="account"
            onClick={() => {
              setMenu(false);
              setError("");
              setPasswordChange(true);
            }}
            disabled={busy}
            title="修改我的管理员密码"
          >
            <span className="avatar">
              {session?.user.name?.slice(0, 1) || "管"}
            </span>
            <span>
              <strong>{session?.user.name || "管理员"}</strong>
              <small>管理员</small>
            </span>
            <Icon name="lock" size={17} />
          </button>
        </div>
      </aside>
      {menu && (
        <button
          className="mobile-scrim"
          tabIndex={-1}
          onClick={() => setMenu(false)}
          aria-label="关闭导航"
        />
      )}
      <main className="main-area" inert={compactNavigation && menu}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              ref={menuButton}
              onClick={() => setMenu(true)}
              aria-label="打开导航"
              aria-expanded={menu}
              aria-controls="admin-navigation"
            >
              <Icon name="menu" />
            </button>
            <span>服务管理</span>
            <Icon name="chevron" size={13} />
            <strong>{selected.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className="live-label">
              <span className="status-dot" />
              已连接服务器
            </span>
            <button
              className="icon-button"
              aria-label="刷新服务状态"
              disabled={busy}
              onClick={() => session && void operation(() => reload(session))}
            >
              <Icon name="refresh" className={busy ? "spin" : ""} />
            </button>
            <button
              className="icon-button"
              aria-label="退出管理后台"
              disabled={busy}
              onClick={() => void logout()}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                TADA ·{" "}
                {page === "overview"
                  ? "YOUR PERSONAL SPACE"
                  : "SERVICE CONSOLE"}
              </p>
              <h1>
                {page === "overview" ? "一切，都安排妥啦。" : selected.label}
              </h1>
              <p>{selected.subtitle}</p>
            </div>
            {page === "overview" && (
              <Badge tone="blue">
                {instanceMode === "official" ? "官方服务" : "自建服务"}
              </Badge>
            )}
          </div>
          {error && (
            <div className="alert alert-error" role="alert">
              <Icon name="info" />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="关闭错误提示"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert alert-success" role="status">
              <Icon name="check" />
              <span>{notice}</span>
            </div>
          )}
          {page === "overview" && (
            <Overview
              status={status}
              config={config}
              users={users}
              instanceMode={instanceMode}
              onNavigate={setPage}
              onNotice={setNotice}
            />
          )}
          {(page === "ai" || page === "connections") &&
            session?.user.role !== "owner" && (
              <div className="soft-note">
                <Icon name="lock" />
                <div>
                  <strong>仅实例所有者可以配置服务</strong>
                  <p>模型密钥、平台应用配置和备份由当前服务器的所有者管理。</p>
                </div>
              </div>
            )}
          {(page === "ai" || page === "connections") &&
            session?.user.role === "owner" && (
              <>
                {page === "connections" && (
                  <div className="soft-note">
                    <span className="note-icon">
                      <Icon name="phone" />
                    </span>
                    <div>
                      <strong>手机应用接入，不需要用户申请 Key</strong>
                      <p>
                        通知、主动分享和图片识字由手机端授权。地图等公共服务的 Key 在这里配置；麦当劳、滴滴、腾讯文档、印象笔记等个人凭证由每位用户在客户端“我的连接”中添加，不在此处配置或共用。华为、小米健康服务的应用 ID 与 Secret 在这里配置，每位用户再单独授权自己的健康数据。百度网盘个人体验默认关闭，仅限测试，正式接入需按百度开放平台要求申请。企业应用配置完成后，用户仍需按实际权限授权。
                      </p>
                    </div>
                  </div>
                )}
                {page === "ai" && <DataFlow instance={status?.instance} />}
                <ReadinessPanel
                  readiness={status?.readiness}
                  connections={page === "connections"}
                />
                <SettingsPanel
                  settings={filteredSettings}
                  edits={edits}
                  revision={config?.revision}
                  onTest={page === "ai" ? testProvider : undefined}
                  onEdit={(key, edit) =>
                    setEdits((prev) => ({ ...prev, [key]: edit }))
                  }
                />
                <ConfigBar
                  count={changeCount}
                  busy={busy}
                  onCheck={() => void saveConfiguration(true)}
                  onSave={() => void saveConfiguration()}
                  onDiscard={() => setEdits({})}
                />
                {page === "ai" && session && <UsagePricePanel session={session} configRevision={config?.revision}
                  hasConfigurationEdits={changeCount > 0} onError={handleError} onNotice={setNotice} />}
              </>
            )}
          {page === "users" && (
            <>
              <SettingsPanel
                settings={filteredSettings}
                edits={edits}
                onEdit={(key, edit) =>
                  setEdits((prev) => ({ ...prev, [key]: edit }))
                }
              />
              {filteredSettings.length > 0 && (
                <ConfigBar
                  count={changeCount}
                  busy={busy}
                  onCheck={() => void saveConfiguration(true)}
                  onSave={() => void saveConfiguration()}
                  onDiscard={() => setEdits({})}
                />
              )}
              <section className="card">
                <div className="section-head">
                  <div>
                    <h2>用户</h2>
                    <p>为家人或团队创建账号，或调整已有账号的访问权限。</p>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={busy || session?.user.role !== "owner"}
                    onClick={() => { if (!operationPending.current) setCreateUser(true); }}
                  >
                    <Icon name="plus" size={16} />
                    创建账号
                  </Button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>用户</th>
                        <th>角色</th>
                        <th>状态</th>
                        <th>创建时间</th>
                        <th className="align-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <div className="user-cell">
                              <span className="avatar avatar-soft">
                                {(user.name || userLoginIdentity(user) || "用").slice(0, 1)}
                              </span>
                              <div>
                                <strong>{user.name || "未命名用户"}</strong>
                                <small>{userLoginIdentity(user)}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {user.role === "admin" || user.role === "owner"
                              ? "管理员"
                              : "普通用户"}
                          </td>
                          <td>
                            <Badge tone={user.disabled ? "neutral" : "green"}>
                              {user.disabled ? "已停用" : "正常"}
                            </Badge>
                          </td>
                          <td className="muted">
                            {timestamp(user.created_at)}
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="text-button"
                                disabled={busy || !canManageUser(user)}
                                onClick={() => setResetUser(user)}
                              >
                                重置密码
                              </button>
                              <button
                                className="text-button"
                                disabled={busy || !canManageUser(user)}
                                onClick={() => setAccessUser(user)}
                              >
                                {user.disabled ? "启用" : "停用"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {users.length === 0 && (
                  <Empty icon="users" title="还没有可显示的用户">
                    创建第一个账号后，它会出现在这里。
                  </Empty>
                )}
                <nav className="user-pagination" aria-label="用户分页">
                  <span className="muted">共 {userPage.total} 位用户{users.length > 0 ? ` · 第 ${userPage.offset + 1}–${userPage.offset + users.length} 位` : ""}</span>
                  <div className="row-actions">
                    <Button variant="secondary" disabled={busy || userPage.offset === 0}
                      onClick={() => void operation(() => reload(session!, Math.max(0, userPage.offset - userPage.limit)))}>上一页</Button>
                    <Button variant="secondary" disabled={busy || !userPage.has_more}
                      onClick={() => void operation(() => reload(session!, userPage.offset + userPage.limit))}>下一页</Button>
                  </div>
                </nav>
              </section>
              <div className="footnote">
                <Icon name="shield" size={15} />
                重置密码和停用账号将撤销对应用户的登录会话。管理后台不会展示用户的聊天正文。
              </div>
              <InvitePanel
                session={session!}
                onError={handleError}
                onNotice={setNotice}
              />
            </>
          )}
          {page === "maintenance" && (
            <>
              <SettingsPanel
                settings={filteredSettings}
                edits={edits}
                onEdit={(key, edit) =>
                  setEdits((prev) => ({ ...prev, [key]: edit }))
                }
              />
              {filteredSettings.length > 0 && (
                <ConfigBar
                  count={changeCount}
                  busy={busy}
                  onCheck={() => void saveConfiguration(true)}
                  onSave={() => void saveConfiguration()}
                  onDiscard={() => setEdits({})}
                />
              )}
              {session?.user.role === "owner" && (
                <BackupPanel
                  backups={backups}
                  busy={busy}
                  error={error}
                  onCreate={(passphrase) =>
                    operation(async () => {
                      await mutate("/backups", { passphrase });
                      await reload(session!);
                      setNotice("备份任务已创建，请妥善保管恢复口令。");
                    })
                  }
                  onDelete={(id) =>
                    operation(async () => {
                      await mutate(
                        `/backups/${encodeURIComponent(id)}`,
                        undefined,
                        "DELETE"
                      );
                      await reload(session!);
                      setNotice("已删除这份服务器备份。");
                    })
                  }
                  onError={handleError}
                />
              )}
              <section className="card maintenance-info">
                <div className="section-head">
                  <div>
                    <h2>诊断与恢复</h2>
                    <p>在需要帮助时分享经过脱敏的服务状态。</p>
                  </div>
                </div>
                <div className="maintenance-row">
                  <div className="maintenance-icon">
                    <Icon name="download" />
                  </div>
                  <div>
                    <strong>导出诊断信息</strong>
                    <p>
                      仅包含运行状态与版本，不包含 Key、聊天、附件或用户授权。
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void operation(async () => {
                        const data = await request("/diagnostics");
                        downloadBlob(
                          new Blob([JSON.stringify(data, null, 2)], {
                            type: "application/json",
                          }),
                          "tada-diagnostics.json"
                        );
                      })
                    }
                  >
                    下载诊断
                  </Button>
                </div>
                <div className="maintenance-row">
                  <div className="maintenance-icon">
                    <Icon name="database" />
                  </div>
                  <div>
                    <strong>恢复到另一台服务器</strong>
                    <p>
                      恢复需要停机并在服务器上运行恢复工具。请使用部署包中的恢复说明，并准备备份文件和口令。恢复后重新登录、重新授权外部账号，确认定时任务后再启用。
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}
          <footer className="page-footer">
            <span>妥啦，让想法落在自己的空间。</span>
            <span>
              {status?.instance.version
                ? `v${status.instance.version}`
                : "开源 · 自主部署"}
            </span>
          </footer>
        </div>
      </main>
      {createUser && (
        <UserForm
          title="创建账号"
          error={error}
          onClose={() => { if (!operationPending.current) setCreateUser(false); }}
          onSubmit={(values) =>
            operation(async () => {
              await mutate("/users", values);
              setCreateUser(false);
              await reload(session!);
              setNotice("账号已创建，请通过你信任的方式交付初始密码。");
            })
          }
          busy={busy}
        />
      )}
      {resetUser && (
        <UserForm
          title={`重置 ${userManagementLabel(resetUser)} 的密码`}
          error={error}
          reset
          onClose={() => { if (!operationPending.current) setResetUser(null); }}
          onSubmit={(values) =>
            operation(async () => {
              await mutate(
                `/users/${encodeURIComponent(resetUser.id)}/reset-password`,
                { new_password: values.password }
              );
              setResetUser(null);
              setNotice(`${userManagementLabel(resetUser)} 的密码已重置，该用户需要重新登录。`);
            })
          }
          busy={busy}
        />
      )}
      {accessUser && (
        <Modal title={`${accessUser.disabled ? "启用" : "停用"} ${userManagementLabel(accessUser)}`}
          busy={busy} onClose={() => { if (!operationPending.current) setAccessUser(null); }}>
          <p className="modal-description">
            {accessUser.disabled ? "确认恢复这个账号的访问权限。" : "确认停用这个账号并撤销其登录会话。"}
            <br />登录账号：<strong>{userLoginIdentity(accessUser)}</strong>
          </p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <Button variant="secondary" disabled={busy} onClick={() => { if (!operationPending.current) setAccessUser(null); }}>取消</Button>
            <Button variant={accessUser.disabled ? "primary" : "danger"} disabled={busy}
              onClick={() => void operation(async () => {
                await mutate(`/users/${encodeURIComponent(accessUser.id)}`, { disabled: !accessUser.disabled }, "PATCH");
                setAccessUser(null);
                await reload(session!);
                setNotice(accessUser.disabled ? `已恢复 ${userManagementLabel(accessUser)} 的访问。` : `已停用 ${userManagementLabel(accessUser)} 并撤销会话。`);
              })}>{busy ? "处理中…" : accessUser.disabled ? "确认启用" : "确认停用"}</Button>
          </div>
        </Modal>
      )}
      {passwordChange && (
        <PasswordForm
          error={error}
          busy={busy}
          onClose={() => setPasswordChange(false)}
          onSubmit={(current, password) =>
            operation(async () => {
              const next = (await mutate("/password", {
                current_password: current,
                new_password: password,
              })) as Session;
              setEdits({});
              setPasswordChange(false);
              authenticated(next);
              setNotice("密码已更新，其他管理会话和手机会话已退出。");
            })
          }
        />
      )}
    </div>
  );
}

function PasswordForm({
  error,
  busy,
  onClose,
  onSubmit,
}: {
  error: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (current: string, password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <Modal title="修改我的管理员密码" onClose={onClose}>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== confirmation) return;
          const values = new FormData(event.currentTarget);
          void onSubmit(String(values.get("current_password")), password);
        }}
      >
        <p className="modal-description">
          更新后将撤销其他管理会话和当前账号的手机会话。你会继续登录当前后台。
        </p>
        <label className="field-label">
          当前密码
          <input
            name="current_password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <label className="field-label">
          新密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            placeholder="至少 12 个字符"
          />
        </label>
        <label className="field-label">
          再次输入
          <input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        {confirmation && password !== confirmation && (
          <p className="danger-text input-help">两次输入的密码不一致。</p>
        )}
        <div className="dialog-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            disabled={busy || password.length < 12 || password !== confirmation}
          >
            更新密码
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AuthPage({
  setup,
  onSession,
  error,
  onError,
}: {
  setup: boolean;
  onSession: (session: Session) => void;
  error: string;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLocalError("");
    const data = new FormData(event.currentTarget);
    const body = Object.fromEntries(data.entries());
    if (!isValidEmailIdentifier(String(body.email ?? ""))) {
      setLocalError("请输入有效的邮箱地址。");
      setBusy(false);
      return;
    }
    if (String(body.password).length < 12 && setup) {
      setLocalError("管理员密码至少需要 12 个字符。");
      setBusy(false);
      return;
    }
    try {
      const current = await request<Session>(setup ? "/setup" : "/login", {
        method: "POST",
        body,
      });
      onSession(current);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <a href="/admin/" className="brand">
          <Orb small />
          <span>
            妥啦<span className="brand-caption">服务管理</span>
          </span>
        </a>
        <div className="auth-art">
          <div className="auth-orbit orbit-one" />
          <div className="auth-orbit orbit-two" />
          <Orb />
          <span className="floating-label label-one">
            <Icon name="spark" size={17} />
            想法，随时接住
          </span>
          <span className="floating-label label-two">
            <Icon name="shield" size={17} />
            自己的空间
          </span>
        </div>
        <h1>
          给每一个明天，
          <br />
          留一点从容。
        </h1>
        <p>
          在这里，照顾你的 AI 服务，
          <br />
          也照顾属于你的每一份数据。
        </p>
        <div className="auth-bottom">
          <Icon name="shield" size={17} />
          <span>开源客户端 · 自主部署 · 按需连接</span>
        </div>
      </section>
      <section className="auth-main">
        <div className="auth-card">
          <span className="auth-icon">
            <Icon name={setup ? "spark" : "lock"} size={25} />
          </span>
          <p className="eyebrow">
            {setup ? "WELCOME TO YOUR SPACE" : "WELCOME BACK"}
          </p>
          <h2>{setup ? "创建你的妥啦空间" : "欢迎回来"}</h2>
          <p className="auth-description">
            {setup
              ? "先创建管理员。模型和语音服务，稍后都能在后台配置。"
              : "登录管理后台，让服务保持妥当。"}
          </p>
          {(error || localError) && (
            <div className="alert alert-error" role="alert">
              <Icon name="info" size={17} />
              {localError || error}
            </div>
          )}
          <form onSubmit={(event) => void submit(event)}>
            {setup && (
              <>
                <label className="field-label">
                  初始化凭证
                  <input
                    name="setup_token"
                    type="password"
                    autoComplete="off"
                    required
                    placeholder="在服务器初始化日志中获取"
                  />
                </label>
                <p className="input-help">
                  凭证仅供首次安装使用，不会出现在公开页面。
                </p>
                <label className="field-label">
                  服务器名称
                  <input
                    name="instance_name"
                    maxLength={80}
                    required
                    placeholder="例如：我的妥啦"
                    defaultValue="我的妥啦"
                  />
                </label>
                <label className="field-label">
                  管理员名称
                  <input
                    name="name"
                    maxLength={80}
                    required
                    autoComplete="name"
                    placeholder="如何称呼你"
                  />
                </label>
              </>
            )}
            <label className="field-label">
              管理员邮箱
              <input
                name="email"
                type="text"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="username"
                maxLength={254}
                required
                placeholder="you@example.com"
              />
            </label>
            <label className="field-label">
              {setup ? "设置管理员密码" : "密码"}
              <input
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 12 : undefined}
                maxLength={128}
                required
                placeholder={setup ? "至少 12 个字符" : "请输入密码"}
              />
            </label>
            <Button className="auth-submit" type="submit" disabled={busy}>
              {busy ? "正在处理…" : setup ? "创建空间" : "登录后台"}
              <Icon name="arrow" size={18} />
            </Button>
          </form>
          <div className="auth-hint">
            <Icon name="info" size={16} />
            <p>
              {setup
                ? "无需短信或模型 Key，即可完成初始化。"
                : "管理员账号属于当前服务器，与手机端的普通账号分开管理。"}
            </p>
          </div>
        </div>
        <p className="auth-copyright">TADA · 一个更从容的个人空间</p>
      </section>
    </div>
  );
}

function Overview({
  status,
  config,
  users,
  instanceMode,
  onNavigate,
  onNotice,
}: {
  status: Status | null;
  config: Config | null;
  users: User[];
  instanceMode: string;
  onNavigate: (page: Page) => void;
  onNotice: (text: string) => void;
}) {
  const [qr, setQr] = useState("");
  const [qrFailed, setQrFailed] = useState(false);
  const instance = status?.instance ?? {};
  const url = safePublicUrl(instance) || window.location.origin;
  const connection = connectUrl(
    { ...instance, public_url: url },
    window.location.origin
  );
  useEffect(() => {
    let active = true;
    setQr("");
    setQrFailed(false);
    void QRCode.toDataURL(connection, {
      width: 180,
      margin: 1,
      color: { dark: "#26324d", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active) setQrFailed(true);
      });
    return () => {
      active = false;
    };
  }, [connection]);
  const settings = config?.settings ?? [];
  const hasKey = (pattern: RegExp) =>
    settings.some((item) => pattern.test(item.key) && item.configured);
  const readiness = (id: string) =>
    status?.readiness?.groups.find((item) => item.id === id);
  const model = settings.find(
    (item) =>
      /^(DEEPSEEK_MODEL|LLM_MODEL|MODEL_NAME|AI_MODEL)$/.test(item.key) &&
      String(item.value ?? "").trim()
  )?.value;
  const counts = status?.counts ?? {};
  const serviceEntries = Object.entries(status?.services ?? {});
  return (
    <>
      <div className="overview-grid">
        <section className="welcome-card">
          <div className="welcome-copy">
            <Badge tone="blue">
              <Icon name="shield" size={13} />
              {instanceMode === "official"
                ? "官方服务已就绪"
                : "这是你自己的空间"}
            </Badge>
            <h2>
              连接手机，
              <br />
              让灵感自然发生。
            </h2>
            <p>
              日常交给妥啦，数据留在你选择的地方。
              <br />
              从一次对话、一份记录开始。
            </p>
            <button className="text-button" onClick={() => onNavigate("ai")}>
              管理 AI 能力
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="welcome-visual">
            <div className="visual-ring" />
            <Orb />
            <span className="visual-star">✦</span>
            <span className="visual-dot" />
          </div>
        </section>
        <section className="card phone-card">
          <div className="phone-card-head">
            <span className="square-icon blue">
              <Icon name="phone" />
            </span>
            <div>
              <h2>连接妥啦 App</h2>
              <p>扫一扫，切换到这台服务器</p>
            </div>
          </div>
          <div className="qr-content">
            <div className="qr-frame">
              {qr ? (
                <img
                  src={qr}
                  alt="仅包含服务器地址和标识的连接二维码"
                  width={124}
                  height={124}
                />
              ) : (
                <span className="qr-fallback">
                  {qrFailed ? "请复制地址连接" : "生成中…"}
                </span>
              )}
            </div>
            <div className="qr-instructions">
              <strong>使用手机相机扫码</strong>
              <p>
                打开妥啦，核对服务器后连接。
                <br />
                也可以在 App 设置中粘贴地址。
              </p>
              <Badge>仅连接信息，无密码或密钥</Badge>
            </div>
          </div>
          <div className="copy-field">
            <span title={url}>{url}</span>
            <button
              className="icon-button"
              aria-label="复制服务器地址"
              onClick={() =>
                void copyText(url)
                  .then(() => onNotice("服务器地址已复制。"))
                  .catch(() =>
                    onNotice("浏览器未允许复制，请手动选择服务器地址。")
                  )
              }
            >
              <Icon name="copy" size={16} />
            </button>
          </div>
        </section>
      </div>
      <div className="stats-grid">
        {[
          {
            label: "用户",
            value: counts.users ?? counts.total_users ?? users.length,
            icon: "users",
            detail: "在这片空间相遇",
          },
          {
            label: "任务",
            value: counts.tasks ?? counts.total_tasks,
            icon: "check",
            detail: "把想法一步步落实",
          },
          {
            label: "文件",
            value: counts.uploads ?? counts.files ?? counts.total_uploads,
            icon: "database",
            detail: "妥善保管每份资料",
          },
          {
            label: "配置版本",
            value: config?.revision ?? status?.configuration_revision,
            icon: "refresh",
            detail: "所有服务使用同一份配置",
          },
        ].map((item) => (
          <section className="stat-card" key={item.label}>
            <div>
              <span className="stat-label">{item.label}</span>
              <span className="stat-value">{showValue(item.value)}</span>
              <p>{item.detail}</p>
            </div>
            <span className="stat-icon">
              <Icon name={item.icon} size={21} />
            </span>
          </section>
        ))}
      </div>
      <div className="overview-bottom">
        <section className="card">
          <div className="section-head">
            <div>
              <h2>能力准备好了多少</h2>
              <p>从最需要的开始，其他能力可以稍后连接。</p>
            </div>
            <button className="text-button" onClick={() => onNavigate("ai")}>
              管理
              <Icon name="chevron" size={14} />
            </button>
          </div>
          <div className="capability-list">
            {[
              {
                title: "AI 对话",
                detail: model ? String(model) : "配置模型后即可开始对话",
                configured: readiness("model")
                  ? readiness("model")?.status === "configured"
                  : hasKey(
                      /DEEPSEEK_API_KEY|MODEL_API_KEY|LLM_API_KEY|AI_API_KEY/
                    ),
                icon: "spark",
                page: "ai" as Page,
                color: "blue",
              },
              {
                title: "语音转文字",
                detail: "把随口说出的想法，整理成文字",
                configured: readiness("speech")
                  ? readiness("speech")?.status === "configured"
                  : hasKey(/ASR_API_KEY|DASHSCOPE_API_KEY/),
                icon: "phone",
                page: "ai" as Page,
                color: "purple",
              },
              {
                title: "应用与资料",
                detail: "手机分享入口已支持，云端连接按需配置",
                configured: true,
                icon: "link",
                page: "connections" as Page,
                color: "peach",
              },
            ].map((item) => (
              <button
                className="capability-row"
                key={item.title}
                onClick={() => onNavigate(item.page)}
              >
                <span className={`square-icon ${item.color}`}>
                  <Icon name={item.icon} />
                </span>
                <span className="capability-copy">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <Badge tone={item.configured ? "green" : "neutral"}>
                  {item.configured
                    ? item.page === "connections"
                      ? "手机端可用"
                      : "配置完整"
                    : "待配置"}
                </Badge>
                <Icon name="chevron" size={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="card service-card">
          <div className="section-head">
            <div>
              <h2>服务状态</h2>
              <p>来自当前服务器的实时信息</p>
            </div>
            <span className="tiny-orb" />
          </div>
          <div className="service-list">
            {serviceEntries.length ? (
              serviceEntries.map(([name, value]) => {
                const detail =
                  typeof value === "object" && value !== null
                    ? (value as Record<string, unknown>)
                    : null;
                const state = detail?.status ?? detail?.healthy ?? value;
                const healthy =
                  state === true ||
                  [
                    "ok",
                    "healthy",
                    "ready",
                    "connected",
                    "active",
                    "configured",
                  ].includes(String(state));
                const labels: Record<string, string> = {
                  database: "数据库",
                  postgres: "数据库",
                  pi: "AI 执行服务",
                  agent: "AI 执行服务",
                  worker: "后台任务",
                  storage: "文件存储",
                  api: "接口服务",
                  model: "对话模型",
                  speech: "语音识别",
                  sms: "短信认证",
                };
                return (
                  <div className="service-row" key={name}>
                    <span>{labels[name] ?? name}</span>
                    <span className={healthy ? "service-ok" : "muted"}>
                      <span
                        className={`status-dot ${healthy ? "" : "dot-gray"}`}
                      />
                      {healthy
                        ? state === "configured"
                          ? "已配置"
                          : "运行正常"
                        : state === false
                        ? "暂不可用"
                        : state === "not_configured"
                        ? "待配置"
                        : state === "disabled"
                        ? "已关闭"
                        : state === "aliyun_pnvs"
                        ? "阿里云短信认证"
                        : showValue(state)}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="muted service-empty">正在读取服务状态…</p>
            )}
          </div>
          <div className="service-foot">
            <Icon name="shield" size={16} />
            <span>自建服务不会自动转发到官方服务器</span>
          </div>
        </section>
      </div>
    </>
  );
}

function DataFlow({ instance }: { instance?: Status["instance"] }) {
  const flows = instance?.dataflow as
    | Record<string, { processor?: string; destination?: string | null }>
    | undefined;
  const destination = (key: string) => {
    const flow = flows?.[key];
    if (!flow || flow.processor === "disabled") return "尚未启用";
    if (flow.processor === "this_server") return "当前服务器";
    return flow.destination || "所配置的服务商";
  };
  return (
    <section className="data-flow">
      <div className="data-flow-title">
        <Icon name="shield" size={18} />
        <strong>看清数据的去向</strong>
      </div>
      <div className="data-flow-items">
        <span>
          对话 <strong>{destination("conversation")}</strong>
        </span>
        <span>
          语音 <strong>{destination("voice")}</strong>
        </span>
        <span>
          云端图片理解 <strong>{destination("images")}</strong>
        </span>
        <span>
          向量检索 <strong>{destination("embeddings")}</strong>
        </span>
        <span>
          附件存储 <strong>{destination("files")}</strong>
        </span>
      </div>
      <p>
        自建服务不经过官方业务服务器。使用外部模型或语音服务时，相关内容会发送给你选择的服务商。云端图片理解与向量检索分别由对应模型配置决定。
      </p>
    </section>
  );
}

function ReadinessPanel({
  readiness,
  connections,
}: {
  readiness?: Status["readiness"];
  connections: boolean;
}) {
  const groups =
    readiness?.groups.filter(
      (item) =>
        connections ===
          [
            "tencent_docs",
            "wps",
            "feishu",
            "dingtalk",
            "google",
            "amap",
            "huawei_health",
            "xiaomi_health",
          ].includes(item.id) && item.id !== "sms"
    ) ?? [];
  if (!groups.length) return null;
  const labels: Record<string, string> = {
    configured: "配置完整",
    incomplete: "待补齐",
    disabled: "未启用",
    not_configured: "未配置",
  };
  return (
    <section className="readiness-panel">
      <div className="readiness-title">
        <strong>当前配置准备情况</strong>
        <span>仅检查配置完整度，未验证上游连接</span>
      </div>
      <div className="readiness-items">
        {groups.map((item) => (
          <div key={item.id} title={item.message}>
            <span>{item.label}</span>
            <Badge
              tone={
                item.status === "configured"
                  ? "green"
                  : item.status === "incomplete"
                  ? "amber"
                  : "neutral"
              }
            >
              {labels[item.status] ?? item.status}
            </Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingsPanel({
  settings,
  edits,
  onEdit,
  onTest,
  revision = 0,
}: {
  settings: Setting[];
  edits: Record<string, Edit>;
  onEdit: (key: string, edit: Edit) => void;
  revision?: number;
  onTest?: (service: Service, signal: AbortSignal) => Promise<ProviderProbe>;
}) {
  const groups = useMemo(() => {
    const result = new Map<string, Setting[]>();
    for (const item of settings) {
      if (item.key === "AMAP_WEB_API_KEY") continue;
      const provider = [
        "GOOGLE",
        "TENCENT_DOCS",
        "WPS",
        "FEISHU",
        "DINGTALK",
        "AMAP",
        "BAIDU_NETDISK",
        "HUAWEI_HEALTH",
        "XIAOMI_HEALTH",
      ].find((prefix) => item.key.startsWith(`${prefix}_`));
      const group =
        item.group === "connections"
          ? `connections:${provider ?? "OTHER"}`
          : item.group;
      result.set(group, [...(result.get(group) ?? []), item]);
    }
    return result;
  }, [settings]);
  if (!settings.length)
    return (
      <section className="card">
        <Empty title="这里暂时没有需要配置的项目">
          配置项会由当前版本的服务器提供。
        </Empty>
      </section>
    );
  return (
    <div className="settings-panels">
      {[...groups.entries()].map(([group, items]) => ["model", "speech", "vision", "embedding"].includes(group) ? (
        <ProviderPanel key={group + ":" + revision} service={group as Service} settings={settings} edits={edits}
          onTest={onTest ? signal => onTest(group as Service, signal) : undefined}
          onEdits={(changes) => Object.entries(changes).forEach(([key, edit]) => onEdit(key, edit))} />
      ) : (
        <section className="card" key={group}>
          <div className="section-head">
            <div>
              <h2>{niceGroup(group)}</h2>
              <p>
                {group === "connections:HUAWEI_HEALTH"
                  ? "官方接口地址已内置。请先申请运动健康服务及读取权限；只需配置应用 ID、Secret 和授权凭证加密密钥。回调留空时使用服务器公开地址加 /v1/health/oauth/huawei/callback，并须在华为平台登记同一地址。当前仅开放已核实的步数读取。"
                  : group === "connections:XIAOMI_HEALTH"
                  ? "官方接口地址已内置。请先开通小米账号与运动健康服务并通过数据权限审批。回调留空时使用服务器公开地址加 /v1/health/oauth/xiaomi/callback，并须在小米平台登记同一地址。用户在 App 内分别授权。"
                  : items.some((item) => item.secret)
                  ? "密钥加密保存在服务器，保存后不再回显。"
                  : "按需要调整，保存后对新请求生效。"}
              </p>
            </div>
            <span className="settings-section-icon">
              <Icon
                name={
                  /voice|asr|speech/.test(group)
                    ? "phone"
                    : /ai|model|llm/.test(group)
                    ? "spark"
                    : "link"
                }
                size={20}
              />
            </span>
          </div>
          <div className="settings-grid">
            {items.map((item) => (
              <SettingField
                key={item.key}
                setting={item}
                edit={edits[item.key]}
                onEdit={(edit) => onEdit(item.key, edit)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
function SettingField({
  setting: item,
  edit,
  onEdit,
}: {
  setting: Setting;
  edit?: Edit;
  onEdit: (edit: Edit) => void;
}) {
  const fieldId = `setting-${item.key}`;
  const value =
    edit?.mode === "replace" ? edit.value : String(item.value ?? "");
  const deleting = edit?.mode === "delete";
  const options = item.options?.length
    ? item.options
    : item.kind === "boolean" ||
      typeof item.value === "boolean" ||
      /^(true|false)$/.test(value)
    ? ["true", "false"]
    : undefined;
  const optionNames: Record<string, string> = {
    true: "开启",
    false: "关闭",
    self_hosted: "自建服务",
    official: "官方服务",
    open: "开放注册",
    invite_only: "凭邀请注册",
    closed: "关闭注册",
    disabled: "不启用",
    aliyun_pnvs: "阿里云短信认证",
    openai_transcriptions: "兼容 OpenAI 转写协议",
    qwen_asr: "通义千问语音识别",
  };
  return (
    <div className={`setting-field ${item.locked ? "field-locked" : ""}`}>
      <div className="setting-title">
        <label htmlFor={fieldId}>{item.label || item.key}</label>
        {item.locked ? (
          <Badge>
            <Icon name="lock" size={11} />
            部署配置管理
          </Badge>
        ) : (
          item.secret && item.configured && <Badge tone="green">已配置</Badge>
        )}
      </div>
      {item.secret ? (
        <>
          {edit?.mode === "replace" && !item.locked ? (
            <input
              id={fieldId}
              type="password"
              value={edit.value}
              onChange={(event) =>
                onEdit({ mode: "replace", value: event.target.value })
              }
              autoComplete="new-password"
              placeholder="输入新密钥，留空保留原值"
              maxLength={8192}
            />
          ) : (
            <div
              className={`secret-placeholder ${
                deleting ? "secret-deleting" : ""
              }`}
              id={fieldId}
            >
              <Icon name="lock" size={15} />
              <span>
                {deleting
                  ? "保存后删除"
                  : item.configured
                  ? "••••••••••••••••"
                  : "尚未配置"}
              </span>
              {!item.locked && (
                <button
                  className="text-button"
                  onClick={() => onEdit({ mode: "replace", value: "" })}
                >
                  {deleting ? "改为替换" : item.configured ? "替换" : "添加"}
                </button>
              )}
            </div>
          )}
          {!item.locked && (item.configured || edit) && (
            <div className="field-actions">
              {edit && (
                <button
                  className="text-button muted"
                  onClick={() => onEdit({ mode: "keep", value: "" })}
                >
                  保留现有值
                </button>
              )}
              {item.configured && !deleting && (
                <button
                  className="text-button danger-text"
                  onClick={() => onEdit({ mode: "delete", value: "" })}
                >
                  删除密钥
                </button>
              )}
            </div>
          )}
        </>
      ) : options ? (
        <select
          id={fieldId}
          value={value}
          disabled={item.locked}
          onChange={(event) =>
            onEdit({ mode: "replace", value: event.target.value })
          }
        >
          {!options.includes(value) && (
            <option value={value}>{value || "请选择"}</option>
          )}
          {options.map((option) => (
            <option key={option} value={option}>
              {optionNames[option] ?? option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={fieldId}
          type={
            item.kind === "number"
              ? "number"
              : item.kind === "url"
              ? "url"
              : "text"
          }
          value={value}
          disabled={item.locked}
          onChange={(event) =>
            onEdit({ mode: "replace", value: event.target.value })
          }
          placeholder={item.configured ? undefined : "尚未配置"}
          autoComplete="off"
          maxLength={8192}
        />
      )}
      <p className="input-help">
        {item.description ||
          (item.locked
            ? "由服务器环境变量控制，网页无法覆盖。"
            : item.secret
            ? "仅提交替换值或明确删除操作。"
            : "留空时按服务器配置规则处理。")}
      </p>
      <details className="field-details">
        <summary>配置来源</summary>
        <span>
          {item.key} ·{" "}
          {item.source === "environment" || item.source === "env"
            ? "环境变量"
            : item.source === "default"
            ? "默认值"
            : "后台配置"}
        </span>
      </details>
    </div>
  );
}
function ConfigBar({
  count,
  busy,
  onCheck,
  onSave,
  onDiscard,
}: {
  count: number;
  busy: boolean;
  onCheck: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className={`config-bar ${count ? "config-bar-dirty" : ""}`}>
      <span>
        <Icon name={count ? "info" : "shield"} size={16} />
        {count
          ? `${count} 项修改等待保存`
          : "环境变量优先于后台配置；Key 仅在服务器使用。"}
      </span>
      <div>
        {count > 0 && (
          <Button variant="ghost" onClick={onDiscard} disabled={busy}>
            放弃修改
          </Button>
        )}
        <Button variant="secondary" onClick={onCheck} disabled={busy}>
          校验格式
        </Button>
        <Button onClick={onSave} disabled={busy || !count}>
          {busy ? "处理中…" : "保存配置"}
        </Button>
      </div>
      <small>格式校验不会调用计费接口</small>
    </div>
  );
}

function UserForm({
  title,
  error,
  reset = false,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  error: string;
  reset?: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: {
    email: string;
    name: string;
    password: string;
    role: string;
  }) => Promise<unknown>;
}) {
  const [localError, setLocalError] = useState("");
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      {(localError || error) && (
        <div className="alert alert-error" role="alert">
          {localError || error}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const form = new FormData(event.currentTarget);
          setLocalError("");
          if (!reset && !isValidEmailIdentifier(String(form.get("email") ?? ""))) {
            setLocalError("请输入有效的邮箱地址。");
            return;
          }
          void onSubmit({
            email: String(form.get("email") ?? ""),
            name: String(form.get("name") ?? ""),
            password: String(form.get("password")),
            role: String(form.get("role") ?? "user"),
          });
        }}
      >
        {!reset && (
          <>
            <label className="field-label">
              名称
              <input name="name" required maxLength={80} autoComplete="off" disabled={busy} />
            </label>
            <label className="field-label">
              邮箱
              <input name="email" type="text" inputMode="email" autoCapitalize="none" spellCheck={false}
                maxLength={254} required autoComplete="off" disabled={busy} />
            </label>
            <label className="field-label">
              角色
              <select name="role" defaultValue="user" disabled={busy}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
          </>
        )}
        <label className="field-label">
          {reset ? "新密码" : "初始密码"}
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            placeholder="至少 12 个字符"
            disabled={busy}
          />
        </label>
        <p className="input-help">
          {reset
            ? "保存后将撤销该用户的会话，不会发送短信。"
            : "请使用安全的方式向用户交付账号和密码。"}
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Invite = {
  id: string;
  created_at?: string;
  expires_at: string | number;
  uses_remaining: number;
  invite_code?: string;
};
function InvitePanel({
  session,
  onError,
  onNotice,
}: {
  session: Session;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
}) {
  const [items, setItems] = useState<Invite[]>([]);
  const [created, setCreated] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const response = await request<{ items: Invite[] }>("/invites");
    setItems(response.items);
  }, []);
  useEffect(() => {
    void refresh().catch(onError);
  }, [refresh, onError]);
  async function create() {
    setBusy(true);
    try {
      const item = await request<Invite>("/invites", {
        method: "POST",
        csrf: session.csrf_token,
        body: { expires_in_hours: 72, max_uses: 1 },
      });
      setCreated(item);
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await request(`/invites/${encodeURIComponent(id)}`, {
        method: "DELETE",
        csrf: session.csrf_token,
      });
      await refresh();
      onNotice("邀请已撤销。");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card invite-card">
      <div className="section-head">
        <div>
          <h2>邀请加入</h2>
          <p>邀请模式下使用；每份邀请有效 72 小时，限注册 1 个账号。</p>
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void create()}
        >
          <Icon name="plus" size={16} />
          创建邀请
        </Button>
      </div>
      {items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>到期时间</th>
                <th>剩余次数</th>
                <th className="align-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{timestamp(item.expires_at)}</td>
                  <td>{item.uses_remaining}</td>
                  <td className="align-right">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void remove(item.id)}
                    >
                      撤销邀请
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="users" title="暂无邀请">
          邀请内容仅在创建时显示一次。
        </Empty>
      )}
      {created && (
        <Modal title="邀请已创建" onClose={() => setCreated(null)}>
          <p className="modal-description">
            邀请码只在本次显示。请复制并通过你信任的方式分享，关闭后无法再次查看。
          </p>
          <div className="invite-code">
            <code>{created.invite_code}</code>
            <button
              className="icon-button"
              aria-label="复制邀请码"
              onClick={() =>
                void copyText(created.invite_code ?? "")
                  .then(() => onNotice("邀请码已复制。"))
                  .catch(() => onNotice("请手动复制邀请码。"))
              }
            >
              <Icon name="copy" size={18} />
            </button>
          </div>
          <p className="input-help">
            到期时间：{timestamp(created.expires_at)}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setCreated(null)}>我已保存</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function BackupPanel({
  backups,
  busy,
  error,
  onCreate,
  onDelete,
  onError,
}: {
  backups: Backups | null;
  busy: boolean;
  error: string;
  onCreate: (passphrase: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onError: (err: unknown) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [downloading, setDownloading] = useState("");
  async function download(id: string) {
    setDownloading(id);
    try {
      const response = await fetch(
        `/admin/api/backups/${encodeURIComponent(id)}/download`,
        { credentials: "same-origin", cache: "no-store", redirect: "error" }
      );
      if (!response.ok)
        throw new ApiError(
          response.status,
          "backup_download_failed",
          "备份下载未完成，请稍后重试。"
        );
      downloadBlob(await response.blob(), `tada-backup-${id}.tadabak`);
    } catch (err) {
      onError(err);
    } finally {
      setDownloading("");
    }
  }
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>加密备份</h2>
          <p>把数据库、附件和服务配置一起妥善保管。</p>
        </div>
        <Button
          variant="secondary"
          disabled={busy || !backups?.supported}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={16} />
          创建备份
        </Button>
      </div>
      <div className="backup-note">
        <Icon name="shield" size={18} />
        <p>
          备份包含整个实例和恢复密钥，使用你设置的口令加密。请将文件与口令分开保管，丢失口令将无法恢复。
        </p>
      </div>
      {!backups?.supported ? (
        <Empty icon="database" title="备份暂不可用">
          {backups?.reason || "正在读取备份能力…"}
        </Empty>
      ) : backups.items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>创建时间</th>
                <th>状态</th>
                <th>大小</th>
                <th className="align-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.items.map((item) => (
                <tr key={item.id}>
                  <td>{timestamp(item.created_at)}</td>
                  <td>
                    <Badge
                      tone={
                        item.status === "ready"
                          ? "green"
                          : item.status === "failed"
                          ? "amber"
                          : "blue"
                      }
                    >
                      {{
                        queued: "等待中",
                        running: "备份中",
                        ready: "可下载",
                        failed: "未完成",
                      }[item.status] ?? item.status}
                    </Badge>
                  </td>
                  <td className="muted">{fileSize(item.bytes)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="text-button"
                        disabled={
                          item.status !== "ready" || downloading === item.id
                        }
                        onClick={() => void download(item.id)}
                      >
                        <Icon name="download" size={15} />
                        {downloading === item.id ? "下载中…" : "下载"}
                      </button>
                      <button
                        className="text-button muted"
                        disabled={
                          busy || ["queued", "running"].includes(item.status)
                        }
                        onClick={() => setPendingDelete(item.id)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="database" title="还没有备份">
          在调整重要配置前，先留一份可恢复的副本。
        </Empty>
      )}
      {creating && (
        <Modal
          title="创建加密备份"
          onClose={() => {
            setCreating(false);
            setPassphrase("");
            setConfirmation("");
          }}
        >
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (passphrase !== confirmation) return;
              void onCreate(passphrase).then((success) => {
                if (success) {
                  setPassphrase("");
                  setConfirmation("");
                  setCreating(false);
                }
              });
            }}
          >
            <p className="modal-description">
              恢复口令不会保存在服务器，也无法找回。备份任务会暂时占用服务器资源。
            </p>
            <label className="field-label">
              恢复口令
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                required
                placeholder="至少 12 个字符"
              />
            </label>
            <label className="field-label">
              再次输入
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                required
              />
            </label>
            {confirmation && confirmation !== passphrase && (
              <p className="danger-text input-help">两次输入的口令不一致。</p>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreating(false);
                  setPassphrase("");
                  setConfirmation("");
                }}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || passphrase.length < 12 || passphrase !== confirmation
                }
              >
                开始备份
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {pendingDelete && (
        <Modal title="删除这份备份？" onClose={() => setPendingDelete(null)}>
          <p className="modal-description">
            将删除服务器上的这份备份文件。已经下载到本机的副本不受影响。
          </p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void onDelete(pendingDelete).then((success) => {
                  if (success) setPendingDelete(null);
                })
              }
            >
              删除备份
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
