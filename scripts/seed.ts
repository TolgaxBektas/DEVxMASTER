import {
  hashSecret, createDbFactory, parseEnv, roles, roleAssignments, tenants,
  userIdentities, users,
} from "../packages/kernel/src/index.ts";
import { dunningLevels, issuers } from "../modules/billing/src/schema.ts";
import { and, eq } from "drizzle-orm";

const env = parseEnv();
const factory = createDbFactory(env);
const db = factory.get();
const now = new Date();
const existingTenant = (await db.select().from(tenants).limit(1))[0];
const tenantId = existingTenant?.id ?? Number((await db.insert(tenants).values({
  code: "demo", name: "Demo-Mandant", status: "active", createdAt: now, updatedAt: now,
}))[0]?.insertId);
const existingUser = (await db.select().from(users).limit(1))[0];
const userId = existingUser?.id ?? Number((await db.insert(users).values({
  email: "admin@example.invalid", displayName: "Administrator", status: "active",
  createdAt: now, updatedAt: now,
}))[0]?.insertId);
let role = (await db.select().from(roles).limit(1))[0];
const permissions = [
  "system.health.read", "system.audit.read", "system.jobs.read", "system.ai.read",
  "system.flags.read", "system.policies.read", "crm.customer.read", "crm.customer.write",
  "crm.address.read", "crm.address.write", "crm.industry.read", "crm.project.read",
  "billing.issuer.read", "billing.issuer.write", "billing.invoice.read",
  "billing.invoice.write", "billing.invoice.issue", "billing.payment.write",
  "billing.dunning.read", "billing.dunning.run", "billing.creditnote.write",
  "ingestion.source.read", "ingestion.document.read", "ingestion.document.write",
  "ingestion.document.upload", "ingestion.document.classify",
  "ingestion.occurrence.read", "ingestion.occurrence.review",
  "assistant.briefing.read", "assistant.chat", "assistant.proposal.read",
  "assistant.proposal.approve", "assistant.proposal.execute",
];
if (!role) {
  const roleId = Number((await db.insert(roles).values({
    code: "admin", title: "Administrator", permissions,
  }))[0]?.insertId);
  role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0];
}
if (role) {
  const current = Array.isArray(role.permissions) ? role.permissions : [];
  const merged = [...new Set([...current, ...permissions])];
  if (merged.length !== current.length) {
    await db.update(roles).set({ permissions: merged }).where(eq(roles.id, role.id));
  }
}
if (!(await db.select().from(issuers).limit(1))[0]) {
  await db.insert(issuers).values({
    tenantId,
    name: "Demo Aussteller",
    invoicePrefix: "DMB",
    currency: "EUR",
    vatTreatment: "VAT19",
    createdAt: now,
    updatedAt: now,
  });
}
if (!(await db.select().from(dunningLevels).limit(1))[0]) {
  await db.insert(dunningLevels).values({
    tenantId,
    level: 1,
    daysAfterDue: 0,
    feeAmount: "5.00",
    interestRate: "5.00",
    subject: "Zahlungserinnerung",
    bodyTemplate: "Bitte begleichen Sie Rechnung {invoiceNumber}.",
  });
}
if (role && !(await db.select().from(roleAssignments).where(and(
  eq(roleAssignments.userId, userId), eq(roleAssignments.tenantId, tenantId),
  eq(roleAssignments.roleId, role.id),
)).limit(1))[0]) {
  await db.insert(roleAssignments).values({ userId, tenantId, roleId: role.id, createdAt: now });
}
const identity = (await db.select().from(userIdentities).where(and(
  eq(userIdentities.provider, "local"), eq(userIdentities.externalId, "admin"),
)).limit(1))[0];
if (!identity) {
  await db.insert(userIdentities).values({
    userId, provider: "local", externalId: "admin",
    secretHash: hashSecret(env.ADMIN_PIN, env.JWT_SECRET), createdAt: now,
  });
}
await factory.close();
console.log(JSON.stringify({ seeded: true, tenantId, userId, login: "admin", pinFromEnv: "ADMIN_PIN" }));
