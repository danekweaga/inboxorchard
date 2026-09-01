import {
  Activity, Archive, ArrowRight, AtSign, BarChart3, BookOpen, Bot, Box, Braces, Check,
  Camera, ChevronDown, CircleHelp, Cloud, Code2, Database, Download, ExternalLink, FileText, GitBranch,
  Gauge, Inbox, LayoutDashboard, Link2, LoaderCircle, LockKeyhole, LogOut, Mail,
  Menu, MessageCircle, MousePointerClick, Network, PackageOpen, Play, Plus, RefreshCw, Save,
  Search, Send, Settings, ShieldCheck, Sparkles, Tags, TestTube2, Trash2, Upload, Users, Webhook,
  X, Zap, type LucideIcon,
} from "lucide-react";
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MarkerType, MiniMap, Position,
  ReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { AutomationDefinition, AutomationNode, AutomationNodeType, TriggerType } from "../automation/schema";
import { nodeTypes, triggerTypes } from "../automation/schema";
import { api, ApiError, post, put, remove } from "./api";
import { composeGuidedJourney, createGuidedJourney, isGuidedJourney, JOURNEY_IDS, type GuidedJourney, type JourneyToggles } from "./guided-journey";
import { arrangeAutomationNodes, compactLinearAutomation } from "./flow-layout";

type PageKey = "dashboard" | "inbox" | "contacts" | "automations" | "templates" | "simulator" | "content" | "analytics" | "resources" | "email" | "ai" | "integrations" | "settings" | "usage" | "backup";
type Notify = (message: string, kind?: "success" | "error") => void;

interface Bootstrap {
  product: { name: string; version: string; singleTenant: boolean };
  freeMode: boolean;
  mockMode: boolean;
  missingSecrets: string[];
  instagram: { connected: boolean; username?: string | null; accountType?: string | null; accountId?: string | null; expiresInDays?: number; tokenStatus?: string; webhookStatus?: string; error?: string | null };
  capabilities: Array<{ key: string; label: string; state: string; detail: string }>;
}

interface NavItem { key: PageKey; label: string; icon: LucideIcon }
const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: "Workspace", items: [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "inbox", label: "Inbox", icon: Inbox },
    { key: "contacts", label: "Contacts", icon: Users },
  ] },
  { label: "Build", items: [
    { key: "automations", label: "Automations", icon: Zap },
    { key: "templates", label: "Templates", icon: BookOpen },
  ] },
  { label: "Grow", items: [
    { key: "content", label: "Content", icon: Camera },
    { key: "analytics", label: "Analytics", icon: BarChart3 },
    { key: "resources", label: "Resources", icon: PackageOpen },
    { key: "email", label: "Email", icon: Mail },
    { key: "ai", label: "AI Agent", icon: Bot },
  ] },
  { label: "System", items: [
    { key: "integrations", label: "Integrations", icon: Network },
    { key: "settings", label: "Settings", icon: Settings },
    { key: "usage", label: "Usage", icon: Gauge },
    { key: "backup", label: "Backup", icon: Archive },
  ] },
];

export function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<PageKey>(() => pageFromHash());
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" } | null>(null);
  const [templateDraft, setTemplateDraft] = useState<AutomationDefinition | null>(null);

  const notify: Notify = useCallback((message, kind = "success") => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      setBootstrap(await api<Bootstrap>("/bootstrap"));
      setAuth("in");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuth("out");
      else notify(errorMessage(error), "error");
    }
  }, [notify]);

  useEffect(() => {
    api<{ authenticated: boolean }>("/session")
      .then((result) => result.authenticated ? loadBootstrap() : setAuth("out"))
      .catch(() => setAuth("out"));
  }, [loadBootstrap]);

  useEffect(() => {
    const sync = () => setPage(pageFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = (next: PageKey) => {
    window.history.pushState(null, "", `#${next}`);
    setPage(next);
    setMobileNav(false);
  };

  if (auth === "checking") return <FullScreenLoader label="Opening your workspace" />;
  if (auth === "out") return <Login onSuccess={loadBootstrap} notify={notify} />;
  if (!bootstrap) return <FullScreenLoader label="Loading installation status" />;

  const pageProps = { notify };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><MessageCircle size={19} /><Sparkles size={10} /></div>
          <div><strong>Inbox</strong><span>Orchard</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <nav aria-label="Main navigation">
          {navGroups.map((group) => <div className="nav-group" key={group.label}>
            <p>{group.label}</p>
            {group.items.map((item) => <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => navigate(item.key)}>
              <item.icon size={17} /><span>{item.label}</span>
            </button>)}
          </div>)}
        </nav>
        <div className="sidebar-foot">
          <div className="infra-badge"><Cloud size={16} /><div><strong>Self-hosted</strong><span>Single-tenant workspace</span></div></div>
          <button className="ghost full" onClick={async () => { await remove("/session"); setAuth("out"); }}><LogOut size={16} /> Sign out</button>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className={`status-pill ${bootstrap.instagram.connected ? "connected" : ""}`}><span />{bootstrap.instagram.connected ? `@${bootstrap.instagram.username ?? "Instagram connected"}` : "Instagram not connected"}</div>
          <div className="topbar-actions">
            {bootstrap.mockMode && <span className="mock-badge"><TestTube2 size={14} /> Mock mode — no real sends</span>}
            {bootstrap.freeMode && <span className="free-badge">FREE MODE</span>}
            <button className="icon-button" aria-label="Help" title="Documentation"><CircleHelp size={19} /></button>
          </div>
        </header>
        <div className="page-canvas">
          {page === "dashboard" && <Dashboard bootstrap={bootstrap} navigate={navigate} {...pageProps} />}
          {page === "inbox" && <InboxPage {...pageProps} />}
          {page === "contacts" && <ContactsPage {...pageProps} />}
          {page === "automations" && <AutomationsPage initialDefinition={templateDraft} clearInitial={() => setTemplateDraft(null)} {...pageProps} />}
          {page === "templates" && <TemplatesPage applyTemplate={(definition) => { setTemplateDraft(definition); navigate("automations"); }} {...pageProps} />}
          {page === "simulator" && <SimulatorPage {...pageProps} />}
          {page === "content" && <ContentPage {...pageProps} />}
          {page === "analytics" && <AnalyticsPage {...pageProps} />}
          {page === "resources" && <ResourcesPage {...pageProps} />}
          {page === "email" && <EmailPage {...pageProps} />}
          {page === "ai" && <AiPage {...pageProps} />}
          {page === "integrations" && <IntegrationsPage bootstrap={bootstrap} refresh={loadBootstrap} {...pageProps} />}
          {page === "settings" && <SettingsPage bootstrap={bootstrap} {...pageProps} />}
          {page === "usage" && <UsagePage {...pageProps} />}
          {page === "backup" && <BackupPage {...pageProps} />}
        </div>
      </main>
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === "success" ? <Check size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </div>
  );
}

function Login({ onSuccess, notify }: { onSuccess: () => Promise<void>; notify: Notify }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await post("/session", { token }); await onSuccess(); }
    catch (error) { notify(errorMessage(error), "error"); }
    finally { setBusy(false); }
  };
  return <main className="login-screen">
    <section className="login-story">
      <div className="brand-lockup light"><div className="brand-mark"><MessageCircle size={19} /><Sparkles size={10} /></div><div><strong>Inbox</strong><span>Orchard</span></div></div>
      <div className="login-copy"><span className="eyebrow">OWN YOUR AUDIENCE</span><h1>Turn every comment into a real conversation.</h1><p>Open-source Instagram DM automation, built for creators and hosted inside your own Cloudflare account.</p></div>
      <div className="login-flow"><span>COMMENT</span><ArrowRight /><span>CONVERSATION</span><ArrowRight /><span>CONVERSION</span></div>
    </section>
    <section className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <div className="login-icon"><LockKeyhole /></div><span className="eyebrow dark">OWNER ACCESS</span>
        <h2>Welcome back</h2><p>Enter the owner token configured for this installation.</p>
        <label>Owner token<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="••••••••••••" required /></label>
        <button className="primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} Open workspace</button>
        <small>Your token is exchanged for a secure, HTTP-only session cookie and is never stored in the browser.</small>
      </form>
    </section>
  </main>;
}

function Dashboard({ bootstrap, navigate, notify }: { bootstrap: Bootstrap; navigate: (page: PageKey) => void; notify: Notify }) {
  const { data, loading, reload } = useRemote<{ days: number; cards: Record<string, number>; runs: Record<string, number> }>("/dashboard", notify);
  const cards = [
    ["DMs received", "dmsReceived", MessageCircle], ["Automated messages", "automatedMessages", Zap],
    ["Conversations", "conversationsStarted", Inbox], ["Unique contacts", "uniqueContacts", Users],
    ["Links clicked", "linksClicked", MousePointerClick], ["Emails collected", "emailsCollected", AtSign],
    ["Resources delivered", "resourcesDelivered", PackageOpen],
  ] as const;
  return <>
    <PageHeader eyebrow="OVERVIEW" title="Your creator engine" description="The last 30 days, calculated from activity stored in this installation." actions={<button className="secondary" onClick={reload}><RefreshCw size={16} /> Refresh</button>} />
    {!bootstrap.instagram.connected && <SetupBanner missing={bootstrap.missingSecrets} onConnect={() => navigate("integrations")} />}
    <div className="metric-grid">
      {cards.map(([label, key, Icon]) => <article className="metric-card" key={key}><div className="metric-icon"><Icon size={18} /></div><span>{label}</span><strong>{loading ? "—" : formatNumber(data?.cards[key] ?? 0)}</strong><small>Stored in your D1 database</small></article>)}
    </div>
    <div className="split-grid">
      <Panel title="Automation health" subtitle="Runs by current status">
        {!data || Object.keys(data.runs).length === 0 ? <EmptyState icon={Activity} title="No runs yet" text="Publish an automation, then test it in mock mode or wait for an Instagram interaction." action={<button className="secondary" onClick={() => navigate("automations")}>Build an automation</button>} /> :
          <div className="status-list">{Object.entries(data.runs).map(([status, count]) => <div key={status}><span className={`status-dot ${status}`} /> <span>{humanize(status)}</span><strong>{count}</strong></div>)}</div>}
      </Panel>
      <Panel title="Start here" subtitle="Three steps to the first automated conversation">
        <ol className="steps-list">
          <li className={bootstrap.missingSecrets.length ? "" : "done"}><span>{bootstrap.missingSecrets.length ? "1" : <Check size={15} />}</span><div><strong>Configure installation secrets</strong><small>{bootstrap.missingSecrets.length ? `${bootstrap.missingSecrets.length} required value(s) missing` : "Core secrets are present"}</small></div></li>
          <li className={bootstrap.instagram.connected ? "done" : ""}><span>{bootstrap.instagram.connected ? <Check size={15} /> : "2"}</span><div><strong>Connect Instagram</strong><small>{bootstrap.instagram.connected ? `Connected as @${bootstrap.instagram.username}` : "Professional Creator or Business account"}</small></div></li>
          <li><span>3</span><div><strong>Publish your first flow</strong><small>Start from a creator-tested template</small></div></li>
        </ol>
      </Panel>
    </div>
  </>;
}

interface ConversationRow { id: string; username: string | null; display_name: string | null; last_message: string | null; updated_at: number; unread_count: number; source_type: string | null }
interface MessageRow { id: string; direction: string; text: string | null; kind: string; delivery_status: string | null; created_at: number }
interface ContactRow { id: string; username: string | null; display_name: string | null; email: string | null; instagram_user_id: string | null; first_seen_at: number; last_seen_at: number; lead_score: number }
interface ConversationDetail { conversation: ConversationRow & { last_inbound_at?: number | null }; contact: ContactRow; messages: MessageRow[]; tags: Array<{ id: string; name: string; color: string }> }

