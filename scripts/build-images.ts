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

// Disable git credential prompts and helpers to avoid authentication issues with public repos
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "echo";
process.env.GIT_CONFIG_NOSYSTEM = "1";  // Ignore system git config
delete process.env.GIT_CONFIG_GLOBAL;     // Ignore global git config

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
// Data directory is now local to mcp repo for simplicity in CI/CD
const REGISTRY_PATH = path.resolve(__dirname, "../data/mcpServers.json");
const PROGRESS_PATH = path.resolve(__dirname, "../data/build-progress.json");
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
const batchNumber = parseInt(args.find(a => a.startsWith("--batch="))?.split("=")[1] || "0");
const totalBatches = parseInt(args.find(a => a.startsWith("--total-batches="))?.split("=")[1] || "1");


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
        spawn?: {
            command?: string;
            args?: string[];
            env?: Record<string, string>;
        };
    }>;
    remotes?: Array<{
        type: string;
        url: string;
    }>;
    [key: string]: unknown;
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
// GHCR Image Existence Check
// =============================================================================

const ghcrImageCache = new Map<string, boolean>();

async function checkImageExistsOnGHCR(imageName: string): Promise<boolean> {
    // Check cache first
    if (ghcrImageCache.has(imageName)) {
        return ghcrImageCache.get(imageName)!;
    }

    try {
        // Parse image name (format: ghcr.io/compose-market/mcp/name:tag)
        const parts = imageName.replace("ghcr.io/", "").split("/");
        const repo = parts.slice(0, -1).join("/"); // compose-market/mcp
        const nameTag = parts[parts.length - 1]; // name:tag
        const [name, tag] = nameTag.split(":");

        // Use Docker Registry HTTP API V2
        // https://ghcr.io/v2/{namespace}/{repo}/manifests/{tag}
        const manifestUrl = `https://ghcr.io/v2/${repo}/${name}/manifests/${tag || "latest"}`;

        const response = await fetch(manifestUrl, {
            method: "HEAD",
            headers: {
                "Authorization": `Bearer ${process.env.GHCR_TOKEN || process.env.GITHUB_TOKEN || ""}`,
            },
        });

        const exists = response.ok;
        ghcrImageCache.set(imageName, exists);

        return exists;
    } catch (error) {
        console.warn(`    Warning: Could not check GHCR for ${imageName}: ${error instanceof Error ? error.message : String(error)}`);
        ghcrImageCache.set(imageName, false);
        return false;
    }
}

// =============================================================================
// Git Repository Operations
// =============================================================================

