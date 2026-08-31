import type { Disposition } from "../domain.ts";
import { TrackerHttpError, type JsonTransport } from "./http.ts";
import { dispositionCommentIdempotencyKey, InMemoryProviderMutationRecovery, isTrackerCommentEcho, normalizeStableIssueContext, parseStableIssueContext, ProviderMutationRejectedError, requireDistinctTrackerSecrets, stableIssueBody, trackerCommentBody, workItemCommentFingerprint, workItemDraftFingerprint, type SearchContext, type SearchTier, type TrackerWebhook, type WorkContainer, type WorkItem, type WorkItemDraft, type WorkTracker } from "../tracker.ts";
import { processUniqueDelivery, requireDeliveryId, requireWebhookBody, verifyHmacSha256, type WebhookDeliveryLedger } from "../webhook.ts";

export interface GitHubConfig {
  endpoint: string;
  token: string;
  webhookSecret: string;
  contextSigningSecret: string;
  commentSigningSecret: string;
  owner: string;
  repository: string;
  workspace: { kind: "org" | "user"; login: string };
  webhookScope?: "repository" | "workspace";
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

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results?: boolean;
  items: GitHubIssueRecord[];
}

interface GitHubRepositoryRecord { full_name: string; }

interface GitHubCreatedIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  updated_at: string;
}

interface GitHubCommentRecord { body?: string; }

const MAX_GITHUB_COMMENT_PAGES = 10;

