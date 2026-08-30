export type Id = string;

export interface ReviewContext {
  reviewId: Id;
  prototypeId: Id;
  revisionId: Id;
  viewportId: Id;
  variantId: Id;
  route: string;
}

export interface Anchor {
  schemaVersion: 1;
  semantic?: { role?: string; accessibleName?: string; testId?: string };
  text?: { exact: string; prefix?: string; suffix?: string };
  geometry: { xRatio: number; yRatio: number };
  scroll: { xRatio: number; yRatio: number };
}

export interface Capture {
  id: Id;
  digest: `sha256:${string}`;
  mediaType: string;
  createdAt: string;
}

export type Disposition = "accepted" | "rejected" | "implemented_verified";

export interface Message {
  id: Id;
  authorId: Id;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface Thread {
  id: Id;
  context: ReviewContext;
  anchor: Anchor;
  capture?: Capture;
  messages: Message[];
  resolvedAt?: string;
  disposition?: Disposition;
  dispositionReason?: string;
}

export interface DomainEvent<T = unknown> {
  id: Id;
  sequence: number;
  reviewId: Id;
  type: string;
  occurredAt: string;
  actorId: Id;
  payload: T;
}
