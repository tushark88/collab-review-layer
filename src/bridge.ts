import type { Anchor } from "./domain.ts";

export const BRIDGE_PROTOCOL = "collab-review-layer.bridge" as const;
export const BRIDGE_WIRE_VERSION = 1 as const;
export const BRIDGE_PROTOCOL_VERSIONS = Object.freeze([1] as const);
export const BRIDGE_CAPABILITIES = Object.freeze(["navigation", "focus", "viewport", "variant", "anchor"] as const);

export type BridgeProtocolVersion = (typeof BRIDGE_PROTOCOL_VERSIONS)[number];
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeRole = "host" | "prototype";
export type BridgeState = "idle" | "negotiating" | "active" | "rejected";
export type BridgeMessageMode = "request" | "report";

export interface BridgeNavigationMessage {
  type: "navigation";
  mode: BridgeMessageMode;
  route: string;
}

export interface BridgeFocusMessage {
  type: "focus";
  mode: BridgeMessageMode;
  focused: boolean;
  anchorId?: string;
}

export interface BridgeViewportMessage {
  type: "viewport";
  mode: BridgeMessageMode;
  viewportId: string;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface BridgeVariantMessage {
  type: "variant";
  mode: BridgeMessageMode;
  variantId: string;
}

export type BridgeAnchorMessage =
  | { type: "anchor"; mode: "request"; anchor: Anchor }
  | { type: "anchor"; mode: "report"; anchor: Anchor; status: "attached" | "orphaned" };

export type BridgeOperationalMessage =
  | BridgeNavigationMessage
  | BridgeFocusMessage
  | BridgeViewportMessage
  | BridgeVariantMessage
  | BridgeAnchorMessage;

export interface BridgeHelloMessage {
  type: "bridge.hello";
  supportedVersions: number[];
  capabilities: string[];
}

export interface BridgeReadyMessage {
  type: "bridge.ready";
  protocolVersion: BridgeProtocolVersion;
  capabilities: BridgeCapability[];
}

export interface BridgeRejectMessage {
  type: "bridge.reject";
  reason: "unsupported_version";
}

export type BridgeWireOperationalMessage = BridgeOperationalMessage & { protocolVersion: BridgeProtocolVersion };
export type BridgeWireMessage = BridgeHelloMessage | BridgeReadyMessage | BridgeRejectMessage | BridgeWireOperationalMessage;

export interface BridgeEnvelope {
  protocol: typeof BRIDGE_PROTOCOL;
  wireVersion: typeof BRIDGE_WIRE_VERSION;
  sessionId: string;
  nonce: string;
  sequence: number;
  message: BridgeWireMessage;
}

export interface BridgeSessionConfig {
  role: BridgeRole;
  sessionId: string;
  nonce: string;
  allowedOrigins: readonly string[];
  capabilities: readonly BridgeCapability[];
  maxMessageBytes?: number;
}

export interface BridgeSessionSnapshot {
  role: BridgeRole;
  state: BridgeState;
  peerOrigin?: string;
  protocolVersion?: BridgeProtocolVersion;
  capabilities: readonly BridgeCapability[];
  nextInboundSequence: number;
  nextOutboundSequence: number;
}

export type BridgeReceiveResult =
  | { kind: "handshake"; reply?: BridgeEnvelope; snapshot: BridgeSessionSnapshot }
  | { kind: "message"; message: BridgeOperationalMessage; snapshot: BridgeSessionSnapshot };

export type BridgeProtocolErrorCode =
  | "invalid_config"
  | "invalid_origin"
  | "invalid_message"
  | "invalid_state"
  | "invalid_sequence"
  | "session_mismatch"
  | "unsupported_capability";

export class BridgeProtocolError extends Error {
  readonly code: BridgeProtocolErrorCode;