function InboxPage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<{ conversations: ConversationRow[] }>("/inbox", notify);
  const { data: resourceData } = useRemote<{ resources: ResourceRow[] }>("/resources", notify);
  const { data: automationData } = useRemote<{ automations: AutomationListItem[] }>("/automations", notify);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [quickResource, setQuickResource] = useState("");
  const [manualAutomation, setManualAutomation] = useState("");
  const open = async (id: string) => { setSelected(id); try { setDetail(await api<ConversationDetail>(`/inbox/${id}`)); } catch (error) { notify(errorMessage(error), "error"); } };
  const sendReply = async () => {
    if (!selected || !reply.trim()) return; setSending(true);
    try { await post(`/inbox/${selected}/reply`, { text: reply, idempotencyKey: crypto.randomUUID() }); setReply(""); await open(selected); notify("Reply sent"); }
    catch (error) { notify(errorMessage(error), "error"); } finally { setSending(false); }
  };
  const suggest = async () => {
    if (!selected) return;
    try { const result = await post<{ suggestion: string }>(`/inbox/${selected}/suggest`); setReply(result.suggestion); notify("AI suggestion is ready"); }
    catch (error) { notify(errorMessage(error), "error"); }
  };
  const sendResource = async () => { if (!selected || !quickResource) return; try { await post(`/inbox/${selected}/resource`, { resourceId: quickResource }); await open(selected); notify("Tracked resource sent"); } catch (error) { notify(errorMessage(error), "error"); } };
  const triggerAutomation = async () => { if (!selected || !manualAutomation) return; try { await post(`/inbox/${selected}/trigger`, { automationId: manualAutomation }); await open(selected); notify("Manual automation started"); } catch (error) { notify(errorMessage(error), "error"); } };
  const filtered = (data?.conversations ?? []).filter((item) => `${item.username} ${item.display_name} ${item.last_message}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHeader eyebrow="CONVERSATIONS" title="Inbox" description="Respond personally, inspect context, or let a published workflow continue the conversation." actions={<button className="secondary" onClick={() => { reload(); if (selected) void open(selected); }}><RefreshCw size={16} /> Refresh</button>} />
    <div className="inbox-shell">
      <section className="conversation-list">
        <div className="search-box"><Search size={16} /><input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {loading ? <InlineLoader /> : filtered.length === 0 ? <EmptyState icon={Inbox} title="No conversations yet" text="New Instagram messages and qualifying comments will appear here." /> : filtered.map((item) => <button className={selected === item.id ? "selected" : ""} key={item.id} onClick={() => void open(item.id)}>
          <Avatar name={item.display_name ?? item.username ?? "IG"} /><div><strong>{item.display_name ?? `@${item.username ?? "instagram"}`}</strong><span>{item.last_message ?? "New conversation"}</span></div><time>{relativeTime(item.updated_at)}</time>{item.unread_count > 0 && <b>{item.unread_count}</b>}
        </button>)}
      </section>
      <section className="conversation-view">
        {!detail ? <EmptyState icon={MessageCircle} title="Choose a conversation" text="Message history and creator CRM context will appear here." /> : <>
          <header><Avatar name={detail.contact.display_name ?? detail.contact.username ?? "IG"} /><div><strong>{detail.contact.display_name ?? `@${detail.contact.username}`}</strong><span>{detail.tags.length ? detail.tags.map((tag) => tag.name).join(" · ") : "No tags yet"}</span></div><WindowBadge lastInbound={detail.conversation.last_inbound_at} /></header>
          <div className="message-history">{detail.messages.map((message) => <div className={`message-row ${message.direction}`} key={message.id}><div><p>{message.text ?? `[${message.kind}]`}</p><span>{formatDateTime(message.created_at)} · {message.delivery_status ?? message.direction}</span></div></div>)}</div>
          <div className="composer"><div className="quick-actions"><select aria-label="Quick resource" value={quickResource} onChange={(event) => setQuickResource(event.target.value)}><option value="">Quick resource…</option>{resourceData?.resources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="ghost" disabled={!quickResource} onClick={() => void sendResource()}><PackageOpen size={14} /> Send</button><select aria-label="Manual automation" value={manualAutomation} onChange={(event) => setManualAutomation(event.target.value)}><option value="">Run automation…</option>{automationData?.automations.filter((item) => item.status === "published").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="ghost" disabled={!manualAutomation} onClick={() => void triggerAutomation()}><Play size={14} /> Run</button></div><textarea aria-label="Message" placeholder="Write a reply…" value={reply} onChange={(event) => setReply(event.target.value)} /><div><button className="ghost" onClick={() => void suggest()}><Sparkles size={16} /> Suggest reply</button><button className="primary" disabled={sending || !reply.trim()} onClick={() => void sendReply()}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} Send</button></div></div>
        </>}
      </section>
      <aside className="contact-rail">{detail ? <><span className="eyebrow dark">CONTACT CONTEXT</span><h3>@{detail.contact.username ?? "instagram"}</h3><InfoRow label="Email" value={detail.contact.email ?? "Not captured"} /><InfoRow label="Lead score" value={String(detail.contact.lead_score ?? 0)} /><InfoRow label="First seen" value={formatDate(detail.contact.first_seen_at)} /><InfoRow label="Source" value={detail.conversation.source_type ?? "Instagram DM"} /><div className="tag-row">{detail.tags.map((tag) => <span key={tag.id} style={{ borderColor: tag.color }}>{tag.name}</span>)}</div></> : <p className="muted">Select a conversation to see contact details.</p>}</aside>
    </div>
  </>;
}

interface ContactDetail { contact: ContactRow; tags: Array<{ id: string; name: string; color: string }>; fields: Array<{ id: string; name: string; type: string; value_json: string | null }>; timeline: Array<{ id: string; type: string; summary: string; created_at: number }> }
function ContactsPage({ notify }: { notify: Notify }) {
  const [query, setQuery] = useState("");
  const { data, loading, reload } = useRemote<{ contacts: ContactRow[] }>(`/contacts${query ? `?search=${encodeURIComponent(query)}` : ""}`, notify);
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const open = async (id: string) => { try { setDetail(await api<ContactDetail>(`/contacts/${id}`)); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="CREATOR CRM" title="Contacts" description="See who is engaging, what they shared, and where each conversation stands." actions={<button className="secondary" onClick={reload}><RefreshCw size={16} /> Refresh</button>} />
    <div className="contacts-layout"><Panel className="contact-list-panel" title="Your audience" subtitle={`${data?.contacts.length ?? 0} people · newest activity first`}><div className="search-box wide"><Search size={16} /><input placeholder="Search username, name, or email" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      {loading ? <InlineLoader /> : !data?.contacts.length ? <EmptyState icon={Users} title="No contacts yet" text="Contacts appear automatically when people interact with your connected Instagram account." /> : <div className="contact-card-list">{data.contacts.map((contact) => <button className={detail?.contact.id === contact.id ? "selected" : ""} key={contact.id} onClick={() => void open(contact.id)}><Avatar name={contact.display_name ?? contact.username ?? "IG"} /><span className="contact-card-copy"><strong>{contact.display_name ?? `@${contact.username ?? "instagram"}`}</strong><small>@{contact.username ?? "unknown"}</small><span>{contact.email ? <b className="contact-signal captured">Email captured</b> : <b className="contact-signal">Instagram contact</b>}{contact.lead_score > 0 && <b className="contact-signal lead">Lead · {contact.lead_score}</b>}</span></span><time>{relativeTime(contact.last_seen_at)}</time><ArrowRight size={15} /></button>)}</div>}
    </Panel><Panel className="contact-detail-panel">{!detail ? <EmptyState icon={MousePointerClick} title="Choose a contact" text="Their profile, captured information, tags, and complete activity timeline will appear here." /> : <><div className="contact-profile-hero"><Avatar name={detail.contact.display_name ?? detail.contact.username ?? "IG"} large /><div><span>INSTAGRAM CONTACT</span><h2>{detail.contact.display_name ?? `@${detail.contact.username ?? "instagram"}`}</h2><p>@{detail.contact.username ?? "instagram"}</p></div><b>{detail.contact.lead_score || 0}<small>lead score</small></b></div><div className="contact-stat-grid"><InfoRow label="Email" value={detail.contact.email ?? "Not captured"} /><InfoRow label="First seen" value={formatDate(detail.contact.first_seen_at)} /><InfoRow label="Last active" value={relativeTime(detail.contact.last_seen_at)} /></div><div className="tag-row">{detail.tags.length ? detail.tags.map((tag) => <span key={tag.id} style={{ borderColor: tag.color }}>{tag.name}</span>) : <span>No tags yet</span>}</div>{detail.fields.length > 0 && <div className="field-grid">{detail.fields.map((field) => <InfoRow key={field.id} label={field.name} value={field.value_json ? readableJson(field.value_json) : "Not set"} />)}</div>}<h4 className="section-label">Activity timeline</h4>{detail.timeline.length ? <div className="timeline">{detail.timeline.map((event) => <div key={event.id}><span /><div><strong>{event.summary}</strong><small>{formatDateTime(event.created_at)}</small></div></div>)}</div> : <p className="config-note">No timeline activity has been recorded yet.</p>}</>}</Panel></div>
  </>;
}

interface AutomationListItem { id: string; name: string; description: string | null; status: string; trigger_type: string; updated_at: number; draft_version_id: string | null; published_version_id: string | null }
interface AutomationDetail { automation: AutomationListItem; draft: { version: { id: string; version: number }; definition: AutomationDefinition } | null; published: { version: { id: string; version: number }; definition: AutomationDefinition } | null; history: Array<{ id: string; version: number; status: string; created_at: number }> }

function AutomationsPage({ notify, initialDefinition, clearInitial }: { notify: Notify; initialDefinition: AutomationDefinition | null; clearInitial: () => void }) {
  const { data, loading, reload } = useRemote<{ automations: AutomationListItem[] }>("/automations", notify);
  const [editing, setEditing] = useState<{ id?: string; definition: AutomationDefinition } | null>(initialDefinition ? { definition: initialDefinition } : null);
  const create = async () => { try { const result = await api<{ definition: AutomationDefinition }>("/automations/starter"); setEditing({ definition: result.definition }); } catch (error) { notify(errorMessage(error), "error"); } };
  const edit = async (id: string) => { try { const item = await api<AutomationDetail>(`/automations/${id}`); const definition = item.draft?.definition ?? item.published?.definition; if (definition) setEditing({ id, definition }); } catch (error) { notify(errorMessage(error), "error"); } };
  const saveAsTemplate = async (item: AutomationListItem) => {
    const name = window.prompt("Name this reusable template", `${item.name} template`);
    if (!name?.trim()) return;
    try { await post("/automations/templates", { automationId: item.id, name: name.trim() }); notify("Template saved — find it in My templates"); }
    catch (error) { notify(errorMessage(error), "error"); }
  };
  const renderCards = (items: AutomationListItem[]) => <div className="automation-grid">{items.map((item) => <article className="automation-card" key={item.id}><div className="automation-icon"><Zap size={18} /></div><div className="automation-copy"><div><span className={`status-chip ${item.status}`}>{item.status === "published" ? "active" : item.status}</span><span className="trigger-chip">{humanize(item.trigger_type)}</span></div><h3>{item.name}</h3><p>{item.description || "No description"}</p><small>Updated {relativeTime(item.updated_at)}</small></div><div className="automation-card-actions"><button className="secondary" onClick={() => void saveAsTemplate(item)}><BookOpen size={15} /> Save as template</button><button className="secondary" onClick={() => void edit(item.id)}>Open builder <ArrowRight size={15} /></button></div></article>)}</div>;
  if (editing) return <FlowBuilder initial={editing.definition} automationId={editing.id} onClose={() => { setEditing(null); if (initialDefinition) clearInitial(); reload(); }} notify={notify} />;
  const automations = data?.automations ?? [];
  const activeCampaigns = automations.filter((item) => item.status === "published");
  const otherCampaigns = automations.filter((item) => item.status !== "published");
  return <><PageHeader eyebrow="AUTOMATION STUDIO" title="My automations" description="Build conversations visually, with plain-language controls for every message and decision." actions={<><button className="secondary" onClick={() => { window.location.hash = "simulator"; }}><TestTube2 size={16} /> Test safely</button><button className="primary" onClick={() => void create()}><Plus size={17} /> New automation</button></>} />
    {loading ? <InlineLoader /> : !automations.length ? <Panel><EmptyState icon={Zap} title="No automations yet" text="Start with a template or describe what you want AI to build." action={<div className="button-row"><button className="primary" onClick={() => void create()}><Plus size={16} /> Create automation</button><button className="secondary" onClick={() => { window.location.hash = "templates"; }}><BookOpen size={16} /> Use template</button></div>} /></Panel> : <>
      <section className="automation-section active-campaigns"><div className="automation-section-heading"><div><span className="eyebrow dark">RUNNING NOW</span><h2>Active campaigns</h2><p>These automations are live and listening for Instagram activity.</p></div><b>{activeCampaigns.length}</b></div>{activeCampaigns.length ? renderCards(activeCampaigns) : <div className="automation-section-empty"><Zap size={17} /> No campaigns are active. Publish a draft when you are ready.</div>}</section>
      {otherCampaigns.length > 0 && <section className="automation-section"><div className="automation-section-heading"><div><span className="eyebrow dark">WORKSPACE</span><h2>Drafts & paused campaigns</h2><p>Keep building, review a paused flow, or turn one into a reusable template.</p></div><b>{otherCampaigns.length}</b></div>{renderCards(otherCampaigns)}</section>}
    </>}
  </>;
}

type FlowNode = Node<{ automation: AutomationNode }, "automation">;
const flowNodeTypes = { automation: AutomationFlowNode };
function FlowBuilder({ initial, automationId: initialId, onClose, notify }: { initial: AutomationDefinition; automationId?: string; onClose: () => void; notify: Notify }) {
  const [automationId, setAutomationId] = useState(initialId);
  const [definition, setDefinition] = useState(initial);
  const [nodes, setNodes] = useState<FlowNode[]>(() => compactLinearAutomation(initial.nodes).map(flowNode));
  const [edges, setEdges] = useState<Edge[]>(() => initial.edges.map(flowEdge));
  const [selectedId, setSelectedId] = useState<string | null>(initial.nodes[0]?.id ?? null);
  const [configText, setConfigText] = useState(() => JSON.stringify(initial.nodes[0]?.config ?? {}, null, 2));
  const [issues, setIssues] = useState<Array<{ level: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [builderMode, setBuilderMode] = useState<"simple" | "advanced">(() => window.matchMedia("(max-width: 680px)").matches ? "simple" : "advanced");
  const selected = nodes.find((node) => node.id === selectedId);
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => setEdges((current) => applyEdgeChanges(changes, current)), []);
  const onConnect = useCallback((connection: Connection) => setEdges((current) => addEdge({ ...connection, id: `edge_${crypto.randomUUID()}`, markerEnd: { type: MarkerType.ArrowClosed } }, current)), []);
  const currentDefinition = (): AutomationDefinition => ({ ...definition, startNodeId: definition.startNodeId || nodes[0]?.id || "", nodes: nodes.map((node) => ({ ...node.data.automation, position: node.position })), edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? undefined, label: typeof edge.label === "string" ? edge.label : undefined })) });
  const validate = async () => { try { const result = await post<{ valid: boolean; issues: Array<{ level: string; message: string }> }>("/automations/validate", { definition: currentDefinition() }); setIssues(result.issues); if (result.valid) notify("Workflow is valid"); } catch (error) { notify(errorMessage(error), "error"); } };
  const save = async () => { setBusy(true); try { const result = await post<{ automationId: string; versionId: string; version: number }>("/automations", { automationId, definition: currentDefinition() }); setAutomationId(result.automationId); notify(`Draft v${result.version} saved`); } catch (error) { notify(errorMessage(error), "error"); } finally { setBusy(false); } };
  const saveAsTemplate = async () => {
    const name = window.prompt("Name this reusable template", `${definition.name || "New automation"} template`);
    if (!name?.trim()) return;
    try { await post("/automations/templates", { name: name.trim(), definition: currentDefinition() }); notify("Template saved — find it in My templates"); }
    catch (error) { notify(errorMessage(error), "error"); }
  };
  const publish = async () => { setBusy(true); try { let idValue = automationId; if (!idValue) { const saved = await post<{ automationId: string }>("/automations", { definition: currentDefinition() }); idValue = saved.automationId; setAutomationId(idValue); } await post(`/automations/${idValue}/publish`, {}); notify("Automation published"); } catch (error) { notify(errorMessage(error), "error"); } finally { setBusy(false); } };
  const addNode = (type: AutomationNodeType) => { const newNode: AutomationNode = { id: `${type}_${crypto.randomUUID().slice(0, 8)}`, type, label: humanize(type), position: { x: 180 + nodes.length * 35, y: 180 + nodes.length * 20 }, config: defaultNodeConfig(type) }; setNodes((current) => [...current, flowNode(newNode)]); setSelectedId(newNode.id); setConfigText(JSON.stringify(newNode.config, null, 2)); };
  const updateSelected = (updates: Partial<AutomationNode>) => setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data: { automation: { ...node.data.automation, ...updates } } } : node));
  const updateSelectedConfig = (config: Record<string, unknown>) => { updateSelected({ config }); setConfigText(JSON.stringify(config, null, 2)); };
  const applyConfig = () => { try { const value = JSON.parse(configText) as Record<string, unknown>; updateSelected({ config: value }); notify("Node configuration applied"); } catch { notify("Node configuration must be valid JSON", "error"); } };
  const applyGuidedJourney = (journey: GuidedJourney) => {
    setNodes(journey.nodes.map(flowNode));
    setEdges(journey.edges.map(flowEdge));
    setDefinition((current) => ({ ...current, startNodeId: journey.startNodeId }));
    setSelectedId(JOURNEY_IDS.opening);
    const opening = journey.nodes.find((node) => node.id === JOURNEY_IDS.opening);
    setConfigText(JSON.stringify(opening?.config ?? {}, null, 2));
    setIssues([]);
  };
  const updateJourneyNode = (nodeId: string, updates: Partial<AutomationNode>) => {
    setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, data: { automation: { ...item.data.automation, ...updates } } } : item));
    if (nodeId === selectedId && updates.config) setConfigText(JSON.stringify(updates.config, null, 2));
  };
  const arrangeCompactly = () => {
    const arranged = arrangeAutomationNodes(nodes.map((item) => ({ ...item.data.automation, position: item.position })));
    setNodes(arranged.map(flowNode));
    notify("Nodes arranged compactly — drag any step to personalize the layout");
  };
  const conversationTrigger = ["instagram_comment", "instagram_dm", "keyword", "story_reply", "story_mention"].includes(definition.trigger.type);
  return <div className="builder-page">
    <div className="builder-top"><button className="ghost" onClick={onClose}><ArrowRight className="flip" size={16} /> Automations</button><input className="builder-name" value={definition.name} onChange={(event) => setDefinition((current) => ({ ...current, name: event.target.value }))} aria-label="Campaign name" placeholder="Name this automation campaign" /><div><button className="secondary mode-toggle" onClick={() => setBuilderMode((current) => current === "simple" ? "advanced" : "simple")}>{builderMode === "simple" ? <GitBranch size={16} /> : <Sparkles size={16} />} {builderMode === "simple" ? "Visual builder" : "Simple setup"}</button><button className="secondary" onClick={() => void saveAsTemplate()}><BookOpen size={16} /> Save as template</button><button className="secondary" onClick={() => void validate()}><ShieldCheck size={16} /> Validate</button><button className="secondary" onClick={() => void save()} disabled={busy}><Save size={16} /> Save draft</button><button className="primary" onClick={() => void publish()} disabled={busy}><Zap size={16} /> Publish</button></div></div>
    <div className={`builder-body ${builderMode === "simple" ? "simple-mode" : "advanced-mode"}`}>
      {builderMode === "advanced" && <aside className="node-palette"><span className="eyebrow dark">NODE PALETTE</span><p>Click to add a step</p>{nodeTypes.map((type) => <button key={type} onClick={() => addNode(type)}><NodeIcon type={type} />{humanize(type)}<Plus size={14} /></button>)}</aside>}
      {builderMode === "advanced" && <section className="flow-canvas"><div className="flow-canvas-toolbar"><button className="secondary" type="button" onClick={arrangeCompactly}><GitBranch size={14} /> Arrange compactly</button><span>Drag any node anywhere · Save draft to keep the layout</span></div><ReactFlow nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} nodesDraggable nodesConnectable elementsSelectable onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => { setSelectedId(node.id); setConfigText(JSON.stringify(node.data.automation.config, null, 2)); }} fitView fitViewOptions={{ padding: .12, maxZoom: 1 }} colorMode="light"><Background color="#cbd3df" gap={22} /><MiniMap pannable zoomable /><Controls /></ReactFlow>{issues.length > 0 && <div className="validation-popover"><strong>{issues.filter((issue) => issue.level === "error").length ? "Needs attention" : "Ready to publish"}</strong>{issues.slice(0, 4).map((issue, index) => <p key={`${issue.message}-${index}`} className={issue.level}>{issue.message}</p>)}</div>}</section>}
      <aside className="config-panel"><span className="eyebrow dark">CONFIGURE JOURNEY</span>{builderMode === "advanced" && <div className="builder-guidance"><Sparkles size={16} /><div><strong>Your flow, explained simply</strong><p>Drag nodes into any layout you like, then click a node to edit it. Save the draft to preserve both the flow and your arrangement.</p></div></div>}
        <section className="config-section campaign-details"><h3>Campaign details</h3><label>Campaign name<input value={definition.name} onChange={(event) => setDefinition((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Toolkit comment campaign" /></label><small className="field-help">This name appears in My automations, analytics, and campaign selectors.</small><label>When the same person triggers it again<select value={definition.settings.reentry ?? "once"} onChange={(event) => setDefinition((current) => ({ ...current, settings: { ...current.settings, reentry: event.target.value as "once" | "after_24h" | "every_time" } }))}><option value="once">Only once (recommended)</option><option value="after_24h">Allow again after 24 hours</option><option value="every_time">Every time</option></select></label><small className="field-help">“Only once” prevents repeat comments and button taps from spamming the same person. Failed attempts can retry after five minutes.</small></section>
        <hr />
        <section className="config-section"><h3>1. When this happens</h3><label>Instagram trigger<select value={definition.trigger.type} onChange={(event) => setDefinition((current) => ({ ...current, trigger: { type: event.target.value as TriggerType, config: defaultTriggerConfig(event.target.value as TriggerType) } }))}>{triggerTypes.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}</select></label><TriggerConfigFields trigger={definition.trigger} notify={notify} onChange={(config) => setDefinition((current) => ({ ...current, trigger: { ...current.trigger, config } }))} /></section>
        {conversationTrigger && <><hr /><section className="config-section"><h3>2. DM journey</h3><GuidedDmJourney triggerType={definition.trigger.type} nodes={nodes.map((item) => item.data.automation)} notify={notify} onApply={applyGuidedJourney} onUpdateNode={updateJourneyNode} /></section></>}
        {builderMode === "advanced" && <><hr />{selected ? <section className="config-section"><h3>{conversationTrigger ? "3" : "2"}. Configure selected step</h3><label>Step name<input value={selected.data.automation.label} onChange={(event) => updateSelected({ label: event.target.value })} /></label><label>What this step does<select value={selected.data.automation.type} onChange={(event) => { const type = event.target.value as AutomationNodeType; const config = defaultNodeConfig(type); updateSelected({ type, config }); setConfigText(JSON.stringify(config, null, 2)); }}>{nodeTypes.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}</select></label><NodeConfigFields node={selected.data.automation} notify={notify} onChange={updateSelectedConfig} /><details className="advanced-config"><summary><Braces size={14} /> Advanced JSON</summary><label>Configuration JSON<textarea className="code-input short" value={configText} onChange={(event) => setConfigText(event.target.value)} spellCheck={false} /></label><button className="secondary full" onClick={applyConfig}>Apply advanced configuration</button></details><button className="danger-link" onClick={() => { setNodes((current) => current.filter((node) => node.id !== selectedId)); setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(null); }}><Trash2 size={15} /> Delete step</button></section> : <EmptyState icon={MousePointerClick} title="Select a step" text="Click a step on the canvas to edit its message, resource, or action." />}<hr /><label>Journey starts with<select value={definition.startNodeId} onChange={(event) => setDefinition((current) => ({ ...current, startNodeId: event.target.value }))}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.data.automation.label}</option>)}</select></label></>}
      </aside>
    </div>
  </div>;
}

interface InstagramStory { id: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string }
function StoryTriggerConfig({ trigger, notify, onChange }: { trigger: AutomationDefinition["trigger"]; notify: Notify; onChange: (config: Record<string, unknown>) => void }) {
  const { data, loading, reload } = useRemote<{ stories: InstagramStory[] }>("/instagram/stories", notify);
  const selectedStoryId = Array.isArray(trigger.config.mediaIds) && typeof trigger.config.mediaIds[0] === "string" ? trigger.config.mediaIds[0] : "";
  const selectStory = (storyId: string) => onChange({ ...trigger.config, mediaIds: storyId ? [storyId] : [] });
  return <div className="story-trigger-config">
    <div className="story-trigger-heading"><div><strong>Story source</strong><span>Choose the Story this automation should answer.</span></div><button type="button" className="icon-button" onClick={reload} aria-label="Refresh Stories"><RefreshCw size={14} /></button></div>
    {loading ? <InlineLoader /> : <div className="story-picker">
      <button type="button" className={!selectedStoryId ? "selected" : ""} onClick={() => selectStory("")}><span className="story-all"><Camera size={17} /></span><small>Any active Story</small></button>
      {(data?.stories ?? []).map((story) => {
        const preview = story.thumbnail_url ?? (story.media_type !== "VIDEO" ? story.media_url : undefined);
        return <button type="button" key={story.id} className={selectedStoryId === story.id ? "selected" : ""} onClick={() => selectStory(story.id)} title={story.id}>{preview ? <img src={preview} alt="Instagram Story" /> : <span className="story-all"><Camera size={17} /></span>}<small>{story.timestamp ? new Date(story.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : story.id.slice(-8)}</small></button>;
      })}
    </div>}
    {!loading && !(data?.stories.length) && <p className="story-picker-note">No active Stories were returned. Paste a Story ID below for an expired or unlisted Story.</p>}
    <label>Story ID fallback<input value={selectedStoryId} onChange={(event) => selectStory(event.target.value.trim())} placeholder="All Stories when empty" /></label>
    <small className="story-trigger-help">Only replies or mentions tied to the selected Story will start this automation. Story access still depends on Meta delivering the event.</small>
  </div>;
}

interface InstagramMedia { id: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; caption?: string; timestamp?: string }
type ConfigChange = (config: Record<string, unknown>) => void;

function TriggerConfigFields({ trigger, notify, onChange }: { trigger: AutomationDefinition["trigger"]; notify: Notify; onChange: ConfigChange }) {
  if (trigger.type === "story_reply" || trigger.type === "story_mention") return <StoryTriggerConfig trigger={trigger} notify={notify} onChange={onChange} />;
  if (trigger.type === "instagram_comment") return <><InstagramMediaPicker trigger={trigger} notify={notify} onChange={onChange} /><TextMatchFields config={trigger.config} noun="comment" onChange={onChange} /></>;
  if (trigger.type === "instagram_dm" || trigger.type === "keyword") return <TextMatchFields config={trigger.config} noun="DM" onChange={onChange} />;
  if (trigger.type === "ai_intent") return <div className="guided-fields"><label>Intent name<input value={stringValue(trigger.config.intent)} onChange={(event) => onChange({ ...trigger.config, intent: event.target.value })} placeholder="Wants the free guide" /></label><label>Example messages<textarea value={listText(trigger.config.examples)} onChange={(event) => onChange({ ...trigger.config, examples: parseList(event.target.value) })} placeholder={"Can I get the guide?\nSend me the template"} /></label><label>Minimum confidence<input type="number" min="0" max="1" step="0.05" value={numberValue(trigger.config.confidence, .75)} onChange={(event) => onChange({ ...trigger.config, confidence: Number(event.target.value) })} /></label></div>;
  if (trigger.type === "scheduled") return <div className="guided-fields"><label>Run every (minutes)<input type="number" min="1" value={numberValue(trigger.config.intervalMinutes, 60)} onChange={(event) => onChange({ ...trigger.config, intervalMinutes: Math.max(1, Number(event.target.value)) })} /></label></div>;
  return <p className="config-note">This trigger starts from {humanize(trigger.type)} events. Use Advanced JSON on individual steps only when you need an uncommon setting.</p>;
}

function InstagramMediaPicker({ trigger, notify, onChange }: { trigger: AutomationDefinition["trigger"]; notify: Notify; onChange: ConfigChange }) {
  const { data, loading, reload } = useRemote<{ media: InstagramMedia[] }>("/instagram/media", notify);
  const selected = Array.isArray(trigger.config.mediaIds) ? trigger.config.mediaIds.filter((id): id is string => typeof id === "string") : [];
  const toggle = (id: string) => onChange({ ...trigger.config, mediaIds: selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] });
  return <div className="story-trigger-config media-trigger-config"><div className="story-trigger-heading"><div><strong>Post or Reel</strong><span>Pick one or more pieces of content, or listen to all.</span></div><button type="button" className="icon-button" onClick={reload} aria-label="Refresh Instagram content"><RefreshCw size={14} /></button></div>
    {loading ? <InlineLoader /> : <div className="media-picker"><button type="button" className={!selected.length ? "selected" : ""} onClick={() => onChange({ ...trigger.config, mediaIds: [] })}><span className="media-all"><Camera size={18} /></span><strong>Any post or Reel</strong><small>New and existing content</small></button>{(data?.media ?? []).map((item) => { const preview = item.thumbnail_url ?? (item.media_type !== "VIDEO" ? item.media_url : undefined); return <button type="button" key={item.id} className={selected.includes(item.id) ? "selected" : ""} onClick={() => toggle(item.id)} title={item.caption ?? item.id}>{preview ? <img src={preview} alt="Instagram post or Reel" /> : <span className="media-all"><Camera size={18} /></span>}<span><strong>{item.caption?.trim().slice(0, 46) || humanize(item.media_type ?? "Instagram post")}</strong><small>{item.timestamp ? new Date(item.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : item.id.slice(-8)}</small></span></button>; })}</div>}
    {!loading && !(data?.media.length) && <p className="story-picker-note">No posts or Reels were returned. Reconnect Instagram if this account should have published media.</p>}
    <small className="story-trigger-help">{selected.length ? `${selected.length} selected. Only comments on those items will qualify.` : "Comments on any post or Reel can qualify."}</small>
  </div>;
}

function TextMatchFields({ config, noun, onChange }: { config: Record<string, unknown>; noun: string; onChange: ConfigChange }) {
  const match = isObject(config.match) ? config.match : {};
  const update = (values: Record<string, unknown>) => onChange({ ...config, match: { ...match, ...values } });
  const keywords = Array.isArray(match.include) ? match.include.filter((item): item is string => typeof item === "string") : [];
  return <div className="guided-fields match-fields"><label>Which {noun}s qualify?<select value={stringValue(match.mode, "contains_any")} onChange={(event) => update({ mode: event.target.value })}><option value="contains_any">Contains any keyword</option><option value="contains_all">Contains all keywords</option><option value="exact">Exactly matches</option><option value="starts_with">Starts with</option><option value="contains">Contains phrase</option><option value="regex">Advanced pattern</option></select></label><KeywordListField values={keywords} noun={noun} onChange={(include) => update({ include })} /><label>Ignore when it contains<textarea className="short-textarea" value={listText(match.exclude)} onChange={(event) => update({ exclude: parseList(event.target.value) })} placeholder={"SCAM\nSPAM"} /></label><label className="checkbox-row"><input type="checkbox" checked={match.caseSensitive === true} onChange={(event) => update({ caseSensitive: event.target.checked })} /><span>Match capital letters exactly</span></label></div>;
}

function KeywordListField({ values, noun, onChange }: { values: string[]; noun: string; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const addKeywords = () => {
    const additions = parseList(draft);
    if (!additions.length) return;
    const next = [...values];
    for (const keyword of additions) if (!next.some((item) => item.toLocaleLowerCase() === keyword.toLocaleLowerCase())) next.push(keyword);
    onChange(next);
    setDraft("");
  };
  return <div className="keyword-list-field"><label>Keywords or phrases <span>({values.length} added)</span></label><div className="keyword-entry"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addKeywords(); } }} placeholder="Type a keyword and press Enter" /><button type="button" className="secondary" onClick={addKeywords} disabled={!draft.trim()}><Plus size={14} /> Add</button></div>{values.length > 0 && <div className="keyword-chips">{values.map((keyword) => <button type="button" key={keyword} onClick={() => onChange(values.filter((item) => item !== keyword))} title={`Remove ${keyword}`}><span>{keyword}</span><X size={12} /></button>)}</div>}<small className="field-help">Add as many as you want. You can also paste comma-separated or one-per-line keywords. Leave empty to accept any {noun.toLowerCase()}.</small></div>;
}

function GuidedDmJourney({ triggerType, nodes, notify, onApply, onUpdateNode }: { triggerType: TriggerType; nodes: AutomationNode[]; notify: Notify; onApply: (journey: GuidedJourney) => void; onUpdateNode: (nodeId: string, updates: Partial<AutomationNode>) => void }) {
  if (!isGuidedJourney(nodes)) return <div className="journey-setup"><MessageCircle size={20} /><strong>Add the complete DM funnel</strong><p>Creates the opening DM, follow confirmation, optional email capture, delivery, and thank-you steps for you.</p><button type="button" className="primary full" onClick={() => onApply(createGuidedJourney(triggerType, nodes))}><Sparkles size={15} /> Set up guided DM journey</button><small>This replaces the current canvas in this unsaved draft.</small></div>;
  return <GuidedDmJourneyEditor triggerType={triggerType} nodes={nodes} notify={notify} onApply={onApply} onUpdateNode={onUpdateNode} />;
}

function GuidedDmJourneyEditor({ triggerType, nodes, notify, onApply, onUpdateNode }: { triggerType: TriggerType; nodes: AutomationNode[]; notify: Notify; onApply: (journey: GuidedJourney) => void; onUpdateNode: (nodeId: string, updates: Partial<AutomationNode>) => void }) {
  const { data, loading } = useRemote<{ resources: Array<{ id: string; name: string; type: string }> }>("/resources", notify);
  const nodeById = (nodeId: string) => nodes.find((item) => item.id === nodeId);
  const opening = nodeById(JOURNEY_IDS.opening)!;
  const follow = nodeById(JOURNEY_IDS.follow);
  const email = nodeById(JOURNEY_IDS.email);
  const delivery = nodeById(JOURNEY_IDS.delivery)!;
  const thanks = nodeById(JOURNEY_IDS.thanks);
  const thankDelay = nodeById(JOURNEY_IDS.thankDelay);
  const toggles: JourneyToggles = { follow: Boolean(follow), email: Boolean(email), thanks: Boolean(thanks) };
  const updateConfig = (nodeId: string, values: Record<string, unknown>) => {
    const target = nodeById(nodeId);
    if (target) onUpdateNode(nodeId, { config: { ...target.config, ...values } });
  };
  const recompose = (values: Partial<JourneyToggles>) => onApply(composeGuidedJourney(triggerType, nodes, { ...toggles, ...values }));
  const openingButton = objectAt(opening.config.buttons, 0);
  const followProfileButton = objectAt(follow?.config.buttons, 0);
  const followConfirmButton = objectAt(follow?.config.buttons, 1);
  const publicReply = nodeById(JOURNEY_IDS.publicReply);
  return <div className="journey-editor">
    {publicReply && <div className="journey-stage"><span>PUBLIC REPLY</span><label>Reply variations<textarea value={listText(Array.isArray(publicReply.config.replies) ? publicReply.config.replies : [stringValue(publicReply.config.text)])} onChange={(event) => { const replies = parseList(event.target.value); updateConfig(publicReply.id, { replies, text: replies[0] ?? "" }); }} placeholder={"Sent it 🤝\nCheck your DMs 👀"} /></label></div>}
    <div className="journey-stage"><span>INTRO MESSAGE</span><label>Opening DM<textarea value={stringValue(opening.config.text)} onChange={(event) => updateConfig(opening.id, { text: event.target.value })} /></label><label>Opening button<input value={stringValue(openingButton.title, "Send it")} onChange={(event) => updateConfig(opening.id, { buttons: [{ title: event.target.value, payload: "OPENING_CONFIRMED" }] })} /></label><small className="field-help">The person taps this before the rest of the journey continues.</small></div>
    <div className="journey-stage"><label className="checkbox-row"><input type="checkbox" checked={toggles.follow} onChange={(event) => recompose({ follow: event.target.checked })} /><span><b>They must follow first</b><small>Already-following people skip this automatically</small></span></label>{follow && <><label>Follow prompt<textarea value={stringValue(follow.config.text)} onChange={(event) => updateConfig(follow.id, { text: event.target.value })} /></label><label>Instagram profile URL<input type="url" value={stringValue(followProfileButton.url)} onChange={(event) => updateConfig(follow.id, { buttons: [{ ...followProfileButton, title: stringValue(followProfileButton.title, "Follow me"), url: event.target.value }, followConfirmButton] })} /></label><div className="two-field"><label>Profile button<input value={stringValue(followProfileButton.title, "Follow me")} onChange={(event) => updateConfig(follow.id, { buttons: [{ ...followProfileButton, title: event.target.value }, followConfirmButton] })} /></label><label>Confirmation button<input value={stringValue(followConfirmButton.title, "I’m following")} onChange={(event) => updateConfig(follow.id, { buttons: [followProfileButton, { ...followConfirmButton, title: event.target.value, payload: "FOLLOW_CONFIRMED" }] })} /></label></div><p className="config-note">Inbox Orchard checks Meta’s follower-status field first. Existing followers continue immediately; the confirmation prompt is only shown when they do not follow or Meta cannot return the status.</p></>}</div>
    <div className="journey-stage"><label className="checkbox-row"><input type="checkbox" checked={toggles.email} onChange={(event) => recompose({ email: event.target.checked })} /><span><b>Ask for their email</b><small>Validate and save it to the contact</small></span></label>{email && <label>Email question<textarea value={stringValue(email.config.text)} onChange={(event) => updateConfig(email.id, { text: event.target.value, field: "email" })} /></label>}</div>
    <div className="journey-stage"><span>DELIVERY</span><label>Send<select value={delivery.type === "send_resource" ? "resource" : "message"} onChange={(event) => onUpdateNode(delivery.id, event.target.value === "resource" ? { type: "send_resource", label: "Deliver resource", config: { resourceId: "" } } : { type: "send_text", label: "Delivery message", config: { text: "Here you go 👇" } })}><option value="message">A DM message</option><option value="resource">A saved resource</option></select></label>{delivery.type === "send_resource" ? <label>Resource<select value={stringValue(delivery.config.resourceId)} onChange={(event) => updateConfig(delivery.id, { resourceId: event.target.value })} disabled={loading}><option value="">{loading ? "Loading resources…" : "Choose a resource"}</option>{data?.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {humanize(resource.type)}</option>)}</select></label> : <label>Final delivery message<textarea value={stringValue(delivery.config.text)} onChange={(event) => updateConfig(delivery.id, { text: event.target.value })} /></label>}</div>
    <div className="journey-stage"><label className="checkbox-row"><input type="checkbox" checked={toggles.thanks} onChange={(event) => recompose({ thanks: event.target.checked })} /><span><b>Send a thank-you message</b><small>Optional delayed follow-up</small></span></label>{thanks && thankDelay && <><label>Wait before sending (minutes)<input type="number" min="1" max="43200" value={Math.max(1, Math.round(numberValue(thankDelay.config.seconds, 2700) / 60))} onChange={(event) => updateConfig(thankDelay.id, { seconds: Math.max(60, Number(event.target.value) * 60) })} /></label><label>Thank-you message<textarea value={stringValue(thanks.config.text)} onChange={(event) => updateConfig(thanks.id, { text: event.target.value })} /></label></>}</div>
  </div>;
}

function objectAt(value: unknown, index: number): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  return isObject(value[index]) ? value[index] : {};
}

function NodeConfigFields({ node, notify, onChange }: { node: AutomationNode; notify: Notify; onChange: ConfigChange }) {
  const config = node.config;
  switch (node.type) {
    case "send_text": return <MessageField label="DM message" value={stringValue(config.text)} placeholder="Here’s the link you asked for…" onChange={(text) => onChange({ ...config, text })} />;
    case "public_comment_reply": return <PublicReplyFields config={config} onChange={onChange} />;
    case "send_buttons": return <ButtonMessageFields config={config} onChange={onChange} />;
    case "send_resource": return <ResourceFields config={config} notify={notify} onChange={onChange} />;
    case "ask_question": return <QuestionFields config={config} onChange={onChange} />;
    case "send_email": return <EmailActionFields config={config} notify={notify} onChange={onChange} />;
    case "send_image": return <div className="guided-fields"><label>Public image URL<input type="url" value={stringValue(config.url)} onChange={(event) => onChange({ ...config, url: event.target.value })} placeholder="https://…" /></label></div>;
    case "delay": return <div className="guided-fields"><label>Wait (seconds)<input type="number" min="1" max={30 * 86400} value={numberValue(config.seconds, 60)} onChange={(event) => onChange({ ...config, seconds: Number(event.target.value) })} /></label><small className="field-help">Examples: 3600 = one hour, 86400 = one day.</small></div>;
    case "condition": return <div className="guided-fields"><label>Saved answer name<input value={stringValue(config.field)} onChange={(event) => onChange({ ...config, field: event.target.value })} /></label><label>Comparison<select value={stringValue(config.operator, "equals")} onChange={(event) => onChange({ ...config, operator: event.target.value })}><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="exists">Has any value</option><option value="greater_than">Is greater than</option><option value="less_than">Is less than</option></select></label>{config.operator !== "exists" && <label>Value<input value={stringValue(config.value)} onChange={(event) => onChange({ ...config, value: event.target.value })} /></label>}</div>;
    case "wait_for_response": return <div className="guided-fields"><label>Save reply as<input value={stringValue(config.field, "answer")} onChange={(event) => onChange({ ...config, field: event.target.value })} /></label></div>;
    case "notify_owner": return <MessageField label="Internal notification" value={stringValue(config.text)} placeholder="A new lead replied" onChange={(text) => onChange({ ...config, text })} />;
    case "goal_reached": return <div className="guided-fields"><label>Goal name<input value={stringValue(config.goal, "converted")} onChange={(event) => onChange({ ...config, goal: event.target.value })} /></label></div>;
    case "end": return <p className="config-note">This ends the journey. No message is sent.</p>;
    case "ai_reply": return <p className="config-note">The configured AI Agent will draft a grounded reply when this step runs.</p>;
    default: return <p className="config-note">This advanced action is available. Open Advanced JSON below to configure its provider-specific fields.</p>;
  }
}

function MessageField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) { return <div className="guided-fields"><label>{label}<textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label><small className="field-help">You can use variables such as {"{{email}}"} or {"{{incoming_text}}"}.</small></div>; }

function PublicReplyFields({ config, onChange }: { config: Record<string, unknown>; onChange: ConfigChange }) {
  const replies = Array.isArray(config.replies) ? config.replies : stringValue(config.text) ? [stringValue(config.text)] : [];
  return <div className="guided-fields"><label>Public replies<textarea value={listText(replies)} onChange={(event) => { const values = parseList(event.target.value); onChange({ ...config, replies: values, text: values[0] ?? "" }); }} placeholder={"Got you — check your DMs\nJust sent it 👀\nIt should be in your inbox now"} /></label><small className="field-help">One reply per line. Inbox Orchard rotates them consistently to make replies feel less repetitive.</small></div>;
}

function ButtonMessageFields({ config, onChange }: { config: Record<string, unknown>; onChange: ConfigChange }) {
  const buttons = Array.isArray(config.buttons) ? config.buttons.filter(isObject) : [];
  const updateButton = (index: number, values: Record<string, unknown>) => onChange({ ...config, buttons: buttons.map((button, buttonIndex) => buttonIndex === index ? { ...button, ...values } : button) });
  return <div className="guided-fields"><label>Opening DM<textarea value={stringValue(config.text)} onChange={(event) => onChange({ ...config, text: event.target.value })} placeholder="I got you — tap below and I’ll send it 👇" /></label><span className="mini-heading">Buttons (up to 3)</span>{buttons.map((button, index) => <div className="button-editor" key={index}><input value={stringValue(button.title)} onChange={(event) => updateButton(index, { title: event.target.value })} placeholder="Button label" /><input value={stringValue(button.url)} onChange={(event) => updateButton(index, { url: event.target.value, payload: event.target.value ? undefined : stringValue(button.payload) })} placeholder="Optional https:// link" /><button type="button" className="icon-button danger" onClick={() => onChange({ ...config, buttons: buttons.filter((_item, buttonIndex) => buttonIndex !== index) })} aria-label="Remove button"><Trash2 size={14} /></button></div>)}<button type="button" className="secondary full" disabled={buttons.length >= 3} onClick={() => onChange({ ...config, buttons: [...buttons, { title: "Send it", payload: `BUTTON_${buttons.length + 1}` }] })}><Plus size={14} /> Add button</button></div>;
}

function ResourceFields({ config, notify, onChange }: { config: Record<string, unknown>; notify: Notify; onChange: ConfigChange }) {
  const { data, loading } = useRemote<{ resources: Array<{ id: string; name: string; type: string }> }>("/resources", notify);
  return <div className="guided-fields"><label>Resource to send<select value={stringValue(config.resourceId)} onChange={(event) => onChange({ ...config, resourceId: event.target.value })} disabled={loading}><option value="">{loading ? "Loading resources…" : "Choose a saved resource"}</option>{data?.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {humanize(resource.type)}</option>)}</select></label>{!loading && !data?.resources.length && <p className="config-warning">Add a link or file in Resources before publishing this step.</p>}<small className="field-help">The recipient gets a tracked link so clicks can appear in Analytics.</small></div>;
}

function QuestionFields({ config, onChange }: { config: Record<string, unknown>; onChange: ConfigChange }) {
  const field = stringValue(config.field, "answer");
  return <div className="guided-fields"><label>Question sent in DM<textarea value={stringValue(config.text)} onChange={(event) => onChange({ ...config, text: event.target.value })} placeholder="What email should I send it to?" /></label><label>Save their answer as<select value={field === "email" ? "email" : "custom"} onChange={(event) => onChange({ ...config, field: event.target.value === "email" ? "email" : "answer" })}><option value="email">Email address</option><option value="custom">Another answer</option></select></label>{field !== "email" && <label>Answer name<input value={field} onChange={(event) => onChange({ ...config, field: event.target.value })} placeholder="company_size" /></label>}<small className="field-help">Email answers are validated and saved directly to the contact before the next step runs.</small></div>;
}

function EmailActionFields({ config, notify, onChange }: { config: Record<string, unknown>; notify: Notify; onChange: ConfigChange }) {
  const { data, loading } = useRemote<EmailOverview>("/email", notify);
  return <div className="guided-fields"><label>Email template<select value={stringValue(config.templateId)} onChange={(event) => onChange({ ...config, templateId: event.target.value })} disabled={loading}><option value="">{loading ? "Loading templates…" : "Choose a template"}</option>{data?.templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.subject}</option>)}</select></label><label>Sender<select value={stringValue(config.senderId)} onChange={(event) => onChange({ ...config, senderId: event.target.value || undefined })} disabled={loading}><option value="">Use default connected sender</option>{data?.senders.filter((sender) => sender.status === "connected").map((sender) => <option key={sender.id} value={sender.id}>{sender.display_name || sender.email} · {sender.provider}</option>)}</select></label><label>Recipient<input value={stringValue(config.recipient)} onChange={(event) => onChange({ ...config, recipient: event.target.value })} placeholder="Uses captured contact email" /></label><small className="field-help">Leave recipient empty after an email-capture question; the saved contact email is used automatically.</small>{!loading && !data?.templates.length && <p className="config-warning">Create an Email template before publishing this step.</p>}</div>;
}

function defaultTriggerConfig(type: TriggerType): Record<string, unknown> {
  if (["instagram_comment", "instagram_dm", "keyword"].includes(type)) return { match: { mode: "contains_any", include: [], exclude: [], caseSensitive: false }, ...(type === "instagram_comment" ? { mediaIds: [] } : {}) };
  if (type === "story_reply" || type === "story_mention") return { mediaIds: [] };
  if (type === "ai_intent") return { intent: "", examples: [], confidence: .75 };
  if (type === "scheduled") return { intervalMinutes: 60 };
  return {};
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function listText(value: unknown): string { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : ""; }
function parseList(value: string): string[] { return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean); }

interface TemplateItem { id: string; name: string; description: string | null; category: string; definition: AutomationDefinition; custom: boolean }
function TemplatesPage({ notify, applyTemplate }: { notify: Notify; applyTemplate: (definition: AutomationDefinition) => void }) {
  const { data, loading, reload } = useRemote<{ templates: TemplateItem[] }>("/automations/templates", notify);
  const deleteTemplate = async (template: TemplateItem) => { if (!window.confirm(`Delete the saved template “${template.name}”?`)) return; try { await remove(`/automations/templates/${template.id}`); reload(); notify("Template deleted"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="TEMPLATE LIBRARY" title="Starter & saved templates" description="Reuse your best Trial Reel campaigns or start with a creator-tested workflow." />
    {loading ? <InlineLoader /> : <div className="template-grid">{(data?.templates ?? []).map((template, index) => <article className={`template-card accent-${index % 4}`} key={template.id}><div><span>{template.custom ? "MY TEMPLATE" : template.category}</span><div className="template-card-icons"><NodeIcon type={template.definition.nodes[0]?.type ?? "end"} />{template.custom && <button className="icon-button danger" aria-label={`Delete ${template.name}`} onClick={() => void deleteTemplate(template)}><Trash2 size={14} /></button>}</div></div><h3>{template.name || template.definition.name}</h3><p>{template.description || template.definition.description}</p><div className="mini-flow">{template.definition.nodes.slice(0, 4).map((node, nodeIndex) => <span key={node.id}>{humanize(node.type)}{nodeIndex < Math.min(3, template.definition.nodes.length - 1) && <ArrowRight size={12} />}</span>)}</div><button className="secondary full" onClick={() => applyTemplate(structuredClone(template.definition))}>Use this template <ArrowRight size={15} /></button></article>)}</div>}
  </>;
}

function SimulatorPage({ notify }: { notify: Notify }) {
  const { data } = useRemote<{ automations: AutomationListItem[] }>("/automations", notify);
  const [automationId, setAutomationId] = useState("");
  const [definition, setDefinition] = useState<AutomationDefinition | null>(null);
  const [incoming, setIncoming] = useState("yo, can I get the guide?");
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ status: string; events: Array<{ nodeId?: string; type: string; summary: string }>; issues: Array<{ level: string; message: string }>; waitingNodeId?: string } | null>(null);
  const select = async (id: string) => { setAutomationId(id); if (!id) { setDefinition(null); return; } try { const item = await api<AutomationDetail>(`/automations/${id}`); setDefinition(item.draft?.definition ?? item.published?.definition ?? null); setResult(null); } catch (error) { notify(errorMessage(error), "error"); } };
  const run = async () => { if (!definition) return; try { setResult(await post("/automations/simulate", { definition, incomingText: incoming, responses })); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="OPTIONAL SAFE TEST" title="Test a flow before publishing" description="Useful when a flow has buttons, waits, or branches. It previews the path without messaging a real person or calling an external service." actions={<><button className="secondary" onClick={() => { window.location.hash = "automations"; }}><ArrowRight className="flip" size={16} /> Automations</button><button className="primary" disabled={!definition} onClick={() => void run()}><Play size={16} /> Run test</button></>} />
    <div className="simulator-layout"><Panel title="Test user" subtitle="Choose a draft and provide the incoming message"><label>Automation<select value={automationId} onChange={(event) => void select(event.target.value)}><option value="">Choose an automation</option>{data?.automations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Incoming message<textarea value={incoming} onChange={(event) => setIncoming(event.target.value)} /></label>{result?.waitingNodeId && <label>Test-user response<input value={responses[result.waitingNodeId] ?? ""} onChange={(event) => setResponses((current) => ({ ...current, [result.waitingNodeId!]: event.target.value }))} placeholder="Type the test user's reply, then run again" /></label>}<div className="safe-callout"><ShieldCheck size={18} /><div><strong>External actions are disabled</strong><span>The simulator only evaluates structured workflow data in memory.</span></div></div></Panel>
      <Panel title="Execution trace" subtitle={result ? `Simulation ${result.status}` : "Run a workflow to see each decision"}>{!result ? <EmptyState icon={TestTube2} title="Ready when you are" text="The trace will show matched nodes, pauses, branches, validation errors, and generated messages." /> : <><div className="trace-list">{result.events.map((step, index) => <div key={`${step.nodeId ?? step.type}-${index}`}><span>{index + 1}</span><div><strong>{humanize(step.type)}</strong><p>{step.summary}</p><small>{step.nodeId ?? "workflow"}</small></div></div>)}</div>{result.issues.length > 0 && <div className="issue-list">{result.issues.map((issue, index) => <p className={issue.level} key={`${issue.message}-${index}`}>{issue.message}</p>)}</div>}</>}</Panel></div>
  </>;
}

interface ContentRow { id: string; media_type: string | null; caption: string | null; permalink: string | null; thumbnail_url: string | null; media_url: string | null; timestamp: number | null; comments_count: number | null; dm_conversations: number; leads: number; clicks: number }
function ContentPage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<{ content: ContentRow[]; syncWarning?: string | null }>("/content", notify);
  return <><PageHeader eyebrow="CONTENT PERFORMANCE" title="Posts & Reels" description="Your recent Instagram content, refreshed from Meta and connected to the conversations and results it created." actions={<button className="secondary" onClick={reload}><RefreshCw size={16} /> Refresh from Instagram</button>} />
    {data?.syncWarning && <div className="content-sync-warning"><CircleHelp size={17} /><span><strong>Showing saved content</strong>{data.syncWarning}</span></div>}
    {loading ? <Panel><InlineLoader /></Panel> : !data?.content.length ? <Panel><EmptyState icon={Camera} title="No Instagram content found" text="Publish a post or Reel, then refresh. Inbox Orchard will pull its preview and connect future comments and DMs to it." /></Panel> : <div className="content-grid">{data.content.map((item) => { const preview = item.thumbnail_url ?? (item.media_type === "IMAGE" || item.media_type === "CAROUSEL_ALBUM" ? item.media_url : null); const body = <>{preview ? <img src={preview} alt="" /> : <span className="content-placeholder"><Camera size={24} /></span>}<span className="content-type">{item.media_type === "UNKNOWN" ? "Awaiting Meta details" : humanize(item.media_type ?? "Instagram")}</span>{item.permalink && <span className="content-open"><ExternalLink size={14} /></span>}</>; return <article className="content-card" key={item.id}>{item.permalink ? <a className="content-preview" href={item.permalink} target="_blank" rel="noreferrer" aria-label="Open on Instagram">{body}</a> : <div className="content-preview">{body}</div>}<div className="content-card-copy"><h3>{item.caption?.trim().slice(0, 110) || (item.media_type === "UNKNOWN" ? "Content referenced by an Instagram event" : `Untitled ${humanize(item.media_type ?? "post")}`)}</h3><p>{item.timestamp ? formatDate(item.timestamp) : `Media ID ${item.id}`}</p></div><div className="content-metrics"><span><strong>{item.comments_count ?? "—"}</strong><small>Comments</small></span><span><strong>{item.dm_conversations}</strong><small>DMs</small></span><span><strong>{item.leads}</strong><small>Leads</small></span><span><strong>{item.clicks}</strong><small>Clicks</small></span></div></article>; })}</div>}
  </>;
}

function AnalyticsPage({ notify }: { notify: Notify }) {
  const { data, loading } = useRemote<{ cards: Record<string, number>; runs: Record<string, number> }>("/dashboard?days=30", notify);
  const totalRuns = Object.values(data?.runs ?? {}).reduce((sum, value) => sum + value, 0);
  const completed = data?.runs.completed ?? 0;
  return <><PageHeader eyebrow="MEASUREMENT" title="Analytics" description="First-party performance from messages, workflow runs, clicks, resources, and captured contact data." />
    <div className="analytics-hero"><div><span>LAST 30 DAYS</span><h2>{loading ? "—" : formatNumber(totalRuns)}</h2><p>Automation runs</p></div><div className="completion-ring" style={{ "--value": `${totalRuns ? Math.round(completed / totalRuns * 100) : 0}%` } as CSSProperties}><strong>{totalRuns ? Math.round(completed / totalRuns * 100) : 0}%</strong><span>completed</span></div></div>
    <div className="metric-grid compact">{Object.entries(data?.cards ?? {}).map(([key, value]) => <article className="metric-card" key={key}><span>{humanize(key)}</span><strong>{formatNumber(value)}</strong></article>)}</div>
    <Panel title="What is measured" subtitle="Transparent, local attribution"><div className="measure-grid"><Measure icon={MessageCircle} title="Conversation activity" text="Inbound and outbound messages saved in D1." /><Measure icon={MousePointerClick} title="Tracked clicks" text="Redirect events tied to a contact and resource." /><Measure icon={Zap} title="Workflow outcomes" text="Run and step state from the durable engine." /></div></Panel>
  </>;
}

interface ResourceRow { id: string; name: string; description: string | null; type: string; target_url: string | null; file_name: string | null; size_bytes: number | null; updated_at: number }
function ResourcesPage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<{ resources: ResourceRow[] }>("/resources", notify);
  const [name, setName] = useState(""); const [url, setUrl] = useState(""); const [file, setFile] = useState<File | null>(null);
  const addLink = async (event: FormEvent) => { event.preventDefault(); try { await post("/resources/link", { name, url }); setName(""); setUrl(""); reload(); notify("Resource saved"); } catch (error) { notify(errorMessage(error), "error"); } };
  const upload = async () => { if (!file || !name) return; const form = new FormData(); form.set("name", name); form.set("file", file); try { await api("/resources/upload", { method: "POST", body: form }); setName(""); setFile(null); reload(); notify("File uploaded to R2"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="DELIVERABLES" title="Resource library" description="Store creator guides once, reference them by ID, and deliver measurable first-party links." />
    <div className="split-grid resource-create"><Panel title="Save a link" subtitle="External guides, templates, or landing pages"><form onSubmit={addLink}><label>Resource name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Resume Kit" required /></label><label>Destination URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" required /></label><button className="primary"><Link2 size={16} /> Save link resource</button></form></Panel><Panel title="Upload a file" subtitle="PDF, image, text, or ZIP up to 25 MB"><label>Resource name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Interview Guide" /></label><label className="file-drop"><Upload size={22} /><span>{file ? file.name : "Choose a file"}</span><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><button className="secondary" disabled={!file || !name} onClick={() => void upload()}><Upload size={16} /> Upload to R2</button></Panel></div>
    <Panel title="Saved resources" subtitle="Automations deliver these through tracked links">{loading ? <InlineLoader /> : !data?.resources.length ? <EmptyState icon={PackageOpen} title="No resources yet" text="Add a link or upload a creator resource. Automation nodes reference resources by stable ID." /> : <div className="resource-grid">{data.resources.map((resource) => <article key={resource.id}><div className="resource-type"><ResourceIcon type={resource.type} /></div><div><span>{humanize(resource.type)}</span><h3>{resource.name}</h3><p>{resource.description || resource.file_name || resource.target_url}</p><small>{resource.size_bytes ? formatBytes(resource.size_bytes) : "External link"} · Updated {relativeTime(resource.updated_at)}</small></div><button className="icon-button danger" aria-label={`Archive ${resource.name}`} onClick={async () => { await remove(`/resources/${resource.id}`); reload(); notify("Resource archived"); }}><Trash2 size={16} /></button></article>)}</div>}</Panel>
  </>;
}

interface EmailOverview { senders: Array<{ id: string; provider: string; email: string; display_name: string | null; status: string; safety_limit: number; sent_in_window: number }>; templates: Array<{ id: string; name: string; subject: string; updated_at: number }>; queue: Array<{ id: string; recipient: string; status: string; scheduled_at: number; last_error: string | null }>; sequences: Array<{ id: string; name: string; status: string; step_count: number; active_subscribers: number }> }
function EmailPage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<EmailOverview>("/email", notify);
  const [tab, setTab] = useState<"queue" | "templates" | "sequences" | "senders">("queue");
  const [template, setTemplate] = useState({ name: "", subject: "", htmlBody: "<p>Hi {{first_name}},</p>" });
  const [sequence, setSequence] = useState({ name: "", templateId: "", delayMinutes: 0 });
  const createTemplate = async (event: FormEvent) => { event.preventDefault(); try { await post("/email/templates", template); setTemplate({ name: "", subject: "", htmlBody: "<p>Hi {{first_name}},</p>" }); reload(); notify("Email template saved"); } catch (error) { notify(errorMessage(error), "error"); } };
  const createEmailSequence = async (event: FormEvent) => { event.preventDefault(); try { await post("/email/sequences", { name: sequence.name, steps: [{ delayMinutes: sequence.delayMinutes, action: { type: "email", templateId: sequence.templateId } }] }); setSequence({ name: "", templateId: "", delayMinutes: 0 }); reload(); notify("Email sequence saved"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="OWNED AUDIENCE" title="Email" description="Queue-first delivery through your own Gmail or Brevo account, with conservative safety thresholds." />
    <div className="tabs">{(["queue", "templates", "sequences", "senders"] as const).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{humanize(item)}</button>)}</div>
    {loading ? <InlineLoader /> : tab === "queue" ? <Panel title="Delivery queue" subtitle="Failed and quota-limited messages remain visible"><div className="data-table email-table"><div className="table-head"><span>Recipient</span><span>Status</span><span>Scheduled</span><span>Detail</span></div>{data?.queue.length ? data.queue.map((item) => <div key={item.id}><span>{item.recipient}</span><span><b className={`status-chip ${item.status}`}>{item.status}</b></span><span>{formatDateTime(item.scheduled_at)}</span><span>{item.last_error ?? "—"}</span></div>) : <EmptyState icon={Mail} title="The queue is empty" text="Email actions and test sends will appear here." />}</div></Panel> : tab === "templates" ? <div className="split-grid"><Panel title="Templates" subtitle="Use {{variables}} from workflow context">{data?.templates.length ? <div className="simple-list">{data.templates.map((item) => <div key={item.id}><FileText size={17} /><div><strong>{item.name}</strong><span>{item.subject}</span></div></div>)}</div> : <EmptyState icon={FileText} title="No email templates" text="Create the first reusable email below." />}</Panel><Panel title="New template"><form onSubmit={createTemplate}><label>Name<input value={template.name} onChange={(event) => setTemplate((current) => ({ ...current, name: event.target.value }))} required /></label><label>Subject<input value={template.subject} onChange={(event) => setTemplate((current) => ({ ...current, subject: event.target.value }))} required /></label><label>HTML body<textarea className="code-input short" value={template.htmlBody} onChange={(event) => setTemplate((current) => ({ ...current, htmlBody: event.target.value }))} required /></label><button className="primary"><Save size={16} /> Save template</button></form></Panel></div> : tab === "sequences" ? <div className="split-grid"><Panel title="Sequences" subtitle="Durable follow-ups with per-step delays">{data?.sequences.length ? <div className="simple-list">{data.sequences.map((item) => <div key={item.id}><Archive size={17} /><div><strong>{item.name}</strong><span>{item.step_count} step(s) · {item.active_subscribers} active · {item.status}</span></div></div>)}</div> : <EmptyState icon={Archive} title="No sequences yet" text="Create a scheduled email follow-up using one of your templates." />}</Panel><Panel title="New email sequence"><form onSubmit={createEmailSequence}><label>Name<input value={sequence.name} onChange={(event) => setSequence((current) => ({ ...current, name: event.target.value }))} required /></label><label>Email template<select value={sequence.templateId} onChange={(event) => setSequence((current) => ({ ...current, templateId: event.target.value }))} required><option value="">Choose a template</option>{data?.templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Delay before send (minutes)<input type="number" min="0" value={sequence.delayMinutes} onChange={(event) => setSequence((current) => ({ ...current, delayMinutes: Number(event.target.value) }))} /></label><button className="primary"><Plus size={16} /> Create sequence</button></form></Panel></div> : <Panel title="Connected senders" subtitle="Credentials stay encrypted on the Worker">{data?.senders.length ? <div className="integration-list">{data.senders.map((sender) => <div key={sender.id}><div className="integration-logo"><Mail /></div><div><strong>{sender.display_name ?? sender.email}</strong><span>{sender.provider} · {sender.sent_in_window}/{sender.safety_limit} in current window</span></div><b className="status-chip connected">{sender.status}</b></div>)}</div> : <EmptyState icon={Mail} title="No email provider connected" text="Email actions remain unavailable until you connect Gmail or Brevo in Integrations." />}</Panel>}
  </>;
}

interface AiOverview { agent: { id: string; identity_text: string; tone_text: string; goal_text: string; rules_text: string; confidence_threshold: number; autopilot_enabled: number } | null; knowledge: Array<{ id: string; type: string; title: string; content: string; enabled: number; updated_at: number }> }
function AiPage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<AiOverview>("/ai-agent", notify);
  const [form, setForm] = useState({ identity: "", tone: "Helpful, concise, creator-friendly", goal: "Help people find the right resource", rules: "Never invent links. Hand off when uncertain.", confidenceThreshold: 0.75, autopilotEnabled: false });
  const [knowledge, setKnowledge] = useState({ title: "", content: "", type: "faq" });
  const formValue = data?.agent && !form.identity ? { identity: data.agent.identity_text, tone: data.agent.tone_text, goal: data.agent.goal_text, rules: data.agent.rules_text, confidenceThreshold: data.agent.confidence_threshold, autopilotEnabled: Boolean(data.agent.autopilot_enabled) } : form;
  const updateForm = (update: Partial<typeof form>) => setForm({ ...formValue, ...update });
  const save = async () => { try { await put("/ai-agent", formValue); reload(); notify("AI agent configuration saved"); } catch (error) { notify(errorMessage(error), "error"); } };
  const addKnowledge = async (event: FormEvent) => { event.preventDefault(); try { await post("/ai-agent/knowledge", knowledge); setKnowledge({ title: "", content: "", type: "faq" }); reload(); notify("Knowledge source added"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="OPTIONAL INTELLIGENCE" title="AI Agent" description="Use Workers AI for suggested replies, intent classification, and structured workflow proposals. Keyword flows keep working if AI is unavailable." actions={<button className="primary" onClick={() => void save()}><Save size={16} /> Save agent</button>} />
    {loading ? <InlineLoader /> : <div className="ai-layout"><Panel title="Agent identity" subtitle="Guardrails and creator voice"><label>Who is this agent?<textarea value={formValue.identity} onChange={(event) => updateForm({ identity: event.target.value })} placeholder="You are the DM assistant for…" /></label><label>Tone<textarea value={formValue.tone} onChange={(event) => updateForm({ tone: event.target.value })} /></label><label>Primary goal<textarea value={formValue.goal} onChange={(event) => updateForm({ goal: event.target.value })} /></label><label>Rules<textarea value={formValue.rules} onChange={(event) => updateForm({ rules: event.target.value })} /></label><label className="range-label"><span>Confidence threshold <b>{Math.round(formValue.confidenceThreshold * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={formValue.confidenceThreshold} onChange={(event) => updateForm({ confidenceThreshold: Number(event.target.value) })} /></label><label className="toggle-row"><input type="checkbox" checked={formValue.autopilotEnabled} onChange={(event) => updateForm({ autopilotEnabled: event.target.checked })} /><span><strong>Enable AI autopilot</strong><small>Only published workflows can invoke it; policy checks still apply.</small></span></label></Panel>
      <div><Panel title="Knowledge" subtitle="Relevant snippets are retrieved locally before generation">{data?.knowledge.length ? <div className="knowledge-list">{data.knowledge.map((item) => <article key={item.id}><div><span>{humanize(item.type)}</span><strong>{item.title}</strong></div><button className="icon-button danger" onClick={async () => { await remove(`/ai-agent/knowledge/${item.id}`); reload(); }}><Trash2 size={15} /></button></article>)}</div> : <EmptyState icon={Database} title="No knowledge yet" text="Add FAQs, product notes, or pasted reference text." />}</Panel><Panel title="Add knowledge"><form onSubmit={addKnowledge}><label>Type<select value={knowledge.type} onChange={(event) => setKnowledge((current) => ({ ...current, type: event.target.value }))}><option value="faq">FAQ</option><option value="note">Note</option><option value="product">Product</option><option value="resource">Resource</option></select></label><label>Title<input value={knowledge.title} onChange={(event) => setKnowledge((current) => ({ ...current, title: event.target.value }))} required /></label><label>Content<textarea value={knowledge.content} onChange={(event) => setKnowledge((current) => ({ ...current, content: event.target.value }))} required /></label><button className="secondary"><Plus size={16} /> Add source</button></form></Panel></div></div>}
  </>;
}

function IntegrationsPage({ bootstrap, refresh, notify }: { bootstrap: Bootstrap; refresh: () => Promise<void>; notify: Notify }) {
  const { data, reload } = useRemote<{ capabilities: Bootstrap["capabilities"]; connections: Array<{ id: string; provider: string; label: string | null; status: string; last_error: string | null }>; customWebhooks: Array<{ id: string; name: string; automation_id: string; active: number }> }>("/integrations", notify);
  const { data: automationData } = useRemote<{ automations: AutomationListItem[] }>("/automations", notify);
  const [brevo, setBrevo] = useState({ apiKey: "", email: "", displayName: "", purpose: "Creator follow-up", safetyLimit: 450 });
  const [sheet, setSheet] = useState({ spreadsheetId: "", range: "Sheet1!A:Z" });
  const [webhook, setWebhook] = useState({ name: "", automationId: "" });
  const [webhookCredential, setWebhookCredential] = useState<{ url: string; secret: string } | null>(null);
  const connectInstagram = async () => { try { const result = await post<{ url: string }>("/integrations/instagram/connect"); window.location.href = result.url; } catch (error) { notify(errorMessage(error), "error"); } };
  const disconnectInstagram = async () => { try { await post("/integrations/instagram/disconnect"); await refresh(); notify("Instagram disconnected"); } catch (error) { notify(errorMessage(error), "error"); } };
  const connectBrevo = async (event: FormEvent) => { event.preventDefault(); try { await post("/email/brevo", brevo); setBrevo((current) => ({ ...current, apiKey: "" })); reload(); notify("Brevo sender connected"); } catch (error) { notify(errorMessage(error), "error"); } };
  const connectGoogle = async (purpose: "gmail" | "sheets") => { try { const result = await post<{ url: string }>("/integrations/google/connect", { purpose, ...sheet }); window.location.assign(result.url); } catch (error) { notify(errorMessage(error), "error"); } };
  const createWebhook = async (event: FormEvent) => { event.preventDefault(); try { const result = await post<{ url: string; secret: string }>("/integrations/custom-webhooks", webhook); setWebhookCredential(result); setWebhook({ name: "", automationId: "" }); reload(); notify("Inbound webhook created — copy its secret now"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="CONNECTIONS" title="Integrations" description="Bring your own provider accounts. Credentials are encrypted server-side and excluded from backups." />
    <div className="integration-stack"><Panel><div className="integration-hero"><div className="integration-logo instagram"><Camera /></div><div><span className="eyebrow dark">PRIMARY CHANNEL</span><h2>Instagram</h2><p>Official Meta API connection for a Professional Creator or Business account.</p></div><b className={`status-chip ${bootstrap.instagram.connected ? "connected" : "paused"}`}>{bootstrap.instagram.connected ? "connected" : "not connected"}</b></div>
      {bootstrap.instagram.connected ? <div className="connection-detail"><InfoRow label="Account" value={`@${bootstrap.instagram.username ?? "instagram"}`} /><InfoRow label="Account ID" value={bootstrap.instagram.accountId ?? "Unavailable"} /><InfoRow label="Account type" value={bootstrap.instagram.accountType ?? "Professional"} /><InfoRow label="Token" value={`${bootstrap.instagram.tokenStatus ?? "unknown"} · ${bootstrap.instagram.expiresInDays ?? 0} days`} /><InfoRow label="Webhook" value={bootstrap.instagram.webhookStatus ?? "unknown"} /><div className="button-row"><button className="secondary" onClick={() => void connectInstagram()}><RefreshCw size={16} /> Reconnect</button><button className="danger-button" onClick={() => void disconnectInstagram()}><Trash2 size={16} /> Disconnect</button></div></div> : <div className="connection-empty"><p>Connect from this protected owner session. The one-time launch link expires after five minutes.</p><button className="primary" onClick={() => void connectInstagram()}><Camera size={17} /> Connect Instagram</button></div>}
      <details className="capabilities"><summary>Instagram capability matrix <ChevronDown size={16} /></summary>{(data?.capabilities ?? bootstrap.capabilities).map((item) => <div key={item.key}><span className={`capability-mark ${item.state}`}>{item.state === "available" ? <Check size={13} /> : item.state === "unavailable" ? <X size={13} /> : <CircleHelp size={13} />}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></div>)}</details>
    </Panel>
    <div className="split-grid"><Panel title="Brevo" subtitle="API-based transactional email with your own key"><form onSubmit={connectBrevo}><label>API key<input type="password" value={brevo.apiKey} onChange={(event) => setBrevo((current) => ({ ...current, apiKey: event.target.value }))} required /></label><label>Sender email<input type="email" value={brevo.email} onChange={(event) => setBrevo((current) => ({ ...current, email: event.target.value }))} required /></label><label>Display name<input value={brevo.displayName} onChange={(event) => setBrevo((current) => ({ ...current, displayName: event.target.value }))} /></label><button className="secondary"><Mail size={16} /> Validate and connect</button></form></Panel><Panel title="Google services" subtitle="Gmail and Sheets use your own Google OAuth app"><button className="secondary full" onClick={() => void connectGoogle("gmail")}><Mail size={16} /> Connect Gmail sender</button><hr /><label>Spreadsheet ID<input value={sheet.spreadsheetId} onChange={(event) => setSheet((current) => ({ ...current, spreadsheetId: event.target.value }))} placeholder="From the Google Sheets URL" /></label><label>Append range<input value={sheet.range} onChange={(event) => setSheet((current) => ({ ...current, range: event.target.value }))} /></label><button className="secondary full" disabled={!sheet.spreadsheetId} onClick={() => void connectGoogle("sheets")}><Database size={16} /> Connect Google Sheets</button></Panel></div>
    <div className="split-grid"><Panel title="Connected adapters" subtitle="Provider credentials remain encrypted">{data?.connections.length ? <div className="simple-list">{data.connections.map((connection) => <div key={connection.id}><Network size={17} /><div><strong>{connection.label ?? humanize(connection.provider)}</strong><span>{connection.status}{connection.last_error ? ` · ${connection.last_error}` : ""}</span></div></div>)}</div> : <EmptyState icon={Network} title="No additional adapters" text="Google Sheets and other provider connections will appear here." />}</Panel><Panel title="Inbound webhook" subtitle="Trigger a published webhook automation from another tool"><form onSubmit={createWebhook}><label>Name<input value={webhook.name} onChange={(event) => setWebhook((current) => ({ ...current, name: event.target.value }))} placeholder="New lead webhook" required /></label><label>Automation<select value={webhook.automationId} onChange={(event) => setWebhook((current) => ({ ...current, automationId: event.target.value }))} required><option value="">Choose an automation</option>{automationData?.automations.filter((item) => item.trigger_type === "webhook").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="secondary"><Webhook size={16} /> Create endpoint</button></form>{webhookCredential && <div className="credential-reveal"><strong>Copy now — the secret is shown once</strong><code>{webhookCredential.url}</code><code>{webhookCredential.secret}</code></div>}{data?.customWebhooks.map((item) => <div className="webhook-row" key={item.id}><Webhook size={15} /><span>{item.name}</span><b>{item.active ? "active" : "disabled"}</b></div>)}</Panel></div></div>
  </>;
}

function SettingsPage({ bootstrap, notify }: { bootstrap: Bootstrap; notify: Notify }) {
  const { data, reload } = useRemote<{ settings: Record<string, unknown> }>("/settings", notify);
  const [key, setKey] = useState(""); const [value, setValue] = useState("");
  const save = async (event: FormEvent) => { event.preventDefault(); try { await put(`/settings/${encodeURIComponent(key)}`, { value }); setKey(""); setValue(""); reload(); notify("Setting saved"); } catch (error) { notify(errorMessage(error), "error"); } };
  return <><PageHeader eyebrow="INSTALLATION" title="Settings" description="Health, runtime behavior, and non-secret preferences for this self-hosted instance." />
    <div className="split-grid"><Panel title="Installation health" subtitle={`Inbox Orchard ${bootstrap.product.version}`}><div className="health-list"><Health ok={bootstrap.missingSecrets.length === 0} label="Required secrets" detail={bootstrap.missingSecrets.length ? `Missing: ${bootstrap.missingSecrets.join(", ")}` : "All configured"} /><Health ok={bootstrap.instagram.connected} label="Instagram connection" detail={bootstrap.instagram.connected ? `@${bootstrap.instagram.username}` : "Not connected"} /><Health ok label="Single-tenant mode" detail="Data stays in your Cloudflare account" /><Health ok={bootstrap.freeMode} label="Free Mode" detail={bootstrap.freeMode ? "Essential work is prioritized" : "Disabled by environment setting"} /></div></Panel><Panel title="Runtime priorities" subtitle="Free Mode degrades optional features first"><ol className="priority-list"><li>Webhook ingestion</li><li>DM delivery</li><li>Automation execution</li><li>Contact persistence</li><li>Email queue</li><li>Analytics</li><li>AI enrichment</li></ol></Panel></div>
    <Panel title="Local preferences" subtitle="Non-secret JSON-compatible values stored in D1"><form className="inline-form" onSubmit={save}><label>Key<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="inbox.signature" required /></label><label>Value<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="— Dan" /></label><button className="secondary"><Save size={16} /> Save</button></form><div className="settings-grid">{Object.entries(data?.settings ?? {}).map(([settingKey, settingValue]) => <div key={settingKey}><strong>{settingKey}</strong><code>{JSON.stringify(settingValue)}</code></div>)}</div></Panel>
  </>;
}

function UsagePage({ notify }: { notify: Notify }) {
  const { data, loading, reload } = useRemote<{ days: number; metrics: Array<{ metric: string; value: number; estimated: number }>; labels: { providerValues: string } }>("/usage", notify);
  const known = new Map(data?.metrics.map((item) => [item.metric, item]) ?? []);
  const metrics = [["Worker requests", "worker_requests", Activity], ["Database operations", "d1_operations", Database], ["Queue operations", "queue_operations", Archive], ["AI requests", "ai_requests", Sparkles], ["Emails sent", "emails_sent", Mail], ["R2 bytes stored", "r2_bytes_stored", Box]] as const;
  return <><PageHeader eyebrow="FREE INFRASTRUCTURE" title="Usage" description="Locally tracked estimates only. Provider dashboards remain the authority for exact quota and billing data." actions={<button className="secondary" onClick={reload}><RefreshCw size={16} /> Refresh</button>} />
    <div className="usage-grid">{metrics.map(([label, key, Icon]) => <article key={key}><Icon size={19} /><span>{label}</span><strong>{loading ? "—" : key === "r2_bytes_stored" ? formatBytes(known.get(key)?.value ?? 0) : formatNumber(known.get(key)?.value ?? 0)}</strong><small>{known.get(key)?.estimated === 0 ? "Exact local count" : "Locally tracked estimate"}</small></article>)}</div>
    <div className="safe-callout wide"><ShieldCheck size={20} /><div><strong>No automatic paid overages</strong><span>Inbox Orchard never purchases capacity, upgrades a provider plan, or silently creates paid infrastructure. Free Mode preserves core ingestion and automation before optional AI and advanced analytics.</span></div></div>
  </>;
}

function BackupPage({ notify }: { notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const download = async () => { setBusy(true); try { const backup = await api<Record<string, unknown>>("/backup"); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = `inbox-orchard-backup-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(href); notify("Secret-free backup downloaded"); } catch (error) { notify(errorMessage(error), "error"); } finally { setBusy(false); } };
  const restore = async () => { if (!backupFile || !window.confirm("Merge this configuration backup into this installation? Existing rows with the same IDs will be replaced.")) return; setBusy(true); try { const payload = JSON.parse(await backupFile.text()) as unknown; const result = await post<{ restored: Record<string, number> }>("/backup/restore", payload); const restored = Object.values(result.restored).reduce((sum, value) => sum + value, 0); notify(`Restored ${restored} configuration records`); setBackupFile(null); } catch (error) { notify(errorMessage(error), "error"); } finally { setBusy(false); } };
  return <><PageHeader eyebrow="DATA OWNERSHIP" title="Backup & portability" description="Export a readable configuration snapshot from your installation. Provider credentials are deliberately excluded." />
    <div className="backup-card"><div className="backup-illustration"><Database size={40} /><Download size={24} /></div><div><span className="eyebrow dark">CONFIGURATION BACKUP</span><h2>Your workflows. Your audience. Your infrastructure.</h2><p>The export includes automations and immutable versions, tags, custom fields, resource metadata, email templates, AI agent configuration, knowledge, and settings.</p><ul><li><Check size={15} /> Portable JSON</li><li><Check size={15} /> No access tokens</li><li><Check size={15} /> No provider secrets</li></ul><button className="primary" disabled={busy} onClick={() => void download()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Download backup</button></div></div>
    <Panel title="Portable automation definitions" subtitle="Community templates use the same versioned schema"><div className="measure-grid"><Measure icon={Code2} title="Structured JSON" text="No custom application code is embedded in a workflow." /><Measure icon={ShieldCheck} title="Validated" text="Unknown node types and unsafe URLs are rejected." /><Measure icon={GitBranch} title="Versioned" text="Published runs retain their immutable definition." /></div></Panel>
    <Panel title="Restore configuration" subtitle="Merge an Inbox Orchard schema v1 backup; secrets and uploaded R2 file bytes are never imported"><label className="file-drop"><Upload size={22} /><span>{backupFile ? backupFile.name : "Choose an Inbox Orchard backup JSON file"}</span><input type="file" accept="application/json,.json" onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)} /></label><button className="secondary" disabled={!backupFile || busy} onClick={() => void restore()}><Upload size={16} /> Validate and restore</button></Panel>
  </>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div><span className="eyebrow dark">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

