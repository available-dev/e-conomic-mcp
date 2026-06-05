/**
 * Typed convenience tools for the most commonly used e-conomic resources.
 *
 * These are ergonomic wrappers over the generic client so common tasks ("list
 * customers", "create a draft invoice") are first-class tools. They are
 * hand-curated from the e-conomic REST API's well-known resource paths. The
 * generic tools remain available for everything else.
 */

import type { ClientRegistry } from "../clientRegistry.js";
import { withProfile, type ToolDefinition } from "./types.js";

/** A read-only collection resource we expose list/get tools for. */
interface ResourceDef {
  /** Singular noun used in tool names/descriptions, e.g. "customer". */
  singular: string;
  /** API collection path, e.g. "customers". */
  path: string;
  /** Human label for descriptions. */
  label: string;
  /** Whether the resource supports a numeric/string id GET at `{path}/{id}`. */
  byId: boolean;
}

const READ_RESOURCES: ResourceDef[] = [
  { singular: "customer", path: "customers", label: "customers", byId: true },
  { singular: "supplier", path: "suppliers", label: "suppliers", byId: true },
  { singular: "product", path: "products", label: "products", byId: true },
  { singular: "account", path: "accounts", label: "chart-of-accounts entries", byId: true },
  { singular: "draft_invoice", path: "invoices/drafts", label: "draft invoices", byId: true },
  { singular: "booked_invoice", path: "invoices/booked", label: "booked invoices", byId: true },
  { singular: "order", path: "orders", label: "orders", byId: true },
  { singular: "quote", path: "quotes", label: "quotes", byId: true },
  { singular: "journal", path: "journals", label: "journals", byId: true },
  { singular: "department", path: "departments", label: "departments", byId: true },
  { singular: "product_group", path: "product-groups", label: "product groups", byId: true },
  { singular: "customer_group", path: "customer-groups", label: "customer groups", byId: true },
  { singular: "supplier_group", path: "supplier-groups", label: "supplier groups", byId: true },
  { singular: "payment_term", path: "payment-terms", label: "payment terms", byId: true },
  { singular: "vat_zone", path: "vat-zones", label: "VAT zones", byId: true },
  { singular: "vat_account", path: "vat-accounts", label: "VAT accounts", byId: true },
  { singular: "currency", path: "currencies", label: "currencies", byId: true },
  { singular: "unit", path: "units", label: "units", byId: true },
  { singular: "employee", path: "employees", label: "employees", byId: true },
];