  constructor(code: BridgeProtocolErrorCode, message: string) {
    super(message);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

/**
 * Pure reference implementation of the cooperative host/prototype protocol.
 * A browser adapter owns postMessage wiring; this module owns validation,
 * negotiation, peer binding, sequencing, and capability enforcement.
 */
export class BridgeSession {
  readonly #role: BridgeRole;
  readonly #sessionId: string;
  readonly #nonce: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #availableCapabilities: ReadonlySet<BridgeCapability>;
  readonly #maxMessageBytes: number;
  #state: BridgeState = "idle";
  #peerOrigin?: string;
  #protocolVersion?: BridgeProtocolVersion;
  #negotiatedCapabilities = new Set<BridgeCapability>();
  #nextInboundSequence = 0;
  #nextOutboundSequence = 0;

  constructor(config: BridgeSessionConfig) {
    if (config.role !== "host" && config.role !== "prototype") fail("invalid_config", "bridge role is invalid");
    this.#role = config.role;
    this.#sessionId = requireIdentifier(config.sessionId, "bridge session id");
    this.#nonce = requireNonce(config.nonce);
    if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) fail("invalid_config", "bridge origin allowlist is required");
    const origins = config.allowedOrigins.map((origin) => normalizeOrigin(origin, "configured bridge origin"));
    if (new Set(origins).size !== origins.length) fail("invalid_config", "bridge origin allowlist contains duplicates");
    this.#allowedOrigins = new Set(origins);
    this.#availableCapabilities = new Set(parseCapabilities(config.capabilities, "configured bridge capabilities"));
    const maxMessageBytes = config.maxMessageBytes ?? 65_536;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 1_048_576) {
      fail("invalid_config", "bridge message limit must be between 1 and 1048576 bytes");
    }
    this.#maxMessageBytes = maxMessageBytes;
  }

  initiate(): BridgeEnvelope {
    if (this.#role !== "host" || this.#state !== "idle") fail("invalid_state", "only an idle host can initiate a bridge session");
    const envelope = this.#envelope({
      type: "bridge.hello",
      supportedVersions: [...BRIDGE_PROTOCOL_VERSIONS],
      capabilities: [...this.#availableCapabilities],
    });
    this.#state = "negotiating";
    return envelope;
  }