function Panel({ title, subtitle, children, className = "" }: { title?: string; subtitle?: string; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title && <header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>}<div className="panel-body">{children}</div></section>;
}

function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div><Icon size={22} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function SetupBanner({ missing, onConnect }: { missing: string[]; onConnect: () => void }) {
  return <div className="setup-banner"><div className="setup-art"><Camera size={27} /><span><Zap size={15} /></span></div><div><span className="eyebrow">FIRST-RUN SETUP</span><h2>Instagram isn’t connected yet.</h2><p>{missing.length ? `Configure ${missing.join(", ")} before starting OAuth.` : "Connect a Professional account to start receiving DMs and comment events."}</p></div><button className="light-button" onClick={onConnect}>Open integrations <ArrowRight size={16} /></button></div>;
}

function Avatar({ name, large = false }: { name: string; large?: boolean }) { const initials = name.replace("@", "").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); return <span className={`avatar ${large ? "large" : ""}`}>{initials || "IG"}</span>; }
function WindowBadge({ lastInbound }: { lastInbound?: number | null }) { const [now] = useState(() => Math.floor(Date.now() / 1000)); const seconds = lastInbound ? lastInbound + 86400 - now : 0; return <span className={`window-badge ${seconds > 0 ? "open" : "closed"}`}><span />{seconds > 0 ? `Open · ${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : "Window closed"}</span>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>; }
function Health({ ok, label, detail }: { ok: boolean; label: string; detail: string }) { return <div><span className={ok ? "ok" : "warn"}>{ok ? <Check size={14} /> : <CircleHelp size={14} />}</span><div><strong>{label}</strong><small>{detail}</small></div></div>; }
function Measure({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) { return <div className="measure"><Icon size={19} /><div><strong>{title}</strong><p>{text}</p></div></div>; }
function InlineLoader() { return <div className="inline-loader"><LoaderCircle className="spin" size={20} /> Loading live data…</div>; }
function FullScreenLoader({ label }: { label: string }) { return <div className="full-loader"><div className="brand-mark"><MessageCircle size={19} /><Sparkles size={10} /></div><LoaderCircle className="spin" /><span>{label}</span></div>; }
function ResourceIcon({ type }: { type: string }) { return type === "link" ? <Link2 /> : type === "image" ? <Camera /> : <FileText />; }
function NodeIcon({ type }: { type: AutomationNodeType }) { if (type.startsWith("send") || type === "ask_question") return <Send size={15} />; if (type === "condition" || type === "random_split") return <GitBranch size={15} />; if (type.includes("webhook") || type === "call_webhook") return <Webhook size={15} />; if (type.includes("ai")) return <Sparkles size={15} />; if (type.includes("tag")) return <Tags size={15} />; if (type === "end") return <Check size={15} />; return <Zap size={15} />; }

function AutomationFlowNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.automation;
  return <div className={`automation-flow-node ${selected ? "selected" : ""}`}><Handle type="target" position={Position.Left} /><span className={`flow-node-icon type-${node.type}`}><NodeIcon type={node.type} /></span><span className="flow-node-copy"><small>{humanize(node.type)}</small><strong>{node.label}</strong><p>{nodeSummary(node)}</p></span><Handle type="source" position={Position.Right} /></div>;
}

function nodeSummary(node: AutomationNode): string {
  if (typeof node.config.text === "string" && node.config.text.trim()) return node.config.text.trim().slice(0, 58);
  if (node.type === "wait_for_response") return `Wait for ${humanize(stringValue(node.config.field, "a reply"))}`;
  if (node.type === "delay") return `Wait ${Math.max(1, Math.round(numberValue(node.config.seconds, 60) / 60))} min`;
  if (node.type === "send_resource") return "Deliver a saved resource";
  if (node.type === "condition") return `Check ${humanize(stringValue(node.config.field, "a saved answer"))}`;
  if (node.type === "end") return "Journey complete";
  return "Automation step";
}

function flowNode(node: AutomationNode): FlowNode { return { id: node.id, position: node.position, data: { automation: node }, type: "automation" }; }
function flowEdge(edge: AutomationDefinition["edges"][number]): Edge { return { ...edge, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6d5dfc", strokeWidth: 2 }, labelStyle: { fill: "#4b5568", fontWeight: 700 } }; }
function defaultNodeConfig(type: AutomationNodeType): Record<string, unknown> {
  if (type === "send_text") return { text: "Write your message…" };
  if (type === "send_buttons") return { text: "I got you — tap below 👇", buttons: [{ title: "Send it", payload: "SEND_IT" }] };
  if (type === "send_image") return { url: "" };
  if (type === "send_resource") return { resourceId: "" };
  if (type === "ask_question") return { text: "What would you like to ask?", field: "answer" };
  if (type === "wait_for_response") return { field: "answer" };
  if (type === "delay") return { seconds: 60 };
  if (type === "condition") return { field: "answer", operator: "equals", value: "yes" };
  if (type === "public_comment_reply") return { text: "Sent 🤝", replies: ["Sent 🤝"] };
  if (type === "send_email") return { templateId: "" };
  if (type === "notify_owner") return { text: "A contact reached this step." };
  if (type === "goal_reached") return { goal: "converted" };
  return {};
}

function useRemote<T>(path: string, notify: Notify) {
  const [data, setData] = useState<T | null>(null); const [loading, setLoading] = useState(true);
  const reload = useCallback(() => { setLoading(true); api<T>(path).then(setData).catch((error) => notify(errorMessage(error), "error")).finally(() => setLoading(false)); }, [path, notify]);
  useEffect(() => { let active = true; api<T>(path).then((result) => { if (active) setData(result); }).catch((error) => { if (active) notify(errorMessage(error), "error"); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [path, notify]);
  return { data, loading, reload };
}

function pageFromHash(): PageKey { const value = window.location.hash.replace("#", "") as PageKey; return value === "simulator" || navGroups.flatMap((group) => group.items).some((item) => item.key === value) ? value : "dashboard"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("→", " → ").replace(/^./, (letter) => letter.toUpperCase()); }
function formatNumber(value: number): string { return new Intl.NumberFormat().format(value); }
function formatDate(timestamp: number): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp * 1000)); }
function formatDateTime(timestamp: number): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp * 1000)); }
function relativeTime(timestamp: number): string { const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestamp); if (delta < 60) return "now"; if (delta < 3600) return `${Math.floor(delta / 60)}m`; if (delta < 86400) return `${Math.floor(delta / 3600)}h`; return `${Math.floor(delta / 86400)}d`; }
function formatBytes(bytes: number): string { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function readableJson(value: string): string { try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "string" ? parsed : JSON.stringify(parsed); } catch { return value; } }