export function typedTools(clients: ClientRegistry): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const res of READ_RESOURCES) {
    tools.push({
      name: `economic_list_${plural(res.singular)}`,
      description:
        `List ${res.label} from e-conomic with optional filtering, sorting and pagination. ` +
        `Filter syntax example: "name$like:Acme"; sort example: "-${idHint(res)}".`,
      inputSchema: {
        type: "object",
        properties: withProfile({
          filter: { type: "string", description: "e-conomic filter expression." },
          sort: { type: "string", description: "Sort field; prefix '-' for descending." },
          pageSize: { type: "integer", minimum: 1, maximum: 1000 },
          maxItems: { type: "integer", minimum: 1 },
          fetchAll: { type: "boolean" },
        }),
        additionalProperties: false,
      },
      handler: async (args) => {
        const result = await clients.resolve(args.profile).collection(res.path, {
          filter: args.filter,
          sort: args.sort,
          pageSize: args.pageSize,
          maxItems: args.maxItems,
          fetchAll: Boolean(args.fetchAll),
        });
        return {
          count: result.items.length,
          pages: result.pages,
          truncated: result.truncated,
          items: result.items,
        };
      },
    });

    if (res.byId) {
      tools.push({
        name: `economic_get_${res.singular}`,
        description: `Get a single e-conomic ${res.singular.replace(/_/g, " ")} by its id/number.`,
        inputSchema: {
          type: "object",
          properties: withProfile({
            id: {
              type: ["string", "integer"],
              description: `The ${res.singular.replace(/_/g, " ")} id (e.g. customerNumber).`,
            },
          }),
          required: ["id"],
          additionalProperties: false,
        },
        handler: async (args) => {
          const res2 = await clients.resolve(args.profile).request({
            method: "GET",
            path: `${res.path}/${encodeURIComponent(String(args.id))}`,
          });
          return res2.data;
        },
      });
    }
  }

  // A few high-value write tools for the most common workflows.
  tools.push({
    name: "economic_create_customer",
    description:
      "Create a new customer in e-conomic. At minimum e-conomic requires name, currency, " +
      "customerGroup, paymentTerms and vatZone. Pass the full customer object as 'customer'. " +
      "Use economic_list_customer_groups / economic_list_payment_terms / economic_list_vat_zones " +
      "to find valid references first.",
    inputSchema: {
      type: "object",
      properties: withProfile({
        customer: {
          type: "object",
          additionalProperties: true,
          description:
            "Customer payload, e.g. { name, currency, customerGroup:{customerGroupNumber}, " +
            "paymentTerms:{paymentTermsNumber}, vatZone:{vatZoneNumber} }.",
        },
      }),
      required: ["customer"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const res = await clients
        .resolve(args.profile)
        .request({ method: "POST", path: "customers", body: args.customer });
      return res.data;
    },
  });

  tools.push({
    name: "economic_update_customer",
    description:
      "Update an existing customer. Provide the customerNumber as 'id' and the full updated " +
      "customer object as 'customer' (e-conomic PUT replaces the resource).",
    inputSchema: {
      type: "object",
      properties: withProfile({
        id: { type: ["string", "integer"], description: "customerNumber." },
        customer: { type: "object", additionalProperties: true },
      }),
      required: ["id", "customer"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const res = await clients.resolve(args.profile).request({
        method: "PUT",
        path: `customers/${encodeURIComponent(String(args.id))}`,
        body: args.customer,
      });
      return res.data;
    },
  });

  tools.push({
    name: "economic_create_draft_invoice",
    description:
      "Create a draft invoice in e-conomic. Pass the full draft invoice object as 'invoice' " +
      "(must include date, currency, paymentTerms, customer, recipient, layout, and lines). " +
      "Use economic_describe_endpoint('POST /invoices/drafts') if a spec is loaded, or fetch an " +
      "existing draft with economic_get_draft_invoice to see the expected shape.",
    inputSchema: {
      type: "object",
      properties: withProfile({
        invoice: {
          type: "object",
          additionalProperties: true,
          description: "Draft invoice payload.",
        },
      }),
      required: ["invoice"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const res = await clients.resolve(args.profile).request({
        method: "POST",
        path: "invoices/drafts",
        body: args.invoice,
      });
      return res.data;
    },
  });

  tools.push({
    name: "economic_book_draft_invoice",
    description:
      "Book (finalize) a draft invoice, turning it into a booked invoice. Provide the draft " +
      "invoice number as 'draftInvoiceNumber'. Optionally provide a specific invoice 'number'.",
    inputSchema: {
      type: "object",
      properties: withProfile({
        draftInvoiceNumber: { type: ["string", "integer"] },
        number: {
          type: "integer",
          description: "Optional explicit invoice number to assign when booking.",
        },
      }),
      required: ["draftInvoiceNumber"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        draftInvoice: { draftInvoiceNumber: Number(args.draftInvoiceNumber) },
      };
      if (args.number !== undefined) body.number = Number(args.number);
      const res = await clients
        .resolve(args.profile)
        .request({ method: "POST", path: "invoices/booked", body });
      return res.data;
    },
  });

  return tools;
}

function plural(singular: string): string {
  if (singular.endsWith("y")) return `${singular.slice(0, -1)}ies`;
  if (singular.endsWith("s")) return singular;
  return `${singular}s`;
}

function idHint(res: ResourceDef): string {
  if (res.singular === "customer") return "customerNumber";
  if (res.singular === "supplier") return "supplierNumber";
  if (res.singular === "product") return "productNumber";
  if (res.singular === "account") return "accountNumber";
  return "number";
}
