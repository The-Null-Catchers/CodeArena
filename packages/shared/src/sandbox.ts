import { OutputBudget } from "./output.js";
import Docker from "dockerode";
import { Writable } from "node:stream";
import tar from "tar-stream";
import type { Limits, Verdict } from "./domain.js";
import type { RuntimeDefinition } from "./runtimes.js";
import { runtimeImage } from "./runtimes.js";
import {
  extractGeneratedArtifacts,
  type GeneratedArtifact,
  type GeneratedArtifactCapture,
} from "./generated-artifacts.js";
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
  compiledArtifact?: Buffer;
  generatedArtifacts?: GeneratedArtifact[];
  artifactCapture?: Pick<GeneratedArtifactCapture, "rejected" | "limited">;
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
    compiledArtifact?: Buffer,
    captureGeneratedArtifacts?: boolean,
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
    cachedCompiledArtifact?: Buffer,
    captureGenerated = false,
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
    let compiledArtifact: Buffer | undefined;
    let generatedArtifacts: GeneratedArtifact[] = [];
    let artifactCapture: Pick<GeneratedArtifactCapture, "rejected" | "limited"> = {
      rejected: 0,
      limited: false,
    };
    let phase = "image";
    const stop = (why: Verdict) => {
      if (reason) return;
      reason = why;
      console.error(
        JSON.stringify({
          service: "sandbox",
          phase,
          submission_id: labels["codearena.submission"],
          worker_id: labels["codearena.worker"],
          verdict: why,
          elapsed_ms: Date.now() - started,
        }),
      );
      void container?.kill().catch(() => {});
    };
    const abort = () => stop("internal_error");
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("CANCELLED");
      const img = await this.docker.getImage(runtimeImage(r)).inspect();
      imageId = img.Id;
      phase = "create";
      container = await this.docker.createContainer(
        containerOptions(imageId, limits, labels, process.env.SANDBOX_APPARMOR),
      );
      timer = setTimeout(
        () => stop("time_limit_exceeded"),
        Math.max(1, limits.wallTimeMs - (Date.now() - started)),
      );
      phase = "start";
      await container.start();
      if (signal.aborted || reason) throw new Error("INTERRUPTED");
      // Docker archive API rejects a read-only rootfs on some daemons even for tmpfs.
      // A fixed tar process writes only registry-owned filenames into the private tmpfs.
      phase = "upload-create";
      const upload = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        User: "65532:65532",
        WorkingDir: "/workspace",
        Cmd: ["tar", "--no-same-owner", "-xf", "-", "-C", "/workspace"],
      });
      phase = "upload-start";
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
      phase = "upload-stream";
      await uploaded;
      phase = "upload-inspect";
      if ((await upload.inspect()).ExitCode !== 0)
        throw new Error("SOURCE_UPLOAD_FAILED");
      if (cachedCompiledArtifact) {
        if (!r.compile || !r.cacheFiles?.length)
          throw new Error("INVALID_COMPILE_CACHE_RUNTIME");
        phase = "cache-restore-create";
        const restore = await container.exec({
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          User: "65532:65532",
          WorkingDir: "/workspace",
          Cmd: ["tar", "--no-same-owner", "-xf", "-", "-C", "/workspace"],
        });
        const restoreStream = await restore.start({ hijack: true, stdin: true });
        restoreStream.resume();
        const restored = new Promise<void>((resolve, reject) => {
          restoreStream.once("end", resolve);
          restoreStream.once("close", resolve);
          restoreStream.once("error", reject);
        });
        restoreStream.end(cachedCompiledArtifact);
        phase = "cache-restore-stream";
        await restored;
        if ((await restore.inspect()).ExitCode !== 0)
          throw new Error("COMPILE_CACHE_RESTORE_FAILED");
      }
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
        phase = compiling ? "compile-create" : "run-create";
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
        phase = compiling ? "compile-start" : "run-start";
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
        phase = compiling ? "compile-stream" : "run-stream";
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
      const captureArtifacts = async () => {
        phase = "artifact-export-create";
        const exportExec = await container!.exec({
          AttachStdout: true,
          AttachStderr: true,
          User: "65532:65532",
          WorkingDir: "/workspace",
          Cmd: ["tar", "-cf", "-", "artifacts"],
        });
        const exportStream = await exportExec.start({
          hijack: true,
          stdin: false,
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let overflow = false;
        const stdoutSink = new Writable({
          write: (buf: Buffer, _encoding, done) => {
            bytes += buf.length;
            if (bytes <= 12 * 1024 * 1024) chunks.push(Buffer.from(buf));
            else overflow = true;
            done();
          },
        });
        const stderrSink = new Writable({ write: (_buf, _encoding, done) => done() });
        phase = "artifact-export-stream";
        this.docker.modem.demuxStream(exportStream, stdoutSink, stderrSink);
        await new Promise<void>((resolve, reject) => {
          exportStream.on("end", resolve);
          exportStream.on("close", resolve);
          exportStream.on("error", reject);
        });
        const exit = (await exportExec.inspect()).ExitCode;
        if (exit !== 0) return;
        if (overflow) {
          artifactCapture = { rejected: 1, limited: true };
          return;
        }
        const captured = await extractGeneratedArtifacts(Buffer.concat(chunks));
        generatedArtifacts = captured.items;
        artifactCapture = {
          rejected: captured.rejected,
          limited: captured.limited,
        };
        if (captured.rejected || captured.limited)
          console.error(
            JSON.stringify({
              service: "sandbox",
              event: "artifact_capture_limited",
              submission_id: labels["codearena.submission"],
              worker_id: labels["codearena.worker"],
              captured: captured.items.length,
              rejected: captured.rejected,
              limited: captured.limited,
            }),
          );
      };
      if (r.compile) {
        await onPhase("compiling");
        if (cachedCompiledArtifact) {
          compileOutput = "[CodeArena] compilation cache hit\n";
          exitCode = 0;
        } else {
          exitCode = await stage(r.compile, true);
          if (exitCode !== 0) reason ??= "compilation_error";
          if (!reason && r.cacheFiles?.length === 1) {
            phase = "cache-export-create";
            const exportExec = await container.exec({
              AttachStdout: true,
              AttachStderr: true,
              User: "65532:65532",
              WorkingDir: "/workspace",
              Cmd: ["tar", "-cf", "-", r.cacheFiles[0]],
            });
            const exportStream = await exportExec.start({
              hijack: true,
              stdin: false,
            });
            const chunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            const stdoutSink = new Writable({
              write: (buf: Buffer, _encoding, done) => {
                chunks.push(Buffer.from(buf));
                done();
              },
            });
            const stderrSink = new Writable({
              write: (buf: Buffer, _encoding, done) => {
                stderrChunks.push(Buffer.from(buf));
                done();
              },
            });
            phase = "cache-export-stream";
            this.docker.modem.demuxStream(
              exportStream,
              stdoutSink,
              stderrSink,
            );
            await new Promise<void>((resolve, reject) => {
              exportStream.on("end", resolve);
              exportStream.on("close", resolve);
              exportStream.on("error", reject);
            });
            if ((await exportExec.inspect()).ExitCode !== 0)
              throw new Error(
                `COMPILE_CACHE_EXPORT_FAILED:${Buffer.concat(
                  stderrChunks,
                ).toString("utf8")}`,
              );
            compiledArtifact = Buffer.concat(chunks);
            if (
              !compiledArtifact.byteLength ||
              compiledArtifact.byteLength > 32 * 1024 * 1024
            )
              throw new Error("COMPILE_CACHE_ARTIFACT_INVALID_SIZE");
          }
        }
      }
      let ranProgram = false;
      if (!reason && !signal.aborted) {
        await onPhase("running");
        exitCode = await stage(r.execute, false);
        ranProgram = true;
        if (exitCode !== 0) reason ??= "runtime_error";
      }
      clearTimeout(timer);
      timer = undefined;
      if (captureGenerated && ranProgram && !signal.aborted)
        await captureArtifacts();
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
        compiledArtifact,
        generatedArtifacts,
        artifactCapture,
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "sandbox",
          phase,
          submission_id: labels["codearena.submission"],
          worker_id: labels["codearena.worker"],
          verdict: reason,
          elapsed_ms: Date.now() - started,
          error:
            error instanceof Error ? error.message : "UNKNOWN_SANDBOX_ERROR",
        }),
      );
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
        compiledArtifact,
        generatedArtifacts,
        artifactCapture,
      };
    } finally {
      clearTimeout(timer);
      clearInterval(sampler);
      signal.removeEventListener("abort", abort);
      if (container) {
        try {
          await container.remove({ force: true, v: true });
        } catch (error) {
          console.error(
            JSON.stringify({
              service: "sandbox",
              event: "cleanup_failed",
              submission_id: labels["codearena.submission"],
              worker_id: labels["codearena.worker"],
              container_id: container.id,
              error:
                error instanceof Error ? error.message : "UNKNOWN_CLEANUP_ERROR",
            }),
          );
        }
      }
    }
  }
  async reap(workerId: string, live: Set<string>) {
    let removed = 0;
    let failed = 0;
    for (const c of await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: ["codearena.managed=true", `codearena.worker=${workerId}`],
      }),
    })) {
      if (live.has(c.Labels["codearena.submission"])) continue;
      try {
        await this.docker.getContainer(c.Id).remove({ force: true, v: true });
        removed += 1;
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({
            service: "sandbox",
            event: "reap_failed",
            worker_id: workerId,
            submission_id: c.Labels["codearena.submission"],
            container_id: c.Id,
            error: error instanceof Error ? error.message : "UNKNOWN_REAP_ERROR",
          }),
        );
      }
    }
    return { removed, failed };
  }
}
