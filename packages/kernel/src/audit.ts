import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { auditChainHeads, auditLog } from "./db/schema.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditEntry = {
  seq: number;
  tenantId: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  detailsJson?: string | null;
  actorId?: string | number | null;
  actorName?: string | null;
  prevHash: string;
  hash: string;
  createdAt: Date;
};

export type AuditRepository = {
  latest(): Promise<Pick<AuditEntry, "seq" | "hash"> | null>;
  insert(entry: AuditEntry): Promise<void>;
  list(tenantId?: string): Promise<AuditEntry[]>;
  appendAtomic?(
    params: Omit<AuditEntry, "seq" | "prevHash" | "hash" | "createdAt">,
    createdAt: Date,
  ): Promise<AuditEntry>;
};

export function isRetryableAuditWriteError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    candidate.code === "ER_DUP_ENTRY"
    || candidate.code === 1062
    || candidate.errno === 1062
    || candidate.code === "ER_LOCK_DEADLOCK"
    || candidate.errno === 1213
    || candidate.code === "ER_LOCK_WAIT_TIMEOUT"
    || candidate.errno === 1205
  ) return true;
  if (
    candidate.cause
    && candidate.cause !== error
    && isRetryableAuditWriteError(candidate.cause)
  ) return true;
  return /duplicate|unique|ER_DUP_ENTRY/i.test(
    String(candidate.message ?? error),
  );
}

export function normalizeAuditEntityId(
  entityId: string | number | null | undefined,
): string {
  return entityId == null ? "" : String(entityId);
}

