import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToastClient } from './clients/toast.js';
import { registerOrdersTools } from './tools/orders.js';
import { registerMenusTools } from './tools/menus.js';
import { registerEmployeesTools } from './tools/employees.js';
import { registerLaborTools } from './tools/labor.js';
import { registerRestaurantTools } from './tools/restaurant.js';
import { registerPaymentsTools } from './tools/payments.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerCustomersTools } from './tools/customers.js';
import { registerReportingTools } from './tools/reporting.js';
import { registerCashTools } from './tools/cash.js';
import { registerDashboardTools } from './tools/dashboard.js';

/**
 * Toast MCP Server - Complete restaurant POS/management platform integration
 */

interface ToastServerConfig {
  apiKey?: string;
  clientId: string;
  clientSecret: string;
  restaurantGuid?: string;
  environment?: 'production' | 'sandbox';
  /** Reuse an existing ToastClient (shares the cached auth token across server instances). */
  client?: ToastClient;
}

/**
 * Tools that mutate the POS. These are untested against live Toast and are
 * disabled unless TOAST_ENABLE_WRITE_TOOLS=true is set explicitly.
 */
const WRITE_TOOLS = new Set([
  'toast_create_order',
  'toast_void_order',
  'toast_add_selections',
  'toast_void_selection',
  'toast_apply_discount',
  'toast_update_order_promised_time',
  'toast_update_item_price',
  'toast_set_item_86',
  'toast_bulk_86_items',
  'toast_create_employee',
  'toast_update_employee',
  'toast_disable_employee',
  'toast_add_payment',
  'toast_refund_payment',
  'toast_void_payment',
  'toast_update_stock_quantity',
  'toast_set_infinite_quantity',
  'toast_bulk_update_stock',
  'toast_create_cash_entry',
  'toast_void_cash_entry',
  'toast_create_cash_deposit',
]);

export class ToastMCPServer {
  private server: Server;
  private client: ToastClient;
  private tools: Map<string, any>;

