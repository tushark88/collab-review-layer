import type { Disposition } from "../domain.ts";
import type { JsonTransport } from "./http.ts";
import { InMemoryWorkItemCreationRecovery, isTrackerCommentEcho, parseStableIssueContext, stableIssueBody, trackerCommentBody, workItemDraftFingerprint, type SearchContext, type SearchTier, type TrackerWebhook, type WorkContainer, type WorkItem, type WorkItemDraft, type WorkTracker } from "../tracker.ts";
import { processUniqueDelivery, requireDeliveryId, requireFreshTimestamp, requireWebhookBody, verifyHmacSha256, type WebhookDeliveryLedger } from "../webhook.ts";

export interface LinearConfig {
  endpoint: string;
  token: string;
  webhookSecret: string;
  contextSigningSecret?: string;
  teamId: string;
  now: () => number;
  deliveries: WebhookDeliveryLedger;
  closedLookbackDays?: number;
  dispositionStateIds: { accepted: string; rejected: string; implemented_verified: string };
}

interface LinearIssueRecord {
  id: string;
  url: string;
  title: string;
  description?: string;
  state: { type: string };
  project?: { id: string };
  labels: { nodes: { name: string }[] };
  updatedAt: string;
}

interface LinearIssueConnection {
  nodes: LinearIssueRecord[];
  pageInfo: { hasNextPage: boolean; endCursor?: string };
}

interface LinearCreatedIssue {
  id: string;
  url: string;
  title: string;
  updatedAt: string;
}

const MAX_LINEAR_SEARCH_PAGES = 20;
const MAX_LINEAR_SEARCH_RESULTS = 1_000;