  receive(origin: string, value: unknown): BridgeReceiveResult {
    const normalizedOrigin = normalizeOrigin(origin, "received bridge origin");
    if (!this.#allowedOrigins.has(normalizedOrigin)) fail("invalid_origin", "bridge origin is not allowed");
    if (this.#peerOrigin !== undefined && this.#peerOrigin !== normalizedOrigin) fail("invalid_origin", "bridge session is already bound to another origin");
    const envelope = parseEnvelope(value, this.#maxMessageBytes);
    if (envelope.sessionId !== this.#sessionId || envelope.nonce !== this.#nonce) fail("session_mismatch", "bridge session identity does not match");
    if (envelope.sequence !== this.#nextInboundSequence) fail("invalid_sequence", "bridge message sequence is not contiguous");

    if (this.#state === "active") return this.#receiveOperational(normalizedOrigin, envelope);
    if (this.#role === "prototype" && this.#state === "idle") return this.#receiveHello(normalizedOrigin, envelope);
    if (this.#role === "host" && this.#state === "negotiating") return this.#receiveHandshakeResult(normalizedOrigin, envelope);
    fail("invalid_state", "bridge message is not valid in the current session state");
  }

  send(message: BridgeOperationalMessage): BridgeEnvelope {
    if (this.#state !== "active" || this.#protocolVersion === undefined) fail("invalid_state", "bridge handshake is not complete");
    const parsed = parseOperationalMessage(message, false);
    this.#requireCapability(parsed.type);
    return this.#envelope({ ...parsed, protocolVersion: this.#protocolVersion } as BridgeWireOperationalMessage);
  }

  snapshot(): BridgeSessionSnapshot {
    return {
      role: this.#role,
      state: this.#state,
      peerOrigin: this.#peerOrigin,
      protocolVersion: this.#protocolVersion,
      capabilities: [...this.#negotiatedCapabilities],
      nextInboundSequence: this.#nextInboundSequence,
      nextOutboundSequence: this.#nextOutboundSequence,
    };
  }

  #receiveHello(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (envelope.message.type !== "bridge.hello") fail("invalid_state", "prototype expected a bridge hello");
    this.#peerOrigin = origin;
    this.#nextInboundSequence += 1;
    if (!envelope.message.supportedVersions.includes(1)) {
      const reply = this.#envelope({ type: "bridge.reject", reason: "unsupported_version" });
      this.#state = "rejected";
      return { kind: "handshake", reply, snapshot: this.snapshot() };
    }
    const capabilities = envelope.message.capabilities.filter(
      (capability): capability is BridgeCapability => isBridgeCapability(capability) && this.#availableCapabilities.has(capability),
    );
    this.#protocolVersion = 1;
    this.#negotiatedCapabilities = new Set(capabilities);
    const reply = this.#envelope({ type: "bridge.ready", protocolVersion: 1, capabilities });
    this.#state = "active";
    return { kind: "handshake", reply, snapshot: this.snapshot() };
  }

  #receiveHandshakeResult(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (envelope.message.type === "bridge.reject") {
      this.#peerOrigin = origin;
      this.#nextInboundSequence += 1;
      this.#state = "rejected";
      return { kind: "handshake", snapshot: this.snapshot() };
    }
    if (envelope.message.type !== "bridge.ready") fail("invalid_state", "host expected a bridge ready or reject message");
    const capabilities = parseCapabilities(envelope.message.capabilities, "negotiated bridge capabilities");
    if (envelope.message.protocolVersion !== 1 || capabilities.some((capability) => !this.#availableCapabilities.has(capability))) {
      fail("invalid_message", "bridge negotiation selected unsupported capabilities or version");
    }
    this.#peerOrigin = origin;
    this.#protocolVersion = envelope.message.protocolVersion;
    this.#negotiatedCapabilities = new Set(capabilities);
    this.#nextInboundSequence += 1;
    this.#state = "active";
    return { kind: "handshake", snapshot: this.snapshot() };
  }

  #receiveOperational(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (this.#peerOrigin !== origin || this.#protocolVersion === undefined) fail("invalid_origin", "bridge peer origin is not bound");
    const message = parseOperationalMessage(envelope.message, true);
    if (message.protocolVersion !== this.#protocolVersion) fail("invalid_message", "bridge protocol version changed during the session");
    const { protocolVersion: _protocolVersion, ...operational } = message;
    this.#requireCapability(operational.type);
    this.#nextInboundSequence += 1;
    return { kind: "message", message: structuredClone(operational) as BridgeOperationalMessage, snapshot: this.snapshot() };
  }

  #requireCapability(capability: BridgeCapability): void {
    if (!this.#negotiatedCapabilities.has(capability)) fail("unsupported_capability", `bridge capability is not negotiated: ${capability}`);
  }

  #envelope(message: BridgeWireMessage): BridgeEnvelope {
    const envelope: BridgeEnvelope = {
      protocol: BRIDGE_PROTOCOL,
      wireVersion: BRIDGE_WIRE_VERSION,
      sessionId: this.#sessionId,
      nonce: this.#nonce,
      sequence: this.#nextOutboundSequence,
      message: structuredClone(message),
    };
    assertBoundedJson(envelope, this.#maxMessageBytes);
    this.#nextOutboundSequence += 1;
    return envelope;
  }
}

function parseEnvelope(value: unknown, maxMessageBytes: number): BridgeEnvelope {
  assertBoundedJson(value, maxMessageBytes);
  const object = requireExactKeys(
    requireObject(value, "bridge envelope"),
    ["protocol", "wireVersion", "sessionId", "nonce", "sequence", "message"],
    [],
    "bridge envelope",
  );
  if (object.protocol !== BRIDGE_PROTOCOL || object.wireVersion !== BRIDGE_WIRE_VERSION) fail("invalid_message", "bridge envelope protocol is invalid");
  const sequence = requireSafeInteger(object.sequence, "bridge sequence", 0, Number.MAX_SAFE_INTEGER);
  return {
    protocol: BRIDGE_PROTOCOL,
    wireVersion: BRIDGE_WIRE_VERSION,
    sessionId: requireIdentifier(object.sessionId, "bridge session id"),
    nonce: requireNonce(object.nonce),
    sequence,
    message: parseWireMessage(object.message),
  };
}

function parseWireMessage(value: unknown): BridgeWireMessage {
  const candidate = requireObject(value, "bridge message");
  const type = requireString(requireOwnField(candidate, "type", "bridge message"), "bridge message type", 64);
  if (type === "bridge.hello") {
    const object = requireExactKeys(candidate, ["type", "supportedVersions", "capabilities"], [], "bridge hello");
    const versions = requireArray(object.supportedVersions, "bridge supported versions").map((version) => requireSafeInteger(version, "bridge protocol version", 1, 65_535));
    if (versions.length === 0 || new Set(versions).size !== versions.length) fail("invalid_message", "bridge supported versions are empty or duplicated");
    return { type, supportedVersions: versions, capabilities: parseCapabilityNames(object.capabilities, "bridge requested capabilities") };
  }
  if (type === "bridge.ready") {
    const object = requireExactKeys(candidate, ["type", "protocolVersion", "capabilities"], [], "bridge ready");
    return {
      type,
      protocolVersion: requireSafeInteger(object.protocolVersion, "bridge protocol version", 1, 1) as BridgeProtocolVersion,
      capabilities: parseCapabilities(object.capabilities, "bridge negotiated capabilities"),
    };
  }
  if (type === "bridge.reject") {
    const object = requireExactKeys(candidate, ["type", "reason"], [], "bridge reject");
    if (object.reason !== "unsupported_version") fail("invalid_message", "bridge rejection reason is invalid");
    return { type, reason: object.reason };
  }
  return parseOperationalMessage(candidate, true);
}

function parseOperationalMessage(value: unknown, wire: false): BridgeOperationalMessage;
function parseOperationalMessage(value: unknown, wire: true): BridgeWireOperationalMessage;
function parseOperationalMessage(value: unknown, wire: boolean): BridgeOperationalMessage | BridgeWireOperationalMessage {
  const candidate = requireObject(value, "bridge operational message");
  const type = requireCapability(requireOwnField(candidate, "type", "bridge operational message"), "bridge operational message type");
  const mode = requireMode(requireOwnField(candidate, "mode", "bridge operational message"));
  const protocolVersion = wire
    ? requireSafeInteger(requireOwnField(candidate, "protocolVersion", "bridge operational message"), "bridge protocol version", 1, 1) as BridgeProtocolVersion
    : undefined;
  const versionKey = wire ? ["protocolVersion"] : [];
  if (type === "navigation") {
    const object = requireExactKeys(candidate, ["type", "mode", "route", ...versionKey], [], "bridge navigation message");
    return withProtocolVersion({ type, mode, route: requireRoute(object.route) }, protocolVersion);
  }
  if (type === "focus") {
    const object = requireExactKeys(candidate, ["type", "mode", "focused", ...versionKey], ["anchorId"], "bridge focus message");
    if (typeof object.focused !== "boolean") fail("invalid_message", "bridge focus state must be boolean");
    const message: BridgeFocusMessage = { type, mode, focused: object.focused };
    if (object.anchorId !== undefined) message.anchorId = requireIdentifier(object.anchorId, "bridge focus anchor id");
    return withProtocolVersion(message, protocolVersion);
  }
  if (type === "viewport") {
    const object = requireExactKeys(
      candidate,
      ["type", "mode", "viewportId", "width", "height", "devicePixelRatio", ...versionKey],
      [],
      "bridge viewport message",
    );
    return withProtocolVersion({
      type,
      mode,
      viewportId: requireIdentifier(object.viewportId, "bridge viewport id"),
      width: requireSafeInteger(object.width, "bridge viewport width", 1, 16_384),
      height: requireSafeInteger(object.height, "bridge viewport height", 1, 16_384),
      devicePixelRatio: requireFiniteNumber(object.devicePixelRatio, "bridge device pixel ratio", 0.1, 10),
    }, protocolVersion);
  }
  if (type === "variant") {
    const object = requireExactKeys(candidate, ["type", "mode", "variantId", ...versionKey], [], "bridge variant message");
    return withProtocolVersion({ type, mode, variantId: requireIdentifier(object.variantId, "bridge variant id") }, protocolVersion);
  }
  const object = requireExactKeys(
    candidate,
    mode === "request" ? ["type", "mode", "anchor", ...versionKey] : ["type", "mode", "anchor", "status", ...versionKey],
    [],
    "bridge anchor message",
  );
  const anchor = parseAnchor(object.anchor);
  if (mode === "request") {
    return withProtocolVersion({ type, mode, anchor }, protocolVersion);
  }
  if (object.status !== "attached" && object.status !== "orphaned") fail("invalid_message", "bridge anchor report status is invalid");
  return withProtocolVersion({ type, mode, anchor, status: object.status }, protocolVersion);
}

function withProtocolVersion<T extends BridgeOperationalMessage>(message: T, protocolVersion: BridgeProtocolVersion | undefined): T | (T & { protocolVersion: BridgeProtocolVersion }) {
  return protocolVersion === undefined ? message : { ...message, protocolVersion };
}

function parseAnchor(value: unknown): Anchor {
  const object = requireExactKeys(
    requireObject(value, "bridge anchor"),
    ["schemaVersion", "geometry", "scroll"],
    ["semantic", "text"],
    "bridge anchor",
  );
  if (object.schemaVersion !== 1) fail("invalid_message", "bridge anchor schema version is invalid");
  const geometry = parseRatios(object.geometry, "bridge anchor geometry");
  const scroll = parseRatios(object.scroll, "bridge anchor scroll");
  const anchor: Anchor = { schemaVersion: 1, geometry, scroll };
  if (object.semantic !== undefined) {
    const semantic = requireExactKeys(
      requireObject(object.semantic, "bridge semantic anchor"),
      [],
      ["role", "accessibleName", "testId"],
      "bridge semantic anchor",
    );
    anchor.semantic = {};
    if (semantic.role !== undefined) anchor.semantic.role = requireString(semantic.role, "bridge anchor role", 256, true);
    if (semantic.accessibleName !== undefined) anchor.semantic.accessibleName = requireString(semantic.accessibleName, "bridge anchor accessible name", 2_048, true);
    if (semantic.testId !== undefined) anchor.semantic.testId = requireString(semantic.testId, "bridge anchor test id", 256, true);
  }
  if (object.text !== undefined) {
    const text = requireExactKeys(
      requireObject(object.text, "bridge text anchor"),
      ["exact"],
      ["prefix", "suffix"],
      "bridge text anchor",
    );
    anchor.text = { exact: requireAnchorText(text.exact, "bridge anchor exact text", 4_096) };
    if (text.prefix !== undefined) anchor.text.prefix = requireAnchorText(text.prefix, "bridge anchor text prefix", 1_024);
    if (text.suffix !== undefined) anchor.text.suffix = requireAnchorText(text.suffix, "bridge anchor text suffix", 1_024);
  }
  return anchor;
}

function parseRatios(value: unknown, label: string): { xRatio: number; yRatio: number } {
  const object = requireExactKeys(requireObject(value, label), ["xRatio", "yRatio"], [], label);
  return {
    xRatio: requireFiniteNumber(object.xRatio, `${label} x ratio`, 0, 1),
    yRatio: requireFiniteNumber(object.yRatio, `${label} y ratio`, 0, 1),
  };
}

function parseCapabilities(value: unknown, label: string): BridgeCapability[] {
  const values = requireArray(value, label).map((capability) => requireCapability(capability, label));
  if (new Set(values).size !== values.length) fail("invalid_message", `${label} contain duplicates`);
  return values;
}

function parseCapabilityNames(value: unknown, label: string): string[] {
  const values = requireArray(value, label).map((capability) => requireString(capability, label, 64));
  if (new Set(values).size !== values.length) fail("invalid_message", `${label} contain duplicates`);
  return values;
}

function isBridgeCapability(value: string): value is BridgeCapability {
  return BRIDGE_CAPABILITIES.includes(value as BridgeCapability);
}

function requireCapability(value: unknown, label: string): BridgeCapability {
  if (typeof value !== "string" || !BRIDGE_CAPABILITIES.includes(value as BridgeCapability)) fail("invalid_message", `${label} are invalid`);
  return value as BridgeCapability;
}

function requireMode(value: unknown): BridgeMessageMode {
  if (value !== "request" && value !== "report") fail("invalid_message", "bridge message mode is invalid");
  return value;
}

function requireRoute(value: unknown): string {
  const route = requireString(value, "bridge route", 2_048);
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /[\u0000-\u001f\u007f]/u.test(route)) {
    fail("invalid_message", "bridge route must be an origin-relative path");
  }
  const base = new URL("https://bridge.invalid");
  if (new URL(route, base).origin !== base.origin) fail("invalid_message", "bridge route must not change origin");
  return route;
}

function requireIdentifier(value: unknown, label: string): string {
  return requireString(value, label, 256);
}

function requireNonce(value: unknown): string {
  const nonce = requireString(value, "bridge nonce", 256);
  if (nonce.length < 16) fail("invalid_message", "bridge nonce must contain at least 16 characters");
  return nonce;
}

function requireString(value: unknown, label: string, maxLength: number, allowWhitespace = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    fail("invalid_message", `${label} is invalid`);
  }
  if (!allowWhitespace && !value.trim()) fail("invalid_message", `${label} is invalid`);
  return value;
}

function requireAnchorText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\u0000")) fail("invalid_message", `${label} is invalid`);
  return value;
}

function assertBoundedJson(value: unknown, maximumBytes: number): void {
  let bytes = 0;
  const active = new WeakSet<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > maximumBytes) fail("invalid_message", "bridge message exceeds the configured limit");
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > 64) fail("invalid_message", "bridge message nesting is too deep");
    if (current === null) {
      add(4);
      return;
    }
    if (typeof current === "string") {
      addJsonStringBytes(current, add);
      return;
    }
    if (typeof current === "boolean") {
      add(current ? 4 : 5);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("invalid_message", "bridge message numbers must be finite");
      add(JSON.stringify(current).length);
      return;
    }
    if (typeof current !== "object") fail("invalid_message", "bridge message must be JSON-compatible");
    if (active.has(current)) fail("invalid_message", "bridge message must not contain cycles");
    active.add(current);
    if (Array.isArray(current)) {
      add(2);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor) fail("invalid_message", "bridge message arrays must not be sparse");
        if (!descriptor.enumerable || !("value" in descriptor)) fail("invalid_message", "bridge message arrays must contain enumerable data properties");
        if (index > 0) add(1);
        visit(descriptor.value, depth + 1);
      }
      active.delete(current);
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_message", "bridge message objects must be plain records");
    add(2);
    let entries = 0;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) fail("invalid_message", "bridge message accessors are not allowed");
      if (entries > 0) add(1);
      addJsonStringBytes(key, add);
      add(1);
      visit(descriptor.value, depth + 1);
      entries += 1;
    }
    active.delete(current);
  };
  visit(value, 0);
}