  constructor(config: ToastServerConfig) {
    this.server = new Server(
      {
        name: 'toast-mcp by PrimeCost (Chris Cusack — chriscusack.net)',
        version: '1.4.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize (or reuse) Toast client
    this.client = config.client || new ToastClient({
      apiKey: config.apiKey || '',
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      restaurantGuid: config.restaurantGuid,
      environment: config.environment || 'production',
    });

    // Register all tools from all modules
    this.tools = new Map();
    this.registerAllTools();
    this.registerLocationTools();

    // Set up request handlers
    this.setupHandlers();

    // Error handling
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private registerAllTools() {
    const toolModules = [
      registerOrdersTools(this.client),
      registerMenusTools(this.client),
      registerEmployeesTools(this.client),
      registerLaborTools(this.client),
      registerRestaurantTools(this.client),
      registerPaymentsTools(this.client),
      registerInventoryTools(this.client),
      registerCustomersTools(this.client),
      registerReportingTools(this.client),
      registerCashTools(this.client),
      registerDashboardTools(this.client),
    ];

    const enableWrites = process.env.TOAST_ENABLE_WRITE_TOOLS === 'true';
    let skipped = 0;
    for (const tools of toolModules) {
      for (const tool of tools) {
        if (!enableWrites && WRITE_TOOLS.has(tool.name)) {
          skipped++;
          continue;
        }
        this.tools.set(tool.name, tool);
      }
    }

    console.error(`[Toast MCP] Registered ${this.tools.size} tools${skipped ? ` (${skipped} write tools disabled; set TOAST_ENABLE_WRITE_TOOLS=true to enable)` : ''}`);
  }

  /**
   * Optional named-location support. Set TOAST_LOCATIONS to a JSON object of
   * {"Location Name": "restaurant-guid", ...} and:
   *  - a toast_get_locations tool is registered so clients can discover locations
   *  - any tool's restaurantGuid argument accepts a location name (case-insensitive)
   */
  private locations: Record<string, string> = {};

  private registerLocationTools() {
    try {
      this.locations = JSON.parse(process.env.TOAST_LOCATIONS || '{}');
    } catch {
      console.error('[Toast MCP] Warning: TOAST_LOCATIONS is not valid JSON; ignoring');
      this.locations = {};
    }
    if (!Object.keys(this.locations).length) return;

    const defaultGuid = process.env.TOAST_RESTAURANT_GUID;
    const locations = this.locations;
    this.tools.set('toast_get_locations', {
      name: 'toast_get_locations',
      description:
        'List this restaurant group\'s locations (name and restaurantGuid). ' +
        'Every other tool\'s restaurantGuid argument accepts either a GUID or one of these location names. ' +
        'ALWAYS ask the user which location they mean (or query each) when they have more than one — ' +
        'calls without restaurantGuid go to the default location only.',
      inputSchema: z.object({}),
      handler: async () => ({
        locations: Object.entries(locations).map(([name, guid]) => ({
          name,
          restaurantGuid: guid,
          isDefault: guid === defaultGuid,
        })),
      }),
    });

    console.error(`[Toast MCP] Locations configured: ${Object.keys(locations).join(', ')}`);
  }

  /** Resolve a location name to its GUID; pass GUIDs (or unknown values) through. */
  private resolveLocation(value: string): string {
    const hit = Object.keys(this.locations).find(
      (name) => name.toLowerCase() === value.toLowerCase()
    );
    return hit ? this.locations[hit] : value;
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema.shape
            ? {
                type: 'object',
                properties: Object.entries(tool.inputSchema.shape).reduce(
                  (acc, [key, value]: [string, any]) => {
                    // Unwrap ZodOptional/ZodDefault/ZodNullable so the advertised
                    // type matches what validation actually expects. Without this,
                    // every optional number was advertised as a string and then
                    // rejected with "Expected number, received string".
                    let inner: any = value;
                    while (inner?._def?.innerType) inner = inner._def.innerType;
                    const t = inner?._def?.typeName;
                    acc[key] = {
                      type: t === 'ZodString' ? 'string' :
                            t === 'ZodNumber' ? 'number' :
                            t === 'ZodBoolean' ? 'boolean' :
                            t === 'ZodArray' ? 'array' :
                            t === 'ZodObject' ? 'object' :
                            t === 'ZodEnum' ? 'string' :
                            'string',
                      description: value.description || inner?.description || '',
                      ...(t === 'ZodEnum' && {
                        enum: inner._def.values,
                      }),
                      ...(value.isOptional() && {
                        optional: true,
                      }),
                    };
                    return acc;
                  },
                  {} as Record<string, any>
                ),
                required: Object.entries(tool.inputSchema.shape)
                  .filter(([_, value]: [string, any]) => !value.isOptional())
                  .map(([key]) => key),
              }
            : tool.inputSchema,
        })),
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools.get(request.params.name);
      
      if (!tool) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      try {
        // Accept location names in restaurantGuid arguments
        const rawArgs = { ...(request.params.arguments || {}) } as Record<string, any>;
        if (typeof rawArgs.restaurantGuid === 'string' && rawArgs.restaurantGuid) {
          rawArgs.restaurantGuid = this.resolveLocation(rawArgs.restaurantGuid);
        }

        // Write safety: three locks. Even with TOAST_ENABLE_WRITE_TOOLS=true
        // (lock 1, registration), every write call must carry confirm_write:true
        // (lock 2), and executes only when TOAST_DRY_RUN=false (lock 3 -
        // dry-run is the default and returns the validated payload untouched).
        const isWrite = WRITE_TOOLS.has(request.params.name);
        const confirmed = rawArgs.confirm_write === true;
        delete rawArgs.confirm_write;

        if (isWrite && !confirmed) {
          throw new Error(
            `${request.params.name} modifies the POS. Re-call it with confirm_write: true to proceed.`
          );
        }

        // Validate input. If a client sends numeric strings (older cached
        // schemas advertised numbers as strings), coerce the flagged paths
        // once and retry rather than failing.
        let validatedArgs: any;
        const first = tool.inputSchema.safeParse(rawArgs);
        if (first.success) {
          validatedArgs = first.data;
        } else {
          let coerced = false;
          for (const issue of first.error.issues) {
            if (issue.code === 'invalid_type' && issue.expected === 'number' && issue.received === 'string') {
              const k = issue.path[0] as string;
              const n = Number(rawArgs[k]);
              if (rawArgs[k] !== '' && !Number.isNaN(n)) {
                rawArgs[k] = n;
                coerced = true;
              }
            }
          }
          if (!coerced) throw first.error;
          validatedArgs = tool.inputSchema.parse(rawArgs);
        }

        if (isWrite && process.env.TOAST_DRY_RUN !== 'false') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    dryRun: true,
                    tool: request.params.name,
                    validatedPayload: validatedArgs,
                    note: 'No API call was made. Payload validated successfully. Set TOAST_DRY_RUN=false on the server to execute real writes.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Execute tool
        const result = await tool.handler(validatedArgs);

        return {
          content: [
            {
              type: 'text',
              // Large data tools (toast_dashboard_data) set compact: pretty-printing row arrays triples their size.
              text: tool.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid arguments: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
        }
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[Toast MCP] Server running on stdio');
  }

  /** Connect this server to an arbitrary MCP transport (e.g. streamable HTTP). */
  async connect(transport: any) {
    await this.server.connect(transport);
  }

  async close() {
    await this.server.close();
  }

  getClient(): ToastClient {
    return this.client;
  }
}

export default ToastMCPServer;
