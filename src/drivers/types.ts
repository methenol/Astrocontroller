/**
 * What a telescope driver is to the rest of the application. A driver owns everything that speaks
 * its telescope's protocol (the link, the device model, its MCP tools and its adapter for the one shared web UI); the
 * framework (src/index.ts) only picks one by TELESCOPE_DRIVER, starts it and stops it.
 *
 *   dwarf     DWARFLAB Dwarf 3: protobuf over WebSocket, HTTP, FTP, RTSP (src/drivers/dwarf/)
 *   seestar   ZWO Seestar: JSON-RPC over TCP, binary image stream, on the local network or
 *             through ZWO Telescope Network (src/drivers/seestar/)
 */
import type http from 'node:http';
import type { Express } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentBridge } from '../agent/omp.js';
import type { ObserverLocation } from '../config.js';

export const DRIVER_IDS = ['dwarf', 'seestar'] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

/** The device side every driver offers, whatever its protocol. */
export interface TelescopeDevice {
  readonly driver: DriverId;
  /** Open the link and keep it open (reconnecting) until stop(). */
  start(): void;
  stop(): void;
  /** Disconnect button: free the telescope for another client until connectLink(). */
  release(): void;
  /** Connect button. */
  connectLink(): void;
  /** What the telescope (or the controller) is busy with, if anything. */
  isBusy(): string | null;
  location(): ObserverLocation | null;
  requireLocation(): ObserverLocation;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/** The MCP server a driver exposes to the agent: tools reach it as mcp__<name>__<tool>. */
export interface McpSpec {
  name: string;
  instructions: string;
  /** Register every tool on a fresh server (called once per MCP request). */
  register(server: McpServer): void;
}

/** A driver, built and running: index.ts starts it once the web server listens and stops it on shutdown. */
export interface DriverRuntime {
  readonly device: TelescopeDevice;
  readonly mcp: McpSpec;
  /** Mount the driver's web UI and API on the app (before the JSON error handler). */
  mountWeb(app: Express, server: http.Server): { close(): void };
  /** Start the link and the driver's background work. */
  start(): void;
  /** Shutdown steps in order; one failing never keeps the others from running. */
  shutdownSteps(): Array<[string, () => void]>;
  /** One line for the start-up log: where the telescope is. */
  describeTarget(): string;
}

export interface DriverDeps {
  agent: AgentBridge;
}

export interface TelescopeDriver {
  readonly id: DriverId;
  /** Human name for logs and the UI. */
  readonly label: string;
  create(deps: DriverDeps): DriverRuntime;
}
