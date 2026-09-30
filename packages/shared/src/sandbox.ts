import { OutputBudget } from "./output.js";
import Docker from "dockerode";
import { Writable } from "node:stream";
import tar from "tar-stream";
import type { Limits, Verdict } from "./domain.js";
import type { RuntimeDefinition } from "./runtimes.js";
import { runtimeImage } from "./runtimes.js";
export interface SandboxResult {
  stdout: string;
  stderr: string;
  compileOutput: string;
  exitCode: number | null;
  wallMs: number;
  cpuMs: number;
  peakMemoryBytes: number;
  outputTruncated: boolean;
  verdict: Verdict;
  imageId: string;
}
export interface ExecutionBackend {
  run(
    runtime: RuntimeDefinition,
    source: string,
    stdin: string,
    limits: Limits,
    signal: AbortSignal,
    onChunk: (kind: string, text: string) => void,
    onPhase: (phase: "compiling" | "running") => Promise<void>,
    labels: Record<string, string>,
  ): Promise<SandboxResult>;
}
export function containerOptions(
  image: string,
  limits: Limits,
  labels: Record<string, string>,
  apparmor?: string,
): Docker.ContainerCreateOptions {
  return {
    Image: image,
    User: "65532:65532",
    WorkingDir: "/workspace",
    Cmd: ["sleep", "infinity"],
    Env: [
      "PATH=/opt/java/openjdk/bin:/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
      "HOME=/workspace",
      "TMPDIR=/workspace",
      "LANG=C.UTF-8",
      "GOCACHE=/workspace/.cache",
      "GOPATH=/workspace/go",
      "GOTOOLCHAIN=local",
      "GOPROXY=off",
    ],
    NetworkDisabled: true,
    Labels: { "codearena.managed": "true", ...labels },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: [
        "no-new-privileges",
        ...(apparmor ? [`apparmor=${apparmor}`] : []),
      ],
      PidsLimit: limits.maxProcesses,
      Memory: limits.memoryMb * 1024 * 1024,
      MemorySwap: limits.memoryMb * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      ShmSize: 1024 * 1024,
      Tmpfs: {
        "/workspace": `rw,exec,nosuid,nodev,size=${limits.maxFileSizeKb}k,uid=65532,gid=65532,mode=0700`,
        "/tmp": "rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0700",
      },
      Ulimits: [
        { Name: "nofile", Soft: 64, Hard: 64 },
        {
          Name: "fsize",
          Soft: limits.maxFileSizeKb * 1024,
          Hard: limits.maxFileSizeKb * 1024,
        },
        { Name: "core", Soft: 0, Hard: 0 },
        {
          Name: "cpu",
          Soft: Math.ceil(limits.cpuTimeMs / 1000),
          Hard: Math.ceil(limits.cpuTimeMs / 1000),
        },
      ],
      LogConfig: { Type: "none", Config: {} },
    },
  };
}
function archive(files: Record<string, string>) {
  const pack = tar.pack();
  for (const [name, value] of Object.entries(files))
    pack.entry({ name, uid: 65532, gid: 65532, mode: 0o600 }, value);
  pack.finalize();
  return pack;
}
// Only registry-owned argv reaches this quoting function. Source and stdin are tar bytes.
function quote(s: string) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
export class DockerBackend implements ExecutionBackend {
  constructor(
    readonly docker = new Docker({
      socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
      timeout: 10000,
    }),
  ) {}
  async check() {
    const info = await this.docker.info();
    if (
      !(info.SecurityOptions || []).some((s: string) => s.includes("seccomp"))
    )
      throw new Error("SECCOMP_REQUIRED");
    if (!info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota)
      throw new Error("CGROUP_LIMITS_REQUIRED");
    return info;
  }
  async run(
    r: RuntimeDefinition,
    source: string,
    stdin: string,
    limits: Limits,
    signal: AbortSignal,
    onChunk: (kind: string, text: string) => void,
    onPhase: (phase: "compiling" | "running") => Promise<void>,
    labels: Record<string, string>,
  ): Promise<SandboxResult> {
    const started = Date.now();
    let container: Docker.Container | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sampler: ReturnType<typeof setInterval> | undefined;
    let sampling = false;
    let cpuMs = 0,
      peakMemoryBytes = 0;
    const output = new OutputBudget(limits.maxOutputKb * 1024);
    let reason: Verdict | undefined;
    let stdout = "",
      stderr = "",
      compileOutput = "";
    let exitCode: number | null = null;
    let imageId = "";
    const stop = (why: Verdict) => {
      reason ??= why;
      void container?.kill().catch(() => {});
    };
    const abort = () => stop("internal_error");
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("CANCELLED");
      const img = await this.docker.getImage(runtimeImage(r)).inspect();
      imageId = img.Id;
      container = await this.docker.createContainer(
        containerOptions(imageId, limits, labels, process.env.SANDBOX_APPARMOR),
      );
      timer = setTimeout(
        () => stop("time_limit_exceeded"),
        Math.max(1, limits.wallTimeMs - (Date.now() - started)),
      );
      await container.start();
      if (signal.aborted || reason) throw new Error("INTERRUPTED");
      // Docker archive API rejects a read-only rootfs on some daemons even for tmpfs.
      // A fixed tar process writes only registry-owned filenames into the private tmpfs.
      const upload = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        User: "65532:65532",
        WorkingDir: "/workspace",
        Cmd: ["tar", "--no-same-owner", "-xf", "-", "-C", "/workspace"],
      });
      const uploadStream = await upload.start({ hijack: true, stdin: true });
      uploadStream.resume();
      const uploaded = new Promise<void>((resolve, reject) => {
        uploadStream.once("end", resolve);
        uploadStream.once("close", resolve);
        uploadStream.once("error", reject);
      });
      const pack = archive({ [r.sourceFile]: source, "stdin.txt": stdin });
      pack.once("error", (error) => uploadStream.destroy(error));
      pack.pipe(uploadStream);
      await uploaded;
      if ((await upload.inspect()).ExitCode !== 0)
        throw new Error("SOURCE_UPLOAD_FAILED");
      sampler = setInterval(() => {
        if (sampling) return;
        sampling = true;
        void container!
          .stats({ stream: false })
          .then((s: any) => {
            cpuMs = Math.max(
              cpuMs,
              Math.ceil((s.cpu_stats?.cpu_usage?.total_usage || 0) / 1e6),
            );
            peakMemoryBytes = Math.max(
              peakMemoryBytes,
              s.memory_stats?.usage || 0,
            );
            if (cpuMs > limits.cpuTimeMs) stop("time_limit_exceeded");
          })
          .catch(() => {})
          .finally(() => {
            sampling = false;
          });
      }, 50);
      const stage = async (argv: string[], compiling: boolean) => {
        const exec = await container!.exec({
          AttachStdout: true,
          AttachStderr: true,
          User: "65532:65532",
          WorkingDir: "/workspace",
          Env: r.environment,
          Cmd: [
            "/bin/sh",
            "-c",
            `exec ${argv.map(quote).join(" ")} < /workspace/stdin.txt`,
          ],
        });
        const stream = await exec.start({ hijack: true, stdin: false });
        const collect = (kind: string, value: string) => {
          if (value) {
            if (compiling) compileOutput += value;
            else if (kind === "stdout") stdout += value;
            else stderr += value;
            onChunk(compiling ? "compile" : kind, value);
          }
          if (output.truncated) stop("output_limit_exceeded");
        };
        const prefix = compiling ? "compile:" : "run:";
        const sink = (kind: string) =>
          new Writable({
            write: (buf: Buffer, _encoding, done) => {
              collect(kind, output.push(prefix + kind, buf));
              done();
            },
          });
        this.docker.modem.demuxStream(stream, sink("stdout"), sink("stderr"));
        await new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("close", resolve);
          stream.on("error", reject);
        });
        for (const kind of ["stdout", "stderr"])
          collect(kind, output.finish(prefix + kind));
        return (await exec.inspect()).ExitCode;
      };
      if (r.compile) {
        await onPhase("compiling");
        exitCode = await stage(r.compile, true);
        if (exitCode !== 0) reason ??= "compilation_error";
      }
      if (!reason && !signal.aborted) {
        await onPhase("running");
        exitCode = await stage(r.execute, false);
        if (exitCode !== 0) reason ??= "runtime_error";
      }
      const inspect = await container.inspect();
      if (inspect.State.OOMKilled) reason = "memory_limit_exceeded";
      return {
        stdout,
        stderr,
        compileOutput,
        exitCode,
        wallMs: Date.now() - started,
        cpuMs,
        peakMemoryBytes,
        outputTruncated: output.truncated,
        verdict: reason || "accepted",
        imageId,
      };
    } catch (error) {
      if (!reason && !signal.aborted) throw error;
      return {
        stdout,
        stderr,
        compileOutput,
        exitCode,
        wallMs: Date.now() - started,
        cpuMs,
        peakMemoryBytes,
        outputTruncated: output.truncated,
        verdict: reason || "internal_error",
        imageId,
      };
    } finally {
      clearTimeout(timer);
      clearInterval(sampler);
      signal.removeEventListener("abort", abort);
      if (container)
        await container.remove({ force: true, v: true }).catch(() => {});
    }
  }
  async reap(workerId: string, live: Set<string>) {
    for (const c of await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: ["codearena.managed=true", `codearena.worker=${workerId}`],
      }),
    })) {
      if (!live.has(c.Labels["codearena.submission"]))
        await this.docker.getContainer(c.Id).remove({ force: true, v: true });
    }
  }
}
