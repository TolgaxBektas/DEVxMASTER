import { permissionProcedure, router } from "@xmaster-center/kernel";
import { z } from "zod";
import type { BillingService } from "./service.js";
import { COMMISSION_RATES } from "./formulas.js";

const actor = (ctx: {
  auth: { user: { id: string; displayName: string } };
}) => ({
  actorId: ctx.auth.user.id,
  actorName: ctx.auth.user.displayName,
});

const issuerInput = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  email: z.string().email().optional(),
  invoicePrefix: z.string().min(1).max(10),
  bankName: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  logoUrl: z.string().url().optional(),
  letterhead: z.string().optional(),
  currency: z.enum(["EUR", "GBP"]).default("EUR"),
  vatTreatment: z.enum(["RC", "VAT19", "VAT0"]).default("RC"),
});

const invoiceInput = z.object({
  issuerId: z.number().int().positive(),
  customerId: z.number().int().positive().optional(),
  recipientName: z.string().min(1),
  recipientAddress: z.string().optional(),
  recipientEmail: z.string().email().optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.string().regex(/^\d+(\.\d{1,2})?$/),
        unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
        commissionRate: z.enum(COMMISSION_RATES).optional(),
        customerId: z.number().int().positive().optional(),
      }),
    )
    .min(1),
});

export function createBillingRouter(service: BillingService) {
  return router({
    issuers: router({
      list: permissionProcedure("billing.issuer.read").query(({ ctx }) =>
        service.listIssuers(ctx.auth.tenantId),
      ),
      create: permissionProcedure("billing.issuer.write")
        .input(issuerInput)
        .mutation(({ ctx, input }) =>
          service.createIssuer(ctx.auth.tenantId, input),
        ),
    }),
    invoices: router({
      list: permissionProcedure("billing.invoice.read").query(({ ctx }) =>
        service.listInvoices(ctx.auth.tenantId),
      ),
      get: permissionProcedure("billing.invoice.read")
        .input(z.object({ id: z.number().int().positive() }))
        .query(({ ctx, input }) =>
          service.getInvoice(ctx.auth.tenantId, input.id),
        ),
      create: permissionProcedure("billing.invoice.write")
        .input(invoiceInput)
        .mutation(({ ctx, input }) =>
          service.createInvoice(
            ctx.auth.tenantId,
            calculateInput(input),
            actor(ctx),
          ),
        ),
      issue: permissionProcedure("billing.invoice.issue")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(({ ctx, input }) =>
          service.issueInvoice(ctx.auth.tenantId, input.id, actor(ctx)),
        ),
      pay: permissionProcedure("billing.payment.write")
        .input(
          z.object({
            id: z.number().int().positive(),
            amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
            reference: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          service.recordPayment(
            ctx.auth.tenantId,
            input.id,
            {
              amount: input.amount,
              paidAt: new Date(),
              ...(input.reference ? { reference: input.reference } : {}),
              ...(input.note ? { note: input.note } : {}),
            },
            actor(ctx),
          ),
        ),
      pdf: permissionProcedure("billing.invoice.read")
        .input(z.object({ id: z.number().int().positive() }))
        .query(async ({ ctx, input }) => ({
          filename: `rechnung-${input.id}.pdf`,
          base64: Buffer.from(
            await service.invoicePdf(ctx.auth.tenantId, input.id),
          ).toString("base64"),
        })),
    }),
    dunning: router({
      list: permissionProcedure("billing.dunning.read").query(({ ctx }) =>
        service.listDunningEntries(ctx.auth.tenantId),
      ),
      run: permissionProcedure("billing.dunning.run").mutation(({ ctx }) =>
        service.runDunning(ctx.auth.tenantId, actor(ctx)),
      ),
    }),
    creditNotes: router({
      create: permissionProcedure("billing.creditnote.write")
        .input(
          z.object({
            issuerId: z.number().int().positive(),
            invoiceId: z.number().int().positive().optional(),
            amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
            currency: z.enum(["EUR", "GBP"]),
            reason: z.string().min(3),
          }),
        )
        .mutation(({ ctx, input }) =>
          service.createCreditNote(
            ctx.auth.tenantId,
            {
              issuerId: input.issuerId,
              amount: input.amount,
              currency: input.currency,
              reason: input.reason,
              ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
            },
            actor(ctx),
          ),
        ),
    }),
  });
}

function calculateInput(input: z.infer<typeof invoiceInput>) {
  const items = input.items.map((item) => ({
    ...item,
    amount: multiply(item.quantity, item.unitPrice),
  }));
  const subtotal = items.reduce((sum, item) => add(sum, item.amount), "0.00");
  const treatment = "RC" as const;
  return {
    ...input,
    items,
    currency: "EUR" as const,
    vatTreatment: treatment,
    subtotal,
    vatRate: "0.00",
    vatAmount: "0.00",
    total: subtotal,
    dueDate: new Date(Date.now() + 14 * 86_400_000),
  };
}

function multiply(left: string, right: string): string {
  const value = BigInt(left.replace(".", "")) * BigInt(right.replace(".", ""));
  return ((value + 50n) / 100n)
    .toString()
    .padStart(3, "0")
    .replace(/(\d{2})$/, ".$1");
}

function add(left: string, right: string): string {
  return (BigInt(left.replace(".", "")) + BigInt(right.replace(".", "")))
    .toString()
    .padStart(3, "0")
    .replace(/(\d{2})$/, ".$1");
}