export class LinearTracker implements WorkTracker {
  readonly provider = "linear" as const;
  readonly config: LinearConfig;
  readonly transport: JsonTransport;
  readonly contextSigningSecret: string;
  readonly #creations = new InMemoryWorkItemCreationRecovery<LinearCreatedIssue, WorkItem>();
  constructor(config: LinearConfig, transport: JsonTransport) {
    const lookback = config.closedLookbackDays ?? 90;
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > 3650) throw new Error("closed lookback must be between 1 and 3650 days");
    this.config = config;
    this.transport = transport;
    this.contextSigningSecret = config.contextSigningSecret ?? config.webhookSecret;
    if (!this.contextSigningSecret) throw new Error("Linear context signing secret is required");
  }

  async findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer> {
    const data = await this.graphql<{ projects: { nodes: { id: string; name: string }[] } }>(`query($name:String!){projects(filter:{name:{eq:$name}}){nodes{id name}}}`, { name: input.name });
    const existing = data.projects.nodes[0];
    if (existing) return { provider: this.provider, id: existing.id, workspaceId: input.workspaceId, name: existing.name };
    const created = await this.graphql<{ projectCreate: { success: boolean; project: { id: string; name: string } } }>(`mutation($name:String!,$teamIds:[String!]!){projectCreate(input:{name:$name,teamIds:$teamIds}){success project{id name}}}`, { name: input.name, teamIds: [this.config.teamId] });
    requireMutationSuccess(created.projectCreate?.success, "project creation");
    return { provider: this.provider, id: created.projectCreate.project.id, workspaceId: input.workspaceId, name: created.projectCreate.project.name };
  }

  async candidates(context: SearchContext, tier: SearchTier = "current_container"): Promise<readonly WorkItem[]> {
    if (tier === "exact_link") {
      if (!context.exactLinkedId) return [];
      const data = await this.graphql<{ issue: LinearIssueRecord | null }>(`query($id:String!){issue(id:$id){id url title description updatedAt state{type} project{id} labels{nodes{name}}}}`, { id: context.exactLinkedId });
      return data.issue ? [this.mapIssue(data.issue)] : [];
    }

    const nodes: LinearIssueRecord[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    let complete = false;
    for (let page = 0; page < MAX_LINEAR_SEARCH_PAGES; page += 1) {
      const data = await this.graphql<{ issueSearch: LinearIssueConnection }>(`query($term:String!,$after:String){issueSearch(query:$term,first:50,after:$after){nodes{id url title description updatedAt state{type} project{id} labels{nodes{name}}} pageInfo{hasNextPage endCursor}}}`, { term: searchTerm(context), after });
      if (!Array.isArray(data.issueSearch.nodes) || data.issueSearch.nodes.length > 50) throw new Error("invalid Linear search page");
      if (nodes.length + data.issueSearch.nodes.length > MAX_LINEAR_SEARCH_RESULTS) return [];
      nodes.push(...data.issueSearch.nodes);
      if (!data.issueSearch.pageInfo.hasNextPage) {
        complete = true;
        break;
      }
      const next = data.issueSearch.pageInfo.endCursor;
      if (!next || cursors.has(next)) throw new Error("invalid Linear search cursor");
      cursors.add(next);
      after = next;
    }
    if (!complete) return [];
    const items = nodes.map((node) => this.mapIssue(node));
    if (tier === "current_container") return items.filter((item) => item.containerId === context.container.id);
    if (tier === "open_workspace") return items.filter((item) => item.state === "open");
    const cutoff = lookbackTimestamp(context.now, this.config.closedLookbackDays ?? 90);
    return items.filter((item) => item.state === "closed" && Date.parse(item.updatedAt) >= cutoff);
  }

  async createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> {
    return this.#creations.run(
      draft.idempotencyKey,
      workItemDraftFingerprint(container, draft),
      async () => {
        const data = await this.graphql<{ issueCreate: { success: boolean; issue: LinearCreatedIssue } }>(`mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id url title updatedAt}}}`, { input: { teamId: this.config.teamId, projectId: container.id, title: draft.title, description: "Collaborative review context is being attached.", labelIds: [] } });
        requireMutationSuccess(data.issueCreate?.success, "issue creation");
        return data.issueCreate.issue;
      },
      async (issue) => {
        const duplicateNote = draft.possibleDuplicateUrl ? `\n\nPossible duplicate: ${draft.possibleDuplicateUrl}` : "";
        const body = stableIssueBody(draft.context, { provider: this.provider, workItemId: issue.id }, this.contextSigningSecret) + duplicateNote;
        const updated = await this.graphql<{ issueUpdate: { success: boolean } }>(`mutation($id:String!,$description:String!){issueUpdate(id:$id,input:{description:$description}){success}}`, { id: issue.id, description: body });
        requireMutationSuccess(updated.issueUpdate?.success, "issue context attachment");
        return { provider: this.provider, id: issue.id, url: issue.url, title: issue.title, body, state: "open", containerId: container.id, labels: draft.labels, updatedAt: issue.updatedAt };
      },
    );
  }

  async addComment(itemId: string, body: string, idempotencyKey: string): Promise<void> {
    const data = await this.graphql<{ commentCreate: { success: boolean } }>(`mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}`, { input: { issueId: itemId, body: trackerCommentBody(body, idempotencyKey, this.contextSigningSecret) } });
    requireMutationSuccess(data.commentCreate?.success, "comment creation");
  }
  async applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    if (disposition === "rejected") {
      await this.addComment(itemId, `Review disposition requested: rejected — ${reason!.trim()}`, `disposition:${disposition}`);
    }
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(`mutation($id:String!,$stateId:String!){issueUpdate(id:$id,input:{stateId:$stateId}){success}}`, { id: itemId, stateId: this.config.dispositionStateIds[disposition] });
    requireMutationSuccess(data.issueUpdate?.success, "disposition update");
    if (disposition !== "rejected") {
      await this.addComment(itemId, `Review disposition: ${disposition}${reason?.trim() ? ` — ${reason.trim()}` : ""}`, `disposition:${disposition}`);
    }
  }
  async processWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>, apply: (webhook: TrackerWebhook) => Promise<void>): Promise<void> {
    requireWebhookBody(body);
    if (!verifyHmacSha256(body, headers["linear-signature"], this.config.webhookSecret, "")) throw new Error("invalid Linear webhook signature");
    const raw = parseObject(body, "Linear");
    const webhookTimestamp = raw.webhookTimestamp;
    if (webhookTimestamp !== undefined && typeof webhookTimestamp !== "string" && typeof webhookTimestamp !== "number") throw new Error("invalid Linear webhook timestamp");
    requireFreshTimestamp(webhookTimestamp ?? headers["linear-timestamp"], this.config.now());
    const deliveryId = requireDeliveryId(headers["linear-delivery"]);
    const event = requireString(raw.type, "Linear event type");
    if (event !== "Comment" && event !== "Issue") throw new Error("unsupported Linear webhook event");
    if (headers["linear-event"] && headers["linear-event"] !== event) throw new Error("Linear webhook event does not match its payload");
    const action = raw.action === undefined ? undefined : requireString(raw.action, "Linear action");
    const data = requireObject(raw.data, "Linear data");
    const workItemId = event === "Comment"
      ? requireLinearId(data.issueId, "comment issue")
      : requireLinearId(data.id, "issue");
    const commentBody = event === "Comment" ? requireString(data.body, "Linear comment body", true) : undefined;
    const projectedData = event === "Comment"
      ? { id: requireLinearId(data.id, "comment"), issueId: workItemId, body: commentBody }
      : { id: workItemId };
    const projectedRaw = { type: event, ...(action ? { action } : {}), data: projectedData };
    const webhook = { deliveryId, event, workItemId, commentBody, raw: projectedRaw };
    await processUniqueDelivery(this.config.deliveries, this.provider, deliveryId, webhook, async (verified) => {
      if (!isTrackerCommentEcho(verified.commentBody, this.contextSigningSecret)) await apply(verified);
    });
  }
  async graphql<T>(query: string, variables: unknown): Promise<T> {
    const response = await this.transport.request<{ data?: T; errors?: unknown }>({ method: "POST", url: this.config.endpoint, headers: { authorization: this.config.token }, body: { query, variables } });
    if (!response.data || response.errors) throw new Error("Linear GraphQL operation failed");
    return response.data;
  }

  private mapIssue(node: LinearIssueRecord): WorkItem {
    const body = node.description ?? "";
    const stable = parseStableIssueContext(body, { provider: this.provider, workItemId: node.id }, this.contextSigningSecret);
    return {
      provider: this.provider,
      id: node.id,
      url: node.url,
      title: node.title,
      body,
      state: node.state.type === "completed" || node.state.type === "canceled" ? "closed" : "open",
      containerId: node.project?.id,
      route: stable.route,
      anchorFingerprint: stable.anchorFingerprint,
      labels: node.labels.nodes.map((label) => label.name),
      updatedAt: node.updatedAt,
    };
  }
}

function searchTerm(context: SearchContext): string {
  return [context.route, context.anchorFingerprint, context.repository, context.product]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim())
    .join(" ");
}

function lookbackTimestamp(now: string, days: number): number {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("search context now must be an ISO timestamp");
  return timestamp - days * 86_400_000;
}

function requireLinearId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid Linear ${label} id`);
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

function requireMutationSuccess(value: unknown, label: string): void {
  if (value !== true) throw new Error(`Linear ${label} was not accepted`);
}
