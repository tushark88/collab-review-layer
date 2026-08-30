import type { Disposition } from "../domain.ts";
import { TrackerHttpError, type JsonTransport } from "./http.ts";
import { parseStableIssueContext, type SearchContext, type SearchTier, type TrackerWebhook, type WorkContainer, type WorkItem, type WorkItemDraft, type WorkTracker } from "../tracker.ts";
import { processUniqueDelivery, requireDeliveryId, requireWebhookBody, verifyHmacSha256, type WebhookDeliveryLedger } from "../webhook.ts";

export interface GitHubConfig {
  endpoint: string;
  token: string;
  webhookSecret: string;
  owner: string;
  repository: string;
  workspace: { kind: "org" | "user"; login: string };
  deliveries: WebhookDeliveryLedger;
  closedLookbackDays?: number;
}

interface GitHubIssueRecord {
  number: number;
  html_url: string;
  title: string;
  body?: string;
  state: string;
  labels: Array<{ name: string }>;
  updated_at: string;
  repository_url?: string;
  pull_request?: unknown;
}

export class GitHubIssuesTracker implements WorkTracker {
  readonly provider = "github" as const;
  readonly config: GitHubConfig;
  readonly transport: JsonTransport;
  constructor(config: GitHubConfig, transport: JsonTransport) {
    requireSlug(config.owner, "owner");
    requireSlug(config.repository, "repository");
    requireSlug(config.workspace.login, "workspace login");
    const lookback = config.closedLookbackDays ?? 90;
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > 3650) throw new Error("closed lookback must be between 1 and 3650 days");
    this.config = config;
    this.transport = transport;
  }
  async findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer> {
    await this.transport.request({ method: "GET", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}`, headers: this.headers() });
    return { provider: this.provider, id: `${this.config.owner}/${this.config.repository}`, workspaceId: input.workspaceId, name: input.name };
  }
  async candidates(context: SearchContext, tier: SearchTier = "current_container"): Promise<readonly WorkItem[]> {
    if (tier === "exact_link") {
      if (!context.exactLinkedId) return [];
      const reference = this.issueReference(context.exactLinkedId);
      try {
        const item = await this.transport.request<GitHubIssueRecord>({ method: "GET", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}`, headers: this.headers() });
        return item.pull_request ? [] : [this.mapIssue(item, reference.repository)];
      } catch (error) {
        if (error instanceof TrackerHttpError && error.status === 404) return [];
        throw error;
      }
    }

    const query = encodeURIComponent(this.searchQuery(context, tier));
    const data = await this.transport.request<{ items: GitHubIssueRecord[] }>({ method: "GET", url: `${this.config.endpoint}/search/issues?q=${query}`, headers: this.headers() });
    return data.items.filter((item) => !item.pull_request).map((item) => this.mapIssue(item));
  }
  async createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> {
    const item = await this.transport.request<{ number: number; html_url: string; title: string; body: string; state: string; labels: Array<{ name: string }>; updated_at: string }>({ method: "POST", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}/issues`, headers: { ...this.headers(), "x-idempotency-key": draft.idempotencyKey }, body: { title: draft.title, body: draft.body, labels: draft.labels } });
    return { provider: this.provider, id: `${container.id}#${item.number}`, url: item.html_url, title: item.title, body: item.body, state: "open", containerId: container.id, repository: container.id, labels: item.labels.map((label) => label.name), updatedAt: item.updated_at };
  }
  async addComment(itemId: string, body: string, idempotencyKey: string): Promise<void> {
    const reference = this.issueReference(itemId);
    await this.transport.request({ method: "POST", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}/comments`, headers: { ...this.headers(), "x-idempotency-key": idempotencyKey }, body: { body } });
  }
  async applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    const reference = this.issueReference(itemId);
    const body = disposition === "accepted"
      ? { state: "open" }
      : { state: "closed", state_reason: disposition === "rejected" ? "not_planned" : "completed" };
    await this.transport.request({ method: "PATCH", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}`, headers: this.headers(), body });
    if (reason) await this.addComment(itemId, `Disposition reason: ${reason}`, `disposition:${disposition}`);
  }
  async processWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>, apply: (webhook: TrackerWebhook) => Promise<void>): Promise<void> {
    requireWebhookBody(body);
    if (!verifyHmacSha256(body, headers["x-hub-signature-256"], this.config.webhookSecret)) throw new Error("invalid GitHub webhook signature");
    const raw = JSON.parse(new TextDecoder().decode(body)) as { issue?: { number?: number }; comment?: { body?: string }; repository?: { full_name?: string } };
    const deliveryId = requireDeliveryId(headers["x-github-delivery"]);
    const repository = raw.repository?.full_name ?? `${this.config.owner}/${this.config.repository}`;
    const workItemId = raw.issue?.number === undefined ? undefined : this.issueReference(`${repository}#${raw.issue.number}`).id;
    const webhook = { deliveryId, event: headers["x-github-event"] ?? "unknown", workItemId, commentBody: raw.comment?.body, raw };
    await processUniqueDelivery(this.config.deliveries, this.provider, deliveryId, webhook, apply);
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.config.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }; }

  private mapIssue(item: GitHubIssueRecord, fallbackRepository?: string): WorkItem {
    const body = item.body ?? "";
    const stable = parseStableIssueContext(body);
    const repository = item.repository_url ? repositoryFromApiUrl(item.repository_url) : fallbackRepository ?? repositoryFromIssueUrl(item.html_url);
    const reference = this.issueReference(`${repository}#${item.number}`);
    return {
      provider: this.provider,
      id: reference.id,
      url: item.html_url,
      title: item.title,
      body,
      state: item.state === "closed" ? "closed" : "open",
      containerId: reference.repository,
      repository: reference.repository,
      route: stable.route,
      anchorFingerprint: stable.anchorFingerprint,
      labels: item.labels.map((label) => label.name),
      updatedAt: item.updated_at,
    };
  }

  private searchQuery(context: SearchContext, tier: Exclude<SearchTier, "exact_link">): string {
    const repositoryScope = `repo:${this.config.owner}/${this.config.repository}`;
    const workspaceScope = `${this.config.workspace.kind}:${this.config.workspace.login}`;
    const state = tier === "open_workspace"
      ? " is:open"
      : tier === "recent_closed"
        ? ` is:closed updated:>=${lookbackDate(context.now, this.config.closedLookbackDays ?? 90)}`
        : "";
    const scope = tier === "current_container" ? repositoryScope : workspaceScope;
    return `${scope} is:issue${state} in:body (${searchPhrase(context.route)} OR ${searchPhrase(context.anchorFingerprint)})`;
  }

  private issueReference(value: string): { id: string; repository: string; number: string } {
    const match = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#)?([1-9][0-9]*)$/.exec(value);
    if (!match) throw new Error("invalid GitHub issue id");
    const owner = match[1] ?? this.config.owner;
    const repositoryName = match[2] ?? this.config.repository;
    const number = match[3]!;
    if (owner.toLowerCase() !== this.config.workspace.login.toLowerCase()) throw new Error("GitHub issue is outside the configured workspace");
    requireSlug(repositoryName, "repository");
    const repository = `${owner}/${repositoryName}`;
    return { id: `${repository}#${number}`, repository, number };
  }
}

function searchPhrase(value: string): string {
  const literal = value.replace(/["\\\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return `"${literal}"`;
}

function requireSlug(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`invalid GitHub ${label}`);
  return value;
}

function lookbackDate(now: string, days: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("search context now must be an ISO timestamp");
  return new Date(timestamp - days * 86_400_000).toISOString().slice(0, 10);
}

function repositoryFromApiUrl(value: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(new URL(value).pathname);
  if (!match) throw new Error("invalid GitHub repository URL");
  return match[1]!;
}

function repositoryFromIssueUrl(value: string): string {
  const match = /^\/([^/]+\/[^/]+)\/issues\/[1-9][0-9]*$/.exec(new URL(value).pathname);
  if (!match) throw new Error("invalid GitHub issue URL");
  return match[1]!;
}
