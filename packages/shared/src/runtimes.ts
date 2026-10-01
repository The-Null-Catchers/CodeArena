import type { Limits } from "./domain.js";
export interface RuntimeDefinition {
  id: string;
  language: string;
  version: string;
  displayName: string;
  sourceFile: string;
  image: string;
  compile?: string[];
  cacheFiles?: string[];
  execute: string[];
  environment: string[];
  limits: Limits;
}
const limits: Limits = {
  cpuTimeMs: 2000,
  wallTimeMs: 5000,
  memoryMb: 256,
  maxProcesses: 32,
  maxOutputKb: 128,
  maxFileSizeKb: 10240,
};
function runtime(
  language: string,
  version: string,
  displayName: string,
  sourceFile: string,
  execute: string[],
  compile?: string[],
  cacheFiles?: string[],
): RuntimeDefinition {
  return {
    id: `${language}:${version}`,
    language,
    version,
    displayName,
    sourceFile,
    image: `codearena-runtime-${language}:${version}`,
    execute,
    compile,
    cacheFiles,
    limits,
    environment: [
      "PATH=/opt/java/openjdk/bin:/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
      "HOME=/workspace",
      "TMPDIR=/workspace",
      "LANG=C.UTF-8",
      "RUSTUP_HOME=/usr/local/rustup",
      "CARGO_HOME=/usr/local/cargo",
      "GOCACHE=/workspace/.cache",
      "GOPATH=/workspace/go",
      "GOTOOLCHAIN=local",
      "GOPROXY=off",
      "GOMAXPROCS=1",
      "CGO_ENABLED=0",
    ],
  };
}
export const runtimes = [
  runtime("python", "3.13", "Python", "main.py", [
    "python3",
    "-I",
    "-B",
    "main.py",
  ]),
  runtime("javascript", "22", "JavaScript", "main.js", ["node", "main.js"]),
  runtime(
    "typescript",
    "5.8",
    "TypeScript",
    "main.ts",
    ["node", "main.js"],
    [
      "tsc",
      "main.ts",
      "--target",
      "ES2022",
      "--module",
      "commonjs",
      "--skipLibCheck",
    ],
    ["main.js"],
  ),
  runtime(
    "c",
    "14",
    "C",
    "main.c",
    ["./main"],
    ["gcc", "main.c", "-O2", "-o", "main"],
    ["main"],
  ),
  runtime(
    "cpp",
    "14",
    "C++",
    "main.cpp",
    ["./main"],
    ["g++", "main.cpp", "-O2", "-std=c++20", "-o", "main"],
    ["main"],
  ),
  runtime(
    "java",
    "21",
    "Java",
    "Main.java",
    [
      "java",
      "-XX:ActiveProcessorCount=1",
      "-Xmx64m",
      "-XX:MaxMetaspaceSize=64m",
      "Main",
    ],
    ["javac", "Main.java"],
  ),
  runtime(
    "go",
    "1.24",
    "Go",
    "main.go",
    ["./main"],
    ["/usr/local/bin/codearena-go-compile"],
    ["main"],
  ),
  runtime(
    "rust",
    "1.85",
    "Rust",
    "main.rs",
    ["./main"],
    ["rustc", "main.rs", "-O", "-o", "main"],
    ["main"],
  ),
];
export function getRuntime(language: string, version: string) {
  const r = runtimes.find(
    (x) => x.language === language && x.version === version,
  );
  if (!r)
    throw Object.assign(new Error("Runtime not supported"), {
      statusCode: 400,
    });
  return r;
}
export function runtimeImage(r: RuntimeDefinition) {
  // Captured Docker content IDs always take precedence over mutable tags and
  // deployment overrides. Never silently substitute a different runtime image.
  if (/^sha256:[0-9a-f]{64}$/.test(r.image)) return r.image;
  const name = `RUNTIME_IMAGE_${r.language.toUpperCase()}`;
  return process.env[name] || r.image;
}

export function snapshotRuntime(
  r: RuntimeDefinition,
  imageId: string,
): RuntimeDefinition {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
    throw new Error("IMMUTABLE_RUNTIME_IMAGE_REQUIRED");
  return structuredClone({ ...r, image: imageId });
}
