export type AnchorConstraintResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

export const ANCHOR_IDENTIFIER_MAXIMUM_LENGTH = 256;
export const ANCHOR_SELECTOR_MAXIMUM_LENGTH = 4_096;
export const ANCHOR_DOCUMENT_COORDINATE_MAXIMUM = 16_777_216;
export const ANCHOR_ELEMENT_OFFSET_MINIMUM = -ANCHOR_DOCUMENT_COORDINATE_MAXIMUM;

export function readAnchorIdentifier(value: unknown): AnchorConstraintResult<string> {
  return readSingleLine(value, ANCHOR_IDENTIFIER_MAXIMUM_LENGTH, false);
}

export function readAnchorSelector(value: unknown): AnchorConstraintResult<string> {
  return readSingleLine(value, ANCHOR_SELECTOR_MAXIMUM_LENGTH, false);
}

export function readAnchorMetadata(value: unknown, maximumLength: number): AnchorConstraintResult<string> {
  return readSingleLine(value, maximumLength, true);
}

export function readAnchorText(value: unknown, maximumLength: number): AnchorConstraintResult<string> {
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\u0000")) return { ok: false };
  return { ok: true, value };
}

export function readAnchorCoordinate(value: unknown, minimum: number): AnchorConstraintResult<number> {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > ANCHOR_DOCUMENT_COORDINATE_MAXIMUM
  ) return { ok: false };
  return { ok: true, value };
}

function readSingleLine(value: unknown, maximumLength: number, allowEmptyOrWhitespace: boolean): AnchorConstraintResult<string> {
  if (
    typeof value !== "string"
    || value.length > maximumLength
    || value.includes("\u0000")
    || value.includes("\r")
    || value.includes("\n")
    || (!allowEmptyOrWhitespace && !value.trim())
  ) return { ok: false };
  return { ok: true, value };
}