export class GitHubIssuesTracker implements WorkTracker {
  readonly provider = "github" as const;
  readonly config: GitHubConfig;
  readonly transport: JsonTransport;
  readonly contextSigningSecret: string;
  readonly commentSigningSecret: string;
  readonly #creations = new InMemoryProviderMutationRecovery<GitHubCreatedIssue, WorkItem>();
  readonly #comments = new InMemoryProviderMutationRecovery<true, void>();
  constructor(config: GitHubConfig, transport: JsonTransport) {
    requireSlug(config.owner, "owner");
    requireSlug(config.repository, "repository");
    requireSlug(config.workspace.login, "workspace login");
    if (config.owner.toLowerCase() !== config.workspace.login.toLowerCase()) throw new Error("GitHub owner must match the configured workspace");
    if (config.webhookScope !== undefined && config.webhookScope !== "repository" && config.webhookScope !== "workspace") throw new Error("invalid GitHub webhook scope");
    const lookback = config.closedLookbackDays ?? 90;
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > 3650) throw new Error("closed lookback must be between 1 and 3650 days");
    this.config = config;
    this.transport = transport;
    requireDistinctTrackerSecrets("GitHub", config.webhookSecret, config.contextSigningSecret, config.commentSigningSecret);
    this.contextSigningSecret = config.contextSigningSecret;
    this.commentSigningSecret = config.commentSigningSecret;
  }
  async findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer> {
    if (input.workspaceId.toLowerCase() !== this.config.workspace.login.toLowerCase()) throw new Error("GitHub workspace does not match the configured workspace");
    const expectedRepository = `${this.config.owner}/${this.config.repository}`.toLowerCase();
    const repository = await this.transport.request<GitHubRepositoryRecord>({ method: "GET", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}`, headers: this.headers() });
    if (repositoryInWorkspace(repository.full_name, this.config.workspace.login) !== expectedRepository) throw new Error("GitHub repository response does not match the configured repository");
    return { provider: this.provider, id: expectedRepository, workspaceId: this.config.workspace.login.toLowerCase(), name: input.name };
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

    const items: GitHubIssueRecord[] = [];
    let expectedTotal: number | undefined;
    let complete = false;
    for (let page = 1; page <= 10; page += 1) {
      const url = new URL(`${this.config.endpoint}/search/issues`);
      url.searchParams.set("q", this.searchQuery(context, tier));
      url.searchParams.set("sort", "updated");
      url.searchParams.set("order", "desc");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const data = await this.transport.request<GitHubSearchResponse>({ method: "GET", url: url.toString(), headers: this.headers() });
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) throw new Error("invalid GitHub search response");
      if (!Array.isArray(data.items) || data.items.length > 100) throw new Error("invalid GitHub search page");
      if (data.incomplete_results || data.total_count > 1000) return [];
      if (expectedTotal !== undefined && data.total_count !== expectedTotal) return [];
      expectedTotal ??= data.total_count;
      items.push(...data.items);
      if (items.length === expectedTotal) {
        complete = true;
        break;
      }
      if (items.length > expectedTotal || data.items.length < 100) return [];
    }
    if (!complete) return [];
    return items.filter((item) => !item.pull_request).map((item) => this.mapIssue(item));
  }
  async createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> {
    const normalizedDraft = { ...draft, context: normalizeStableIssueContext(draft.context) };
    const configuredRepository = `${this.config.owner}/${this.config.repository}`.toLowerCase();
    if (container.id.toLowerCase() !== configuredRepository.toLowerCase()) throw new Error("GitHub Work Container does not match the configured repository");
    return this.#creations.run(
      normalizedDraft.idempotencyKey,
      workItemDraftFingerprint(container, normalizedDraft),
      async () => {
        try {
          return await this.transport.request<GitHubCreatedIssue>({ method: "POST", url: `${this.config.endpoint}/repos/${configuredRepository}/issues`, headers: { ...this.headers(), "x-idempotency-key": normalizedDraft.idempotencyKey }, body: { title: normalizedDraft.title, body: "Collaborative review context is being attached.", labels: normalizedDraft.labels } });
        } catch (error) {
          if (error instanceof TrackerHttpError && isDefinitiveCreationRefusal(error.status)) throw new ProviderMutationRejectedError(error.message);
          throw error;
        }
      },
      async (item) => {
        const reference = this.issueReference(`${configuredRepository}#${item.number}`);
        const duplicateNote = normalizedDraft.possibleDuplicateUrl ? `\n\nPossible duplicate: ${normalizedDraft.possibleDuplicateUrl}` : "";
        const body = stableIssueBody(normalizedDraft.context, { provider: this.provider, workItemId: reference.id }, this.contextSigningSecret) + duplicateNote;
        await this.transport.request({ method: "PATCH", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}`, headers: this.headers(), body: { body } });
        return { provider: this.provider, id: reference.id, url: item.html_url, title: item.title, body, state: "open", containerId: configuredRepository, repository: configuredRepository, labels: item.labels.map((label) => label.name), updatedAt: item.updated_at };
      },
    );
  }
  async addComment(itemId: string, body: string, idempotencyKey: string): Promise<void> {
    const reference = this.issueReference(itemId);
    const binding = { provider: this.provider, workItemId: reference.id } as const;
    const markedBody = trackerCommentBody(body, idempotencyKey, this.commentSigningSecret, binding);
    await this.#comments.run(
      idempotencyKey,
      workItemCommentFingerprint(this.provider, reference.id, markedBody),
      async () => {
        try {
          await this.transport.request({ method: "POST", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}/comments`, headers: { ...this.headers(), "x-idempotency-key": idempotencyKey }, body: { body: markedBody } });
        } catch (error) {
          if (error instanceof TrackerHttpError && isDefinitiveCreationRefusal(error.status)) throw new ProviderMutationRejectedError(error.message);
          throw error;
        }
        return true;
      },
      async () => undefined,
      async () => await this.hasComment(reference, markedBody) ? { found: true, result: undefined } : { found: false },
    );
  }
  async applyDisposition(itemId: string, disposition: Disposition, transitionId: string, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    const reference = this.issueReference(itemId);
    const commentKey = dispositionCommentIdempotencyKey(this.provider, reference.id, transitionId);
    if (disposition === "rejected") {
      await this.addComment(reference.id, `Disposition reason: ${reason!.trim()}`, commentKey);
    }
    const body = disposition === "accepted"
      ? { state: "open" }
      : { state: "closed", state_reason: disposition === "rejected" ? "not_planned" : "completed" };
    await this.transport.request({ method: "PATCH", url: `${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}`, headers: this.headers(), body });
    if (disposition !== "rejected" && reason?.trim()) await this.addComment(reference.id, `Disposition reason: ${reason.trim()}`, commentKey);
  }
  async processWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>, apply: (webhook: TrackerWebhook) => Promise<void>): Promise<void> {
    requireWebhookBody(body);
    if (!verifyHmacSha256(body, headers["x-hub-signature-256"], this.config.webhookSecret)) throw new Error("invalid GitHub webhook signature");
    const raw = parseObject(body, "GitHub");
    const deliveryId = requireDeliveryId(headers["x-github-delivery"]);
    const event = headers["x-github-event"];
    if (event !== "issue_comment" && event !== "issues") throw new Error("unsupported GitHub webhook event");
    const action = requireString(raw.action, "GitHub action");
    const repository = requireObject(raw.repository, "GitHub repository");
    const fullName = requireString(repository.full_name, "GitHub repository name");
    const expectedRepository = `${this.config.owner}/${this.config.repository}`.toLowerCase();
    const webhookRepository = repositoryInWorkspace(fullName, this.config.workspace.login);
    if ((this.config.webhookScope ?? "repository") === "repository" && webhookRepository !== expectedRepository) throw new Error("GitHub webhook repository does not match the configured repository");
    const issue = requireObject(raw.issue, "GitHub issue");
    if ("pull_request" in issue) throw new Error("GitHub pull request comments are outside the Work Item boundary");
    const issueNumber = requirePositiveInteger(issue.number, "GitHub issue number");
    const workItemId = this.issueReference(`${webhookRepository}#${issueNumber}`).id;
    let commentBody: string | undefined;
    let providerActorId: string | undefined;
    let providerCommentId: string | undefined;
    let projectedRaw: Readonly<Record<string, unknown>> = { action, repository: { full_name: webhookRepository }, issue: { number: issueNumber } };
    if (event === "issue_comment") {
      if (action !== "created") throw new Error("unsupported GitHub issue comment action");
      const comment = requireObject(raw.comment, "GitHub comment");
      providerCommentId = String(requirePositiveInteger(comment.id, "GitHub comment id"));
      const user = requireObject(comment.user, "GitHub comment user");
      providerActorId = String(requirePositiveInteger(user.id, "GitHub comment user id"));
      commentBody = requireString(comment.body, "GitHub comment body", true);
      projectedRaw = { ...projectedRaw, comment: { id: providerCommentId, body: commentBody, user: { id: providerActorId } } };
    }
    const webhook = { deliveryId, event, workItemId, commentBody, providerActorId, providerCommentId, raw: projectedRaw };
    await processUniqueDelivery(this.config.deliveries, this.provider, deliveryId, webhook, async (verified) => {
      if (!isTrackerCommentEcho(verified.commentBody, this.commentSigningSecret, { provider: this.provider, workItemId })) await apply(verified);
    });
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.config.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }; }

  private async hasComment(reference: { repository: string; number: string }, expectedBody: string): Promise<boolean> {
    for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES; page += 1) {
      const url = new URL(`${this.config.endpoint}/repos/${reference.repository}/issues/${reference.number}/comments`);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const comments = await this.transport.request<GitHubCommentRecord[]>({ method: "GET", url: url.toString(), headers: this.headers() });
      if (!Array.isArray(comments) || comments.length > 100 || comments.some((comment) => !comment || typeof comment.body !== "string")) throw new Error("invalid GitHub comment reconciliation response");
      if (comments.some((comment) => comment.body === expectedBody)) return true;
      if (comments.length < 100) return false;
    }
    throw new Error("GitHub comment reconciliation exceeded search limit");
  }

  private mapIssue(item: GitHubIssueRecord, fallbackRepository?: string): WorkItem {
    const body = item.body ?? "";
    const repository = item.repository_url ? repositoryFromApiUrl(item.repository_url) : fallbackRepository ?? repositoryFromIssueUrl(item.html_url);
    const reference = this.issueReference(`${repository}#${item.number}`);
    const stable = parseStableIssueContext(body, { provider: this.provider, workItemId: reference.id }, this.contextSigningSecret);
    return {
      provider: this.provider,
      id: reference.id,
      url: item.html_url,
      title: item.title,
      body,
      state: item.state === "closed" ? "closed" : "open",
      containerId: reference.repository,
      repository: reference.repository,
      product: stable.product,
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
    const scope = tier === "current_container" || (this.config.webhookScope ?? "repository") === "repository" ? repositoryScope : workspaceScope;
    const phrases = [context.route, context.anchorFingerprint, context.product]
      .filter((value): value is string => Boolean(value))
      .map(searchPhrase)
      .join(" OR ");
    return `${scope} is:issue${state} in:body (${phrases})`;
  }

  private issueReference(value: string): { id: string; repository: string; number: string } {
    const match = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#)?([1-9][0-9]*)$/.exec(value);
    if (!match) throw new Error("invalid GitHub issue id");
    const owner = match[1] ?? this.config.owner;
    const repositoryName = match[2] ?? this.config.repository;
    const number = match[3]!;
    if (owner.toLowerCase() !== this.config.workspace.login.toLowerCase()) throw new Error("GitHub issue is outside the configured workspace");
    requireSlug(repositoryName, "repository");
    const repository = `${owner}/${repositoryName}`.toLowerCase();
    const configuredRepository = `${this.config.owner}/${this.config.repository}`.toLowerCase();
    if ((this.config.webhookScope ?? "repository") === "repository" && repository !== configuredRepository) throw new Error("GitHub issue is outside the configured webhook scope");
    return { id: `${repository}#${number}`, repository, number };
  }
}

function repositoryInWorkspace(value: string, workspaceLogin: string): string {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match || match[1]!.toLowerCase() !== workspaceLogin.toLowerCase()) throw new Error("GitHub webhook repository is outside the configured workspace");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function searchPhrase(value: string): string {
  const literal = value.replace(/["\\\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return `"${literal}"`;
}

function requireSlug(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`invalid GitHub ${label}`);
  return value;
}

function parseObject(body: Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error(`invalid ${label} webhook JSON`);
  }
  return requireObject(parsed, `${label} webhook`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`invalid ${label}`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid ${label}`);
  return value as number;
}

function lookbackDate(now: string, days: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("search context now must be an ISO timestamp");
  return new Date(timestamp - days * 86_400_000).toISOString().slice(0, 10);
}

function isDefinitiveCreationRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
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
