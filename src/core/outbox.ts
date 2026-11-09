import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Outbox pattern: outgoing writes are queued on disk first, delivered with retry. */

export interface OutboxEntry {
  id: string;
  at: string;
  kind: string;
  payload: unknown;
  attempts: number;
  status: "pending" | "sent" | "failed";
  lastError?: string;
}

export type OutboxSender = (kind: string, payload: unknown) => Promise<void>;

export interface FlushReport {
  sent: number;
  failed: number;
  pending: number;
}

export class Outbox {
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly maxAttempts = 3,
  ) {}

  async enqueue(kind: string, payload: unknown): Promise<OutboxEntry> {
    const entries = await this.load();
    this.seq += 1;
    const entry: OutboxEntry = {
      id: `${Date.now().toString(36)}-${this.seq}`,
      at: new Date().toISOString(),
      kind,
      payload,
      attempts: 0,
      status: "pending",
    };
    entries.push(entry);
    await this.save(entries);
    return entry;
  }

  async list(): Promise<OutboxEntry[]> {
    return this.load();
  }

  async flush(send: OutboxSender): Promise<FlushReport> {
    const entries = await this.load();
    const report: FlushReport = { sent: 0, failed: 0, pending: 0 };
    for (const entry of entries) {
      if (entry.status !== "pending") continue;
      entry.attempts += 1;
      try {
        await send(entry.kind, entry.payload);
        entry.status = "sent";
        entry.lastError = undefined;
        report.sent += 1;
      } catch (err) {
        entry.lastError = err instanceof Error ? err.message : String(err);
        if (entry.attempts >= this.maxAttempts) {
          entry.status = "failed";
          report.failed += 1;
        } else {
          report.pending += 1;
        }
      }
      await this.save(entries);
    }
    return report;
  }

  private async load(): Promise<OutboxEntry[]> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      return lines.map((l) => JSON.parse(l) as OutboxEntry);
    } catch {
      return [];
    }
  }

  private async save(entries: OutboxEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, entries.map((e) => JSON.stringify(e)).join("\n"), "utf8");
  }
}
