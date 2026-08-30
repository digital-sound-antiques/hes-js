/**
 * Generic state snapshots.
 *
 * A snapshot has to carry every mutable field of the machine and nothing else,
 * and the surest way to get that is to not enumerate the fields by hand: this
 * walks the object graph and copies whatever it finds. What must stay out - the
 * constant lookup tables, and the references each part holds to its host - is
 * declared with `#private` fields, which are invisible to this walk. Forgetting
 * to save a new field therefore becomes impossible, which matters because the
 * symptom of a missed field is a seek that sounds subtly wrong rather than an
 * error.
 */

type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

function isTypedArray(v: unknown): v is TypedArray {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** Deep copy of every enumerable field, transferable across a worker boundary. */
export function snapshot(value: unknown): unknown {
  if (isTypedArray(value)) return value.slice();
  if (Array.isArray(value)) return value.map(snapshot);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = snapshot((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Write a snapshot back over a live object, in place. */
export function restore(target: unknown, saved: unknown): void {
  if (isTypedArray(target)) {
    (target as TypedArray).set(saved as TypedArray as never);
    return;
  }
  if (target === null || typeof target !== "object" || saved === null || typeof saved !== "object") {
    return;
  }
  const t = target as Record<string, unknown>;
  const s = saved as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    const value = s[key];
    const current = t[key];
    if (isTypedArray(current)) (current as TypedArray).set(value as TypedArray as never);
    else if (value !== null && typeof value === "object" && current !== null && typeof current === "object") {
      restore(current, value);
    } else {
      t[key] = value;
    }
  }
}
