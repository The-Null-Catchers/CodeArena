import { beforeAll, describe, it, expect } from "vitest";
import { DockerBackend } from "../../packages/shared/src/sandbox.js";
import { getRuntime } from "../../packages/shared/src/runtimes.js";
import { limitSchema } from "../../packages/shared/src/domain.js";
const backend = new DockerBackend(),
  r = getRuntime("python", "3.13");
beforeAll(() => backend.check());
async function run(source: string, overrides: Record<string, number> = {}) {
  return backend.run(
    r,
    source,
    "",
    limitSchema.parse(overrides),
    new AbortController().signal,
    () => {},
    async () => {},
    {
      "codearena.worker": "security-test",
      "codearena.submission": crypto.randomUUID(),
    },
  );
}
describe("real Docker security boundaries (no mocks)", () => {
  it("runs non-root with no Docker socket or host files", async () => {
    const s = await run(
      "import os\nprint(os.getuid())\nprint(os.path.exists('/var/run/docker.sock'))\nprint(os.path.exists('/etc/codearena-host-sentinel'))\n",
    );
    expect(s.stdout).toBe("65532\nFalse\nFalse\n");
  });
  it("never inherits platform secrets", async () => {
    process.env.CODEARENA_TEST_SECRET = "DO_NOT_LEAK";
    const s = await run(
      "import os\nprint(os.environ.get('CODEARENA_TEST_SECRET', 'absent'))\nprint(os.environ.get('DATABASE_URL', 'absent'))\nprint(os.environ.get('REDIS_URL', 'absent'))",
    );
    expect(s.stdout).toBe("absent\nabsent\nabsent\n");
  });
  it("cannot reach platform ports or metadata", async () => {
    const s = await run(
      "import socket\nfor host,port in [('127.0.0.1',5432),('127.0.0.1',6379),('169.254.169.254',80),('1.1.1.1',443)]:\n s=socket.socket();s.settimeout(.2)\n try:s.connect((host,port));print('reachable')\n except OSError:print('blocked')\n finally:s.close()",
    );
    expect(s.stdout).toBe("blocked\nblocked\nblocked\nblocked\n");
  });
  it("terminates infinite loops", async () => {
    const s = await run("while True: pass", {
      wallTimeMs: 700,
      cpuTimeMs: 500,
    });
    expect(s.verdict).toBe("time_limit_exceeded");
    expect(s.wallMs).toBeLessThan(12000);
  });
  it("caps combined stdout and stderr", async () => {
    const s = await run("while True: print('X'*4096,flush=True)", {
      maxOutputKb: 4,
    });
    expect(s.outputTruncated).toBe(true);
    expect(
      Buffer.byteLength(s.stdout) + Buffer.byteLength(s.stderr),
    ).toBeLessThanOrEqual(4096);
  });
  it("constrains memory allocation", async () => {
    const s = await run("x=[]\nwhile True:x.append(bytearray(8*1024*1024))", {
      memoryMb: 32,
    });
    expect(["memory_limit_exceeded", "runtime_error"]).toContain(s.verdict);
    expect(s.verdict).not.toBe("accepted");
  });
  it("constrains process creation", async () => {
    const s = await run(
      "import os,time\ntry:\n for _ in range(100):\n  if os.fork()==0:time.sleep(10);os._exit(0)\nexcept OSError:print('process-limit',flush=True)\ntime.sleep(.1)",
      { maxProcesses: 8, wallTimeMs: 2000 },
    );
    expect(s.stdout).toContain("process-limit");
  });
  it("cancels and removes the sandbox", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    try {
      await backend.run(
        r,
        "while True:pass",
        "",
        limitSchema.parse({}),
        controller.signal,
        () => {},
        async () => {},
        {
          "codearena.worker": "security-cancel",
          "codearena.submission": "cancel-test",
        },
      );
      const remaining = await backend.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: ["codearena.worker=security-cancel"],
        }),
      });
      expect(remaining).toHaveLength(0);
    } finally {
      clearTimeout(timer);
    }
  });
});