function addJsonStringBytes(value: string, add: (count: number) => void): void {
  add(2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      add(2);
    } else if (code <= 0x1f) {
      add(6);
    } else if (code <= 0x7f) {
      add(1);
    } else if (code <= 0x7ff) {
      add(2);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : undefined;
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        add(4);
        index += 1;
      } else {
        add(6);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      add(6);
    } else {
      add(3);
    }
  }
}

function requireSafeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail("invalid_message", `${label} is invalid`);
  return value as number;
}

function requireFiniteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("invalid_message", `${label} is invalid`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid_message", `${label} are invalid`);
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("invalid_message", `${label} must contain enumerable data properties`);
    values.push(descriptor.value);
  }
  return values;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_message", `${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("invalid_message", `${label} must be a plain record`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const allowedKeys = new Set([...required, ...optional]);
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (!allowedKeys.has(key)) fail("invalid_message", `${label} contains unknown fields`);
    fields[key] = requireOwnField(object, key, label);
  }
  for (const key of required) fields[key] = requireOwnField(object, key, label);
  for (const key of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined) fields[key] = requireOwnField(object, key, label);
  }
  return fields;
}

function requireOwnField(object: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    fail("invalid_message", `${label} field ${key} must be an enumerable own data property`);
  }
  return descriptor.value;
}

function normalizeOrigin(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "*" || value === "null") fail("invalid_origin", `${label} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_origin", `${label} is invalid`);
  }
  if (url.username || url.password || url.origin === "null") fail("invalid_origin", `${label} is invalid`);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) fail("invalid_origin", `${label} must use HTTPS outside loopback development`);
  if (url.pathname !== "/" || url.search || url.hash) fail("invalid_origin", `${label} must contain only an origin`);
  return url.origin;
}

function fail(code: BridgeProtocolErrorCode, message: string): never {
  throw new BridgeProtocolError(code, message);
}
