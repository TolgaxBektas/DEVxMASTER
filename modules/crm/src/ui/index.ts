export { CrmPage } from "./CrmPage.js";

export const crmPages = [
  ["crm.customers", "Kunden", "/kunden", "crm.customer.read"],
  ["crm.addresses", "Adressen", "/adressen", "crm.address.read"],
  ["crm.industries", "Branchen", "/branchen", "crm.industry.read"],
  ["crm.projects", "Projekte", "/projekte", "crm.project.read"],
] as const;
