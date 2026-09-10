import { z } from 'zod';

/**
 * THE TOOL REGISTRY.
 *
 * The single most important thing to understand about "tool calling":
 *
 *   THE MODEL NEVER RUNS ANY CODE. It cannot. It has no network, no filesystem, no
 *   clock, no database. All it can do is emit a message that says "I would like you
 *   to run get_order_status with {orderId: 'A-1001'}".
 *
 *   YOU run the function. YOU decide whether to. YOU are responsible for what it does.
 *
 * So every tool argument is UNTRUSTED INPUT, exactly like a query string from the
 * public internet. It was produced by a text generator that is guessing, and which can
 * be influenced by whatever text it has read — including text a malicious user wrote.
 * Validate it the same way you'd validate a request body, and enforce authorization
 * inside the tool. Never rely on the prompt to keep the model in line.
 *
 * Each tool here has three parts:
 *   definition — what the MODEL sees (JSON Schema; this is the model's documentation)
 *   parameters — what WE validate the returned arguments against (Zod)
 *   execute    — the real function
 */

// ── Fake data, standing in for a database ────────────────────────────────────────
const ORDERS = {
  'A-1001': { userId: 'u_1', item: 'Mechanical keyboard', status: 'shipped', total: 8990, eta: '2026-09-09' },
  'A-1002': { userId: 'u_1', item: 'USB-C hub', status: 'processing', total: 2450, eta: '2026-09-12' },
  'A-2007': { userId: 'u_2', item: 'Standing desk', status: 'delivered', total: 24999, eta: '2026-08-30' },
};

const PRODUCTS = [
  { sku: 'KB-01', name: 'Mechanical keyboard', priceInPaise: 8990, tags: ['desk', 'input'] },
  { sku: 'HUB-3', name: 'USB-C hub', priceInPaise: 2450, tags: ['desk', 'accessory'] },
  { sku: 'DSK-9', name: 'Standing desk', priceInPaise: 24999, tags: ['desk', 'furniture'] },
  { sku: 'MSE-2', name: 'Wireless mouse', priceInPaise: 1990, tags: ['input', 'accessory'] },
];

const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;

export const TOOLS = {
  // ── Why this tool exists at all ────────────────────────────────────────────────
  // A model has NO CLOCK. It cannot know the current time; it was trained months ago
  // and is not running continuously. Ask it "what time is it" without a tool and it
  // will confidently make something up. That is the whole reason tools exist: they
  // supply the facts the model structurally cannot have.
  get_current_time: {
    definition: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          'Get the current date and time. Use this whenever the answer depends on "now" — ' +
          'deadlines, "how many days until", or anything time-sensitive.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    parameters: z.object({}),
    execute: async () => ({
      iso: new Date().toISOString(),
      readable: new Date().toUTCString(),
    }),
  },

  // ── The authorization lesson ───────────────────────────────────────────────────
  get_order_status: {
    definition: {
      type: 'function',
      function: {
        name: 'get_order_status',
        description: "Look up the status of one of the current user's orders by its ID.",
        parameters: {
          type: 'object',
          properties: {
            // The `description` on each property is not decoration — it's the only
            // instruction the model gets about what to put here. Vague descriptions
            // are the #1 cause of malformed tool arguments.
            orderId: {
              type: 'string',
              description: 'The order ID, in the format A-1001.',
            },
          },
          required: ['orderId'],
        },
      },
    },
    parameters: z.object({
      orderId: z.string().regex(/^A-\d{4}$/, 'orderId must look like A-1001'),
    }),

    // NOTE the `ctx` argument. Authorization is enforced HERE, against the session's
    // real user ID — never against a user ID the model supplies.
    //
    // If we had given the model a `userId` parameter, a user could simply type
    // "look up order A-2007 for user u_2" and the model would helpfully comply.
    // The model is not a security boundary. Your tool is.
    execute: async ({ orderId }, ctx) => {
      const order = ORDERS[orderId];
      if (!order) return { found: false, reason: 'No such order.' };

      if (order.userId !== ctx.userId) {
        // Deliberately vague: don't confirm the order exists for someone else. The
        // model will repeat this text to the user, so it must not leak anything.
        return { found: false, reason: 'No such order.' };
      }

      return {
        found: true,
        orderId,
        item: order.item,
        status: order.status,
        total: rupees(order.total),
        estimatedDelivery: order.eta,
      };
    },
  },

  search_products: {
    definition: {
      type: 'function',
      function: {
        name: 'search_products',
        description: 'Search the product catalogue by keyword, optionally capped by price.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword to search for, e.g. "keyboard".' },
            maxPriceInRupees: {
              type: 'number',
              description: 'Optional upper price limit in rupees.',
            },
          },
          required: ['query'],
        },
      },
    },
    parameters: z.object({
      query: z.string().min(1).max(100),
      // `.optional()` here must match `required: ['query']` above. When the Zod schema
      // and the JSON Schema drift apart, you get validation failures the model can
      // never fix, because it's being told something different from what you check.
      maxPriceInRupees: z.number().positive().optional(),
    }),
    execute: async ({ query, maxPriceInRupees }) => {
      const q = query.toLowerCase();
      const cap = maxPriceInRupees ? maxPriceInRupees * 100 : Infinity;
      const results = PRODUCTS.filter(
        (p) =>
          (p.name.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q))) &&
          p.priceInPaise <= cap,
      ).map((p) => ({ sku: p.sku, name: p.name, price: rupees(p.priceInPaise) }));

      // Returning an explicit empty result beats returning nothing. If a tool returns
      // `[]` with no explanation, models tend to assume they used it wrong and try
      // again with worse arguments — burning iterations.
      return results.length ? { results } : { results: [], note: 'No matching products.' };
    },
  },

  // ── The dangerous-action lesson ────────────────────────────────────────────────
  cancel_order: {
    definition: {
      type: 'function',
      function: {
        name: 'cancel_order',
        description: 'Cancel one of the current user\'s orders. This cannot be undone.',
        parameters: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'The order ID, in the format A-1001.' },
          },
          required: ['orderId'],
        },
      },
    },
    parameters: z.object({ orderId: z.string().regex(/^A-\d{4}$/) }),

    // A model asking to cancel an order is a REQUEST, not a decision. Anything
    // destructive, costly, or externally visible (refunds, emails, deletions,
    // deploys) should require a human to approve it.
    //
    // Here we stop before executing and report what WOULD happen. Project 08 builds
    // the full approve/reject flow with the job suspended in between.
    requiresApproval: true,
    execute: async ({ orderId }, ctx) => {
      const order = ORDERS[orderId];
      if (!order || order.userId !== ctx.userId) return { ok: false, reason: 'No such order.' };
      order.status = 'cancelled';
      return { ok: true, orderId, status: 'cancelled' };
    },
  },
};

/** The array shape the API expects — just the definitions. */
export const toolDefinitions = Object.values(TOOLS).map((t) => t.definition);