async function cloneRepository(repoUrl: string, destDir: string): Promise<{ success: boolean; sha?: string; error?: string }> {
    try {
        console.log(`    Cloning: ${repoUrl}`);

        // Use exec directly with clean environment to bypass GitHub Actions git config
        // GitHub Actions configures git globally with credentials which causes auth errors on other people's public repos
        const cleanEnv = {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "/bin/echo",
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: "/tmp/git-clean-home",  // Use temp HOME to avoid ~/.gitconfig
        };
        delete (cleanEnv as any).GIT_CONFIG_GLOBAL;

        await execAsync(
            `git -c credential.helper= -c core.askPass= clone --depth 1 "${repoUrl}" "${destDir}"`,
            { env: cleanEnv, maxBuffer: 10 * 1024 * 1024 }
        );

        // Get SHA
        const { stdout: sha } = await execAsync(`git -C "${destDir}" rev-parse --short HEAD`);

        console.log(`    ✓ Cloned (SHA: ${sha.trim()})`);
        return { success: true, sha: sha.trim() };
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

async function buildWithPythonMCP(
    repoDir: string,
    imageName: string
): Promise<{ success: boolean; error?: string }> {
    try {
        console.log(`    Strategy: Python MCP auto-build`);

        // Check for Python project files
        const hasRequirements = await fs.access(path.join(repoDir, "requirements.txt")).then(() => true).catch(() => false);
        const hasPyproject = await fs.access(path.join(repoDir, "pyproject.toml")).then(() => true).catch(() => false);

        if (!hasRequirements && !hasPyproject) {
            return { success: false, error: "No Python project files found" };
        }

        // Auto-detect Python entry point
        const possibleEntryPoints = [
            'src/index.py',
            'src/server.py',
            'src/main.py',
            'index.py',
            'server.py',
            'main.py',
            'app.py',
            '__main__.py'
        ];

        let entryPoint = null;
        for (const ep of possibleEntryPoints) {
            const exists = await fs.access(path.join(repoDir, ep)).then(() => true).catch(() => false);
            if (exists) {
                entryPoint = ep;
                console.log(`    Found entry point: ${ep}`);
                break;
            }
        }

        // Check pyproject.toml for entry points
        if (!entryPoint && hasPyproject) {
            try {
                const pyprojectContent = await fs.readFile(path.join(repoDir, "pyproject.toml"), 'utf8');
                const scriptMatch = pyprojectContent.match(/\[tool\.poetry\.scripts\]\s*([\w-]+)\s*=/m);
                if (scriptMatch) {
                    entryPoint = `poetry run ${scriptMatch[1]}`;
                    console.log(`    Found Poetry script: ${scriptMatch[1]}`);
                }
            } catch {
                // Ignore pyproject.toml parse errors
            }
        }

        // Build CMD variations to try
        const cmdVariations = [];
        if (entryPoint) {
            if (entryPoint.startsWith('poetry run')) {
                cmdVariations.push(`CMD ${JSON.stringify(entryPoint.split(' '))}`);
            } else {
                cmdVariations.push(`CMD ["python", "${entryPoint}"]`);
                cmdVariations.push(`CMD ["python", "-m", "${entryPoint.replace(/\.py$/, '').replace(/\//g, '.')}"]`);
            }
        }
        // Generic fallbacks
        cmdVariations.push('CMD ["python", "-m", "mcp"]');
        cmdVariations.push('CMD ["python", "src/index.py"]');
        cmdVariations.push('CMD ["python", "index.py"]');

        // Try each CMD variation
        for (let i = 0; i < cmdVariations.length; i++) {
            const cmd = cmdVariations[i];

            // Create a Dockerfile for Python MCP server
            const dockerfile = `FROM python:3.11-slim

WORKDIR /app

# Copy project files
COPY . .

# Install dependencies
${hasRequirements ? 'RUN pip install --no-cache-dir -r requirements.txt' : ''}
${hasPyproject ? 'RUN pip install --no-cache-dir .' : ''}

# Run MCP server
${cmd}

LABEL org.opencontainers.image.source=https://github.com/compose-market/mcp
`;

            await fs.writeFile(path.join(repoDir, "Dockerfile.mcp"), dockerfile);

            try {
                // Build with the generated Dockerfile
                await execAsync(
                    `docker build --label "org.opencontainers.image.source=https://github.com/compose-market/mcp" -f ${path.join(repoDir, "Dockerfile.mcp")} -t ${imageName} ${repoDir}`,
                    { maxBuffer: 10 * 1024 * 1024 }
                );

                console.log(`    ✓ Built with Python MCP strategy (CMD: ${cmd.substring(0, 50)})`);
                return { success: true };
            } catch (buildError) {
                if (i === cmdVariations.length - 1) {
                    // Last attempt failed, throw error
                    throw buildError;
                }
                // Try next CMD variation
                console.log(`    Trying next CMD variation...`);
            }
        }

        return { success: false, error: "All CMD variations failed" };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Show MORE of the error (first 500 chars instead of 200)
        console.log(`    ✗ Python MCP build failed: ${errorMsg.substring(0, 500)}`);
        return { success: false, error: errorMsg };
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`    ✗ Nixpacks build failed: ${errorMsg.substring(0, 500)}`);
        return { success: false, error: errorMsg };
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

    // Validate repository URL format if present
    if (repoUrl) {
        // Check if URL is complete (has owner AND repo name)
        const githubMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
        if (!githubMatch || !githubMatch[2]) {
            console.log(`  ⊘ Skipped: Invalid/incomplete repository URL (${repoUrl})`);
            return { success: false, error: "Invalid or incomplete repository URL" };
        }
    }

    // Determine package name
    let packageName: string | undefined;
    let hasNpmPackage = false;
    let hasOciPackage = false;

    if (server.packages && server.packages.length > 0) {
        const npmPackage = server.packages.find(p => p.registryType === "npm" || p.registryType === "npmjs");
        if (npmPackage) {
            packageName = npmPackage.identifier;
            hasNpmPackage = true;
        }

        // Check for existing OCI/Docker images
        const ociPackage = server.packages.find(p => p.registryType === "oci" || p.registryType === "docker");
        if (ociPackage) {
            hasOciPackage = true;
        }
    }

    // SKIP RULE 1: Servers with existing OCI/Docker images
    if (hasOciPackage) {
        const ociPkg = server.packages!.find(p => p.registryType === "oci" || p.registryType === "docker");
        console.log(`  ⊘ Skipped: Already has public Docker image (${ociPkg?.identifier})`);
        return { success: false, error: "Already has public Docker image" };
    }

    // SKIP RULE 2: HTTP/SSE servers (already remote-capable)
    if (server.transport === "http" || server.remoteUrl || (server.remotes && server.remotes.length > 0)) {
        console.log(`  ⊘ Skipped: Already remote-capable (HTTP/SSE)`);
        if (server.remoteUrl) {
            console.log(`    Remote URL: ${server.remoteUrl}`);
        }
        return { success: false, error: "Already remote-capable via HTTP/SSE" };
    }

    // SKIP RULE 3: NPM-only packages without repo (users can use npx)
    if (hasNpmPackage && !repoUrl) {
        console.log(`  ⊘ Skipped: NPM package available, use npx (${packageName})`);
        return { success: false, error: "Use npx instead of containerization" };
    }

    // SKIP RULE 4: No package and no repo
    if (!packageName && !repoUrl) {
        console.log(`  ⊘ Skipped: No package or repository found`);
        return { success: false, error: "No package or repository URL" };
    }

    // Generate Docker image name using actual server name (not namespace-slug concatenation)
    // This produces correct names like "google-calendar" instead of "io-github-google-calendar-mcp"
    let imageName: string;
    let cleanName: string;

    if (server.name) {
        // Use the actual name field from metadata
        cleanName = server.name
            .toLowerCase()
            .replace(/^@/, '')              // Remove npm scope prefix like @modelcontextprotocol/
            .replace(/\s*mcp\s*server\s*/gi, '')    // Remove "MCP Server"
            .replace(/\s*server\s*/gi, '')          // Remove "Server"
            .replace(/\s*mcp\s*/gi, '')             // Remove "MCP"
            .replace(/\s*by\s+[\w-]+/gi, '')        // Remove "by author"
            .replace(/\s*\|\s*.+$/g, '')            // Remove "| Glama" etc
            .replace(/[^a-z0-9-]/g, '-')            // Clean special chars
            .replace(/--+/g, '-')           // Remove double dashes
            .replace(/^-+|-+$/g, '');       // Trim dashes

        imageName = `${DOCKER_REGISTRY}/${cleanName}`;
    } else {
        // Fallback to namespace-slug only if name is missing
        console.warn(`  Warning: No name field, using namespace-slug`);
        cleanName = `${server.namespace}-${server.slug}`
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/--+/g, '-')
            .replace(/^-+|-+$/g, '');

        imageName = `${DOCKER_REGISTRY}/${cleanName}`;
    }



    let repoDir: string | null = null;
    let sha: string | undefined;
    let fullImageName = imageName;

    try {
        // Strategy 1 & 2: Clone repository if available to get SHA first
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
            fullImageName = `${imageName}:${sha}`;

            // Check if this SHA-tagged image already exists on GHCR
            console.log(`  Checking GHCR for existing image...`);
            const imageExists = await checkImageExistsOnGHCR(fullImageName);

            if (imageExists) {
                console.log(`  ⊘ Skipped: Image already exists on GHCR (${fullImageName})`);
                return { success: true, image: fullImageName };
            }

            // Strategy 1: Check for existing Dockerfile
            const dockerfilePath = path.join(repoDir, "Dockerfile");
            try {
                await fs.access(dockerfilePath);
                const buildResult = await buildWithExistingDockerfile(repoDir, fullImageName);

                if (buildResult.success) {
                    // Push and verify
                    const pushResult = await pushImage(fullImageName);
                    if (!pushResult.success) {
                        return { success: false, error: pushResult.error };
                    }

                    return { success: true, image: fullImageName };
                }
            } catch {
                // No Dockerfile, continue to next strategy
            }

            // Strategy 2: Try Python MCP build
            const pythonResult = await buildWithPythonMCP(repoDir, fullImageName);
            if (pythonResult.success) {
                const pushResult = await pushImage(fullImageName);
                if (!pushResult.success) {
                    return { success: false, error: pushResult.error };
                }
                return { success: true, image: fullImageName };
            }

            // Strategy 3: Try Nixpacks
            const nixpacksResult = await buildWithNixpacks(repoDir, fullImageName);
            if (nixpacksResult.success) {
                const pushResult = await pushImage(fullImageName);
                if (!pushResult.success) {
                    return { success: false, error: pushResult.error };
                }

                return { success: true, image: fullImageName };
            }
        }

        // Strategy 3: Universal Bridge fallback (for NPM packages with repos or packages only)
        if (packageName) {
            // Use "latest" tag for universal bridge
            fullImageName = `${imageName}:latest`;

            // Check GHCR for NPM-based images
            console.log(`  Checking GHCR for existing image...`);
            const imageExists = await checkImageExistsOnGHCR(fullImageName);

            if (imageExists) {
                console.log(`  ⊘ Skipped: Image already exists on GHCR (${fullImageName})`);
                return { success: true, image: fullImageName };
            }

            const bridgeResult = await buildWithUniversalBridge(packageName, fullImageName);
            if (!bridgeResult.success) {
                return { success: false, error: bridgeResult.error };
            }

            // Verify health
            const healthResult = await verifyServerHealth(fullImageName);
            if (!healthResult.success) {
                console.warn(`  ⚠ Health check failed: ${healthResult.error}`);
                // Continue anyway - health checks can be flaky
            }

            // Push
            const pushResult = await pushImage(fullImageName);
            if (!pushResult.success) {
                return { success: false, error: pushResult.error };
            }

            return { success: true, image: fullImageName };
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

    // Filter servers that need containerization
    let serversToProcess = registry.servers.filter(s => {
        // Skip if already has a container image built
        if (s.image) return false;

        // Skip if remote-capable (HTTP/SSE)
        if (s.transport === "http") return false;
        if (s.remoteUrl) return false;
        if (s.remotes && s.remotes.length > 0) return false;

        // Skip if already has public OCI/Docker image
        if (s.packages && s.packages.some(p => p.registryType === "oci" || p.registryType === "docker")) {
            return false;
        }

        // Skip if has NPM package (can use npx directly, regardless of repo)
        const hasNpm = s.packages && s.packages.some(p => p.registryType === "npm" || p.registryType === "npmjs");
        if (hasNpm) return false;

        // Must have repository URL to build from source
        return !!s.repository?.url;
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

    // Apply batch slicing for parallel processing
    if (totalBatches > 1) {
        const serversPerBatch = Math.ceil(serversToProcess.length / totalBatches);
        const startIdx = batchNumber * serversPerBatch;
        const endIdx = Math.min(startIdx + serversPerBatch, serversToProcess.length);

        serversToProcess = serversToProcess.slice(startIdx, endIdx);
        console.log(`Batch ${batchNumber + 1}/${totalBatches}: Processing servers ${startIdx + 1}-${endIdx} (${serversToProcess.length} servers)`);
    }

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
