export { BillingPage } from "./BillingPage.js";

export const billingPages = [
  ["billing.overview", "Faktura", "/billing", "billing.invoice.read"],
  ["billing.issuers", "Aussteller", "/billing/issuers", "billing.issuer.read"],
  [
    "billing.invoices",
    "Rechnungen",
    "/billing/invoices",
    "billing.invoice.read",
  ],
  ["billing.dunning", "Mahnwesen", "/billing/dunning", "billing.dunning.read"],
] as const;