export function computeAuditHash(entry: Omit<AuditEntry, "hash">): string {
  const payload = [
    entry.seq,
    entry.tenantId ?? "",
    entry.action,
    entry.entityType,
    normalizeAuditEntityId(entry.entityId),
    entry.detailsJson ?? "",
    entry.actorId ?? "",
    entry.createdAt.toISOString(),
    entry.prevHash,
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export async function appendAudit(
  repository: AuditRepository,
  params: Omit<AuditEntry, "seq" | "prevHash" | "hash" | "createdAt"> & {
    createdAt?: Date;
  },
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => Date;
  } = {},
): Promise<AuditEntry> {
  const maxAttempts = options.maxAttempts ?? 8;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const detailsJson = params.detailsJson ?? null;
  const createdAt = params.createdAt ?? options.now?.() ?? new Date();
  if (repository.appendAtomic) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await repository.appendAtomic({ ...params, detailsJson }, createdAt);
      } catch (error) {
        if (!isRetryableAuditWriteError(error) || attempt === maxAttempts - 1)
          throw error;
        await sleep(25 + Math.floor(random() * 150) * (attempt + 1));
      }
    }
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latest = await repository.latest();
    const prevHash = latest?.hash ?? GENESIS_HASH;
    const seq = (latest?.seq ?? 0) + 1;
    const entry: AuditEntry = {
      ...params,
      detailsJson,
      createdAt,
      seq,
      prevHash,
      hash: computeAuditHash({
        ...params,
        detailsJson,
        createdAt,
        seq,
        prevHash,
      }),
    };
    try {
      await repository.insert(entry);
      return entry;
    } catch (error) {
      if (
        !isRetryableAuditWriteError(error) ||
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

export async function verifyAuditChain(repository: AuditRepository, tenantId?: string) {
  const entries = (await repository.list(tenantId)).sort((a, b) => a.seq - b.seq);
  let previous = GENESIS_HASH;
  for (const entry of entries) {
    const expected = computeAuditHash(entry);
    if (entry.hash !== expected || (!tenantId && entry.prevHash !== previous)) {
      return {
        ok: false,
        totalEntries: entries.length,
        brokenAtSeq: entry.seq,
        scoped: Boolean(tenantId),
        complete: !tenantId,
      };
    }
    if (!tenantId) previous = entry.hash;
  }
  return {
    ok: true,
    totalEntries: entries.length,
    brokenAtSeq: null,
    scoped: Boolean(tenantId),
    complete: !tenantId,
  };
}

export class MemoryAuditRepository implements AuditRepository {
  readonly entries: AuditEntry[] = [];
  private forcedCollision = false;

  forceNextCollision(): void {
    this.forcedCollision = true;
  }
  async latest(): Promise<Pick<AuditEntry, "seq" | "hash"> | null> {
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
  async list(tenantId?: string) {
    const entries = tenantId
      ? this.entries.filter((entry) => entry.tenantId === tenantId)
      : this.entries;
    return [...entries];
  }
}

export function createDrizzleAuditRepository(db: any): AuditRepository {
  const appendWithHead = async (
    database: any,
    params: Omit<AuditEntry, "seq" | "prevHash" | "hash" | "createdAt">,
    createdAt: Date,
  ): Promise<AuditEntry> => {
    const head = (
      await database
        .select({
          seq: auditChainHeads.seq,
          hash: auditChainHeads.hash,
        })
        .from(auditChainHeads)
        .where(eq(auditChainHeads.id, 1))
        .for("update")
        .limit(1)
    )[0];
    if (!head) throw new Error("Audit-Kettenkopf fehlt");
    const seq = Number(head.seq) + 1;
    const prevHash = String(head.hash);
    const entry: AuditEntry = {
      ...params,
      detailsJson: params.detailsJson ?? null,
      createdAt,
      seq,
      prevHash,
      hash: computeAuditHash({
        ...params,
        detailsJson: params.detailsJson ?? null,
        createdAt,
        seq,
        prevHash,
      }),
    };
    await database.insert(auditLog).values({
      seq: entry.seq,
      tenantId: entry.tenantId ? Number(entry.tenantId) : null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      detailsJson: entry.detailsJson ?? null,
      actorId: entry.actorId == null ? null : Number(entry.actorId),
      actorName: entry.actorName ?? null,
      prevHash: entry.prevHash,
      hash: entry.hash,
      createdAt: entry.createdAt,
    });
    await database
      .update(auditChainHeads)
      .set({ seq: entry.seq, hash: entry.hash })
      .where(eq(auditChainHeads.id, 1));
    return entry;
  };
  return {
    async latest() {
      return (
        (
          await db
            .select({
              seq: auditLog.seq,
              hash: auditLog.hash,
            })
            .from(auditLog)
            .orderBy(desc(auditLog.seq))
            .limit(1)
        )[0] ?? null
      );
    },
    async insert(entry) {
      await db.insert(auditLog).values({
        seq: entry.seq,
        tenantId: entry.tenantId ? Number(entry.tenantId) : null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId == null ? null : String(entry.entityId),
        detailsJson: entry.detailsJson ?? null,
        actorId: entry.actorId == null ? null : Number(entry.actorId),
        actorName: entry.actorName ?? null,
        prevHash: entry.prevHash,
        hash: entry.hash,
        createdAt: entry.createdAt,
      });
    },
    async appendAtomic(params, createdAt) {
      if (typeof db.transaction === "function") {
        return db.transaction((transaction: any) =>
          appendWithHead(transaction, params, createdAt),
        );
      }
      return appendWithHead(db, params, createdAt);
    },
    async list(tenantId) {
      const rows = await db
        .select()
        .from(auditLog)
        .where(tenantId ? eq(auditLog.tenantId, Number(tenantId)) : undefined)
        .orderBy(auditLog.seq);
      return rows.map((row: any) => ({
        seq: Number(row.seq),
        tenantId: row.tenantId == null ? null : String(row.tenantId),
        action: String(row.action),
        entityType: String(row.entityType),
        entityId: row.entityId,
        detailsJson: row.detailsJson,
        actorId: row.actorId,
        actorName: row.actorName,
        prevHash: String(row.prevHash),
        hash: String(row.hash),
        createdAt: new Date(row.createdAt),
      }));
    },
  };
}
