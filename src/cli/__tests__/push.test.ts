/**
 * Unit tests for src/cli/push.ts
 *
 * NOTE: `loadInitConfig` is an unexported module-private function.
 * Its behavior is exercised here through two complementary approaches:
 *
 *   1. Filesystem integration: create real tmp dirs with config files, spy on
 *      process.cwd() to point loadInitConfig at the right dir, and invoke
 *      runPush with empty opts so loadInitConfig populates engineUrl/apiKey.
 *
 *   2. Guard-clause coverage: assert that runPush exits with specific console
 *      error messages when required values are missing.
 *
 * Recommendation: extract `loadInitConfig` into a separate exported helper
 * (e.g. `src/config/load-init-config.ts`) so it can be tested in isolation
 * without touching the filesystem or monkey-patching process.cwd.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = "codeprism-push-test-"): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeInitConfig(dir: string, config: object): void {
  mkdirSync(join(dir, ".codeprism"), { recursive: true });
  writeFileSync(
    join(dir, ".codeprism", "config.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Global test scaffolding
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
    throw new Error(`process.exit(${_code})`);
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runPush — guard clauses (no network needed)
// ---------------------------------------------------------------------------

describe("runPush — guard clauses", () => {
  it("exits with an error when engineUrl is empty and no config file is found", async () => {
    // Arrange: fresh tmp dir — no .codeprism/config.json anywhere nearby
    const tmp = makeTmpDir();
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");

    // Act & Assert
    await expect(
      runPush({ engineUrl: "", apiKey: "sk-test", db: join(tmp, "no.db") }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorMessages.some((m) => m.includes("--engine-url is required"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits with an error when apiKey is empty and no config file is found", async () => {
    // Arrange
    const tmp = makeTmpDir();
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");

    // Act & Assert
    await expect(
      runPush({
        engineUrl: "https://example.codeprism.dev",
        apiKey: "",
        db: join(tmp, "no.db"),
      }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorMessages.some((m) => m.includes("--api-key is required"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits with an error when the DB file does not exist", async () => {
    // Arrange
    const tmp = makeTmpDir();
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");
    const missingDb = join(tmp, "no-such.db");

    // Act & Assert
    await expect(
      runPush({
        engineUrl: "https://example.codeprism.dev",
        apiKey: "sk-valid",
        db: missingDb,
      }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorMessages.some((m) => m.includes("Database not found"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// loadInitConfig — tested indirectly through runPush behaviour
// ---------------------------------------------------------------------------

describe("loadInitConfig (via runPush) — config file discovery", () => {
  it("reads engineUrl and apiKey from .codeprism/config.json in cwd", async () => {
    // Arrange: config exists in cwd — loadInitConfig should populate both values
    const tmp = makeTmpDir();
    writeInitConfig(tmp, {
      engineUrl: "https://from-config.codeprism.dev",
      apiKey: "sk-from-config",
    });
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");

    // runPush picks up the config (no --engine-url error) then fails at DB-not-found
    await expect(
      runPush({ engineUrl: "", apiKey: "", db: join(tmp, "no.db") }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));

    // Neither credential error should appear — config was found
    expect(errorMessages.some((m) => m.includes("--engine-url is required"))).toBe(false);
    expect(errorMessages.some((m) => m.includes("--api-key is required"))).toBe(false);
    // The DB-not-found error should appear — the walk succeeded but DB is missing
    expect(errorMessages.some((m) => m.includes("Database not found"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("walks up to find config in a parent directory when cwd has none", async () => {
    // Arrange: config is in parent, cwd is a child dir with no config
    const parent = makeTmpDir();
    const child = join(parent, "my-project");
    mkdirSync(child, { recursive: true });
    writeInitConfig(parent, {
      engineUrl: "https://parent.codeprism.dev",
      apiKey: "sk-parent",
    });
    vi.spyOn(process, "cwd").mockReturnValue(child);
    const { runPush } = await import("../push.js");

    // The walk should find parent's config and not error on missing credentials
    await expect(
      runPush({ engineUrl: "", apiKey: "", db: join(child, "no.db") }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));

    expect(errorMessages.some((m) => m.includes("--engine-url is required"))).toBe(false);
    expect(errorMessages.some((m) => m.includes("Database not found"))).toBe(true);

    rmSync(parent, { recursive: true, force: true });
  });

  it("returns empty config when no .codeprism/config.json exists in the directory tree", async () => {
    // Arrange: fresh tmp dir with no config — walk terminates at filesystem root
    const tmp = makeTmpDir();
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");

    // With no config found, runPush falls through to the missing-engineUrl guard
    await expect(
      runPush({ engineUrl: "", apiKey: "", db: join(tmp, "no.db") }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorMessages.some((m) => m.includes("--engine-url is required"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("handles malformed JSON gracefully — falls through to missing-credentials guard", async () => {
    // Arrange: .codeprism/config.json has invalid JSON
    const tmp = makeTmpDir();
    mkdirSync(join(tmp, ".codeprism"), { recursive: true });
    writeFileSync(
      join(tmp, ".codeprism", "config.json"),
      "{ not: valid json }",
      "utf-8",
    );
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { runPush } = await import("../push.js");

    // loadInitConfig catches the SyntaxError and returns {} — no uncaught exception
    await expect(
      runPush({ engineUrl: "", apiKey: "", db: join(tmp, "no.db") }),
    ).rejects.toThrow("process.exit(1)");

    const errorSpy = console.error as ReturnType<typeof vi.fn>;
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // Graceful: falls back to missing engineUrl, not an uncaught JSON parse error
    expect(errorMessages.some((m) => m.includes("--engine-url is required"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// PushOptions type contract
// ---------------------------------------------------------------------------

describe("PushOptions interface", () => {
  it("requires engineUrl and apiKey fields", () => {
    // TypeScript compile-time check surfaced at test time.
    // If PushOptions changes its required shape the compiler catches it here.
    const opts = {
      engineUrl: "https://example.codeprism.dev",
      apiKey: "sk-test",
    } satisfies import("../push.js").PushOptions;

    expect(opts.engineUrl).toBe("https://example.codeprism.dev");
    expect(opts.apiKey).toBe("sk-test");
  });

  it("accepts optional db and delete fields", () => {
    const opts = {
      engineUrl: "https://example.codeprism.dev",
      apiKey: "sk-test",
      db: "/tmp/codeprism.db",
      delete: true,
    } satisfies import("../push.js").PushOptions;

    expect(opts.db).toBe("/tmp/codeprism.db");
    expect(opts.delete).toBe(true);
  });
});
