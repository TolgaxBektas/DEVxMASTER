import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export type AuditEntry = {
  seq: number;
  tenantId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  detailsJson?: string | null;
  actorId?: string | number | null;
  actorName?: string | null;
  prevHash: string;
  hash: string;
  createdAt?: Date;
};

export type AuditRepository = {
  latest(): Promise<Pick<AuditEntry, "seq" | "hash"> | null>;
  insert(entry: AuditEntry): Promise<void>;
  list(): Promise<AuditEntry[]>;
};

export function computeAuditHash(
  entry: Omit<AuditEntry, "hash" | "createdAt">,
): string {
  const payload = [
    entry.seq,
    entry.action,
    entry.entityType,
    entry.entityId ?? "",
    entry.detailsJson ?? "",
    entry.actorId ?? "",
    entry.prevHash,
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export async function appendAudit(
  repository: AuditRepository,
  params: Omit<AuditEntry, "seq" | "prevHash" | "hash" | "createdAt">,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<AuditEntry> {
  const maxAttempts = options.maxAttempts ?? 5;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const detailsJson = params.detailsJson ?? null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latest = await repository.latest();
    const prevHash = latest?.hash ?? GENESIS_HASH;
    const seq = (latest?.seq ?? 0) + 1;
    const entry: AuditEntry = {
      ...params,
      detailsJson,
      seq,
      prevHash,
      hash: computeAuditHash({ ...params, detailsJson, seq, prevHash }),
      createdAt: new Date(),
    };
    try {
      await repository.insert(entry);
      return entry;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (
        !/duplicate|unique|ER_DUP_ENTRY/i.test(message) ||
        attempt === maxAttempts - 1
      )
        throw error;
      await sleep(25 + Math.floor(random() * 150) * (attempt + 1));
    }
  }
  throw new Error(
    "Audit-Eintrag konnte nach mehreren Versuchen nicht geschrieben werden",
  );
}

export async function verifyAuditChain(repository: AuditRepository) {
  const entries = (await repository.list()).sort((a, b) => a.seq - b.seq);
  let previous = GENESIS_HASH;
  for (const entry of entries) {
    const expected = computeAuditHash(entry);
    if (entry.prevHash !== previous || entry.hash !== expected) {
      return {
        ok: false,
        totalEntries: entries.length,
        brokenAtSeq: entry.seq,
      };
    }
    previous = entry.hash;
  }
  return { ok: true, totalEntries: entries.length, brokenAtSeq: null };
}

export class MemoryAuditRepository implements AuditRepository {
  readonly entries: AuditEntry[] = [];
  private forcedCollision = false;

  forceNextCollision(): void {
    this.forcedCollision = true;
  }
  async latest() {
    return this.entries.at(-1) ?? null;
  }
  async insert(entry: AuditEntry) {
    if (this.forcedCollision) {
      this.forcedCollision = false;
      throw new Error("Duplicate entry for seq");
    }
    if (this.entries.some((item) => item.seq === entry.seq))
      throw new Error("Duplicate entry for seq");
    this.entries.push(entry);
  }
  async list() {
    return [...this.entries];
  }
}
