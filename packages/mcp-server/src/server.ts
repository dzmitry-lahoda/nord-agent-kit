import { version } from "../package.json";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { id, orderSchema, pageSchema, requestIdSchema } from "./model";
import { publicError } from "./errors";
import { Runtime, localPage, serializable } from "./runtime";
import { outputFor, type outputs } from "./outputs";
import { NordReads } from "./nord/reads";

export function createServer(runtime: Runtime): McpServer {
  return createToolsServer(runtime.reads, runtime);
}

export function createPublicServer(reads: NordReads): McpServer {
  return createToolsServer(reads);
}

function createToolsServer(reads: NordReads, runtime?: Runtime): McpServer {
  const server = new McpServer(
    { name: "nord", version },
    {
      capabilities: { tools: {} },
      instructions: runtime
        ? undefined
        : `Public Nord market data on ${reads.network}. No account or trading tools are available. RFQ data is indicative; inspect source timestamps for freshness.`,
    },
  );
  function tool<S extends z.ZodObject>(
    name: keyof typeof outputs,
    description: string,
    input: S,
    run: (args: z.output<S>) => Promise<unknown>,
    writes = false,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: input as z.ZodObject,
        outputSchema: outputFor(name),
        annotations: {
          readOnlyHint: !writes,
          destructiveHint: writes,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        const execute = async () => {
          try {
            const data = serializable(await run(input.parse(args)));
            const failed =
              data &&
              typeof data === "object" &&
              "state" in data &&
              [
                "prepared",
                "unknown",
                "rejected",
                "not_submitted",
                "submitting",
              ].includes(String(data.state));
            const result = { ok: !failed, data };
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result) },
              ],
              structuredContent: result,
              isError: Boolean(failed),
            };
          } catch (error) {
            const result = {
              ok: false,
              error:
                error instanceof z.ZodError
                  ? {
                      code: "INVALID_ARGUMENTS",
                      message:
                        "Arguments or provider data do not match the required schema. Inspect the tool inputs and retry reads.",
                    }
                  : publicError(error),
            };
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${result.error.code}: ${result.error.message}`,
                },
              ],
              structuredContent: result,
              isError: true,
            };
          }
        };
        return runtime ? runtime.serialize(execute) : execute();
      },
    );
  }
  tool(
    "nord_list_markets",
    "Discover market IDs, symbols, precision and CLOB/RFQ modes. Paginated over a fresh market snapshot; no total count is inferred.",
    pageSchema
      .extend({
        search: z.string().max(100).optional(),
        mode: z.enum(["clob", "rfq"]).optional(),
      })
      .strict(),
    async ({ limit, cursor, search, mode }) => {
      const markets = (await reads.markets()).filter(
        (m) =>
          (!search || m.symbol.toLowerCase().includes(search.toLowerCase())) &&
          (!mode || m.mode === mode),
      );
      return localPage(markets, limit, cursor, "marketId");
    },
  );
  tool(
    "nord_get_market",
    "Inspect current pricing, precision and availability; CLOB book levels are capped at 50 per side. RFQ data is indicative and is not a firm quote or fill guarantee.",
    z.object({ marketId: id }).strict(),
    async ({ marketId }) => {
      const { market, live, observedAt } = await reads.market(marketId);
      let depth: unknown = null;
      if (market.mode === "clob") {
        const book = z
          .object({ asks: z.array(z.unknown()), bids: z.array(z.unknown()) })
          .passthrough()
          .parse(await reads.get(`/market/${marketId}/orderbook`));
        depth = {
          ...book,
          asks: book.asks.slice(0, 50),
          bids: book.bids.slice(0, 50),
          truncated: book.asks.length > 50 || book.bids.length > 50,
        };
      }
      return {
        market,
        live,
        depth,
        observedAt: new Date(observedAt).toISOString(),
        capabilities: {
          limit: market.mode === "clob",
          cancel: market.mode === "clob",
          market: ["clob", "rfq"].includes(String(market.mode)),
        },
      };
    },
  );
  // Public mode never registers account, signing, or recovery tools.
  if (!runtime) return server;
  tool(
    "nord_get_connection",
    "Inspect the fixed profile, network, owner, account and session readiness. Credentials and owner keys are never returned.",
    z.object({}).strict(),
    () => runtime.connection(),
  );
  tool(
    "nord_get_account",
    "Read selected-account balances and provider margin/risk metrics. Unknown equity is returned as null; margin metrics are not fabricated into an equity estimate.",
    z.object({}).strict(),
    async () => {
      const account = await runtime.account();
      return {
        accountId: runtime.profile.accountId,
        balances: account.balances,
        risk: account.margins,
        equity: null,
        updateId: account.updateId,
      };
    },
  );
  tool(
    "nord_list_positions",
    "Read current positions from the selected account, optionally filtered by market; live snapshot keyset pagination.",
    pageSchema.extend({ marketId: id.optional() }).strict(),
    async ({ limit, cursor, marketId }) =>
      localPage(
        (await runtime.account()).positions.filter(
          (p) => !marketId || p.marketId === marketId,
        ),
        limit,
        cursor,
        "marketId",
      ),
  );
  tool(
    "nord_list_open_orders",
    "Read authoritative CLOB open-order membership and remaining sizes. Empty results do not prove a timed-out submission was rejected. Live snapshot keyset pagination.",
    pageSchema.strict(),
    async ({ limit, cursor }) =>
      localPage((await runtime.account()).orders, limit, cursor, "orderId"),
  );
  tool(
    "nord_list_order_history",
    "Read one page of CLOB/RFQ account history. Return the backend cursor unchanged; history can lag execution.",
    pageSchema.strict(),
    ({ limit, cursor }) => runtime.history(limit, cursor),
  );
  tool(
    "nord_get_order",
    "Read an order belonging to this profile account and one page of fills. An RFQ placement acknowledgement is not a fill; inspect finalizationReason and fills.",
    pageSchema.extend({ orderId: id }).strict(),
    ({ orderId, limit, cursor }) => runtime.order(orderId, limit, cursor),
  );
  tool(
    "nord_preview_order",
    "Prepare an indicative order without signing. Specify exactly one decimal-string baseSize or quoteNotional. Quote amounts are position notional, not collateral or leverage. A preview is not reusable execution authorization.",
    orderSchema,
    (input) => runtime.prepare(input),
  );
  tool(
    "nord_place_order",
    "Submit a protected CLOB market/limit order or RFQ market-style request. Requires a stable requestId: retry with exactly the same ID and arguments after ambiguity. Market orders require explicit slippageBps; limit orders require limitPrice. RFQ quote sizing is a notional target, not a native quote cap. Host approval settings apply. Cancelling the MCP call does not cancel an order.",
    z.object({ requestId: requestIdSchema, order: orderSchema }).strict(),
    ({ requestId, order }) => runtime.place(requestId, order),
    true,
  );
  tool(
    "nord_cancel_order",
    "Cancel one CLOB order using a stable requestId. RFQ cancellation is unsupported. Cancellation can race fills; inspect the returned receipt and order state.",
    z.object({ requestId: requestIdSchema, orderId: id }).strict(),
    ({ requestId, orderId }) => runtime.cancel(requestId, orderId),
    true,
  );
  tool(
    "nord_get_request",
    "Inspect a stable local request and reconcile at most 50 action IDs. Unknown outcomes stay unknown when evidence is missing. Repeat this read to advance recovery; never create a replacement trade to bypass ambiguity.",
    z.object({ requestId: requestIdSchema }).strict(),
    ({ requestId }) => runtime.reconcile(requestId),
  );
  return server;
}
