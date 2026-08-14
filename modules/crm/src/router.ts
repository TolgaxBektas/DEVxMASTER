import { z } from "zod";
import {
  appendAudit,
  permissionProcedure,
  router,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { CrmRepository } from "./repository.js";

const customerInput = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  industryId: z.number().int().positive().optional(),
});
const addressInput = z.object({
  company: z.string().optional(),
  contactPerson: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  website: z.string().url().optional(),
  industryId: z.number().int().positive().optional(),
});

export function createCrmRouter(deps: {
  repository: CrmRepository;
  repositoryFor(db: unknown): CrmRepository;
  audit: AuditRepository;
  auditFor(db: unknown): AuditRepository;
  transaction<T>(callback: (db: unknown) => Promise<T>): Promise<T>;
  eventExecutorFor(db: unknown): EventExecutor;
  publish(
    input: {
      name: string;
      tenantId: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
    executor?: EventExecutor,
  ): Promise<unknown>;
}) {
  return router({
    customers: router({
      list: permissionProcedure("crm.customer.read").query(({ ctx }) =>
        deps.repository.listCustomers(ctx.auth.tenantId),
      ),
      get: permissionProcedure("crm.customer.read")
        .input(z.object({ id: z.number().int().positive() }))
        .query(({ ctx, input }) =>
          deps.repository.getCustomer(ctx.auth.tenantId, input.id),
        ),
      create: permissionProcedure("crm.customer.write")
        .input(customerInput)
        .mutation(async ({ ctx, input }) => {
          return deps.transaction(async (db) => {
            const repository = deps.repositoryFor(db);
            const audit = deps.auditFor(db);
            const customer = await repository.createCustomer(
              ctx.auth.tenantId,
              input,
            );
            const id = String((customer as { id?: number } | null)?.id ?? "");
            const entry = await appendAudit(audit, {
              tenantId: ctx.auth.tenantId,
              action: "created",
              entityType: "customer",
              entityId: id,
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
              detailsJson: JSON.stringify(input),
            });
            await deps.publish(
              {
                name: "customer.created",
                tenantId: ctx.auth.tenantId,
                aggregateType: "customer",
                aggregateId: id,
                payload: { customerId: id },
                idempotencyKey: `customer.created:${entry.hash}`,
              },
              deps.eventExecutorFor(db),
            );
            return customer;
          });
        }),
      update: permissionProcedure("crm.customer.write")
        .input(
          z.object({
            id: z.number().int().positive(),
            data: customerInput.partial(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          return deps.transaction(async (db) => {
            const repository = deps.repositoryFor(db);
            const audit = deps.auditFor(db);
            await repository.updateCustomer(
              ctx.auth.tenantId,
              input.id,
              input.data,
            );
            const entry = await appendAudit(audit, {
              tenantId: ctx.auth.tenantId,
              action: "updated",
              entityType: "customer",
              entityId: input.id,
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
              detailsJson: JSON.stringify(input.data),
            });
            await deps.publish(
              {
                name: "customer.updated",
                tenantId: ctx.auth.tenantId,
                aggregateType: "customer",
                aggregateId: String(input.id),
                payload: input.data,
                idempotencyKey: `customer.updated:${entry.hash}`,
              },
              deps.eventExecutorFor(db),
            );
            return { success: true };
          });
        }),
      delete: permissionProcedure("crm.customer.write")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          return deps.transaction(async (db) => {
            const repository = deps.repositoryFor(db);
            const audit = deps.auditFor(db);
            await repository.deleteCustomer(ctx.auth.tenantId, input.id);
            const entry = await appendAudit(audit, {
              tenantId: ctx.auth.tenantId,
              action: "deleted",
              entityType: "customer",
              entityId: input.id,
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
            });
            await deps.publish(
              {
                name: "customer.deleted",
                tenantId: ctx.auth.tenantId,
                aggregateType: "customer",
                aggregateId: String(input.id),
                payload: { customerId: input.id },
                idempotencyKey: `customer.deleted:${entry.hash}`,
              },
              deps.eventExecutorFor(db),
            );
            return { success: true };
          });
        }),
    }),
    addresses: router({
      list: permissionProcedure("crm.address.read").query(({ ctx }) =>
        deps.repository.listAddresses(ctx.auth.tenantId),
      ),
      create: permissionProcedure("crm.address.write")
        .input(addressInput)
        .mutation(async ({ ctx, input }) => {
          return deps.transaction(async (db) => {
            const repository = deps.repositoryFor(db);
            const audit = deps.auditFor(db);
            const address = await repository.createAddress(
              ctx.auth.tenantId,
              input,
            );
            const entry = await appendAudit(audit, {
              tenantId: ctx.auth.tenantId,
              action: "created",
              entityType: "address",
              entityId: String((address as { id?: number } | null)?.id ?? ""),
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
              detailsJson: JSON.stringify(input),
            });
            await deps.publish(
              {
                name: "address.created",
                tenantId: ctx.auth.tenantId,
                aggregateType: "address",
                aggregateId: String(
                  (address as { id?: number } | null)?.id ?? "",
                ),
                payload: { addressId: (address as { id?: number } | null)?.id },
                idempotencyKey: `address.created:${entry.hash}`,
              },
              deps.eventExecutorFor(db),
            );
            return address;
          });
        }),
    }),
    industries: router({
      list: permissionProcedure("crm.industry.read").query(() =>
        deps.repository.listIndustries(),
      ),
    }),
    projects: router({
      list: permissionProcedure("crm.project.read").query(({ ctx }) =>
        deps.repository.listProjects(ctx.auth.tenantId),
      ),
    }),
  });
}
