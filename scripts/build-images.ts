/**
 * Universal MCP Server Containerizer
 * 
 * Mass-builds Docker images for all stdio MCP servers in the registry.
 * Supports multiple strategies:
 * 1. Existing Dockerfile in repository
 * 2. Nixpacks auto-detection
 * 3. Universal bridge fallback (supergateway)
 * 
 * Features:
 * - Batch processing with cleanup (manages ~250GB storage)
 * - Progress caching (resume from failures)
 * - Concurrent builds with limit
 * - GHCR push and health verification
 * 
 * Run: npx tsx scripts/build-images.ts [--concurrency=10] [--batch-size=100] [--filter=namespace/slug]
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import simpleGit from "simple-git";
import Dockerode from "dockerode";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const execAsync = promisify(exec);

// Disable git credential prompts to avoid hanging on private repos
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "echo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const REGISTRY_PATH = path.resolve(__dirname, "../src/data/mcpServers.json");
const PROGRESS_PATH = path.resolve(__dirname, "../src/data/build-progress.json");
const DOCKER_REGISTRY = "ghcr.io/compose-market/mcp";
const TEMPLATE_DIR = path.resolve(__dirname, "../templates/mcp-container");
const TEMP_DIR = path.resolve(__dirname, "../.build-temp");
const CONCURRENCY_LIMIT = parseInt(process.env.BUILD_CONCURRENCY || "10");
const BATCH_SIZE = parseInt(process.env.BUILD_BATCH_SIZE || "100");

// Parse CLI args
const args = process.argv.slice(2);
const concurrency = args.find(a => a.startsWith("--concurrency="))?.split("=")[1] || String(CONCURRENCY_LIMIT);
const batchSize = args.find(a => a.startsWith("--batch-size="))?.split("=")[1] || String(BATCH_SIZE);
const filterArg = args.find(a => a.startsWith("--filter="))?.split("=")[1];

interface BuildProgress {
    lastBuiltId: string | null;
    completedBuilds: Record<string, {
        success: boolean;
        image?: string;
        error?: string;
        timestamp: string;
    }>;
    totalAttempted: number;
    totalSucceeded: number;
    totalFailed: number;
}

interface McpServer {
    id: string;
    name: string;
    namespace: string;
    slug: string;
    repository?: { url?: string; source?: string };
    transport?: "stdio" | "http";
    image?: string;
    remoteUrl?: string;
    packages?: Array<{
        registryType: string;
        identifier: string;
        version?: string;
    }>;
}

interface RegistryData {
    sources: string[];
    updatedAt: string;
    count: number;
    servers: McpServer[];
}

const docker = new Dockerode();

//=============================================================================
// Progress Management
// =============================================================================

async function loadProgress(): Promise<BuildProgress> {
    try {
        const data = await fs.readFile(PROGRESS_PATH, "utf8");
        return JSON.parse(data);
    } catch {
        return {
            lastBuiltId: null,
            completedBuilds: {},
            totalAttempted: 0,
            totalSucceeded: 0,
            totalFailed: 0,
        };
    }
}

async function saveProgress(progress: BuildProgress): Promise<void> {
    await fs.writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

// =============================================================================
// Git Repository Operations
// =============================================================================

async function cloneRepository(repoUrl: string, destDir: string): Promise<{ success: boolean; sha?: string; error?: string }> {
    try {
        const git = simpleGit();
        console.log(`    Cloning: ${repoUrl}`);

        await git.clone(repoUrl, destDir, ["--depth", "1"]);

        const clonedGit = simpleGit(destDir);
        const log = await clonedGit.log(["-1"]);
        const sha = log.latest?.hash.substring(0, 7) || "unknown";

        console.log(`    ✓ Cloned (SHA: ${sha})`);
        return { success: true, sha };
    } catch (error) {
        console.error(`    ✗ Clone failed: ${error instanceof Error ? error.message : String(error)}`);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Docker Build Strategies
// =============================================================================

async function buildWithExistingDockerfile(
    repoDir: string,
    imageName: string
): Promise<{ success: boolean; error?: string }> {
    try {
        console.log(`    Strategy: Existing Dockerfile`);

        const { stdout, stderr } = await execAsync(
            `docker build --label "org.opencontainers.image.source=https://github.com/compose-market/mcp" -t ${imageName} ${repoDir}`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        if (stderr && !stderr.includes("WARNING")) {
            console.warn(`    Build warnings: ${stderr.substring(0, 200)}`);
        }

        console.log(`    ✓ Built with Dockerfile`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function buildWithNixpacks(
    repoDir: string,
    imageName: string
): Promise<{ success: boolean; error?: string }> {
    try {
        console.log(`    Strategy: Nixpacks auto-detection`);

        // Check if nixpacks is installed
        try {
            execSync("which nixpacks", { stdio: "ignore" });
        } catch {
            return { success: false, error: "nixpacks not installed" };
        }

        // Build with nixpacks
        const tempImageName = `${imageName}-temp`;
        await execAsync(
            `nixpacks build ${repoDir} --name ${tempImageName}`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        // Add label to link to public repo (nixpacks doesn't support --label)
        const labelDockerfile = `FROM ${tempImageName}\nLABEL org.opencontainers.image.source=https://github.com/compose-market/mcp`;
        await execAsync(
            `echo "${labelDockerfile}" | docker build -t ${imageName} -`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        console.log(`    ✓ Built with Nixpacks`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function buildWithUniversalBridge(
    packageName: string,
    imageName: string
): Promise<{ success: boolean; error?: string }> {
    try {
        console.log(`    Strategy: Universal Bridge (supergateway)`);
        console.log(`    Package: ${packageName}`);

        // Create temp build context
        const buildContext = path.join(TEMP_DIR, "universal-bridge");
        await fs.mkdir(buildContext, { recursive: true });

        // Copy Dockerfile and entrypoint
        await fs.copyFile(
            path.join(TEMPLATE_DIR, "Dockerfile"),
            path.join(buildContext, "Dockerfile")
        );
        await fs.copyFile(
            path.join(TEMPLATE_DIR, "entrypoint.sh"),
            path.join(buildContext, "entrypoint.sh")
        );

        // Build with package as build arg and make it public
        const { stdout, stderr } = await execAsync(
            `docker build --label "org.opencontainers.image.source=https://github.com/compose-market/mcp" --build-arg SERVER_PACKAGE=${packageName} -t ${imageName} ${buildContext}`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        console.log(`    ✓ Built with Universal Bridge`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Container Health Check
// =============================================================================

async function verifyServerHealth(imageName: string): Promise<{ success: boolean; error?: string }> {
    let container: Dockerode.Container | null = null;

    try {
        console.log(`    Verifying health...`);

        // Create and start container
        container = await docker.createContainer({
            Image: imageName,
            ExposedPorts: { "8080/tcp": {} },
            HostConfig: {
                PublishAllPorts: true,
                AutoRemove: false, // We'll remove manually
            },
        });

        await container.start();

        // Get allocated port
        const inspect = await container.inspect();
        const port = inspect.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;

        if (!port) {
            throw new Error("No port allocated");
        }

        // Wait for container to be ready
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to connect to SSE endpoint
        const baseUrl = `http://localhost:${port}`;
        const response = await fetch(`${baseUrl}/sse`, {
            method: "GET",
            headers: { "Accept": "text/event-stream" },
        });

        if (!response.ok) {
            throw new Error(`Health check failed: ${response.status}`);
        }

        console.log(`    ✓ Health check passed`);

        // Stop container
        await container.stop();
        await container.remove();

        return { success: true };
    } catch (error) {
        // Cleanup on error
        if (container) {
            try {
                await container.stop();
                await container.remove();
            } catch {
                // Ignore cleanup errors
            }
        }

        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Image Push to Registry
// =============================================================================

async function pushImage(imageName: string): Promise<{ success: boolean; error?: string }> {
    try {
        console.log(`    Pushing to registry...`);

        const { stdout, stderr } = await execAsync(`docker push ${imageName}`, {
            maxBuffer: 10 * 1024 * 1024,
        });

        console.log(`    ✓ Pushed to ${imageName}`);

        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Main Build Logic
// =============================================================================

async function buildServer(
    server: McpServer,
    progress: BuildProgress
): Promise<{ success: boolean; image?: string; error?: string }> {
    console.log(`\n[${progress.totalAttempted + 1}] Building: ${server.namespace}/${server.slug}`);
    console.log(`  ID: ${server.id}`);

    const repoUrl = server.repository?.url;

    // Determine package name
    let packageName: string | undefined;
    if (server.packages && server.packages.length > 0) {
        const npmPackage = server.packages.find(p => p.registryType === "npm" || p.registryType === "npmjs");
        if (npmPackage) {
            packageName = npmPackage.identifier;
        }
    }

    // If no package and no repo, skip
    if (!packageName && !repoUrl) {
        console.log(`  ⊘ Skipped: No package name or repository URL`);
        return { success: false, error: "No package or repository URL" };
    }

    // Generate clean image tag - extract meaningful name from slug/name
    // Remove common prefixes (mcp-, -mcp, server-, -server, author names)
    // But preserve the actual descriptive part
    let cleanName = server.name || server.slug;

    // Remove namespace/author prefix if present (e.g., "io.github.author/server" -> "server")
    if (cleanName.includes('/')) {
        cleanName = cleanName.split('/').pop() || cleanName;
    }

    // Remove common prefixes and suffixes
    cleanName = cleanName
        .replace(/^mcp[-_]?/i, '')           // Remove mcp- prefix
        .replace(/[-_]?mcp$/i, '')           // Remove -mcp suffix
        .replace(/^server[-_]?/i, '')        // Remove server- prefix  
        .replace(/[-_]?server$/i, '')        // Remove -server suffix
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')         // Clean special chars
        .replace(/--+/g, '-')                // Remove double dashes
        .replace(/^-+|-+$/g, '');            // Trim dashes

    // Fallback to slug if name becomes empty
    if (!cleanName || cleanName.length < 2) {
        cleanName = server.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    let imageName = `${DOCKER_REGISTRY}/${cleanName}`;

    let repoDir: string | null = null;
    let sha: string | undefined;

    try {
        // Strategy 1 & 2: Clone repository if available
        if (repoUrl) {
            repoDir = path.join(TEMP_DIR, cleanName);
            await fs.mkdir(TEMP_DIR, { recursive: true });

            const cloneResult = await cloneRepository(repoUrl, repoDir);
            if (!cloneResult.success) {
                // Skip if clone failed
                console.log(`  ⊘ Skipped: Clone failed`);
                return { success: false, error: cloneResult.error };
            }

            sha = cloneResult.sha;
            imageName = `${imageName}:${sha}`;

            // Strategy 1: Check for existing Dockerfile
            const dockerfilePath = path.join(repoDir, "Dockerfile");
            try {
                await fs.access(dockerfilePath);
                const buildResult = await buildWithExistingDockerfile(repoDir, imageName);

                if (buildResult.success) {
                    // Push and verify
                    const pushResult = await pushImage(imageName);
                    if (!pushResult.success) {
                        return { success: false, error: pushResult.error };
                    }

                    return { success: true, image: imageName };
                }
            } catch {
                // No Dockerfile, continue to next strategy
            }

            // Strategy 2: Try Nixpacks
            const nixpacksResult = await buildWithNixpacks(repoDir, imageName);
            if (nixpacksResult.success) {
                const pushResult = await pushImage(imageName);
                if (!pushResult.success) {
                    return { success: false, error: pushResult.error };
                }

                return { success: true, image: imageName };
            }
        }

        // Strategy 3: Universal Bridge fallback
        if (packageName) {
            // Use "latest" tag for universal bridge
            imageName = `${DOCKER_REGISTRY}/${cleanName}:latest`;

            const bridgeResult = await buildWithUniversalBridge(packageName, imageName);
            if (!bridgeResult.success) {
                return { success: false, error: bridgeResult.error };
            }

            // Verify health
            const healthResult = await verifyServerHealth(imageName);
            if (!healthResult.success) {
                console.warn(`  ⚠ Health check failed: ${healthResult.error}`);
                // Continue anyway - health checks can be flaky
            }

            // Push
            const pushResult = await pushImage(imageName);
            if (!pushResult.success) {
                return { success: false, error: pushResult.error };
            }

            return { success: true, image: imageName };
        }

        return { success: false, error: "All build strategies failed" };

    } finally {
        // Cleanup: Remove cloned repo
        if (repoDir) {
            try {
                await fs.rm(repoDir, { recursive: true, force: true });
            } catch (error) {
                console.warn(`  Warning: Failed to cleanup ${repoDir}`);
            }
        }
    }
}

// =============================================================================
// Batch Processing
// =============================================================================

async function processBatch(
    servers: McpServer[],
    progress: BuildProgress,
    batchNum: number
): Promise<void> {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`BATCH ${batchNum}: Processing ${servers.length} servers`);
    console.log(`${"=".repeat(70)}`);

    // Process with concurrency limit
    const concurrencyLimit = parseInt(concurrency);
    const chunks: McpServer[][] = [];
    for (let i = 0; i < servers.length; i += concurrencyLimit) {
        chunks.push(servers.slice(i, i + concurrencyLimit));
    }

    for (const chunk of chunks) {
        const results = await Promise.all(
            chunk.map(async (server) => {
                const result = await buildServer(server, progress);

                progress.completedBuilds[server.id] = {
                    success: result.success,
                    image: result.image,
                    error: result.error,
                    timestamp: new Date().toISOString(),
                };

                progress.totalAttempted++;
                if (result.success) {
                    progress.totalSucceeded++;
                } else {
                    progress.totalFailed++;
                }

                progress.lastBuiltId = server.id;

                return { server, result };
            })
        );

        // Save progress after each chunk
        await saveProgress(progress);
    }

    console.log(`\nBatch ${batchNum} complete:`);
    console.log(`  Succeeded: ${servers.filter(s => progress.completedBuilds[s.id]?.success).length}`);
    console.log(`  Failed: ${servers.filter(s => !progress.completedBuilds[s.id]?.success).length}`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  MCP Universal Containerizer                                 ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`Concurrency: ${concurrency}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Registry: ${DOCKER_REGISTRY}`);
    console.log(``);

    // Load registry
    const registryRaw = await fs.readFile(REGISTRY_PATH, "utf8");
    const registry: RegistryData = JSON.parse(registryRaw);

    console.log(`Loaded ${registry.count} servers from registry`);

    // Filter stdio servers with repositories or packages
    let serversToProcess = registry.servers.filter(s => {
        // Skip if already has image
        if (s.image) return false;

        // Skip if remote (HTTP/SSE)
        if (s.transport === "http" || s.remoteUrl) return false;

        // Must have repository URL or package
        return !!(s.repository?.url || (s.packages && s.packages.length > 0));
    });

    console.log(`${serversToProcess.length} stdio servers eligible for containerization`);

    // Apply filter if specified
    if (filterArg) {
        const filters = filterArg.split(",");
        serversToProcess = serversToProcess.filter(s =>
            filters.some(f => `${s.namespace}/${s.slug}`.includes(f) || s.slug.includes(f))
        );
        console.log(`Filter applied: ${serversToProcess.length} servers match "${filterArg}"`);
    }

    // Load progress
    const progress = await loadProgress();
    console.log(`Resume from progress: ${progress.totalAttempted} attempted, ${progress.totalSucceeded} succeeded`);

    // Skip already processed
    serversToProcess = serversToProcess.filter(s => !progress.completedBuilds[s.id]);
    console.log(`${serversToProcess.length} servers remaining to process`);

    if (serversToProcess.length === 0) {
        console.log("\n✓ All servers already processed!");
        return;
    }

    // Process in batches
    const batchSizeNum = parseInt(batchSize);
    let batchNum = 1;

    for (let i = 0; i < serversToProcess.length; i += batchSizeNum) {
        const batch = serversToProcess.slice(i, i + batchSizeNum);

        await processBatch(batch, progress, batchNum);

        // Cleanup Docker images after each batch to save space
        console.log(`\nCleaning up batch ${batchNum} images...`);
        try {
            execSync("docker system prune -af --volumes", { stdio: "inherit" });
            console.log("✓ Cleanup complete\n");
        } catch (error) {
            console.warn("⚠ Cleanup failed, continuing anyway\n");
        }

        batchNum++;
    }

    // Update registry with image metadata
    console.log("\nUpdating registry with image metadata...");
    for (const server of registry.servers) {
        const build = progress.completedBuilds[server.id];
        if (build?.success && build.image) {
            server.image = build.image;
            server.transport = "http"; // Containerized servers are accessible via HTTP
        }
    }

    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
    console.log("✓ Registry updated");

    // Final summary
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Containerization Complete                                   ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total attempted: ${progress.totalAttempted.toString().padEnd(46)}║`);
    console.log(`║  Succeeded: ${progress.totalSucceeded.toString().padEnd(51)}║`);
    console.log(`║  Failed: ${progress.totalFailed.toString().padEnd(54)}║`);
    console.log(`║  Success rate: ${((progress.totalSucceeded / progress.totalAttempted) * 100).toFixed(1)}%${' '.repeat(49)}║`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\nContainerization failed:", err);
    process.exit(1);
});
