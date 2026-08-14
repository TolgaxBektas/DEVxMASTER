import { and, desc, eq } from "drizzle-orm";
import { addresses, customers, industries, projects } from "./schema.js";

export type CrmRepository = {
  listCustomers(tenantId: string): Promise<unknown[]>;
  getCustomer(tenantId: string, id: number): Promise<unknown | null>;
  createCustomer(
    tenantId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  updateCustomer(
    tenantId: string,
    id: number,
    input: Record<string, unknown>,
  ): Promise<void>;
  deleteCustomer(tenantId: string, id: number): Promise<void>;
  listAddresses(tenantId: string): Promise<unknown[]>;
  createAddress(
    tenantId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  listIndustries(): Promise<unknown[]>;
  listProjects(tenantId: string): Promise<unknown[]>;
};

export function createDrizzleCrmRepository(db: any): CrmRepository {
  return {
    async listCustomers(tenantId) {
      return db
        .select()
        .from(customers)
        .where(eq(customers.tenantId, Number(tenantId)))
        .orderBy(desc(customers.createdAt));
    },
    async getCustomer(tenantId, id) {
      return (
        (
          await db
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.id, id),
                eq(customers.tenantId, Number(tenantId)),
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    },
    async createCustomer(tenantId, input) {
      const result = await db.insert(customers).values({
        ...input,
        tenantId: Number(tenantId),
      });
      return this.getCustomer(tenantId, Number(result[0]?.insertId));
    },
    async updateCustomer(tenantId, id, input) {
      await db
        .update(customers)
        .set(input)
        .where(
          and(eq(customers.id, id), eq(customers.tenantId, Number(tenantId))),
        );
    },
    async deleteCustomer(tenantId, id) {
      await db
        .delete(customers)
        .where(
          and(eq(customers.id, id), eq(customers.tenantId, Number(tenantId))),
        );
    },
    async listAddresses(tenantId) {
      return db
        .select()
        .from(addresses)
        .where(eq(addresses.tenantId, Number(tenantId)))
        .orderBy(desc(addresses.createdAt));
    },
    async createAddress(tenantId, input) {
      const result = await db.insert(addresses).values({
        ...input,
        tenantId: Number(tenantId),
      });
      return (
        (
          await db
            .select()
            .from(addresses)
            .where(eq(addresses.id, Number(result[0]?.insertId)))
            .limit(1)
        )[0] ?? null
      );
    },
    async listIndustries() {
      return db.select().from(industries).orderBy(industries.name);
    },
    async listProjects(tenantId) {
      return db
        .select()
        .from(projects)
        .where(eq(projects.tenantId, Number(tenantId)))
        .orderBy(desc(projects.createdAt));
    },
  };
}
