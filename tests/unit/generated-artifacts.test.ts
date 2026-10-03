import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import {
  extractGeneratedArtifacts,
  inspectGeneratedArtifactMime,
  GENERATED_ARTIFACT_MAX_FILES,
} from "../../packages/shared/src/generated-artifacts.js";

async function makeArchive(
  entries: Array<{
    name: string;
    body?: Buffer | string;
    type?: "file" | "symlink" | "directory";
    linkname?: string;
  }>,
) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => {
    pack.once("end", resolve);
    pack.once("error", reject);
  });
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body || "", "utf8");
    pack.entry(
      {
        name: entry.name,
        type: entry.type || "file",
        linkname: entry.linkname,
      },
      body,
    );
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("generated artifact policy", () => {
  it("sniffs content instead of trusting filename extensions", () => {
    expect(
      inspectGeneratedArtifactMime(
        "fake.txt",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(inspectGeneratedArtifactMime("report.json", Buffer.from('{"ok":true}'))).toBe(
      "application/json",
    );
    expect(inspectGeneratedArtifactMime("report.json", Buffer.from("not json"))).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("captures only direct regular files under artifacts and rejects symlinks", async () => {
    const capture = await extractGeneratedArtifacts(
      await makeArchive([
        { name: "artifacts/", type: "directory" },
        { name: "artifacts/report.json", body: '{"score":7}' },
        { name: "artifacts/nested/secret.txt", body: "no" },
        {
          name: "artifacts/leak.txt",
          type: "symlink",
          linkname: "/etc/passwd",
        },
      ]),
    );
    expect(capture.items.map((item) => item.filename)).toEqual(["report.json"]);
    expect(capture.items[0].mimeType).toBe("application/json");
    expect(capture.rejected).toBe(1);
  });

  it("enforces the generated artifact file-count limit", async () => {
    const capture = await extractGeneratedArtifacts(
      await makeArchive(
        Array.from({ length: GENERATED_ARTIFACT_MAX_FILES + 3 }, (_, index) => ({
          name: `artifacts/file-${index}.txt`,
          body: String(index),
        })),
      ),
    );
    expect(capture.items).toHaveLength(GENERATED_ARTIFACT_MAX_FILES);
    expect(capture.rejected).toBe(3);
    expect(capture.limited).toBe(true);
  });
});
