#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { CodeArena } from "./index.js";
const [command, subcommand, ...args] = process.argv.slice(2),
  dir = join(homedir(), ".config", "codearena"),
  file = join(dir, "config.json");
if (command === "login") {
  const key = process.env.CODEARENA_API_KEY;
  if (!key)
    throw new Error(
      "Set CODEARENA_API_KEY before login; credentials are not accepted on argv.",
    );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    JSON.stringify({
      apiKey: key,
      baseUrl: process.env.CODEARENA_API_URL || "http://localhost:4000",
      projectId: process.env.CODEARENA_PROJECT_ID,
    }),
    { mode: 0o600 },
  );
  console.log("Configuration saved.");
} else {
  let saved: any = {};
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* environment-only configuration is supported */
  }
  const apiKey = process.env.CODEARENA_API_KEY || saved.apiKey;
  if (!apiKey) throw new Error("Set CODEARENA_API_KEY or run codearena login");
  const arena = new CodeArena({
    apiKey,
    baseUrl: process.env.CODEARENA_API_URL || saved.baseUrl,
  });
  if (command === "runtimes" && subcommand === "list")
    console.log(JSON.stringify(await arena.runtimes.list(), null, 2));
  else if (command === "submissions" && subcommand === "get")
    console.log(JSON.stringify(await arena.submissions.get(args[0]), null, 2));
  else if (command === "run" || command === "submit") {
    const path = command === "run" ? subcommand : args[0],
      projectId = process.env.CODEARENA_PROJECT_ID || saved.projectId;
    if (!projectId) throw new Error("CODEARENA_PROJECT_ID is required");
    const map: Record<string, [string, string]> = {
      ".py": ["python", "3.13"],
      ".js": ["javascript", "22"],
      ".ts": ["typescript", "5.8"],
      ".c": ["c", "14"],
      ".cpp": ["cpp", "14"],
      ".java": ["java", "21"],
      ".go": ["go", "1.24"],
      ".rs": ["rust", "1.85"],
    };
    const runtime = map[extname(path)];
    if (!runtime) throw new Error("Unsupported file extension");
    let challengeId: string | undefined;
    if (command === "submit")
      challengeId = (await arena.request(`/v1/challenges/${subcommand}`)).id;
    const s = await arena.submissions.create({
      projectId,
      language: runtime[0],
      version: runtime[1],
      source: await readFile(path, "utf8"),
      stdin: process.env.CODEARENA_STDIN || "",
      mode: command === "submit" ? "challenge" : "run",
      challengeId,
    });
    console.log(JSON.stringify(await arena.submissions.wait(s.id), null, 2));
  } else
    throw new Error(
      "Usage: codearena login | run FILE | submit SLUG FILE | runtimes list | submissions get ID",
    );
}
