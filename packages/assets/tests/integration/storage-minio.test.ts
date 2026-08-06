import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { MinioContainer } from "@testcontainers/minio";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";
import {
  createBuildContext,
  defineCollection,
  defineConfig,
  syncEmittedAssetsStorage,
  schema as s,
} from "@anhur/core";
import { assets } from "../../src/schema";

const MINIO_IMAGE = "minio/minio:RELEASE.2025-07-23T15-54-02Z";
const BUCKET = "anhur-assets";

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();

const scratchRoot = path.join(import.meta.dirname, "../.temp");
const scratchRoots: string[] = [];

describe.skipIf(!dockerAvailable)(
  "assets storage sync against MinIO (Testcontainers)",
  () => {
    let container: Awaited<ReturnType<MinioContainer["start"]>>;
    let endpoint: string;
    let files: Files;
    let caseIndex = 0;

    beforeAll(async () => {
      container = await new MinioContainer(MINIO_IMAGE)
        .withUsername("anhur")
        .withPassword("anhursecret")
        .start();

      endpoint = `http://${container.getHost()}:${container.getPort()}`;

      const s3 = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: container.getUsername(),
          secretAccessKey: container.getPassword(),
        },
      });
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      s3.destroy();

      files = new Files({
        adapter: minio({
          bucket: BUCKET,
          endpoint,
          accessKeyId: container.getUsername(),
          secretAccessKey: container.getPassword(),
          publicBaseUrl: `${endpoint}/${BUCKET}`,
        }),
      });
    }, 120_000);

    afterAll(async () => {
      for (const root of scratchRoots.splice(0)) {
        await rm(root, { recursive: true, force: true });
      }
      await container?.stop();
    });

    function nextPrefix(): string {
      caseIndex += 1;
      return `anhur-case-${caseIndex}`;
    }

    async function setupContext(
      prefix: string,
      opts?: { dryRun?: boolean; prune?: boolean },
    ) {
      await mkdir(scratchRoot, { recursive: true });
      const root = await mkdtemp(path.join(scratchRoot, "minio-"));
      scratchRoots.push(root);

      const config = defineConfig({
        processors: [
          assets({
            dir: ".anhur/assets",
            base: `http://cdn.test/anhur/`,
            storage: {
              enabled: true,
              files: () => files,
              prefix,
              prune: opts?.prune ?? true,
              dryRun: opts?.dryRun ?? false,
            },
          }),
        ],
        content: [
          defineCollection({
            name: "posts",
            directory: "content",
            include: "**/*.md",
            schema: s.object({ title: s.string() }),
          }),
        ],
      });

      const ctx = await createBuildContext(config, {
        rootDir: root,
        configDir: root,
      });
      return { root, ctx };
    }

    async function listPrefix(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      for await (const item of files.listAll({ prefix: `${prefix}/` })) {
        keys.push(item.key);
      }
      return keys.sort();
    }

    it("uploads hashed assets and skips on rebuild", async () => {
      const prefix = nextPrefix();
      const { root, ctx } = await setupContext(prefix);
      const source = path.join(root, "hero.png");
      await writeFile(source, "hero-bytes-v1");
      const emitted = await ctx.emitAsset(source);
      const key = `${prefix}/${path.basename(emitted.outputPath)}`;

      const first = await syncEmittedAssetsStorage(ctx);
      expect(first?.uploaded).toContain(key);
      expect(await files.exists(key)).toBe(true);
      expect(emitted.src).toBe(
        `http://cdn.test/anhur/${path.basename(emitted.outputPath)}`,
      );

      const second = await syncEmittedAssetsStorage(ctx);
      expect(second?.uploaded).toEqual([]);
      expect(second?.skipped).toContain(key);
    });

    it("deletes remote orphans under prefix when prune is true", async () => {
      const prefix = nextPrefix();
      const orphanKey = `${prefix}/orphan-${Date.now()}.bin`;
      await files.upload(orphanKey, "orphan-bytes");

      const { root, ctx } = await setupContext(prefix, { prune: true });
      const source = path.join(root, "keep.png");
      await writeFile(source, `keep-${Date.now()}`);
      const emitted = await ctx.emitAsset(source);
      const keepKey = `${prefix}/${path.basename(emitted.outputPath)}`;

      const result = await syncEmittedAssetsStorage(ctx);
      expect(result?.uploaded).toContain(keepKey);
      expect(result?.deleted).toContain(orphanKey);
      expect(await files.exists(orphanKey)).toBe(false);
      expect(await files.exists(keepKey)).toBe(true);

      const keys = await listPrefix(prefix);
      expect(keys).toContain(keepKey);
      expect(keys).not.toContain(orphanKey);
    });

    it("dryRun does not write or delete", async () => {
      const prefix = nextPrefix();
      const staleKey = `${prefix}/stale-dryrun-${Date.now()}.bin`;
      await files.upload(staleKey, "stale");

      const { root, ctx } = await setupContext(prefix, {
        dryRun: true,
        prune: true,
      });
      const source = path.join(root, "planned.png");
      await writeFile(source, `planned-${Date.now()}`);
      const emitted = await ctx.emitAsset(source);
      const plannedKey = `${prefix}/${path.basename(emitted.outputPath)}`;

      const result = await syncEmittedAssetsStorage(ctx);
      expect(result?.dryRun).toBe(true);
      expect(result?.uploaded).toContain(plannedKey);
      expect(result?.deleted).toContain(staleKey);
      expect(await files.exists(plannedKey)).toBe(false);
      expect(await files.exists(staleKey)).toBe(true);

      await files.delete(staleKey);
    });

    it("does not wipe the prefix when this build emitted no assets", async () => {
      const prefix = nextPrefix();
      const keepKey = `${prefix}/preexisting.bin`;
      await files.upload(keepKey, "keep");

      const { ctx } = await setupContext(prefix, { prune: true });
      const result = await syncEmittedAssetsStorage(ctx);
      expect(result?.pruneSkipped).toBe("empty-emit");
      expect(result?.deleted).toEqual([]);
      expect(await files.exists(keepKey)).toBe(true);
    });
  },
);
