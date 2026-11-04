/** Existing native worker wire format. Parsing alone grants no execution. */
export interface NativeAuthorization {
  readonly version: 1;
  readonly machineID: string;
  readonly leaseID: string;
  readonly revision: number;
  readonly boot: number;
  readonly bootSessionID: string;
  readonly deadline: number;
  readonly fenced: boolean;
}

const fields = ["version", "machineID", "leaseID", "revision", "boot", "bootSessionID", "deadline", "fenced"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

export function parseNativeAuthorization(value: unknown): NativeAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid native execution authorization.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key)) ||
      record.version !== 1 || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
      !time(record.boot) || !time(record.deadline) || typeof record.fenced !== "boolean" ||
      [record.machineID, record.leaseID, record.bootSessionID].some(id => typeof id !== "string" || !uuid.test(id))) {
    throw new TypeError("Invalid native execution authorization.");
  }
  return Object.freeze({
    version: 1,
    machineID: (record.machineID as string).toLowerCase(),
    leaseID: (record.leaseID as string).toLowerCase(),
    revision: record.revision as number,
    boot: record.boot,
    bootSessionID: (record.bootSessionID as string).toLowerCase(),
    deadline: record.deadline,
    fenced: record.fenced,
  });
}
